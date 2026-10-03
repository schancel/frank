//! Private policy over authenticated evidence. Persistence never accepts caller projections.
use super::*;
use frank_cbor::{
    preview_directory_context, validate_frame, verify_preview_directory_evidence, CborValue,
    Operation, TypedPayload, ValidationResult,
};
use sha2::{Digest, Sha256};

pub(crate) fn identity(anchor: &Anchor) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update([anchor.network.len() as u8]);
    digest.update(anchor.network.as_bytes());
    digest.update(&anchor.subject.key_bytes);
    digest.finalize().into()
}

pub(crate) fn evidence_digest<'a>(records: impl Iterator<Item = &'a Record>) -> [u8; 32] {
    let mut digest = Sha256::new();
    for r in records {
        digest.update(r.revision.to_be_bytes());
        digest.update(r.evidence.hash);
        digest.update((r.evidence.attestation.len() as u64).to_be_bytes());
        digest.update(&r.evidence.attestation);
    }
    digest.finalize().into()
}

#[derive(Clone, Debug)]
pub(crate) struct Record {
    pub evidence: HistoricalEvidence,
    pub schema: u32,
    pub revision: u64,
    pub issued: Timestamp,
    pub expiry: Timestamp,
    pub relay: RelayBinding,
    pub message: AccountRef,
    pub stamp: AccountRef,
    pub generations: [u64; 2],
    pub predecessor: Option<[u8; 32]>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct History {
    pub records: Vec<Record>,
    pub previous: Option<AccountRef>,
}

pub(crate) fn nanos(t: Timestamp) -> i128 {
    i128::from(t.seconds) * 1_000_000_000 + i128::from(t.nanoseconds)
}

pub(crate) fn counter_follows(previous: u64, next: u64, changed: bool) -> bool {
    (if changed {
        previous.checked_add(1)
    } else {
        Some(previous)
    }) == Some(next)
}

pub(crate) fn clock(
    now: Option<Timestamp>,
    prior: Option<Timestamp>,
) -> Result<Timestamp, AdmissionError> {
    let now = now
        .filter(|t| t.nanoseconds < 1_000_000_000)
        .ok_or(AdmissionError::Clock)?;
    if prior.is_some_and(|p| nanos(p) > nanos(now)) {
        return Err(AdmissionError::Clock);
    }
    Ok(now)
}

pub(crate) fn validate_anchor(anchor: &Anchor) -> Result<(), AdmissionError> {
    let n = &anchor.network;
    if n.is_empty()
        || n.len() > 64
        || !n.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && matches!(b, b'.' | b'_' | b'-'))
        })
        || anchor.subject.key_type != 1
        || anchor.subject.key_bytes.len() != 33
        || !matches!(anchor.subject.key_bytes[0], 2 | 3)
        || secp256k1_abc::PublicKey::from_slice(&anchor.subject.key_bytes).is_err()
    {
        return Err(AdmissionError::Anchor);
    }
    Ok(())
}

pub(crate) fn budget(
    count: usize,
    bytes: usize,
    incoming_count: usize,
    incoming_bytes: usize,
) -> Result<(), AdmissionError> {
    if count
        .checked_add(incoming_count)
        .is_none_or(|n| n > MAX_STATEMENTS)
        || bytes
            .checked_add(incoming_bytes)
            .is_none_or(|n| n > MAX_CHARGED_BYTES)
    {
        return Err(AdmissionError::Resource);
    }
    Ok(())
}

