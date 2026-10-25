//! Self-published directory subjects: one continuity row per subject, the address index, the
//! first-accepted listing, the subject counters, and the forward queue.
//!
//! All of it lives in the directory's transaction store beside the preview evidence
//! ([`super::directory_store`]). A subject's continuity row and indexes are written by the
//! recorders below inside the same transaction as its evidence and metadata, so enrollment is
//! one atomic step (there is no "prospective" row to clean up after a crash) and a continuity
//! row can never fall behind or ahead of the evidence it describes, whichever replica commits.
//! The relay-wide subject caps are two counters changed by atomic adds in the enrollment
//! transaction; that transaction also reads the counter it adds to, so concurrent enrollments
//! on different replicas serialize and the cap holds exactly.
//!
//! Forwards are claimed by compare-and-set before an attempt and finished only by their
//! claimer, so two replicas never send the same forward at once, and a replica that dies
//! mid-attempt leaves a claim that expires and is taken over.
use std::sync::Arc;

use bitcoinsuite_error::Result;
use serde::{Deserialize, Serialize};

use super::directory_preview::{subject_key, Commit, RecordError};
use super::directory_store::{now_ms, DirectoryStore, Stored};
use crate::directory_admission::{AdmissionError, Checkpoint};
use crate::store::{
    kv_store::{KvError, KvTransaction, Transact},
    large_values::{LargeValueError, Staged, INLINE_LIMIT},
};

/// Length of a first-accepted position: big-endian Unix milliseconds, then the address.
pub(crate) const FIRST_ACCEPTED_POSITION_BYTES: usize = 8 + 20;
const ROWS: &[u8] = b"s/r/";
const ADDRESSES: &[u8] = b"s/a/";
const FIRST_ACCEPTED: &[u8] = b"s/f/";
const LOCAL_COUNT: &[u8] = b"s/n/local";
const REPLICATED_COUNT: &[u8] = b"s/n/replicated";
const FORWARDS: &[u8] = b"f/r/";
const FORWARD_BODIES: &[u8] = b"f/b/";

/// One message this relay accepted for a recipient whose mailbox is on another relay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ForwardRow {
    /// Relay endpoint named by the recipient's entry.
    pub(crate) endpoint: String,
    pub(crate) content_type: String,
    /// Sender key, so its entry can be offered to the recipient's relay.
    pub(crate) sender: String,
    pub(crate) network: String,
    pub(crate) created_ms: i64,
    pub(crate) attempts: u32,
    pub(crate) next_ms: i64,
    /// Set once the recipient's relay gave a final answer; that answer is then repeated.
    pub(crate) done: bool,
    pub(crate) status: u16,
    pub(crate) response: String,
    /// Identity echo for answering "retained" before the recipient's relay was reached.
    pub(crate) echo: serde_json::Value,
    /// The replica attempting delivery now, until its claim expires.
    #[serde(default)]
    pub(crate) claim: Option<ForwardClaim>,
}

/// A replica's exclusive right to attempt one forward until `until_ms`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ForwardClaim {
    pub(crate) holder: [u8; 16],
    pub(crate) until_ms: u64,
}

/// What [`DbDirectorySubjects::claim_forward`] found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ForwardClaimed {
    /// No such forward.
    Missing,
    /// A final answer is recorded; repeat it, send nothing.
    Done(ForwardRow),
    /// Another replica is attempting it now.
    Held(ForwardRow),
    /// This holder may attempt it until its claim expires.
    Claimed(ForwardRow),
}

/// Durable per-subject continuity. `anchor` never changes once written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubjectRow {
    pub(crate) version: u32,
    pub(crate) anchor: [u8; 32],
    pub(crate) checkpoint: Checkpoint,
    /// Whether the account's first entry named this relay. Accounts that live elsewhere are
    /// counted against a separate budget so copies from peers cannot crowd out sign-ups here.
    pub(crate) local: bool,
}

/// What a subject's first commit writes beside its evidence.
#[derive(Clone, Debug)]
pub(crate) struct Enrollment {
    pub(crate) address: [u8; 20],
    /// When this first publication happened, in Unix milliseconds.
    pub(crate) accepted_ms: u64,
    pub(crate) anchor: [u8; 32],
    pub(crate) local: bool,
    /// The relay-wide cap of the counter this subject is charged to.
    pub(crate) budget: u64,
}

/// One first-accepted row: its position, the time in Unix milliseconds, the address.
pub(crate) type FirstAcceptedRow = ([u8; FIRST_ACCEPTED_POSITION_BYTES], u64, [u8; 20]);

