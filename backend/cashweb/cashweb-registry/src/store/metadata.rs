//! Contains `DbMetadata`, allowing access to keyserver metadata.
//!
//! `m/` + pkh holds the entry; `mt/` + [`TimePkh`] is its by-time index, replaced in the same
//! transaction as the entry. The monotonic-timestamp rule is checked again inside that
//! transaction, so two replicas writing one address cannot leave a stale index row.

use std::fmt::Debug;

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use cashweb_payload::payload::SignedPayload;
use prost::Message;
use thiserror::Error;

use crate::{
    proto,
    store::{
        db::{mark_format, prefix_end, Db, SCAN_BATCH},
        kv_store::{key_after, KvTransaction},
        pubkeyhash::{PubKeyHash, TimePkh},
    },
};

pub(crate) const METADATA_PREFIX: &[u8] = b"m/";
pub(crate) const PKH_BY_TIME_PREFIX: &[u8] = b"mt/";

pub(crate) fn metadata_key(pkh: &PubKeyHash) -> Vec<u8> {
    [METADATA_PREFIX, &pkh.to_storage_bytes()].concat()
}

pub(crate) fn by_time_key(time_pkh: &TimePkh) -> Vec<u8> {
    [PKH_BY_TIME_PREFIX, &time_pkh.to_storage_bytes()].concat()
}

/// Allows access to registry metadata.
pub struct DbMetadata<'a> {
    db: &'a Db,
}

/// Errors indicating some registry metadata error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbMetadataError {
    /// Database contains an invalid protobuf MetadataEntry.
    #[critical()]
    #[error("Inconsistent db: Cannot decode MetadataEntry: {0}")]
    CannotDecodeMetadataEntry(String),

    /// Database contains an invalid protobuf MetadataEntry.
    #[critical()]
    #[error("Inconsistent db: Invalid SignedPayload in DB")]
    InvalidSignedPayloadInDb,

    /// Attempting to put a new metadata entry without a payload.
    #[critical()]
    #[error("Metadata is missing a payload")]
    MissingMetadataPayload,
}

use self::DbMetadataError::*;

/// Why [`DbMetadata::put`] did not replace the stored entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataRefusal {
    /// The stored entry has the same payload hash; nothing changed.
    SamePayload,
    /// The stored entry's timestamp is not older than the new one.
    NotNewer {
        /// Stored timestamp.
        previous: i64,
        /// Offered timestamp.
        next: i64,
    },
}

fn get_in(
    tx: &mut dyn KvTransaction,
    pkh: &PubKeyHash,
) -> Result<Option<SignedPayload<proto::AddressMetadata>>> {
    let Some(serialized) = tx.get(&metadata_key(pkh))? else {
        return Ok(None);
    };
    let entry = cashweb_payload::proto::SignedPayload::decode(serialized.as_slice())
        .wrap_err_with(|| CannotDecodeMetadataEntry(hex::encode(&serialized)))?;
    let entry = SignedPayload::parse_proto(&entry).wrap_err(InvalidSignedPayloadInDb)?;
    Ok(Some(entry))
}

fn decode_time_pkh(key: &[u8]) -> Result<TimePkh> {
    TimePkh::from_storage_bytes(key[PKH_BY_TIME_PREFIX.len()..].to_vec().into())
}

impl<'a> DbMetadata<'a> {
    /// Create a new [`DbMetadata`] instance.
    pub fn new(db: &'a Db) -> Self {
        DbMetadata { db }
    }

