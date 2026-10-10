//! Verification for Monad-native profile registration (`PUT`/`GET /metadata/monad/:addr`, and
//! the plain `/metadata/:addr` route's Monad-address dispatch branch -- see
//! `crate::http::monad_profile`'s module docs -- ticket #45).
//!
//! ## The open question this ticket exists to resolve: how does the relay authenticate a PUT?
//!
//! Every other Monad-native write path in this crate (`monad_stamp_verify`, `monad_topic_verify`)
//! authenticates its sender by `ecrecover`-ing a signature off a *burn transaction the client
//! already had to construct anyway* (see [`crate::monad_evm_tx::recover_sender`]'s docs) --
//! there's no separate app-level signature field needed, since a raw signed EVM tx already proves
//! who sent it. Profile registration has no such transaction: it's a bare HTTP `PUT`, never
//! burn-gated (POP is disabled for the hackathon demo, and profile registration was never
//! POP-gated to begin with -- see PLAN.md constraint 4 and this ticket's non-goals). So the naive
//! extension of the established pattern -- have the client sign an arbitrary message and
//! `ecrecover` the address back out, with no separate pubkey field needed -- doesn't have
//! anything to recover a signature *from*.
//!
//! This ticket's own instructions were explicit: don't design that in isolation from the real,
//! already-merged TS client this route is meant to unblock. Checking `app/src/cashweb/wallet/
//! monad-identity.ts`'s `registerMonadIdentity`/`buildSignedAddressMetadata`/`signHash` (ticket
//! #41) directly (rather than assuming the "ecrecover, no pubkey field" shape some earlier
//! grooming notes speculated) found it does something different from that speculation in two
//! ways:
//!
//! 1. It builds a `cashweb_payload::proto::SignedPayload` -- the *exact* wire message Lotus's own
//!    `lotus-identity.ts`'s `registerIdentity` already sends to this same route -- carrying an
//!    **explicit `pubkey` field**, not just a bare signature.
//! 2. It signs `SHA256(payload)` (not Keccak256) with `bitcore-lib-xpi`'s plain DER ECDSA signer
//!    (`bitcoreCrypto.ECDSA.sign(...).toDER()`), which produces a signature with **no recovery id**
//!    (`v`/`yParity`) at all -- unlike a raw EVM tx's `(v, r, s)`, a bare DER signature is `(r, s)`
//!    only. `ecrecover`-style single-shot recovery isn't directly available from it; recovering a
//!    candidate pubkey would mean trying both possible recovery ids and disambiguating some other
//!    way, for no benefit, since the client already sends the pubkey outright.
//!
//! So the actual resolution mirrors **Lotus's own solution to this identical problem**: an
//! explicit `pubkey`/`sig` pair on `SignedPayload`, verified with plain [`Ecc::verify`] (exactly
//! `cashweb_payload::payload::SignedPayload::verify`'s `SignatureScheme::Ecdsa` branch) -- not
//! `ecrecover`. The only genuinely Monad-native piece is the *address* check: instead of Lotus's
//! `PubKeyHash::from_address` (`SHA256`+`RIPEMD160` of the compressed pubkey, matched against a
//! `LotusAddress`'s P2PKH script), this derives the Ethereum-style address from the pubkey
//! (`Keccak256` of the uncompressed `X||Y` coordinates, low 20 bytes -- see
//! [`crate::monad_evm_tx::address_from_uncompressed_pubkey`], reused here rather than
//! reimplemented) and checks it matches the claimed `:addr`. `ecrecover` never enters into it:
//! there's no signature-without-a-declared-signer to recover an identity *from* here, since the
//! signer is already named up front, same as it always was on the Lotus side.
//!
//! ## Why not reuse `cashweb_payload::payload::SignedPayload<T>::verify` directly
//!
//! That method also loops over `burn_txs`, parsing each entry's `tx` bytes as a Lotus
//! [`bitcoinsuite_core::Tx`] via `UnhashedTx::deser` -- harmless when `burn_txs` is empty (which
//! is what the real client always sends, and what [`verify_monad_profile`] requires below) but
//! wrong to depend on silently. Rather than inherit that Lotus-shaped parsing path implicitly,
//! [`verify_monad_profile`] explicitly rejects a non-empty `burn_txs` up front instead --
//! reinforcing (not just documenting) that profile registration is never burn-gated. `cashweb-
//! payload` itself is left untouched, per this session's established "don't try to make
//! `SignedPayload`/`PubKeyHash` dual-chain, build a parallel Monad-native path" precedent
//! (PLAN.md constraint 5/6).

