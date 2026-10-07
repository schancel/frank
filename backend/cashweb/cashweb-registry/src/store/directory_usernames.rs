//! Unique username index and tombstone store for domain-level identity routing.
//!
//! Enforces First-Come, First-Served (FCFS) uniqueness for routable handles (e.g. `alice`),
//! prevents collisions, and records tombstones upon de-registration to prevent handle recycling.

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use rocksdb::{ColumnFamilyDescriptor, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::db::{Db, CF};

/// Backward-compatible RocksDB column family name for routable username records.
pub const CF_DIRECTORY_USERNAMES: &str = "directory_usernames";
/// Ticket 1.1 Column Family constant alias for username records (`cf_usernames`).
pub const CF_USERNAMES: &str = CF_DIRECTORY_USERNAMES;

/// Errors specifically related to username registration and uniqueness.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum UsernameError {
    /// The username handle format is invalid (length, character set).
    #[invalid_client_input()]
    #[error("Invalid username handle format: {0}")]
    InvalidFormat(String),

    /// The username is already registered to a different account.
    #[invalid_client_input()]
    #[error("Username '{0}' is already registered to account 0x{1}")]
    NameCollision(String, String),

    /// The username is in a cooldown tombstone period and cannot be claimed.
    #[invalid_client_input()]
    #[error("Username '{0}' has been deactivated and is tombstoned until {1}")]
    Tombstoned(String, i64),

    /// Conflict error when a handle is already taken or tombstoned.
    #[invalid_client_input()]
    #[error("Conflict: {0}")]
    Conflict(String),

    /// Remote RESP / Redis store error or connection failure.
    #[critical()]
    #[error("RESP store error: {0}")]
    RespError(String),
}

/// Abstract store for unique routable usernames, claim verification, and tombstone lifecycle.
///
/// Implemented by [`DbDirectoryUsernames`] for standalone embedded RocksDB, and by
/// [`crate::store::resp_username::RespUsernameStore`] for clustered Apache Kvrocks / Redis-XC deployments.
pub trait UsernameStore: std::fmt::Debug + Send + Sync {
    /// Fetch a username record by canonical name.
    fn get(&self, raw_username: &str) -> Result<Option<UsernameRecord>>;

    /// Attempt to claim or re-bind a username for an account address.
    ///
    /// Fails with [`UsernameError::NameCollision`] if owned by another account.
    /// Fails with [`UsernameError::Tombstoned`] if tombstone cooldown is still active.
    fn claim(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        stamp_key: Option<Vec<u8>>,
        now_ms: i64,
    ) -> Result<UsernameClaimResult>;

    /// Mark a username as tombstoned when released or deactivated.
    fn tombstone(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool>;

    /// Rename an active username to a new handle for the same account.
    ///
    /// Claims the `new_username` for `account_address`, and transitions `old_username`
    /// into a `Moved` state with a redirect pointer to `new_username` and a tombstone cooldown.
    fn rename(
        &self,
        old_username: &str,
        new_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<()>;

    /// Register a username for an account address with tombstone protection.
    ///
    /// - If name does not exist -> insert as Active, return Ok(()).
    /// - If name exists with same address -> update updated_at, return Ok(()).
    /// - If name exists with different address and status is Active -> return Conflict (Handle taken).
    /// - If name exists and status is Tombstoned:
    ///   - If now < tombstone_expires_at -> return Conflict (Handle tombstoned).
    ///   - If now >= tombstone_expires_at -> reclaim name: overwrite with new address, status Active, return Ok(()).
    fn register_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
    ) -> std::result::Result<(), UsernameError>;

    /// Tombstone a username with cooldown protection.
    ///
    /// If name owned by address -> set status to Tombstoned, tombstone_expires_at = now + cooldown_seconds.
    fn tombstone_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
        cooldown_seconds: i64,
    ) -> std::result::Result<bool, UsernameError>;
}

use self::UsernameError::*;

/// The active, tombstoned, or moved state of a username.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UsernameStatus {
    /// Active handle bound to an account.
    Active,
    /// Handle was released/deleted and is cooling off to prevent recycling.
    Tombstoned,
    /// Handle was renamed/migrated to another username and redirects there.
    Moved,
}

