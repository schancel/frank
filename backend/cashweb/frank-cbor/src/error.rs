//! Stable cross-language error categories (README section 10).

use std::fmt;

/// Category preserved across languages. English text is not stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    /// Short header, bad magic, or declared-length mismatch.
    Frame,
    /// Unknown version or unallocated identifier, without permitted retention.
    Unsupported,
    /// A byte, depth, container, item, or type-specific limit.
    Resource,
    /// Truncated or ill-formed CBOR, including invalid UTF-8.
    Malformed,
    /// A non-shortest or indefinite encoding, or a duplicate or unsorted key.
    Noncanonical,
    /// A forbidden CBOR class or a CDDL/profile violation.
    Schema,
    /// Ordering, uniqueness, linkage, or cross-field equality.
    Semantic,
}

impl ErrorCategory {
    /// Manifest spelling of the category.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Frame => "frame",
            Self::Unsupported => "unsupported",
            Self::Resource => "resource",
            Self::Malformed => "malformed",
            Self::Noncanonical => "noncanonical",
            Self::Schema => "schema",
            Self::Semantic => "semantic",
        }
    }
}

impl fmt::Display for ErrorCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Section 9 stage that determined the failure. `cbor` is the standalone item API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorStage {
    /// Root length limits.
    S1,
    /// Magic and header size.
    S2,
    /// Frame version.
    S3,
    /// Declared body length.
    S4,
    /// Envelope CBOR.
    S5,
    /// Envelope keys and ranges.
    S6,
    /// Payload CBOR and the V6 decision.
    S7,
    /// Type-specific limits.
    S81,
    /// CDDL structure.
    S82,
    /// Allocated identifiers.
    S83,
    /// Recursive child frames.
    S84,
    /// Semantic checks.
    S9,
    /// Standalone restricted-CBOR API.
    Cbor,
}

impl ErrorStage {
    /// Manifest-free stage label (`8.1`, `cbor`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::S1 => "1",
            Self::S2 => "2",
            Self::S3 => "3",
            Self::S4 => "4",
            Self::S5 => "5",
            Self::S6 => "6",
            Self::S7 => "7",
            Self::S81 => "8.1",
            Self::S82 => "8.2",
            Self::S83 => "8.3",
            Self::S84 => "8.4",
            Self::S9 => "9",
            Self::Cbor => "cbor",
        }
    }
}

impl fmt::Display for ErrorStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which CBOR pass raised a CBOR-stage failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CborPass {
    /// Syntax and resource limits, in byte order.
    A,
    /// Canonicality and profile class, after pass A succeeds.
    B,
}

impl CborPass {
    /// `A` or `B`, concatenated onto the stage label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
        }
    }
}

/// A protocol failure. The category and stage are stable; `detail` is not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecError {
    /// Stable category.
    pub category: ErrorCategory,
    /// Section 9 stage.
    pub stage: ErrorStage,
    /// Set only for a CBOR pass failure.
    pub pass: Option<CborPass>,
    /// Human-readable location, for example `root/payload`.
    pub location: String,
    /// Message without the category prefix.
    pub detail: String,
}

impl CodecError {
    pub(crate) fn new(
        category: ErrorCategory,
        stage: ErrorStage,
        detail: impl Into<String>,
        location: impl Into<String>,
        pass: Option<CborPass>,
    ) -> Self {
        Self {
            category,
            stage,
            pass,
            location: location.into(),
            detail: detail.into(),
        }
    }
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} (stage {}{}) at {}: {}",
            self.category,
            self.stage,
            self.pass.map(CborPass::as_str).unwrap_or(""),
            self.location,
            self.detail
        )
    }
}

impl std::error::Error for CodecError {}

/// The caller supplied an invalid validation context. Not a vector outcome.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ContextError(pub String);

/// Failure of [`crate::validate_frame`] or [`crate::parse_frame`].
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The frame failed a section 9 check.
    #[error(transparent)]
    Codec(#[from] CodecError),
    /// `route_byte_limit` or the prior-statement slot was unusable.
    #[error(transparent)]
    Context(#[from] ContextError),
}

/// Caller error from an encoder or transcript helper. Not a decode category.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct UsageError(pub String);
