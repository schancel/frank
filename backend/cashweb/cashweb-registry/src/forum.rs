//! Canonical Forum runtime: one lazy owner of the forum's transaction store, and the views,
//! pages and statuses read from it.
//!
//! Every replica of a cluster opens the same store (FoundationDB under
//! `<fdb_subspace_prefix>forum-v1/`), so a post made through one replica is read, voted on and
//! paged through any other. Cursors are stateless: a position (topic, since, first-visible time
//! and post hash, or a discovery topic) plus the revision and epoch they were issued at. The
//! epoch is derived from the network and burn policy, so every replica issues and accepts the
//! same cursors, across restarts too.
use frank_cbor::message_fields::{
    forum_aggregate, forum_discovery_entry, forum_discovery_page, forum_operation_state,
    forum_operation_status, forum_single_view, forum_topic_page, forum_vote_direction,
};
use frank_cbor::message_types::{
    TYPE_FORUM_DISCOVERY_PAGE, TYPE_FORUM_OPERATION_STATUS, TYPE_FORUM_TOPIC_PAGE, TYPE_FORUM_VIEW,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use frank_cbor::{
    cbor_map, decode_forum_cursor, encode_forum_cursor, encode_forum_read_frame, CborValue,
    ForumCursor, ForumCursorPosition, Timestamp,
};

use crate::{
    monad_http::{Address, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    monad_topic_cbor::{
        check_topic_burn_before_broadcast, parse_topic_event, TopicBurnPolicy, TopicEvent,
    },
    monad_topic_verify::VoteDirection,
    store::{
        forum::{
            invalid, time_key, time_value, ForumError, Observation, Result, Row, Store, StoredRow,
            STORE_SUFFIX,
        },
        kv_store::{key_after, prefix_end, RelayKvStore, RocksDbKvStore},
        large_values::{ObjectStore, SweepReport},
    },
};

/// Rows per page.
const PAGE_ROWS: usize = 128;
/// Encoded page budget.
const PAGE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn now() -> Timestamp {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Timestamp {
        seconds: time.as_secs().min(i64::MAX as u64) as i64,
        nanoseconds: time.subsec_nanos(),
    }
}

/// The cursor epoch of a network and burn policy: the same on every replica and every start.
pub(crate) fn epoch(network: &str, policy: &TopicBurnPolicy) -> [u8; 16] {
    use bitcoinsuite_core::{Hashed, Sha256};
    let digest = Sha256::digest(
        [
            b"forum-epoch-v1",
            network.as_bytes(),
            &policy.expected_chain_id.to_be_bytes(),
            &policy.burn_address.0,
        ]
        .concat()
        .into(),
    );
    let mut epoch = [0; 16];
    epoch.copy_from_slice(&digest.as_slice()[..16]);
    epoch
}

/// Where the forum keeps its state, chosen by composition.
#[derive(Debug)]
enum Storage {
    /// A transaction store every replica shares (FoundationDB in a cluster).
    Shared(Arc<dyn RelayKvStore>),
    /// A single replica's RocksDB beside its registry database, opened on first use and created
    /// only by the first write.
    Beside {
        path: PathBuf,
        opened: Mutex<Option<Arc<RocksDbKvStore>>>,
    },
}

#[derive(Debug)]
pub(crate) struct Owner {
    storage: Storage,
    objects: Arc<dyn ObjectStore>,
    opened: Mutex<Option<Arc<Store>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Query {
    Topic { topic: String, since: Timestamp },
    Discovery,
}

/// A shared store blocks on the network; on a multi-threaded runtime the worker is handed over
/// to other tasks for the call.
fn blocking<T>(call: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(call)
        }
        _ => call(),
    }
}

impl Owner {
    /// The store beside the registry database at `registry_db`: its file name plus
    /// [`STORE_SUFFIX`].
    pub(crate) fn beside(registry_db: PathBuf, objects: Arc<dyn ObjectStore>) -> Self {
        let mut name = registry_db.as_os_str().to_owned();
        name.push(STORE_SUFFIX);
        Self {
            storage: Storage::Beside {
                path: name.into(),
                opened: Mutex::new(None),
            },
            objects,
            opened: Mutex::new(None),
        }
    }

    /// The store on a transaction backend shared by every replica of a cluster.
    pub(crate) fn shared(store: Arc<dyn RelayKvStore>, objects: Arc<dyn ObjectStore>) -> Self {
        Self {
            storage: Storage::Shared(store),
            objects,
            opened: Mutex::new(None),
        }
    }

    /// The single-node store's directory (`None` for a shared store).
    #[cfg(test)]
    pub(crate) fn local_path(&self) -> Option<&std::path::Path> {
        match &self.storage {
            Storage::Beside { path, .. } => Some(path),
            Storage::Shared(_) => None,
        }
    }

    fn reset_text(&self) -> String {
        match &self.storage {
            Storage::Beside { path, .. } => format!(
                "The forum store at {} holds a format this build has no reader for. Development \
                 reset: stop the relay and delete {} and the forum/ prefix of the large-value \
                 object store. It holds public forum posts and burn records only: no keys and \
                 no funds.",
                path.display(),
                path.display()
            ),
            Storage::Shared(_) => "The shared forum store holds a format this build has no \
                 reader for. Development reset: stop every relay of the cluster and clear the \
                 FoundationDB keys under <fdb_subspace_prefix>forum-v1/ and the objects under \
                 <bucket prefix>/forum/ in [registry.large_values]. They hold public forum posts \
                 and burn records only: no keys and no funds."
                .to_owned(),
        }
    }

    /// The transaction backend, or `None` for a single-node store that does not exist yet and
    /// may not be created.
    fn kv(&self, create: bool) -> Result<Option<Arc<dyn RelayKvStore>>> {
        let (path, opened) = match &self.storage {
            Storage::Shared(store) => return Ok(Some(Arc::clone(store))),
            Storage::Beside { path, opened } => (path, opened),
        };
        let mut guard = opened.lock().map_err(|_| ForumError::Unavailable)?;
        if guard.is_none() {
            let exists = match std::fs::symlink_metadata(path) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => true,
                Ok(_) => return Err(ForumError::Unavailable),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(_) => return Err(ForumError::Unavailable),
            };
            if !exists && !create {
                return Ok(None);
            }
            // Never create inside an existing directory: an empty one is an interrupted
            // creation or a loss, preserved for investigation.
            if exists && !path.join("CURRENT").is_file() {
                return Err(ForumError::Unavailable);
            }
            let kv = if exists {
                RocksDbKvStore::open_existing(path)
            } else {
                RocksDbKvStore::open(path)
            }
            .map_err(|_| ForumError::Unavailable)?;
            *guard = Some(Arc::new(kv));
        }
        // A directory whose database was removed underneath the open handle is not read as
        // empty.
        if !path.join("CURRENT").is_file() {
            return Err(ForumError::Unavailable);
        }
        Ok(guard
            .as_ref()
            .map(|kv| Arc::clone(kv) as Arc<dyn RelayKvStore>))
    }

    /// The open store for `network` and `policy`. Without `create`, a store nothing has
    /// written yet is `None` and nothing is created.
    fn store(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        create: bool,
    ) -> Result<Option<Arc<Store>>> {
        let mut opened = self.opened.lock().map_err(|_| ForumError::Unavailable)?;
        if let Some(store) = opened.as_ref() {
            if store.network != network || store.policy != policy {
                return Err(ForumError::Unavailable);
            }
            if let Storage::Beside { path, .. } = &self.storage {
                if !path.join("CURRENT").is_file() {
                    return Err(ForumError::Unavailable);
                }
            }
            return Ok(Some(Arc::clone(store)));
        }
        let Some(kv) = self.kv(create)? else {
            return Ok(None);
        };
        let reset = self.reset_text();
        let Some(store) = blocking(|| {
            Store::open(
                kv,
                Arc::clone(&self.objects),
                network,
                policy,
                create,
                &reset,
            )
        })?
        else {
            return Ok(None);
        };
        let store = Arc::new(store);
        *opened = Some(Arc::clone(&store));
        Ok(Some(store))
    }

    pub(crate) fn contains(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        hash: &[u8; 32],
    ) -> Result<bool> {
        let Some(store) = self.store(network, policy, false)? else {
            return Ok(false);
        };
        blocking(|| {
            store.read(|tx| Ok(Store::post(tx, hash)?.is_some_and(|p| p.visible.is_some())))
        })
    }

    pub(crate) fn view(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        hash: &[u8; 32],
    ) -> Result<Option<Vec<u8>>> {
        let Some(store) = self.store(network, policy, false)? else {
            return Ok(None);
        };
        blocking(|| {
            let found = store.read(|tx| {
                Ok(Store::stored_row(tx, hash)?.map(|row| (row, Store::revision(tx))))
            })?;
            let Some((row, revision)) = found else {
                return Ok(None);
            };
            let row = store.resolve_row(row)?;
            Ok(Some(view_row(
                &store.network,
                &row,
                &epoch(network, &policy),
                revision?,
            )?))
        })
    }

    pub(crate) fn status(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        frame: &[u8],
    ) -> Result<Vec<u8>> {
        let request = request(network, policy, frame)?;
        let epoch = epoch(network, &policy);
        let Some(store) = self.store(network, policy, false)? else {
            return status_frame(network, &epoch, 0, &request, false);
        };
        let (retained, revision) = blocking(|| {
            store.read(|tx| Ok((Store::retained(tx, &request)?, Store::revision(tx)?)))
        })?;
        status_frame(
            network,
            &epoch,
            revision,
            retained.as_ref().unwrap_or(&request),
            retained.is_some(),
        )
    }

    pub(crate) async fn submit<T: JsonRpcTransport + Clone>(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        frame: &[u8],
        transport: &T,
        poll: PollConfig,
    ) -> Result<Vec<u8>> {
        let request = request(network, policy, frame)?;
        if request.checked.decoded.value_wei > i64::MAX as u128 {
            return Err(invalid("burn exceeds i64::MAX"));
        }
        if matches!(&request.event,TopicEvent::Post(p) if p.schema_version<2) {
            return Err(invalid("Forum post requires schema 2"));
        }
        let epoch = epoch(network, &policy);
        let store = self
            .store(network, policy, true)?
            .ok_or(ForumError::Unavailable)?;
        let op = blocking(|| store.admit(request))?;
        let status = |op: &Observation| -> Result<Vec<u8>> {
            let revision = blocking(|| store.read(|tx| Store::revision(tx)))?;
            status_frame(network, &epoch, revision, op, true)
        };
        if op.confirmed.is_some() {
            return status(&op);
        }
        // The durable reservation exists; every subsequent failure is indeterminate. No
        // transaction is open while network confirmation is awaited, so a second replica given
        // the same burn broadcasts the same bytes and confirms it at most once.
        let verified = crate::monad_topic_cbor::broadcast_and_verify_forum_event(
            transport, &op.event, &policy, poll,
        )
        .await
        .map_err(|e| ForumError::OutcomeUnknown(e.to_string()))?;
        let confirmed = blocking(|| store.confirm(&op, &verified, now()))
            .map_err(|e| ForumError::OutcomeUnknown(e.to_string()))?;
        status(&confirmed).map_err(|e| ForumError::OutcomeUnknown(e.to_string()))
    }

    pub(crate) fn page(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        query: Query,
        cursor: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        let epoch = epoch(network, &policy);
        let store = self.store(network, policy, false)?;
        blocking(|| page(store.as_deref(), network, &epoch, query, cursor))
    }

    /// Confirmed visible Forum posts, when this replica has opened the store. Metrics never
    /// open or create it.
    pub(crate) fn stored_post_count(&self) -> Result<Option<u64>> {
        let Some(store) = self
            .opened
            .lock()
            .map_err(|_| ForumError::Unavailable)?
            .clone()
        else {
            return Ok(None);
        };
        blocking(|| store.stored_post_count()).map(Some)
    }

    /// Delete unreferenced forum objects (frames over the inline limit) as sweep lease holder
    /// `holder`. Nothing is done before this replica has opened the store. Blocks.
    pub(crate) fn sweep_large_values(&self, holder: [u8; 16]) -> Result<SweepReport> {
        let Some(store) = self
            .opened
            .lock()
            .map_err(|_| ForumError::Unavailable)?
            .clone()
        else {
            return Ok(SweepReport::default());
        };
        store.sweep_large_values(holder)
    }
}

