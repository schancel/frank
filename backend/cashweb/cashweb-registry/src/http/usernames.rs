//! Username routes. Mounted with the directory, because a name only ever points to a key that
//! has a directory entry on this relay: resolving a name gives someone you can message.
//!
//! - `PUT /directory/user/:username`: body is a signed claim (see
//!   [`crate::store::directory_usernames`]). 200 when the key holds the name afterwards.
//! - `GET /directory/user/:username`: who holds the name, or 404.
//! - `GET /directory/users?prefix=<text>[&limit=<n>]`: names starting with `prefix`.
//! - `GET /directory/users?addresses=<0x…,0x…>`: the names those addresses hold.
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{rejection::QueryRejection, ContentLengthLimit, Extension, Path, Query},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing, Json, Router,
};

use crate::{
    directory_runtime::DirectoryRuntime,
    monad_http::Address,
    store::directory_usernames::{
        normalize, UsernameError, UsernameRecord, MAX_CLAIM_BYTES, MAX_SEARCH_RESULTS,
    },
};

/// Names returned by a search that gives no `limit`.
const DEFAULT_SEARCH_RESULTS: usize = 20;

fn json(status: StatusCode, body: serde_json::Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

fn refusal(status: StatusCode, code: &str, message: impl std::fmt::Display) -> Response {
    json(
        status,
        serde_json::json!({ "error": code, "message": message.to_string() }),
    )
}

fn refused(error: UsernameError) -> Response {
    let status = match error {
        UsernameError::InvalidName(_) | UsernameError::InvalidClaim(_) => StatusCode::BAD_REQUEST,
        UsernameError::Taken | UsernameError::Stale => StatusCode::CONFLICT,
    };
    refusal(status, error.code(), error)
}

fn storage_failed(error: impl std::fmt::Display) -> Response {
    tracing::error!(%error, "username store failed");
    refusal(
        StatusCode::INTERNAL_SERVER_ERROR,
        "storage",
        "The relay could not read or write its username store",
    )
}

/// What clients get for one name. `address`/`account_address`/`status`/`entry` are the fields
/// the app's contact search and the mail gateway read; `claim` lets anyone re-verify the record.
fn user(runtime: &DirectoryRuntime, record: &UsernameRecord) -> serde_json::Value {
    let address = format!("0x{}", hex::encode(record.address));
    // The account's old-style profile (display name, avatar), when it has published one.
    let entry = runtime
        .registry()
        .get_monad_profile_raw(Address(record.address))
        .ok()
        .flatten()
        .map(|raw| {
            serde_json::json!({
                "content_type": if crate::store::monad_profiles::is_cbor_frame(&raw) {
                    "application/cbor"
                } else {
                    "application/x-protobuf"
                },
                "raw_hex": hex::encode(raw),
            })
        });
    serde_json::json!({
        "username": record.username,
        "address": address,
        "account_address": address,
        "subject": hex::encode(record.subject),
        "status": "active",
        "issued_ms": record.issued_ms,
        "updated_at_ms": record.accepted_ms,
        "claim": hex::encode(&record.claim),
        "entry": entry,
    })
}

/// False for a reserved name in the hands of any key but the one it is reserved for: such a
/// record (taken before the operator reserved the name) is never served and cannot be made.
fn shown(runtime: &DirectoryRuntime, record: &UsernameRecord) -> bool {
    runtime
        .reserved_username(&record.username)
        .is_none_or(|owner| *owner == record.subject)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn claim(
    Extension(runtime): Extension<Arc<DirectoryRuntime>>,
    Path(username): Path<String>,
    body: Result<
        ContentLengthLimit<Bytes, MAX_CLAIM_BYTES>,
        axum::extract::rejection::ContentLengthLimitRejection<
            axum::extract::rejection::BytesRejection,
        >,
    >,
) -> Response {
    let Ok(ContentLengthLimit(body)) = body else {
        return refused(UsernameError::InvalidClaim(format!(
            "send the signed claim as a body of at most {MAX_CLAIM_BYTES} bytes"
        )));
    };
    let name = match normalize(&username) {
        Ok(name) => name,
        Err(error) => return refused(error),
    };
    let registry = runtime.registry();
    let network = &runtime.info().network;
    let now = now_ms();
    let record = match registry.verify_username_claim(&body, network, now) {
        Ok(record) => record,
        Err(error) => return refused(error),
    };
    if record.username != name {
        return refused(UsernameError::InvalidClaim(format!(
            "the claim is for {:?}, not {name:?}",
            record.username
        )));
    }
    // A name the operator reserved is taken for everyone but the key it is reserved for.
    let reserved = runtime.reserved_username(&name).is_some();
    if !shown(&runtime, &record) {
        return refused(UsernameError::Taken);
    }
    // A name must resolve to someone who can be messaged, and that needs their directory entry.
    if !runtime.is_published(network, &hex::encode(record.subject)) {
        return refusal(
            StatusCode::CONFLICT,
            "not-published",
            "This account has no directory entry on this relay yet; publish it, then claim a name",
        );
    }
    let names = registry.usernames();
    match names.claim(&record, now, reserved) {
        Err(error) => storage_failed(error),
        Ok(Err(error)) => refused(error),
        Ok(Ok(_)) => match names.get(&name) {
            Ok(Some(stored)) => json(StatusCode::OK, user(&runtime, &stored)),
            Ok(None) => storage_failed("claimed name is missing"),
            Err(error) => storage_failed(error),
        },
    }
}

async fn lookup(
    Extension(runtime): Extension<Arc<DirectoryRuntime>>,
    Path(username): Path<String>,
) -> Response {
    let name = match normalize(&username) {
        Ok(name) => name,
        Err(error) => return refused(error),
    };
    match runtime.registry().usernames().get(&name) {
        Err(error) => storage_failed(error),
        Ok(None) => refusal(
            StatusCode::NOT_FOUND,
            "not-found",
            format!("Nobody has the username {name:?}"),
        ),
        Ok(Some(record)) if shown(&runtime, &record) => {
            json(StatusCode::OK, user(&runtime, &record))
        }
        Ok(Some(_)) => refusal(
            StatusCode::NOT_FOUND,
            "not-found",
            format!("Nobody has the username {name:?}"),
        ),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchQuery {
    /// Start of a name; `@` and upper case are accepted.
    prefix: Option<String>,
    /// 1 to 100 names, default 20. Only with `prefix`.
    limit: Option<usize>,
    /// Comma-separated 0x addresses, at most 100.
    addresses: Option<String>,
}

async fn search(
    Extension(runtime): Extension<Arc<DirectoryRuntime>>,
    query: Result<Query<SearchQuery>, QueryRejection>,
) -> Response {
    let bad = |message: &str| refusal(StatusCode::BAD_REQUEST, "invalid-query", message);
    let Ok(Query(query)) = query else {
        return bad("Give either prefix (with an optional limit) or addresses");
    };
    let names = runtime.registry().usernames();
    let found = match (query.prefix, query.addresses) {
        (Some(prefix), None) => {
            let trimmed = prefix.trim();
            let prefix = trimmed
                .strip_prefix('@')
                .unwrap_or(trimmed)
                .to_ascii_lowercase();
            let limit = query.limit.unwrap_or(DEFAULT_SEARCH_RESULTS);
            if limit == 0 || limit > MAX_SEARCH_RESULTS {
                return bad("limit must be 1 to 100");
            }
            names.search(&prefix, limit)
        }
        (None, Some(addresses)) if query.limit.is_none() => {
            let mut parsed = Vec::new();
            for text in addresses.split(',').filter(|text| !text.is_empty()) {
                match Address::from_hex(&text.to_ascii_lowercase()) {
                    Ok(address) if parsed.len() < MAX_SEARCH_RESULTS => parsed.push(address),
                    _ => return bad("addresses must be at most 100 comma-separated 0x addresses"),
                }
            }
            parsed
                .iter()
                .filter_map(|address| names.of_address(&address.0).transpose())
                .collect()
        }
        _ => return bad("Give either prefix (with an optional limit) or addresses"),
    };
    match found {
        Err(error) => storage_failed(error),
        Ok(records) => json(
            StatusCode::OK,
            serde_json::json!({
                "users": records
                    .iter()
                    .filter(|record| shown(&runtime, record))
                    .map(|record| user(&runtime, record))
                    .collect::<Vec<_>>(),
            }),
        ),
    }
}

/// The username routes of a relay whose directory is `runtime`.
pub fn router(runtime: Arc<DirectoryRuntime>) -> Router {
    Router::new()
        .route("/directory/user/:username", routing::get(lookup).put(claim))
        .route("/directory/users", routing::get(search))
        .layer(Extension(runtime))
}

#[cfg(test)]
#[path = "usernames_tests.rs"]
mod tests;
