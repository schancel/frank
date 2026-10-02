//! Section 9 validation order, stages 1-9 plus stage 10.6.
//!
//! Stage 10.6 verifies every type-2 signature entry and key-transition authorization. Stages
//! 10.1-10.5 (the type-1 stamp checks) are not implemented; a `full` type-1 root is a
//! context error.

use std::collections::HashMap;

use crate::cbor::{decode_single_item, Counters};
use crate::crypto;
use crate::error::{CodecError, ContextError, Error, ErrorCategory, ErrorStage};
use crate::hash::{directory_signature_digest, key_transition_signature_digest};
use crate::limits::{
    is_known_type, FRAME_HEADER_BYTES, FRAME_MAGIC, FRAME_VERSION, KNOWN_TYPES, MAX_FRAME_BYTES,
    MAX_MESSAGE_ITEMS_TOTAL, TYPE_DIRECTORY_STATEMENT, TYPE_KEY_TRANSITION_STATEMENT,
    TYPE_MESSAGE_REVISION, TYPE_RECIPIENT_PAYLOAD, TYPE_TOPIC_POST,
};
use crate::model::{
    ChildFrame, FrameOnly, JournalFact, KeyTransition, OpaqueSection, ParsedFrame, PaymentMember,
    ProfileEntry, ProfileHeader, Projection, RelayBinding, RetainedFrame, RetentionReason,
    SignatureEntry, TypedPayload, ValidationResult,
};
use crate::schema::{
    check_allocated, check_root_frame_limit, check_type_limits, parse_draft, Draft, SchemaVersions,
};
use crate::semantic::{check_semantics, PriorView};

/// How far section 9 runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Stop after stage 4.
    Frame,
    /// Stop after stage 7.
    Generic,
    /// Stop after stage 9.
    Typed,
    /// Run stage 10.6 (the type-2 signature verification) after stage 9.
    Full,
}

/// One entry of the reader's supported-schema list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupportedSchema {
    /// Type identifier.
    pub type_id: u32,
    /// Highest schema version this reader supports for the type.
    pub schema_version: u32,
}

/// Prior type-4 statement supplied with a type-2 validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PriorStatement {
    /// The caller did not provide the slot.
    Absent,
    /// Bootstrap: there is no prior statement.
    None,
    /// Exact bytes of the last accepted type-4 frame.
    Frame(Vec<u8>),
}

/// Normative validation context (README section 10). No ambient state is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationContext {
    /// Final stage to run.
    pub operation: Operation,
    /// Stage 1 caller limit. Values above [`MAX_FRAME_BYTES`] do not raise that ceiling.
    pub route_byte_limit: u64,
    /// Semantic reader version compared with `min_reader_version`.
    pub reader_version: u32,
    /// Types this reader knows, with the highest schema it implements.
    pub supported_schemas: Vec<SupportedSchema>,
    /// Governs the root frame only (V6.1).
    pub opaque_retention_allowed: bool,
    /// Required for a type-2 root under [`Operation::Typed`] or [`Operation::Full`].
    /// Ignored otherwise.
    pub prior: PriorStatement,
}

/// Typed validation of every v1 schema, with no root retention and a bootstrap prior.
pub fn default_context() -> ValidationContext {
    ValidationContext {
        operation: Operation::Typed,
        route_byte_limit: MAX_FRAME_BYTES as u64,
        // Reader version 2 reads type 4 at schema 3 (the stamp key and profile entries, README
        // S10a.1 and M4); every other type stays at schema 1.
        reader_version: 2,
        supported_schemas: KNOWN_TYPES
            .iter()
            .copied()
            .map(|type_id| SupportedSchema {
                type_id,
                schema_version: if type_id == TYPE_DIRECTORY_STATEMENT {
                    3
                } else {
                    1
                },
            })
            .collect(),
        opaque_retention_allowed: false,
        prior: PriorStatement::None,
    }
}

enum Mode {
    Root,
    Open,
    Required { type_id: u32 },
}

