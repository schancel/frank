//! [`HmacBearerScheme`]: a chain-agnostic HMAC-based bearer token scheme.
//!
//! Inspired by (not a literal port of) the deprecated `cashweb-backends` repo's
//! `lib/cashweb-token/src/schemes/hmac_bearer.rs::HmacScheme`. Once a caller has verified a
//! payment (see [`crate::verifier::PaymentVerifier`]), it can issue a token binding that
//! verification to an arbitrary `scope` (e.g. a pubkey hash, an address, a resource path —
//! whatever the caller wants to gate). The token is a base64url-encoded HMAC-SHA256 tag over
//! `scope`, so later requests can be re-validated cheaply (without re-running payment
//! verification) by recomputing and comparing the tag.
//!
//! The server-side secret `key` never leaves this process; tokens are opaque to clients and
//! carry no state of their own beyond what's embedded in `scope` by the caller.

use base64::{CharacterSet, Config};
use bitcoinsuite_error::ErrorMeta;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

/// Base64 config used for token encoding: URL-safe alphabet, no padding.
fn base64_config() -> Config {
    Config::new(CharacterSet::UrlSafe, false)
}

/// Error associated with HMAC bearer token validation.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum ValidationError {
    /// Failed to base64-decode the token.
    #[invalid_client_input()]
    #[error("failed to decode token: {0:?}")]
    Base64(base64::DecodeError),
    /// Token was well-formed base64 but did not match the expected HMAC tag for `scope`.
    #[invalid_client_input()]
    #[error("invalid token")]
    Invalid,
}

/// A chain-agnostic HMAC-SHA256 bearer token scheme.
///
/// Construct one per server process, seeded with a secret key that only the server knows.
#[derive(Clone)]
pub struct HmacBearerScheme {
    key: Vec<u8>,
}

impl std::fmt::Debug for HmacBearerScheme {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately don't print `key`.
        f.debug_struct("HmacBearerScheme").finish_non_exhaustive()
    }
}

impl HmacBearerScheme {
    /// Create a new [`HmacBearerScheme`] using the given secret key.
    ///
    /// The key should be a securely generated random secret, kept only in server-side
    /// configuration/memory (e.g. generated once at deploy time). Any length is accepted (HMAC
    /// hashes keys longer than the block size), but at least 32 bytes is recommended.
    pub fn new(key: impl Into<Vec<u8>>) -> Self {
        Self { key: key.into() }
    }

    /// Issue (construct) a bearer token binding this scheme's key to `scope`.
    pub fn construct_token(&self, scope: &[u8]) -> String {
        // `HmacSha256::new_from_slice` only fails for invalid key lengths, which HMAC doesn't
        // impose (any length is valid), so this can't actually fail.
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(scope);
        let tag = mac.finalize().into_bytes();
        base64::encode_config(tag, base64_config())
    }

    /// Validate that `token` is a bearer token previously issued by [`Self::construct_token`]
    /// for this exact `scope`.
    pub fn validate_token(&self, scope: &[u8], token: &str) -> Result<(), ValidationError> {
        let tag = base64::decode_config(token, base64_config()).map_err(ValidationError::Base64)?;
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(scope);
        mac.verify_slice(&tag).map_err(|_| ValidationError::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let scheme = HmacBearerScheme::new(b"super-secret-server-key".to_vec());
        let scope = b"pubkey-hash-or-address-or-whatever";
        let token = scheme.construct_token(scope);
        assert!(scheme.validate_token(scope, &token).is_ok());
    }

    #[test]
    fn rejects_wrong_scope() {
        let scheme = HmacBearerScheme::new(b"super-secret-server-key".to_vec());
        let token = scheme.construct_token(b"scope-a");
        assert_eq!(
            scheme.validate_token(b"scope-b", &token),
            Err(ValidationError::Invalid)
        );
    }

    #[test]
    fn rejects_token_from_different_key() {
        let issuer = HmacBearerScheme::new(b"key-one".to_vec());
        let verifier = HmacBearerScheme::new(b"key-two".to_vec());
        let scope = b"same-scope";
        let token = issuer.construct_token(scope);
        assert_eq!(
            verifier.validate_token(scope, &token),
            Err(ValidationError::Invalid)
        );
    }

    #[test]
    fn rejects_malformed_base64() {
        let scheme = HmacBearerScheme::new(b"super-secret-server-key".to_vec());
        let result = scheme.validate_token(b"scope", "not valid base64!!");
        assert!(matches!(result, Err(ValidationError::Base64(_))));
    }

    #[test]
    fn rejects_tampered_token() {
        let scheme = HmacBearerScheme::new(b"super-secret-server-key".to_vec());
        let scope = b"scope";
        let mut token = scheme.construct_token(scope);
        // Flip the last character to corrupt the tag while staying valid base64url.
        let last = token.pop().unwrap();
        let replacement = if last == 'A' { 'B' } else { 'A' };
        token.push(replacement);
        assert_eq!(
            scheme.validate_token(scope, &token),
            Err(ValidationError::Invalid)
        );
    }
}