    /// Store a [`cashweb_payload::proto::SignedPayload`], replacing the entry for `pkh` and its
    /// by-time index row in one transaction. The outer error is storage; the inner one says why
    /// the stored entry was kept (checked against the entry read in this same transaction).
    pub fn put(
        &self,
        pkh: &PubKeyHash,
        metadata_entry: &SignedPayload<proto::AddressMetadata>,
    ) -> Result<std::result::Result<(), MetadataRefusal>> {
        let new_payload = metadata_entry
            .payload()
            .as_ref()
            .ok_or(MissingMetadataPayload)?;
        let encoded = metadata_entry.to_proto().encode_to_vec();
        self.db.transact(|tx| {
            if let Some(existing) = get_in(tx, pkh)? {
                let payload = existing
                    .payload()
                    .as_ref()
                    .ok_or(InvalidSignedPayloadInDb)?;
                if existing.payload_hash() == metadata_entry.payload_hash() {
                    return Ok(Err(MetadataRefusal::SamePayload));
                }
                if payload.timestamp >= new_payload.timestamp {
                    return Ok(Err(MetadataRefusal::NotNewer {
                        previous: payload.timestamp,
                        next: new_payload.timestamp,
                    }));
                }
                tx.clear(&by_time_key(&TimePkh {
                    timestamp: payload.timestamp,
                    pkh: pkh.clone(),
                }))?;
            }
            mark_format(tx)?;
            tx.set(&metadata_key(pkh), &encoded)?;
            tx.set(
                &by_time_key(&TimePkh {
                    timestamp: new_payload.timestamp,
                    pkh: pkh.clone(),
                }),
                &[],
            )?;
            Ok(Ok(()))
        })
    }

    /// Retrieve a [`cashweb_payload::proto::SignedPayload`] from the db.
    pub fn get(&self, pkh: &PubKeyHash) -> Result<Option<SignedPayload<proto::AddressMetadata>>> {
        self.db.transact(|tx| get_in(tx, pkh))
    }

    /// Iterate public key hashes by time ascendingly from a given `start_timestamp`, reading
    /// [`SCAN_BATCH`] index rows per transaction.
    pub fn iter_by_time(&self, start_timestamp: i64) -> impl Iterator<Item = Result<TimePkh>> + 'a {
        ByTime {
            db: self.db,
            next: Some([PKH_BY_TIME_PREFIX, &start_timestamp.to_be_bytes()].concat()),
            buffered: std::collections::VecDeque::new(),
        }
    }

    /// Return the last public key hash, by time.
    pub fn get_latest(&self) -> Result<Option<TimePkh>> {
        let rows = self.db.transact(|tx| {
            Ok(tx.get_range_reverse(PKH_BY_TIME_PREFIX, &prefix_end(PKH_BY_TIME_PREFIX), 1)?)
        })?;
        rows.first()
            .map(|(key, _)| decode_time_pkh(key))
            .transpose()
    }
}

/// [`DbMetadata::iter_by_time`]: one transaction per batch of index rows.
struct ByTime<'a> {
    db: &'a Db,
    next: Option<Vec<u8>>,
    buffered: std::collections::VecDeque<Vec<u8>>,
}

impl Iterator for ByTime<'_> {
    type Item = Result<TimePkh>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.buffered.is_empty() {
            let start = self.next.take()?;
            let end = prefix_end(PKH_BY_TIME_PREFIX);
            let rows = match self
                .db
                .transact(|tx| Ok(tx.get_range(&start, &end, SCAN_BATCH)?))
            {
                Ok(rows) => rows,
                Err(error) => return Some(Err(error)),
            };
            if rows.len() == SCAN_BATCH {
                self.next = rows.last().map(|(key, _)| key_after(key));
            }
            self.buffered = rows.into_iter().map(|(key, _)| key).collect();
        }
        self.buffered.pop_front().map(|key| decode_time_pkh(&key))
    }
}