impl Default for UsernameStatus {
    fn default() -> Self {
        UsernameStatus::Active
    }
}

/// Durable record for a username.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct UsernameRecord {
    /// Canonical lowercase username handle.
    #[serde(default)]
    pub username: String,
    /// 20-byte raw account address.
    pub account_address: [u8; 20],
    /// Optional stamp public key.
    #[serde(default)]
    pub stamp_key: Option<Vec<u8>>,
    /// Active, tombstoned, or moved state.
    pub status: UsernameStatus,
    /// Timestamp of last modification in seconds / milliseconds.
    #[serde(default)]
    pub updated_at: i64,
    /// Expiration timestamp in seconds / milliseconds for tombstone cooldown.
    #[serde(default)]
    pub tombstone_expires_at: i64,
    /// Timestamp of last modification in milliseconds.
    #[serde(default)]
    pub updated_at_ms: i64,
    /// Expiration timestamp in milliseconds for tombstone cooldown.
    #[serde(default)]
    pub tombstone_expires_at_ms: Option<i64>,
    /// Optional redirect pointer to new username when status is Moved.
    #[serde(default)]
    pub redirect_to: Option<String>,
}

impl UsernameRecord {
    /// Construct a new username record with account address and status.
    pub fn new(
        username: impl Into<String>,
        account_address: [u8; 20],
        status: UsernameStatus,
        updated_at: i64,
        tombstone_expires_at: i64,
    ) -> Self {
        let name = username.into();
        Self {
            username: name,
            account_address,
            stamp_key: None,
            status,
            updated_at,
            tombstone_expires_at,
            updated_at_ms: updated_at,
            tombstone_expires_at_ms: if tombstone_expires_at > 0 {
                Some(tombstone_expires_at)
            } else {
                None
            },
            redirect_to: None,
        }
    }
}

/// Result of attempting to claim a username.
#[derive(Debug, PartialEq, Eq)]
pub enum UsernameClaimResult {
    /// Successfully claimed the handle.
    Claimed,
    /// Handle was already owned by this same account; updated metadata.
    AlreadyOwned,
}

/// RocksDB store for unique routable usernames and tombstones.
pub struct DbDirectoryUsernames<'a> {
    db: &'a Db,
    cf: &'a CF,
}

impl<'a> DbDirectoryUsernames<'a> {
    pub(crate) fn new(db: &'a Db) -> Self {
        let cf = db.cf(CF_DIRECTORY_USERNAMES).unwrap();
        Self { db, cf }
    }

    pub(crate) fn add_cfs(cfs: &mut Vec<ColumnFamilyDescriptor>) {
        cfs.push(ColumnFamilyDescriptor::new(
            CF_DIRECTORY_USERNAMES,
            rocksdb::Options::default(),
        ));
    }

    /// Normalizes and validates username syntax:
    /// - 3 to 32 characters
    /// - Lowercase ASCII alphanumeric plus '-' and '_'
    /// - Must start with an alphanumeric character
    pub fn validate_and_normalize(raw: &str) -> std::result::Result<String, UsernameError> {
        let normalized = raw.trim().to_ascii_lowercase();
        let len = normalized.len();
        if !(3..=32).contains(&len) {
            return Err(InvalidFormat(format!(
                "length must be between 3 and 32 characters, got {}",
                len
            )));
        }

        let first = normalized.chars().next().unwrap();
        if !first.is_ascii_alphanumeric() {
            return Err(InvalidFormat(
                "username must start with an alphanumeric character".to_string(),
            ));
        }

        for ch in normalized.chars() {
            if !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' {
                return Err(InvalidFormat(format!(
                    "character '{}' is not allowed in username",
                    ch
                )));
            }
        }

