//! Preview admission over the directory's transaction store. The public handle has no
//! trusted-record setter.
//!
//! Each operation reads one subject's marker, head metadata and evidence rows in one read
//! transaction, authenticates them outside it, decides, and then commits in a second
//! transaction that first checks the marker and metadata are exactly the bytes it read: a
//! compare-and-set on the previous checkpoint. Every commit increments the metadata's sequence,
//! so equal bytes mean nobody committed in between. When another writer (another replica, or
//! another handle in this process) did commit, the whole operation is decided again against the
//! new state, so concurrent advances serialize exactly as they did under the old process mutex.
use std::{
    marker::PhantomData,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};

use super::db::Db;
use super::directory_store::{DirectoryStore, Stored};
use crate::directory_admission::{
    policy::{self, History, Record, Transition},
    *,
};
use crate::store::{
    kv_store::{KvError, KvTransaction, Transact},
    large_values::{LargeValueError, Staged, INLINE_LIMIT},
};

const VERSION: u32 = 1;
type Result<T> = std::result::Result<T, AdmissionError>;

/// Rounds of read, decide and compare-and-set before a contended subject answers "busy".
const MAX_ROUNDS: usize = 64;
/// Evidence one commit keeps inline. Further new records are staged as large values first, so a
/// commit stays well inside the 10 MB transaction limit.
const INLINE_BUDGET: usize = 6 * 1024 * 1024;
const MARKER: &[u8] = b"p/m/";
const HEAD: &[u8] = b"p/h/";
const EVIDENCE: &[u8] = b"p/e/";
/// Slot, revision and T1 after the subject key.
const RECORD_KEY_TAIL: usize = 4 + 8 + 32;

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

/// What a commit tells the caller's recorder, inside the commit transaction.
pub(crate) struct Commit<'a> {
    /// No metadata existed before this commit: this is the subject's enrollment.
    pub(crate) first: bool,
    /// The state this commit writes.
    pub(crate) status: &'a Status,
}

/// Why a recorder refused a commit.
#[derive(Debug)]
pub(crate) enum RecordError {
    /// A store operation failed; the driver may re-run the transaction.
    Kv(KvError),
    /// The caller's rule refuses this commit (for example a relay-wide subject cap).
    Refused(AdmissionError),
}

impl From<KvError> for RecordError {
    fn from(error: KvError) -> Self {
        Self::Kv(error)
    }
}

/// Extra writes that commit in the same transaction as a subject's evidence and metadata.
pub(crate) type Recorder<'r> =
    &'r dyn Fn(&mut dyn KvTransaction, &Commit<'_>) -> std::result::Result<(), RecordError>;

/// The bytes one read transaction saw for a subject.
struct Raw {
    marker: Option<Vec<u8>>,
    meta: Option<Vec<u8>>,
    rows: Vec<(Vec<u8>, Vec<u8>)>,
}

/// One round's outcome: final, or the state changed underneath and the round must be redone.
enum Round {
    Changed,
    Fail(AdmissionError),
}

impl From<AdmissionError> for Round {
    fn from(error: AdmissionError) -> Self {
        Self::Fail(error)
    }
}

/// Inside the commit transaction.
enum TxError {
    Changed,
    Kv(KvError),
    Large(LargeValueError),
    Refused(AdmissionError),
}

impl From<KvError> for TxError {
    fn from(error: KvError) -> Self {
        Self::Kv(error)
    }
}

impl From<LargeValueError> for TxError {
    fn from(error: LargeValueError) -> Self {
        Self::Large(error)
    }
}

impl From<RecordError> for TxError {
    fn from(error: RecordError) -> Self {
        match error {
            RecordError::Kv(error) => Self::Kv(error),
            RecordError::Refused(error) => Self::Refused(error),
        }
    }
}

/// An explicitly opened subject, borrowing the registry lifetime and sharing its store.
/// Every operation reloads and authenticates bounded durable evidence. Storage failures disable
/// this handle; use a verified reopen with external continuity.
#[derive(Debug)]
pub struct Directory<'a> {
    pub(crate) store: Arc<DirectoryStore>,
    registry_owner: PhantomData<&'a Db>,
    anchor: Anchor,
    key: Vec<u8>,
    enrolled: AtomicBool,
    unavailable: AtomicBool,
    #[cfg(test)]
    commit_hook: Option<fn(bool) -> Result<()>>,
}

