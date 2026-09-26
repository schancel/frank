//! [`TokenIssuer`]: ties a [`PaymentVerifier`] (payment gating) together with an
//! [`HmacBearerScheme`] (token issuance/caching) into the full issue/validate lifecycle.
//!
//! - Issuing a token requires a fresh, successful [`PaymentVerifier::verify_payment`] call.
//! - Validating a previously issued token is a cheap local HMAC check, and does **not** call
//!   back into the [`PaymentVerifier`] — this is the "caching" half of the bearer-token layer:
//!   once a payment has been verified once, the resulting token can be presented on subsequent
//!   requests without re-verifying the payment each time.

use thiserror::Error;

use crate::hmac_bearer::{HmacBearerScheme, ValidationError as HmacValidationError};
use crate::verifier::PaymentVerifier;

/// Error returned by [`TokenIssuer::issue_token`].
#[derive(Debug, Error, PartialEq, Eq)]
pub enum IssueError<E> {
    /// The [`PaymentVerifier`] rejected the given proof.
    #[error("payment verification failed: {0}")]
    PaymentRejected(E),
}

/// Combines a [`PaymentVerifier`] with an [`HmacBearerScheme`] to provide the full POP bearer
/// token lifecycle: gated issuance, and cheap re-validation.
#[derive(Debug)]
pub struct TokenIssuer<V> {
    verifier: V,
    scheme: HmacBearerScheme,
}

impl<V: PaymentVerifier> TokenIssuer<V> {
    /// Create a new [`TokenIssuer`] from a [`PaymentVerifier`] and an [`HmacBearerScheme`].
    pub fn new(verifier: V, scheme: HmacBearerScheme) -> Self {
        Self { verifier, scheme }
    }

    /// Verify `proof` authorizes `scope` via the underlying [`PaymentVerifier`], and if so,
    /// issue a bearer token bound to `scope`.
    pub async fn issue_token(
        &self,
        scope: &[u8],
        proof: &[u8],
    ) -> Result<String, IssueError<V::Error>> {
        self.verifier
            .verify_payment(scope, proof)
            .await
            .map_err(IssueError::PaymentRejected)?;
        Ok(self.scheme.construct_token(scope))
    }

    /// Validate that `token` was previously issued for `scope`. Does not call the
    /// [`PaymentVerifier`]; this is a local HMAC check only.
    pub fn validate_token(&self, scope: &[u8], token: &str) -> Result<(), HmacValidationError> {
        self.scheme.validate_token(scope, token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verifier::test_util::{AllowlistError, AllowlistVerifier};

    fn issuer(allowed_proofs: Vec<Vec<u8>>) -> TokenIssuer<AllowlistVerifier> {
        TokenIssuer::new(
            AllowlistVerifier::new(allowed_proofs),
            HmacBearerScheme::new(b"test-server-secret".to_vec()),
        )
    }

    #[tokio::test]
    async fn issues_and_validates_token_for_accepted_proof() {
        let issuer = issuer(vec![b"valid-proof".to_vec()]);
        let scope = b"scope-for-alice";

        let token = issuer
            .issue_token(scope, b"valid-proof")
            .await
            .expect("proof is allowlisted");

        assert!(issuer.validate_token(scope, &token).is_ok());
    }

    #[tokio::test]
    async fn refuses_to_issue_for_rejected_proof() {
        let issuer = issuer(vec![b"valid-proof".to_vec()]);

        let result = issuer.issue_token(b"scope-for-alice", b"bogus-proof").await;

        assert_eq!(
            result,
            Err(IssueError::PaymentRejected(AllowlistError::NotRecognized))
        );
    }

    #[tokio::test]
    async fn issued_token_does_not_validate_against_a_different_scope() {
        let issuer = issuer(vec![b"valid-proof".to_vec()]);
        let token = issuer
            .issue_token(b"scope-for-alice", b"valid-proof")
            .await
            .unwrap();

        assert!(issuer.validate_token(b"scope-for-bob", &token).is_err());
    }
}