        Ok(normalized)
    }

    /// Fetch a username record by canonical name.
    pub fn get(&self, raw_username: &str) -> Result<Option<UsernameRecord>> {
        let normalized = match Self::validate_and_normalize(raw_username) {
            Ok(n) => n,
            Err(_) => return Ok(None),
        };

        let slice = match self
            .db
            .rocksdb()
            .get_cf(self.cf, normalized.as_bytes())
            .wrap_err(crate::store::db::DbError::RocksDb)?
        {
            Some(s) => s,
            None => return Ok(None),
        };

        let mut record: UsernameRecord =
            serde_json::from_slice(&slice).wrap_err(crate::store::db::DbError::RocksDb)?;
        if record.updated_at == 0 && record.updated_at_ms != 0 {
            record.updated_at = record.updated_at_ms;
        }
        if record.updated_at_ms == 0 && record.updated_at != 0 {
            record.updated_at_ms = record.updated_at;
        }
        if record.tombstone_expires_at == 0 {
            if let Some(exp) = record.tombstone_expires_at_ms {
                record.tombstone_expires_at = exp;
            }
        }
        if record.tombstone_expires_at_ms.is_none() && record.tombstone_expires_at > 0 {
            record.tombstone_expires_at_ms = Some(record.tombstone_expires_at);
        }
        Ok(Some(record))
    }

    /// Attempt to claim or re-bind a username for an account address.
    ///
    /// Fails with `NameCollision` if owned by another account.
    /// Fails with `Tombstoned` if tombstone cooldown is still active.
    pub fn claim(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        stamp_key: Option<Vec<u8>>,
        now_ms: i64,
    ) -> Result<UsernameClaimResult> {
        let normalized = Self::validate_and_normalize(raw_username)?;

        if let Some(existing) = self.get(&normalized)? {
            match existing.status {
                UsernameStatus::Active => {
                    if existing.account_address != *account_address {
                        let current_hex = hex::encode(existing.account_address);
                        return Err(NameCollision(normalized, current_hex).into());
                    }
                    // Same account updating stamp_key or metadata
                    let updated = UsernameRecord {
                        username: normalized.clone(),
                        account_address: *account_address,
                        stamp_key,
                        status: UsernameStatus::Active,
                        updated_at: now_ms,
                        tombstone_expires_at: 0,
                        updated_at_ms: now_ms,
                        tombstone_expires_at_ms: None,
                        redirect_to: None,
                    };
                    self.put_record(&updated)?;
                    return Ok(UsernameClaimResult::AlreadyOwned);
                }
                UsernameStatus::Tombstoned | UsernameStatus::Moved => {
                    let expires_at = existing
                        .tombstone_expires_at
                        .max(existing.tombstone_expires_at_ms.unwrap_or(0));
                    if now_ms < expires_at {
                        return Err(Tombstoned(normalized, expires_at).into());
                    }
                    // Cooldown expired, allow fresh claim
                }
            }
        }

        let record = UsernameRecord {
            username: normalized,
            account_address: *account_address,
            stamp_key,
            status: UsernameStatus::Active,
            updated_at: now_ms,
            tombstone_expires_at: 0,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: None,
            redirect_to: None,
        };
        self.put_record(&record)?;

        Ok(UsernameClaimResult::Claimed)
    }

    /// Mark a username as tombstoned when released or deactivated.
    pub fn tombstone(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool> {
        let normalized = Self::validate_and_normalize(raw_username)?;
        let existing = match self.get(&normalized)? {
            Some(e) => e,
            None => return Ok(false),
        };

        if existing.account_address != *account_address {
            return Ok(false); // Only the owner can tombstone
        }

        let tombstone_record = UsernameRecord {
            username: normalized,
            account_address: *account_address,
            stamp_key: existing.stamp_key,
            status: UsernameStatus::Tombstoned,
            updated_at: now_ms,
            tombstone_expires_at: now_ms + cooldown_duration_ms,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: Some(now_ms + cooldown_duration_ms),
            redirect_to: None,
        };
        self.put_record(&tombstone_record)?;
        Ok(true)
    }

    /// Rename an active username to a new handle for the same account.
    ///
    /// Claims the `new_username` for `account_address`, and transitions `old_username`
    /// into a `Moved` state with a redirect pointer to `new_username` and a tombstone cooldown.
    pub fn rename(
        &self,
        old_username: &str,
        new_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        let old_norm = Self::validate_and_normalize(old_username)?;
        let new_norm = Self::validate_and_normalize(new_username)?;

        if old_norm == new_norm {
            return Ok(());
        }

        let existing_old = match self.get(&old_norm)? {
            Some(r) => r,
            None => {
                return Err(UsernameError::InvalidFormat(format!(
                    "Username '{}' does not exist",
                    old_norm
                ))
                .into());
            }
        };

        if existing_old.account_address != *account_address {
            let current_hex = hex::encode(existing_old.account_address);
            return Err(UsernameError::NameCollision(old_norm, current_hex).into());
        }

        // 1. Claim new username (fails on collision with other accounts or active tombstones)
        self.claim(
            &new_norm,
            account_address,
            existing_old.stamp_key.clone(),
            now_ms,
        )?;

        // 2. Put old username into Moved state with redirect to new_norm
        let moved_record = UsernameRecord {
            username: old_norm,
            account_address: *account_address,
            stamp_key: existing_old.stamp_key,
            status: UsernameStatus::Moved,
            updated_at: now_ms,
            tombstone_expires_at: now_ms + cooldown_duration_ms,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: Some(now_ms + cooldown_duration_ms),
            redirect_to: Some(new_norm),
        };
        self.put_record(&moved_record)?;

        Ok(())
    }

    /// Attempt to register a username with first-come, first-served uniqueness and tombstone protection.
    ///
    /// - If name does not exist -> insert as Active, return Ok(()).
    /// - If name exists with same address -> update updated_at, return Ok(()).
    /// - If name exists with different address and status is Active -> return Conflict (Handle taken).
    /// - If name exists and status is Tombstoned:
    ///   - If now < tombstone_expires_at -> return Conflict (Handle tombstoned).
    ///   - If now >= tombstone_expires_at -> reclaim name: overwrite with new address, status Active, return Ok(()).
    pub fn register_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
    ) -> std::result::Result<(), UsernameError> {
        let normalized = Self::validate_and_normalize(username)?;

        if let Ok(Some(existing)) = self.get(&normalized) {
            match existing.status {
                UsernameStatus::Active => {
                    if existing.account_address != address {
                        return Err(UsernameError::Conflict("Handle taken".to_string()));
                    }
                    let updated = UsernameRecord {
                        username: normalized.clone(),
                        account_address: address,
                        stamp_key: existing.stamp_key,
                        status: UsernameStatus::Active,
                        updated_at: now,
                        tombstone_expires_at: 0,
                        updated_at_ms: now,
                        tombstone_expires_at_ms: None,
                        redirect_to: None,
                    };
                    self.put_record(&updated)
                        .map_err(|e| UsernameError::Conflict(e.to_string()))?;
                    return Ok(());
                }
                UsernameStatus::Tombstoned | UsernameStatus::Moved => {
                    let expires_at = existing
                        .tombstone_expires_at
                        .max(existing.tombstone_expires_at_ms.unwrap_or(0));
                    if now < expires_at {
                        return Err(UsernameError::Conflict("Handle tombstoned".to_string()));
                    }
                    let reclaimed = UsernameRecord {
                        username: normalized.clone(),
                        account_address: address,
                        stamp_key: None,
                        status: UsernameStatus::Active,
                        updated_at: now,
                        tombstone_expires_at: 0,
                        updated_at_ms: now,
                        tombstone_expires_at_ms: None,
                        redirect_to: None,
                    };
                    self.put_record(&reclaimed)
                        .map_err(|e| UsernameError::Conflict(e.to_string()))?;
                    return Ok(());
                }
            }
        }

        let record = UsernameRecord {
            username: normalized,
            account_address: address,
            stamp_key: None,
            status: UsernameStatus::Active,
            updated_at: now,
            tombstone_expires_at: 0,
            updated_at_ms: now,
            tombstone_expires_at_ms: None,
            redirect_to: None,
        };
        self.put_record(&record)
            .map_err(|e| UsernameError::Conflict(e.to_string()))?;
        Ok(())
    }

    /// Mark a username as tombstoned with cooldown expiration.
    ///
    /// If name owned by address -> set status to Tombstoned, tombstone_expires_at = now + cooldown_seconds.
    pub fn tombstone_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
        cooldown_seconds: i64,
    ) -> std::result::Result<bool, UsernameError> {
        let normalized = Self::validate_and_normalize(username)?;
        let existing = match self.get(&normalized) {
            Ok(Some(e)) => e,
            Ok(None) => return Ok(false),
            Err(e) => return Err(UsernameError::Conflict(e.to_string())),
        };

        if existing.account_address != address {
            return Ok(false);
        }

        let expires = now + cooldown_seconds;
        let tombstone_record = UsernameRecord {
            username: normalized,
            account_address: address,
            stamp_key: existing.stamp_key,
            status: UsernameStatus::Tombstoned,
            updated_at: now,
            tombstone_expires_at: expires,
            updated_at_ms: now,
            tombstone_expires_at_ms: Some(expires),
            redirect_to: None,
        };
        self.put_record(&tombstone_record)
            .map_err(|e| UsernameError::Conflict(e.to_string()))?;
        Ok(true)
    }

    fn put_record(&self, record: &UsernameRecord) -> Result<()> {
        let mut rec = record.clone();
        if rec.updated_at == 0 && rec.updated_at_ms != 0 {
            rec.updated_at = rec.updated_at_ms;
        }
        if rec.updated_at_ms == 0 && rec.updated_at != 0 {
            rec.updated_at_ms = rec.updated_at;
        }
        if rec.tombstone_expires_at == 0 {
            if let Some(exp) = rec.tombstone_expires_at_ms {
                rec.tombstone_expires_at = exp;
            }
        }
        if rec.tombstone_expires_at_ms.is_none() && rec.tombstone_expires_at > 0 {
            rec.tombstone_expires_at_ms = Some(rec.tombstone_expires_at);
        }
        let serialized = serde_json::to_vec(&rec).wrap_err(crate::store::db::DbError::RocksDb)?;
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf, rec.username.as_bytes(), serialized);
        let mut write_options = WriteOptions::default();
        write_options.set_sync(false);
        self.db
            .rocksdb()
            .write_opt(batch, &write_options)
            .wrap_err(crate::store::db::DbError::RocksDb)?;
        Ok(())
    }
}

