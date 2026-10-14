//! Self-published directory subjects: one continuity row per subject and the address index.
//!
//! The signed evidence itself lives in the preview sidecar. This table remembers, for every key
//! that published an entry, the revision-zero hash it pinned first and the last continuity
//! checkpoint, so a restart reopens exactly the history it served before. The address index maps
//! the 20-byte account address to the key that hashes to it. A third table lists addresses in
//! the order their first entry was accepted here, for the public "new accounts" listing.
use bitcoinsuite_error::{Result, WrapErr};
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

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

/// Owns lazy sidecar opening; typed rows borrow the same database handle and lifetime.
pub(super) struct Owner {
    opened: OnceLock<rocksdb::DB>,
    opening: Mutex<()>,
}

impl Owner {
    pub(super) fn new() -> Self {
        Self {
            opened: OnceLock::new(),
            opening: Mutex::new(()),
        }
    }

    pub(super) fn rows(&self, registry_path: &std::path::Path) -> Result<DbDirectorySubjects<'_>> {
        if self.opened.get().is_none() {
            let _guard = self
                .opening
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if self.opened.get().is_none() {
                // Resolve the original registry path on first access, exactly as the legacy
                // accessor did. Failed opens leave the cell empty so a later access retries.
                let path = std::fs::canonicalize(registry_path)
                    .wrap_err(super::db::DbError::RocksDb)?
                    .join(STORE);
                let _ = self.opened.set(open(&path)?);
            }
        }
        DbDirectorySubjects::new(self.opened.get().ok_or(super::db::DbError::RocksDb)?)
    }
}

