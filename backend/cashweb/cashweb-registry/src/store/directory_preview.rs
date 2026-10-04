//! Private RocksDB owner for preview admission. The public handle has no trusted-record setter.
use std::{
    marker::PhantomData,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use rocksdb::{Direction, IteratorMode, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};

use super::db::Db;
use super::directory_preview_owner::{
    Store, CF_DIRECTORY_PREVIEW_ENROLLMENT_V1, CF_DIRECTORY_PREVIEW_EVIDENCE_V1,
    CF_DIRECTORY_PREVIEW_HEAD_V1,
};
use crate::directory_admission::{
    policy::{self, History, Record, Transition},
    *,
};

const VERSION: u32 = 1;
type Result<T> = std::result::Result<T, AdmissionError>;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Marker {
    version: u32,
    anchor: [u8; 32],
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u32,
    identity: [u8; 32],
    anchor: [u8; 32],
    sequence: u64,
    accepted: usize,
    retained: usize,
    charged: usize,
    forked: bool,
    checked: (i64, u32),
    head: Option<[u8; 32]>,
    revision: Option<u64>,
    generations: Option<[u64; 2]>,
    current_stamp: Option<Vec<u8>>,
    previous_stamp: Option<Vec<u8>>,
    // Commits to exact stable wrappers and their identities, not merely projected fields.
    evidence_digest: [u8; 32],
}

#[derive(Debug)]
struct State {
    history: History,
    // A single bounded fork proof: zero or more private staged links followed by its competitor.
    // These records never become accepted history or fresh output.
    proof: Vec<Record>,
    checked: Timestamp,
    sequence: u64,
}

impl State {
    fn records(&self) -> impl Iterator<Item = &Record> {
        self.history.records.iter().chain(&self.proof)
    }
    fn metadata(&self, anchor: &Anchor) -> Metadata {
        let mut charged = 0;
        for r in self.records() {
            charged += r.charge();
        }
        let h = self.history.records.last();
        Metadata {
            version: VERSION,
            identity: policy::identity(anchor),
            anchor: anchor.revision_zero,
            sequence: self.sequence,
            accepted: self.history.records.len(),
            retained: self.history.records.len() + self.proof.len(),
            charged,
            forked: !self.proof.is_empty(),
            checked: (self.checked.seconds, self.checked.nanoseconds),
            head: h.map(|r| r.evidence.hash),
            revision: h.map(|r| r.revision),
            generations: h.map(|r| r.generations),
            current_stamp: h.map(|r| r.stamp.key_bytes.clone()),
            previous_stamp: self.history.previous.as_ref().map(|p| p.key_bytes.clone()),
            evidence_digest: policy::evidence_digest(self.records()),
        }
    }

    fn verifies_checkpoint(&self, anchor: &Anchor, expected: Checkpoint) -> bool {
        let actual = self.metadata(anchor);
        let common = expected.identity == actual.identity
            && expected.anchor == actual.anchor
            && expected.retained > 0
            && expected.accepted <= expected.retained
            && expected.retained <= actual.retained
            && expected.checked_time.1 < 1_000_000_000
            && expected.checked_time <= actual.checked
            && policy::evidence_digest(self.records().take(expected.retained))
                == expected.evidence_digest;
        if !common {
            return false;
        }
        match expected.kind {
            CheckpointKind::ProspectiveEnrollment => {
                // This expectation never asserted an accepted head. Initial quarantine may
                // retain its exact anchor only as proof; load() has authenticated the full fork.
                expected.accepted == 1
                    && expected.retained == 1
                    && !expected.forked
                    && expected.head == Some(anchor.revision_zero)
                    && self
                        .records()
                        .next()
                        .is_some_and(|r| r.evidence.hash == anchor.revision_zero)
                    && (actual.accepted > 0 || actual.forked)
            }
            CheckpointKind::CommittedPrefix => {
                expected.accepted <= actual.accepted
                    && expected.head
                        == expected
                            .accepted
                            .checked_sub(1)
                            .and_then(|i| self.history.records.get(i))
                            .map(|r| r.evidence.hash)
                    && if expected.forked {
                        actual.forked
                            && expected.accepted == actual.accepted
                            && expected.retained == actual.retained
                    } else {
                        expected.accepted > 0 && expected.retained == expected.accepted
                    }
            }
        }
    }
}

impl Metadata {
    fn bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|_| AdmissionError::Unavailable)
    }
    fn status(&self) -> Result<Status> {
        Ok(Status {
            checkpoint: Checkpoint {
                kind: CheckpointKind::CommittedPrefix,
                identity: self.identity,
                anchor: self.anchor,
                head: self.head,
                accepted: self.accepted,
                retained: self.retained,
                evidence_digest: self.evidence_digest,
                checked_time: self.checked,
                forked: self.forked,
            },
            head: self.head,
            revision: self.revision,
            generations: self.generations,
            current_stamp: self.current_stamp.as_ref().map(|key_bytes| AccountRef {
                key_type: 1,
                key_bytes: key_bytes.clone(),
            }),
            previous_stamp: self.previous_stamp.as_ref().map(|key_bytes| AccountRef {
                key_type: 1,
                key_bytes: key_bytes.clone(),
            }),
            accepted: self.accepted,
            retained: self.retained,
            charged_bytes: self.charged,
            forked: self.forked,
            checked_time: Timestamp {
                seconds: self.checked.0,
                nanoseconds: self.checked.1,
            },
        })
    }
}