impl std::fmt::Debug for DbDirectoryUsernames<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbDirectoryUsernames {{ .. }}")
    }
}

// RocksDB column family handles are immutable and thread-safe for concurrent reads and writes.
unsafe impl Send for DbDirectoryUsernames<'_> {}
unsafe impl Sync for DbDirectoryUsernames<'_> {}

impl UsernameStore for DbDirectoryUsernames<'_> {
    fn get(&self, raw_username: &str) -> Result<Option<UsernameRecord>> {
        self.get(raw_username)
    }

    fn claim(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        stamp_key: Option<Vec<u8>>,
        now_ms: i64,
    ) -> Result<UsernameClaimResult> {
        self.claim(raw_username, account_address, stamp_key, now_ms)
    }

    fn tombstone(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool> {
        self.tombstone(raw_username, account_address, cooldown_duration_ms, now_ms)
    }

    fn rename(
        &self,
        old_username: &str,
        new_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        self.rename(
            old_username,
            new_username,
            account_address,
            cooldown_duration_ms,
            now_ms,
        )
    }

    fn register_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
    ) -> std::result::Result<(), UsernameError> {
        self.register_username(username, address, now)
    }

    fn tombstone_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
        cooldown_seconds: i64,
    ) -> std::result::Result<bool, UsernameError> {
        self.tombstone_username(username, address, now, cooldown_seconds)
    }
}

