//! Canonical Forum runtime: one lazy store owner and one serialized snapshot/publication boundary.
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use frank_cbor::{
    cbor_map, decode_forum_cursor, encode_forum_cursor, encode_forum_read_frame, CborValue,
    ForumCursor, ForumCursorPosition, Timestamp,
};
use rand::RngCore;

use crate::{
    monad_http::{Address, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    monad_topic_cbor::{
        check_topic_burn_before_broadcast, parse_topic_event, TopicBurnPolicy, TopicEvent,
    },
    monad_topic_verify::VoteDirection,
    store::forum::{invalid, time_value, ForumError, Observation, Post, Result, Store},
};

pub(crate) fn now() -> Timestamp {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Timestamp {
        seconds: time.as_secs().min(i64::MAX as u64) as i64,
        nanoseconds: time.subsec_nanos(),
    }
}

#[derive(Debug)]
pub(crate) struct Owner {
    path: PathBuf,
    state: Mutex<Option<State>>,
}

#[derive(Debug)]
struct State {
    store: Store,
    epoch: [u8; 16],
    revision: u64,
    incarnation: u64,
    snapshots: Vec<Snapshot>,
    unavailable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Query {
    Topic { topic: String, since: Timestamp },
    Discovery,
}

#[derive(Debug)]
struct Row {
    value: CborValue,
    position: ForumCursorPosition,
    charge: usize,
}

#[derive(Debug)]
struct Snapshot {
    query: Query,
    revision: u64,
    incarnation: u64,
    created: Instant,
    rows: Vec<Row>,
    charge: usize,
}

impl Owner {
    pub(crate) fn exists(&self) -> Result<bool> {
        match std::fs::symlink_metadata(Store::path(&self.path)?) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(ForumError::Unavailable),
        }
    }
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(None),
        }
    }

    fn with<T>(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        create: bool,
        f: impl FnOnce(&mut State) -> Result<T>,
    ) -> Result<Option<T>> {
        let mut guard = self.state.lock().map_err(|_| ForumError::Unavailable)?;
        if guard.is_none() {
            if !create {
                match std::fs::symlink_metadata(Store::path(&self.path)?) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(_) => return Err(ForumError::Unavailable),
                    _ => (),
                }
            }
            let store = Store::open(&self.path, network, policy)?;
            let mut epoch = [0; 16];
            rand::thread_rng().fill_bytes(&mut epoch);
            *guard = Some(State {
                store,
                epoch,
                revision: 0,
                incarnation: 0,
                snapshots: Vec::new(),
                unavailable: false,
            });
        }
        let state = guard.as_mut().ok_or(ForumError::Unavailable)?;
        if !Store::path(&self.path)?.join("CURRENT").is_file() {
            state.unavailable = true;
        }
        if state.unavailable || state.store.network != network || state.store.policy != policy {
            return Err(ForumError::Unavailable);
        }
        let result = f(state);
        if matches!(result, Err(ForumError::Unavailable)) {
            state.unavailable = true;
        }
        result.map(Some)
    }

    pub(crate) fn contains(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        hash: &[u8; 32],
    ) -> Result<bool> {
        Ok(self
            .with(network, policy, false, |state| {
                Ok(state.store.post(hash)?.is_some_and(|p| p.visible.is_some()))
            })?
            .unwrap_or(false))
    }

    pub(crate) fn view(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        hash: &[u8; 32],
    ) -> Result<Option<Vec<u8>>> {
        self.with(network, policy, false, |state| {
            let Some(post) = state.store.post(hash)? else {
                return Ok(None);
            };
            if post.visible.is_none() {
                return Ok(None);
            }
            Ok(Some(state.view(&post)?))
        })
        .map(Option::flatten)
    }

    pub(crate) fn status(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        frame: &[u8],
    ) -> Result<Vec<u8>> {
        let request = request(network, policy, frame)?;
        self.with(network, policy, true, |state| {
            let observation = state
                .store
                .operation(&request.checked.decoded.tx_hash.0)?
                .filter(|op| op.frame() == frame);
            state.status(
                observation.as_ref().unwrap_or(&request),
                observation.is_some(),
            )
        })?
        .ok_or(ForumError::Unavailable)
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
        let op = self
            .with(network, policy, true, |state| {
                // Reserve revision headroom for every retained uncertain publication as well
                // as this admission. No later successful burn may force a wrapped revision.
                let known = state
                    .store
                    .operation(&request.checked.decoded.tx_hash.0)?
                    .is_some();
                if !known {
                    state
                        .revision
                        .checked_add(state.store.pending_count())
                        .and_then(|v| v.checked_add(2))
                        .ok_or(ForumError::Capacity)?;
                }
                let admitted = state.store.admit(request)?;
                if !known {
                    state.revision += 1;
                }
                Ok(admitted)
            })?
            .ok_or(ForumError::Unavailable)?;
        if op.confirmed.is_some() {
            return self
                .with(network, policy, true, |s| s.status(&op, true))?
                .ok_or(ForumError::Unavailable);
        }
        // The durable reservation exists; every subsequent failure is indeterminate.
        // No lock is held while network confirmation is awaited.
        let verified = crate::monad_topic_cbor::broadcast_and_verify_forum_event(
            transport, &op.event, &policy, poll,
        )
        .await
        .map_err(|e| ForumError::OutcomeUnknown(e.to_string()))?;
        self.with(network, policy, true, |state| {
            let prior = state
                .store
                .operation(&verified.tx_hash.0)?
                .ok_or(ForumError::Unavailable)?;
            let confirmed = state.store.confirm(&verified.tx_hash.0, &verified, now())?;
            if prior.confirmed.is_none() {
                state.revision = state
                    .revision
                    .checked_add(1)
                    .ok_or(ForumError::Unavailable)?;
            }
            state.status(&confirmed, true)
        })
        .map_err(|e| ForumError::OutcomeUnknown(e.to_string()))?
        .ok_or(ForumError::Unavailable)
    }

    pub(crate) fn page(
        &self,
        network: &str,
        policy: TopicBurnPolicy,
        query: Query,
        cursor: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        self.with(network, policy, true, |state| state.page(query, cursor))?
            .ok_or(ForumError::Unavailable)
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

impl State {
    fn view(&self, post: &Post) -> Result<Vec<u8>> {
        let author = self
            .store
            .operation(&post.author.ok_or(ForumError::Unavailable)?)?
            .ok_or(ForumError::Unavailable)?;
        let (block, index, _) = author.confirmed.ok_or(ForumError::Unavailable)?;
        let TopicEvent::Post(author_post) = &author.event else {
            return Err(ForumError::Unavailable);
        };
        if author_post.post_frame != post.frame {
            return Err(ForumError::Unavailable);
        }
        encode_forum_read_frame(
            12,
            &cbor_map(vec![
                (0, CborValue::Text(self.store.network.clone())),
                (1, CborValue::Bytes(post.frame.clone())),
                (
                    2,
                    CborValue::Bytes(author.checked.decoded.sender.0.to_vec()),
                ),
                (3, CborValue::Bytes(author.event.burn_tx().to_vec())),
                (
                    4,
                    CborValue::Bytes(author.checked.decoded.tx_hash.0.to_vec()),
                ),
                (5, time_value(post.visible.ok_or(ForumError::Unavailable)?)),
                (6, CborValue::Int(block.into())),
                (7, CborValue::Int(index.into())),
                (
                    8,
                    cbor_map(vec![
                        (0, CborValue::Bool(post.aggregate.negative)),
                        (1, CborValue::Bytes(post.aggregate.magnitude.0.to_vec())),
                    ]),
                ),
                (9, CborValue::Int(self.revision.into())),
                (10, CborValue::Bytes(self.epoch.to_vec())),
            ]),
        )
        .map_err(|_| ForumError::Unavailable)
    }

    fn status(&self, op: &Observation, retained: bool) -> Result<Vec<u8>> {
        let mut fields = vec![
            (0, CborValue::Text(self.store.network.clone())),
            (1, CborValue::Bytes(op.frame().to_vec())),
            (2, CborValue::Bytes(op.event.target_hash().to_vec())),
            (3, CborValue::Bytes(op.checked.decoded.tx_hash.0.to_vec())),
            (4, CborValue::Bytes(op.checked.decoded.sender.0.to_vec())),
            (
                5,
                CborValue::Int(if op.checked.direction == VoteDirection::Up {
                    1
                } else {
                    0
                }),
            ),
            (
                6,
                CborValue::Int(op.checked.decoded.value_wei.try_into().map_err(invalid)?),
            ),
            (
                7,
                CborValue::Int(if !retained {
                    0
                } else if op.confirmed.is_some() {
                    2
                } else {
                    1
                }),
            ),
            (10, CborValue::Int(self.revision.into())),
            (11, CborValue::Bytes(self.epoch.to_vec())),
        ];
        if retained {
            if let Some((block, index, _)) = op.confirmed {
                fields.extend([
                    (8, CborValue::Int(block.into())),
                    (9, CborValue::Int(index.into())),
                ]);
            }
        }
        encode_forum_read_frame(15, &cbor_map(fields)).map_err(|_| ForumError::Unavailable)
    }

    fn cursor(&self, snapshot: &Snapshot, position: ForumCursorPosition) -> Result<Vec<u8>> {
        encode_forum_cursor(&ForumCursor {
            bytes: Vec::new(),
            network: self.store.network.clone(),
            revision: snapshot.revision,
            epoch: self.epoch.to_vec(),
            incarnation: snapshot.incarnation,
            position,
        })
        .map_err(invalid)
    }

    fn materialize(&self, query: Query, incarnation: u64) -> Result<Snapshot> {
        let mut snapshot = Snapshot {
            query: query.clone(),
            revision: self.revision,
            incarnation,
            created: Instant::now(),
            rows: Vec::new(),
            charge: 4096,
        };
        let occupied: usize = self.snapshots.iter().map(|s| s.charge).sum();
        // Empty queries still retain their snapshot/index overhead. Reserve it
        // before construction, just as every later row reserves its capacity.
        if occupied
            .checked_add(snapshot.charge)
            .ok_or(ForumError::SnapshotTooLarge)?
            > 256 * 1024 * 1024
        {
            return Err(ForumError::SnapshotTooLarge);
        }
        let mut push = |row: Row| -> Result<()> {
            let next = snapshot
                .charge
                .checked_add(row.charge + std::mem::size_of::<Row>() * 2)
                .ok_or(ForumError::SnapshotTooLarge)?;
            if next > 64 * 1024 * 1024 || occupied + next > 256 * 1024 * 1024 {
                return Err(ForumError::SnapshotTooLarge);
            }
            snapshot
                .rows
                .try_reserve_exact(1)
                .map_err(|_| ForumError::SnapshotTooLarge)?;
            snapshot.rows.push(row);
            snapshot.charge = next;
            Ok(())
        };
        match query {
            Query::Topic { topic, since } => {
                self.store.visit_posts(&topic, since, |hash, post| {
                    let frame = self.view(&post)?;
                    let charge = frame.capacity() + topic.len() + 32 + 256;
                    push(Row {
                        value: CborValue::Bytes(frame),
                        position: ForumCursorPosition::Topic {
                            topic: topic.clone(),
                            since,
                            timestamp: post.visible.ok_or(ForumError::Unavailable)?,
                            hash: hash.to_vec(),
                        },
                        charge,
                    })
                })?
            }
            Query::Discovery => self.store.visit_topics(|topic, count, last| {
                let charge = topic.capacity() * 2 + 512;
                push(Row {
                    value: cbor_map(vec![
                        (0, CborValue::Text(topic.clone())),
                        (1, CborValue::Int(count.into())),
                        (2, time_value(last)),
                    ]),
                    position: ForumCursorPosition::Discovery { topic },
                    charge,
                })
            })?,
        }
        Ok(snapshot)
    }

    fn page_frame(
        &self,
        snapshot: &Snapshot,
        start: usize,
        end: usize,
        request: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        let rows = snapshot.rows[start..end]
            .iter()
            .map(|r| r.value.clone())
            .collect();
        let next = if end < snapshot.rows.len() && end > start {
            Some(self.cursor(snapshot, snapshot.rows[end - 1].position.clone())?)
        } else {
            None
        };
        let (id, mut fields, next_key, echo_key) = match &snapshot.query {
            Query::Topic { topic, since } => (
                13,
                vec![
                    (0, CborValue::Text(self.store.network.clone())),
                    (1, CborValue::Text(topic.clone())),
                    (2, time_value(*since)),
                    (3, CborValue::Int(snapshot.revision.into())),
                    (4, CborValue::Array(rows)),
                    (6, CborValue::Bytes(self.epoch.to_vec())),
                ],
                5,
                7,
            ),
            Query::Discovery => (
                14,
                vec![
                    (0, CborValue::Text(self.store.network.clone())),
                    (1, CborValue::Int(snapshot.revision.into())),
                    (2, CborValue::Array(rows)),
                    (4, CborValue::Bytes(self.epoch.to_vec())),
                ],
                3,
                5,
            ),
        };
        if let Some(next) = next {
            fields.push((next_key, CborValue::Bytes(next)));
        }
        if let Some(request) = request {
            fields.push((echo_key, CborValue::Bytes(request.to_vec())));
        }
        encode_forum_read_frame(id, &cbor_map(fields)).map_err(|_| ForumError::RowTooLarge)
    }

    fn page(&mut self, query: Query, raw: Option<&[u8]>) -> Result<Vec<u8>> {
        let now = Instant::now();
        self.snapshots
            .retain(|s| now.duration_since(s.created) < Duration::from_secs(120));
        let (index, start) = if let Some(raw) = raw {
            let cursor = decode_forum_cursor(raw).map_err(invalid)?;
            if cursor.epoch != self.epoch {
                return Err(ForumError::Expired);
            }
            let index = self
                .snapshots
                .iter()
                .position(|s| s.incarnation == cursor.incarnation)
                .ok_or(ForumError::Expired)?;
            let snapshot = &self.snapshots[index];
            if cursor.network != self.store.network
                || cursor.revision != snapshot.revision
                || snapshot.query != query
            {
                return Err(invalid("cursor query binding"));
            }
            let row = snapshot
                .rows
                .iter()
                .position(|r| r.position == cursor.position)
                .ok_or_else(|| invalid("cursor tuple not retained"))?;
            (index, row + 1)
        } else if let Some(index) = self
            .snapshots
            .iter()
            .position(|s| s.query == query && s.revision == self.revision)
        {
            (index, 0)
        } else {
            self.incarnation = self
                .incarnation
                .checked_add(1)
                .ok_or(ForumError::SnapshotCapacity)?;
            if self.snapshots.len() >= 16 {
                return Err(ForumError::SnapshotCapacity);
            }
            let snapshot = self.materialize(query, self.incarnation)?;
            if snapshot.created.elapsed() >= Duration::from_secs(120) {
                return Err(ForumError::Expired);
            }
            self.snapshots.push(snapshot);
            (self.snapshots.len() - 1, 0)
        };
        let snapshot = &self.snapshots[index];
        // Bound construction before cloning payloads, then let the shared codec enforce
        // complete encoded size and cumulative item/depth budgets. Drop each attempted
        // page before constructing the next; retain no unmetered database snapshot.
        let mut end = start;
        let mut budget = 4096;
        while end < snapshot.rows.len() && end - start < 128 {
            if budget + snapshot.rows[end].charge > 4 * 1024 * 1024 {
                break;
            }
            budget += snapshot.rows[end].charge;
            end += 1;
        }
        loop {
            match self.page_frame(snapshot, start, end, raw) {
                Ok(frame) if frame.len() <= 4 * 1024 * 1024 => return Ok(frame),
                _ if end > start + 1 => end -= 1,
                _ => return Err(ForumError::RowTooLarge),
            }
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
mod tests {
    use super::*;
    use crate::store::forum::tests::{facts, observation};
    use frank_cbor::{TypedPayload, ValidationResult};

    fn setup() -> (tempdir::TempDir, State) {
        let dir = tempdir::TempDir::new("forum-snapshot").unwrap();
        let store = Store::open(
            &dir.path().join("db.rocksdb"),
            "monad-testnet",
            policy(10143, Address([0x44; 20])),
        )
        .unwrap();
        (
            dir,
            State {
                store,
                epoch: [1; 16],
                revision: 0,
                incarnation: 0,
                snapshots: vec![],
                unavailable: false,
            },
        )
    }

    fn publish(state: &mut State, nonce: u64, target: Option<[u8; 32]>, down: bool) -> Observation {
        let op = observation(nonce, target, down);
        state.store.admit(op.clone()).unwrap();
        state
            .store
            .confirm(
                &op.checked.decoded.tx_hash.0,
                &facts(&op, nonce, 0),
                Timestamp {
                    seconds: 200,
                    nanoseconds: 0,
                },
            )
            .unwrap();
        state.revision += 1;
        op
    }

    #[test]
    fn full_pages_preserve_exact_snapshot_rows_and_reject_forged_tuples() {
        for discovery in [false, true] {
            let (_dir, mut state) = setup();
            for nonce in 0..130 {
                let topic = if discovery {
                    format!("topic.{nonce:03}")
                } else {
                    "test.topic".into()
                };
                let op = crate::store::forum::tests::distinct_post(nonce, &topic);
                state.store.admit(op.clone()).unwrap();
                state
                    .store
                    .confirm(
                        &op.checked.decoded.tx_hash.0,
                        &facts(&op, nonce, 0),
                        Timestamp {
                            seconds: 200,
                            nanoseconds: 0,
                        },
                    )
                    .unwrap();
                state.revision += 1;
            }
            let query = if discovery {
                Query::Discovery
            } else {
                Query::Topic {
                    topic: "test.topic".into(),
                    since: Timestamp {
                        seconds: 0,
                        nanoseconds: 0,
                    },
                }
            };
            let first = state.page(query.clone(), None).unwrap();
            let expected = state.snapshots[0]
                .rows
                .iter()
                .map(|r| r.value.clone())
                .collect::<Vec<_>>();
            let mut observed = Vec::new();
            let mut frame = first;
            let mut request: Option<Vec<u8>> = None;
            let mut pages = 0;
            loop {
                assert!(frame.len() <= 4 * 1024 * 1024);
                let ValidationResult::Parsed(parsed) =
                    frank_cbor::validate_frame(&frame, &frank_cbor::default_context()).unwrap()
                else {
                    panic!()
                };
                let (next, echo, count, rows) = match parsed.typed.as_deref().unwrap() {
                    TypedPayload::ForumTopicPage(page) => (
                        page.next_cursor.as_ref(),
                        page.request_cursor.as_ref(),
                        page.rows.len(),
                        page.rows
                            .iter()
                            .map(|r| CborValue::Bytes(r.frame.clone()))
                            .collect::<Vec<_>>(),
                    ),
                    TypedPayload::ForumDiscoveryPage(page) => {
                        let CborValue::Map(fields) = &parsed.payload else {
                            panic!()
                        };
                        let CborValue::Array(rows) =
                            fields.iter().find(|(k, _)| *k == 2).unwrap().1.clone()
                        else {
                            panic!()
                        };
                        (
                            page.next_cursor.as_ref(),
                            page.request_cursor.as_ref(),
                            page.entries.len(),
                            rows,
                        )
                    }
                    _ => panic!(),
                };
                assert!(count > 0 && count <= 128);
                assert_eq!(echo.map(|c| &c.bytes), request.as_ref());
                observed.extend(rows);
                pages += 1;
                let Some(next) = next else { break };
                let mut forged = next.clone();
                match &mut forged.position {
                    ForumCursorPosition::Topic { hash, .. } => *hash = vec![0xaa; 32],
                    ForumCursorPosition::Discovery { topic } => *topic = "unknown.topic".into(),
                }
                let forged = encode_forum_cursor(&forged).unwrap();
                assert!(matches!(
                    state.page(query.clone(), Some(&forged)),
                    Err(ForumError::Invalid(_))
                ));
                request = Some(next.bytes.clone());
                frame = state.page(query.clone(), request.as_deref()).unwrap();
            }
            assert_eq!(pages, 2);
            assert_eq!(observed, expected);
        }
    }

    #[test]
    fn actual_charged_snapshots_reserve_empty_query_overhead() {
        let (_dir, mut state) = setup();
        let row_overhead = std::mem::size_of::<Row>() * 2;
        let mut charged = 4096;
        let mut nonce = 0;
        let publish_sized = |state: &mut State, nonce: u64, title_len: usize| {
            let op = crate::store::forum::tests::sized_post(nonce, "test.topic", title_len);
            state.store.admit(op.clone()).unwrap();
            state
                .store
                .confirm(
                    &op.checked.decoded.tx_hash.0,
                    &facts(&op, nonce, 0),
                    Timestamp {
                        seconds: 200,
                        nanoseconds: 0,
                    },
                )
                .unwrap();
            state.revision += 1;
            let post = state.store.post(op.event.target_hash()).unwrap().unwrap();
            let frame = state.view(&post).unwrap();
            frame.capacity() + post.topic.len() + 32 + 256 + row_overhead
        };
        let large_title = 262_000;
        let large_charge = publish_sized(&mut state, nonce, large_title);
        charged += large_charge;
        nonce += 1;
        let target = 64 * 1024 * 1024 - 512;
        while target - charged > 2 * (large_charge + 128) {
            charged += publish_sized(&mut state, nonce, large_title);
            nonce += 1;
        }
        // Exact frame capacities let valid final titles approach the quota without
        // assigning fictional charges. Nonce/CBOR integer width variations are bounded
        // by the explicitly asserted 256-byte margin below.
        let fixed = large_charge - large_title;
        let title = (target - charged) / 2 - fixed - 64;
        charged += publish_sized(&mut state, nonce, title);
        nonce += 1;
        let title = target - charged - fixed - 64;
        charged += publish_sized(&mut state, nonce, title);
        assert!(charged <= target + 128 && charged >= target - 256);
        for seconds in 0..4 {
            let query = Query::Topic {
                topic: "test.topic".into(),
                since: Timestamp {
                    seconds,
                    nanoseconds: 0,
                },
            };
            state.page(query, None).unwrap();
        }
        assert_eq!(state.snapshots.len(), 4);
        let actual = state.snapshots[0].charge;
        assert!(actual > 64 * 1024 * 1024 - 1024);
        for snapshot in &state.snapshots {
            assert_eq!(snapshot.charge, actual);
            assert!(snapshot.charge <= 64 * 1024 * 1024);
            assert!(!snapshot.rows.is_empty());
        }
        let occupied: usize = state.snapshots.iter().map(|s| s.charge).sum();
        assert!(occupied <= 256 * 1024 * 1024);
        assert!(occupied + 4096 > 256 * 1024 * 1024);
        let empty = Query::Topic {
            topic: "empty.topic".into(),
            since: Timestamp {
                seconds: 0,
                nanoseconds: 0,
            },
        };
        assert!(matches!(
            state.page(empty.clone(), None),
            Err(ForumError::SnapshotTooLarge)
        ));
        assert_eq!(
            state.snapshots.len(),
            4,
            "failed empty construction must not publish or evict"
        );
        let nonempty = Query::Topic {
            topic: "test.topic".into(),
            since: Timestamp {
                seconds: 4,
                nanoseconds: 0,
            },
        };
        assert!(matches!(
            state.page(nonempty.clone(), None),
            Err(ForumError::SnapshotTooLarge)
        ));
        assert_eq!(state.snapshots.len(), 4);
        assert_eq!(
            state.incarnation, 6,
            "failed allocations consume incarnations"
        );
        state.snapshots.truncate(3); // Controls have genuine remaining room.
        state.page(empty, None).unwrap();
        assert!(state.snapshots.last().unwrap().rows.is_empty());
        state.snapshots.truncate(3);
        state.page(nonempty, None).unwrap();
        assert!(!state.snapshots.last().unwrap().rows.is_empty());
    }

    #[test]
    fn retained_snapshot_is_immutable_after_new_votes() {
        let (_dir, mut state) = setup();
        let post = publish(&mut state, 0, None, false);
        let query = Query::Topic {
            topic: "test.topic".into(),
            since: Timestamp {
                seconds: 0,
                nanoseconds: 0,
            },
        };
        let first = state.page(query.clone(), None).unwrap();
        let frozen = state.snapshots[0].rows[0].value.clone();
        publish(&mut state, 1, Some(*post.event.target_hash()), true);
        let second = state.page(query, None).unwrap();
        assert_ne!(first, second);
        assert_eq!(state.snapshots[0].rows[0].value, frozen);
        assert_ne!(
            state.snapshots[0].rows[0].value,
            state.snapshots[1].rows[0].value
        );
        assert_eq!(state.snapshots.len(), 2);
    }

    #[test]
    fn expired_incarnation_cannot_resume_recreated_query_at_same_revision() {
        for discovery in [false, true] {
            let (_dir, mut state) = setup();
            publish(&mut state, 0, None, false);
            let query = if discovery {
                Query::Discovery
            } else {
                Query::Topic {
                    topic: "test.topic".into(),
                    since: Timestamp {
                        seconds: 0,
                        nanoseconds: 0,
                    },
                }
            };
            state.page(query.clone(), None).unwrap();
            let snapshot = &state.snapshots[0];
            let cursor = state
                .cursor(snapshot, snapshot.rows[0].position.clone())
                .unwrap();
            state.snapshots[0].created = Instant::now() - Duration::from_secs(121);
            state.page(query.clone(), None).unwrap();
            assert!(matches!(
                state.page(query, Some(&cursor)),
                Err(ForumError::Expired)
            ));
        }
    }

    #[test]
    fn exact_terminal_cursor_echo_and_query_binding() {
        let (_dir, mut state) = setup();
        publish(&mut state, 0, None, false);
        let query = Query::Topic {
            topic: "test.topic".into(),
            since: Timestamp {
                seconds: 0,
                nanoseconds: 0,
            },
        };
        state.page(query.clone(), None).unwrap();
        let snapshot = &state.snapshots[0];
        let cursor = state
            .cursor(snapshot, snapshot.rows[0].position.clone())
            .unwrap();
        let terminal = state.page(query.clone(), Some(&cursor)).unwrap();
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&terminal, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumTopicPage(page) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert!(page.rows.is_empty());
        assert!(page.next_cursor.is_none());
        assert_eq!(page.request_cursor.as_ref().unwrap().bytes, cursor);
        assert!(matches!(
            state.page(Query::Discovery, Some(&cursor)),
            Err(ForumError::Invalid(_))
        ));
        state.epoch = [2; 16];
        assert!(matches!(
            state.page(query, Some(&cursor)),
            Err(ForumError::Expired)
        ));
    }

    #[test]
    fn snapshot_count_and_incarnation_do_not_wrap_or_evict_live_queries() {
        let (_dir, mut state) = setup();
        for i in 0..16 {
            state
                .page(
                    Query::Topic {
                        topic: format!("topic.{i}"),
                        since: Timestamp {
                            seconds: 0,
                            nanoseconds: 0,
                        },
                    },
                    None,
                )
                .unwrap();
        }
        assert!(matches!(
            state.page(Query::Discovery, None),
            Err(ForumError::SnapshotCapacity)
        ));
        assert_eq!(state.snapshots.len(), 16);
        assert_eq!(state.incarnation, 17);
        state.snapshots.clear();
        state.incarnation = u64::MAX;
        assert!(matches!(
            state.page(Query::Discovery, None),
            Err(ForumError::SnapshotCapacity)
        ));
        assert_eq!(state.incarnation, u64::MAX);
    }

    #[test]
    fn status_of_another_burn_does_not_borrow_post_confirmation() {
        let (dir, mut state) = setup();
        let confirmed = publish(&mut state, 0, None, false);
        let other = observation(1, None, false);
        assert_eq!(confirmed.event.target_hash(), other.event.target_hash());
        let owner = Owner {
            path: dir.path().join("db.rocksdb"),
            state: Mutex::new(Some(state)),
        };
        let response = owner
            .status(
                "monad-testnet",
                policy(10143, Address([0x44; 20])),
                other.frame(),
            )
            .unwrap();
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&response, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumOperationStatus(status) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert_eq!(
            status.evidence,
            frank_cbor::ForumOperationEvidence::UnknownRequest
        );
        let guard = owner.state.lock().unwrap();
        assert!(guard
            .as_ref()
            .unwrap()
            .store
            .operation(&other.checked.decoded.tx_hash.0)
            .unwrap()
            .is_none());
    }
}