impl Debug for DbMetadata<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbMetadata {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        proto,
        store::{
            db::Db,
            metadata::{by_time_key, metadata_key, DbMetadataError},
            pubkeyhash::{PkhAlgorithm, PkhError, PubKeyHash, TimePkh},
        },
    };
    use bitcoinsuite_core::{BitcoinCode, Hashed, Script, Sha256, TxOutput, UnhashedTx};
    use bitcoinsuite_error::Result;
    use cashweb_payload::payload::{SignatureScheme, SignedPayload};
    use pretty_assertions::assert_eq;
    use prost::Message;

    #[test]
    fn test_db_metadata() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--metadata")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let pkh = PubKeyHash::new(PkhAlgorithm::Sha256Ripemd160, [7; 20].into())?;

        // Entry doesn't exist yet
        assert_eq!(db.metadata().get(&pkh)?, None);
        // No by time entries yet
        assert_eq!(db.metadata().iter_by_time(0).count(), 0);
        assert_eq!(db.metadata().get_latest()?, None);

        let mut address_metadata = proto::AddressMetadata {
            timestamp: 1234,
            ttl: 10,
            entries: vec![],
        };
        // Add entry and check
        let mut entry_proto = cashweb_payload::proto::SignedPayload {
            pubkey: vec![2; 33],
            sig: vec![4, 5, 6, 7, 8],
            sig_scheme: SignatureScheme::Ecdsa.into(),
            payload: address_metadata.encode_to_vec(),
            payload_hash: Sha256::digest(address_metadata.encode_to_vec().into())
                .as_slice()
                .to_vec(),
            burn_amount: 1_337_000_000_000,
            burn_txs: vec![cashweb_payload::proto::BurnTx {
                tx: UnhashedTx {
                    version: 1,
                    inputs: vec![],
                    outputs: vec![TxOutput {
                        script: Script::default(),
                        value: 1_337_000_000_000,
                    }],
                    lock_time: 0,
                }
                .ser()
                .to_vec(),
                burn_idx: 0,
            }],
        };
        let entry = SignedPayload::parse_proto(&entry_proto)?;
        db.metadata().put(&pkh, &entry)?.unwrap();
        assert_eq!(db.metadata().get(&pkh)?, Some(entry));
        assert_eq!(
            db.metadata()
                .iter_by_time(1234)
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            vec![TimePkh {
                timestamp: 1234,
                pkh: pkh.clone(),
            }],
        );
        assert_eq!(
            db.metadata().get_latest()?,
            Some(TimePkh {
                timestamp: 1234,
                pkh: pkh.clone(),
            }),
        );
        assert_eq!(db.metadata().iter_by_time(1235).count(), 0);

        // Update entry
        address_metadata.timestamp = 1235;
        entry_proto.payload = address_metadata.encode_to_vec();
        entry_proto.payload_hash = Sha256::digest(entry_proto.payload.clone().into())
            .as_slice()
            .to_vec();
        let entry = SignedPayload::parse_proto(&entry_proto)?;
        db.metadata().put(&pkh, &entry)?.unwrap();
        assert_eq!(db.metadata().get(&pkh)?, Some(entry));
        assert_eq!(
            db.metadata()
                .iter_by_time(1234)
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            vec![TimePkh {
                timestamp: 1235,
                pkh: pkh.clone(),
            }],
        );
        assert_eq!(
            db.metadata().get_latest()?,
            Some(TimePkh {
                timestamp: 1235,
                pkh: pkh.clone(),
            }),
        );
        assert_eq!(db.metadata().iter_by_time(1235).count(), 1);
        assert_eq!(db.metadata().iter_by_time(1236).count(), 0);

        // Put data with invalid Protobuf encoding
        db.raw_set(&metadata_key(&pkh), b"foobar")?;
        // Results in CannotDecodeMetadataEntry
        assert_eq!(
            db.metadata()
                .get(&pkh)
                .unwrap_err()
                .downcast::<DbMetadataError>()?,
            DbMetadataError::CannotDecodeMetadataEntry("666f6f626172".to_string()),
        );

        // Put data with invalid TimePkh encoding
        db.raw_set(b"mt/foobar", b"")?;
        assert_eq!(
            db.metadata()
                .iter_by_time(0)
                .last()
                .unwrap()
                .unwrap_err()
                .downcast::<PkhError>()?,
            PkhError::InvalidTimePkhTimestamp,
        );
        assert_eq!(
            db.metadata()
                .get_latest()
                .unwrap_err()
                .downcast::<PkhError>()?,
            PkhError::InvalidTimePkhTimestamp,
        );

        Ok(())
    }

    #[test]
    fn test_iter_by_time() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--metadata")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let mut pkhs = Vec::new();
        for i in 0u8..50 {
            let pkh = PubKeyHash::new(PkhAlgorithm::Sha256Ripemd160, [i / 2; 20].into())?;
            let address_metadata = proto::AddressMetadata {
                timestamp: 1000 + i as i64,
                ttl: 10,
                entries: vec![],
            };
            let entry_proto = cashweb_payload::proto::SignedPayload {
                pubkey: vec![2; 33],
                sig: vec![4, 5, 6, 7, 8],
                sig_scheme: SignatureScheme::Ecdsa.into(),
                payload: address_metadata.encode_to_vec(),
                payload_hash: vec![],
                burn_amount: 0,
                burn_txs: vec![],
            };
            let entry = SignedPayload::parse_proto(&entry_proto)?;
            db.metadata().put(&pkh, &entry)?.unwrap();
            // even gets overridden by odd
            if i % 2 == 1 {
                pkhs.push(pkh);
            }
        }

        // i = 0 got overridden by i = 1
        assert_eq!(
            db.metadata().iter_by_time(0).next().transpose()?,
            Some(TimePkh {
                timestamp: 1001,
                pkh: pkhs[0].clone(),
            }),
        );
        assert_eq!(
            db.metadata().iter_by_time(1001).next().transpose()?,
            Some(TimePkh {
                timestamp: 1001,
                pkh: pkhs[0].clone(),
            }),
        );

        // Get all odd timestamps after (including) 1020
        assert_eq!(
            db.metadata()
                .iter_by_time(1020)
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            pkhs[10..]
                .iter()
                .enumerate()
                .map(|(idx, pkh)| {
                    TimePkh {
                        timestamp: 1021 + idx as i64 * 2,
                        pkh: pkh.clone(),
                    }
                })
                .collect::<Vec<_>>(),
        );

        Ok(())
    }

    /// The monotonic rule is decided in the replacing transaction itself, so a refused or
    /// repeated entry leaves exactly the stored entry and its one index row.
    #[test]
    fn a_replacement_is_checked_against_the_entry_it_replaces() -> Result<()> {
        use crate::store::metadata::MetadataRefusal;
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--metadata-replace")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let pkh = PubKeyHash::new(PkhAlgorithm::Sha256Ripemd160, [9; 20].into())?;
        let entry = |timestamp: i64, ttl: i64| {
            SignedPayload::parse_proto(&cashweb_payload::proto::SignedPayload {
                pubkey: vec![2; 33],
                sig: vec![4, 5, 6, 7, 8],
                sig_scheme: SignatureScheme::Ecdsa.into(),
                payload: proto::AddressMetadata {
                    timestamp,
                    ttl,
                    entries: vec![],
                }
                .encode_to_vec(),
                payload_hash: vec![],
                burn_amount: 0,
                burn_txs: vec![],
            })
        };
        let first = entry(2000, 1)?;
        db.metadata().put(&pkh, &first)?.unwrap();
        let rows = || -> Result<_> { Ok((db.raw_rows(b"m/")?, db.raw_rows(b"mt/")?)) };
        let stored = rows()?;
        assert_eq!(
            stored.1,
            vec![(
                by_time_key(&TimePkh {
                    timestamp: 2000,
                    pkh: pkh.clone()
                }),
                vec![]
            )]
        );
        assert_eq!(
            db.metadata().put(&pkh, &first)?,
            Err(MetadataRefusal::SamePayload)
        );
        for timestamp in [2000, 1999] {
            assert_eq!(
                db.metadata().put(&pkh, &entry(timestamp, 2)?)?,
                Err(MetadataRefusal::NotNewer {
                    previous: 2000,
                    next: timestamp
                })
            );
        }
        assert_eq!(rows()?, stored);
        Ok(())
    }

    #[test]
    fn test_db_metadata_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--metadata-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(format!("{:?}", db.metadata()), "DbMetadata { .. }");
        Ok(())
    }
}