struct Shared<'a> {
    ctx: &'a ValidationContext,
    supported: HashMap<u32, u32>,
    counters: Counters,
    items_opened: u32,
    /// Set when the prior-statement slot is unusable. That is a context error,
    /// which `process_frame` cannot return directly.
    context_error: Option<ContextError>,
}

struct Envelope {
    type_id: u32,
    schema_version: u32,
    min_reader_version: u32,
    payload_bytes: Vec<u8>,
}

fn fail(
    category: ErrorCategory,
    stage: ErrorStage,
    detail: impl Into<String>,
    location: &str,
) -> CodecError {
    CodecError::new(category, stage, detail, location, None)
}

fn relocate(location: &str, mut error: CodecError) -> CodecError {
    if location != "root" && error.location.starts_with("root") {
        error.location = format!("{location}{}", &error.location["root".len()..]);
    }
    error
}

fn relocating<T>(location: &str, result: Result<T, CodecError>) -> Result<T, CodecError> {
    result.map_err(|error| relocate(location, error))
}

fn map_get(value: &crate::cbor::CborValue, key: u64) -> Option<&crate::cbor::CborValue> {
    match value {
        crate::cbor::CborValue::Map(entries) => {
            entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
        }
        _ => None,
    }
}

fn parse_envelope(value: &crate::cbor::CborValue, location: &str) -> Result<Envelope, CodecError> {
    let bad = |detail: String| {
        fail(
            ErrorCategory::Schema,
            ErrorStage::S6,
            detail,
            &format!("{location}/envelope"),
        )
    };
    let crate::cbor::CborValue::Map(entries) = value else {
        return Err(bad("the envelope must be a map (E1)".to_string()));
    };
    if entries.len() != 4 {
        return Err(bad(
            "the envelope must have exactly keys 0..3 (E1)".to_string()
        ));
    }
    for key in [0, 1, 2, 3] {
        if !entries.iter().any(|(k, _)| *k == key) {
            return Err(bad(format!("missing envelope key {key} (E1)")));
        }
    }
    let u32_field = |key: u64, min: u64| -> Result<u32, CodecError> {
        match map_get(value, key) {
            Some(crate::cbor::CborValue::Int(n))
                if *n >= min as i128 && *n <= i128::from(u32::MAX) =>
            {
                Ok(*n as u32)
            }
            Some(crate::cbor::CborValue::Int(_)) => {
                Err(bad(format!("envelope key {key} out of range")))
            }
            _ => Err(bad(format!(
                "envelope key {key} must be an unsigned integer"
            ))),
        }
    };
    let type_id = u32_field(0, 0)?;
    let schema_version = u32_field(1, 1)?;
    let min_reader_version = u32_field(2, 1)?;
    let payload_bytes = match map_get(value, 3) {
        Some(crate::cbor::CborValue::Bytes(bytes)) => bytes.clone(),
        _ => return Err(bad("envelope payload must be a byte string".to_string())),
    };
    if min_reader_version > schema_version {
        return Err(bad(
            "min_reader_version exceeds schema_version (E2)".to_string()
        ));
    }
    Ok(Envelope {
        type_id,
        schema_version,
        min_reader_version,
        payload_bytes,
    })
}

fn retained(reason: RetentionReason, frame: Vec<u8>, env: Option<&Envelope>) -> RetainedFrame {
    let (type_id, schema_version, min_reader_version) = match env {
        Some(env) => (
            Some(env.type_id),
            Some(env.schema_version),
            Some(env.min_reader_version),
        ),
        None => (None, None, None),
    };
    RetainedFrame {
        reason,
        frame,
        type_id,
        schema_version,
        min_reader_version,
    }
}

fn highest(supported: &HashMap<u32, u32>, type_id: u32) -> Option<u32> {
    if !is_known_type(type_id) {
        return None;
    }
    supported.get(&type_id).copied()
}