/// The subject key: one length byte, the network, the compressed point.
pub(crate) fn subject_key(network: &str, point: &[u8]) -> Vec<u8> {
    let mut key = vec![network.len() as u8];
    key.extend_from_slice(network.as_bytes());
    key.extend_from_slice(point);
    key
}

impl<'a> Directory<'a> {
    pub(crate) fn open(db: &'a Db, anchor: Anchor, mode: OpenMode) -> Result<Self> {
        policy::validate_anchor(&anchor)?;
        let key = subject_key(&anchor.network, &anchor.subject.key_bytes);
        let store = db
            .directory_store(matches!(mode, OpenMode::NewEnrollment))
            .map_err(|_| AdmissionError::Unavailable)?;
        let directory = Self {
            store,
            registry_owner: PhantomData,
            anchor,
            key,
            enrolled: AtomicBool::new(matches!(mode, OpenMode::Reopen(_))),
            unavailable: AtomicBool::new(false),
            #[cfg(test)]
            commit_hook: None,
        };
        let raw = directory.read()?;
        let meta = directory.header(&raw)?;
        match mode {
            OpenMode::NewEnrollment => {
                if meta.is_some() {
                    return Err(AdmissionError::AlreadyEnrolled);
                }
                directory.load(None, &raw)?; // Also refuses orphan evidence without a marker/head.
            }
            OpenMode::Reopen(expected) => {
                let state = directory
                    .load(meta.as_ref(), &raw)?
                    .ok_or(AdmissionError::Unavailable)?;
                if !state.verifies_checkpoint(&directory.anchor, expected) {
                    return Err(AdmissionError::Continuity);
                }
            }
        }
        Ok(directory)
    }

    pub(crate) fn marker_key(&self) -> Vec<u8> {
        [MARKER, &self.key].concat()
    }
    pub(crate) fn head_key(&self) -> Vec<u8> {
        [HEAD, &self.key].concat()
    }
    pub(crate) fn evidence_prefix(&self) -> Vec<u8> {
        [EVIDENCE, &self.key].concat()
    }

    fn ensure_available(&self) -> Result<()> {
        if self.unavailable.load(Ordering::Acquire) {
            Err(AdmissionError::Unavailable)
        } else {
            Ok(())
        }
    }
    fn fail(&self, error: AdmissionError) -> AdmissionError {
        if error == AdmissionError::Unavailable {
            self.unavailable.store(true, Ordering::Release);
        }
        error
    }
    fn storage<T>(&self, result: Result<T>) -> Result<T> {
        if matches!(result, Err(AdmissionError::Unavailable)) {
            self.unavailable.store(true, Ordering::Release);
        }
        result
    }

    /// One read transaction: marker, metadata and every evidence row (one more than the cap, so
    /// an excess is seen without reading further).
    fn read(&self) -> Result<Raw> {
        self.ensure_available()?;
        let (marker, head, evidence) = (self.marker_key(), self.head_key(), self.evidence_prefix());
        let raw = self.store.kv().transact(|tx| {
            Ok::<_, KvError>(Raw {
                marker: tx.get(&marker)?,
                meta: tx.get(&head)?,
                rows: tx.scan_prefix(&evidence, None, MAX_STATEMENTS + 1)?,
            })
        });
        self.storage(raw.map_err(|_| AdmissionError::Unavailable))
    }

