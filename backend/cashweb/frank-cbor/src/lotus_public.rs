//! Pure closed Lotus public values. Relay projections never confer economic authority.
use crate::{
    AccountRef, CborValue, CodecError, ErrorCategory, ErrorStage, ParsedFrame, SignatureEntry,
    TypedPayload, UsageError,
};
use sha2::{Digest, Sha256};

/// Exact canonical body or historical protobuf reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotusReference {
    /// Zero identifies a canonical body, one a historical protobuf digest.
    pub origin: u8,
    /// Exact digest bytes.
    pub hash: [u8; 32],
}
/// Ordered public entry; a known post requires an opened type35 child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotusEntry {
    /// Exact kind string.
    pub kind: String,
    /// Exact pairs in authored order; names are unique.
    pub headers: Vec<(String, String)>,
    /// Exact raw data, including original frame bytes for known posts.
    pub data: Vec<u8>,
    /// Validated known post child; absent for unknown kinds and writer inputs.
    pub post: Option<ParsedFrame>,
}
/// One selected native output; chain decoding belongs to runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotusBurn {
    /// Complete exact native transaction bytes.
    pub raw: Vec<u8>,
    /// Selected output, not a whole-transaction credit.
    pub output_index: u32,
}
/// An inventory row identifies an exact retrievable wrapper or projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotusDescriptor {
    /// Type36, 37 or 43 only.
    pub type_id: u32,
    /// Ordinary complete-frame SHA256 lookup index.
    pub index: [u8; 32],
    /// Exact sequence.
    pub sequence: u64,
    /// Relay observation time.
    pub time: i64,
    /// Optional target.
    pub target: Option<LotusReference>,
}
/// Closed writer inputs and owned projections for all twelve allocated types.
/// Numeric fields are exact; optional empty text remains distinct from absence.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LotusPayload {
    Metadata {
        network: String,
        timestamp: i64,
        ttl: i64,
        entries: Vec<LotusEntry>,
    },
    Post {
        network: String,
        topic: String,
        timestamp: i64,
        entries: Vec<LotusEntry>,
        parent: Option<LotusReference>,
    },
    Offering {
        network: String,
        target: LotusReference,
        direction: u8,
    },
    Text {
        title: Option<String>,
        url: Option<String>,
        message: Option<String>,
    },
    Submission {
        network: String,
        body_frame: Vec<u8>,
        body: Option<ParsedFrame>,
        signature: SignatureEntry,
        burns: Vec<LotusBurn>,
        claimed_burn: Option<u64>,
    },
    HistoricalManifest {
        network: String,
        digest: [u8; 32],
        author: AccountRef,
        kind: u8,
        observed: i64,
        ttl: Option<i64>,
        parent: Option<LotusReference>,
        total_burn: u64,
        component_count: u64,
        authored: Option<i64>,
        target: Option<LotusReference>,
    },
    Inventory {
        network: String,
        collection: u8,
        epoch: [u8; 16],
        incarnation: u64,
        ceiling: u64,
        rows: Vec<LotusDescriptor>,
        next: Option<Vec<u8>>,
        echo: Option<Vec<u8>>,
    },
    Summary {
        network: String,
        target: LotusReference,
        revision: u64,
        physical: u64,
        support: u64,
        oppose: u64,
    },
    Result {
        network: String,
        request: [u8; 32],
        phase: u8,
        txids: Vec<[u8; 32]>,
        sequence: Option<u64>,
        reason: Option<String>,
    },
    Peers {
        network: String,
        origins: Vec<String>,
    },
    Error {
        network: String,
        code: String,
        request: Option<[u8; 32]>,
        retryable: bool,
    },
    HistoricalChunk {
        network: String,
        digest: [u8; 32],
        ordinal: u64,
        path: [u64; 4],
        encoding: u8,
        total: u64,
        offset: u64,
        chunk: Vec<u8>,
    },
}
impl LotusPayload {
    /// Allocated type for this closed variant.
    pub fn type_id(&self) -> u32 {
        match self {
            Self::Metadata { .. } => 32,
            Self::Post { .. } => 33,
            Self::Offering { .. } => 34,
            Self::Text { .. } => 35,
            Self::Submission { .. } => 36,
            Self::HistoricalManifest { .. } => 37,
            Self::Inventory { .. } => 38,
            Self::Summary { .. } => 39,
            Self::Result { .. } => 40,
            Self::Peers { .. } => 41,
            Self::Error { .. } => 42,
            Self::HistoricalChunk { .. } => 43,
        }
    }
    /// Validated body network; presentation text uses the T1 literal frank.
    pub fn network(&self) -> &str {
        match self {
            Self::Metadata { network, .. }
            | Self::Post { network, .. }
            | Self::Offering { network, .. }
            | Self::Submission { network, .. }
            | Self::HistoricalManifest { network, .. }
            | Self::Inventory { network, .. }
            | Self::Summary { network, .. }
            | Self::Result { network, .. }
            | Self::Peers { network, .. }
            | Self::Error { network, .. }
            | Self::HistoricalChunk { network, .. } => network,
            Self::Text { .. } => "frank",
        }
    }
}
fn bad(detail: impl Into<String>) -> CodecError {
    CodecError::new(
        ErrorCategory::Schema,
        ErrorStage::S82,
        detail,
        "root/payload",
        None,
    )
}
fn semantic(detail: impl Into<String>) -> CodecError {
    CodecError::new(
        ErrorCategory::Semantic,
        ErrorStage::S9,
        detail,
        "root/payload",
        None,
    )
}
fn resource(detail: impl Into<String>) -> CodecError {
    CodecError::new(
        ErrorCategory::Resource,
        ErrorStage::S81,
        detail,
        "root/payload",
        None,
    )
}
fn map<'a>(
    v: &'a CborValue,
    required: &[u64],
    optional: &[u64],
) -> Result<&'a [(u64, CborValue)], CodecError> {
    let CborValue::Map(m) = v else {
        return Err(bad("expected closed map"));
    };
    if m.iter()
        .any(|(k, _)| !(required.contains(k) || optional.contains(k)))
    {
        return Err(bad("unknown field in closed Lotus map"));
    }
    if required.iter().any(|k| get(m, *k).is_none()) {
        return Err(bad("missing required Lotus field"));
    }
    Ok(m)
}
fn get(m: &[(u64, CborValue)], k: u64) -> Option<&CborValue> {
    m.iter()
        .find_map(|(key, v)| if *key == k { Some(v) } else { None })
}
fn req(m: &[(u64, CborValue)], k: u64) -> Result<&CborValue, CodecError> {
    get(m, k).ok_or_else(|| bad("missing required field"))
}
fn uint(v: &CborValue, max: u64) -> Result<u64, CodecError> {
    match v {
        CborValue::Int(n) if *n >= 0 && *n <= max as i128 => Ok(*n as u64),
        _ => Err(bad("expected bounded unsigned integer")),
    }
}
fn signed(v: &CborValue) -> Result<i64, CodecError> {
    match v {
        CborValue::Int(n) => i64::try_from(*n).map_err(|_| bad("expected i64")),
        _ => Err(bad("expected i64")),
    }
}
fn text(v: &CborValue) -> Result<String, CodecError> {
    match v {
        CborValue::Text(s) => Ok(s.clone()),
        _ => Err(bad("expected text")),
    }
}
fn bytes(v: &CborValue, min: usize, max: usize) -> Result<Vec<u8>, CodecError> {
    match v {
        CborValue::Bytes(b) if b.len() >= min && b.len() <= max => Ok(b.clone()),
        CborValue::Bytes(_) => Err(bad("Lotus byte string bound")),
        _ => Err(bad("expected bytes")),
    }
}
fn fixed<const N: usize>(v: &CborValue) -> Result<[u8; N], CodecError> {
    bytes(v, N, N)?.try_into().map_err(|_| bad("fixed bytes"))
}
fn list(v: &CborValue, min: usize, max: usize) -> Result<&[CborValue], CodecError> {
    match v {
        CborValue::Array(a) if a.len() >= min && a.len() <= max => Ok(a),
        CborValue::Array(_) => Err(bad("Lotus array count bound")),
        _ => Err(bad("expected array")),
    }
}
fn reference(v: &CborValue) -> Result<LotusReference, CodecError> {
    let m = map(v, &[0, 1], &[])?;
    Ok(LotusReference {
        origin: uint(req(m, 0)?, 1)? as u8,
        hash: fixed(req(m, 1)?)?,
    })
}
fn account(v: &CborValue) -> Result<AccountRef, CodecError> {
    crate::schema::account(Some(v), "root/payload/account")
}
fn framed_bytes(v: &CborValue) -> Result<Vec<u8>, CodecError> {
    bytes(v, 1, crate::MAX_FRAME_BYTES)
}
fn entries(v: &CborValue) -> Result<Vec<LotusEntry>, CodecError> {
    list(v, 0, 64)?
        .iter()
        .map(|v| {
            let m = map(v, &[0, 1, 2], &[])?;
            let headers = list(req(m, 1)?, 0, 32)?
                .iter()
                .map(|v| {
                    let p = list(v, 2, 2)?;
                    Ok((text(&p[0])?, text(&p[1])?))
                })
                .collect::<Result<Vec<_>, CodecError>>()?;
            let kind = text(req(m, 0)?)?;
            let data = if kind == "post" {
                framed_bytes(req(m, 2)?)?
            } else {
                bytes(req(m, 2)?, 0, crate::MAX_BYTE_STRING_BYTES)?
            };
            Ok(LotusEntry {
                kind,
                headers,
                data,
                post: None,
            })
        })
        .collect()
}
/// Full frame cap, applied to both roots and required children.
pub(crate) fn frame_cap(t: u32) -> Option<usize> {
    Some(match t {
        32 | 35 => 262144,
        33 => 1048576,
        34 | 37 | 39 | 40 | 41 => 65536,
        36 => 8388617,
        38 => 4194304,
        42 => 16384,
        43 => 131072,
        _ => return None,
    })
}
/// Parse the closed schema; child frames are subsequently opened in the shared traversal.
pub(crate) fn parse(t: u32, v: &CborValue) -> Result<LotusPayload, CodecError> {
    let (required, optional): (&[u64], &[u64]) = match t {
        32 => (&[0, 1, 2, 3], &[]),
        33 => (&[0, 1, 2, 3], &[4]),
        34 => (&[0, 1, 2], &[]),
        35 => (&[], &[0, 1, 2]),
        36 => (&[0, 1, 2, 3], &[4]),
        37 => (&[0, 1, 2, 3, 4, 7, 8], &[5, 6, 9, 10]),
        38 => (&[0, 1, 2, 3, 4, 5], &[6, 7]),
        39 => (&[0, 1, 2, 3, 4, 5], &[]),
        40 => (&[0, 1, 2, 3], &[4, 5]),
        41 => (&[0, 1], &[]),
        42 => (&[0, 1, 3], &[2]),
        43 => (&[0, 1, 2, 3, 4, 5, 6, 7], &[]),
        _ => return Err(bad("unknown Lotus type")),
    };
    let m = map(v, required, optional)?;
    let r = |k| req(m, k);
    let u = |k| uint(r(k)?, u64::MAX);
    let i = |k| signed(r(k)?);
    let s = |k| text(r(k)?);
    let d = |k| fixed::<32>(r(k)?);
    let network = if t == 35 {
        "frank".into()
    } else {
        let n = s(0)?;
        if n != "xpi-mainnet" && n != "xpi-regtest" {
            return Err(bad("unregistered Lotus network"));
        }
        n
    };
    Ok(match t {
        32 => LotusPayload::Metadata {
            network,
            timestamp: i(1)?,
            ttl: i(2)?,
            entries: entries(r(3)?)?,
        },
        33 => LotusPayload::Post {
            network,
            topic: {
                let topic = s(1)?;
                if topic.is_empty() || topic.len() > 4096 {
                    return Err(bad("topic byte length bound"));
                }
                topic
            },
            timestamp: i(2)?,
            entries: entries(r(3)?)?,
            parent: get(m, 4).map(reference).transpose()?,
        },
        34 => LotusPayload::Offering {
            network,
            target: reference(r(1)?)?,
            direction: uint(r(2)?, 1)? as u8,
        },
        35 => {
            if m.is_empty() {
                return Err(bad("post text requires a present field"));
            }
            LotusPayload::Text {
                title: get(m, 0).map(text).transpose()?,
                url: get(m, 1).map(text).transpose()?,
                message: get(m, 2).map(text).transpose()?,
            }
        }
        36 => {
            let sig = map(&list(r(2)?, 1, 1)?[0], &[0, 1, 2], &[])?;
            let algorithm = uint(req(sig, 0)?, 65535)? as u32;
            let signer = account(req(sig, 1)?)?;
            let signature = bytes(req(sig, 2)?, 1, 512)?;
            let burns = list(r(3)?, 0, 64)?
                .iter()
                .map(|v| {
                    let m = map(v, &[0, 1], &[])?;
                    Ok(LotusBurn {
                        raw: bytes(req(m, 0)?, 1, 1048576)?,
                        output_index: uint(req(m, 1)?, u32::MAX as u64)? as u32,
                    })
                })
                .collect::<Result<Vec<_>, CodecError>>()?;
            LotusPayload::Submission {
                network,
                body_frame: framed_bytes(r(1)?)?,
                body: None,
                signature: SignatureEntry {
                    algorithm,
                    signer,
                    signature,
                },
                burns,
                claimed_burn: get(m, 4).map(|v| uint(v, i64::MAX as u64)).transpose()?,
            }
        }
        37 => LotusPayload::HistoricalManifest {
            network,
            digest: d(1)?,
            author: account(r(2)?)?,
            kind: uint(r(3)?, 2)? as u8,
            observed: i(4)?,
            ttl: get(m, 5).map(signed).transpose()?,
            parent: get(m, 6).map(reference).transpose()?,
            total_burn: u(7)?,
            component_count: u(8)?,
            authored: get(m, 9).map(signed).transpose()?,
            target: get(m, 10).map(reference).transpose()?,
        },
        38 => {
            let rows = list(r(5)?, 0, 100)?
                .iter()
                .map(|v| {
                    let m = map(v, &[0, 1, 2, 3], &[4])?;
                    let type_id = uint(req(m, 0)?, 43)? as u32;
                    if !matches!(type_id, 36 | 37 | 43) {
                        return Err(bad("inventory descriptor type"));
                    }
                    Ok(LotusDescriptor {
                        type_id,
                        index: fixed(req(m, 1)?)?,
                        sequence: uint(req(m, 2)?, u64::MAX)?,
                        time: signed(req(m, 3)?)?,
                        target: get(m, 4).map(reference).transpose()?,
                    })
                })
                .collect::<Result<Vec<_>, CodecError>>()?;
            LotusPayload::Inventory {
                network,
                collection: uint(r(1)?, 4)? as u8,
                epoch: fixed(r(2)?)?,
                incarnation: u(3)?,
                ceiling: u(4)?,
                rows,
                next: get(m, 6).map(|v| bytes(v, 1, 2048)).transpose()?,
                echo: get(m, 7).map(|v| bytes(v, 1, 2048)).transpose()?,
            }
        }
        39 => LotusPayload::Summary {
            network,
            target: reference(r(1)?)?,
            revision: u(2)?,
            physical: u(3)?,
            support: u(4)?,
            oppose: u(5)?,
        },
        40 => LotusPayload::Result {
            network,
            request: d(1)?,
            phase: uint(r(2)?, 3)? as u8,
            txids: list(r(3)?, 0, 64)?
                .iter()
                .map(fixed)
                .collect::<Result<Vec<_>, CodecError>>()?,
            sequence: get(m, 4).map(|v| uint(v, u64::MAX)).transpose()?,
            reason: get(m, 5).map(text).transpose()?,
        },
        41 => LotusPayload::Peers {
            network,
            origins: list(r(1)?, 0, 32)?
                .iter()
                .map(|v| {
                    let origin = text(v)?;
                    if origin.is_empty() {
                        return Err(bad("empty peer origin"));
                    }
                    Ok(origin)
                })
                .collect::<Result<Vec<_>, CodecError>>()?,
        },
        42 => LotusPayload::Error {
            network,
            code: {
                let code = s(1)?;
                if code.is_empty() || code.len() > 64 {
                    return Err(bad("error code byte length"));
                }
                code
            },
            request: get(m, 2).map(fixed).transpose()?,
            retryable: match r(3)? {
                CborValue::Bool(b) => *b,
                _ => return Err(bad("retryable must be bool")),
            },
        },
        43 => {
            let p = list(r(3)?, 4, 4)?;
            LotusPayload::HistoricalChunk {
                network,
                digest: d(1)?,
                ordinal: u(2)?,
                path: [
                    uint(&p[0], u64::MAX)?,
                    uint(&p[1], u64::MAX)?,
                    uint(&p[2], u64::MAX)?,
                    uint(&p[3], u64::MAX)?,
                ],
                encoding: uint(r(4)?, 1)? as u8,
                total: u(5)?,
                offset: u(6)?,
                chunk: bytes(r(7)?, 0, 65536)?,
            }
        }
        _ => unreachable!(),
    })
}
/// Closed family predicates. Runtime trust, transaction ownership and snapshots are separate.
pub(crate) fn check(value: &LotusPayload) -> Result<(), CodecError> {
    match value {
        LotusPayload::Metadata { entries, .. } | LotusPayload::Post { entries, .. } => {
            for e in entries {
                if e.headers.windows(2).any(|p| {
                    p[0].0
                        .as_bytes()
                        .cmp(p[1].0.as_bytes())
                        .then_with(|| p[0].1.as_bytes().cmp(p[1].1.as_bytes()))
                        != std::cmp::Ordering::Less
                }) {
                    return Err(semantic("headers require exact UTF8 pair order"));
                }
                let mut names = std::collections::HashSet::new();
                for (name, _) in &e.headers {
                    if !names.insert(name) {
                        return Err(semantic("duplicate header name"));
                    }
                }
                if e.kind == "post" && e.post.is_none() {
                    return Err(semantic("known post entry requires type35"));
                }
            }
            if let LotusPayload::Post { topic, .. } = value {
                let segments: Vec<_> = topic.split('.').collect();
                if topic.len() > 4096
                    || segments.is_empty()
                    || segments.len() > 10
                    || segments.iter().any(|s| {
                        s.is_empty()
                            || !s
                                .chars()
                                .all(|c| c.is_lowercase() || c.is_numeric() || c == '-')
                    })
                {
                    return Err(semantic("invalid Lotus topic"));
                }
            }
        }
        LotusPayload::Submission {
            network,
            body,
            burns,
            ..
        } => {
            let b = body
                .as_ref()
                .ok_or_else(|| semantic("required Lotus body missing"))?;
            let Some(TypedPayload::Lotus(p)) = b.typed.as_deref() else {
                return Err(semantic("required Lotus body projection"));
            };
            if !matches!(b.type_id, 32..=34) || p.network() != network {
                return Err(semantic("Lotus body network mismatch"));
            }
            for (i, burn) in burns.iter().enumerate() {
                if burns[..i]
                    .iter()
                    .any(|old| old.output_index == burn.output_index && old.raw == burn.raw)
                {
                    return Err(semantic("duplicate selected Lotus output"));
                }
            }
        }
        LotusPayload::HistoricalManifest {
            kind,
            ttl,
            parent,
            authored,
            target,
            ..
        } => {
            if (*kind == 0) != ttl.is_some()
                || (*kind != 2) != authored.is_some()
                || (*kind == 2) != target.is_some()
                || (*kind != 1 && parent.is_some())
            {
                return Err(semantic("historical manifest conditional fields"));
            }
        }
        LotusPayload::Summary {
            physical,
            support,
            oppose,
            ..
        } => {
            if support.checked_add(*oppose) != Some(*physical) {
                return Err(semantic("summary physical sum mismatch or overflow"));
            }
        }
        LotusPayload::Result {
            phase,
            txids,
            sequence,
            reason,
            ..
        } => {
            let valid = match phase {
                0 | 3 => txids.is_empty() && sequence.is_none() && reason.is_none(),
                1 => sequence.is_some() && reason.is_none(),
                2 => sequence.is_none() && reason.is_some(),
                _ => false,
            };
            if !valid {
                return Err(semantic("operation phase conditional fields"));
            }
            let mut seen = std::collections::HashSet::new();
            if txids.iter().any(|t| !seen.insert(t)) {
                return Err(semantic("duplicate native transaction id"));
            }
        }
        LotusPayload::Peers { origins, .. } => {
            if origins
                .windows(2)
                .any(|p| p[0].as_bytes() >= p[1].as_bytes())
                || origins.iter().any(|s| !https_origin(s))
            {
                return Err(semantic("peers require unique sorted exact HTTPS origins"));
            }
        }
        LotusPayload::Error { code, .. } => {
            if code.is_empty()
                || code.len() > 64
                || !code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            {
                return Err(semantic("invalid sanitized Lotus error code"));
            }
        }
        LotusPayload::HistoricalChunk {
            path,
            total,
            offset,
            chunk,
            ..
        } => {
            let valid = match path[0] {
                0 => path[1..] == [0, 0, 0],
                1 | 4 | 5 | 6 | 7 => path[2..] == [0, 0],
                2 | 3 => path[3] == 0,
                _ => false,
            };
            if !valid
                || offset
                    .checked_add(chunk.len() as u64)
                    .map_or(true, |end| end > *total)
            {
                return Err(semantic("invalid historical component path/encoding/range"));
            }
        }
        _ => {}
    }
    Ok(())
}
fn https_origin(s: &str) -> bool {
    let Some(authority) = s.strip_prefix("https://") else {
        return false;
    };
    if authority.is_empty()
        || !authority.is_ascii()
        || authority
            .bytes()
            .any(|b| b <= 32 || b >= 127 || matches!(b, b'/' | b'?' | b'#' | b'@' | b'\\'))
    {
        return false;
    }
    let (host, port) = if authority.starts_with('[') {
        let Some(end) = authority.find(']') else {
            return false;
        };
        let host = &authority[..=end];
        let rest = &authority[end + 1..];
        if rest.is_empty() {
            (host, None)
        } else if let Some(port) = rest.strip_prefix(':') {
            (host, Some(port))
        } else {
            return false;
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if host.is_empty() || host.bytes().any(|b| b.is_ascii_uppercase()) {
        return false;
    }
    if let Some(port) = port {
        if port.is_empty()
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.starts_with('0')
            || port == "443"
            || port.parse::<u16>().ok().filter(|n| *n > 0).is_none()
        {
            return false;
        }
    }
    if host.starts_with('[') {
        let value = &host[1..host.len() - 1];
        return value
            .parse::<std::net::Ipv6Addr>()
            .is_ok_and(|address| address.to_string() == value);
    }
    let last = host.rsplit('.').next().unwrap_or("");
    let numeric = last.bytes().all(|b| b.is_ascii_digit())
        || last.strip_prefix("0x").is_some_and(|digits| {
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_hexdigit())
        });
    if numeric {
        return host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|address| address.to_string() == host);
    }
    host.len() <= 253
        && !host.starts_with('.')
        && !host.ends_with('.')
        && host.split('.').all(|p| {
            !p.is_empty()
                && p.len() <= 63
                && !p.starts_with('-')
                && !p.ends_with('-')
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
fn cv_u(n: u64) -> CborValue {
    CborValue::Int(n as i128)
}
fn cv_i(n: i64) -> CborValue {
    CborValue::Int(n as i128)
}
fn cv_s(s: &str) -> CborValue {
    CborValue::Text(s.into())
}
fn cv_b(b: &[u8]) -> CborValue {
    CborValue::Bytes(b.to_vec())
}
fn cv_ref(r: &LotusReference) -> CborValue {
    crate::cbor_map(vec![(0, cv_u(r.origin as u64)), (1, cv_b(&r.hash))])
}
fn cv_account(a: &AccountRef) -> CborValue {
    crate::cbor_map(vec![(0, cv_u(a.key_type as u64)), (1, cv_b(&a.key_bytes))])
}
fn cv_entries(entries: &[LotusEntry]) -> CborValue {
    CborValue::Array(
        entries
            .iter()
            .map(|e| {
                crate::cbor_map(vec![
                    (0, cv_s(&e.kind)),
                    (
                        1,
                        CborValue::Array(
                            e.headers
                                .iter()
                                .map(|(n, v)| CborValue::Array(vec![cv_s(n), cv_s(v)]))
                                .collect(),
                        ),
                    ),
                    (2, cv_b(&e.data)),
                ])
            })
            .collect(),
    )
}
fn wire(p: &LotusPayload) -> CborValue {
    use LotusPayload::*;
    let mut m = if matches!(p, Text { .. }) {
        vec![]
    } else {
        vec![(0, cv_s(p.network()))]
    };
    match p {
        Metadata {
            timestamp,
            ttl,
            entries,
            ..
        } => m.extend([
            (1, cv_i(*timestamp)),
            (2, cv_i(*ttl)),
            (3, cv_entries(entries)),
        ]),
        Post {
            topic,
            timestamp,
            entries,
            parent,
            ..
        } => {
            m.extend([
                (1, cv_s(topic)),
                (2, cv_i(*timestamp)),
                (3, cv_entries(entries)),
            ]);
            if let Some(p) = parent {
                m.push((4, cv_ref(p)))
            }
        }
        Offering {
            target, direction, ..
        } => m.extend([(1, cv_ref(target)), (2, cv_u(*direction as u64))]),
        Text {
            title,
            url,
            message,
        } => {
            for (k, v) in [(0, title), (1, url), (2, message)] {
                if let Some(s) = v {
                    m.push((k, cv_s(s)))
                }
            }
        }
        Submission {
            body_frame,
            signature,
            burns,
            claimed_burn,
            ..
        } => {
            m.extend([
                (1, cv_b(body_frame)),
                (
                    2,
                    CborValue::Array(vec![crate::cbor_map(vec![
                        (0, cv_u(signature.algorithm as u64)),
                        (1, cv_account(&signature.signer)),
                        (2, cv_b(&signature.signature)),
                    ])]),
                ),
                (
                    3,
                    CborValue::Array(
                        burns
                            .iter()
                            .map(|b| {
                                crate::cbor_map(vec![
                                    (0, cv_b(&b.raw)),
                                    (1, cv_u(b.output_index as u64)),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]);
            if let Some(n) = claimed_burn {
                m.push((4, cv_u(*n)))
            }
        }
        HistoricalManifest {
            digest,
            author,
            kind,
            observed,
            ttl,
            parent,
            total_burn,
            component_count,
            authored,
            target,
            ..
        } => {
            m.extend([
                (1, cv_b(digest)),
                (2, cv_account(author)),
                (3, cv_u(*kind as u64)),
                (4, cv_i(*observed)),
                (7, cv_u(*total_burn)),
                (8, cv_u(*component_count)),
            ]);
            if let Some(n) = ttl {
                m.push((5, cv_i(*n)))
            }
            if let Some(p) = parent {
                m.push((6, cv_ref(p)))
            }
            if let Some(n) = authored {
                m.push((9, cv_i(*n)))
            }
            if let Some(p) = target {
                m.push((10, cv_ref(p)))
            }
        }
        Inventory {
            collection,
            epoch,
            incarnation,
            ceiling,
            rows,
            next,
            echo,
            ..
        } => {
            m.extend([
                (1, cv_u(*collection as u64)),
                (2, cv_b(epoch)),
                (3, cv_u(*incarnation)),
                (4, cv_u(*ceiling)),
                (
                    5,
                    CborValue::Array(
                        rows.iter()
                            .map(|r| {
                                let mut m = vec![
                                    (0, cv_u(r.type_id as u64)),
                                    (1, cv_b(&r.index)),
                                    (2, cv_u(r.sequence)),
                                    (3, cv_i(r.time)),
                                ];
                                if let Some(p) = &r.target {
                                    m.push((4, cv_ref(p)))
                                }
                                crate::cbor_map(m)
                            })
                            .collect(),
                    ),
                ),
            ]);
            if let Some(b) = next {
                m.push((6, cv_b(b)))
            }
            if let Some(b) = echo {
                m.push((7, cv_b(b)))
            }
        }
        Summary {
            target,
            revision,
            physical,
            support,
            oppose,
            ..
        } => m.extend([
            (1, cv_ref(target)),
            (2, cv_u(*revision)),
            (3, cv_u(*physical)),
            (4, cv_u(*support)),
            (5, cv_u(*oppose)),
        ]),
        Result {
            request,
            phase,
            txids,
            sequence,
            reason,
            ..
        } => {
            m.extend([
                (1, cv_b(request)),
                (2, cv_u(*phase as u64)),
                (3, CborValue::Array(txids.iter().map(|b| cv_b(b)).collect())),
            ]);
            if let Some(n) = sequence {
                m.push((4, cv_u(*n)))
            }
            if let Some(s) = reason {
                m.push((5, cv_s(s)))
            }
        }
        Peers { origins, .. } => m.push((
            1,
            CborValue::Array(origins.iter().map(|s| cv_s(s)).collect()),
        )),
        Error {
            code,
            request,
            retryable,
            ..
        } => {
            m.extend([(1, cv_s(code)), (3, CborValue::Bool(*retryable))]);
            if let Some(d) = request {
                m.push((2, cv_b(d)))
            }
        }
        HistoricalChunk {
            digest,
            ordinal,
            path,
            encoding,
            total,
            offset,
            chunk,
            ..
        } => m.extend([
            (1, cv_b(digest)),
            (2, cv_u(*ordinal)),
            (3, CborValue::Array(path.iter().map(|n| cv_u(*n)).collect())),
            (4, cv_u(*encoding as u64)),
            (5, cv_u(*total)),
            (6, cv_u(*offset)),
            (7, cv_b(chunk)),
        ]),
    }
    crate::cbor_map(m)
}
/// Deterministically encode through the ordinary shared typed validator.
pub fn encode_lotus_public(p: &LotusPayload) -> Result<Vec<u8>, crate::Error> {
    let v = wire(p);
    let frame = crate::encode_frame(
        crate::EnvelopeFields {
            type_id: p.type_id(),
            schema_version: 1,
            min_reader_version: 1,
        },
        crate::FramePayload::Value(&v),
    )
    .map_err(|e| crate::Error::Context(crate::ContextError(e.to_string())))?;
    crate::validate_frame(&frame, &crate::default_context())?;
    Ok(frame)
}
/// Owned exact frame and validated closed projection, with no child budget reset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotusProjection {
    /// Forward these original bytes unchanged.
    pub frame: Vec<u8>,
    /// Structural value; never runtime admission evidence.
    pub payload: LotusPayload,
}
/// Project an already opened frame; never revalidate it as a root.
pub fn project_lotus_public(frame: &ParsedFrame) -> Result<LotusProjection, UsageError> {
    match frame.typed.as_deref() {
        Some(TypedPayload::Lotus(p)) if p.type_id() == frame.type_id => Ok(LotusProjection {
            frame: frame.frame.clone(),
            payload: p.clone(),
        }),
        _ => Err(UsageError("expected validated Lotus frame".into())),
    }
}
/// Approved native-family/network registry rows; other families and XPI testnet refuse.
/// String labels avoid a dependency on runtime-owned native enums.
pub fn lotus_network_descriptor(family: &str, network: &str) -> Result<&'static str, UsageError> {
    match (family, network) {
        ("xpi", "mainnet") => Ok("xpi-mainnet"),
        ("xpi", "regtest") => Ok("xpi-regtest"),
        _ => Err(UsageError("unsupported Lotus native family/network".into())),
    }
}
fn body(frame: &ParsedFrame) -> Result<&LotusPayload, UsageError> {
    match frame.typed.as_deref() {
        Some(TypedPayload::Lotus(p))
            if matches!(frame.type_id, 32..=34) && p.type_id() == frame.type_id =>
        {
            Ok(p)
        }
        _ => Err(UsageError("expected validated Lotus economic body".into())),
    }
}
/// T1 of an exact validated type32,33 or34 body.
pub fn lotus_body_hash(frame: &ParsedFrame) -> Result<[u8; 32], UsageError> {
    body(frame)?;
    crate::content_hash(frame)
}
/// Common transcript digest with the registered Lotus signature domain.
pub fn lotus_signature_digest(frame: &ParsedFrame) -> Result<[u8; 32], UsageError> {
    let p = body(frame)?;
    let t = crate::common_transcript(
        "frank/lotus-public-signature/v1",
        p.network(),
        &frame.frame,
        &[],
    )?;
    Ok(Sha256::digest(&t).into())
}
/// SHA256(SHA256(compressed signer)||body T1); no transaction math or chain parsing.
pub fn lotus_burn_commitment(
    signer: &AccountRef,
    body_hash: &[u8; 32],
) -> Result<[u8; 32], UsageError> {
    if signer.key_type != 1
        || signer.key_bytes.len() != 33
        || secp256k1_abc::PublicKey::from_slice(&signer.key_bytes).is_err()
    {
        return Err(UsageError("expected compressed signer key1".into()));
    }
    let mut h = Sha256::new();
    h.update(Sha256::digest(&signer.key_bytes));
    h.update(body_hash);
    Ok(h.finalize().into())
}
/// Verification classification never upgrades structural Schnorr shape to verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LotusVerification {
    /// Algorithm1 verified the exact common digest.
    Verified,
    /// Signature failed verification.
    Invalid,
    /// This precursor has no algorithm3 verifier.
    Unsupported,
}
/// Pure signature verification only, with no runtime admission or receipt guarantee.
pub fn verify_lotus_submission(frame: &ParsedFrame) -> Result<LotusVerification, UsageError> {
    let Some(TypedPayload::Lotus(LotusPayload::Submission {
        body: Some(body),
        signature,
        ..
    })) = frame.typed.as_deref()
    else {
        return Err(UsageError("expected validated Lotus submission".into()));
    };
    if frame.type_id != 36 {
        return Err(UsageError("expected type36".into()));
    }
    if signature.algorithm == 3 {
        return Ok(LotusVerification::Unsupported);
    }
    let digest = lotus_signature_digest(body)?;
    Ok(
        if signature.algorithm == 1
            && signature.signer.key_type == 1
            && crate::verify_algorithm_1(&digest, &signature.signature, &signature.signer.key_bytes)
        {
            LotusVerification::Verified
        } else {
            LotusVerification::Invalid
        },
    )
}
/// Allocation checks use the same common account/signature tables as existing types.
pub(crate) fn allocated(p: &LotusPayload) -> Result<(), CodecError> {
    match p {
        LotusPayload::Submission { signature: s, .. } => {
            if !matches!(s.algorithm, 1 | 3) {
                return Err(CodecError::new(
                    ErrorCategory::Unsupported,
                    ErrorStage::S83,
                    "Lotus signature algorithm must be1 or3",
                    "root/payload.2[0]",
                    None,
                ));
            }
            crate::schema::check_key_type(&s.signer, "root/payload.2[0].1")?;
            crate::schema::check_signature_shape(
                s.algorithm,
                &s.signer,
                &s.signature,
                "root/payload.2[0]",
            )?;
            if s.algorithm == 1 {
                let (_, scalar) = crate::parse_strict_der(&s.signature)
                    .map_err(|_| bad("strict DER signature"))?;
                if !crate::has_low_s(&scalar) {
                    return Err(bad("high-S signature"));
                }
            }
            Ok(())
        }
        LotusPayload::HistoricalManifest { author, .. } => {
            crate::schema::check_key_type(author, "root/payload.2")
        }
        _ => Ok(()),
    }
}
/// Stage8.1 count/byte caps precede typed projection copies, including malformed shapes.
pub(crate) fn check_limits(t: u32, p: &CborValue) -> Result<(), CodecError> {
    let CborValue::Map(m) = p else { return Ok(()) };
    let count = |v: Option<&CborValue>, n: usize| -> Result<(), CodecError> {
        if matches!(v,Some(CborValue::Array(a)) if a.len()>n) {
            Err(resource("Lotus field count limit"))
        } else {
            Ok(())
        }
    };
    let size = |v: Option<&CborValue>, n: usize| -> Result<(), CodecError> {
        if matches!(v,Some(CborValue::Bytes(b)) if b.len()>n) {
            Err(resource("Lotus field byte limit"))
        } else {
            Ok(())
        }
    };
    match t {
        32 | 33 => {
            count(get(m, 3), 64)?;
            if let Some(CborValue::Array(a)) = get(m, 3) {
                for e in a {
                    if let CborValue::Map(e) = e {
                        count(get(e, 1), 32)?
                    }
                }
            }
        }
        36 => {
            count(get(m, 3), 64)?;
            if let Some(CborValue::Array(a)) = get(m, 3) {
                for b in a {
                    if let CborValue::Map(b) = b {
                        size(get(b, 0), 1048576)?
                    }
                }
            }
        }
        38 => {
            count(get(m, 5), 100)?;
            size(get(m, 6), 2048)?;
            size(get(m, 7), 2048)?
        }
        40 => count(get(m, 3), 64)?,
        41 => count(get(m, 1), 32)?,
        43 => size(get(m, 7), 65536)?,
        _ => {}
    }
    Ok(())
}
/// Ordinary exact-GET lookup index; this digest grants no author authority.
pub fn lotus_request_index(frame: &ParsedFrame) -> Result<[u8; 32], UsageError> {
    if !matches!(frame.typed.as_deref(),Some(TypedPayload::Lotus(p)) if p.type_id()==frame.type_id)
        || !matches!(frame.type_id, 36 | 37 | 43)
    {
        return Err(UsageError("exactGET requires type36/37/43".into()));
    }
    Ok(Sha256::digest(&frame.frame).into())
}
/// Exact native commitment script, without constructing or parsing a transaction.
pub fn lotus_burn_script(frame: &ParsedFrame, signer: &AccountRef) -> Result<[u8; 40], UsageError> {
    let p = body(frame)?;
    let hash = lotus_body_hash(frame)?;
    let commitment = lotus_burn_commitment(signer, &hash)?;
    let mut script = [0u8; 40];
    script[0] = 0x6a;
    script[1] = 4;
    script[2..6].copy_from_slice(if p.type_id() == 32 { b"STMP" } else { b"POND" });
    script[6] = 0x51;
    script[7] = 32;
    script[8..].copy_from_slice(&commitment);
    Ok(script)
}