fn position(accepted_ms: u64, address: &[u8; 20]) -> [u8; FIRST_ACCEPTED_POSITION_BYTES] {
    let mut tail = [0; FIRST_ACCEPTED_POSITION_BYTES];
    tail[..8].copy_from_slice(&accepted_ms.to_be_bytes());
    tail[8..].copy_from_slice(address);
    tail
}

fn network_prefix(table: &[u8], network: &str) -> Vec<u8> {
    let mut key = table.to_vec();
    key.push(network.len() as u8);
    key.extend_from_slice(network.as_bytes());
    key
}
fn key(table: &[u8], network: &str, tail: &[u8]) -> Vec<u8> {
    let mut key = network_prefix(table, network);
    key.extend_from_slice(tail);
    key
}
fn row_key(network: &str, subject: &[u8]) -> Vec<u8> {
    [ROWS, &subject_key(network, subject)].concat()
}
fn forward_key(identity: &[u8; 32]) -> Vec<u8> {
    [FORWARDS, identity.as_slice()].concat()
}
fn body_key(identity: &[u8; 32]) -> Vec<u8> {
    [FORWARD_BODIES, identity.as_slice()].concat()
}
fn read_count(tx: &mut dyn KvTransaction, key: &[u8]) -> std::result::Result<u64, KvError> {
    Ok(tx.get(key)?.map_or(0, |bytes| {
        let mut le = [0u8; 8];
        let len = bytes.len().min(8);
        le[..len].copy_from_slice(&bytes[..len]);
        u64::from_le_bytes(le)
    }))
}
fn json<T: Serialize>(value: &T) -> std::result::Result<Vec<u8>, KvError> {
    serde_json::to_vec(value).map_err(|error| KvError::Backend(error.to_string()))
}

/// The recorder for a subject's commits: on its first commit the continuity row, address
/// index, first-accepted position and counter (refused at the cap); afterwards the continuity
/// row whenever anything but the checked time changed.
pub(crate) fn record(
    enrollment: Option<&Enrollment>,
    network: &str,
    subject: &[u8],
    tx: &mut dyn KvTransaction,
    commit: &Commit<'_>,
) -> std::result::Result<(), RecordError> {
    let rows = row_key(network, subject);
    if commit.first {
        let Some(enrollment) = enrollment else {
            // A subject enrolled without its row (the bare preview facade) is not published.
            return Err(RecordError::Refused(AdmissionError::Unavailable));
        };
        let counter = if enrollment.local {
            LOCAL_COUNT
        } else {
            REPLICATED_COUNT
        };
        if read_count(tx, counter)? >= enrollment.budget {
            return Err(RecordError::Refused(AdmissionError::Resource));
        }
        tx.atomic_add(counter, 1)?;
        let row = SubjectRow {
            version: 1,
            anchor: enrollment.anchor,
            checkpoint: commit.status.checkpoint,
            local: enrollment.local,
        };
        tx.set(&rows, &json(&row)?)?;
        tx.set(&key(ADDRESSES, network, &enrollment.address), subject)?;
        tx.set(
            &key(
                FIRST_ACCEPTED,
                network,
                &position(enrollment.accepted_ms, &enrollment.address),
            ),
            &[],
        )?;
        return Ok(());
    }
    let Some(bytes) = tx.get(&rows)? else {
        return Err(RecordError::Refused(AdmissionError::Unavailable));
    };
    let mut row: SubjectRow = serde_json::from_slice(&bytes)
        .map_err(|_| RecordError::Refused(AdmissionError::Unavailable))?;
    // A later checked time alone is not rewritten: an older floor still reopens the same history.
    let mut same_but_time = commit.status.checkpoint;
    same_but_time.checked_time = row.checkpoint.checked_time;
    if same_but_time != row.checkpoint {
        row.checkpoint = commit.status.checkpoint;
        tx.set(&rows, &json(&row)?)?;
    }
    Ok(())
}

/// Typed access to subjects and forwards in the directory store. Every method is one or more
/// transactions and blocks; async callers run it on a blocking worker.
pub(crate) struct DbDirectorySubjects {
    store: Arc<DirectoryStore>,
}

impl DbDirectorySubjects {
    pub(crate) fn new(store: Arc<DirectoryStore>) -> Self {
        Self { store }
    }