fn process_frame(
    frame: Vec<u8>,
    mode: Mode,
    container_depth: u32,
    shared: &mut Shared<'_>,
    location: &str,
    stop_after: Operation,
) -> Result<ValidationResult, CodecError> {
    if frame.len() < FRAME_HEADER_BYTES {
        return Err(fail(
            ErrorCategory::Frame,
            ErrorStage::S2,
            "fewer than nine header bytes",
            location,
        ));
    }
    if frame[..4] != FRAME_MAGIC {
        return Err(fail(
            ErrorCategory::Frame,
            ErrorStage::S2,
            "bad magic (F1)",
            location,
        ));
    }
    if frame[4] != FRAME_VERSION {
        if matches!(mode, Mode::Required { .. }) {
            return Err(fail(
                ErrorCategory::Unsupported,
                ErrorStage::S3,
                format!("unsupported frame version {} (F2)", frame[4]),
                location,
            ));
        }
        if matches!(mode, Mode::Open) || shared.ctx.opaque_retention_allowed {
            return Ok(ValidationResult::Retained(retained(
                RetentionReason::UnsupportedFrameVersion,
                frame,
                None,
            )));
        }
        return Err(fail(
            ErrorCategory::Unsupported,
            ErrorStage::S3,
            format!("unsupported frame version {} (F2)", frame[4]),
            location,
        ));
    }
    let declared = u32::from_be_bytes([frame[5], frame[6], frame[7], frame[8]]);
    let present = frame.len() - FRAME_HEADER_BYTES;
    if declared as usize != present {
        return Err(fail(
            ErrorCategory::Frame,
            ErrorStage::S4,
            format!("declared length {declared} differs from the {present} bytes present (F3)"),
            location,
        ));
    }
    if matches!(mode, Mode::Root) && stop_after == Operation::Frame {
        return Ok(ValidationResult::Frame(FrameOnly {
            version: frame[4],
            body: frame[FRAME_HEADER_BYTES..].to_vec(),
            frame,
        }));
    }
    let env_value = decode_single_item(
        &frame[FRAME_HEADER_BYTES..],
        ErrorStage::S5,
        &format!("{location}/envelope"),
        &mut shared.counters,
        container_depth,
    )?;
    let env = parse_envelope(&env_value, location)?;
    if let Mode::Required { type_id } = mode {
        if env.type_id != type_id {
            return Err(fail(
                ErrorCategory::Semantic,
                ErrorStage::S84,
                format!(
                    "a required-type field must carry type {type_id}, found {} (S8)",
                    env.type_id
                ),
                location,
            ));
        }
    }
    if matches!(mode, Mode::Open) && (1..=11).contains(&env.type_id) {
        return Err(fail(
            ErrorCategory::Semantic,
            ErrorStage::S84,
            format!(
                "an open message-item field cannot carry assigned type {} (S8)",
                env.type_id
            ),
            location,
        ));
    }
    let env_depth = container_depth + 1;
    let payload = decode_single_item(
        &env.payload_bytes,
        ErrorStage::S7,
        &format!("{location}/payload"),
        &mut shared.counters,
        env_depth,
    )?;
    let known = highest(&shared.supported, env.type_id);
    if known.is_none() {
        return keep_or_reject(
            shared,
            &mode,
            RetentionReason::UnknownType,
            format!("type {} is not known to this reader (V6.1)", env.type_id),
            frame,
            Some(&env),
            location,
        );
    }
    if env.min_reader_version > shared.ctx.reader_version {
        return keep_or_reject(
            shared,
            &mode,
            RetentionReason::UnsupportedMinReader,
            format!(
                "min_reader_version {} exceeds reader version (V6.1)",
                env.min_reader_version
            ),
            frame,
            Some(&env),
            location,
        );
    }
    let highest_schema = known.expect("known type");
    let projection = if env.schema_version > highest_schema {
        Projection::NewerSchema
    } else {
        Projection::Exact
    };
    let allow_unknown = projection == Projection::NewerSchema;
    let mut parsed = ParsedFrame {
        frame,
        type_id: env.type_id,
        schema_version: env.schema_version,
        min_reader_version: env.min_reader_version,
        payload_bytes: env.payload_bytes,
        payload,
        projection,
        typed: None,
    };
    if matches!(mode, Mode::Root) && stop_after == Operation::Generic {
        return Ok(ValidationResult::Parsed(parsed));
    }
    if matches!(mode, Mode::Root) && !check_root_frame_limit(parsed.type_id, parsed.frame.len()) {
        return Err(fail(
            ErrorCategory::Resource,
            ErrorStage::S81,
            "frame exceeds its type-specific limit (R2/R3)",
            location,
        ));
    }
    let draft = relocating(location, {
        check_type_limits(parsed.type_id, &parsed.payload)?;
        let draft = parse_draft(
            parsed.type_id,
            &parsed.payload,
            allow_unknown,
            SchemaVersions {
                envelope: parsed.schema_version,
                effective: parsed.schema_version.min(highest_schema),
            },
        )?;
        check_allocated(&draft)?;
        Ok(draft)
    })?;
    let typed = open_children(draft, env_depth, shared, location)?;
    let prior_slot = if typed_is_type2(&typed) {
        match resolve_prior_view(shared.ctx) {
            Ok(view) => Some(view),
            Err(Error::Context(context)) => {
                shared.context_error = Some(context);
                return Err(fail(
                    ErrorCategory::Semantic,
                    ErrorStage::S9,
                    "prior statement context",
                    location,
                ));
            }
            Err(Error::Codec(codec)) => return Err(codec),
        }
    } else {
        None
    };
    relocating(
        location,
        check_semantics(&typed, prior_slot.as_ref().map(|slot| slot.as_ref())),
    )?;
    parsed.typed = Some(Box::new(typed));
    if matches!(mode, Mode::Root) && stop_after == Operation::Full {
        match run_stage_10(&parsed) {
            Ok(()) => {}
            Err(Error::Codec(codec)) => return Err(codec),
            Err(Error::Context(context)) => {
                shared.context_error = Some(context);
                return Err(fail(
                    ErrorCategory::Semantic,
                    ErrorStage::S9,
                    "stage 10 context",
                    location,
                ));
            }
        }
    }
    Ok(ValidationResult::Parsed(parsed))
}