/// Open the store, creating it on first use.
fn open(path: &std::path::Path) -> Result<rocksdb::DB> {
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
    fn new(db: &'a rocksdb::DB) -> Result<Self> {
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

#[cfg(test)]
mod tests {
    use super::super::db::Db;
    use super::*;
    use crate::directory_admission::CheckpointKind;

    fn subject_row() -> SubjectRow {
        SubjectRow {
            version: 1,
            anchor: [1; 32],
            checkpoint: Checkpoint {
                kind: CheckpointKind::CommittedPrefix,
                identity: [2; 32],
                anchor: [1; 32],
                head: Some([3; 32]),
                accepted: 1,
                retained: 1,
                evidence_digest: [4; 32],
                checked_time: (1700000000, 0),
                forked: false,
            },
            local: true,
        }
    }

    #[test]
    fn subjects_owner_is_lazy_and_concurrent_first_access_shares_one_handle() -> Result<()> {
        let dir = tempdir::TempDir::new("subjects-owner-concurrent")?;
        let path = dir.path().join("registry");
        let db = Db::open(&path)?;
        assert!(!path.join(STORE).exists());
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let db = &db;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        let rows = db.directory_subjects().unwrap();
                        rows.put(
                            "monad-testnet",
                            &[i; 33],
                            Some((&[i; 20], i as u64)),
                            &subject_row(),
                        )
                        .unwrap();
                        rows.db as *const rocksdb::DB as usize
                    })
                })
                .collect();
            let handles: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            assert!(handles.iter().all(|h| *h == handles[0]));
        });
        assert_eq!(db.directory_subjects()?.count()?, (8, 0));
        drop(db);
        assert_eq!(Db::open(&path)?.directory_subjects()?.count()?, (8, 0));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn subjects_owner_resolves_registry_path_on_first_access_and_retries() -> Result<()> {
        let dir = tempdir::TempDir::new("subjects-owner-path")?;
        let actual = dir.path().join("actual-registry");
        std::fs::create_dir(&actual)?;
        let link = dir.path().join("registry-link");
        std::os::unix::fs::symlink(&actual, &link)?;
        let db = Db::open(&link)?;
        std::fs::remove_file(&link)?;
        assert!(db.directory_subjects().is_err());
        assert!(!actual.join(STORE).exists());
        std::os::unix::fs::symlink(&actual, &link)?;
        assert_eq!(db.directory_subjects()?.count()?, (0, 0));
        assert!(actual.join(STORE).is_dir());
        Ok(())
    }

    #[test]
    fn subjects_owner_failed_open_retries_without_resetting_existing_data() -> Result<()> {
        let dir = tempdir::TempDir::new("subjects-owner-retry")?;
        let path = dir.path().join("registry");
        let db = Db::open(&path)?;
        let sidecar = path.join(STORE);
        // Obstruct the path with a file while retaining a populated sidecar elsewhere.
        let held = open(&sidecar)?;
        DbDirectorySubjects::new(&held)?.put(
            "monad-testnet",
            &[5; 33],
            Some((&[6; 20], 9)),
            &subject_row(),
        )?;
        drop(held);
        let retained = path.join("retained-sidecar");
        std::fs::rename(&sidecar, &retained)?;
        std::fs::write(&sidecar, b"obstruction")?;
        assert!(db.directory_subjects().is_err());
        assert!(db.directory_subjects().is_err());
        assert_eq!(std::fs::read(&sidecar)?, b"obstruction");
        std::fs::remove_file(&sidecar)?;
        std::fs::rename(&retained, &sidecar)?;
        let rows = db.directory_subjects()?;
        assert_eq!(rows.get("monad-testnet", &[5; 33])?, Some(subject_row()));
        assert_eq!(
            rows.subject_for_address("monad-testnet", &[6; 20])?,
            Some(vec![5; 33])
        );
        Ok(())
    }

    #[test]
    fn subjects_owner_preserves_exact_rows_indexes_and_forward_completion_on_reopen() -> Result<()>
    {
        let dir = tempdir::TempDir::new("subjects-owner-records")?;
        let path = dir.path().join("registry");
        let identity = [7; 32];
        let mut forward = ForwardRow {
            endpoint: "https://example.test/".into(),
            content_type: "application/cbor".into(),
            sender: "subject".into(),
            network: "monad-testnet".into(),
            created_ms: 1,
            attempts: 0,
            next_ms: 2,
            done: false,
            status: 0,
            response: String::new(),
            echo: serde_json::json!({"identity": "retained"}),
        };
        {
            let db = Db::open(&path)?;
            let rows = db.directory_subjects()?;
            rows.put(
                "monad-testnet",
                &[5; 33],
                Some((&[6; 20], 9)),
                &subject_row(),
            )?;
            assert_eq!(
                rows.db
                    .get_cf(rows.subjects, key("monad-testnet", &[5; 33]))?,
                Some(serde_json::to_vec(&subject_row())?)
            );
            assert_eq!(
                rows.first_accepted("monad-testnet", &[0; FIRST_ACCEPTED_POSITION_BYTES], 10)?,
                vec![(position(9, &[6; 20]), 9, [6; 20])]
            );
            assert!(rows.get("ethereum-sepolia", &[5; 33])?.is_none());
            rows.put_forward(&identity, &forward, Some(b"exact request"))?;
        }
        {
            let db = Db::open(&path)?;
            let rows = db.directory_subjects()?;
            assert_eq!(rows.forward(&identity)?, Some(forward.clone()));
            assert_eq!(
                rows.forward_body(&identity)?,
                Some(b"exact request".to_vec())
            );
            assert_eq!(
                rows.list("monad-testnet", None, 10)?,
                vec![(vec![5; 33], subject_row())]
            );
            forward.done = true;
            forward.status = 202;
            rows.put_forward(&identity, &forward, Some(b"must be deleted"))?;
        }
        {
            let db = Db::open(&path)?;
            let rows = db.directory_subjects()?;
            assert_eq!(rows.forward(&identity)?, Some(forward));
            assert_eq!(rows.forward_body(&identity)?, None);
            rows.delete_forward(&identity)?;
            assert!(rows.forwards()?.is_empty());
            rows.delete("monad-testnet", &[5; 33], &[6; 20], Some(9))?;
            assert_eq!(rows.count()?, (0, 0));
            assert!(rows
                .first_accepted("monad-testnet", &[0; FIRST_ACCEPTED_POSITION_BYTES], 10)?
                .is_empty());
        }
        Ok(())
    }

    #[test]
    fn subjects_owner_boundary_keeps_raw_lifecycle_out_of_general_db() {
        let source = include_str!("db.rs");
        assert!(!source.contains("directory_subjects_lock"));
        assert!(!source.contains("super::directory_subjects::open("));
        assert!(!source.contains("directory_subjects: std::sync::OnceLock"));
        assert!(source.contains("directory_subjects: super::directory_subjects::Owner"));
    }
}