fn request(network: &str, policy: TopicBurnPolicy, frame: &[u8]) -> Result<Observation> {
    let event = parse_topic_event(frame, network).map_err(invalid)?;
    let checked = check_topic_burn_before_broadcast(&event, &policy).map_err(invalid)?;
    u64::try_from(checked.decoded.value_wei).map_err(invalid)?;
    Ok(Observation {
        event,
        checked,
        first_seen: now(),
        confirmed: None,
    })
}

fn view_row(network: &str, row: &Row, epoch: &[u8], revision: u64) -> Result<Vec<u8>> {
    let author = &row.author;
    let (block, index, _) = author.confirmed.ok_or(ForumError::Unavailable)?;
    let TopicEvent::Post(author_post) = &author.event else {
        return Err(ForumError::Unavailable);
    };
    let post = &row.post;
    use forum_single_view as V;
    encode_forum_read_frame(
        TYPE_FORUM_VIEW,
        &cbor_map(vec![
            (V::NETWORK, CborValue::Text(network.to_owned())),
            (
                V::POST_FRAME,
                CborValue::Bytes(author_post.post_frame.clone()),
            ),
            (
                V::AUTHOR,
                CborValue::Bytes(author.checked.decoded.sender.0.to_vec()),
            ),
            (
                V::AUTHOR_BURN_TX,
                CborValue::Bytes(author.event.burn_tx().to_vec()),
            ),
            (
                V::TRANSACTION_HASH,
                CborValue::Bytes(author.checked.decoded.tx_hash.0.to_vec()),
            ),
            (
                V::FIRST_VISIBLE,
                time_value(post.visible.ok_or(ForumError::Unavailable)?),
            ),
            (V::BLOCK, CborValue::Int(block.into())),
            (V::TRANSACTION_INDEX, CborValue::Int(index.into())),
            (
                V::AGGREGATE,
                cbor_map(vec![
                    (
                        forum_aggregate::NEGATIVE,
                        CborValue::Bool(post.aggregate.negative),
                    ),
                    (
                        forum_aggregate::MAGNITUDE,
                        CborValue::Bytes(post.aggregate.magnitude.0.to_vec()),
                    ),
                ]),
            ),
            (V::REVISION, CborValue::Int(revision.into())),
            (V::EPOCH, CborValue::Bytes(epoch.to_vec())),
        ]),
    )
    .map_err(|_| ForumError::Unavailable)
}