/// Stage 10 for a root frame. Only 10.6 exists in this slice; it applies to a type-2 root.
fn run_stage_10(parsed: &ParsedFrame) -> Result<(), Error> {
    let Some(typed) = parsed.typed.as_deref() else {
        return Err(Error::Context(ContextError(
            "internal: stage 10 needs the typed projection".to_string(),
        )));
    };
    match typed {
        TypedPayload::DirectoryAttestation {
            statement,
            signatures,
            ..
        } => {
            verify_attestation(statement, signatures)?;
            Ok(())
        }
        TypedPayload::DirectMessage { .. } => Err(Error::Context(ContextError(
            "stages 10.1-10.5 (the type-1 stamp checks) are outside this slice; `full` runs \
             only the type-2 signature verification of stage 10.6"
                .to_string(),
        ))),
        _ => Ok(()),
    }
}

/// Stage 10.6: first preflight all entries for allocated-but-unverifiable algorithms (M7), then
/// verify signature entries followed by key-transition authorizations in document order.
fn verify_attestation(
    statement: &ParsedFrame,
    signatures: &[SignatureEntry],
) -> Result<(), CodecError> {
    let Some(typed) = statement.typed.as_deref() else {
        return Err(fail(
            ErrorCategory::Cryptographic,
            ErrorStage::S106,
            "internal: statement not typed",
            "root/payload.1",
        ));
    };
    let TypedPayload::DirectoryStatement {
        network,
        key_transitions,
        ..
    } = typed
    else {
        return Err(fail(
            ErrorCategory::Cryptographic,
            ErrorStage::S106,
            "internal: statement not a type-4 payload",
            "root/payload.1",
        ));
    };
    let digest = directory_signature_digest(network, &statement.frame).map_err(|err| {
        fail(
            ErrorCategory::Cryptographic,
            ErrorStage::S106,
            format!("invalid directory signature transcript: {}", err.0),
            "root/payload.0",
        )
    })?;
    let transitions = key_transitions.as_deref().unwrap_or(&[]);
    // M7: an allocated algorithm this reader cannot verify makes the entire attestation
    // unsupported. Discover that before running any algorithm-1 verification.
    for (i, entry) in signatures.iter().enumerate() {
        preflight_algorithm(entry.algorithm, &format!("root/payload.1[{i}]"))?;
    }
    for (i, transition) in transitions.iter().enumerate() {
        preflight_algorithm(transition.algorithm, &format!("root/payload.0/5[{i}]"))?;
    }
    for (i, entry) in signatures.iter().enumerate() {
        verify_entry(
            entry.algorithm,
            &entry.signer,
            &entry.signature,
            &digest,
            &format!("root/payload.1[{i}]"),
        )?;
    }
    for (i, transition) in transitions.iter().enumerate() {
        let transition_typed = transition.statement.typed.as_deref();
        let Some(TypedPayload::KeyTransitionStatement {
            network: transition_network,
            ..
        }) = transition_typed
        else {
            return Err(fail(
                ErrorCategory::Cryptographic,
                ErrorStage::S106,
                "internal: transition statement not typed",
                &format!("root/payload.0/5[{i}]"),
            ));
        };
        let digest =
            key_transition_signature_digest(transition_network, &transition.statement.frame)
                .map_err(|err| {
                    fail(
                        ErrorCategory::Cryptographic,
                        ErrorStage::S106,
                        format!("invalid key-transition signature transcript: {}", err.0),
                        &format!("root/payload.0/5[{i}]"),
                    )
                })?;
        verify_entry(
            transition.algorithm,
            &transition.signer,
            &transition.signature,
            &digest,
            &format!("root/payload.0/5[{i}]"),
        )?;
    }
    Ok(())
}

