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
    monad_topic_cbor::{
        check_topic_burn_before_broadcast, hand_forum_event_to_node, parse_topic_event, Handoff,
        TopicBurnPolicy, TopicEvent,
    },
    monad_topic_verify::VoteDirection,
    store::{
        forum::{
            invalid, time_key, time_value, ForumError, Observation, Phase, Result, Row, Store,
            StoredRow, LAND_BOUND, STORE_SUFFIX,
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

    /// Admit an event and hand its burns to the node. It counts (a post is visible, a vote is
    /// in the tally) as soon as the node has accepted every burn of its set; the chain is not
    /// waited for. A set the node has not wholly accepted stays pending, and the background
    /// pass ([`Owner::reconcile`]) hands it over again.
    pub(crate) async fn submit<T: JsonRpcTransport + Clone>(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        frame: &[u8],
        transport: &T,
    ) -> Result<Vec<u8>> {
        let request = request(network, policy, frame)?;
        if request.checked.value_wei > i64::MAX as u128 {
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
        if op.phase != Phase::Pending {
            return status(&op);
        }
        // The durable reservation exists, so from here the event is never refused: a set the
        // node did not wholly take stays pending and is handed over again in the background.
        // No transaction is open while the node is asked, so a second replica given the same
        // set hands over the same bytes and counts it at most once.
        let handoffs =
            hand_forum_event_to_node(transport, &op.event, &op.checked, &policy, HANDOFF_WAIT)
                .await;
        if handoffs.iter().all(|h| *h == Handoff::Accepted) {
            let counted = blocking(|| store.count(&op, now()))?;
            return status(&counted);
        }
        for (index, handoff) in handoffs.iter().enumerate() {
            if let Handoff::Refused(reason) | Handoff::Unknown(reason) = handoff {
                tracing::warn!(
                    tx_hash = %hex::encode(op.checked.members[index].tx_hash.0),
                    %reason,
                    "Forum burn not accepted by the node; the event stays pending"
                );
            }
        }
        if handoffs.iter().all(|h| matches!(h, Handoff::Refused(_))) {
            // The node took none of them: say why, as a direct message's payments would.
            let reasons: Vec<_> = handoffs
                .iter()
                .filter_map(|h| match h {
                    Handoff::Refused(reason) => Some(reason.as_str()),
                    _ => None,
                })
                .collect();
            return Err(ForumError::Refused(reasons.join("; ")));
        }
        status(&op)
    }

    /// One background pass over the events not yet confirmed or dropped. For each, the chain
    /// is read once: when every burn landed the event is confirmed; when one reverted, or its
    /// nonce was taken by another transaction, or its burns have not all landed within
    /// [`LAND_BOUND`] of admission, it is dropped and its weight taken back (a post no counted
    /// burn pays for any more is hidden). Otherwise its burns are handed to the node again, and
    /// a pending event the node now wholly holds is counted. An event whose chain state cannot
    /// be read is left for the next pass. Any replica may run it; every change is one
    /// transaction that happens once.
    pub(crate) async fn reconcile<T: JsonRpcTransport + Clone>(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        transport: &T,
        now: Timestamp,
    ) -> Result<ReconcileReport> {
        let mut report = ReconcileReport::default();
        let Some(store) = self.store(network, policy, false)? else {
            return Ok(report);
        };
        let mut after = None;
        loop {
            let batch = blocking(|| store.unsettled(after.as_ref(), RECONCILE_BATCH))?;
            for hash in &batch {
                let Some(op) = blocking(|| store.load(hash))? else {
                    continue;
                };
                if op.phase.settled() {
                    continue;
                }
                // Another replica may have made the same change first: only this pass's own
                // changes are reported.
                let moved = reconcile_one(&store, &op, &policy, transport, now)
                    .await
                    .map(|phase| phase.filter(|phase| *phase != op.phase));
                match moved {
                    Ok(Some(Phase::Counted { .. })) => report.counted += 1,
                    Ok(Some(Phase::Confirmed { .. })) => report.confirmed += 1,
                    Ok(Some(Phase::Dropped)) => report.dropped += 1,
                    Ok(_) => report.waiting += 1,
                    Err(error) => {
                        report.waiting += 1;
                        tracing::warn!(
                            tx_hash = %hex::encode(hash),
                            %error,
                            "Forum reconciliation of an event failed; it is retried next pass"
                        );
                    }
                }
            }
            if batch.len() < RECONCILE_BATCH {
                break;
            }
            after = batch.last().copied();
        }
        Ok(report)
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

    /// Visible Forum posts, when this replica has opened the store. Metrics never
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

/// What one [`Owner::reconcile`] pass changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReconcileReport {
    pub(crate) counted: usize,
    pub(crate) confirmed: usize,
    pub(crate) dropped: usize,
    /// Events left for a later pass.
    pub(crate) waiting: usize,
}

/// Events one pass reads per store transaction.
const RECONCILE_BATCH: usize = 64;
/// Longest the relay waits on the node for one call before going on.
const HANDOFF_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// A burn without a receipt whose sender's nonce is already used is dropped only once the
/// event is this old: a receipt can show up on one upstream a little after the nonce moved on
/// another.
const NONCE_USED_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

fn older_than(first_seen: Timestamp, now: Timestamp, age: std::time::Duration) -> bool {
    let elapsed = (now.seconds as i128 - first_seen.seconds as i128) * 1_000_000_000
        + (now.nanoseconds as i128 - first_seen.nanoseconds as i128);
    elapsed > age.as_nanos() as i128
}

/// Settle or advance one unsettled event; `Some` names the phase it moved to.
async fn reconcile_one<T: JsonRpcTransport + Clone>(
    store: &Store,
    op: &Observation,
    policy: &TopicBurnPolicy,
    transport: &T,
    now: Timestamp,
) -> Result<Option<Phase>> {
    use crate::monad_topic_cbor::{probe_forum_burn, LandedBurn};
    let expected = crate::monad_topic_verify::ExpectedTopicBurn {
        commitment: bitcoinsuite_core::Sha256::new(*op.event.commitment()),
        burn_address: policy.burn_address,
    };
    let probes = futures::future::join_all(op.checked.members.iter().map(|member| {
        tokio::time::timeout(
            HANDOFF_WAIT,
            probe_forum_burn(transport, member, op.checked.direction, &expected),
        )
    }))
    .await;
    let mut landed = Vec::with_capacity(probes.len());
    let mut nonce_used = false;
    for probe in probes {
        match probe {
            Ok(Ok(LandedBurn::Landed(fact))) => landed.push(fact),
            Ok(Ok(LandedBurn::Failed(reason))) => {
                tracing::warn!(
                    tx_hash = %hex::encode(op.hash()),
                    %reason,
                    "A forum burn cannot pay; the event is dropped"
                );
                return blocking(|| store.drop_event(op)).map(|op| Some(op.phase));
            }
            Ok(Ok(LandedBurn::NonceUsed)) => nonce_used = true,
            Ok(Ok(LandedBurn::NotYet)) => {}
            // The chain could not be read: nothing is decided this pass.
            Ok(Err(error)) => return Err(ForumError::OutcomeUnknown(error.to_string())),
            Err(_) => {
                return Err(ForumError::OutcomeUnknown(
                    "no answer from the node in time".to_owned(),
                ))
            }
        }
    }
    if landed.len() == op.checked.members.len() {
        return blocking(|| store.confirm(op, &landed, now)).map(|op| Some(op.phase));
    }
    if older_than(op.first_seen, now, LAND_BOUND)
        || (nonce_used && older_than(op.first_seen, now, NONCE_USED_GRACE))
    {
        tracing::warn!(
            tx_hash = %hex::encode(op.hash()),
            "A forum event's burns did not all land; the event is dropped"
        );
        return blocking(|| store.drop_event(op)).map(|op| Some(op.phase));
    }
    let handoffs =
        hand_forum_event_to_node(transport, &op.event, &op.checked, policy, HANDOFF_WAIT).await;
    if op.phase == Phase::Pending && handoffs.iter().all(|h| *h == Handoff::Accepted) {
        return blocking(|| store.count(op, now)).map(|op| Some(op.phase));
    }
    Ok(None)
}

fn request(network: &str, policy: TopicBurnPolicy, frame: &[u8]) -> Result<Observation> {
    let event = parse_topic_event(frame, network).map_err(invalid)?;
    let checked = check_topic_burn_before_broadcast(&event, &policy).map_err(invalid)?;
    u64::try_from(checked.value_wei).map_err(invalid)?;
    Ok(Observation {
        event,
        checked,
        first_seen: now(),
        phase: Phase::Pending,
    })
}

fn view_row(network: &str, row: &Row, epoch: &[u8], revision: u64) -> Result<Vec<u8>> {
    let author = &row.author;
    let TopicEvent::Post(author_post) = &author.event else {
        return Err(ForumError::Unavailable);
    };
    let post = &row.post;
    use forum_single_view as V;
    encode_forum_read_frame(
        TYPE_FORUM_VIEW,
        &cbor_map(
            vec![
                (V::NETWORK, CborValue::Text(network.to_owned())),
                (
                    V::POST_FRAME,
                    CborValue::Bytes(author_post.post_frame.clone()),
                ),
                (
                    V::AUTHOR,
                    CborValue::Bytes(author.checked.lead().sender.0.to_vec()),
                ),
                (
                    V::AUTHOR_BURN_TX,
                    CborValue::Bytes(author.event.lead_burn_tx().to_vec()),
                ),
                (
                    V::TRANSACTION_HASH,
                    CborValue::Bytes(author.checked.lead().tx_hash.0.to_vec()),
                ),
                (
                    V::FIRST_VISIBLE,
                    time_value(post.visible.ok_or(ForumError::Unavailable)?),
                ),
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
            ]
            .into_iter()
            .chain(
                author
                    .phase
                    .position()
                    .into_iter()
                    .flat_map(|(block, index)| {
                        [
                            (V::BLOCK, CborValue::Int(block.into())),
                            (V::TRANSACTION_INDEX, CborValue::Int(index.into())),
                        ]
                    }),
            )
            .collect(),
        ),
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
            CborValue::Bytes(op.checked.lead().tx_hash.0.to_vec()),
        ),
        (
            S::SENDER,
            CborValue::Bytes(op.checked.lead().sender.0.to_vec()),
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
            CborValue::Int(op.checked.value_wei.try_into().map_err(invalid)?),
        ),
        (
            S::STATE,
            CborValue::Int(
                if !retained {
                    forum_operation_state::UNKNOWN
                } else {
                    match op.phase {
                        Phase::Pending => forum_operation_state::PENDING,
                        Phase::Counted { .. } => forum_operation_state::COUNTED,
                        Phase::Confirmed { .. } => forum_operation_state::CONFIRMED,
                        Phase::Dropped => forum_operation_state::DROPPED,
                    }
                }
                .into(),
            ),
        ),
        (S::REVISION, CborValue::Int(revision.into())),
        (S::EPOCH, CborValue::Bytes(epoch.to_vec())),
    ];
    if retained {
        if let Some((block, index)) = op.phase.position() {
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