fn status_frame(
    network: &str,
    epoch: &[u8],
    revision: u64,
    op: &Observation,
    retained: bool,
) -> Result<Vec<u8>> {
    use forum_operation_status as S;
    let mut fields = vec![
        (S::NETWORK, CborValue::Text(network.to_owned())),
        (S::SUBMITTED_FRAME, CborValue::Bytes(op.frame().to_vec())),
        (
            S::TARGET_HASH,
            CborValue::Bytes(op.event.target_hash().to_vec()),
        ),
        (
            S::TRANSACTION_HASH,
            CborValue::Bytes(op.checked.decoded.tx_hash.0.to_vec()),
        ),
        (
            S::SENDER,
            CborValue::Bytes(op.checked.decoded.sender.0.to_vec()),
        ),
        (
            S::DIRECTION,
            CborValue::Int(
                if op.checked.direction == VoteDirection::Up {
                    forum_vote_direction::UP
                } else {
                    forum_vote_direction::DOWN
                }
                .into(),
            ),
        ),
        (
            S::VALUE,
            CborValue::Int(op.checked.decoded.value_wei.try_into().map_err(invalid)?),
        ),
        (
            S::STATE,
            CborValue::Int(
                if !retained {
                    forum_operation_state::UNKNOWN
                } else if op.confirmed.is_some() {
                    forum_operation_state::CONFIRMED
                } else {
                    forum_operation_state::PENDING
                }
                .into(),
            ),
        ),
        (S::REVISION, CborValue::Int(revision.into())),
        (S::EPOCH, CborValue::Bytes(epoch.to_vec())),
    ];
    if retained {
        if let Some((block, index, _)) = op.confirmed {
            fields.extend([
                (S::BLOCK, CborValue::Int(block.into())),
                (S::TRANSACTION_INDEX, CborValue::Int(index.into())),
            ]);
        }
    }
    encode_forum_read_frame(TYPE_FORUM_OPERATION_STATUS, &cbor_map(fields))
        .map_err(|_| ForumError::Unavailable)
}