fn preflight_algorithm(algorithm: u32, location: &str) -> Result<(), CodecError> {
    if matches!(algorithm, 2 | 3 | 16) {
        return Err(fail(
            ErrorCategory::Unsupported,
            ErrorStage::S106,
            format!("algorithm {algorithm} is allocated but not verifiable in this slice (M7)"),
            location,
        ));
    }
    Ok(())
}

/// One stage-10.6 entry: M7's `unsupported` for allocated-but-unverifiable algorithms, then
/// the algorithm-1 verification. Unallocated algorithms cannot reach this point (stage 8.3).
fn verify_entry(
    algorithm: u32,
    signer: &crate::model::AccountRef,
    signature: &[u8],
    digest: &[u8; 32],
    location: &str,
) -> Result<(), CodecError> {
    preflight_algorithm(algorithm, location)?;
    if algorithm != 1 {
        return Err(fail(
            ErrorCategory::Unsupported,
            ErrorStage::S106,
            format!("algorithm {algorithm} is not allocated to this reader (S2a)"),
            location,
        ));
    }
    if !crypto::verify_algorithm_1(digest, signature, &signer.key_bytes) {
        return Err(fail(
            ErrorCategory::Cryptographic,
            ErrorStage::S106,
            "the algorithm-1 signature does not verify over the transcript digest",
            location,
        ));
    }
    Ok(())
}

fn typed_is_type2(typed: &TypedPayload) -> bool {
    matches!(typed, TypedPayload::DirectoryAttestation { .. })
}