pub(crate) fn preflight(
    count: usize,
    bytes: usize,
    candidates: &[Candidate<'_>],
) -> Result<(), AdmissionError> {
    // No allocation, CBOR decoding or curve operation before the whole input is metered.
    let mut incoming = 0usize;
    budget(count, bytes, candidates.len(), 0)?;
    for c in candidates {
        if c.statement.len() > MAX_FRAME_BYTES || c.attestation.len() > MAX_FRAME_BYTES {
            return Err(AdmissionError::Resource);
        }
        incoming = incoming
            .checked_add(c.statement.len())
            .and_then(|n| n.checked_add(c.attestation.len()))
            .ok_or(AdmissionError::Resource)?;
    }
    budget(count, bytes, candidates.len(), incoming)
}

pub(crate) fn authenticate(anchor: &Anchor, wrapper: &[u8]) -> Result<Record, AdmissionError> {
    let signed = verify_preview_directory_evidence(wrapper, &anchor.network)
        .map_err(|_| AdmissionError::Evidence)?;
    let frame = signed.statement_frame();
    let Some(TypedPayload::DirectoryStatement {
        subject,
        revision,
        timestamp,
        expiry: Some(expiry),
        relays,
        stamp_key: Some(stamp),
        preview: Some(roles),
        ..
    }) = frame.typed.as_deref()
    else {
        return Err(AdmissionError::Evidence);
    };
    if subject != &anchor.subject {
        return Err(AdmissionError::Anchor);
    }
    Ok(Record {
        evidence: HistoricalEvidence {
            statement: frame.frame.clone(),
            attestation: wrapper.to_vec(),
            hash: signed.statement_hash,
        },
        schema: frame.schema_version,
        revision: *revision,
        issued: *timestamp,
        expiry: *expiry,
        relay: relays[0].clone(),
        message: roles.message_dh_key.clone(),
        stamp: stamp.clone(),
        generations: [roles.mailbox_key_generation, roles.stamp_key_generation],
        predecessor: roles
            .predecessor
            .as_deref()
            .map(|b| b.try_into().map_err(|_| AdmissionError::Evidence))
            .transpose()?,
    })
}

/// Cheap bounded generic-envelope pass using the existing codec; it does not open the type-4
/// child or validate any curve point/signature. This makes supplied byte lengths trustworthy
/// before costly typed decoding, retained-history verification, or candidate authentication.
pub(crate) fn statement_bytes(wrapper: &[u8]) -> Result<Vec<u8>, AdmissionError> {
    let mut context = preview_directory_context();
    context.operation = Operation::Generic;
    context.route_byte_limit = MAX_FRAME_BYTES as u64;
    let ValidationResult::Parsed(p) =
        validate_frame(wrapper, &context).map_err(|_| AdmissionError::Evidence)?
    else {
        return Err(AdmissionError::Evidence);
    };
    if p.type_id != 2 {
        return Err(AdmissionError::Evidence);
    }
    let CborValue::Map(fields) = p.payload else {
        return Err(AdmissionError::Evidence);
    };
    match fields.into_iter().find(|(key, _)| *key == 0) {
        Some((_, CborValue::Bytes(bytes))) if bytes.len() <= MAX_FRAME_BYTES => Ok(bytes),
        _ => Err(AdmissionError::Evidence),
    }
}

impl Record {
    pub(crate) fn charge(&self) -> usize {
        self.evidence.statement.len() + self.evidence.attestation.len()
    }
    pub(crate) fn fresh(
        &self,
        now: Timestamp,
        relay: Option<&RelayBinding>,
    ) -> Result<(), AdmissionError> {
        if nanos(self.issued) > nanos(now) || nanos(now) >= nanos(self.expiry) {
            return Err(AdmissionError::Validity);
        }
        if relay != Some(&self.relay) {
            return Err(AdmissionError::Binding);
        }
        Ok(())
    }
}

impl History {
    pub(crate) fn head(&self) -> Result<&Record, AdmissionError> {
        self.records.last().ok_or(AdmissionError::Unenrolled)
    }
    pub(crate) fn append(&mut self, r: Record) {
        if let Some(old) = self.records.last() {
            if old.stamp != r.stamp {
                self.previous = Some(old.stamp.clone());
            }
        }
        self.records.push(r);
    }
    pub(crate) fn bootstrap(anchor: &Anchor, r: &Record) -> Result<(), AdmissionError> {
        if r.revision != 0
            || r.evidence.hash != anchor.revision_zero
            || r.generations != [0, 0]
            || r.predecessor.is_some()
        {
            return Err(AdmissionError::Anchor);
        }
        Ok(())
    }
    /// Check a candidate's complete ancestry and role transition before calling it a fork.
    fn successor(
        &self,
        anchor: &Anchor,
        parent_index: usize,
        r: &Record,
    ) -> Result<(), AdmissionError> {
        let p = &self.records[parent_index];
        if !counter_follows(p.revision, r.revision, true) || r.predecessor != Some(p.evidence.hash)
        {
            return Err(AdmissionError::Link);
        }
        if r.schema < p.schema || nanos(r.issued) < nanos(p.issued) {
            return Err(AdmissionError::Order);
        }
        for (index, (key, old)) in [(&r.message, &p.message), (&r.stamp, &p.stamp)]
            .iter()
            .enumerate()
        {
            let changed = key != old;
            if !counter_follows(p.generations[index], r.generations[index], changed) {
                return Err(AdmissionError::Generation);
            }
            if changed
                && (key.key_bytes[1..] == anchor.subject.key_bytes[1..]
                    || self.records[..=parent_index].iter().any(|h| {
                        [&h.message, &h.stamp]
                            .iter()
                            .any(|k| k.key_bytes[1..] == key.key_bytes[1..])
                    }))
            {
                return Err(AdmissionError::KeyReuse);
            }
        }
        Ok(())
    }
    /// Return duplicate, successor or fully verified conflict. No mutation on rejection.
    pub(crate) fn classify(
        &self,
        anchor: &Anchor,
        r: &Record,
    ) -> Result<Transition, AdmissionError> {
        let Some(head) = self.records.last() else {
            Self::bootstrap(anchor, r)?;
            return Ok(Transition::Append);
        };
        if head.evidence.statement == r.evidence.statement {
            return Ok(Transition::Duplicate);
        }
        if self
            .records
            .iter()
            .any(|h| h.evidence.statement == r.evidence.statement)
        {
            return Err(AdmissionError::Rollback);
        }
        // A different revision-zero record is not the installed anchor.
        if r.revision == 0 {
            return Err(AdmissionError::Anchor);
        }
        let parent = self
            .records
            .iter()
            .position(|p| Some(p.evidence.hash) == r.predecessor)
            .ok_or(AdmissionError::Link)?;
        self.successor(anchor, parent, r)?;
        if parent + 1 < self.records.len() {
            return Ok(Transition::Fork);
        }
        Ok(Transition::Append)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Transition {
    Duplicate,
    Append,
    Fork,
}