use bitcoinsuite_core::{
    ecc::{Ecc, PUBKEY_LENGTH},
    Bytes, Hashed, Sha256,
};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use cashweb_payload::proto::signed_payload::SignatureScheme;
use prost::Message;
use thiserror::Error;

use crate::{monad_evm_tx::address_from_uncompressed_pubkey, monad_http::Address, proto};

/// Errors verifying a Monad-native profile registration's `cashweb_payload::proto::SignedPayload`
/// envelope (see this module's docs for the overall scheme).
#[derive(Debug, Error, ErrorMeta, Clone, PartialEq, Eq)]
pub enum MonadProfileVerifyError {
    /// `pubkey` wasn't exactly 33 bytes (a compressed secp256k1 public key).
    #[invalid_client_input()]
    #[error("Public key len should be {PUBKEY_LENGTH}, but got {0}")]
    InvalidPubKeyLen(usize),

    /// `pubkey` was 33 bytes but not a valid secp256k1 point.
    #[invalid_client_input()]
    #[error("Invalid secp256k1 pubkey: {0}")]
    InvalidPubKey(String),

    /// `sig_scheme` wasn't `ECDSA`. Profile registration has no Schnorr path (mirrors Lotus,
    /// which supports both, but every real client -- Lotus and Monad alike -- sends ECDSA).
    #[invalid_client_input()]
    #[error("Unsupported signature scheme id {0}: Monad profile registration requires ECDSA")]
    UnsupportedSignatureScheme(i32),

    /// `burn_txs` was non-empty. Profile registration is never burn-gated (see this module's
    /// docs) -- rejected explicitly rather than silently parsed as Lotus transactions.
    #[invalid_client_input()]
    #[error(
        "Monad profile registration doesn't support burn_txs (got {0} entries); \
         profile registration is never burn-gated"
    )]
    UnexpectedBurnTxs(usize),

    /// `payload_hash` was set but wasn't exactly 32 bytes.
    #[invalid_client_input()]
    #[error("payload_hash len should be 32 or empty, but got {0}")]
    InvalidPayloadHashLen(usize),

    /// The claimed `payload_hash` doesn't match `SHA256(payload)`.
    #[invalid_client_input()]
    #[error(
        "Claimed payload_hash does not match SHA256(payload): expected {expected}, got {actual}"
    )]
    PayloadHashMismatch {
        /// `payload_hash` as claimed in the request.
        expected: Sha256,
        /// Actual `SHA256(payload)`.
        actual: Sha256,
    },

    /// The ECDSA signature didn't verify against `pubkey`/`payload_hash`.
    #[invalid_client_input()]
    #[error("Invalid ECDSA signature: {0}")]
    InvalidSignature(bitcoinsuite_core::ecc::VerifySignatureError),

    /// The signature verified, but the address derived from `pubkey` (Keccak256-based, Ethereum
    /// convention) doesn't match the address this registration was submitted under.
    #[invalid_client_input()]
    #[error(
        "Signature is valid but the address derived from pubkey ({actual}) doesn't match the \
         claimed address ({expected})"
    )]
    AddressMismatch {
        /// Address the registration was submitted under (the `:addr` path segment).
        expected: Address,
        /// Address actually derived from the signing pubkey.
        actual: Address,
    },

    /// `payload` didn't decode as a [`proto::MonadProfile`].
    #[invalid_client_input()]
    #[error("Failed to decode payload as MonadProfile: {0}")]
    InvalidProfilePayload(String),

    /// A present `display_name` wasn't already in Decision #189's canonical signed form.
    #[invalid_client_input()]
    #[error("Invalid profile display_name: {0}")]
    InvalidDisplayName(String),

    /// The Frank-CBOR frame failed section 9 validation or stage 10.6 signature checks.
    #[invalid_client_input()]
    #[error("Invalid Frank-CBOR frame: {0}")]
    InvalidCborFrame(String),

    /// Frank-CBOR statement network does not match the relay's expected network.
    #[invalid_client_input()]
    #[error("Statement network mismatch: expected {expected}, got {actual}")]
    NetworkMismatch {
        /// Expected network identifier.
        expected: String,
        /// Actual network in statement.
        actual: String,
    },

    /// Frank-CBOR attestation has no signature by the statement's subject key.
    #[invalid_client_input()]
    #[error("Missing signature from subject account in attestation")]
    MissingSubjectSignature,
}

