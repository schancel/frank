//! The oracle's own database: `<registry db_path with extension oracle-v1>`, a RocksDB directory
//! beside the registry database. It is created the first time a relay with `[registry.oracle]`
//! enabled starts; a relay without the oracle never opens it, and the registry database itself
//! is unchanged, so builds from before the oracle still open it.
//!
//! It holds prices and public statistics only. Deleting it loses collected history and nothing
//! else: the collector starts again from the bundled history.
//!
//! Column families:
//! - `raw`: what each provider answered. Key `name 0x00 time(8, big-endian) provider`, value the
//!   number (8 bytes, big-endian IEEE 754). `name` is a series name, or an input that is not
//!   itself served (`providers/<asset>`: how many providers could be asked for it that round;
//!   `supply/<chain>`, `subsidy/<chain>`, `fx/eur-usd`, and
//!   `electricity/<region>` in the source's own currency per MWh).
//! - `series`: the served series. Key `name 0x00 time(8)`, same value. The owner of these points
//!   is the collector; `price/*` is derived from `raw` by [`super::sampling::replay`].
//! - `meta`: when each kind of round last ran, and how far thinning has got.
//!
//! Points older than the full-resolution window are thinned to the last point of each UTC day,
//! in both `raw` (per provider) and `series`.

use std::path::Path;

use bitcoinsuite_error::Result;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode, WriteBatch};

/// Extension of the store's directory, replacing the registry database's.
pub const STORE_EXTENSION: &str = "oracle-v1";
const CF_RAW: &str = "raw";
const CF_SERIES: &str = "series";
const CF_META: &str = "meta";
const DAY_S: u64 = 86_400;

/// One provider's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct RawSample {
    /// Series or input name.
    pub name: String,
    /// The round's time, unix seconds.
    pub time: u64,
    /// Provider id from configuration.
    pub provider: String,
    /// The value as the adapter normalised it.
    pub value: f64,
}

/// The oracle's database.
pub struct OracleStore {
    db: rocksdb::DB,
}

impl std::fmt::Debug for OracleStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "OracleStore {{ .. }}")
    }
}

fn key(name: &str, time: u64) -> Vec<u8> {
    let mut key = Vec::with_capacity(name.len() + 9);
    key.extend_from_slice(name.as_bytes());
    key.push(0);
    key.extend_from_slice(&time.to_be_bytes());
    key
}

/// `(name, time, rest)` of a key in `raw` or `series`.
fn split_key(key: &[u8]) -> Option<(&str, u64, &[u8])> {
    let end = key.iter().position(|byte| *byte == 0)?;
    let name = std::str::from_utf8(&key[..end]).ok()?;
    let time = u64::from_be_bytes(key.get(end + 1..end + 9)?.try_into().ok()?);
    Some((name, time, &key[end + 9..]))
}

fn number(value: &[u8]) -> Option<f64> {
    Some(f64::from_be_bytes(value.try_into().ok()?))
}