impl<T: ?Sized + UsernameStore> UsernameStore for Box<T> {
    fn get(&self, raw_username: &str) -> Result<Option<UsernameRecord>> {
        (**self).get(raw_username)
    }

    fn claim(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        stamp_key: Option<Vec<u8>>,
        now_ms: i64,
    ) -> Result<UsernameClaimResult> {
        (**self).claim(raw_username, account_address, stamp_key, now_ms)
    }

    fn tombstone(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool> {
        (**self).tombstone(raw_username, account_address, cooldown_duration_ms, now_ms)
    }

    fn rename(
        &self,
        old_username: &str,
        new_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        (**self).rename(
            old_username,
            new_username,
            account_address,
            cooldown_duration_ms,
            now_ms,
        )
    }

    fn register_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
    ) -> std::result::Result<(), UsernameError> {
        (**self).register_username(username, address, now)
    }

    fn tombstone_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
        cooldown_seconds: i64,
    ) -> std::result::Result<bool, UsernameError> {
        (**self).tombstone_username(username, address, now, cooldown_seconds)
    }
}

impl<T: ?Sized + UsernameStore> UsernameStore for std::sync::Arc<T> {
    fn get(&self, raw_username: &str) -> Result<Option<UsernameRecord>> {
        (**self).get(raw_username)
    }

