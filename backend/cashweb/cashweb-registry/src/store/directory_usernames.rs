//! Unique username index and tombstone store for domain-level identity routing.
//!
//! Enforces First-Come, First-Served (FCFS) uniqueness for routable handles (e.g. `alice`),
//! prevents collisions, and records tombstones upon de-registration to prevent handle recycling.

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use rocksdb::{ColumnFamilyDescriptor, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::db::{Db, CF};

pub(crate) const CF_DIRECTORY_USERNAMES: &str = "directory_usernames";

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
}

use self::UsernameError::*;

/// The active or tombstoned state of a username.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UsernameStatus {
    /// Active handle bound to an account.
    Active,
    /// Handle was released/deleted and is cooling off to prevent recycling.
    Tombstoned,
}

/// Durable record for a username.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsernameRecord {
    /// Canonical lowercase username handle.
    pub username: String,
    /// 20-byte raw account address.
    pub account_address: [u8; 20],
    /// Optional stamp public key.
    pub stamp_key: Option<Vec<u8>>,
    /// Active or tombstoned state.
    pub status: UsernameStatus,
    /// Timestamp of last modification in milliseconds.
    pub updated_at_ms: i64,
    /// Expiration timestamp in milliseconds for tombstone cooldown.
    pub tombstone_expires_at_ms: Option<i64>,
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

        let record: UsernameRecord =
            serde_json::from_slice(&slice).wrap_err(crate::store::db::DbError::RocksDb)?;
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
                        updated_at_ms: now_ms,
                        tombstone_expires_at_ms: None,
                    };
                    self.put_record(&updated)?;
                    return Ok(UsernameClaimResult::AlreadyOwned);
                }
                UsernameStatus::Tombstoned => {
                    if let Some(expires_at) = existing.tombstone_expires_at_ms {
                        if now_ms < expires_at {
                            return Err(Tombstoned(normalized, expires_at).into());
                        }
                    }
                    // Tombstone expired, allow fresh claim
                }
            }
        }

        let record = UsernameRecord {
            username: normalized,
            account_address: *account_address,
            stamp_key,
            status: UsernameStatus::Active,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: None,
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
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: Some(now_ms + cooldown_duration_ms),
        };
        self.put_record(&tombstone_record)?;
        Ok(true)
    }

    fn put_record(&self, record: &UsernameRecord) -> Result<()> {
        let serialized =
            serde_json::to_vec(record).wrap_err(crate::store::db::DbError::RocksDb)?;
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf, record.username.as_bytes(), serialized);
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
        assert_eq!(tomb_record.tombstone_expires_at_ms, Some(now + 30 + cooldown));

        // 5. Mallory tries to claim during tombstone cooldown -> Blocked by Tombstoned!
        let blocked = store.claim("alice", &mallory_addr, None, now + 100);
        assert!(blocked.is_err());

        // 6. After cooldown expires, Mallory can successfully claim
        let claim_after_expiry = store.claim("alice", &mallory_addr, None, now + 30 + cooldown + 1)?;
        assert_eq!(claim_after_expiry, UsernameClaimResult::Claimed);

        let final_record = store.get("alice")?.expect("record should exist");
        assert_eq!(final_record.account_address, mallory_addr);
        assert_eq!(final_record.status, UsernameStatus::Active);

        Ok(())
    }
}
