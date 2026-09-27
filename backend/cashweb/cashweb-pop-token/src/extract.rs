//! POP token extraction from an HTTP `Authorization` header, or an `access_token` query
//! parameter.
//!
//! Ported from the deprecated `cashweb-backends` repo's `lib/cashweb-token/src/lib.rs`
//! (`extract_pop`/`split_pop_token`), preserving the exact `"POP <token>"` convention used by
//! the [`POP Token Protocol`], plus the `access_token` query-param fallback used by that repo's
//! `relayserver/src/net/protection.rs`.
//!
//! [`POP Token Protocol`]: https://github.com/cashweb/specifications/blob/master/proof-of-payment-token/specification.mediawiki

use http::header::{HeaderMap, HeaderValue, AUTHORIZATION};

/// Prefix that precedes a POP token in an `Authorization` header value or `access_token` query
/// param, per the POP Token Protocol.
const POP_PREFIX: &str = "POP ";

/// Split a POP token out of a full token string, removing the `"POP "` prefix.
///
/// Returns `None` if `full_token` is too short, or doesn't start with the expected prefix.
pub fn split_pop_token(full_token: &str) -> Option<&str> {
    if full_token.len() > POP_PREFIX.len() && &full_token[..POP_PREFIX.len()] == POP_PREFIX {
        return Some(&full_token[POP_PREFIX.len()..]);
    }
    None
}

/// Extract a POP token from a single `Authorization` header value.
pub fn extract_pop_header(value: &HeaderValue) -> Option<&str> {
    value.to_str().ok().and_then(split_pop_token)
}

/// Extract the first POP token found among the `Authorization` headers in a [`HeaderMap`].
pub fn extract_pop(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(AUTHORIZATION)
        .iter()
        .find_map(extract_pop_header)
}

/// Extract a POP token, preferring the `Authorization` header, falling back to an
/// `access_token` query parameter (both must carry the `"POP "` prefix; this mirrors the
/// deprecated `relayserver`'s `pop_protection`, which allows the token to be supplied either
/// way, e.g. for clients that can't set custom headers).
pub fn extract_pop_or_query<'a>(
    headers: &'a HeaderMap,
    access_token: Option<&'a str>,
) -> Option<&'a str> {
    extract_pop(headers).or_else(|| access_token.and_then(split_pop_token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_ok() {
        assert_eq!(split_pop_token("POP abc"), Some("abc"));
    }

    #[test]
    fn split_short() {
        assert_eq!(split_pop_token("A"), None);
    }

    #[test]
    fn split_exact_prefix_len_is_short() {
        // "POP " is 4 chars; a full_token of length <= 4 can never carry a token after the
        // prefix, so it must be rejected even if it textually matches.
        assert_eq!(split_pop_token("POP "), None);
    }

    #[test]
    fn split_err_wrong_prefix() {
        assert_eq!(split_pop_token("ABC d"), None);
    }

    #[test]
    fn split_err_malformed_no_space() {
        assert_eq!(split_pop_token("POPabc"), None);
    }

    #[test]
    fn extract_pop_header_ok() {
        let value = HeaderValue::from_static("POP sometoken");
        assert_eq!(extract_pop_header(&value), Some("sometoken"));
    }

    #[test]
    fn extract_pop_header_wrong_scheme() {
        let value = HeaderValue::from_static("Bearer sometoken");
        assert_eq!(extract_pop_header(&value), None);
    }

    #[test]
    fn extract_pop_from_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("POP abc123"));
        assert_eq!(extract_pop(&headers), Some("abc123"));
    }

    #[test]
    fn extract_pop_missing() {
        let headers = HeaderMap::new();
        assert_eq!(extract_pop(&headers), None);
    }

    #[test]
    fn extract_pop_finds_among_multiple_authorization_headers() {
        let mut headers = HeaderMap::new();
        headers.append(AUTHORIZATION, HeaderValue::from_static("Bearer other"));
        headers.append(AUTHORIZATION, HeaderValue::from_static("POP abc123"));
        assert_eq!(extract_pop(&headers), Some("abc123"));
    }

    #[test]
    fn extract_pop_or_query_prefers_header() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("POP from-header"));
        assert_eq!(
            extract_pop_or_query(&headers, Some("POP from-query")),
            Some("from-header")
        );
    }

    #[test]
    fn extract_pop_or_query_falls_back_to_query() {
        let headers = HeaderMap::new();
        assert_eq!(
            extract_pop_or_query(&headers, Some("POP from-query")),
            Some("from-query")
        );
    }

    #[test]
    fn extract_pop_or_query_none() {
        let headers = HeaderMap::new();
        assert_eq!(extract_pop_or_query(&headers, None), None);
        assert_eq!(
            extract_pop_or_query(&headers, Some("not-a-pop-token")),
            None
        );
    }
}