impl OracleStore {
    /// Opens the store, creating it when it does not exist.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut options = rocksdb::Options::default();
        options.create_if_missing(true);
        options.create_missing_column_families(true);
        let cfs = [CF_RAW, CF_SERIES, CF_META]
            .iter()
            .map(|name| ColumnFamilyDescriptor::new(*name, rocksdb::Options::default()));
        Ok(OracleStore {
            db: rocksdb::DB::open_cf_descriptors(&options, path, cfs)?,
        })
    }

    fn cf(&self, name: &str) -> &rocksdb::ColumnFamily {
        self.db
            .cf_handle(name)
            .expect("column family opened in OracleStore::open")
    }

    /// Writes one round: the answers and the points they produced, together or not at all.
    pub fn write(&self, raw: &[RawSample], points: &[(String, u64, f64)]) -> Result<()> {
        let mut batch = WriteBatch::default();
        for sample in raw {
            let mut key = key(&sample.name, sample.time);
            key.extend_from_slice(sample.provider.as_bytes());
            batch.put_cf(self.cf(CF_RAW), key, sample.value.to_be_bytes());
        }
        for (name, time, value) in points {
            batch.put_cf(self.cf(CF_SERIES), key(name, *time), value.to_be_bytes());
        }
        Ok(self.db.write(batch)?)
    }

    /// The points of `name` with `from <= time <= to`, oldest first.
    pub fn points(&self, name: &str, from: u64, to: u64) -> Result<Vec<(u64, f64)>> {
        let mut points = Vec::new();
        let start = key(name, from);
        for item in self.db.iterator_cf(
            self.cf(CF_SERIES),
            IteratorMode::From(&start, Direction::Forward),
        ) {
            let (key, value) = item?;
            match split_key(&key) {
                Some((found, time, _)) if found == name && time <= to => {
                    points.extend(number(&value).map(|value| (time, value)));
                }
                _ => break,
            }
        }
        Ok(points)
    }

    /// The latest point of `name` at or before `time`.
    pub fn floor(&self, name: &str, time: u64) -> Result<Option<(u64, f64)>> {
        let start = key(name, time);
        let mut iterator = self.db.iterator_cf(
            self.cf(CF_SERIES),
            IteratorMode::From(&start, Direction::Reverse),
        );
        Ok(match iterator.next().transpose()? {
            Some((key, value)) => match split_key(&key) {
                Some((found, time, _)) if found == name => {
                    number(&value).map(|value| (time, value))
                }
                _ => None,
            },
            None => None,
        })
    }

    /// The earliest point of `name`.
    pub fn first(&self, name: &str) -> Result<Option<(u64, f64)>> {
        let start = key(name, 0);
        let mut iterator = self.db.iterator_cf(
            self.cf(CF_SERIES),
            IteratorMode::From(&start, Direction::Forward),
        );
        Ok(match iterator.next().transpose()? {
            Some((key, value)) => match split_key(&key) {
                Some((found, time, _)) if found == name => {
                    number(&value).map(|value| (time, value))
                }
                _ => None,
            },
            None => None,
        })
    }

    /// Every series name with at least one point.
    pub fn names(&self) -> Result<Vec<String>> {
        self.names_in(CF_SERIES)
    }

    fn names_in(&self, cf: &str) -> Result<Vec<String>> {
        let mut names = Vec::new();
        let mut start = Vec::new();
        loop {
            let mut iterator = self
                .db
                .iterator_cf(self.cf(cf), IteratorMode::From(&start, Direction::Forward));
            let Some((key, _)) = iterator.next().transpose()? else {
                return Ok(names);
            };
            let Some((name, _, _)) = split_key(&key) else {
                return Ok(names);
            };
            // Everything of this name sorts below `name 0x01`.
            start = name.as_bytes().to_vec();
            start.push(1);
            names.push(name.to_owned());
        }
    }

    /// The stored answers for `name` with `from <= time <= to`, oldest first.
    pub fn raw(&self, name: &str, from: u64, to: u64) -> Result<Vec<RawSample>> {
        let mut samples = Vec::new();
        let start = key(name, from);
        for item in self.db.iterator_cf(
            self.cf(CF_RAW),
            IteratorMode::From(&start, Direction::Forward),
        ) {
            let (key, value) = item?;
            match split_key(&key) {
                Some((found, time, provider)) if found == name && time <= to => {
                    if let Some(value) = number(&value) {
                        samples.push(RawSample {
                            name: name.to_owned(),
                            time,
                            provider: String::from_utf8_lossy(provider).into_owned(),
                            value,
                        });
                    }
                }
                _ => break,
            }
        }
        Ok(samples)
    }

    /// A remembered time (`last-round/price`, ...).
    pub fn meta(&self, name: &str) -> Result<Option<u64>> {
        Ok(self
            .db
            .get_cf(self.cf(CF_META), name)?
            .and_then(|value| Some(u64::from_be_bytes(value.as_slice().try_into().ok()?))))
    }

    /// Remembers a time.
    pub fn set_meta(&self, name: &str, value: u64) -> Result<()> {
        Ok(self
            .db
            .put_cf(self.cf(CF_META), name, value.to_be_bytes())?)
    }

    /// Thins everything older than `full_resolution_days` before `now` to the last point of each
    /// UTC day (per provider in `raw`). Returns how many entries were removed. Days already
    /// thinned are not read again.
    pub fn thin(&self, now: u64, full_resolution_days: u64) -> Result<usize> {
        let cutoff = (now / DAY_S).saturating_sub(full_resolution_days) * DAY_S;
        let done = self.meta("thinned-until")?.unwrap_or(0);
        if cutoff <= done {
            return Ok(0);
        }
        let mut batch = WriteBatch::default();
        let mut removed = 0;
        for cf in [CF_RAW, CF_SERIES] {
            for name in self.names_in(cf)? {
                // (day, provider) -> key of the latest entry seen; earlier ones are deleted.
                let mut latest = std::collections::HashMap::<(u64, Vec<u8>), Vec<u8>>::new();
                let start = key(&name, done);
                for item in self
                    .db
                    .iterator_cf(self.cf(cf), IteratorMode::From(&start, Direction::Forward))
                {
                    let (key, _) = item?;
                    match split_key(&key) {
                        Some((found, time, provider)) if found == name && time < cutoff => {
                            let slot = (time / DAY_S, provider.to_vec());
                            if let Some(earlier) = latest.insert(slot, key.to_vec()) {
                                batch.delete_cf(self.cf(cf), earlier);
                                removed += 1;
                            }
                        }
                        _ => break,
                    }
                }
            }
        }
        batch.put_cf(self.cf(CF_META), "thinned-until", cutoff.to_be_bytes());
        self.db.write(batch)?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempdir::TempDir {
        tempdir::TempDir::new("cashweb-oracle-store").expect("temp dir")
    }

    fn point(name: &str, time: u64, value: f64) -> (String, u64, f64) {
        (name.to_owned(), time, value)
    }

    /// What a restart must not lose: points, answers and when rounds last ran.
    #[test]
    fn everything_written_is_there_after_reopening() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("registry.oracle-v1");
        let raw = RawSample {
            name: "price/btc-mainnet".to_owned(),
            time: 1000,
            provider: "kraken".to_owned(),
            value: 82_985.3,
        };
        {
            let store = OracleStore::open(&path)?;
            store.write(
                std::slice::from_ref(&raw),
                &[
                    point("price/btc-mainnet", 1000, 82_990.0),
                    point("price/btc-mainnet", 1600, 83_000.0),
                    point("price/btc-mainnet-extra", 1200, 1.0),
                    point("price/bch-mainnet", 1000, 279.0),
                ],
            )?;
            store.set_meta("last-round/price", 1600)?;
        }
        let store = OracleStore::open(&path)?;
        assert_eq!(
            store.points("price/btc-mainnet", 0, u64::MAX)?,
            vec![(1000, 82_990.0), (1600, 83_000.0)]
        );
        assert_eq!(store.points("price/btc-mainnet", 1001, 1599)?, vec![]);
        assert_eq!(
            store.floor("price/btc-mainnet", 1599)?,
            Some((1000, 82_990.0))
        );
        assert_eq!(store.floor("price/btc-mainnet", 999)?, None);
        assert_eq!(store.first("price/btc-mainnet")?, Some((1000, 82_990.0)));
        assert_eq!(store.first("price/eth-mainnet")?, None);
        assert_eq!(store.raw("price/btc-mainnet", 0, u64::MAX)?, vec![raw]);
        assert_eq!(store.meta("last-round/price")?, Some(1600));
        assert_eq!(
            store.names()?,
            [
                "price/bch-mainnet",
                "price/btc-mainnet",
                "price/btc-mainnet-extra"
            ]
        );
        Ok(())
    }

    #[test]
    fn old_points_are_thinned_to_one_a_day_and_recent_ones_kept() -> Result<()> {
        let dir = temp();
        let store = OracleStore::open(dir.path().join("o"))?;
        let now = 100 * DAY_S + 500;
        let mut points = Vec::new();
        let mut raw = Vec::new();
        // Ten-minute points over days 80..=99.
        for time in (80 * DAY_S..100 * DAY_S).step_by(600) {
            points.push(point("price/x", time, time as f64));
            for provider in ["a", "b"] {
                raw.push(RawSample {
                    name: "price/x".to_owned(),
                    time,
                    provider: provider.to_owned(),
                    value: 1.0,
                });
            }
        }
        store.write(&raw, &points)?;
        let removed = store.thin(now, 14)?;
        // Days 80..=85 (six days) are older than 14 days: 143 of 144 points go, per day.
        assert_eq!(removed, 6 * 143 + 6 * 143 * 2);
        let old = store.points("price/x", 0, 86 * DAY_S - 1)?;
        assert_eq!(old.len(), 6);
        assert_eq!(
            old[0].0,
            81 * DAY_S - 600,
            "the last point of the day stays"
        );
        assert_eq!(
            store.points("price/x", 86 * DAY_S, u64::MAX)?.len(),
            14 * 144
        );
        assert_eq!(store.raw("price/x", 0, 86 * DAY_S - 1)?.len(), 12);
        // Nothing more to do until another day ages out.
        assert_eq!(store.thin(now, 14)?, 0);
        Ok(())
    }
}