fn keep_or_reject(
    shared: &Shared<'_>,
    mode: &Mode,
    reason: RetentionReason,
    message: String,
    frame: Vec<u8>,
    env: Option<&Envelope>,
    location: &str,
) -> Result<ValidationResult, CodecError> {
    if matches!(mode, Mode::Required { .. }) {
        return Err(fail(
            ErrorCategory::Unsupported,
            ErrorStage::S7,
            message,
            location,
        ));
    }
    if matches!(mode, Mode::Open) || shared.ctx.opaque_retention_allowed {
        return Ok(ValidationResult::Retained(retained(reason, frame, env)));
    }
    Err(fail(
        ErrorCategory::Unsupported,
        ErrorStage::S7,
        message,
        location,
    ))
}

fn open_required(
    bytes: Vec<u8>,
    type_id: u32,
    container_depth: u32,
    shared: &mut Shared<'_>,
    location: &str,
) -> Result<ParsedFrame, CodecError> {
    match process_frame(
        bytes,
        Mode::Required { type_id },
        container_depth,
        shared,
        location,
        Operation::Typed,
    )? {
        ValidationResult::Parsed(parsed) => Ok(parsed),
        _ => panic!("internal: required child was not parsed"),
    }
}

fn open_items(
    items: Vec<Vec<u8>>,
    container_depth: u32,
    shared: &mut Shared<'_>,
    location: &str,
) -> Result<Vec<ChildFrame>, CodecError> {
    let mut out = Vec::with_capacity(items.len());
    for (i, bytes) in items.into_iter().enumerate() {
        shared.items_opened = shared.items_opened.saturating_add(1);
        if shared.items_opened > MAX_MESSAGE_ITEMS_TOTAL {
            return Err(fail(
                ErrorCategory::Resource,
                ErrorStage::S84,
                "more than 256 message items in the opened graph (R2)",
                location,
            ));
        }
        match process_frame(
            bytes,
            Mode::Open,
            container_depth,
            shared,
            &format!("{location}[{i}]"),
            Operation::Typed,
        )? {
            ValidationResult::Parsed(parsed) => out.push(ChildFrame::Parsed(parsed)),
            ValidationResult::Retained(retained) => out.push(ChildFrame::Retained(retained)),
            ValidationResult::Frame(_) => panic!("internal: unexpected frame-only result"),
        }
    }
    Ok(out)
}

