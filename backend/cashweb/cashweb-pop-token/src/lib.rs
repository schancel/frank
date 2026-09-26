#![warn(
    missing_debug_implementations,
    missing_docs,
    rust_2018_idioms,
    unreachable_pub
)]

//! `cashweb-pop-token` is a chain-agnostic library providing the [`POP Token Protocol`]'s
//! bearer-token issuance/caching layer: extracting a POP token from an HTTP request, and an
//! HMAC-based scheme for issuing/validating tokens that are bound to a payment verification
//! gated by the pluggable [`verifier::PaymentVerifier`] trait.
//!
//! This crate deliberately has no dependency on any specific blockchain client. A chain-specific
//! [`verifier::PaymentVerifier`] implementation (e.g. Monad-backed) is expected to live in its
//! own crate/module and be plugged in via [`issuer::TokenIssuer`].
//!
//! [`POP Token Protocol`]: https://github.com/cashweb/specifications/blob/master/proof-of-payment-token/specification.mediawiki

pub mod extract;
pub mod hmac_bearer;
pub mod issuer;
pub mod verifier;

pub use extract::{extract_pop, extract_pop_header, extract_pop_or_query, split_pop_token};
pub use hmac_bearer::HmacBearerScheme;
pub use issuer::{IssueError, TokenIssuer};
pub use verifier::PaymentVerifier;