/// An explicitly opened subject, borrowing the registry lifetime and sharing its isolated sidecar.
/// Every operation reloads and authenticates bounded durable evidence under one directory lock.
/// Storage failures disable this handle; use a verified reopen with external continuity.
#[derive(Debug)]
pub struct Directory<'a> {
    db: Arc<Store>,
    registry_owner: PhantomData<&'a Db>,
    anchor: Anchor,
    key: Vec<u8>,
    enrolled: AtomicBool,
    unavailable: AtomicBool,
    #[cfg(test)]
    commit_hook: Option<fn(bool) -> Result<()>>,
}

impl<'a> Directory<'a> {
    pub(crate) fn open(db: &'a Db, anchor: Anchor, mode: OpenMode) -> Result<Self> {
        policy::validate_anchor(&anchor)?;
        let mut key = vec![anchor.network.len() as u8];
        key.extend_from_slice(anchor.network.as_bytes());
        key.extend_from_slice(&anchor.subject.key_bytes);
        let directory = Self {
            db: db.open_directory_preview(mode)?,
            registry_owner: PhantomData,
            anchor,
            key,
            enrolled: AtomicBool::new(matches!(mode, OpenMode::Reopen(_))),
            unavailable: AtomicBool::new(false),
            #[cfg(test)]
            commit_hook: None,
        };
        let _guard = directory
            .db
            .lock_directory_preview()
            .map_err(|_| AdmissionError::Unavailable)?;
        let meta = directory.header()?;
        match mode {
            OpenMode::NewEnrollment => {
                if meta.is_some() {
                    return Err(AdmissionError::AlreadyEnrolled);
                }
                directory.load(None)?; // Also refuses orphan evidence without a marker/head.
            }
            OpenMode::Reopen(expected) => {
                let state = directory
                    .load(meta.as_ref())?
                    .ok_or(AdmissionError::Unavailable)?;
                if !state.verifies_checkpoint(&directory.anchor, expected) {
                    return Err(AdmissionError::Continuity);
                }
            }
        }
        drop(_guard);
        Ok(directory)
    }

