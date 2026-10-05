//! Provisional directory allocation: signed structure is not trusted directory state.
use crate::{
    default_context, validate_frame, AccountRef, CodecError, ContextError, Error, ErrorCategory,
    ErrorStage, ParsedFrame, Timestamp, TypedPayload, ValidationContext, ValidationResult,
};

/// Explicit reader-4/schema-4 opt-in. Runtime defaults remain reader 2/schema 3.
pub fn preview_directory_context() -> ValidationContext {
    let mut ctx = default_context();
    ctx.reader_version = 4;
    for schema in &mut ctx.supported_schemas {
        if schema.type_id == 4 {
            schema.schema_version = 4;
        }
    }
    ctx
}

/// Bounded signed evidence only; never grants routing, DM or durable-head admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewDirectoryEvidence {
    /// Exact wrapper and its typed child, including unknown optional bytes.
    pub attestation_frame: ParsedFrame,
    /// T1 of the exact complete type-4 frame, never the wrapper.
    pub statement_hash: [u8; 32],
    /// Exact T2 digest whose subject signature was checked.
    pub signature_digest: [u8; 32],
}

impl PreviewDirectoryEvidence {
    /// The signed statement and typed role-specific projection.
    pub fn statement_frame(&self) -> &ParsedFrame {
        match self.attestation_frame.typed.as_deref() {
            Some(TypedPayload::DirectoryAttestation { statement, .. }) => statement,
            _ => unreachable!("evidence is constructed only from an attestation"),
        }
    }
}

fn semantic(message: &str) -> CodecError {
    CodecError::new(
        ErrorCategory::Semantic,
        ErrorStage::S9,
        message,
        "root",
        None,
    )
}

pub(crate) fn is_preview(typed: &TypedPayload) -> bool {
    match typed {
        TypedPayload::DirectoryStatement { preview, .. } => preview.is_some(),
        TypedPayload::DirectoryAttestation { statement, .. } => {
            statement.typed.as_deref().is_some_and(is_preview)
        }
        _ => false,
    }
}

fn valid_point(key: &AccountRef) -> bool {
    key.key_type == 1
        && key.key_bytes.len() == 33
        && matches!(key.key_bytes[0], 2 | 3)
        && secp256k1_abc::PublicKey::from_slice(&key.key_bytes).is_ok()
}

/// Longest signed validity of one directory entry: 366 days, in nanoseconds.
const MAX_DIRECTORY_VALIDITY_NS: i128 = 31_622_400_000_000_000;

fn nanos(t: &Timestamp) -> i128 {
    i128::from(t.seconds) * 1_000_000_000 + i128::from(t.nanoseconds)
}

pub(crate) fn check_statement(typed: &TypedPayload) -> Result<(), CodecError> {
    let TypedPayload::DirectoryStatement {
        subject,
        revision,
        timestamp,
        relays,
        expiry: Some(expiry),
        stamp_key: Some(stamp),
        preview: Some(roles),
        ..
    } = typed
    else {
        return Ok(());
    };
    let keys = [subject, stamp, &roles.message_dh_key];
    if keys.iter().any(|key| !valid_point(key)) {
        return Err(semantic(
            "directory preview requires valid compressed type-1 role points",
        ));
    }
    for i in 0..keys.len() {
        for j in i + 1..keys.len() {
            if keys[i].key_bytes[1..] == keys[j].key_bytes[1..] {
                return Err(semantic(
                    "directory preview roles must differ, including point negation",
                ));
            }
        }
    }
    if relays.len() != 1 {
        return Err(semantic("directory preview requires exactly one relay"));
    }
    let relay = &relays[0];
    if !relay.endpoint.starts_with("https:") || !valid_point(&relay.identity) {
        return Err(semantic(
            "directory preview requires HTTPS and a valid type-1 relay point",
        ));
    }
    let duration = nanos(expiry) - nanos(timestamp);
    if duration <= 0 || duration > MAX_DIRECTORY_VALIDITY_NS || nanos(&relay.expiry) < nanos(expiry)
    {
        return Err(semantic("directory preview validity must be positive, at most 366 days and covered by relay expiry"));
    }
    if *revision == 0 {
        if roles.predecessor.is_some()
            || roles.mailbox_key_generation != 0
            || roles.stamp_key_generation != 0
        {
            return Err(semantic(
                "directory preview bootstrap requires null predecessor and zero generations",
            ));
        }
    } else if roles.predecessor.is_none()
        || roles.mailbox_key_generation > *revision
        || roles.stamp_key_generation > *revision
    {
        return Err(semantic(
            "directory preview successor requires predecessor and generations bounded by revision",
        ));
    }
    Ok(())
}

/// Verify canonical structure, role semantics, explicit network and exact T2 subject signature.
/// The successor must enforce trusted anchors, clock/freshness, authenticated relay tuples,
/// contiguous history/generations/no-reuse, cumulative budgets, forks and atomic admission.
pub fn verify_preview_directory_evidence(
    bytes: &[u8],
    network: &str,
) -> Result<PreviewDirectoryEvidence, Error> {
    if network.is_empty()
        || network.len() > 64
        || !network.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && matches!(b, b'.' | b'_' | b'-'))
        })
    {
        return Err(Error::Context(ContextError(
            "an explicit valid expected network is required".to_string(),
        )));
    }
    let mut ctx = preview_directory_context();
    ctx.route_byte_limit = 262_144;
    let ValidationResult::Parsed(attestation_frame) = validate_frame(bytes, &ctx)? else {
        return Err(Error::Codec(CodecError::new(
            ErrorCategory::Unsupported,
            ErrorStage::S7,
            "expected a preview directory attestation",
            "root",
            None,
        )));
    };
    let Some(TypedPayload::DirectoryAttestation {
        statement,
        signatures,
        ..
    }) = attestation_frame.typed.as_deref()
    else {
        return Err(Error::Codec(CodecError::new(
            ErrorCategory::Unsupported,
            ErrorStage::S7,
            "expected a preview directory attestation",
            "root",
            None,
        )));
    };
    let Some(TypedPayload::DirectoryStatement {
        network: actual,
        preview: Some(_),
        ..
    }) = statement.typed.as_deref()
    else {
        return Err(Error::Codec(CodecError::new(
            ErrorCategory::Unsupported,
            ErrorStage::S7,
            "expected a preview directory attestation",
            "root",
            None,
        )));
    };
    if actual != network {
        return Err(semantic("directory network differs from expected network").into());
    }
    crate::validate::verify_attestation(statement, signatures)?;
    let statement_hash =
        crate::content_hash(statement).map_err(|e| Error::Context(ContextError(e.0)))?;
    let signature_digest = crate::directory_signature_digest(network, &statement.frame)
        .map_err(|e| Error::Context(ContextError(e.0)))?;
    Ok(PreviewDirectoryEvidence {
        attestation_frame,
        statement_hash,
        signature_digest,
    })
}
