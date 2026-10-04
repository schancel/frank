//! Self-published directory subjects: one continuity row per subject and the address index.
//!
//! The signed evidence itself lives in the preview sidecar. This table remembers, for every key
//! that published an entry, the revision-zero hash it pinned first and the last continuity
//! checkpoint, so a restart reopens exactly the history it served before. The address index maps
//! the 20-byte account address to the key that hashes to it.
use bitcoinsuite_error::Result;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};

use super::db::{Db, CF};
use crate::directory_admission::Checkpoint;

pub(crate) const CF_DIRECTORY_SUBJECTS_V1: &str = "directory_subjects_v1";
pub(crate) const CF_DIRECTORY_ADDRESSES_V1: &str = "directory_addresses_v1";

/// Durable per-subject continuity. `anchor` never changes once written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubjectRow {
    pub(crate) version: u32,
    pub(crate) anchor: [u8; 32],
    pub(crate) checkpoint: Checkpoint,
}

pub(crate) struct DbDirectorySubjects<'a> {
    db: &'a Db,
    subjects: &'a CF,
    addresses: &'a CF,
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
    pub(crate) fn new(db: &'a Db) -> Result<Self> {
        Ok(Self {
            db,
            subjects: db.cf(CF_DIRECTORY_SUBJECTS_V1)?,
            addresses: db.cf(CF_DIRECTORY_ADDRESSES_V1)?,
        })
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        for name in [CF_DIRECTORY_SUBJECTS_V1, CF_DIRECTORY_ADDRESSES_V1] {
            columns.push(ColumnFamilyDescriptor::new(
                name,
                rocksdb::Options::default(),
            ));
        }
    }

    pub(crate) fn get(&self, network: &str, subject: &[u8]) -> Result<Option<SubjectRow>> {
        match self.db.get(self.subjects, key(network, subject))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            None => Ok(None),
        }
    }

    /// Write the continuity row; with `address` also the index entry, in one synced batch.
    pub(crate) fn put(
        &self,
        network: &str,
        subject: &[u8],
        address: Option<&[u8; 20]>,
        row: &SubjectRow,
    ) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.put_cf(
            self.subjects,
            key(network, subject),
            serde_json::to_vec(row)?,
        );
        if let Some(address) = address {
            batch.put_cf(self.addresses, key(network, address), subject);
        }
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.rocksdb().write_opt(batch, &options)?;
        Ok(())
    }

    /// Forget a subject whose first entry was never accepted.
    pub(crate) fn delete(&self, network: &str, subject: &[u8], address: &[u8; 20]) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.subjects, key(network, subject));
        batch.delete_cf(self.addresses, key(network, address));
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.rocksdb().write_opt(batch, &options)?;
        Ok(())
    }

    pub(crate) fn subject_for_address(
        &self,
        network: &str,
        address: &[u8; 20],
    ) -> Result<Option<Vec<u8>>> {
        Ok(self
            .db
            .get(self.addresses, key(network, address))?
            .map(|bytes| bytes.to_vec())
            .filter(|bytes| bytes.len() == 33))
    }

    /// Number of subjects across all networks. One bounded key scan at startup.
    pub(crate) fn count(&self) -> Result<u64> {
        let mut count = 0u64;
        for row in self
            .db
            .rocksdb()
            .iterator_cf(self.subjects, IteratorMode::Start)
        {
            row?;
            count += 1;
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
            .rocksdb()
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
}
