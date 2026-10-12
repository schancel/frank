// Synthetic fixture verifier only. Never imported by a production workspace.
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT, edwards::CompressedEdwardsY, scalar::Scalar,
};
use ed25519_dalek::{
    hazmat::{raw_sign, ExpandedSecretKey},
    Signature, VerifyingKey,
};
use serde_json::Value;
use sha2::Sha512;

fn decode(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn raw(v: &Value, field: &str) -> [u8; 32] {
    decode(v[field].as_str().unwrap()).try_into().unwrap()
}

fn scalar(v: &Value, field: &str) -> Scalar {
    Option::<Scalar>::from(Scalar::from_canonical_bytes(raw(v, field))).unwrap()
}

fn main() {
    let fixture: Value = serde_json::from_str(include_str!("../vectors.json")).unwrap();
    let mut count = 0;
    for v in fixture["vectors"].as_array().unwrap() {
        let b = scalar(v, "b");
        let r = scalar(v, "r");
        let t = scalar(v, "t");
        let p = scalar(v, "p");
        let b_point = ED25519_BASEPOINT_POINT * b;
        let r_point = ED25519_BASEPOINT_POINT * r;
        assert_eq!(b_point.compress().to_bytes(), raw(v, "B"));
        assert_eq!(r_point.compress().to_bytes(), raw(v, "R"));
        assert_eq!((b_point * r).compress().to_bytes(), raw(v, "senderD"));
        assert_eq!((r_point * b).compress().to_bytes(), raw(v, "recipientD"));
        let p_point = b_point + ED25519_BASEPOINT_POINT * t;
        assert_eq!(p_point.compress().to_bytes(), raw(v, "P"));
        assert_eq!(ED25519_BASEPOINT_POINT * p, p_point);
        assert!(p_point.is_torsion_free());
        let key = VerifyingKey::from_bytes(&raw(v, "P")).unwrap();
        // Construct fields directly: ExpandedSecretKey::from_bytes would clamp p incorrectly.
        let expanded = ExpandedSecretKey {
            scalar: p,
            hash_prefix: raw(v, "zP"),
        };
        for s in v["signatures"].as_array().unwrap() {
            let message = decode(s["message"].as_str().unwrap());
            let expected: [u8; 64] = decode(s["signature"].as_str().unwrap()).try_into().unwrap();
            let signature = raw_sign::<Sha512>(&expanded, &message, &key);
            assert_eq!(signature.to_bytes(), expected);
            key.verify_strict(&message, &Signature::from_bytes(&expected))
                .unwrap();
            count += 1;
        }
    }
    for (_, value) in fixture["invalidPoints"].as_object().unwrap() {
        let bytes = decode(value.as_str().unwrap());
        let accepted = bytes.try_into().ok().and_then(|a: [u8; 32]| {
            CompressedEdwardsY(a).decompress().filter(|p| {
                p.compress().to_bytes() == a
                    && p.is_torsion_free()
                    && *p != curve25519_dalek::edwards::EdwardsPoint::default()
            })
        });
        assert!(accepted.is_none());
    }
    println!("PASS: Dalek independently reproduces point arithmetic and {count} expanded-key signatures; strict verification and malformed-point rejection");
}