    fn header(&self, raw: &Raw) -> Result<Option<Metadata>> {
        let parsed = match (&raw.marker, &raw.meta) {
            (None, None) if !self.enrolled.load(Ordering::Acquire) => return Ok(None),
            (Some(marker), Some(meta)) if marker.len() <= 1024 && meta.len() <= 4096 => {
                let marker: Marker =
                    serde_json::from_slice(marker).map_err(|_| AdmissionError::Unavailable)?;
                let meta: Metadata =
                    serde_json::from_slice(meta).map_err(|_| AdmissionError::Unavailable)?;
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
                    Err(AdmissionError::Unavailable)
                } else {
                    self.enrolled.store(true, Ordering::Release);
                    Ok(Some(meta))
                }
            }
            _ => Err(AdmissionError::Unavailable),
        };
        self.storage(parsed)
    }

    fn record_key(&self, index: usize, r: &Record) -> Vec<u8> {
        let mut key = self.evidence_prefix();
        key.extend_from_slice(&(index as u32).to_be_bytes());
        key.extend_from_slice(&r.revision.to_be_bytes());
        key.extend_from_slice(&r.evidence.hash);
        key
    }

    fn load(&self, meta: Option<&Metadata>, raw: &Raw) -> Result<Option<State>> {
        let loaded = self.load_rows(meta, raw);
        self.storage(loaded)
    }

    fn load_rows(&self, meta: Option<&Metadata>, raw: &Raw) -> Result<Option<State>> {
        let prefix = self.evidence_prefix();
        // Bound raw retained bytes/count before reading objects or doing signature work,
        // including unexpected rows.
        let mut stored = Vec::new();
        let mut bytes = 0usize;
        for (key, value) in &raw.rows {
            let value = Stored::decode(value).ok_or(AdmissionError::Unavailable)?;
            if stored.len() >= MAX_STATEMENTS
                || key.len() != prefix.len() + RECORD_KEY_TAIL
                || value.len() > MAX_FRAME_BYTES as u64
            {
                return Err(AdmissionError::Unavailable);
            }
            bytes = bytes
                .checked_add(value.len() as usize)
                .ok_or(AdmissionError::Unavailable)?;
            if bytes > MAX_CHARGED_BYTES {
                return Err(AdmissionError::Unavailable);
            }
            stored.push((key, value));
        }
        let Some(meta) = meta else {
            return if stored.is_empty() {
                Ok(None)
            } else {
                Err(AdmissionError::Unavailable)
            };
        };
        if stored.len() != meta.retained {
            return Err(AdmissionError::Unavailable);
        }
        let mut rows = Vec::with_capacity(stored.len());
        for (key, value) in stored {
            // A referenced object must exist and match its digest and length.
            let value = self
                .store
                .resolve(value)
                .map_err(|_| AdmissionError::Unavailable)?;
            rows.push((key, value));
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

    /// Read and authenticate the subject's whole durable state in one consistent view.
    fn snapshot(&self) -> Result<(Raw, Option<Metadata>, Option<State>)> {
        let raw = self.read()?;
        let meta = self.header(&raw)?;
        let state = self.load(meta.as_ref(), &raw)?;
        Ok((raw, meta, state))
    }

    /// Commit `state` only if the marker and metadata are still exactly `raw`'s.
    fn commit(
        &self,
        state: &mut State,
        raw: &Raw,
        prior: Option<&Metadata>,
        recorder: Option<Recorder<'_>>,
    ) -> std::result::Result<Metadata, Round> {
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
        let meta_bytes = meta.bytes()?;
        let marker_bytes = serde_json::to_vec(&Marker {
            version: VERSION,
            anchor: self.anchor.revision_zero,
        })
        .map_err(|_| AdmissionError::Unavailable)?;
        let status = meta.status()?;
        // New records only: retained rows never change. Large ones are uploaded before the
        // transaction that references them; an abandoned upload is collected by the sweep.
        let mut inline = 0usize;
        let mut writes: Vec<(Vec<u8>, Stored, Option<Staged>)> = Vec::new();
        let large = self.store.large();
        let abandon = |writes: &[(Vec<u8>, Stored, Option<Staged>)]| {
            for (_, _, staged) in writes {
                if let Some(staged) = staged {
                    large.abandon(staged);
                }
            }
        };
        for (i, r) in state
            .records()
            .enumerate()
            .skip(prior.map_or(0, |m| m.retained))
        {
            let bytes = &r.evidence.attestation;
            if bytes.len() <= INLINE_LIMIT && inline + bytes.len() <= INLINE_BUDGET {
                inline += bytes.len();
                writes.push((self.record_key(i, r), Stored::Inline(bytes.clone()), None));
            } else {
                match large.stage(bytes) {
                    Ok(staged) => writes.push((
                        self.record_key(i, r),
                        Stored::Large(staged.reference),
                        Some(staged),
                    )),
                    Err(_) => {
                        abandon(&writes);
                        return Err(Round::Fail(AdmissionError::Unavailable));
                    }
                }
            }
        }
        #[cfg(test)]
        if let Some(hook) = self.commit_hook {
            if let Err(error) = hook(false) {
                abandon(&writes);
                return Err(Round::Fail(self.fail(error)));
            }
        }
        let (marker_key, head_key) = (self.marker_key(), self.head_key());
        let committed = self.store.kv().transact(|tx| {
            if tx.get(&marker_key)? != raw.marker || tx.get(&head_key)? != raw.meta {
                return Err(TxError::Changed);
            }
            for (key, stored, staged) in &writes {
                tx.set(key, &stored.encode())?;
                if let Some(staged) = staged {
                    large.commit_reference(tx, staged, key)?;
                }
            }
            tx.set(&marker_key, &marker_bytes)?;
            tx.set(&head_key, &meta_bytes)?;
            if let Some(recorder) = recorder {
                recorder(
                    tx,
                    &Commit {
                        first: prior.is_none(),
                        status: &status,
                    },
                )?;
            }
            Ok(())
        });
        match committed {
            Ok(()) => {}
            Err(TxError::Kv(KvError::CommitUnknownResult(_))) => {
                // Learn the outcome by reading: this commit's metadata is unique (its sequence).
                let landed = self
                    .store
                    .kv()
                    .transact(|tx| tx.get(&head_key))
                    .is_ok_and(|now| now.as_deref() == Some(meta_bytes.as_slice()));
                if !landed {
                    abandon(&writes);
                    return Err(Round::Changed);
                }
            }
            Err(error) => {
                abandon(&writes);
                return Err(match error {
                    TxError::Changed | TxError::Large(LargeValueError::IntentLost) => {
                        Round::Changed
                    }
                    TxError::Refused(error) => Round::Fail(error),
                    TxError::Kv(
                        KvError::KeyTooLarge { .. }
                        | KvError::ValueTooLarge { .. }
                        | KvError::TransactionTooLarge { .. },
                    ) => Round::Fail(AdmissionError::Resource),
                    TxError::Kv(
                        KvError::TransactionTimedOut | KvError::ConflictRetriesExhausted { .. },
                    ) => Round::Fail(AdmissionError::Contended),
                    TxError::Kv(_) | TxError::Large(_) => {
                        Round::Fail(self.fail(AdmissionError::Unavailable))
                    }
                });
            }
        }
        self.enrolled.store(true, Ordering::Release);
        #[cfg(test)]
        if let Some(hook) = self.commit_hook {
            if let Err(error) = hook(true) {
                return Err(Round::Fail(self.fail(error)));
            }
        }
        Ok(meta)
    }

    /// Atomically enroll or catch up through a fresh terminal head. Expired intermediate links
    /// stay private; a failed terminal check cannot advance the durable head or stamp pair.
    /// A verified competing child is the sole rejection that durably retains a fork proof.
    pub fn advance(&self, candidates: &[Candidate<'_>], context: Context<'_>) -> Result<Current> {
        self.advance_with(
            candidates,
            context.now,
            BindingPolicy::Exact(context.relay),
            None,
        )
    }

    /// As [`Self::advance`], for a relay's routing table: the head may name any relay.
    pub fn advance_declared(
        &self,
        candidates: &[Candidate<'_>],
        now: Option<Timestamp>,
    ) -> Result<Current> {
        self.advance_with(candidates, now, BindingPolicy::Declared, None)
    }

    /// As [`Self::current`], for a relay's routing table: the head may name any relay.
    pub fn current_declared(&self, now: Option<Timestamp>) -> Result<Current> {
        self.advance_with(&[], now, BindingPolicy::Declared, None)
    }

    /// As [`Self::advance_declared`], with `recorder` writing in every commit's transaction.
    pub(crate) fn advance_declared_recording(
        &self,
        candidates: &[Candidate<'_>],
        now: Option<Timestamp>,
        recorder: Recorder<'_>,
    ) -> Result<Current> {
        self.advance_with(candidates, now, BindingPolicy::Declared, Some(recorder))
    }

    fn advance_with(
        &self,
        candidates: &[Candidate<'_>],
        now: Option<Timestamp>,
        binding: BindingPolicy<'_>,
        recorder: Option<Recorder<'_>>,
    ) -> Result<Current> {
        for _ in 0..MAX_ROUNDS {
            match self.advance_round(candidates, now, binding, recorder) {
                Ok(current) => return Ok(current),
                Err(Round::Fail(error)) => return Err(error),
                Err(Round::Changed) => continue,
            }
        }
        Err(AdmissionError::Contended)
    }

    fn advance_round(
        &self,
        candidates: &[Candidate<'_>],
        now: Option<Timestamp>,
        binding: BindingPolicy<'_>,
        recorder: Option<Recorder<'_>>,
    ) -> std::result::Result<Current, Round> {
        self.ensure_available()?;
        let raw = self.read()?;
        let meta = self.header(&raw)?;
        policy::preflight(
            meta.as_ref().map_or(0, |m| m.retained),
            meta.as_ref().map_or(0, |m| m.charged),
            candidates,
        )?;
        for c in candidates {
            if policy::statement_bytes(c.attestation)? != c.statement {
                return Err(AdmissionError::Evidence.into());
            }
        }
        let loaded = self.load(meta.as_ref(), &raw)?;
        let prior = loaded.as_ref().map(|s| s.checked);
        let now = match binding {
            // A relay's replicas share each subject's checked time but not a clock. Their
            // trusted time is the later of their own and the stored floor, so a replica whose
            // clock is slightly behind another's never refuses that replica's subjects.
            BindingPolicy::Declared => policy::clock_floor(now, prior)?,
            BindingPolicy::Exact(_) => policy::clock(now, prior)?,
        };
        // Missing trust input never poisons a subject, including with a valid signed competitor.
        if matches!(binding, BindingPolicy::Exact(None)) {
            return Err(AdmissionError::Binding.into());
        }
        let mut state = loaded.unwrap_or(State {
            history: History::default(),
            proof: Vec::new(),
            checked: now,
            sequence: 0,
        });
        if !state.proof.is_empty() {
            return Err(AdmissionError::Fork.into());
        }
        // Authenticate the entire candidate batch before mutating even the staged history.
        let mut incoming = Vec::with_capacity(candidates.len());
        for c in candidates {
            let r = policy::authenticate(&self.anchor, c.attestation)?;
            if r.evidence.statement != c.statement {
                return Err(AdmissionError::Evidence.into());
            }
            if policy::nanos(r.issued) > policy::nanos(now) {
                return Err(AdmissionError::Validity.into());
            }
            incoming.push(r);
        }
        let accepted = state.history.records.len();
        for r in incoming {
            match state.history.classify(&self.anchor, &r)? {
                Transition::Duplicate => (),
                Transition::Append => state.history.append(r),
                // On a relay the first accepted child of a revision wins. A second, different
                // child (two devices renewing at once, or the same renewal raced to two
                // replicas) is refused and nothing is recorded, so honest use can never
                // quarantine an account; the client re-reads and adopts.
                Transition::Fork if matches!(binding, BindingPolicy::Declared) => {
                    return Err(AdmissionError::Fork.into());
                }
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
                    self.commit(&mut state, &raw, meta.as_ref(), recorder)?;
                    return Err(AdmissionError::Fork.into());
                }
            }
        }
        state.history.head()?.fresh(now, binding)?;
        state.checked = now;
        let committed = self.commit(&mut state, &raw, meta.as_ref(), recorder)?;
        Ok(Self::current_result(&state, committed.status()?)?)
    }

    /// Validate supplied current trust for staging without changing durable state.
    ///
    /// Success is only a point-in-time validation, not a fresh authority token or a
    /// committed checkpoint. Serving still requires `current` or `advance` with fresh
    /// inputs. This uses the same retained-evidence, clock, quarantine and head policy.
    pub fn check_current(&self, context: Context<'_>) -> Result<()> {
        self.ensure_available()?;
        let raw = self.read()?;
        let meta = self.header(&raw)?;
        policy::preflight(
            meta.as_ref().map_or(0, |m| m.retained),
            meta.as_ref().map_or(0, |m| m.charged),
            &[],
        )?;
        let loaded = self.load(meta.as_ref(), &raw)?;
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
        let (_, _, state) = self.snapshot()?;
        let state = state.ok_or(AdmissionError::Unenrolled)?;
        Ok(state
            .history
            .records
            .iter()
            .find(|r| r.evidence.hash == hash)
            .map(|r| r.evidence.clone()))
    }

    /// Validate and describe durable state without granting freshness. `None` means unenrolled.
    pub fn status(&self) -> Result<Option<Status>> {
        let (_, _, state) = self.snapshot()?;
        state.map(|s| s.metadata(&self.anchor).status()).transpose()
    }

    /// Every retained record in stored order: the accepted chain, then any fork proof. This is
    /// what one relay hands another; the receiver verifies each record itself.
    pub fn retained(&self) -> Result<Vec<HistoricalEvidence>> {
        let (_, _, state) = self.snapshot()?;
        let state = state.ok_or(AdmissionError::Unenrolled)?;
        Ok(state.records().map(|r| r.evidence.clone()).collect())
    }

    /// Bounded exact fork proof for external investigation. These are not accepted history.
    pub fn conflict_evidence(&self) -> Result<Vec<HistoricalEvidence>> {
        let (_, _, state) = self.snapshot()?;
        let state = state.ok_or(AdmissionError::Unenrolled)?;
        Ok(state.proof.into_iter().map(|r| r.evidence).collect())
    }
}

/// Direct access to this subject's stored rows, for fault and layout tests.
#[cfg(test)]
impl Directory<'_> {
    pub(crate) fn header_now(&self) -> Result<Option<Metadata>> {
        let raw = self.read()?;
        self.header(&raw)
    }
    pub(crate) fn load_now(&self, meta: Option<&Metadata>) -> Result<Option<State>> {
        let raw = self.read()?;
        self.load(meta, &raw)
    }
    pub(crate) fn raw_put(&self, key: &[u8], value: &[u8]) {
        self.store.kv().transact(|tx| tx.set(key, value)).unwrap();
    }
    pub(crate) fn raw_delete(&self, key: &[u8]) {
        self.store.kv().transact(|tx| tx.clear(key)).unwrap();
    }
    pub(crate) fn raw_get(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.store.kv().transact(|tx| tx.get(key)).unwrap()
    }
    /// Every evidence row of this subject as stored (tag, then bytes or a reference).
    pub(crate) fn raw_evidence(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
        let prefix = self.evidence_prefix();
        let mut rows = Vec::new();
        let mut after: Option<Vec<u8>> = None;
        loop {
            let page = self
                .store
                .kv()
                .transact(|tx| tx.scan_prefix(&prefix, after.as_deref(), 1024))
                .unwrap();
            let Some((last, _)) = page.last() else {
                return rows;
            };
            after = Some(last.clone());
            rows.extend(page);
        }
    }
    /// Every evidence row's exact bytes, read from the object store when large.
    pub(crate) fn stored_evidence(&self) -> Vec<Vec<u8>> {
        self.raw_evidence()
            .into_iter()
            .map(|(_, value)| self.store.resolve(Stored::decode(&value).unwrap()).unwrap())
            .collect()
    }
    /// Store an evidence value inline, as a commit would.
    pub(crate) fn raw_put_evidence(&self, key: &[u8], bytes: &[u8]) {
        self.raw_put(key, &Stored::Inline(bytes.to_vec()).encode());
    }
}

#[cfg(test)]
#[path = "../directory_admission/storage_tests.rs"]
mod tests;
