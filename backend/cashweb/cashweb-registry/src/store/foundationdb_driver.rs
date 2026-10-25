//! FoundationDB 7.3 driver for the [`RelayKvStore`] transaction contract.
//!
//! Host composition must boot the process-wide FDB network (`foundationdb::boot`) and keep
//! its guard until every store is dropped. Calls block on FDB futures, so async hosts call
//! them from blocking workers. Every key is stored under the store's subspace prefix.
//!
//! Retryable FDB errors (conflicts, `transaction_too_old`, recoveries) re-run the closure
//! through FDB's `on_error` backoff, up to [`MAX_ATTEMPTS`]. `commit_unknown_result` is returned
//! as [`KvError::CommitUnknownResult`] without a retry.
use super::kv_store::{
    add_le, KvError, KvTransaction, Limits, Outcome, RelayKvStore, MAX_ATTEMPTS,
};
use foundationdb::{options::MutationType, Database, FdbError, RangeOption, Transaction};
use futures::{executor::block_on, TryStreamExt};

// https://apple.github.io/foundationdb/api-error-codes.html
const TRANSACTION_TOO_OLD: i32 = 1007;
const TRANSACTION_TIMED_OUT: i32 = 1031;
const TRANSACTION_TOO_LARGE: i32 = 2101;
const KEY_TOO_LARGE: i32 = 2102;
const VALUE_TOO_LARGE: i32 = 2103;

/// A live FoundationDB cluster, scoped to one subspace prefix.
pub struct FoundationDbKvStore {
    database: Database,
    subspace: Vec<u8>,
}

impl std::fmt::Debug for FoundationDbKvStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FoundationDbKvStore")
            .field("subspace", &String::from_utf8_lossy(&self.subspace))
            .finish_non_exhaustive()
    }
}

impl FoundationDbKvStore {
    /// Open the cluster named by `cluster_file`, after the host has booted the FDB network.
    /// `subspace` must be non-empty and outside the `0xff` system key space.
    pub fn open(cluster_file: &str, subspace: impl Into<Vec<u8>>) -> Result<Self, KvError> {
        let subspace = subspace.into();
        if cluster_file.is_empty() {
            return Err(KvError::InvalidArgument("empty FDB cluster file".into()));
        }
        if subspace.is_empty() || subspace[0] == 0xff {
            return Err(KvError::InvalidArgument(
                "FDB subspace prefix must be non-empty and outside the system key space".into(),
            ));
        }
        Ok(Self {
            database: Database::new(Some(cluster_file)).map_err(fdb_error)?,
            subspace,
        })
    }

    /// The subspace prefix every key is stored under.
    pub fn subspace(&self) -> &[u8] {
        &self.subspace
    }
}

/// Map a non-retryable FDB error to the contract's typed errors.
fn fdb_error(error: FdbError) -> KvError {
    match error.code() {
        TRANSACTION_TOO_LARGE => KvError::TransactionTooLarge {
            limit: super::kv_store::MAX_TRANSACTION_BYTES,
        },
        VALUE_TOO_LARGE => KvError::ValueTooLarge {
            len: 0,
            limit: super::kv_store::MAX_VALUE_BYTES,
        },
        KEY_TOO_LARGE => KvError::KeyTooLarge {
            len: 0,
            limit: super::kv_store::MAX_KEY_BYTES,
        },
        TRANSACTION_TIMED_OUT => KvError::TransactionTimedOut,
        _ => KvError::Backend(format!("FoundationDB error {}: {error}", error.code())),
    }
}

struct FdbTransaction<'a> {
    tx: &'a Transaction,
    subspace: &'a [u8],
    limits: Limits,
    /// A retryable error seen by an operation; the attempt is re-run after `on_error`.
    retry: Option<FdbError>,
}