    fn ensure_available(&self) -> Result<()> {
        if self.unavailable.load(Ordering::Acquire) {
            Err(AdmissionError::Unavailable)
        } else {
            Ok(())
        }
    }
    fn storage<T>(&self, result: Result<T>) -> Result<T> {
        if matches!(result, Err(AdmissionError::Unavailable)) {
            self.unavailable.store(true, Ordering::Release);
        }
        result
    }
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let cf = self.db.cf(name).map_err(|_| AdmissionError::Unavailable)?;
        self.db
            .get(cf, &self.key)
            .map(|v| v.map(|b| b.to_vec()))
            .map_err(|_| AdmissionError::Unavailable)
    }
    fn header(&self) -> Result<Option<Metadata>> {
        self.ensure_available()?;
        let marker = self.get(CF_DIRECTORY_PREVIEW_ENROLLMENT_V1)?;
        let meta = self.get(CF_DIRECTORY_PREVIEW_HEAD_V1)?;
        match (marker, meta) {
            (None, None) if !self.enrolled.load(Ordering::Acquire) => Ok(None),
            (Some(marker), Some(meta)) if marker.len() <= 1024 && meta.len() <= 4096 => {
                let marker: Marker =
                    serde_json::from_slice(&marker).map_err(|_| AdmissionError::Unavailable)?;
                let meta: Metadata =
                    serde_json::from_slice(&meta).map_err(|_| AdmissionError::Unavailable)?;
                if marker
                    != (Marker {
                        version: VERSION,
                        anchor: self.anchor.revision_zero,
                    })
                    || meta.version != VERSION
                    || meta.anchor != self.anchor.revision_zero
                    || meta.accepted > meta.retained
                    || meta.retained == 0
                    || meta.checked.1 >= 1_000_000_000
                    || (!meta.forked && meta.accepted != meta.retained)
                    || (meta.forked && meta.accepted == meta.retained)
                    || policy::budget(meta.retained, meta.charged, 0, 0).is_err()
                {
                    return Err(AdmissionError::Unavailable);
                }
                self.enrolled.store(true, Ordering::Release);
                Ok(Some(meta))
            }
            _ => Err(AdmissionError::Unavailable),
        }
    }

    fn record_key(&self, index: usize, r: &Record) -> Vec<u8> {
        let mut key = self.key.clone();
        key.extend_from_slice(&(index as u32).to_be_bytes());
        key.extend_from_slice(&r.revision.to_be_bytes());
        key.extend_from_slice(&r.evidence.hash);
        key
    }

    fn load(&self, meta: Option<&Metadata>) -> Result<Option<State>> {
        let cf = self
            .db
            .cf(CF_DIRECTORY_PREVIEW_EVIDENCE_V1)
            .map_err(|_| AdmissionError::Unavailable)?;
        // Bound raw retained bytes/count before doing signature work, including unexpected rows.
        let mut rows = Vec::new();
        let mut bytes = 0usize;
        for row in self
            .db
            .rocksdb()
            .iterator_cf(cf, IteratorMode::From(&self.key, Direction::Forward))
        {
            let (key, value) = row.map_err(|_| AdmissionError::Unavailable)?;
            if !key.starts_with(&self.key) {
                break;
            }
            if rows.len() >= MAX_STATEMENTS
                || key.len() != self.key.len() + 44
                || value.len() > MAX_FRAME_BYTES
            {
                return Err(AdmissionError::Unavailable);
            }
            bytes = bytes
                .checked_add(value.len())
                .ok_or(AdmissionError::Unavailable)?;
            if bytes > MAX_CHARGED_BYTES {
                return Err(AdmissionError::Unavailable);
            }
            rows.push((key, value));
        }
        let Some(meta) = meta else {
            return if rows.is_empty() {
                Ok(None)
            } else {
                Err(AdmissionError::Unavailable)
            };
        };
        if rows.len() != meta.retained {
            return Err(AdmissionError::Unavailable);
        }
        // Validate the exact cumulative charge of every raw retained row before any curve work.
        for (_, value) in &rows {
            bytes = bytes
                .checked_add(
                    policy::statement_bytes(value)
                        .map_err(|_| AdmissionError::Unavailable)?
                        .len(),
                )
                .ok_or(AdmissionError::Unavailable)?;
            if bytes > MAX_CHARGED_BYTES {
                return Err(AdmissionError::Unavailable);
            }
        }
        if bytes != meta.charged {
            return Err(AdmissionError::Unavailable);
        }
        let mut staged = History::default();
        let mut state = State {
            history: History::default(),
            proof: Vec::new(),
            checked: Timestamp {
                seconds: meta.checked.0,
                nanoseconds: meta.checked.1,
            },
            sequence: meta.sequence,
        };
        for (i, (key, value)) in rows.iter().enumerate() {
            let r = policy::authenticate(&self.anchor, value)
                .map_err(|_| AdmissionError::Unavailable)?;
            if **key != self.record_key(i, &r)
                || policy::nanos(r.issued) > policy::nanos(state.checked)
            {
                return Err(AdmissionError::Unavailable);
            }
            let transition = staged
                .classify(&self.anchor, &r)
                .map_err(|_| AdmissionError::Unavailable)?;
            let final_fork = meta.forked && i + 1 == rows.len();
            if transition
                != if final_fork {
                    Transition::Fork
                } else {
                    Transition::Append
                }
            {
                return Err(AdmissionError::Unavailable);
            }
            if !final_fork {
                staged.append(r.clone());
            }
            if i < meta.accepted {
                state.history.append(r);
            } else {
                state.proof.push(r);
            }
        }
        if state.metadata(&self.anchor) != *meta {
            return Err(AdmissionError::Unavailable);
        }
        Ok(Some(state))
    }

    fn commit(&self, state: &mut State, prior: Option<&Metadata>) -> Result<Metadata> {
        let mut meta = state.metadata(&self.anchor);
        if prior == Some(&meta) {
            return Ok(meta);
        }
        state.sequence = state
            .sequence
            .checked_add(1)
            .ok_or(AdmissionError::Unavailable)?;
        meta = state.metadata(&self.anchor);
        policy::budget(meta.retained, meta.charged, 0, 0)?;
        let mut batch = WriteBatch::default();
        let cf_evidence = self
            .db
            .cf(CF_DIRECTORY_PREVIEW_EVIDENCE_V1)
            .map_err(|_| AdmissionError::Unavailable)?;
        for (i, r) in state
            .records()
            .enumerate()
            .skip(prior.map_or(0, |m| m.retained))
        {
            batch.put_cf(cf_evidence, self.record_key(i, r), &r.evidence.attestation);
        }
        batch.put_cf(
            self.db
                .cf(CF_DIRECTORY_PREVIEW_ENROLLMENT_V1)
                .map_err(|_| AdmissionError::Unavailable)?,
            &self.key,
            serde_json::to_vec(&Marker {
                version: VERSION,
                anchor: self.anchor.revision_zero,
            })
            .map_err(|_| AdmissionError::Unavailable)?,
        );
        batch.put_cf(
            self.db
                .cf(CF_DIRECTORY_PREVIEW_HEAD_V1)
                .map_err(|_| AdmissionError::Unavailable)?,
            &self.key,
            meta.bytes()?,
        );
        let mut options = WriteOptions::default();
        options.set_sync(true);
        #[cfg(test)]
        if let Some(hook) = self.commit_hook {
            hook(false)?;
        }
        self.db
            .rocksdb()
            .write_opt(batch, &options)
            .map_err(|_| AdmissionError::Unavailable)?;
        self.enrolled.store(true, Ordering::Release);
        #[cfg(test)]
        if let Some(hook) = self.commit_hook {
            hook(true)?;
        }
        Ok(meta)
    }

    /// Atomically enroll or catch up through a fresh terminal head. Expired intermediate links
    /// stay private; a failed terminal check cannot advance the durable head or stamp pair.
    /// A verified competing child is the sole rejection that durably retains a fork proof.
    pub fn advance(&self, candidates: &[Candidate<'_>], context: Context<'_>) -> Result<Current> {
        self.advance_with(candidates, context.now, BindingPolicy::Exact(context.relay))
    }

    /// As [`Self::advance`], for a relay's routing table: the head may name any relay.
    pub fn advance_declared(
        &self,
        candidates: &[Candidate<'_>],
        now: Option<Timestamp>,
    ) -> Result<Current> {
        self.advance_with(candidates, now, BindingPolicy::Declared)
    }

    /// As [`Self::current`], for a relay's routing table: the head may name any relay.
    pub fn current_declared(&self, now: Option<Timestamp>) -> Result<Current> {
        self.advance_with(&[], now, BindingPolicy::Declared)
    }

    fn advance_with(
        &self,
        candidates: &[Candidate<'_>],
        now: Option<Timestamp>,
        binding: BindingPolicy<'_>,
    ) -> Result<Current> {
        self.ensure_available()?;
        let _guard = self
            .db
            .lock_directory_preview()
            .map_err(|_| AdmissionError::Unavailable)?;
        let meta = self.storage(self.header())?;
        policy::preflight(
            meta.as_ref().map_or(0, |m| m.retained),
            meta.as_ref().map_or(0, |m| m.charged),
            candidates,
        )?;
        for c in candidates {
            if policy::statement_bytes(c.attestation)? != c.statement {
                return Err(AdmissionError::Evidence);
            }
        }
        let loaded = self.storage(self.load(meta.as_ref()))?;
        let now = policy::clock(now, loaded.as_ref().map(|s| s.checked))?;
        // Missing trust input never poisons a subject, including with a valid signed competitor.
        if matches!(binding, BindingPolicy::Exact(None)) {
            return Err(AdmissionError::Binding);
        }
        let mut state = loaded.unwrap_or(State {
            history: History::default(),
            proof: Vec::new(),
            checked: now,
            sequence: 0,
        });
        if !state.proof.is_empty() {
            return Err(AdmissionError::Fork);
        }
        // Authenticate the entire candidate batch before mutating even the staged history.
        let mut incoming = Vec::with_capacity(candidates.len());
        for c in candidates {
            let r = policy::authenticate(&self.anchor, c.attestation)?;
            if r.evidence.statement != c.statement {
                return Err(AdmissionError::Evidence);
            }
            if policy::nanos(r.issued) > policy::nanos(now) {
                return Err(AdmissionError::Validity);
            }
            incoming.push(r);
        }
        let accepted = state.history.records.len();
        for r in incoming {
            match state.history.classify(&self.anchor, &r)? {
                Transition::Duplicate => (),
                Transition::Append => state.history.append(r),
                Transition::Fork => {
                    let mut proof = state.history.records.split_off(accepted);
                    proof.push(r);
                    // Rebuild only the original accepted pair; no staged rotation may escape.
                    let original = std::mem::take(&mut state.history.records);
                    state.history = History::default();
                    for old in original {
                        state.history.append(old);
                    }
                    state.proof = proof;
                    state.checked = now;
                    self.storage(self.commit(&mut state, meta.as_ref()))?;
                    return Err(AdmissionError::Fork);
                }
            }
        }
        state.history.head()?.fresh(now, binding)?;
        state.checked = now;
        let committed = self.storage(self.commit(&mut state, meta.as_ref()))?;
        Self::current_result(&state, committed.status()?)
    }

    /// Validate supplied current trust for staging without changing durable state.
    ///
    /// Success is only a point-in-time validation, not a fresh authority token or a
    /// committed checkpoint. Serving still requires `current` or `advance` with fresh
    /// inputs. This uses the same retained-evidence, clock, quarantine and head policy.
    pub fn check_current(&self, context: Context<'_>) -> Result<()> {
        self.ensure_available()?;
        let _guard = self
            .db
            .lock_directory_preview()
            .map_err(|_| AdmissionError::Unavailable)?;
        let meta = self.storage(self.header())?;
        policy::preflight(
            meta.as_ref().map_or(0, |m| m.retained),
            meta.as_ref().map_or(0, |m| m.charged),
            &[],
        )?;
        let loaded = self.storage(self.load(meta.as_ref()))?;
        let now = policy::clock(context.now, loaded.as_ref().map(|s| s.checked))?;
        if context.relay.is_none() {
            return Err(AdmissionError::Binding);
        }
        let state = loaded.ok_or(AdmissionError::Unenrolled)?;
        if !state.proof.is_empty() {
            return Err(AdmissionError::Fork);
        }
        state
            .history
            .head()?
            .fresh(now, BindingPolicy::Exact(context.relay))
    }

    /// Recheck the durable head against freshly supplied trust inputs; successful checked-time
    /// advancement is synchronous and durable before returning. An empty batch cannot revive expiry.
    pub fn current(&self, context: Context<'_>) -> Result<Current> {
        self.advance(&[], context)
    }

    fn current_result(state: &State, status: Status) -> Result<Current> {
        let h = state.history.head()?;
        Ok(Current {
            evidence: h.evidence.clone(),
            message_key: h.message.clone(),
            stamp_key: h.stamp.clone(),
            previous_stamp: state.history.previous.clone(),
            relay: h.relay.clone(),
            revision: h.revision,
            generations: h.generations,
            status,
        })
    }

    /// Exact accepted historical evidence, including when expired or quarantined. No fresh use.
    /// Proof-only fork rows are exposed only as status/quarantine, never accepted history.
    pub fn historical_evidence(&self, hash: [u8; 32]) -> Result<Option<HistoricalEvidence>> {
        self.ensure_available()?;
        let _guard = self
            .db
            .lock_directory_preview()
            .map_err(|_| AdmissionError::Unavailable)?;
        let meta = self.storage(self.header())?;
        let state = self
            .storage(self.load(meta.as_ref()))?
            .ok_or(AdmissionError::Unenrolled)?;
        Ok(state
            .history
            .records
            .iter()
            .find(|r| r.evidence.hash == hash)
            .map(|r| r.evidence.clone()))
    }

    /// Validate and describe durable state without granting freshness. `None` means unenrolled.
    pub fn status(&self) -> Result<Option<Status>> {
        self.ensure_available()?;
        let _guard = self
            .db
            .lock_directory_preview()
            .map_err(|_| AdmissionError::Unavailable)?;
        let meta = self.storage(self.header())?;
        self.storage(self.load(meta.as_ref()))?
            .map(|s| s.metadata(&self.anchor).status())
            .transpose()
    }

    /// Every retained record in stored order: the accepted chain, then any fork proof. This is
    /// what one relay hands another; the receiver verifies each record itself.
    pub fn retained(&self) -> Result<Vec<HistoricalEvidence>> {
        self.ensure_available()?;
        let _guard = self
            .db
            .lock_directory_preview()
            .map_err(|_| AdmissionError::Unavailable)?;
        let meta = self.storage(self.header())?;
        let state = self
            .storage(self.load(meta.as_ref()))?
            .ok_or(AdmissionError::Unenrolled)?;
        Ok(state.records().map(|r| r.evidence.clone()).collect())
    }

    /// Bounded exact fork proof for external investigation. These are not accepted history.
    pub fn conflict_evidence(&self) -> Result<Vec<HistoricalEvidence>> {
        self.ensure_available()?;
        let _guard = self
            .db
            .lock_directory_preview()
            .map_err(|_| AdmissionError::Unavailable)?;
        let meta = self.storage(self.header())?;
        let state = self
            .storage(self.load(meta.as_ref()))?
            .ok_or(AdmissionError::Unenrolled)?;
        Ok(state.proof.into_iter().map(|r| r.evidence).collect())
    }
}

#[cfg(test)]
#[path = "../directory_admission/storage_tests.rs"]
mod tests;