fn open_children(
    draft: Draft,
    env_depth: u32,
    shared: &mut Shared<'_>,
    location: &str,
) -> Result<TypedPayload, CodecError> {
    let path = format!("{location}/payload");
    match draft {
        Draft::DirectMessage {
            network,
            destination,
            payload_frame,
            payload_digest,
            payments,
            unknown,
        } => Ok(TypedPayload::DirectMessage {
            network,
            destination,
            payload_frame: open_required(
                payload_frame,
                TYPE_RECIPIENT_PAYLOAD,
                env_depth + 1,
                shared,
                &format!("{path}.2"),
            )?,
            payload_digest,
            payments: payments
                .into_iter()
                .map(|payment| PaymentMember {
                    child_index: payment.child_index,
                    transaction_id: payment.transaction_id,
                    value: payment.value,
                    address: payment.address,
                    commitment: payment.commitment,
                })
                .collect(),
            unknown,
        }),
        Draft::DirectoryAttestation {
            statement_frame,
            signatures,
            unknown,
        } => Ok(TypedPayload::DirectoryAttestation {
            statement: open_required(
                statement_frame,
                TYPE_DIRECTORY_STATEMENT,
                env_depth + 1,
                shared,
                &format!("{path}.0"),
            )?,
            signatures: signatures
                .into_iter()
                .map(|sig| SignatureEntry {
                    algorithm: sig.algorithm,
                    signer: sig.signer,
                    signature: sig.signature,
                })
                .collect(),
            unknown,
        }),
        Draft::Checkpoint {
            network,
            owner,
            checkpoint_id,
            timestamp,
            facts,
            sections,
            unknown,
        } => Ok(TypedPayload::MailboxCheckpoint {
            network,
            owner,
            checkpoint_id,
            timestamp,
            facts: facts
                .into_iter()
                .map(|fact| JournalFact {
                    timestamp: fact.timestamp,
                    fact_id: fact.fact_id,
                    kind: fact.kind,
                    payload: fact.payload,
                    unknown: fact.unknown,
                })
                .collect(),
            sections: sections.map(|items| {
                items
                    .into_iter()
                    .map(|section| OpaqueSection {
                        section_type: section.section_type,
                        section_schema_version: section.section_schema_version,
                        value: section.value,
                    })
                    .collect()
            }),
            unknown,
        }),
        Draft::Statement {
            network,
            subject,
            revision,
            timestamp,
            relays,
            key_transitions,
            expiry,
            recovery,
            schema_version,
            stamp_key,
            profile_entries,
            unknown,
        } => {
            let key_transitions = match key_transitions {
                Some(items) => {
                    let mut opened = Vec::with_capacity(items.len());
                    for (i, transition) in items.into_iter().enumerate() {
                        opened.push(KeyTransition {
                            statement: open_required(
                                transition.statement_frame,
                                TYPE_KEY_TRANSITION_STATEMENT,
                                env_depth + 3,
                                shared,
                                &format!("{path}.5[{i}].0"),
                            )?,
                            algorithm: transition.algorithm,
                            signer: transition.signer,
                            signature: transition.signature,
                            unknown: transition.unknown,
                        });
                    }
                    Some(opened)
                }
                None => None,
            };
            Ok(TypedPayload::DirectoryStatement {
                network,
                subject,
                revision,
                timestamp,
                relays: relays
                    .into_iter()
                    .map(|relay| RelayBinding {
                        relay_id: relay.relay_id,
                        endpoint: relay.endpoint,
                        identity: relay.identity,
                        expiry: relay.expiry,
                        unknown: relay.unknown,
                    })
                    .collect(),
                key_transitions,
                expiry,
                recovery,
                schema_version,
                stamp_key,
                profile_entries: profile_entries.map(|entries| {
                    entries
                        .into_iter()
                        .map(|entry| ProfileEntry {
                            kind: entry.kind,
                            headers: entry
                                .headers
                                .into_iter()
                                .map(|header| ProfileHeader {
                                    name: header.name,
                                    value: header.value,
                                    unknown: header.unknown,
                                })
                                .collect(),
                            body: entry.body,
                            unknown: entry.unknown,
                        })
                        .collect()
                }),
                unknown,
            })
        }
        Draft::Recipient {
            network,
            sender,
            recipient,
            suite,
            nonce,
            ciphertext,
            ephemeral_point,
            shared_point,
            dleq_proof,
            unknown,
        } => Ok(TypedPayload::RecipientPayload {
            network,
            sender,
            recipient,
            suite,
            nonce,
            ciphertext,
            ephemeral_point,
            shared_point,
            dleq_proof,
            unknown,
        }),
        Draft::Encrypted {
            network,
            message_id,
            revision_frame,
            content_digest,
            unknown,
        } => Ok(TypedPayload::EncryptedContent {
            network,
            message_id,
            revision_frame: open_required(
                revision_frame,
                TYPE_MESSAGE_REVISION,
                env_depth + 1,
                shared,
                &format!("{path}.2"),
            )?,
            content_digest,
            unknown,
        }),
        Draft::TransitionStatement {
            network,
            subject,
            prior_authority,
            revision,
            new_key,
            unknown,
        } => Ok(TypedPayload::KeyTransitionStatement {
            network,
            subject,
            prior_authority,
            revision,
            new_key,
            unknown,
        }),
        Draft::TopicPost {
            network,
            topic,
            parent_hash,
            body,
            unknown,
        } => Ok(TypedPayload::TopicPost {
            network,
            topic,
            parent_hash,
            body,
            unknown,
        }),
        Draft::TopicPostSubmission {
            network,
            post_frame,
            burn_tx,
            unknown,
        } => Ok(TypedPayload::TopicPostSubmission {
            network,
            post_frame: open_required(
                post_frame,
                TYPE_TOPIC_POST,
                env_depth + 1,
                shared,
                &format!("{path}.1"),
            )?,
            burn_tx,
            unknown,
        }),
        Draft::TopicVoteSubmission {
            network,
            target_hash,
            burn_tx,
            unknown,
        } => Ok(TypedPayload::TopicVoteSubmission {
            network,
            target_hash,
            burn_tx,
            unknown,
        }),
        Draft::Revision { items, unknown } => Ok(TypedPayload::MessageRevision {
            items: open_items(items, env_depth + 2, shared, &format!("{path}.1"))?,
            unknown,
        }),
        Draft::Container { items, unknown } => Ok(TypedPayload::ContainerItem {
            items: open_items(items, env_depth + 2, shared, &format!("{path}.0"))?,
            unknown,
        }),
        Draft::Text { text, unknown } => Ok(TypedPayload::TextItem { text, unknown }),
    }
}