use self::MonadProfileVerifyError::*;

const DISPLAY_NAME_MAX_SCALARS: usize = 128;
const DISPLAY_NAME_MAX_UTF8_BYTES: usize = 512;

/// Validates raw display-name bytes according to Decision #189's canonical rules.
pub fn validate_display_name_bytes(body: &[u8]) -> Result<()> {
    let name = std::str::from_utf8(body)
        .map_err(|_| InvalidDisplayName("value is not valid UTF-8".to_string()))?;
    let normalized = name.trim_matches(char::is_whitespace);
    if normalized != name {
        return Err(InvalidDisplayName("value has edge whitespace".to_string()).into());
    }
    if name.is_empty() {
        return Err(InvalidDisplayName("value is empty".to_string()).into());
    }
    if name.chars().any(|character| {
        matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{2028}' | '\u{2029}')
    }) {
        return Err(InvalidDisplayName("value contains a forbidden character".to_string()).into());
    }
    if name.chars().count() > DISPLAY_NAME_MAX_SCALARS {
        return Err(InvalidDisplayName(format!(
            "value exceeds {DISPLAY_NAME_MAX_SCALARS} Unicode scalars"
        ))
        .into());
    }
    if name.len() > DISPLAY_NAME_MAX_UTF8_BYTES {
        return Err(InvalidDisplayName(format!(
            "value exceeds {DISPLAY_NAME_MAX_UTF8_BYTES} UTF-8 bytes"
        ))
        .into());
    }
    Ok(())
}

fn validate_display_names(profile: &proto::MonadProfile) -> Result<()> {
    for entry in profile
        .entries
        .iter()
        .filter(|entry| entry.kind == "display_name")
    {
        validate_display_name_bytes(&entry.body)?;
    }
    Ok(())
}

/// A successfully-verified Monad profile registration.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedMonadProfile {
    /// `SHA256(payload)`, verified to match the claimed `payload_hash` (or computed, if
    /// `payload_hash` was left empty).
    pub payload_hash: Sha256,
    /// The decoded profile content.
    pub profile: proto::MonadProfile,
}

/// Who signed a `SignedPayload` envelope, once [`verify_signed_payload`] has checked it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSigner {
    /// The compressed secp256k1 key that signed the payload.
    pub pubkey: [u8; PUBKEY_LENGTH],
    /// The Ethereum-style address of that key.
    pub address: Address,
    /// `SHA256(payload)`, the digest that was signed.
    pub payload_hash: Sha256,
}

/// Verify the envelope shared by everything an account signs with its identity key outside a
/// CBOR frame (profiles and username claims): `sig_scheme` must be `ECDSA`, `burn_txs` must be
/// empty, `payload_hash` (if set) must match `SHA256(payload)`, and `sig` must be a valid ECDSA
/// signature by `pubkey` over that hash. Says nothing about what the payload means.
pub fn verify_signed_payload(
    ecc: &EccSecp256k1,
    signed: &cashweb_payload::proto::SignedPayload,
) -> Result<VerifiedSigner> {
    if !signed.burn_txs.is_empty() {
        return Err(UnexpectedBurnTxs(signed.burn_txs.len()).into());
    }

    if SignatureScheme::from_i32(signed.sig_scheme) != Some(SignatureScheme::Ecdsa) {
        return Err(UnsupportedSignatureScheme(signed.sig_scheme).into());
    }

    let pubkey_arr: [u8; PUBKEY_LENGTH] = signed
        .pubkey
        .as_slice()
        .try_into()
        .map_err(|_| InvalidPubKeyLen(signed.pubkey.len()))?;
    let pubkey = ecc
        .pubkey_from_array(pubkey_arr)
        .map_err(|err| InvalidPubKey(err.to_string()))?;

    let actual_hash = Sha256::digest(signed.payload.clone().into());
    let payload_hash = if signed.payload_hash.is_empty() {
        actual_hash
    } else {
        let declared = Sha256::from_slice(&signed.payload_hash)
            .wrap_err_with(|| InvalidPayloadHashLen(signed.payload_hash.len()))?;
        if declared != actual_hash {
            return Err(PayloadHashMismatch {
                expected: declared,
                actual: actual_hash,
            }
            .into());
        }
        declared
    };

    let sig: Bytes = signed.sig.as_slice().into();
    ecc.verify(&pubkey, payload_hash.byte_array().clone(), &sig)
        .map_err(InvalidSignature)?;

    let uncompressed = ecc.serialize_pubkey_uncompressed(&pubkey);
    Ok(VerifiedSigner {
        pubkey: pubkey_arr,
        address: address_from_uncompressed_pubkey(&uncompressed),
        payload_hash,
    })
}