impl FdbTransaction<'_> {
    fn key(&self, key: &[u8]) -> Result<Vec<u8>, KvError> {
        let full = [self.subspace, key].concat();
        self.limits.key(full.len())?;
        Ok(full)
    }

    fn failed(&mut self, error: FdbError) -> KvError {
        if error.code() == TRANSACTION_TOO_OLD && self.limits.timed_out() {
            return KvError::TransactionTimedOut;
        }
        if error.is_retryable() {
            self.retry = Some(error);
            return KvError::Retry;
        }
        fdb_error(error)
    }
}

impl KvTransaction for FdbTransaction<'_> {
    fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        let key = self.key(key)?;
        self.limits.charge(key.len())?;
        match block_on(self.tx.get(&key, false)) {
            Ok(value) => Ok(value.map(|v| v.to_vec())),
            Err(error) => Err(self.failed(error)),
        }
    }

    fn get_range(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        let (start, end) = (self.key(start)?, self.key(end)?);
        if limit == 0 || start >= end {
            return Ok(Vec::new());
        }
        self.limits.charge(start.len() + end.len())?;
        let mut range = RangeOption::from((start.as_slice(), end.as_slice()));
        range.limit = Some(limit.min(i32::MAX as usize));
        let rows = block_on(
            self.tx
                .get_ranges_keyvalues(range, false)
                .try_collect::<Vec<_>>(),
        );
        match rows {
            Ok(rows) => Ok(rows
                .into_iter()
                .map(|row| {
                    (
                        row.key()[self.subspace.len()..].to_vec(),
                        row.value().to_vec(),
                    )
                })
                .collect()),
            Err(error) => Err(self.failed(error)),
        }
    }

    fn set(&mut self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
        let key = self.key(key)?;
        self.limits.value(value.len())?;
        self.limits.charge(key.len() + value.len())?;
        self.tx.set(&key, value);
        Ok(())
    }

    fn clear(&mut self, key: &[u8]) -> Result<(), KvError> {
        let key = self.key(key)?;
        self.limits.charge(key.len())?;
        self.tx.clear(&key);
        Ok(())
    }

    fn atomic_add(&mut self, key: &[u8], delta: i64) -> Result<(), KvError> {
        let key = self.key(key)?;
        self.limits.charge(key.len() + 8)?;
        self.tx
            .atomic_op(&key, &add_le(None, delta), MutationType::Add);
        Ok(())
    }
}

impl RelayKvStore for FoundationDbKvStore {
    fn run_transaction(
        &self,
        body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
    ) -> Result<Outcome, KvError> {
        let mut tx = self.database.create_trx().map_err(fdb_error)?;
        for _ in 0..MAX_ATTEMPTS {
            let mut attempt = FdbTransaction {
                tx: &tx,
                subspace: &self.subspace,
                limits: Limits::start(),
                retry: None,
            };
            let outcome = body(&mut attempt);
            let FdbTransaction { retry, limits, .. } = attempt;
            if let Some(error) = retry {
                tx = block_on(tx.on_error(error)).map_err(fdb_error)?;
                continue;
            }
            if outcome == Outcome::Abort {
                return Ok(Outcome::Abort);
            }
            limits.check_time()?;
            match block_on(tx.commit()) {
                Ok(_) => return Ok(Outcome::Commit),
                Err(error) if error.is_maybe_committed() => {
                    return Err(KvError::CommitUnknownResult(error.to_string()))
                }
                // A commit cut off by the client timeout may already be applied.
                Err(error) if error.code() == TRANSACTION_TIMED_OUT => {
                    return Err(KvError::CommitUnknownResult(error.to_string()))
                }
                Err(error) if error.code() == TRANSACTION_TOO_OLD && limits.timed_out() => {
                    return Err(KvError::TransactionTimedOut)
                }
                Err(error) => tx = block_on(error.on_error()).map_err(fdb_error)?,
            }
        }
        Err(KvError::ConflictRetriesExhausted {
            attempts: MAX_ATTEMPTS,
        })
    }
}
