//! CR-3 probe: zero-valued DER INTEGER in the Rust primitives.

use secp256k1_abc::{Message, PublicKey, Secp256k1, Signature};

use frank_cbor::{has_low_s, parse_strict_der, verify_algorithm_1};

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn scratch_cr3_zero_r() {
    // r = 0, s = 1
    let der_r0 = hex("3006020100020101");
    match parse_strict_der(&der_r0) {
        Ok((r, s)) => {
            println!(
                "RUST parse_strict_der(r=0): ACCEPTED r=...{:02x?} s=...{:02x?}",
                &r[28..],
                &s[28..]
            );
            assert_eq!(r, [0u8; 32]);
            assert!(has_low_s(&s));
            // Which layer rejects downstream?
            let compact = {
                let mut c = [0u8; 64];
                c[..32].copy_from_slice(&r);
                c[32..].copy_from_slice(&s);
                c
            };
            match Signature::from_compact(&compact) {
                Ok(sig) => {
                    println!("  from_compact(r=0): ACCEPTED");
                    let digest = [0u8; 32];
                    let msg = Message::from_slice(&digest).unwrap();
                    // a real compressed key (G, the generator) to rule out key-parse failure
                    let gen = PublicKey::from_slice(&hex(
                        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                    ))
                    .unwrap();
                    let ok = Secp256k1::verification_only().verify(&msg, &sig, &gen).is_ok();
                    println!("  verify(r=0) over G: {}", ok);
                }
                Err(e) => println!("  from_compact(r=0): REJECTED ({:?})", e),
            }
        }
        Err(e) => println!("RUST parse_strict_der(r=0): REJECTED ({:?})", e),
    }

    // The stage-10.6 path: verify_algorithm_1 with r=0 must be false.
    let gen = hex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    println!(
        "RUST verify_algorithm_1(r=0 der) = {}",
        verify_algorithm_1(&[0u8; 32], &der_r0, &gen)
    );

    // Sanity: r=1 s=1 parses.
    let der_r1 = hex("3006020101020101");
    println!(
        "RUST parse_strict_der(r=1) = {:?}",
        parse_strict_der(&der_r1).is_ok()
    );
}