/// One page. `store` is `None` before anything was written: every page is then empty, and a
/// cursor (which only a written store could have issued) is refused as not retained.
fn page(
    store: Option<&Store>,
    network: &str,
    epoch: &[u8; 16],
    query: Query,
    raw: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let request_cursor = match raw {
        Some(raw) => {
            let cursor = decode_forum_cursor(raw).map_err(invalid)?;
            if cursor.epoch != epoch {
                return Err(ForumError::Expired);
            }
            if cursor.network != network {
                return Err(invalid("cursor network binding"));
            }
            Some(cursor)
        }
        None => None,
    };
    let incarnation = request_cursor.as_ref().map_or(0, |c| c.incarnation);
    let cursor_revision = request_cursor.as_ref().map(|c| c.revision);
    let next_cursor = |revision: u64, position: ForumCursorPosition| -> Result<Vec<u8>> {
        encode_forum_cursor(&ForumCursor {
            bytes: vec![],
            network: network.to_owned(),
            revision,
            epoch: epoch.to_vec(),
            incarnation,
            position,
        })
        .map_err(invalid)
    };
    match query {
        Query::Topic { topic, since } => {
            let mut after: Option<(Timestamp, [u8; 32])> = None;
            if let Some(cursor) = &request_cursor {
                let ForumCursorPosition::Topic {
                    topic: cur_topic,
                    since: cur_since,
                    timestamp,
                    hash,
                } = &cursor.position
                else {
                    return Err(invalid("cursor query binding"));
                };
                if cur_topic != &topic || cur_since != &since {
                    return Err(invalid("cursor query binding"));
                }
                let hash: [u8; 32] = hash
                    .as_slice()
                    .try_into()
                    .map_err(|_| invalid("cursor post hash length"))?;
                after = Some((*timestamp, hash));
            }
            let (stored, current_revision, more) = match store {
                None if after.is_some() => return Err(invalid("cursor tuple not retained")),
                None => (Vec::new(), 0, false),
                Some(store) => store.read(|tx| {
                    if let Some((timestamp, hash)) = &after {
                        let post = Store::post(tx, hash)?
                            .ok_or_else(|| invalid("cursor tuple not retained"))?;
                        if post.visible != Some(*timestamp) || post.topic != topic {
                            return Err(invalid("cursor tuple not retained"));
                        }
                    }
                    let prefix = Store::topic_index_prefix(&topic);
                    let start = match &after {
                        Some((ts, hash)) => {
                            key_after(&Store::topic_index_key(&topic, Some(*ts), Some(hash)))
                        }
                        None => Store::topic_index_key(&topic, Some(since), None),
                    };
                    let index = tx.get_range(&start, &prefix_end(&prefix), PAGE_ROWS + 1)?;
                    let more = index.len() > PAGE_ROWS;
                    let mut rows = Vec::new();
                    for (_, value) in index {
                        let hash: [u8; 32] = value
                            .as_slice()
                            .try_into()
                            .map_err(|_| ForumError::Unavailable)?;
                        let row = Store::stored_row(tx, &hash)?.ok_or(ForumError::Unavailable)?;
                        let visible = row.post.visible.ok_or(ForumError::Unavailable)?;
                        if row.post.topic != topic || time_key(visible) < time_key(since) {
                            continue;
                        }
                        rows.push(row);
                    }
                    Ok((rows, Store::revision(tx)?, more))
                })?,
            };
            let page_revision = cursor_revision.unwrap_or(current_revision);
            let total = stored.len();
            let mut rows = Vec::new();
            let mut budget = 4096;
            let mut last: Option<ForumCursorPosition> = None;
            for stored_row in stored {
                if rows.len() >= PAGE_ROWS {
                    break;
                }
                let store = store.ok_or(ForumError::Unavailable)?;
                let row: Row = store.resolve_row(stored_row as StoredRow)?;
                let visible = row.post.visible.ok_or(ForumError::Unavailable)?;
                let view = view_row(network, &row, epoch, page_revision)?;
                let charge = view.len() + topic.len() + 32 + 256;
                if budget + charge > PAGE_BYTES && !rows.is_empty() {
                    break;
                }
                budget += charge;
                last = Some(ForumCursorPosition::Topic {
                    topic: topic.clone(),
                    since,
                    timestamp: visible,
                    hash: row.hash.to_vec(),
                });
                rows.push(CborValue::Bytes(view));
            }
            let has_more = rows.len() < total || more;
            use forum_topic_page as P;
            let mut fields = vec![
                (P::NETWORK, CborValue::Text(network.to_owned())),
                (P::TOPIC, CborValue::Text(topic)),
                (P::SINCE, time_value(since)),
                (P::REVISION, CborValue::Int(page_revision.into())),
                (P::ROWS, CborValue::Array(rows)),
                (P::EPOCH, CborValue::Bytes(epoch.to_vec())),
            ];
            if let (true, Some(position)) = (has_more, last) {
                fields.push((
                    P::NEXT_CURSOR,
                    CborValue::Bytes(next_cursor(page_revision, position)?),
                ));
            }
            if let Some(request) = raw {
                fields.push((P::REQUEST_CURSOR, CborValue::Bytes(request.to_vec())));
            }
            encode_forum_read_frame(TYPE_FORUM_TOPIC_PAGE, &cbor_map(fields))
                .map_err(|_| ForumError::RowTooLarge)
        }
        Query::Discovery => {
            let mut after: Option<String> = None;
            if let Some(cursor) = &request_cursor {
                let ForumCursorPosition::Discovery { topic } = &cursor.position else {
                    return Err(invalid("cursor query binding"));
                };
                after = Some(topic.clone());
            }
            let (entries, current_revision, more) = match store {
                None if after.is_some() => return Err(invalid("cursor tuple not retained")),
                None => (Vec::new(), 0, false),
                Some(_) => store.ok_or(ForumError::Unavailable)?.read(|tx| {
                    if let Some(topic) = &after {
                        if Store::discovery_entry(tx, topic)?.is_none() {
                            return Err(invalid("cursor tuple not retained"));
                        }
                    }
                    let prefix = Store::discovery_prefix();
                    let start = match &after {
                        Some(topic) => key_after(&Store::discovery_key(topic)),
                        None => prefix.to_vec(),
                    };
                    let rows = tx.get_range(&start, &prefix_end(prefix), PAGE_ROWS + 1)?;
                    let more = rows.len() > PAGE_ROWS;
                    let mut entries = Vec::new();
                    for (key, value) in rows.into_iter().take(PAGE_ROWS) {
                        let topic = std::str::from_utf8(&key[prefix.len()..])
                            .map_err(|_| ForumError::Unavailable)?
                            .to_string();
                        let (count, last) = Store::decode_discovery_entry(&value)?;
                        entries.push((topic, count, last));
                    }
                    Ok((entries, Store::revision(tx)?, more))
                })?,
            };
            let page_revision = cursor_revision.unwrap_or(current_revision);
            let total = entries.len();
            let mut rows = Vec::new();
            let mut budget = 4096;
            let mut last: Option<ForumCursorPosition> = None;
            for (topic, count, last_activity) in entries {
                let charge = topic.len() * 2 + 512;
                if budget + charge > PAGE_BYTES && !rows.is_empty() {
                    break;
                }
                budget += charge;
                last = Some(ForumCursorPosition::Discovery {
                    topic: topic.clone(),
                });
                rows.push(cbor_map(vec![
                    (forum_discovery_entry::TOPIC, CborValue::Text(topic)),
                    (forum_discovery_entry::COUNT, CborValue::Int(count.into())),
                    (
                        forum_discovery_entry::LAST_ACTIVITY,
                        time_value(last_activity),
                    ),
                ]));
            }
            let has_more = rows.len() < total || more;
            use forum_discovery_page as P;
            let mut fields = vec![
                (P::NETWORK, CborValue::Text(network.to_owned())),
                (P::REVISION, CborValue::Int(page_revision.into())),
                (P::ENTRIES, CborValue::Array(rows)),
                (P::EPOCH, CborValue::Bytes(epoch.to_vec())),
            ];
            if let (true, Some(position)) = (has_more, last) {
                fields.push((
                    P::NEXT_CURSOR,
                    CborValue::Bytes(next_cursor(page_revision, position)?),
                ));
            }
            if let Some(request) = raw {
                fields.push((P::REQUEST_CURSOR, CborValue::Bytes(request.to_vec())));
            }
            encode_forum_read_frame(TYPE_FORUM_DISCOVERY_PAGE, &cbor_map(fields))
                .map_err(|_| ForumError::RowTooLarge)
        }
    }
}

pub(crate) fn policy(chain: u64, burn_address: Address) -> TopicBurnPolicy {
    TopicBurnPolicy {
        expected_chain_id: chain,
        burn_address,
    }
}

#[cfg(test)]
#[path = "forum_owner_tests.rs"]
mod tests;