    pub(crate) fn get(&self, network: &str, subject: &[u8]) -> Result<Option<SubjectRow>> {
        let rows = row_key(network, subject);
        match self.store.kv().transact(|tx| tx.get(&rows))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            None => Ok(None),
        }
    }

    pub(crate) fn subject_for_address(
        &self,
        network: &str,
        address: &[u8; 20],
    ) -> Result<Option<Vec<u8>>> {
        let address = key(ADDRESSES, network, address);
        Ok(self
            .store
            .kv()
            .transact(|tx| tx.get(&address))?
            .filter(|bytes| bytes.len() == 33))
    }

    /// Number of (local, replicated) subjects across all networks.
    pub(crate) fn counts(&self) -> Result<(u64, u64)> {
        Ok(self.store.kv().transact(|tx| {
            Ok::<_, KvError>((
                read_count(tx, LOCAL_COUNT)?,
                read_count(tx, REPLICATED_COUNT)?,
            ))
        })?)
    }

    /// Subjects of `network` in key order strictly after `after`, with their continuity rows.
    pub(crate) fn list(
        &self,
        network: &str,
        after: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, SubjectRow)>> {
        let start = network_prefix(ROWS, network);
        let after = after.map(|after| key(ROWS, network, after));
        let scanned = self
            .store
            .kv()
            .transact(|tx| tx.scan_prefix(&start, after.as_deref(), limit))?;
        let mut out = Vec::new();
        for (key, value) in scanned {
            if key.len() != start.len() + 33 {
                break;
            }
            out.push((key[start.len()..].to_vec(), serde_json::from_slice(&value)?));
        }
        Ok(out)
    }

    /// At most `limit` first-accepted positions of `network` in time order, strictly after
    /// `after`, as `(position, accepted_ms, address)`.
    pub(crate) fn first_accepted(
        &self,
        network: &str,
        after: &[u8; FIRST_ACCEPTED_POSITION_BYTES],
        limit: usize,
    ) -> Result<Vec<FirstAcceptedRow>> {
        let start = network_prefix(FIRST_ACCEPTED, network);
        let after = key(FIRST_ACCEPTED, network, after);
        let scanned = self
            .store
            .kv()
            .transact(|tx| tx.scan_prefix(&start, Some(&after), limit))?;
        let mut out = Vec::new();
        for (key, _) in scanned {
            if key.len() != start.len() + FIRST_ACCEPTED_POSITION_BYTES {
                break;
            }
            let tail: [u8; FIRST_ACCEPTED_POSITION_BYTES] =
                key[start.len()..].try_into().expect("length checked");
            let accepted_ms = u64::from_be_bytes(tail[..8].try_into().expect("8 bytes"));
            let address = tail[8..].try_into().expect("20 bytes");
            out.push((tail, accepted_ms, address));
        }
        Ok(out)
    }

    #[cfg(test)]
    pub(crate) fn forward(&self, identity: &[u8; 32]) -> Result<Option<ForwardRow>> {
        let forward = forward_key(identity);
        match self.store.kv().transact(|tx| tx.get(&forward))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            None => Ok(None),
        }
    }

    /// The exact request bytes of a pending forward, read from the object store when large.
    pub(crate) fn forward_body(&self, identity: &[u8; 32]) -> Result<Option<Vec<u8>>> {
        let body = body_key(identity);
        let Some(stored) = self.store.kv().transact(|tx| tx.get(&body))? else {
            return Ok(None);
        };
        let stored = Stored::decode(&stored)
            .ok_or_else(|| bitcoinsuite_error::Report::msg("corrupt forward body"))?;
        Ok(Some(
            self.store
                .resolve(stored)
                .map_err(bitcoinsuite_error::Report::msg)?,
        ))
    }

    /// Durably write the forward state and, when given, its exact request bytes; a final answer
    /// discards the bytes. Bodies over the inline limit go to the object store first.
    // The message route does not enqueue forwards yet (`/relay/v1/info` says `forwarding:
    // false`); this is the queue's writer, exercised by its tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn put_forward(
        &self,
        identity: &[u8; 32],
        row: &ForwardRow,
        body: Option<&[u8]>,
    ) -> Result<()> {
        let staged = match body {
            Some(body) if !row.done && body.len() > INLINE_LIMIT => {
                Some(self.store.large().stage(body)?)
            }
            _ => None,
        };
        let result = self.write_forward(identity, row, body, staged.as_ref(), None);
        if result.is_err() {
            if let Some(staged) = &staged {
                self.store.large().abandon(staged);
            }
        }
        result.map(drop)
    }

    fn write_forward(
        &self,
        identity: &[u8; 32],
        row: &ForwardRow,
        body: Option<&[u8]>,
        staged: Option<&Staged>,
        holder: Option<&[u8; 16]>,
    ) -> Result<bool> {
        let (forward, body_key) = (forward_key(identity), body_key(identity));
        let large = self.store.large();
        let bytes = serde_json::to_vec(row)?;
        Ok(self.store.kv().transact(|tx| {
            if let Some(holder) = holder {
                let current = tx.get(&forward)?;
                let claimed = current
                    .and_then(|bytes| serde_json::from_slice::<ForwardRow>(&bytes).ok())
                    .and_then(|row| row.claim)
                    .is_some_and(|claim| claim.holder == *holder);
                if !claimed {
                    return Ok(false);
                }
            }
            tx.set(&forward, &bytes)?;
            if row.done {
                clear_body(tx, large, &body_key)?;
            } else if let Some(body) = body {
                clear_body(tx, large, &body_key)?;
                match staged {
                    Some(staged) => {
                        tx.set(&body_key, &Stored::Large(staged.reference).encode())?;
                        large.commit_reference(tx, staged, &body_key)?;
                    }
                    None => tx.set(&body_key, &Stored::Inline(body.to_vec()).encode())?,
                }
            }
            Ok::<_, LargeValueError>(true)
        })?)
    }

    /// Claim a forward for one attempt by `holder` until `ttl_ms` from now. A live claim of
    /// another holder is never taken; an expired one is.
    pub(crate) fn claim_forward(
        &self,
        identity: &[u8; 32],
        holder: &[u8; 16],
        ttl_ms: u64,
    ) -> Result<ForwardClaimed> {
        let forward = forward_key(identity);
        Ok(self.store.kv().transact(|tx| {
            let Some(bytes) = tx.get(&forward)? else {
                return Ok(ForwardClaimed::Missing);
            };
            let mut row: ForwardRow = serde_json::from_slice(&bytes)
                .map_err(|error| KvError::Backend(error.to_string()))?;
            if row.done {
                return Ok(ForwardClaimed::Done(row));
            }
            let now = now_ms();
            if row
                .claim
                .is_some_and(|claim| claim.holder != *holder && claim.until_ms > now)
            {
                return Ok(ForwardClaimed::Held(row));
            }
            row.claim = Some(ForwardClaim {
                holder: *holder,
                until_ms: now.saturating_add(ttl_ms),
            });
            tx.set(&forward, &json(&row)?)?;
            Ok::<_, KvError>(ForwardClaimed::Claimed(row))
        })?)
    }

    /// Record the outcome of `holder`'s attempt and release its claim. False, writing nothing,
    /// when the claim expired and another holder took the forward over.
    pub(crate) fn finish_forward(
        &self,
        identity: &[u8; 32],
        holder: &[u8; 16],
        row: &ForwardRow,
    ) -> Result<bool> {
        let mut row = row.clone();
        row.claim = None;
        self.write_forward(identity, &row, None, None, Some(holder))
    }

    pub(crate) fn delete_forward(&self, identity: &[u8; 32]) -> Result<()> {
        let (forward, body_key) = (forward_key(identity), body_key(identity));
        let large = self.store.large();
        Ok(self.store.kv().transact(|tx| {
            tx.clear(&forward)?;
            clear_body(tx, large, &body_key)
        })?)
    }

    /// Every forward this relay remembers. Bounded by the pending and history limits.
    pub(crate) fn forwards(&self) -> Result<Vec<([u8; 32], ForwardRow)>> {
        let mut out = Vec::new();
        let mut after: Option<Vec<u8>> = None;
        loop {
            let page = self
                .store
                .kv()
                .transact(|tx| tx.scan_prefix(FORWARDS, after.as_deref(), 256))?;
            let Some((last, _)) = page.last() else {
                break;
            };
            after = Some(last.clone());
            for (key, value) in page {
                if let Ok(identity) = <[u8; 32]>::try_from(&key[FORWARDS.len()..]) {
                    out.push((identity, serde_json::from_slice(&value)?));
                }
            }
        }
        Ok(out)
    }

    /// Take or renew the lease `name` (see [`DirectoryStore::hold_lease`]).
    pub(crate) fn hold_lease(&self, name: &[u8], holder: &[u8; 16], ttl_ms: u64) -> Result<bool> {
        Ok(self.store.hold_lease(name, holder, ttl_ms)?)
    }
}

/// Remove a forward's body and, when it was in the object store, its reference.
fn clear_body(
    tx: &mut dyn KvTransaction,
    large: &crate::store::large_values::LargeValues,
    body_key: &[u8],
) -> std::result::Result<(), LargeValueError> {
    if let Some(Stored::Large(reference)) = tx.get(body_key)?.as_deref().and_then(Stored::decode) {
        large.clear_reference(tx, &reference, body_key)?;
    }
    tx.clear(body_key)?;
    Ok(())
}

#[cfg(test)]
#[path = "directory_subjects_tests.rs"]
mod tests;

#[cfg(all(test, feature = "foundationdb"))]
#[path = "directory_subjects_fdb_tests.rs"]
mod fdb;
