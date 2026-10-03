//! Independent offline derivation and policy fixtures. Not a production API.
use frank_cbor::{common_transcript, decode_canonical, encode_canonical, CborValue as V};
use hmac::{Hmac, Mac};
use secp256k1_abc::{PublicKey, Secp256k1, SecretKey};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use std::path::Path;

const REGISTRY: &str = "frank-domain-roots-v1";
const PURPOSES: [&str; 5] = [
    "ecash-bch-wallet",
    "evm-wallet",
    "solana-wallet",
    "messaging-encryption",
    "identity-authentication",
];
const ORDER: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}
fn bytes(v: &Value, k: &str) -> Vec<u8> {
    hex::decode(s(v, k)).unwrap()
}
fn mac256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
fn mac512(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha512>::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
fn point(secret: &[u8]) -> Vec<u8> {
    PublicKey::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(secret).unwrap())
        .serialize()
        .to_vec()
}
fn generation(v: &Value) -> Result<u32, &'static str> {
    let text = v.as_str().ok_or("generation")?;
    if text.is_empty()
        || !text.bytes().all(|b| b.is_ascii_digit())
        || text.len() > 1 && text.starts_with('0')
    {
        return Err("generation");
    }
    let n = text.parse::<u64>().map_err(|_| "generation")?;
    if n > 2147483647 {
        return Err("generation");
    }
    Ok(n as u32)
}
fn path(role: &str, g: u32) -> Vec<u32> {
    let h = 0x80000000;
    match role {
        "auth" | "main" => {
            assert_eq!(g, 0);
            vec![h + 44, h + 60, h + 1, 0, 0]
        }
        "funding" | "change" => vec![h + 44, h + 60, h, u32::from(role == "change"), g],
        "message" | "stamp" => vec![
            h + 44,
            h + 60,
            h + if role == "message" { 4 } else { 2 },
            h,
            h + g,
        ],
        _ => panic!("unknown role"),
    }
}
fn purpose(role: &str) -> &str {
    match role {
        "auth" => "identity-authentication",
        "message" => "messaging-encryption",
        _ => "evm-wallet",
    }
}
fn root(account: &[u8], purpose: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let code = PURPOSES.iter().position(|p| *p == purpose).unwrap() + 1;
    let label = format!("frank/domain-root/v1/{purpose}");
    let mut info = vec![];
    info.extend_from_slice(&(REGISTRY.len() as u16).to_be_bytes());
    info.extend_from_slice(REGISTRY.as_bytes());
    info.extend_from_slice(&(code as u16).to_be_bytes());
    info.extend_from_slice(&(label.len() as u16).to_be_bytes());
    info.extend_from_slice(label.as_bytes());
    info.extend_from_slice(&32u16.to_be_bytes());
    let prk = mac256(b"frank/domain-root-registry/v1", account);
    let mut expansion = info.clone();
    expansion.push(1);
    (info, prk.clone(), mac256(&prk, &expansion))
}
#[derive(Clone)]
struct Node {
    secret: Vec<u8>,
    chain: Vec<u8>,
}
fn master(seed: &[u8], injected: Option<&[u8]>) -> Result<Node, &'static str> {
    let digest = injected
        .map(Vec::from)
        .unwrap_or_else(|| mac512(b"Bitcoin seed", seed));
    SecretKey::from_slice(&digest[..32]).map_err(|_| "master-scalar")?;
    Ok(Node {
        secret: digest[..32].to_vec(),
        chain: digest[32..].to_vec(),
    })
}
fn child(parent: &Node, index: u32, injected: Option<&[u8]>) -> Result<Node, &'static str> {
    let mut data = if index & 0x80000000 != 0 {
        let mut b = vec![0];
        b.extend_from_slice(&parent.secret);
        b
    } else {
        point(&parent.secret)
    };
    data.extend_from_slice(&index.to_be_bytes());
    let digest = injected
        .map(Vec::from)
        .unwrap_or_else(|| mac512(&parent.chain, &data));
    if digest[..32] >= hex::decode(ORDER).unwrap()[..] {
        return Err("child-scalar");
    }
    let mut key = SecretKey::from_slice(&parent.secret).unwrap();
    key.add_assign(&digest[..32]).map_err(|_| "child-zero")?;
    Ok(Node {
        secret: key.serialize_secret().to_vec(),
        chain: digest[32..].to_vec(),
    })
}
fn derive(account: &[u8], role: &str, g: u32) -> Node {
    let seed = root(account, purpose(role)).2;
    let mut node = master(&seed, None).unwrap();
    for index in path(role, g) {
        node = child(&node, index, None).unwrap();
    }
    node
}
fn public(account: &[u8], role: &str, g: u32) -> String {
    hex::encode(point(&derive(account, role, g).secret))
}
fn field(v: &V, k: u64) -> &V {
    match v {
        V::Map(m) => &m.iter().find(|(n, _)| *n == k).unwrap().1,
        _ => panic!("map"),
    }
}
fn raw(v: &V) -> &[u8] {
    match v {
        V::Bytes(b) => b,
        _ => panic!("bytes"),
    }
}
fn num(v: &V) -> i128 {
    match v {
        V::Int(n) => *n,
        _ => panic!("int"),
    }
}
fn directory(snapshot: &Value, prior: Option<&Value>) {
    let frame = bytes(snapshot, "type4_hex");
    assert_eq!(&frame[..5], b"FRNK\x01");
    assert_eq!(
        u32::from_be_bytes(frame[5..9].try_into().unwrap()) as usize,
        frame.len() - 9
    );
    let envelope = decode_canonical(&frame[9..]).unwrap();
    assert_eq!(encode_canonical(&envelope).unwrap(), frame[9..]);
    assert_eq!(
        (
            num(field(&envelope, 0)),
            num(field(&envelope, 1)),
            num(field(&envelope, 2))
        ),
        (4, 4, 4)
    );
    let payload = decode_canonical(raw(field(&envelope, 3))).unwrap();
    assert_eq!(field(&payload, 0), &V::Text("monad-testnet".into()));
    for (index, name) in [(1, "auth"), (8, "stamp"), (10, "message")] {
        assert_eq!(num(field(field(&payload, index), 0)), 1);
        assert_eq!(
            hex::encode(raw(field(field(&payload, index), 1))),
            s(snapshot, name)
        );
    }
    for (index, name) in [
        (2, "revision"),
        (11, "message_generation"),
        (12, "stamp_generation"),
    ] {
        assert_eq!(num(field(&payload, index)).to_string(), s(snapshot, name));
    }
    match prior {
        None => assert_eq!(field(&payload, 13), &V::Null),
        Some(p) => assert_eq!(hex::encode(raw(field(&payload, 13))), s(p, "t1")),
    }
    assert_eq!(
        hex::encode(Sha256::digest(
            common_transcript("frank/content-hash/v1", "monad-testnet", &frame, &[]).unwrap()
        )),
        s(snapshot, "t1")
    );
}
fn restore(corpus: &Value, c: &Value) -> &'static str {
    let account = &corpus["accounts"][c["account"].as_u64().unwrap() as usize];
    let snapshot = &account["snapshots"][c["snapshot"].as_u64().unwrap() as usize];
    let mut seed = bytes(account, "account_root");
    let mut registry = REGISTRY;
    let mut recovery = "codex32-master-v1";
    let (mut registry_code, mut recovery_code, mut message_code, mut stamp_code) = (1, 1, 4, 2);
    let mut interpretation = "bip32-secp256k1-master-seed";
    let mut network = "monad-testnet";
    let mut mp = "messaging-encryption";
    let mut sp = "evm-wallet";
    let mut mg = snapshot["message_generation"].clone();
    let mut sg = snapshot["stamp_generation"].clone();
    let mut m = s(snapshot, "message").to_string();
    let mut stamp = s(snapshot, "stamp").to_string();
    let mut previous = snapshot["previous_stamp"].as_str().map(String::from);
    let mut supplied_m = path("message", generation(&mg).unwrap());
    let mut supplied_s = path("stamp", generation(&sg).unwrap());
    let mut commitment = s(snapshot, "t1").to_string();
    let mutation = c["mutation"].as_str().unwrap_or("");
    match mutation {
        "registry" => registry = "frank-domain-roots-v2",
        "registry-code" => registry_code = 2,
        "recovery-code" => recovery_code = 2,
        "message-purpose-code" => message_code = 5,
        "stamp-purpose-code" => stamp_code = 4,
        "interpretation" => interpretation = "ed25519-keypair-seed",
        "seed-length" => seed = seed[1..].to_vec(),
        "recovery" => recovery = "codex32-master-v2",
        "purpose" => mp = "identity-authentication",
        "auth-as-message" => m = s(snapshot, "auth").into(),
        "stamp-purpose" => sp = "messaging-encryption",
        "evm-as-message" => m = public(&seed, "main", 0),
        "stamp-as-message" => m = stamp.clone(),
        "funding-as-stamp" => stamp = public(&seed, "funding", 0),
        "negated-message" => {
            m = format!(
                "{}{}",
                if m.starts_with("02") { "03" } else { "02" },
                &m[2..]
            )
        }
        "nonhardened-message" => supplied_m[4] -= 0x80000000,
        "nonhardened-stamp" => supplied_s[4] -= 0x80000000,
        "wrong-account" => seed = bytes(&corpus["accounts"][1], "account_root"),
        "missing-generation" => mg = Value::Null,
        "overflow-generation" => sg = Value::String("2147483648".into()),
        "missing-stamp-generation" => sg = Value::Null,
        "wrong-message-generation" => mg = Value::String("1".into()),
        "wrong-stamp-generation" => sg = Value::String("1".into()),
        "missing-previous" => previous = None,
        "wrong-previous" => previous = Some(stamp.clone()),
        "wrong-current" => stamp = previous.clone().unwrap(),
        "network" => network = "monad-mainnet",
        "head-lost" => return "reject",
        "t1" => commitment = "00".repeat(32),
        _ => (),
    }
    if registry != REGISTRY
        || recovery != "codex32-master-v1"
        || (registry_code, recovery_code, message_code, stamp_code) != (1, 1, 4, 2)
        || interpretation != "bip32-secp256k1-master-seed"
        || seed.len() != 32
        || network != "monad-testnet"
        || mp != "messaging-encryption"
        || sp != "evm-wallet"
    {
        return "reject";
    }
    let (mg, sg) = match (generation(&mg), generation(&sg)) {
        (Ok(m), Ok(s)) => (m, s),
        _ => return "reject",
    };
    if supplied_m != path("message", mg) || supplied_s != path("stamp", sg) {
        return "reject";
    }
    let digest = hex::encode(Sha256::digest(
        common_transcript(
            "frank/content-hash/v1",
            network,
            &bytes(snapshot, "type4_hex"),
            &[],
        )
        .unwrap(),
    ));
    if commitment != digest
        || public(&seed, "auth", 0) != s(snapshot, "auth")
        || public(&seed, "message", mg) != m
        || public(&seed, "stamp", sg) != stamp
    {
        return "reject";
    }
    let auth = s(snapshot, "auth");
    if auth[2..] == m[2..] || auth[2..] == stamp[2..] || m[2..] == stamp[2..] {
        return "reject";
    }
    if mutation == "pair-lost" {
        previous = None;
    } else {
        let pg = &snapshot["previous_stamp_generation"];
        if sg == 0 {
            if !pg.is_null() || previous.is_some() {
                return "reject";
            }
        } else {
            match generation(pg) {
                Ok(g) if g + 1 == sg && previous == Some(public(&seed, "stamp", g)) => (),
                _ => return "reject",
            }
        }
    }
    let operation = s(c, "operation");
    if operation == "restore" {
        return if mutation == "pair-lost" {
            "current-only"
        } else {
            "accept"
        };
    }
    let g = generation(&c["candidate_generation"]).unwrap();
    if operation == "archive" {
        return if account["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| s(v, "message") == public(&seed, "message", g))
        {
            "archive-only"
        } else {
            "reject"
        };
    }
    if operation == "stamp-admission" {
        let candidate = public(&seed, "stamp", g);
        if candidate == stamp || previous == Some(candidate) {
            "accept"
        } else {
            "reject"
        }
    } else if public(&seed, "message", g) == m {
        "accept"
    } else {
        "reject"
    }
}
fn main() {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(
            base.join("docs/protocol/proposals/message-stamp-derivation/vectors.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(corpus["status"], "PROPOSED-NOT-ALLOCATED");
    let old: Value = serde_json::from_str(
        &std::fs::read_to_string(base.join("packages/domain-roots/vectors/domain-roots-v1.json"))
            .unwrap(),
    )
    .unwrap();
    for (i, account) in corpus["accounts"].as_array().unwrap().iter().enumerate() {
        let seed = bytes(account, "account_root");
        assert_eq!(account["account_root"], old["vectors"][i]["accountRoot"]);
        for r in account["roots"].as_array().unwrap() {
            let p = s(r, "purpose");
            let (info, prk, output) = root(&seed, p);
            assert_eq!(hex::encode(info), s(r, "info_hex"));
            assert_eq!(hex::encode(prk), s(r, "prk_hex"));
            assert_eq!(hex::encode(&output), s(r, "output_hex"));
            assert_eq!(hex::encode(output), old["vectors"][i]["outputs"][p]);
            assert_eq!(bytes(r, "salt_hex"), b"frank/domain-root-registry/v1");
            assert_eq!(
                r["code"].as_u64().unwrap(),
                (PURPOSES.iter().position(|s| *s == p).unwrap() + 1) as u64
            );
            assert_eq!(s(r, "label"), format!("frank/domain-root/v1/{p}"));
        }
        let mut seen = std::collections::HashSet::new();
        for l in account["leaves"].as_array().unwrap() {
            let role = s(l, "role");
            let g = generation(&l["generation"]).unwrap();
            let indices = path(role, g);
            let text = format!(
                "m/{}",
                indices
                    .iter()
                    .map(|i| if i & 0x80000000 != 0 {
                        format!("{}'", i - 0x80000000)
                    } else {
                        i.to_string()
                    })
                    .collect::<Vec<_>>()
                    .join("/")
            );
            assert_eq!(s(l, "path"), text);
            assert_eq!(s(l, "purpose"), purpose(role));
            assert_eq!(
                bytes(l, "indices_hex"),
                indices
                    .iter()
                    .flat_map(|i| i.to_be_bytes())
                    .collect::<Vec<_>>()
            );
            assert_eq!(bytes(l, "seed_hex"), root(&seed, purpose(role)).2);
            let node = derive(&seed, role, g);
            assert_eq!(bytes(l, "private_hex"), node.secret);
            assert_eq!(bytes(l, "chain_hex"), node.chain);
            let pubkey = point(&node.secret);
            assert_eq!(bytes(l, "public_hex"), pubkey);
            assert!(seen.insert(pubkey[1..].to_vec()));
        }
        let snapshots = account["snapshots"].as_array().unwrap();
        for (n, snap) in snapshots.iter().enumerate() {
            directory(snap, n.checked_sub(1).map(|p| &snapshots[p]));
        }
    }
    for c in corpus["generation_cases"].as_array().unwrap() {
        assert_eq!(
            if generation(&c["value"]).is_ok() {
                "accept"
            } else {
                "reject"
            },
            s(c, "expected")
        );
    }
    for c in corpus["scalar_cases"].as_array().unwrap() {
        let mut digest = bytes(c, "left_hex");
        digest.extend_from_slice(&[0x55; 32]);
        let mut one = vec![0; 32];
        one[31] = 1;
        for index in [0x80000000, 0xffffffff] {
            let result = if s(c, "operation") == "master" {
                master(&[0; 32], Some(&digest))
            } else {
                child(
                    &Node {
                        secret: one.clone(),
                        chain: vec![0; 32],
                    },
                    index,
                    Some(&digest),
                )
            };
            let actual = match result {
                Ok(node) => {
                    assert_eq!(node.secret, one);
                    assert_eq!(node.chain, vec![0x55; 32]);
                    "accept"
                }
                Err(e) => e,
            };
            assert_eq!(
                actual,
                s(c, "expected"),
                "{} at {index}: must not skip index",
                s(c, "id")
            );
        }
    }
    for c in corpus["restore_cases"].as_array().unwrap() {
        assert_eq!(restore(&corpus, c), s(c, "expected"), "{}", s(c, "id"));
    }
    for c in corpus["reuse_cases"].as_array().unwrap() {
        let get = |id: &str| {
            s(
                corpus["accounts"][0]["leaves"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|l| s(l, "id") == id)
                    .unwrap(),
                "public_hex",
            )
            .to_string()
        };
        let mut candidate = get(s(c, "candidate"));
        if c["negate"].as_bool().unwrap() {
            candidate = format!(
                "{}{}",
                if candidate.starts_with("02") {
                    "03"
                } else {
                    "02"
                },
                &candidate[2..]
            );
        }
        let duplicate = c["history"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| get(id.as_str().unwrap())[2..] == candidate[2..]);
        assert_eq!(
            if duplicate { "reject" } else { "accept" },
            s(c, "expected")
        );
    }
    for f in corpus["frozen_sha256"].as_array().unwrap() {
        assert_eq!(
            hex::encode(Sha256::digest(
                std::fs::read(base.join(s(f, "path"))).unwrap()
            )),
            s(f, "sha256")
        );
    }
    println!("Rust: 10 frozen roots; 32 exact leaves; 8 directory tuples/T1; {} bounds; 10 scalar probes; {} restore/admission cases; {} no-reuse cases; frozen-source hashes", corpus["generation_cases"].as_array().unwrap().len(), corpus["restore_cases"].as_array().unwrap().len(), corpus["reuse_cases"].as_array().unwrap().len());
}