    fn claim(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        stamp_key: Option<Vec<u8>>,
        now_ms: i64,
    ) -> Result<UsernameClaimResult> {
        (**self).claim(raw_username, account_address, stamp_key, now_ms)
    }

    fn tombstone(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool> {
        (**self).tombstone(raw_username, account_address, cooldown_duration_ms, now_ms)
    }

    fn rename(
        &self,
        old_username: &str,
        new_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        (**self).rename(
            old_username,
            new_username,
            account_address,
            cooldown_duration_ms,
            now_ms,
        )
    }

    fn register_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
    ) -> std::result::Result<(), UsernameError> {
        (**self).register_username(username, address, now)
    }

    fn tombstone_username(
        &self,
        username: &str,
        address: [u8; 20],
        now: i64,
        cooldown_seconds: i64,
    ) -> std::result::Result<bool, UsernameError> {
        (**self).tombstone_username(username, address, now, cooldown_seconds)
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_error::Result;
    use tempdir::TempDir;

    use super::*;
    use crate::store::db::Db;

    #[test]
    fn test_username_validation() {
        assert_eq!(
            DbDirectoryUsernames::validate_and_normalize("alice").unwrap(),
            "alice"
        );
        assert_eq!(
            DbDirectoryUsernames::validate_and_normalize("  Bob-123  ").unwrap(),
            "bob-123"
        );
        assert_eq!(
            DbDirectoryUsernames::validate_and_normalize("charlie_dev").unwrap(),
            "charlie_dev"
        );

        // Too short (< 3)
        assert!(DbDirectoryUsernames::validate_and_normalize("al").is_err());
        // Too long (> 32)
        assert!(DbDirectoryUsernames::validate_and_normalize(&"a".repeat(33)).is_err());
        // Must start with alphanumeric
        assert!(DbDirectoryUsernames::validate_and_normalize("-alice").is_err());
        assert!(DbDirectoryUsernames::validate_and_normalize("_alice").is_err());
        // Invalid characters
        assert!(DbDirectoryUsernames::validate_and_normalize("alice@frank").is_err());
        assert!(DbDirectoryUsernames::validate_and_normalize("alice.smith").is_err());
    }

    #[test]
    fn test_claim_collision_and_tombstone_lifecycle() -> Result<()> {
        let tempdir = TempDir::new("test-db-usernames")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.directory_usernames();

        let alice_addr = [1u8; 20];
        let mallory_addr = [2u8; 20];
        let now = 1000000;

        // 1. Alice claims "alice"
        let res = store.claim("alice", &alice_addr, Some(vec![1, 2, 3]), now)?;
        assert_eq!(res, UsernameClaimResult::Claimed);

        let record = store.get("alice")?.expect("record should exist");
        assert_eq!(record.status, UsernameStatus::Active);
        assert_eq!(record.account_address, alice_addr);

        // 2. Alice updates metadata for "alice" -> AlreadyOwned
        let res2 = store.claim("alice", &alice_addr, Some(vec![4, 5, 6]), now + 10)?;
        assert_eq!(res2, UsernameClaimResult::AlreadyOwned);

        // 3. Mallory tries to claim "alice" -> Collision Error!
        let collision_err = store.claim("alice", &mallory_addr, None, now + 20);
        assert!(collision_err.is_err());

        // 4. Alice deactivates and tombstones "alice" with 1000s cooldown
        let cooldown = 1000;
        let tombstoned = store.tombstone("alice", &alice_addr, cooldown, now + 30)?;
        assert!(tombstoned);

        let tomb_record = store.get("alice")?.expect("record should exist");
        assert_eq!(tomb_record.status, UsernameStatus::Tombstoned);
        assert_eq!(
            tomb_record.tombstone_expires_at_ms,
            Some(now + 30 + cooldown)
        );

        // 5. Mallory tries to claim during tombstone cooldown -> Blocked by Tombstoned!
        let blocked = store.claim("alice", &mallory_addr, None, now + 100);
        assert!(blocked.is_err());

        // 6. After cooldown expires, Mallory can successfully claim
        let claim_after_expiry =
            store.claim("alice", &mallory_addr, None, now + 30 + cooldown + 1)?;
        assert_eq!(claim_after_expiry, UsernameClaimResult::Claimed);

        let final_record = store.get("alice")?.expect("record should exist");
        assert_eq!(final_record.account_address, mallory_addr);
        assert_eq!(final_record.status, UsernameStatus::Active);

        Ok(())
    }

    #[test]
    fn test_rename_lifecycle() -> Result<()> {
        let tempdir = TempDir::new("test-db-rename")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.directory_usernames();

        let alice_addr = [1u8; 20];
        let bob_addr = [2u8; 20];
        let now = 2000000;
        let cooldown = 50000;

        // 1. Alice claims "alice_old"
        store.claim("alice_old", &alice_addr, None, now)?;

        // 2. Bob already has "bob_taken"
        store.claim("bob_taken", &bob_addr, None, now)?;

        // 3. Alice tries to rename "alice_old" to "bob_taken" -> Collision error
        assert!(store
            .rename("alice_old", "bob_taken", &alice_addr, cooldown, now + 10)
            .is_err());

        // 4. Alice renames "alice_old" to "alice_new"
        store.rename("alice_old", "alice_new", &alice_addr, cooldown, now + 20)?;

        // Verify "alice_new" is Active for Alice
        let new_rec = store.get("alice_new")?.expect("should exist");
        assert_eq!(new_rec.status, UsernameStatus::Active);
        assert_eq!(new_rec.account_address, alice_addr);

        // Verify "alice_old" is Moved pointing to "alice_new"
        let old_rec = store.get("alice_old")?.expect("should exist");
        assert_eq!(old_rec.status, UsernameStatus::Moved);
        assert_eq!(old_rec.redirect_to, Some("alice_new".to_string()));
        assert_eq!(old_rec.tombstone_expires_at_ms, Some(now + 20 + cooldown));

        // 5. Bob tries to claim "alice_old" during cooldown -> Blocked
        assert!(store
            .claim("alice_old", &bob_addr, None, now + 100)
            .is_err());

        Ok(())
    }

    #[test]
    fn test_cf_usernames_column_family() -> Result<()> {
        let tempdir = TempDir::new("test-cf-usernames")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let cf = db.cf_usernames()?;
        assert!(db.cf(CF_USERNAMES).is_ok());
        assert!(db.cf("directory_usernames").is_ok());
        db.put(cf, b"test_key", b"test_val")?;
        let val = db.get(cf, b"test_key")?;
        assert_eq!(val.as_deref(), Some(b"test_val".as_slice()));
        Ok(())
    }

    #[test]
    fn test_register_username_state_machine_and_tombstones() -> Result<()> {
        let tempdir = TempDir::new("test-username-state-machine")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.directory_usernames();

        let alice_addr = [1u8; 20];
        let mallory_addr = [2u8; 20];
        let bob_addr = [3u8; 20];
        let charlie_addr = [4u8; 20];

        // 1. Valid vs Invalid username normalization and registration
        assert!(store.register_username("alice", alice_addr, 1000).is_ok());
        assert!(store.register_username("bob-123", bob_addr, 1000).is_ok());
        assert!(store.register_username("charlie_dev", charlie_addr, 1000).is_ok());

        // Reject invalid usernames:
        // Too short (< 3)
        assert!(matches!(
            store.register_username("al", alice_addr, 1000),
            Err(UsernameError::InvalidFormat(_))
        ));
        // Too long (> 32)
        let too_long = "a".repeat(33);
        assert!(matches!(
            store.register_username(&too_long, alice_addr, 1000),
            Err(UsernameError::InvalidFormat(_))
        ));
        // Non-alphanumeric start
        assert!(matches!(
            store.register_username("-alice", alice_addr, 1000),
            Err(UsernameError::InvalidFormat(_))
        ));
        assert!(matches!(
            store.register_username("_alice", alice_addr, 1000),
            Err(UsernameError::InvalidFormat(_))
        ));
        // Disallowed characters
        assert!(matches!(
            store.register_username("alice@domain.com", alice_addr, 1000),
            Err(UsernameError::InvalidFormat(_))
        ));
        assert!(matches!(
            store.register_username("alice.smith", alice_addr, 1000),
            Err(UsernameError::InvalidFormat(_))
        ));

        // 2. Same address re-registering -> succeeds and updates updated_at
        assert!(store.register_username("alice", alice_addr, 1050).is_ok());
        let rec = store.get("alice")?.expect("record should exist");
        assert_eq!(rec.account_address, alice_addr);
        assert_eq!(rec.status, UsernameStatus::Active);
        assert_eq!(rec.updated_at, 1050);

        // Name clash with different address -> returns Conflict ("Handle taken")
        let clash_res = store.register_username("alice", mallory_addr, 1060);
        assert!(matches!(clash_res, Err(UsernameError::Conflict(ref msg)) if msg.contains("taken")));

        // 3. Tombstone prevents re-registration before expiry
        // Alice tombstones "alice" with 300s cooldown at now = 1100 (expires 1400)
        let tombstoned = store.tombstone_username("alice", alice_addr, 1100, 300)?;
        assert!(tombstoned);

        let tomb_rec = store.get("alice")?.expect("record should exist");
        assert_eq!(tomb_rec.status, UsernameStatus::Tombstoned);
        assert_eq!(tomb_rec.tombstone_expires_at, 1400);

        // Mallory attempts to register "alice" at now = 1200 (now < tombstone_expires_at) -> Conflict ("Handle tombstoned")
        let blocked = store.register_username("alice", mallory_addr, 1200);
        assert!(matches!(blocked, Err(UsernameError::Conflict(ref msg)) if msg.contains("tombstoned")));

        // 4. Re-registration succeeds after expiry (now >= tombstone_expires_at)
        // Mallory reclaims at now = 1400 (exact expiry) -> succeeds!
        assert!(store.register_username("alice", mallory_addr, 1400).is_ok());
        let reclaimed_rec = store.get("alice")?.expect("record should exist");
        assert_eq!(reclaimed_rec.account_address, mallory_addr);
        assert_eq!(reclaimed_rec.status, UsernameStatus::Active);
        assert_eq!(reclaimed_rec.updated_at, 1400);

        // 5. Ownership transition
        // Mallory owns "alice". Mallory tombstones it at now = 1500 with 100s cooldown (expires 1600).
        assert!(store.tombstone_username("alice", mallory_addr, 1500, 100)?);

        // Charlie cannot claim before expiry
        assert!(matches!(
            store.register_username("alice", charlie_addr, 1550),
            Err(UsernameError::Conflict(_))
        ));

        // Charlie claims at now = 1605 (after expiry) -> succeeds!
        assert!(store.register_username("alice", charlie_addr, 1605).is_ok());
        let charlie_rec = store.get("alice")?.expect("record should exist");
        assert_eq!(charlie_rec.account_address, charlie_addr);
        assert_eq!(charlie_rec.status, UsernameStatus::Active);
        assert_eq!(charlie_rec.updated_at, 1605);

        // Charlie re-registers at now = 1700 -> succeeds and updates updated_at
        assert!(store.register_username("alice", charlie_addr, 1700).is_ok());
        let updated_charlie = store.get("alice")?.expect("record should exist");
        assert_eq!(updated_charlie.updated_at, 1700);

        Ok(())
    }
}
