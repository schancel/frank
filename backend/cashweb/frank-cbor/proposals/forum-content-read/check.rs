//! Offline proposal fixtures only; no production API, network, or writes.
use frank_cbor::{
    common_transcript, decode_canonical, encode_canonical, encode_frame, keccak256,
    topic_vote_commitment, CborValue as V, EnvelopeFields, FramePayload,
};
use serde_json::Value as J;
use sha2::{Digest, Sha256};

const NET: &str = "monad-testnet";
const MAX: i128 = u64::MAX as i128;
type Check<T> = Result<T, String>;
fn need(ok: bool, message: &str) -> Check<()> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn map(v: &V) -> Check<&Vec<(u64, V)>> {
    if let V::Map(m) = v {
        Ok(m)
    } else {
        Err("map".into())
    }
}
fn get(v: &V, k: u64) -> Check<&V> {
    map(v)?
        .iter()
        .find(|x| x.0 == k)
        .map(|x| &x.1)
        .ok_or_else(|| format!("field {k}"))
}
fn has(v: &V, k: u64) -> bool {
    get(v, k).is_ok()
}
fn keys(v: &V, allowed: &[u64], future: bool) -> Check<()> {
    need(
        map(v)?.iter().all(|(k, _)| future || allowed.contains(k)),
        "unknown key",
    )
}
fn uint(v: &V, max: i128) -> Check<i128> {
    if let V::Int(n) = v {
        need(*n >= 0 && *n <= max, "uint")?;
        Ok(*n)
    } else {
        Err("uint".into())
    }
}
fn bytes(v: &V, min: usize, max: usize) -> Check<&[u8]> {
    if let V::Bytes(b) = v {
        need(b.len() >= min && b.len() <= max, "bytes")?;
        Ok(b)
    } else {
        Err("bytes".into())
    }
}
fn text(v: &V, min: usize, max: usize) -> Check<&str> {
    if let V::Text(s) = v {
        need(s.len() >= min && s.len() <= max, "text")?;
        Ok(s)
    } else {
        Err("text".into())
    }
}
fn array(v: &V) -> Check<&Vec<V>> {
    if let V::Array(a) = v {
        Ok(a)
    } else {
        Err("array".into())
    }
}
fn timestamp(v: &V) -> Check<()> {
    keys(v, &[0, 1], false)?;
    if let V::Int(s) = get(v, 0)? {
        need(*s >= i64::MIN as i128 && *s <= i64::MAX as i128, "seconds")?
    } else {
        return Err("seconds".into());
    };
    uint(get(v, 1)?, 999999999)?;
    Ok(())
}
fn time(v: &V) -> Check<(i128, i128)> {
    timestamp(v)?;
    if let V::Int(s) = get(v, 0)? {
        Ok((*s, uint(get(v, 1)?, 999999999)?))
    } else {
        unreachable!()
    }
}
fn decode(b: &[u8]) -> Check<V> {
    decode_canonical(b).map_err(|e| e.to_string())
}
fn m(v: Vec<(u64, V)>) -> V {
    V::Map(v)
}
fn s(v: &str) -> V {
    V::Text(v.into())
}
fn b(v: &[u8]) -> V {
    V::Bytes(v.to_vec())
}
fn n(v: i128) -> V {
    V::Int(v)
}
fn stamp(seconds: i128, nanos: i128) -> V {
    m(vec![(0, n(seconds)), (1, n(nanos))])
}
fn hash(raw: &[u8]) -> [u8; 32] {
    Sha256::digest(raw).into()
}
fn t1(raw: &[u8]) -> [u8; 32] {
    let p = open(raw).unwrap().p;
    hash(
        &common_transcript(
            "frank/content-hash/v1",
            text(get(&p, 0).unwrap(), 1, 64).unwrap(),
            raw,
            &[],
        )
        .unwrap(),
    )
}
fn encode(kind: u32, schema: u32, min: u32, payload: &V) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id: kind,
            schema_version: schema,
            min_reader_version: min,
        },
        FramePayload::Value(payload),
    )
    .unwrap()
}
fn recipe(v: &J) -> V {
    if v.is_null() {
        V::Null
    } else if let Some(x) = v.as_bool() {
        V::Bool(x)
    } else if let Some(x) = v.as_str() {
        s(x)
    } else if let Some(a) = v.as_array() {
        V::Array(a.iter().map(recipe).collect())
    } else if let Some(x) = v["int"].as_str() {
        n(x.parse().unwrap())
    } else if let Some(x) = v["hex"].as_str() {
        b(&hex::decode(x).unwrap())
    } else {
        m(v["map"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (x[0].as_u64().unwrap(), recipe(&x[1])))
            .collect())
    }
}
struct Frame {
    kind: u32,
    schema: u32,
    min: u32,
    p: V,
}
fn open(raw: &[u8]) -> Check<Frame> {
    need(
        raw.len() >= 9 && raw.len() <= 8388617 && raw[..5] == *b"FRNK\x01",
        "frame",
    )?;
    need(
        u32::from_be_bytes(raw[5..9].try_into().unwrap()) as usize == raw.len() - 9,
        "length",
    )?;
    let e = decode(&raw[9..])?;
    keys(&e, &[0, 1, 2, 3], false)?;
    let kind = uint(get(&e, 0)?, u32::MAX as i128)? as u32;
    let schema = uint(get(&e, 1)?, u32::MAX as i128)? as u32;
    let min = uint(get(&e, 2)?, u32::MAX as i128)? as u32;
    need(min >= 1 && min <= schema, "version")?;
    Ok(Frame {
        kind,
        schema,
        min,
        p: decode(bytes(get(&e, 3)?, 1, 8388608)?)?,
    })
}
fn validate(raw: &[u8]) -> Check<Frame> {
    let f = open(raw)?;
    let p = &f.p;
    let supported = if f.kind == 9 { 2 } else { 1 };
    let future = f.schema > supported;
    need(
        f.min <= supported && f.schema >= supported,
        "required version",
    )?;
    text(get(p, 0)?, 1, 64)?;
    match f.kind {
        9 => {
            need(raw.len() <= 1048576, "post limit")?;
            keys(p, &[0, 1, 2, 3], future)?;
            text(get(p, 1)?, 1, 512)?;
            if has(p, 2) {
                bytes(get(p, 2)?, 32, 32)?;
            }
            let c = decode(bytes(get(p, 3)?, 1, 524288)?)?;
            keys(&c, &[0, 1], future)?;
            timestamp(get(&c, 0)?)?;
            let entries = array(get(&c, 1)?)?;
            need(!entries.is_empty() && entries.len() <= 64, "entry count")?;
            for entry in entries {
                let kind = uint(get(entry, 0)?, MAX)?;
                need(kind == 1 || future, "kind")?;
                if kind == 1 {
                    keys(entry, &[0, 1, 2, 3], future)?;
                    for k in [1, 2, 3] {
                        if has(entry, k) {
                            text(get(entry, k)?, 0, 262144)?;
                        }
                    }
                }
            }
        }
        10 | 11 => {
            keys(p, &[0, 1, 2], future)?;
            need(
                raw.len() <= if f.kind == 10 { 1048576 } else { 65536 },
                "submission limit",
            )?;
            bytes(get(p, 2)?, 1, 16384)?;
            if f.kind == 10 {
                let post = validate(bytes(get(p, 1)?, 9, 1048576)?)?;
                need(
                    post.kind == 9 && get(&post.p, 0)? == get(p, 0)?,
                    "post network",
                )?;
            } else {
                bytes(get(p, 1)?, 32, 32)?;
            }
        }
        12 => {
            need(raw.len() <= 2097152, "view limit")?;
            keys(p, &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], future)?;
            let post = validate(bytes(get(p, 1)?, 9, 1048576)?)?;
            need(
                post.kind == 9 && get(&post.p, 0)? == get(p, 0)?,
                "view network",
            )?;
            bytes(get(p, 2)?, 20, 20)?;
            bytes(get(p, 3)?, 1, 16384)?;
            bytes(get(p, 4)?, 32, 32)?;
            timestamp(get(p, 5)?)?;
            for k in [6, 7, 9] {
                uint(get(p, k)?, MAX)?;
            }
            bytes(get(p, 10)?, 16, 16)?;
            let a = get(p, 8)?;
            keys(a, &[0, 1], future)?;
            let mag = bytes(get(a, 1)?, 32, 32)?;
            if let V::Bool(negative) = get(a, 0)? {
                need(!negative || mag.iter().any(|x| *x != 0), "negative zero")?
            } else {
                return Err("sign".into());
            }
        }
        13 | 14 => {
            need(raw.len() <= 4194304, "page limit")?;
            let topic = f.kind == 13;
            keys(
                p,
                if topic {
                    &[0, 1, 2, 3, 4, 5, 6, 7]
                } else {
                    &[0, 1, 2, 3, 4, 5]
                },
                future,
            )?;
            if topic {
                text(get(p, 1)?, 1, 512)?;
                timestamp(get(p, 2)?)?;
            }
            let rev = get(p, if topic { 3 } else { 1 })?;
            uint(rev, MAX)?;
            let epoch = bytes(get(p, if topic { 6 } else { 4 })?, 16, 16)?;
            let rows = array(get(p, if topic { 4 } else { 2 })?)?;
            need(rows.len() <= 128, "row count")?;
            for k in if topic { [5, 7] } else { [3, 5] } {
                if has(p, k) {
                    bytes(get(p, k)?, 1, 2048)?;
                }
            }
            need(
                !rows.is_empty() || !has(p, if topic { 5 } else { 3 }),
                "empty continuation",
            )?;
            let mut previous: Option<((i128, i128), [u8; 32])> = None;
            let mut previous_topic: Option<&str> = None;
            for row in rows {
                if topic {
                    let v = validate(bytes(row, 9, 2097152)?)?;
                    need(v.kind == 12, "row type")?;
                    let post_bytes = bytes(get(&v.p, 1)?, 9, 1048576)?;
                    let post = validate(post_bytes)?;
                    need(
                        get(&v.p, 0)? == get(p, 0)?
                            && get(&post.p, 1)? == get(p, 1)?
                            && get(&v.p, 9)? == rev
                            && bytes(get(&v.p, 10)?, 16, 16)? == epoch,
                        "row binding",
                    )?;
                    let tuple = (time(get(&v.p, 5)?)?, t1(post_bytes));
                    need(tuple.0 >= time(get(p, 2)?)?, "since")?;
                    if let Some(last) = previous {
                        need(last < tuple, "row order")?;
                    }
                    previous = Some(tuple);
                } else {
                    keys(row, &[0, 1, 2], future)?;
                    let name = text(get(row, 0)?, 1, 512)?;
                    uint(get(row, 1)?, MAX)?;
                    timestamp(get(row, 2)?)?;
                    if let Some(last) = previous_topic {
                        need(last.as_bytes() < name.as_bytes(), "discovery order")?;
                    }
                    previous_topic = Some(name);
                }
            }
        }
        15 => {
            need(raw.len() <= 2097152, "status limit")?;
            keys(p, &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], future)?;
            let sub = validate(bytes(get(p, 1)?, 9, 1048576)?)?;
            need(
                (sub.kind == 10 || sub.kind == 11) && get(&sub.p, 0)? == get(p, 0)?,
                "status network",
            )?;
            let target = if sub.kind == 10 {
                t1(bytes(get(&sub.p, 1)?, 9, 1048576)?).to_vec()
            } else {
                bytes(get(&sub.p, 1)?, 32, 32)?.to_vec()
            };
            need(bytes(get(p, 2)?, 32, 32)? == target, "status target")?;
            bytes(get(p, 3)?, 32, 32)?;
            bytes(get(p, 4)?, 20, 20)?;
            uint(get(p, 5)?, 1)?;
            let amount = uint(get(p, 6)?, MAX)?;
            let state = uint(get(p, 7)?, 3)?;
            need(
                has(p, 8) == (state == 2) && has(p, 9) == (state == 2),
                "confirmation position",
            )?;
            if state == 2 {
                uint(get(p, 8)?, MAX)?;
                uint(get(p, 9)?, MAX)?;
            }
            if state == 1 || state == 2 {
                need(amount > 0 && amount <= i64::MAX as i128, "burn ceiling")?;
            }
            uint(get(p, 10)?, MAX)?;
            bytes(get(p, 11)?, 16, 16)?;
        }
        _ => return Err("unknown type".into()),
    }
    Ok(f)
}
fn bind_status(raw: &[u8], request: &V, observation: Option<&V>) -> Check<&'static str> {
    let f = validate(raw)?;
    for k in 0..=6 {
        need(get(&f.p, k)? == get(request, k)?, "request mismatch")?;
    }
    let state = uint(get(&f.p, 7)?, 3)?;
    if state == 0 || state == 3 {
        return Ok("unverified-request");
    }
    let observed = observation.ok_or("missing observation")?;
    let sub = open(bytes(get(&f.p, 1)?, 9, 1048576)?)?;
    need(
        bytes(get(&f.p, 3)?, 32, 32)? == keccak256(bytes(get(&sub.p, 2)?, 1, 16384)?),
        "raw transaction hash",
    )?;
    for k in 0..=6 {
        need(get(&f.p, k)? == get(observed, k)?, "observation mismatch")?;
    }
    Ok(if state == 2 {
        "relay-confirmed"
    } else {
        "relay-pending"
    })
}
fn replace(v: &V, key: u64, val: V) -> V {
    m(map(v)
        .unwrap()
        .iter()
        .map(|(k, x)| (*k, if *k == key { val.clone() } else { x.clone() }))
        .collect())
}
fn rust_origin() -> Vec<u8> {
    // Independently authored encoder origin, including negative seconds and Unicode.
    let content = m(vec![
        (0, stamp(-1, 1)),
        (
            1,
            V::Array(vec![m(vec![(0, n(1)), (3, s("Rust origin λ"))])]),
        ),
    ]);
    encode(
        9,
        2,
        2,
        &m(vec![
            (0, s(NET)),
            (1, s("Forum/é")),
            (3, b(&encode_canonical(&content).unwrap())),
        ]),
    )
}
fn policies(frames: &[J]) {
    let raw = |id: &str| {
        hex::decode(
            frames.iter().find(|f| f["id"] == id).unwrap()["hex"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    let confirmed_raw = raw("confirmed-a");
    let confirmed = open(&confirmed_raw).unwrap().p;
    let unknown_raw = raw("unknown-b-same-post");
    let unknown = open(&unknown_raw).unwrap().p;
    assert_eq!(
        bind_status(&confirmed_raw, &confirmed, Some(&confirmed)).unwrap(),
        "relay-confirmed"
    );
    assert_eq!(
        bind_status(&unknown_raw, &unknown, None).unwrap(),
        "unverified-request"
    );
    assert!(bind_status(&confirmed_raw, &unknown, Some(&confirmed)).is_err());
    for label in ["tx", "sender", "direction", "value"] {
        assert!(bind_status(
            &raw(&format!("mismatched-response-{label}")),
            &confirmed,
            Some(&confirmed)
        )
        .is_err());
    }
    for k in 0..=6 {
        let changed = replace(
            &confirmed,
            k,
            match get(&confirmed, k).unwrap() {
                V::Int(i) => n(i + 1),
                V::Text(t) => s(&format!("{t}x")),
                _ => b(&[0]),
            },
        );
        assert!(bind_status(&confirmed_raw, &changed, Some(&confirmed)).is_err());
        assert!(bind_status(&confirmed_raw, &confirmed, Some(&changed)).is_err());
    }
    let mut ids = vec![t1(&raw("typescript-origin")), t1(&raw("rust-origin"))];
    ids.sort();
    assert_eq!(ids.iter().filter(|x| **x > ids[0]).count(), 1);
    let mut overlap = ids.clone();
    overlap.extend(ids);
    overlap.sort();
    overlap.dedup();
    assert_eq!(overlap.len(), 2);
    let applies = |current: (&str, u64, u64), incoming: (&str, u64, u64)| {
        current.0 == incoming.0 && incoming.1 >= current.1 && current.2 == incoming.2
    };
    assert!(!applies(("new", 1, 2), ("old", u64::MAX, 1)));
    assert!(!applies(("same", u64::MAX, 2), ("same", 1, 2)));
    assert!(!applies(("same", u64::MAX, 2), ("same", u64::MAX, 1)));
    let capacity = |count: u64, total: u64, one: u64| {
        count < 16 && one <= 64 * 1024 * 1024 && total + one <= 256 * 1024 * 1024
    };
    assert!(capacity(15, 192 * 1024 * 1024, 64 * 1024 * 1024));
    assert!(!capacity(16, 0, 1));
    assert!(!capacity(1, 256 * 1024 * 1024, 1));
    assert!(!capacity(0, 0, 64 * 1024 * 1024 + 1));
    assert_ne!(
        t1(&raw("typescript-origin")),
        t1(&raw("different-authored-time"))
    );
}
fn cursors(shared: &J) {
    let expected = decode(&hex::decode(shared["expected"].as_str().unwrap()).unwrap()).unwrap();
    for f in shared["cases"].as_array().unwrap() {
        let run = || -> Check<()> {
            let transport = f["transport"].as_str().unwrap();
            need(
                transport.len() <= 2731
                    && !transport.is_empty()
                    && transport
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
                "cursor transport",
            )?;
            let raw =
                base64::decode_config(transport, base64::URL_SAFE_NO_PAD).map_err(|_| "base64")?;
            need(
                raw.len() <= 2048
                    && base64::encode_config(&raw, base64::URL_SAFE_NO_PAD) == transport,
                "cursor spelling",
            )?;
            need(hex::encode(&raw) == f["hex"].as_str().unwrap(), "bytes")?;
            let c = decode(&raw)?;
            let allowed: Vec<u64> = map(&expected)?.iter().map(|(k, _)| *k).collect();
            keys(&c, &allowed, false)?;
            let retained = replace(
                &expected,
                7,
                n(f["retainedIncarnation"].as_str().unwrap().parse().unwrap()),
            );
            let lookup_key = |cursor: &V| -> Check<(Vec<u8>, u64)> {
                Ok((
                    bytes(get(cursor, 3)?, 16, 16)?.to_vec(),
                    uint(get(cursor, 7)?, MAX)? as u64,
                ))
            };
            // Bind lookup to the original lifetime, before query/tuple checks.
            let snapshots = std::collections::BTreeMap::from([(lookup_key(&retained)?, &retained)]);
            let snapshot = snapshots.get(&lookup_key(&c)?).ok_or("cursor-expired")?;
            need(
                f["active"] == true && f["age"].as_u64().unwrap() < 120000,
                "cursor-expired",
            )?;
            need(c == **snapshot, "cursor binding/tuple membership")
        };
        assert_eq!(
            run().is_ok(),
            f["valid"].as_bool().unwrap(),
            "cursor {}",
            f["id"]
        );
    }
}
fn observations(frames: &[J], facts: &J) {
    let raw = |id: &str| {
        hex::decode(
            frames.iter().find(|f| f["id"] == id).unwrap()["hex"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    let find = |tx: &[u8], target: &[u8; 32], network: &str| -> Check<&J> {
        let fact = facts
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["raw"] == hex::encode(tx))
            .ok_or("missing synthetic observation")?;
        need(
            fact["network"] == network
                && fact["target"] == hex::encode(target)
                && fact["hash"] == hex::encode(keccak256(tx))
                && fact["commitment"]
                    == hex::encode(topic_vote_commitment(network, target).unwrap()),
            "transaction-derived binding",
        )?;
        Ok(fact)
    };
    for id in ["view-large-aggregate", "view-rust"] {
        let p = validate(&raw(id)).unwrap().p;
        let tx = bytes(get(&p, 3).unwrap(), 1, 16384).unwrap();
        let target = t1(bytes(get(&p, 1).unwrap(), 9, 1048576).unwrap());
        let fact = find(tx, &target, NET).unwrap();
        assert_eq!(
            hex::encode(bytes(get(&p, 2).unwrap(), 20, 20).unwrap()),
            fact["sender"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(bytes(get(&p, 4).unwrap(), 32, 32).unwrap()),
            fact["hash"].as_str().unwrap()
        );
        assert_eq!(fact["direction"], 1);
        assert!(find(tx, &[0; 32], NET).is_err());
    }
    for id in ["confirmed-a", "pending-a"] {
        let raw = raw(id);
        let p = validate(&raw).unwrap().p;
        let sub = open(bytes(get(&p, 1).unwrap(), 9, 1048576).unwrap()).unwrap();
        let target: [u8; 32] = bytes(get(&p, 2).unwrap(), 32, 32)
            .unwrap()
            .try_into()
            .unwrap();
        let fact = find(
            bytes(get(&sub.p, 2).unwrap(), 1, 16384).unwrap(),
            &target,
            NET,
        )
        .unwrap();
        let observed = m(vec![
            (0, s(NET)),
            (1, get(&p, 1).unwrap().clone()),
            (2, b(&target)),
            (3, b(&hex::decode(fact["hash"].as_str().unwrap()).unwrap())),
            (
                4,
                b(&hex::decode(fact["sender"].as_str().unwrap()).unwrap()),
            ),
            (5, n(fact["direction"].as_i64().unwrap() as i128)),
            (6, n(fact["value"].as_str().unwrap().parse().unwrap())),
        ]);
        assert_eq!(
            bind_status(&raw, &p, Some(&observed)).unwrap(),
            if id == "confirmed-a" {
                "relay-confirmed"
            } else {
                "relay-pending"
            }
        );
    }
}
fn main() {
    if std::env::args().any(|a| a == "--emit-origin") {
        println!("{}", hex::encode(rust_origin()));
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../../docs/protocol/proposals/forum-content-read/vectors.json");
    let doc: J = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(doc["format"], "PROPOSED-forum-content-read-v1");
    let frames = doc["frames"].as_array().unwrap();
    for f in frames {
        let id = f["id"].as_str().unwrap();
        let p = recipe(&f["payload"]);
        let encoded = encode(
            f["type"].as_u64().unwrap() as u32,
            f["schema"].as_u64().unwrap() as u32,
            f["min"].as_u64().unwrap() as u32,
            &p,
        );
        assert_eq!(hex::encode(&encoded), f["hex"].as_str().unwrap(), "{id}");
        if let Some(expected) = f["t1"].as_str() {
            assert_eq!(hex::encode(t1(&encoded)), expected, "{id}");
            assert_eq!(
                hex::encode(topic_vote_commitment(NET, &t1(&encoded)).unwrap()),
                f["t7"].as_str().unwrap(),
                "{id}"
            );
        }
        assert_eq!(
            validate(&encoded).is_ok(),
            f["valid"].as_bool().unwrap(),
            "{id}"
        );
        if f["valid"] == true {
            assert_eq!(
                encode_canonical(&open(&encoded).unwrap().p).unwrap(),
                encode_canonical(&p).unwrap(),
                "{id}"
            );
        }
        if id == "rust-origin" {
            assert_eq!(rust_origin(), encoded);
        }
    }
    policies(frames);
    for group in doc["cursors"].as_array().unwrap() {
        cursors(group);
    }
    observations(frames, &doc["observations"]);
    println!("Rust proposal: {} shared frames, independent encode/T1/T7, hostile binding/cursor/restart policies passed",frames.len());
}
