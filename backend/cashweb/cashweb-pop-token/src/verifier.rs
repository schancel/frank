//! [`PaymentVerifier`]: the pluggable boundary between this crate's chain-agnostic token
//! issuance/caching logic and a chain-specific payment-verification backend.
//!
//! This crate ships no implementation of this trait. A later ticket (#23) provides a
//! Monad-backed implementation; a Lotus/BCH-backed implementation could equally be written
//! against the same trait. Nothing in this crate (or in [`crate::issuer::TokenIssuer`]) depends
//! on any specific chain client.

use async_trait::async_trait;

/// A chain-specific backend capable of verifying that a payment proof authorizes access to a
/// given scope.
///
/// `scope` and `proof` are both opaque byte slices as far as this trait is concerned:
/// - `scope` is whatever the caller wants the resulting token to be bound to (e.g. a pubkey
///   hash, an address, a hash of a requested resource). It's the same value that gets passed to
///   [`crate::hmac_bearer::HmacBearerScheme::construct_token`]/`validate_token`.
/// - `proof` is chain-specific evidence of payment (e.g. a raw transaction, a tx id + vout, a
///   signed receipt) that the implementation knows how to interpret and check on-chain.
///
/// Implementations should treat `verify_payment` as fallible for any reason a payment might not
/// actually authorize `scope` (wrong amount, wrong commitment, not found, already used, chain
/// RPC failure, ...); callers only need to know success from failure to decide whether to issue
/// a token.
#[async_trait]
pub trait PaymentVerifier: std::fmt::Debug + Send + Sync {
    /// Error returned when a payment proof fails to verify, or verification itself fails (e.g.
    /// a chain RPC error).
    type Error: std::error::Error + Send + Sync + 'static;

    /// Verify that `proof` is a valid payment proof authorizing access to `scope`.
    ///
    /// Returns `Ok(())` if a token for `scope` may be issued; `Err(_)` otherwise.
    async fn verify_payment(&self, scope: &[u8], proof: &[u8]) -> Result<(), Self::Error>;
}

#[cfg(test)]
pub(crate) mod test_util {
    //! A trivial in-memory [`PaymentVerifier`] used by this crate's own tests, and available for
    //! downstream crates to use in their own tests without depending on a real chain backend.

    use super::PaymentVerifier;
    use async_trait::async_trait;
    use std::collections::HashSet;
    use std::sync::Mutex;
    use thiserror::Error;

    /// Error returned by [`AllowlistVerifier`].
    #[derive(Debug, Error, PartialEq, Eq)]
    pub(crate) enum AllowlistError {
        /// The given proof was not in the verifier's allowlist.
        #[error("payment proof not recognized")]
        NotRecognized,
    }

    /// A [`PaymentVerifier`] that accepts any `proof` present in a fixed allowlist, regardless
    /// of `scope`. Useful for exercising [`crate::issuer::TokenIssuer`] in tests without a real
    /// chain-specific implementation.
    #[derive(Debug, Default)]
    pub(crate) struct AllowlistVerifier {
        allowed_proofs: Mutex<HashSet<Vec<u8>>>,
    }

    impl AllowlistVerifier {
        /// Create a verifier that accepts exactly the given proofs.
        pub(crate) fn new(allowed_proofs: impl IntoIterator<Item = Vec<u8>>) -> Self {
            Self {
                allowed_proofs: Mutex::new(allowed_proofs.into_iter().collect()),
            }
        }
    }

    #[async_trait]
    impl PaymentVerifier for AllowlistVerifier {
        type Error = AllowlistError;

        async fn verify_payment(&self, _scope: &[u8], proof: &[u8]) -> Result<(), Self::Error> {
            if self.allowed_proofs.lock().unwrap().contains(proof) {
                Ok(())
            } else {
                Err(AllowlistError::NotRecognized)
            }
        }
    }
}
