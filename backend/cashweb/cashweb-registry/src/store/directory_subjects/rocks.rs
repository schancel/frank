//! Concrete persistence for the directory-subjects owner, not a general relay KV interface.
//!
//! Each named mutation retains its existing atomic domain within this RocksDB sidecar. This
//! boundary provides neither cross-preview transactions nor compare-and-set/replica safety.
//! A future FDB owner still needs explicit cluster identity, transaction and concurrency policy.
use bitcoinsuite_error::Result;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode, WriteBatch, WriteOptions};

use super::{
    CF_DIRECTORY_ADDRESSES_V1, CF_DIRECTORY_FIRST_ACCEPTED_V1, CF_DIRECTORY_SUBJECTS_V1,
    CF_FORWARDS_V1, CF_FORWARD_BODIES_V1,
};
use crate::store::db::{DbError, CF};

pub(super) struct RocksDirectorySubjects {
    db: rocksdb::DB,
}

/// The two index entries that accompany a subject's first publication.
pub(super) struct FirstPublication<'a> {
    pub(super) address_key: &'a [u8],
    pub(super) subject: &'a [u8],
    pub(super) position_key: &'a [u8],
}

/// Existing forward-body transitions; final answers discard retained request bytes.
pub(super) enum ForwardBody<'a> {
    Keep,
    Put(&'a [u8]),
    Delete,
}

type StoredRow = (Box<[u8]>, Box<[u8]>);

impl RocksDirectorySubjects {
    pub(super) fn open(path: &std::path::Path) -> Result<Self> {
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
        Ok(Self {
            db: rocksdb::DB::open_cf_descriptors(&options, path, cfs)?,
        })
    }

    fn cf(&self, name: &str) -> Result<&CF> {
        Ok(self
            .db
            .cf_handle(name)
            .ok_or_else(|| DbError::NoSuchColumnFamily(name.to_string()))?)
    }

    pub(super) fn check_columns(&self) -> Result<()> {
        for name in [
            CF_DIRECTORY_SUBJECTS_V1,
            CF_DIRECTORY_ADDRESSES_V1,
            CF_DIRECTORY_FIRST_ACCEPTED_V1,
            CF_FORWARDS_V1,
            CF_FORWARD_BODIES_V1,
        ] {
            self.cf(name)?;
        }
        Ok(())
    }

    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self
            .db
            .get_pinned_cf(self.cf(table)?, key)?
            .map(|bytes| bytes.to_vec()))
    }

    pub(super) fn subject(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.get(CF_DIRECTORY_SUBJECTS_V1, key)
    }

    pub(super) fn address(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.get(CF_DIRECTORY_ADDRESSES_V1, key)
    }

    pub(super) fn forward(&self, identity: &[u8; 32]) -> Result<Option<Vec<u8>>> {
        self.get(CF_FORWARDS_V1, identity)
    }

    pub(super) fn forward_body(&self, identity: &[u8; 32]) -> Result<Option<Vec<u8>>> {
        self.get(CF_FORWARD_BODIES_V1, identity)
    }

    // Iterator items stay lazy: callers retain their existing decode, filter, and early-stop
    // order without materializing a network prefix or exposing native RocksDB handles.
    fn scan(
        &self,
        table: &str,
        mode: IteratorMode<'_>,
    ) -> Result<impl Iterator<Item = Result<StoredRow>> + '_> {
        Ok(self
            .db
            .iterator_cf(self.cf(table)?, mode)
            .map(|row| Ok(row?)))
    }

    pub(super) fn subjects(&self) -> Result<impl Iterator<Item = Result<StoredRow>> + '_> {
        self.scan(CF_DIRECTORY_SUBJECTS_V1, IteratorMode::Start)
    }

    pub(super) fn subjects_from(
        &self,
        from: &[u8],
    ) -> Result<impl Iterator<Item = Result<StoredRow>> + '_> {
        self.scan(
            CF_DIRECTORY_SUBJECTS_V1,
            IteratorMode::From(from, Direction::Forward),
        )
    }

    pub(super) fn first_accepted_from(
        &self,
        from: &[u8],
    ) -> Result<impl Iterator<Item = Result<StoredRow>> + '_> {
        self.scan(
            CF_DIRECTORY_FIRST_ACCEPTED_V1,
            IteratorMode::From(from, Direction::Forward),
        )
    }

    pub(super) fn forwards(&self) -> Result<impl Iterator<Item = Result<StoredRow>> + '_> {
        self.scan(CF_FORWARDS_V1, IteratorMode::Start)
    }

    pub(super) fn put_subject(
        &self,
        subject_key: &[u8],
        row: &[u8],
        first: Option<FirstPublication<'_>>,
    ) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_DIRECTORY_SUBJECTS_V1)?, subject_key, row);
        if let Some(first) = first {
            batch.put_cf(
                self.cf(CF_DIRECTORY_ADDRESSES_V1)?,
                first.address_key,
                first.subject,
            );
            batch.put_cf(
                self.cf(CF_DIRECTORY_FIRST_ACCEPTED_V1)?,
                first.position_key,
                [],
            );
        }
        self.write_synced(batch)
    }

    pub(super) fn delete_subject(
        &self,
        subject_key: &[u8],
        address_key: &[u8],
        position_key: Option<&[u8]>,
    ) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.cf(CF_DIRECTORY_SUBJECTS_V1)?, subject_key);
        batch.delete_cf(self.cf(CF_DIRECTORY_ADDRESSES_V1)?, address_key);
        if let Some(position_key) = position_key {
            batch.delete_cf(self.cf(CF_DIRECTORY_FIRST_ACCEPTED_V1)?, position_key);
        }
        self.write_synced(batch)
    }

    pub(super) fn put_forward(
        &self,
        identity: &[u8; 32],
        row: &[u8],
        body: ForwardBody<'_>,
    ) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_FORWARDS_V1)?, identity, row);
        match body {
            ForwardBody::Keep => {}
            ForwardBody::Put(body) => {
                batch.put_cf(self.cf(CF_FORWARD_BODIES_V1)?, identity, body);
            }
            ForwardBody::Delete => {
                batch.delete_cf(self.cf(CF_FORWARD_BODIES_V1)?, identity);
            }
        }
        self.write_synced(batch)
    }

    pub(super) fn delete_forward(&self, identity: &[u8; 32]) -> Result<()> {
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.cf(CF_FORWARDS_V1)?, identity);
        batch.delete_cf(self.cf(CF_FORWARD_BODIES_V1)?, identity);
        // Preserve the existing non-synced deletion policy for finalized/history forwards.
        self.db.write(batch)?;
        Ok(())
    }

    fn write_synced(&self, batch: WriteBatch) -> Result<()> {
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        Ok(())
    }
}