/// Verify that `signed` is a validly-signed Monad profile registration for `claimed_address` (see
/// this module's docs for the full rationale): the envelope must pass [`verify_signed_payload`]
/// and the Ethereum-style address derived from `pubkey` must equal `claimed_address`. Returns the
/// decoded [`proto::MonadProfile`] and its verified `payload_hash` on success.
pub fn verify_monad_profile(
    ecc: &EccSecp256k1,
    claimed_address: Address,
    signed: &cashweb_payload::proto::SignedPayload,
) -> Result<VerifiedMonadProfile> {
    let signer = verify_signed_payload(ecc, signed)?;
    if signer.address != claimed_address {
        return Err(AddressMismatch {
            expected: claimed_address,
            actual: signer.address,
        }
        .into());
    }

    let profile = proto::MonadProfile::decode(signed.payload.as_slice())
        .map_err(|err| InvalidProfilePayload(err.to_string()))?;
    validate_display_names(&profile)?;

    Ok(VerifiedMonadProfile {
        payload_hash: signer.payload_hash,
        profile,
    })
}

/// A successfully-verified Frank-CBOR directory registration statement.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedCborRegistration {
    /// Public key (33-byte compressed secp256k1).
    pub pubkey: Vec<u8>,
    /// Derived 20-byte Monad address.
    pub address: Address,
    /// Statement revision (field 2).
    pub revision: u64,
    /// Statement timestamp in milliseconds (join_ms).
    pub timestamp_ms: i64,
    /// First normalized display name, if any.
    pub display_name: Option<String>,
    /// Exact type-4 directory statement frame bytes (can be used as prior).
    pub type_4_frame: Vec<u8>,
}

