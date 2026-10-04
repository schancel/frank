//! Self-published directory subjects: one continuity row per subject and the address index.
//!
//! The signed evidence itself lives in the preview sidecar. This table remembers, for every key
//! that published an entry, the revision-zero hash it pinned first and the last continuity
//! checkpoint, so a restart reopens exactly the history it served before. The address index maps
//! the 20-byte account address to the key that hashes to it. A third table lists addresses in
//! the order their first entry was accepted here, for the public "new accounts" listing.
use bitcoinsuite_error::Result;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};

use super::db::CF;
use crate::directory_admission::Checkpoint;

/// Directory inside the registry path holding this store.
pub(crate) const STORE: &str = "directory-subjects-v1.rocksdb";
pub(crate) const CF_DIRECTORY_SUBJECTS_V1: &str = "directory_subjects_v1";
pub(crate) const CF_DIRECTORY_ADDRESSES_V1: &str = "directory_addresses_v1";
pub(crate) const CF_DIRECTORY_FIRST_ACCEPTED_V1: &str = "directory_first_accepted_v1";
/// Length of a first-accepted position: big-endian Unix milliseconds, then the address.
pub(crate) const FIRST_ACCEPTED_POSITION_BYTES: usize = 8 + 20;
/// Messages accepted for a recipient on another relay: state by submission identity.
pub(crate) const CF_FORWARDS_V1: &str = "forwards_v1";
/// The exact request bytes of each forward, written once.
pub(crate) const CF_FORWARD_BODIES_V1: &str = "forward_bodies_v1";

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
    #[serde(default = "local_by_default")]
    pub(crate) local: bool,
}
fn local_by_default() -> bool {
    true
}

/// Open the store, creating it on first use.
pub(crate) fn open(path: &std::path::Path) -> Result<rocksdb::DB> {
    let mut options = rocksdb::Options::default();
    options.create_if_missing(true);
    options.create_missing_column_families(true);
    let cfs = [
        CF_DIRECTORY_SUBJECTS_V1,
        CF_DIRECTORY_ADDRESSES_V1,
        CF_DIRECTORY_FIRST_ACCEPTED_V1,
        CF_FORWARDS_V1,
        CF_FORWARD_BODIES_V1,
    ]
    .iter()
    .map(|name| ColumnFamilyDescriptor::new(*name, rocksdb::Options::default()));
    Ok(rocksdb::DB::open_cf_descriptors(&options, path, cfs)?)
}

pub(crate) struct DbDirectorySubjects<'a> {
    db: &'a rocksdb::DB,
    subjects: &'a CF,
    addresses: &'a CF,
    first_accepted: &'a CF,
    forwards: &'a CF,
    forward_bodies: &'a CF,
}
/// One first-accepted row: its position, the time in Unix milliseconds, the address.
pub(crate) type FirstAcceptedRow = ([u8; FIRST_ACCEPTED_POSITION_BYTES], u64, [u8; 20]);
fn position(accepted_ms: u64, address: &[u8; 20]) -> [u8; FIRST_ACCEPTED_POSITION_BYTES] {
    let mut tail = [0; FIRST_ACCEPTED_POSITION_BYTES];
    tail[..8].copy_from_slice(&accepted_ms.to_be_bytes());
    tail[8..].copy_from_slice(address);
    tail
}

fn prefix(network: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(1 + network.len() + 33);
    key.push(network.len() as u8);
    key.extend_from_slice(network.as_bytes());
    key
}
fn key(network: &str, tail: &[u8]) -> Vec<u8> {
    let mut key = prefix(network);
    key.extend_from_slice(tail);
    key
}

impl<'a> DbDirectorySubjects<'a> {
    pub(crate) fn new(db: &'a rocksdb::DB) -> Result<Self> {
        let cf = |name: &str| {
            db.cf_handle(name)
                .ok_or_else(|| super::db::DbError::NoSuchColumnFamily(name.to_string()))
        };
        Ok(Self {
            db,
            subjects: cf(CF_DIRECTORY_SUBJECTS_V1)?,
            addresses: cf(CF_DIRECTORY_ADDRESSES_V1)?,
            first_accepted: cf(CF_DIRECTORY_FIRST_ACCEPTED_V1)?,
            forwards: cf(CF_FORWARDS_V1)?,
            forward_bodies: cf(CF_FORWARD_BODIES_V1)?,
        })
    }

    pub(crate) fn get(&self, network: &str, subject: &[u8]) -> Result<Option<SubjectRow>> {
        match self
            .db
            .get_pinned_cf(self.subjects, key(network, subject))?
        {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            None => Ok(None),
        }
    }

