//! Lazy, isolated preview ownership. Never registers preview CFs in the legacy registry.
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
};

use rocksdb::{ColumnFamily, ColumnFamilyDescriptor, Options};

use crate::directory_admission::{AdmissionError, OpenMode};

pub(super) const SIDECAR: &str = "directory-preview-v1.rocksdb";
pub(super) const CF_DIRECTORY_PREVIEW_ENROLLMENT_V1: &str = "directory_preview_enrollment_v1";
pub(super) const CF_DIRECTORY_PREVIEW_HEAD_V1: &str = "directory_preview_head_v1";
pub(super) const CF_DIRECTORY_PREVIEW_EVIDENCE_V1: &str = "directory_preview_evidence_v1";

type Result<T> = std::result::Result<T, AdmissionError>;

/// The legacy owner remembers only a path and lazily acquired sidecar owner.
pub(super) struct Owner {
    path: PathBuf,
    opened: Mutex<Option<Arc<Store>>>,
}

impl Owner {
    pub(super) fn new(registry: PathBuf) -> Self {
        Self {
            path: registry.join(SIDECAR),
            opened: Mutex::new(None),
        }
    }

    pub(super) fn open(&self, mode: OpenMode) -> Result<Arc<Store>> {
        let mut opened = self
            .opened
            .lock()
            .map_err(|_| AdmissionError::Unavailable)?;
        let exists = match std::fs::symlink_metadata(&self.path) {
            Ok(meta) if meta.file_type().is_dir() => true,
            Ok(_) => return Err(AdmissionError::Unavailable),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err(AdmissionError::Unavailable),
        };
        if exists
            && !std::fs::symlink_metadata(self.path.join("CURRENT"))
                .is_ok_and(|meta| meta.file_type().is_file())
        {
            return Err(AdmissionError::Unavailable);
        }
        if let Some(store) = opened.as_ref() {
            if !exists || !self.path.join("CURRENT").is_file() {
                return Err(AdmissionError::Unavailable);
            }
            return Ok(Arc::clone(store));
        }
        let create = !exists && matches!(mode, OpenMode::NewEnrollment);
        if !exists && !create {
            return Err(AdmissionError::Unavailable);
        }
        if create {
            // Reserve only the absent sidecar. Never repair/reset an existing empty or corrupt
            // directory, including an interrupted first creation; preserve it for investigation.
            std::fs::create_dir(&self.path).map_err(|_| AdmissionError::Unavailable)?;
        }
        let mut options = Options::default();
        options.create_if_missing(create);
        options.create_missing_column_families(create);
        let cfs = [
            CF_DIRECTORY_PREVIEW_ENROLLMENT_V1,
            CF_DIRECTORY_PREVIEW_HEAD_V1,
            CF_DIRECTORY_PREVIEW_EVIDENCE_V1,
        ]
        .iter()
        .map(|name| ColumnFamilyDescriptor::new(*name, Options::default()));
        let db = rocksdb::DB::open_cf_descriptors(&options, &self.path, cfs)
            .map_err(|_| AdmissionError::Unavailable)?;
        let store = Arc::new(Store {
            db,
            admission: Mutex::new(()),
        });
        *opened = Some(Arc::clone(&store));
        Ok(store)
    }
}

/// One RocksDB process lock and one admission mutex cover every subject in the sidecar.
pub(super) struct Store {
    db: rocksdb::DB,
    admission: Mutex<()>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DirectoryPreviewStore { .. }")
    }
}

impl Store {
    pub(super) fn cf(&self, name: &str) -> Result<&ColumnFamily> {
        self.db.cf_handle(name).ok_or(AdmissionError::Unavailable)
    }
    pub(super) fn get(
        &self,
        cf: &ColumnFamily,
        key: &[u8],
    ) -> Result<Option<rocksdb::DBPinnableSlice<'_>>> {
        self.db
            .get_pinned_cf(cf, key)
            .map_err(|_| AdmissionError::Unavailable)
    }
    pub(super) fn rocksdb(&self) -> &rocksdb::DB {
        &self.db
    }
    pub(super) fn lock_directory_preview(&self) -> Result<MutexGuard<'_, ()>> {
        self.admission
            .lock()
            .map_err(|_| AdmissionError::Unavailable)
    }
}