fn resolve_prior_view(ctx: &ValidationContext) -> Result<Option<PriorView>, Error> {
    match &ctx.prior {
        PriorStatement::Absent => Err(Error::Context(ContextError(
            "a type-2 root under `typed` needs priorDirectoryStatementFrame (null for bootstrap)"
                .to_string(),
        ))),
        PriorStatement::None => Ok(None),
        PriorStatement::Frame(bytes) => {
            let nested = ValidationContext {
                operation: Operation::Typed,
                route_byte_limit: MAX_FRAME_BYTES as u64,
                reader_version: ctx.reader_version,
                supported_schemas: ctx.supported_schemas.clone(),
                opaque_retention_allowed: false,
                prior: PriorStatement::None,
            };
            match validate_frame(bytes, &nested) {
                Err(Error::Codec(error)) => Err(Error::Context(ContextError(format!(
                    "the prior directory statement is invalid: {error}"
                )))),
                Err(error) => Err(error),
                Ok(ValidationResult::Parsed(parsed)) => match parsed.typed.as_deref() {
                    Some(TypedPayload::DirectoryStatement {
                        network,
                        subject,
                        revision,
                        recovery,
                        schema_version,
                        ..
                    }) => Ok(Some(PriorView {
                        network: network.clone(),
                        subject: subject.clone(),
                        revision: *revision,
                        schema_version: *schema_version,
                        recovery: recovery.clone().unwrap_or_default(),
                    })),
                    _ => Err(Error::Context(ContextError(
                        "the prior directory statement is not a type-4 frame".to_string(),
                    ))),
                },
                Ok(_) => Err(Error::Context(ContextError(
                    "the prior directory statement is not a type-4 frame".to_string(),
                ))),
            }
        }
    }
}

/// Runs section 9 up to `ctx.operation`.
///
/// The returned frames own a copy of the input bytes. A failure returns no
/// partial typed value. No protobuf, JSON, or BCS fallback is attempted (F5).
pub fn validate_frame(bytes: &[u8], ctx: &ValidationContext) -> Result<ValidationResult, Error> {
    if ctx.route_byte_limit < 1 {
        return Err(Error::Context(ContextError(
            "routeByteLimit must be a positive integer".to_string(),
        )));
    }
    if bytes.len() as u64 > ctx.route_byte_limit || bytes.len() > MAX_FRAME_BYTES {
        return Err(Error::Codec(fail(
            ErrorCategory::Resource,
            ErrorStage::S1,
            format!("frame length {} exceeds a root limit", bytes.len()),
            "root",
        )));
    }
    let mut supported = HashMap::new();
    for schema in &ctx.supported_schemas {
        supported.insert(schema.type_id, schema.schema_version);
    }
    let mut shared = Shared {
        ctx,
        supported,
        counters: Counters::default(),
        items_opened: 0,
        context_error: None,
    };
    let result = process_frame(
        bytes.to_vec(),
        Mode::Root,
        0,
        &mut shared,
        "root",
        ctx.operation,
    );
    if let Some(context) = shared.context_error {
        return Err(Error::Context(context));
    }
    result.map_err(Error::Codec)
}
