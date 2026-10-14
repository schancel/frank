//! Offline signing of explicitly supplied public synthetic fixture keys and digests.
use secp256k1_abc::{key::SecretKey, Message, Secp256k1};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        3,
        "usage: sign-fixture PUBLIC_FIXTURE_SECRET_HEX DIGEST_HEX"
    );
    let secret = SecretKey::from_slice(&hex::decode(&args[1]).unwrap()).unwrap();
    let message = Message::from_slice(&hex::decode(&args[2]).unwrap()).unwrap();
    println!(
        "{}",
        hex::encode(Secp256k1::new().sign(&message, &secret).serialize_der())
    );
}