    /// Write the continuity row. With `first` (the address and the time of this first
    /// publication in Unix milliseconds) also the address index entry and the first-accepted
    /// position, all in one synced batch.
    pub(crate) fn put(
        &self,
        network: &str,
        subject: &[u8],
        first: Option<(&[u8; 20], u64)>,
        row: &SubjectRow,
    ) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.put_cf(
            self.subjects,
            key(network, subject),
            serde_json::to_vec(row)?,
        );
        if let Some((address, accepted_ms)) = first {
            batch.put_cf(self.addresses, key(network, address), subject);
            batch.put_cf(
                self.first_accepted,
                key(network, &position(accepted_ms, address)),
                [],
            );
        }
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        Ok(())
    }

    /// Forget a subject whose first entry was never accepted. `accepted_ms` is the time its
    /// first-accepted position was written with, when the caller still knows it; a position
    /// left behind names an address with no index entry and is skipped by the listing.
    pub(crate) fn delete(
        &self,
        network: &str,
        subject: &[u8],
        address: &[u8; 20],
        accepted_ms: Option<u64>,
    ) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.subjects, key(network, subject));
        batch.delete_cf(self.addresses, key(network, address));
        if let Some(accepted_ms) = accepted_ms {
            batch.delete_cf(
                self.first_accepted,
                key(network, &position(accepted_ms, address)),
            );
        }
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        Ok(())
    }

    pub(crate) fn subject_for_address(
        &self,
        network: &str,
        address: &[u8; 20],
    ) -> Result<Option<Vec<u8>>> {
        Ok(self
            .db
            .get_pinned_cf(self.addresses, key(network, address))?
            .map(|bytes| bytes.to_vec())
            .filter(|bytes| bytes.len() == 33))
    }

    /// Number of (local, replicated) subjects across all networks. One scan at startup.
    pub(crate) fn count(&self) -> Result<(u64, u64)> {
        let mut count = (0u64, 0u64);
        for row in self.db.iterator_cf(self.subjects, IteratorMode::Start) {
            let (_, value) = row?;
            if serde_json::from_slice::<SubjectRow>(&value)?.local {
                count.0 += 1;
            } else {
                count.1 += 1;
            }
        }
        Ok(count)
    }

    /// Subjects of `network` in key order strictly after `after`, with their current head hash.
    pub(crate) fn list(
        &self,
        network: &str,
        after: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, SubjectRow)>> {
        let start = prefix(network);
        let from = key(network, after.unwrap_or(&[]));
        let mut out = Vec::new();
        for row in self
            .db
            .iterator_cf(self.subjects, IteratorMode::From(&from, Direction::Forward))
        {
            let (key, value) = row?;
            if !key.starts_with(&start) || key.len() != start.len() + 33 {
                break;
            }
            let subject = &key[start.len()..];
            if after == Some(subject) {
                continue;
            }
            out.push((subject.to_vec(), serde_json::from_slice(&value)?));
            if out.len() >= limit {
                break;
            }
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
        let start = prefix(network);
        let from = key(network, after);
        let mut out = Vec::new();
        for row in self.db.iterator_cf(
            self.first_accepted,
            IteratorMode::From(&from, Direction::Forward),
        ) {
            if out.len() >= limit {
                break;
            }
            let (key, _) = row?;
            if !key.starts_with(&start) || key.len() != start.len() + FIRST_ACCEPTED_POSITION_BYTES
            {
                break;
            }
            let tail: [u8; FIRST_ACCEPTED_POSITION_BYTES] =
                key[start.len()..].try_into().expect("length checked");
            if after == &tail {
                continue;
            }
            let accepted_ms = u64::from_be_bytes(tail[..8].try_into().expect("8 bytes"));
            let address = tail[8..].try_into().expect("20 bytes");
            out.push((tail, accepted_ms, address));
        }
        Ok(out)
    }

    pub(crate) fn forward(&self, identity: &[u8; 32]) -> Result<Option<ForwardRow>> {
        match self.db.get_pinned_cf(self.forwards, identity)? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            None => Ok(None),
        }
    }

    pub(crate) fn forward_body(&self, identity: &[u8; 32]) -> Result<Option<Vec<u8>>> {
        Ok(self
            .db
            .get_pinned_cf(self.forward_bodies, identity)?
            .map(|bytes| bytes.to_vec()))
    }

    /// Durably write the forward state and, the first time, the exact request bytes.
    pub(crate) fn put_forward(
        &self,
        identity: &[u8; 32],
        row: &ForwardRow,
        body: Option<&[u8]>,
    ) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.put_cf(self.forwards, identity, serde_json::to_vec(row)?);
        if let Some(body) = body {
            batch.put_cf(self.forward_bodies, identity, body);
        }
        if row.done {
            batch.delete_cf(self.forward_bodies, identity);
        }
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        Ok(())
    }

    pub(crate) fn delete_forward(&self, identity: &[u8; 32]) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.forwards, identity);
        batch.delete_cf(self.forward_bodies, identity);
        self.db.write(batch)?;
        Ok(())
    }

    /// Every forward this relay remembers. Bounded by the pending and history limits.
    pub(crate) fn forwards(&self) -> Result<Vec<([u8; 32], ForwardRow)>> {
        let mut out = Vec::new();
        for row in self.db.iterator_cf(self.forwards, IteratorMode::Start) {
            let (key, value) = row?;
            if let Ok(identity) = <[u8; 32]>::try_from(&key[..]) {
                out.push((identity, serde_json::from_slice(&value)?));
            }
        }
        Ok(out)
    }
}
