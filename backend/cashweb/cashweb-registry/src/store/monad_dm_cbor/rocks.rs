//! Native persistence for the canonical message owner. Named locked operations include their
//! reads, decisions and synced writes; this is a process-local Rocks boundary, not replica CAS.
use std::{path::PathBuf, sync::Mutex};

use rocksdb::{Direction, IteratorMode, Options, ReadOptions, WriteBatch, WriteOptions};

use super::{CanonicalError, Result};

#[derive(Debug)]
pub(super) struct RocksCanonicalMessages {
    path: PathBuf,
    db: Mutex<Option<rocksdb::DB>>,
}

impl RocksCanonicalMessages {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            db: Mutex::new(None),
        }
    }

    fn with<T>(
        &self,
        create: bool,
        action: impl FnOnce(&rocksdb::DB) -> Result<T>,
    ) -> Result<Option<T>> {
        let mut guard = self.db.lock().map_err(|_| CanonicalError::Unavailable)?;
        if guard.is_none() {
            match std::fs::symlink_metadata(&self.path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(CanonicalError::Unavailable)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
                    return Ok(None)
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(CanonicalError::Unavailable)
                }
                _ => {}
            }
            let mut options = Options::default();
            options.create_if_missing(create);
            let opened =
                rocksdb::DB::open(&options, &self.path).map_err(|_| CanonicalError::Unavailable)?;
            *guard = Some(opened);
        }
        if !self.path.join("CURRENT").is_file() {
            return Err(CanonicalError::Unavailable);
        }
        action(guard.as_ref().ok_or(CanonicalError::Unavailable)?).map(Some)
    }

    // The closure and all lazy iterators finish before the process lock can be released.
    pub(super) fn read_messages<T>(
        &self,
        read: impl FnOnce(&MessageRead<'_>) -> Result<T>,
    ) -> Result<Option<T>> {
        self.with(false, |db| read(&MessageRead { db }))
    }

    pub(super) fn admit_message<T>(
        &self,
        admit: impl FnOnce(Admission<'_>) -> Result<T>,
    ) -> Result<T> {
        self.with(true, |db| admit(Admission { db }))?
            .ok_or(CanonicalError::Unavailable)
    }

    pub(super) fn consume_challenge<T>(
        &self,
        consume: impl FnOnce(ChallengeUse<'_>) -> Result<T>,
    ) -> Result<T> {
        self.with(true, |db| {
            consume(ChallengeUse {
                db,
                expired: WriteBatch::default(),
            })
        })?
        .ok_or(CanonicalError::Unavailable)
    }

    pub(super) fn notification_policy(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.with(false, |db| {
            db.get(key).map_err(|_| CanonicalError::Unavailable)
        })
        .map(Option::flatten)
    }

    pub(super) fn replace_notification_policy(&self, key: &[u8], row: &[u8]) -> Result<()> {
        self.with(true, |db| {
            let mut batch = WriteBatch::default();
            batch.put(key, row);
            write(db, batch)
        })?
        .ok_or(CanonicalError::Unavailable)
    }

    pub(super) fn initialize_vapid<T>(
        &self,
        initialize: impl FnOnce(VapidInitialization<'_>) -> Result<T>,
    ) -> Result<T> {
        self.with(true, |db| initialize(VapidInitialization { db }))?
            .ok_or(CanonicalError::Unavailable)
    }

    pub(super) fn estimated_live_data_size_bytes(&self) -> Result<Option<u64>> {
        self.with(false, |db| {
            db.property_int_value("rocksdb.estimate-live-data-size")
                .map_err(|_| CanonicalError::Unavailable)?
                .ok_or(CanonicalError::Unavailable)
        })
    }
}

pub(super) struct MessageRead<'a> {
    db: &'a rocksdb::DB,
}
impl MessageRead<'_> {
    pub(super) fn message_row(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.db.get(key).map_err(|_| CanonicalError::Unavailable)
    }

    pub(super) fn mailbox_rows(&self, start: &[u8], upper: Vec<u8>) -> Rows<'_> {
        let mut options = ReadOptions::default();
        options.set_iterate_upper_bound(upper);
        Rows(
            self.db
                .iterator_opt(IteratorMode::From(start, Direction::Forward), options),
        )
    }
}