/// Verify that `frame_bytes` is a valid Frank-CBOR type-2 account registration attestation for
/// `claimed_address` on `expected_network`. Stage 10.6 signature verification is performed over
/// the type-4 directory statement with `Operation::Full`.
pub fn verify_cbor_account_registration(
    claimed_address: Address,
    expected_network: &str,
    frame_bytes: &[u8],
    prior: frank_cbor::PriorStatement,
) -> Result<VerifiedCborRegistration> {
    let ctx = frank_cbor::ValidationContext {
        operation: frank_cbor::Operation::Full,
        route_byte_limit: 262_144, // 256 KiB
        reader_version: 2,
        supported_schemas: frank_cbor::default_context().supported_schemas,
        opaque_retention_allowed: false,
        prior,
    };

    let parsed = match frank_cbor::validate_frame(frame_bytes, &ctx) {
        Ok(frank_cbor::ValidationResult::Parsed(parsed)) => parsed,
        Ok(frank_cbor::ValidationResult::Retained(_)) => {
            return Err(InvalidCborFrame("root frame was retained".to_string()).into());
        }
        Ok(frank_cbor::ValidationResult::Frame(_)) => {
            return Err(InvalidCborFrame("unexpected frame-only result".to_string()).into());
        }
        Err(err) => return Err(InvalidCborFrame(err.to_string()).into()),
    };

    if parsed.type_id != 2 {
        return Err(InvalidCborFrame(format!(
            "expected type 2 (DirectoryAttestation), got type {}",
            parsed.type_id
        ))
        .into());
    }

    let (statement, signatures) = match parsed.typed.as_deref() {
        Some(frank_cbor::TypedPayload::DirectoryAttestation {
            statement,
            signatures,
            ..
        }) => (statement, signatures),
        _ => {
            return Err(
                InvalidCborFrame("missing DirectoryAttestation typed payload".to_string()).into(),
            )
        }
    };

    let (network, subject, revision, timestamp, profile_entries) = match statement.typed.as_deref()
    {
        Some(frank_cbor::TypedPayload::DirectoryStatement {
            network,
            subject,
            revision,
            timestamp,
            profile_entries,
            ..
        }) => (network, subject, *revision, timestamp, profile_entries),
        _ => {
            return Err(
                InvalidCborFrame("missing DirectoryStatement typed payload".to_string()).into(),
            )
        }
    };

    if network != expected_network {
        return Err(NetworkMismatch {
            expected: expected_network.to_string(),
            actual: network.clone(),
        }
        .into());
    }

    if subject.key_type != 1 {
        return Err(InvalidPubKey(format!(
            "expected key_type 1 (secp256k1), got {}",
            subject.key_type
        ))
        .into());
    }
    if subject.key_bytes.len() != PUBKEY_LENGTH {
        return Err(InvalidPubKeyLen(subject.key_bytes.len()).into());
    }

    let derived_address_bytes = frank_cbor::address_from_compressed_pubkey(&subject.key_bytes)
        .map_err(|err| InvalidPubKey(err.to_string()))?;
    let derived_address = Address(derived_address_bytes);
    if derived_address != claimed_address {
        return Err(AddressMismatch {
            expected: claimed_address,
            actual: derived_address,
        }
        .into());
    }

    // Verify self-signed: at least one signature must be signed by the subject account
    let has_subject_sig = signatures.iter().any(|sig| {
        sig.signer.key_type == subject.key_type && sig.signer.key_bytes == subject.key_bytes
    });
    if !has_subject_sig {
        return Err(MissingSubjectSignature.into());
    }

    // Validate display names in profile entries if present
    if let Some(entries) = profile_entries {
        for entry in entries.iter().filter(|e| e.kind == "display_name") {
            validate_display_name_bytes(&entry.body)?;
        }
    }

    let timestamp_ms: i64 = frank_cbor::join_ms(timestamp.seconds, timestamp.nanoseconds)
        .map_err(|err| InvalidCborFrame(err.to_string()))?
        .try_into()
        .map_err(|_| InvalidCborFrame("timestamp out of range for i64 milliseconds".to_string()))?;

    let display_name = profile_entries.as_ref().and_then(|entries| {
        entries
            .iter()
            .find(|e| e.kind == "display_name")
            .and_then(|e| {
                let raw = std::str::from_utf8(&e.body).ok()?;
                let norm = raw.trim().to_lowercase();
                if norm.is_empty() {
                    None
                } else {
                    Some(norm)
                }
            })
    });

    Ok(VerifiedCborRegistration {
        pubkey: subject.key_bytes.clone(),
        address: derived_address,
        revision,
        timestamp_ms,
        display_name,
        type_4_frame: statement.frame.clone(),
    })
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_core::ecc::{Ecc, SecKey};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use pretty_assertions::assert_eq;
    use prost::Message;
    use serde::Deserialize;

    use super::*;

    fn seckey(byte: u8) -> SecKey {
        EccSecp256k1::default()
            .seckey_from_array([byte; 32])
            .unwrap()
    }

    /// Builds a validly-signed `SignedPayload` for `profile`, signed by `seckey`, and returns it
    /// alongside the [`Address`] it should be registered under -- mirroring
    /// `monad-identity.ts`'s `buildSignedAddressMetadata`/`signHash` exactly (SHA256 digest, DER
    /// ECDSA signature, explicit pubkey field).
    fn sign_profile(
        seckey: &SecKey,
        profile: &proto::MonadProfile,
    ) -> (cashweb_payload::proto::SignedPayload, Address) {
        let ecc = EccSecp256k1::default();
        let pubkey = ecc.derive_pubkey(seckey);
        let uncompressed = ecc.serialize_pubkey_uncompressed(&pubkey);
        let address = address_from_uncompressed_pubkey(&uncompressed);

        let payload = profile.encode_to_vec();
        let payload_hash = Sha256::digest(payload.clone().into());
        let sig = ecc.sign(seckey, payload_hash.byte_array().clone());

        let signed = cashweb_payload::proto::SignedPayload {
            pubkey: pubkey.as_slice().to_vec(),
            sig: sig.to_vec(),
            sig_scheme: SignatureScheme::Ecdsa as i32,
            payload,
            payload_hash: payload_hash.as_slice().to_vec(),
            burn_amount: 0,
            burn_txs: vec![],
        };
        (signed, address)
    }

    fn sample_profile(timestamp: i64) -> proto::MonadProfile {
        proto::MonadProfile {
            timestamp,
            ttl: 1000 * 60 * 60 * 24 * 365,
            entries: vec![],
        }
    }

    fn display_name_profile(name: &str) -> proto::MonadProfile {
        proto::MonadProfile {
            entries: vec![proto::AddressEntry {
                kind: "display_name".to_string(),
                body: name.as_bytes().to_vec(),
                ..Default::default()
            }],
            ..sample_profile(1234)
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DisplayNameFixture {
        cases: Vec<DisplayNameFixtureCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DisplayNameFixtureCase {
        id: String,
        input: Option<String>,
        input_repeat: Option<DisplayNameRepeat>,
        valid: bool,
        normalized: Option<String>,
    }

    #[derive(Deserialize)]
    struct DisplayNameRepeat {
        value: String,
        count: usize,
        #[serde(default)]
        suffix: String,
    }

    impl DisplayNameFixtureCase {
        fn input(&self) -> String {
            match (&self.input, &self.input_repeat) {
                (Some(input), _) => input.clone(),
                (None, Some(repeated)) => repeated.value.repeat(repeated.count) + &repeated.suffix,
                (None, None) => panic!("Fixture {} has no input", self.id),
            }
        }
    }

    #[test]
    fn verifies_a_validly_signed_profile() {
        let ecc = EccSecp256k1::default();
        let seckey = seckey(0x42);
        let profile = sample_profile(1234);
        let (signed, address) = sign_profile(&seckey, &profile);

        let verified = verify_monad_profile(&ecc, address, &signed).unwrap();
        assert_eq!(verified.profile, profile);
        assert_eq!(
            verified.payload_hash,
            Sha256::digest(signed.payload.clone().into())
        );
    }

    #[test]
    fn enforces_shared_display_name_fixtures_on_correctly_signed_profiles() {
        let fixture: DisplayNameFixture = serde_json::from_str(include_str!(
            "../../../../fixtures/profile-display-name-v1.json"
        ))
        .unwrap();
        let ecc = EccSecp256k1::default();
        let seckey = seckey(0x42);

        for test_case in fixture.cases {
            let input = test_case.input();
            let wire_valid = test_case.valid
                && test_case.normalized.as_deref().unwrap_or(input.as_str()) == input;
            let profile = display_name_profile(&input);
            let (signed, address) = sign_profile(&seckey, &profile);
            let result = verify_monad_profile(&ecc, address, &signed);

            if wire_valid {
                assert_eq!(result.unwrap().profile, profile, "fixture {}", test_case.id);
            } else {
                assert!(
                    matches!(
                        result
                            .unwrap_err()
                            .downcast::<MonadProfileVerifyError>()
                            .unwrap(),
                        MonadProfileVerifyError::InvalidDisplayName(_)
                    ),
                    "fixture {}",
                    test_case.id
                );
            }
        }
    }

    #[test]
    fn validates_every_present_display_name() {
        let ecc = EccSecp256k1::default();
        let seckey = seckey(0x42);
        let mut profile = display_name_profile("Alice");
        profile.entries.push(proto::AddressEntry {
            kind: "display_name".to_string(),
            body: b"   ".to_vec(),
            ..Default::default()
        });
        let (signed, address) = sign_profile(&seckey, &profile);

        assert!(matches!(
            verify_monad_profile(&ecc, address, &signed)
                .unwrap_err()
                .downcast::<MonadProfileVerifyError>()
                .unwrap(),
            MonadProfileVerifyError::InvalidDisplayName(_)
        ));
    }

    #[test]
    fn rejects_a_signature_from_a_different_key() {
        let ecc = EccSecp256k1::default();
        let profile = sample_profile(1234);
        let (mut signed, address) = sign_profile(&seckey(0x42), &profile);
        // Swap in a different key's pubkey without re-signing: the signature no longer matches.
        let other_pubkey = ecc.derive_pubkey(&seckey(0x43));
        signed.pubkey = other_pubkey.as_slice().to_vec();

        let err = verify_monad_profile(&ecc, address, &signed).unwrap_err();
        assert_eq!(
            err.downcast::<MonadProfileVerifyError>().unwrap(),
            MonadProfileVerifyError::InvalidSignature(
                bitcoinsuite_core::ecc::VerifySignatureError::IncorrectSignature
            ),
        );
    }

    #[test]
    fn rejects_when_claimed_address_does_not_match_pubkey() {
        let ecc = EccSecp256k1::default();
        let profile = sample_profile(1234);
        let (signed, _address) = sign_profile(&seckey(0x42), &profile);
        let (_, wrong_address) = sign_profile(&seckey(0x99), &sample_profile(1));

        let err = verify_monad_profile(&ecc, wrong_address, &signed).unwrap_err();
        assert_eq!(
            err.downcast::<MonadProfileVerifyError>().unwrap(),
            MonadProfileVerifyError::AddressMismatch {
                expected: wrong_address,
                actual: address_from_uncompressed_pubkey(
                    &ecc.serialize_pubkey_uncompressed(&ecc.derive_pubkey(&seckey(0x42)))
                ),
            },
        );
    }

    #[test]
    fn rejects_tampered_payload() {
        let ecc = EccSecp256k1::default();
        let profile = sample_profile(1234);
        let (mut signed, address) = sign_profile(&seckey(0x42), &profile);
        // Tamper with the payload after signing: SHA256(payload) no longer matches payload_hash.
        signed.payload = sample_profile(9999).encode_to_vec();

        let err = verify_monad_profile(&ecc, address, &signed).unwrap_err();
        assert!(matches!(
            err.downcast::<MonadProfileVerifyError>().unwrap(),
            MonadProfileVerifyError::PayloadHashMismatch { .. }
        ));
    }

    #[test]
    fn rejects_non_ecdsa_scheme() {
        let ecc = EccSecp256k1::default();
        let profile = sample_profile(1234);
        let (mut signed, address) = sign_profile(&seckey(0x42), &profile);
        signed.sig_scheme = SignatureScheme::Schnorr as i32;

        let err = verify_monad_profile(&ecc, address, &signed).unwrap_err();
        assert_eq!(
            err.downcast::<MonadProfileVerifyError>().unwrap(),
            MonadProfileVerifyError::UnsupportedSignatureScheme(SignatureScheme::Schnorr as i32),
        );
    }

    #[test]
    fn rejects_non_empty_burn_txs() {
        let ecc = EccSecp256k1::default();
        let profile = sample_profile(1234);
        let (mut signed, address) = sign_profile(&seckey(0x42), &profile);
        signed.burn_txs = vec![cashweb_payload::proto::BurnTx {
            tx: vec![1, 2, 3],
            burn_idx: 0,
        }];

        let err = verify_monad_profile(&ecc, address, &signed).unwrap_err();
        assert_eq!(
            err.downcast::<MonadProfileVerifyError>().unwrap(),
            MonadProfileVerifyError::UnexpectedBurnTxs(1),
        );
    }

    #[test]
    fn rejects_invalid_pubkey_length() {
        let ecc = EccSecp256k1::default();
        let profile = sample_profile(1234);
        let (mut signed, address) = sign_profile(&seckey(0x42), &profile);
        signed.pubkey = vec![2; 32];

        let err = verify_monad_profile(&ecc, address, &signed).unwrap_err();
        assert_eq!(
            err.downcast::<MonadProfileVerifyError>().unwrap(),
            MonadProfileVerifyError::InvalidPubKeyLen(32),
        );
    }
}