/// Only the admission command can check used payments/last time and commit delivery rows.
pub(super) struct Admission<'a> {
    db: &'a rocksdb::DB,
}
impl Admission<'_> {
    pub(super) fn messages(&self) -> MessageRead<'_> {
        MessageRead { db: self.db }
    }

    pub(super) fn payment_used(&self, key: &[u8]) -> Result<bool> {
        self.db
            .get_pinned(key)
            .map(|row| row.is_some())
            .map_err(|_| CanonicalError::Unavailable)
    }

    pub(super) fn last_delivery(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.db
            .get_pinned(key)
            .map(|row| row.map(|bytes| bytes.to_vec()))
            .map_err(|_| CanonicalError::Unavailable)
    }

    pub(super) fn commit_delivery(self, delivery: Delivery<'_>) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.put(delivery.last_delivery_key, delivery.delivered_at);
        for key in delivery.payment_keys {
            batch.put(key, delivery.hash);
        }
        batch.put(delivery.row_key, delivery.row);
        batch.put(delivery.recipient_key, delivery.hash);
        if let Some(key) = delivery.sender_key {
            batch.put(key, delivery.hash);
        }
        write(self.db, batch)
    }
}

/// Encoded owner records; key layout and row serialization remain on the facade.
pub(super) struct Delivery<'a> {
    pub(super) last_delivery_key: &'a [u8],
    pub(super) delivered_at: [u8; 8],
    pub(super) payment_keys: Vec<Vec<u8>>,
    pub(super) hash: &'a [u8; 32],
    pub(super) row_key: &'a [u8],
    pub(super) row: &'a [u8],
    pub(super) recipient_key: &'a [u8],
    pub(super) sender_key: Option<&'a [u8]>,
}

/// Pruning is staged until the complete scan/capacity decision succeeds. Dropping on any
/// decode/scan failure applies neither expired deletions nor the new consumed challenge.
pub(super) struct ChallengeUse<'a> {
    db: &'a rocksdb::DB,
    expired: WriteBatch,
}
impl<'a> ChallengeUse<'a> {
    pub(super) fn nonce_used(&self, key: &[u8]) -> Result<bool> {
        self.db
            .get(key)
            .map(|row| row.is_some())
            .map_err(|_| CanonicalError::Unavailable)
    }

    pub(super) fn used_challenges(&self, lower: Vec<u8>, upper: Vec<u8>) -> Rows<'a> {
        let mut options = ReadOptions::default();
        options.set_iterate_lower_bound(lower);
        options.set_iterate_upper_bound(upper);
        Rows(self.db.iterator_opt(IteratorMode::Start, options))
    }

    pub(super) fn prune_expired(&mut self, key: &[u8]) {
        self.expired.delete(key);
    }

    pub(super) fn commit_pruning(self) -> Result<()> {
        write(self.db, self.expired)
    }

    pub(super) fn commit_consumption(mut self, key: &[u8], expires: [u8; 8]) -> Result<()> {
        self.expired.put(key, expires);
        write(self.db, self.expired)
    }
}

pub(super) struct VapidInitialization<'a> {
    db: &'a rocksdb::DB,
}
impl VapidInitialization<'_> {
    pub(super) fn stored_key(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.db.get(key).map_err(|_| CanonicalError::Unavailable)
    }
    pub(super) fn store_generated_key(self, key: &[u8], bytes: &[u8; 32]) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.put(key, bytes);
        write(self.db, batch)
    }
}

/// The native iterator never leaves this module; each row/error is pulled only on demand.
pub(super) struct Rows<'a>(rocksdb::DBIteratorWithThreadMode<'a, rocksdb::DB>);
impl Iterator for Rows<'_> {
    type Item = Result<(Box<[u8]>, Box<[u8]>)>;
    fn next(&mut self) -> Option<Self::Item> {
        self.0
            .next()
            .map(|row| row.map_err(|_| CanonicalError::Unavailable))
    }
}

fn write(db: &rocksdb::DB, batch: WriteBatch) -> Result<()> {
    let mut options = WriteOptions::default();
    options.set_sync(true);
    db.write_opt(batch, &options)
        .map_err(|_| CanonicalError::Unavailable)
}
