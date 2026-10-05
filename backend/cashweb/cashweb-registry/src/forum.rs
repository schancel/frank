//! Canonical Forum runtime: one lazy store owner and one serialized snapshot/publication boundary.
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use frank_cbor::{
    cbor_map, decode_forum_cursor, encode_forum_cursor, encode_forum_read_frame, CborValue,
    ForumCursor, ForumCursorPosition, Timestamp,
};
use rocksdb::{Direction, IteratorMode};

use crate::{
    monad_http::{Address, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    monad_topic_cbor::{
        check_topic_burn_before_broadcast, parse_topic_event, TopicBurnPolicy, TopicEvent,
    },
    monad_topic_verify::VoteDirection,
    store::forum::{invalid, time_key, time_value, ForumError, Observation, Post, Result, Store},
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
    unavailable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Query {
    Topic { topic: String, since: Timestamp },
    Discovery,
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
            epoch.copy_from_slice(&digest.as_slice()[..16]);
            *guard = Some(State {
                store,
                epoch,
                revision: 0,
                incarnation: 0,
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
        self.view_row(post, &self.epoch, self.revision)
    }

    fn view_row(&self, post: &Post, epoch: &[u8], revision: u64) -> Result<Vec<u8>> {
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
                (9, CborValue::Int(revision.into())),
                (10, CborValue::Bytes(epoch.to_vec())),
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

    fn page(&mut self, query: Query, raw: Option<&[u8]>) -> Result<Vec<u8>> {
        let (request_cursor, page_epoch, page_revision, incarnation) = if let Some(raw) = raw {
            let cursor = decode_forum_cursor(raw).map_err(invalid)?;
            if cursor.epoch != self.epoch {
                return Err(ForumError::Expired);
            }
            if cursor.network != self.store.network {
                return Err(invalid("cursor network binding"));
            }
            let epoch = cursor.epoch.clone();
            let revision = cursor.revision;
            let incarnation = cursor.incarnation;
            (Some(cursor), epoch, revision, incarnation)
        } else {
            (None, self.epoch.to_vec(), self.revision, 0)
        };

        match query {
            Query::Topic { topic, since } => {
                let mut after_cursor: Option<(Timestamp, [u8; 32])> = None;
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
                    if hash.len() != 32 {
                        return Err(invalid("cursor post hash length"));
                    }
                    let hash_arr: [u8; 32] = hash.as_slice().try_into().map_err(invalid)?;
                    let post = self
                        .store
                        .post(&hash_arr)?
                        .ok_or_else(|| invalid("cursor tuple not retained"))?;
                    if post.visible != Some(*timestamp) || post.topic != topic {
                        return Err(invalid("cursor tuple not retained"));
                    }
                    after_cursor = Some((*timestamp, hash_arr));
                }

                let prefix = Store::topic_index_prefix(&topic);
                let start_key = if let Some((ts, hash)) = after_cursor {
                    Store::topic_index_key(&topic, Some(ts), Some(&hash))
                } else {
                    Store::topic_index_key(&topic, Some(since), None)
                };

                let mut rows = Vec::new();
                let mut budget = 4096;
                let mut last_position: Option<ForumCursorPosition> = None;
                let mut has_more = false;

                for item in self
                    .store
                    .db()
                    .iterator(IteratorMode::From(&start_key, Direction::Forward))
                {
                    let (k, v) = item.map_err(|_| ForumError::Unavailable)?;
                    if !k.starts_with(&prefix) {
                        break;
                    }
                    if after_cursor.is_some() && k.as_ref() == start_key.as_slice() {
                        continue;
                    }

                    let hash: [u8; 32] =
                        v.as_ref().try_into().map_err(|_| ForumError::Unavailable)?;
                    let post = self.store.post(&hash)?.ok_or(ForumError::Unavailable)?;
                    let visible = post.visible.ok_or(ForumError::Unavailable)?;
                    if post.topic != topic {
                        continue;
                    }
                    if time_key(visible) < time_key(since) {
                        continue;
                    }

                    if rows.len() >= 128 {
                        has_more = true;
                        break;
                    }

                    let view_frame = self.view_row(&post, &page_epoch, page_revision)?;
                    let charge = view_frame.len() + topic.len() + 32 + 256;
                    if budget + charge > 4 * 1024 * 1024 && !rows.is_empty() {
                        has_more = true;
                        break;
                    }
                    budget += charge;
                    last_position = Some(ForumCursorPosition::Topic {
                        topic: topic.clone(),
                        since,
                        timestamp: visible,
                        hash: hash.to_vec(),
                    });
                    rows.push(CborValue::Bytes(view_frame));
                }

                let next = if has_more {
                    if let Some(pos) = last_position {
                        let cursor = ForumCursor {
                            bytes: vec![],
                            network: self.store.network.clone(),
                            revision: page_revision,
                            epoch: page_epoch.clone(),
                            incarnation,
                            position: pos,
                        };
                        Some(encode_forum_cursor(&cursor).map_err(invalid)?)
                    } else {
                        None
                    }
                } else {
                    None
                };

                let mut fields = vec![
                    (0, CborValue::Text(self.store.network.clone())),
                    (1, CborValue::Text(topic)),
                    (2, time_value(since)),
                    (3, CborValue::Int(page_revision.into())),
                    (4, CborValue::Array(rows)),
                    (6, CborValue::Bytes(page_epoch)),
                ];
                if let Some(next) = next {
                    fields.push((5, CborValue::Bytes(next)));
                }
                if let Some(request) = raw {
                    fields.push((7, CborValue::Bytes(request.to_vec())));
                }
                encode_forum_read_frame(13, &cbor_map(fields)).map_err(|_| ForumError::RowTooLarge)
            }
            Query::Discovery => {
                let mut after_topic: Option<String> = None;
                if let Some(cursor) = &request_cursor {
                    let ForumCursorPosition::Discovery { topic: cur_topic } = &cursor.position
                    else {
                        return Err(invalid("cursor query binding"));
                    };
                    if self.store.discovery_entry(cur_topic)?.is_none() {
                        return Err(invalid("cursor tuple not retained"));
                    }
                    after_topic = Some(cur_topic.clone());
                }

                let start_key = if let Some(ref t) = after_topic {
                    let mut k = vec![b'd'];
                    k.extend_from_slice(t.as_bytes());
                    k
                } else {
                    vec![b'd']
                };

                let mut rows = Vec::new();
                let mut budget = 4096;
                let mut last_position: Option<ForumCursorPosition> = None;
                let mut has_more = false;

                for item in self
                    .store
                    .db()
                    .iterator(IteratorMode::From(&start_key, Direction::Forward))
                {
                    let (k, v) = item.map_err(|_| ForumError::Unavailable)?;
                    if k.first() != Some(&b'd') {
                        break;
                    }
                    if after_topic.is_some() && k.as_ref() == start_key.as_slice() {
                        continue;
                    }

                    let topic = std::str::from_utf8(&k[1..])
                        .map_err(|_| ForumError::Unavailable)?
                        .to_string();
                    let (count, last) = self.store.decode_discovery_entry(&v)?;

                    if rows.len() >= 128 {
                        has_more = true;
                        break;
                    }

                    let charge = topic.len() * 2 + 512;
                    if budget + charge > 4 * 1024 * 1024 && !rows.is_empty() {
                        has_more = true;
                        break;
                    }
                    budget += charge;
                    last_position = Some(ForumCursorPosition::Discovery {
                        topic: topic.clone(),
                    });
                    rows.push(cbor_map(vec![
                        (0, CborValue::Text(topic)),
                        (1, CborValue::Int(count.into())),
                        (2, time_value(last)),
                    ]));
                }

                let next = if has_more {
                    if let Some(pos) = last_position {
                        let cursor = ForumCursor {
                            bytes: vec![],
                            network: self.store.network.clone(),
                            revision: page_revision,
                            epoch: page_epoch.clone(),
                            incarnation,
                            position: pos,
                        };
                        Some(encode_forum_cursor(&cursor).map_err(invalid)?)
                    } else {
                        None
                    }
                } else {
                    None
                };

                let mut fields = vec![
                    (0, CborValue::Text(self.store.network.clone())),
                    (1, CborValue::Int(page_revision.into())),
                    (2, CborValue::Array(rows)),
                    (4, CborValue::Bytes(page_epoch)),
                ];
                if let Some(next) = next {
                    fields.push((3, CborValue::Bytes(next)));
                }
                if let Some(request) = raw {
                    fields.push((5, CborValue::Bytes(request.to_vec())));
                }
                encode_forum_read_frame(14, &cbor_map(fields)).map_err(|_| ForumError::RowTooLarge)
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
            let mut expected = Vec::new();
            match &query {
                Query::Topic { topic, since } => {
                    state
                        .store
                        .visit_posts(topic, *since, |_, post| {
                            expected.push(CborValue::Bytes(state.view(&post)?));
                            Ok(())
                        })
                        .unwrap();
                }
                Query::Discovery => {
                    state
                        .store
                        .visit_topics(|topic, count, last| {
                            expected.push(cbor_map(vec![
                                (0, CborValue::Text(topic)),
                                (1, CborValue::Int(count.into())),
                                (2, time_value(last)),
                            ]));
                            Ok(())
                        })
                        .unwrap();
                }
            }
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
    fn stateless_topic_paging_has_no_capacity_ceiling_or_503() {
        let (_dir, mut state) = setup();
        for i in 0..32 {
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
        assert!(state.page(Query::Discovery, None).is_ok());
    }

    #[test]
    fn exact_terminal_cursor_echo_and_query_binding() {
        let (_dir, mut state) = setup();
        let post = publish(&mut state, 0, None, false);
        let query = Query::Topic {
            topic: "test.topic".into(),
            since: Timestamp {
                seconds: 0,
                nanoseconds: 0,
            },
        };
        state.page(query.clone(), None).unwrap();
        let cursor = encode_forum_cursor(&ForumCursor {
            bytes: Vec::new(),
            network: state.store.network.clone(),
            revision: state.revision,
            epoch: state.epoch.to_vec(),
            incarnation: 0,
            position: ForumCursorPosition::Topic {
                topic: "test.topic".into(),
                since: Timestamp {
                    seconds: 0,
                    nanoseconds: 0,
                },
                timestamp: Timestamp {
                    seconds: 200,
                    nanoseconds: 0,
                },
                hash: post.event.target_hash().to_vec(),
            },
        })
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
    fn cursors_survive_relay_restarts_without_expiring() {
        let dir = tempdir::TempDir::new("forum-restart").unwrap();
        let db_path = dir.path().join("db.rocksdb");
        let policy = policy(10143, Address([0x44; 20]));
        let op = observation(0, None, false);
        {
            let owner = Owner::new(db_path.clone());
            owner
                .with("monad-testnet", policy, true, |s| {
                    s.store.admit(op.clone()).unwrap();
                    s.store
                        .confirm(
                            &op.checked.decoded.tx_hash.0,
                            &facts(&op, 0, 0),
                            Timestamp {
                                seconds: 200,
                                nanoseconds: 0,
                            },
                        )
                        .unwrap();
                    s.revision += 1;
                    Ok(())
                })
                .unwrap();
        }
        let epoch = {
            use bitcoinsuite_core::{Hashed, Sha256};
            let d = Sha256::digest(
                [
                    b"forum-epoch-v1",
                    b"monad-testnet".as_slice(),
                    &policy.expected_chain_id.to_be_bytes(),
                    &policy.burn_address.0,
                ]
                .concat()
                .into(),
            );
            d.as_slice()[..16].to_vec()
        };
        let cursor = encode_forum_cursor(&ForumCursor {
            bytes: Vec::new(),
            network: "monad-testnet".into(),
            revision: 1,
            epoch,
            incarnation: 0,
            position: ForumCursorPosition::Topic {
                topic: "test.topic".into(),
                since: Timestamp {
                    seconds: 0,
                    nanoseconds: 0,
                },
                timestamp: Timestamp {
                    seconds: 200,
                    nanoseconds: 0,
                },
                hash: op.event.target_hash().to_vec(),
            },
        })
        .unwrap();

        let owner2 = Owner::new(db_path);
        let res = owner2.page(
            "monad-testnet",
            policy,
            Query::Topic {
                topic: "test.topic".into(),
                since: Timestamp {
                    seconds: 0,
                    nanoseconds: 0,
                },
            },
            Some(&cursor),
        );
        assert!(
            res.is_ok(),
            "stateless cursor must survive restart without expiring: {:?}",
            res.err()
        );
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

    #[derive(Debug, Clone)]
    struct ProofTransport {
        op: Observation,
        entered: std::sync::Arc<tokio::sync::Semaphore>,
        release: std::sync::Arc<tokio::sync::Semaphore>,
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        fail: bool,
    }

    #[async_trait::async_trait]
    impl JsonRpcTransport for ProofTransport {
        async fn call(
            &self,
            method: &str,
            params: serde_json::Value,
        ) -> std::result::Result<serde_json::Value, crate::monad_http::MonadRpcError> {
            use serde_json::json;
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail {
                return Err(crate::monad_http::MonadRpcError::InvalidResponse {
                    method: method.into(),
                    reason: "controlled uncertain response".into(),
                });
            }
            let hash = self.op.checked.decoded.tx_hash.to_hex();
            match method {
                "eth_sendRawTransaction" => {
                    assert_eq!(
                        params[0].as_str().unwrap(),
                        format!("0x{}", hex::encode(self.op.event.burn_tx()))
                    );
                    self.entered.add_permits(1);
                    self.release.acquire().await.unwrap().forget();
                    Ok(json!(hash))
                }
                "eth_getTransactionReceipt" => Ok(json!({"transactionHash": hash,
                    "blockHash": format!("0x{}", hex::encode([0x22;32])),
                    "blockNumber":"0x1", "transactionIndex":"0x0",
                    "from":self.op.checked.decoded.sender.to_hex(),
                    "to":Address([0x44;20]).to_hex(), "contractAddress":null,
                    "gasUsed":"0x5208", "status":"0x1", "logs":[]})),
                "eth_getTransactionByHash" => Ok(json!({"hash":hash,
                    "from":self.op.checked.decoded.sender.to_hex(),
                    "to":Address([0x44;20]).to_hex(), "value":"0x7",
                    "input":format!("0x{}",hex::encode(&self.op.checked.decoded.input))})),
                _ => panic!("unexpected RPC {method}"),
            }
        }
    }

    fn proof_transport(op: Observation, fail: bool) -> ProofTransport {
        ProofTransport {
            op,
            entered: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
            release: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
            calls: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            fail,
        }
    }

    fn proof_poll() -> PollConfig {
        PollConfig {
            interval: Duration::from_millis(1),
            max_attempts: 1,
        }
    }

    fn proof_parsed(frame: &[u8]) -> frank_cbor::ParsedFrame {
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(frame, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        parsed
    }

    #[tokio::test]
    async fn proof_concurrent_owner_duplicates_and_exact_event_conflict_publish_once() {
        use crate::store::forum::tests::{
            optional_observation, proof_reservations, proof_retained_records,
        };
        use std::sync::{atomic::Ordering, Arc};
        let dir = tempdir::TempDir::new("forum-proof-concurrency").unwrap();
        let owner = Arc::new(Owner::new(dir.path().join("db.rocksdb")));
        let policy = policy(10143, Address([0x44; 20]));
        let op = optional_observation(811);
        let transport = proof_transport(op.clone(), false);
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let owner = owner.clone();
            let transport = transport.clone();
            let frame = op.frame().to_vec();
            tasks.push(tokio::spawn(async move {
                owner
                    .submit("monad-testnet", policy, &frame, &transport, proof_poll())
                    .await
            }));
        }
        tokio::time::timeout(Duration::from_secs(5), transport.entered.acquire_many(2))
            .await
            .unwrap()
            .unwrap()
            .forget();
        let before = owner
            .with("monad-testnet", policy, true, |s| {
                assert_eq!(s.revision, 1);
                assert_eq!(s.store.pending_count(), 1);
                assert_eq!(
                    proof_reservations(&s.store, op.event.target_hash()),
                    (
                        crate::store::forum::Magnitude::from_u64(7),
                        crate::store::forum::Magnitude::default()
                    )
                );
                let retained = s.store.operation(&op.checked.decoded.tx_hash.0)?.unwrap();
                assert_eq!(retained.frame(), op.frame());
                assert!(retained.confirmed.is_none());
                assert!(s
                    .store
                    .post(op.event.target_hash())?
                    .unwrap()
                    .visible
                    .is_none());
                Ok(proof_retained_records(&s.store))
            })
            .unwrap()
            .unwrap();
        let parsed = proof_parsed(op.frame());
        let CborValue::Map(mut fields) = parsed.payload else {
            panic!()
        };
        fields.iter_mut().find(|(k, _)| *k == 99).unwrap().1 = CborValue::Bytes(vec![1, 2, 3]);
        let conflict = frank_cbor::encode_frame(
            frank_cbor::EnvelopeFields {
                type_id: 10,
                schema_version: 2,
                min_reader_version: 1,
            },
            frank_cbor::FramePayload::Value(&cbor_map(fields)),
        )
        .unwrap();
        assert_eq!(
            request("monad-testnet", policy, &conflict)
                .unwrap()
                .checked
                .decoded
                .tx_hash,
            op.checked.decoded.tx_hash
        );
        assert!(matches!(
            owner
                .submit("monad-testnet", policy, &conflict, &transport, proof_poll())
                .await,
            Err(ForumError::Conflict)
        ));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
        owner
            .with("monad-testnet", policy, true, |s| {
                assert_eq!(proof_retained_records(&s.store), before);
                Ok(())
            })
            .unwrap();
        transport.release.add_permits(2);
        let first = tokio::time::timeout(Duration::from_secs(5), tasks.remove(0))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let second = tokio::time::timeout(Duration::from_secs(5), tasks.remove(0))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first, second);
        let published = owner
            .with("monad-testnet", policy, true, |s| {
                assert_eq!(s.revision, 2);
                assert_eq!(s.store.pending_count(), 0);
                assert_eq!(
                    proof_reservations(&s.store, op.event.target_hash()),
                    (
                        crate::store::forum::Magnitude::default(),
                        crate::store::forum::Magnitude::default()
                    )
                );
                let post = s.store.post(op.event.target_hash())?.unwrap();
                assert!(post.visible.is_some());
                assert_eq!(
                    post.aggregate.magnitude,
                    crate::store::forum::Magnitude::from_u64(7)
                );
                Ok(proof_retained_records(&s.store))
            })
            .unwrap()
            .unwrap();
        let calls = transport.calls.load(Ordering::SeqCst);
        assert_eq!(
            owner
                .submit(
                    "monad-testnet",
                    policy,
                    op.frame(),
                    &transport,
                    proof_poll()
                )
                .await
                .unwrap(),
            first
        );
        assert_eq!(transport.calls.load(Ordering::SeqCst), calls);
        owner
            .with("monad-testnet", policy, true, |s| {
                assert_eq!(s.revision, 2);
                assert_eq!(proof_retained_records(&s.store), published);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn proof_real_owner_reopen_preserves_epoch_and_resumes_both_page_families() {
        let dir = tempdir::TempDir::new("forum-proof-owner-epoch").unwrap();
        let path = dir.path().join("db.rocksdb");
        let policy = policy(10143, Address([0x44; 20]));
        let owner = Owner::new(path.clone());
        owner
            .with("monad-testnet", policy, true, |s| {
                for nonce in 0..129 {
                    let topic_post = crate::store::forum::tests::distinct_post(nonce, "test.topic");
                    s.store.admit(topic_post.clone())?;
                    s.store.confirm(
                        &topic_post.checked.decoded.tx_hash.0,
                        &facts(&topic_post, nonce, 0),
                        topic_post.first_seen,
                    )?;
                    s.revision += 1;
                    let op = crate::store::forum::tests::distinct_post(
                        1000 + nonce,
                        &format!("topic.{nonce:03}"),
                    );
                    s.store.admit(op.clone())?;
                    s.store.confirm(
                        &op.checked.decoded.tx_hash.0,
                        &facts(&op, nonce, 0),
                        op.first_seen,
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let queries = [
            Query::Topic {
                topic: "test.topic".into(),
                since: Timestamp {
                    seconds: 0,
                    nanoseconds: 0,
                },
            },
            Query::Discovery,
        ];
        let mut retained = Vec::new();
        for query in &queries {
            let frame = owner
                .page("monad-testnet", policy, query.clone(), None)
                .unwrap();
            let parsed = proof_parsed(&frame);
            let cursor = match parsed.typed.as_deref().unwrap() {
                TypedPayload::ForumTopicPage(p) => p.next_cursor.as_ref().unwrap().clone(),
                TypedPayload::ForumDiscoveryPage(p) => p.next_cursor.as_ref().unwrap().clone(),
                _ => panic!(),
            };
            owner
                .page("monad-testnet", policy, query.clone(), Some(&cursor.bytes))
                .unwrap();
            retained.push(cursor);
        }
        drop(owner);
        let owner = Owner::new(path);
        for (query, cursor) in queries.iter().zip(&retained) {
            let frame = owner
                .page("monad-testnet", policy, query.clone(), None)
                .unwrap();
            let parsed = proof_parsed(&frame);
            let epoch = match parsed.typed.as_deref().unwrap() {
                TypedPayload::ForumTopicPage(p) => &p.epoch,
                TypedPayload::ForumDiscoveryPage(p) => &p.epoch,
                _ => panic!(),
            };
            assert_eq!(epoch, &cursor.epoch);
            assert!(
                owner
                    .page("monad-testnet", policy, query.clone(), Some(&cursor.bytes))
                    .is_ok(),
                "cursor must resume successfully after reopen"
            );
        }
    }

    #[tokio::test]
    async fn proof_revision_exhaustion_preserves_pending_obligation_and_never_wraps() {
        use crate::store::forum::tests::{
            optional_observation, proof_reservations, proof_retained_records,
        };
        use std::sync::atomic::Ordering;
        let dir = tempdir::TempDir::new("forum-proof-revision").unwrap();
        let owner = Owner::new(dir.path().join("db.rocksdb"));
        let policy = policy(10143, Address([0x44; 20]));
        owner
            .with("monad-testnet", policy, true, |s| {
                s.revision = u64::MAX - 2;
                Ok(())
            })
            .unwrap();
        let op = optional_observation(811);
        let uncertain = proof_transport(op.clone(), true);
        assert!(matches!(
            owner
                .submit(
                    "monad-testnet",
                    policy,
                    op.frame(),
                    &uncertain,
                    proof_poll()
                )
                .await,
            Err(ForumError::OutcomeUnknown(_))
        ));
        let before = owner
            .with("monad-testnet", policy, true, |s| {
                assert_eq!(s.revision, u64::MAX - 1);
                assert_eq!(s.store.pending_count(), 1);
                assert_eq!(
                    proof_reservations(&s.store, op.event.target_hash()),
                    (
                        crate::store::forum::Magnitude::from_u64(7),
                        crate::store::forum::Magnitude::default()
                    )
                );
                assert_eq!(
                    s.store
                        .operation(&op.checked.decoded.tx_hash.0)?
                        .unwrap()
                        .frame(),
                    op.frame()
                );
                Ok(proof_retained_records(&s.store))
            })
            .unwrap()
            .unwrap();
        let extra = optional_observation(812);
        let calls = uncertain.calls.load(Ordering::SeqCst);
        assert!(matches!(
            owner
                .submit(
                    "monad-testnet",
                    policy,
                    extra.frame(),
                    &uncertain,
                    proof_poll()
                )
                .await,
            Err(ForumError::Capacity)
        ));
        assert_eq!(uncertain.calls.load(Ordering::SeqCst), calls);
        owner
            .with("monad-testnet", policy, true, |s| {
                assert_eq!(s.revision, u64::MAX - 1);
                assert_eq!(s.store.pending_count(), 1);
                assert_eq!(
                    proof_reservations(&s.store, op.event.target_hash()),
                    (
                        crate::store::forum::Magnitude::from_u64(7),
                        crate::store::forum::Magnitude::default()
                    )
                );
                assert_eq!(proof_retained_records(&s.store), before);
                Ok(())
            })
            .unwrap();
        let confirmed = proof_transport(op.clone(), false);
        confirmed.release.add_permits(1);
        owner
            .submit(
                "monad-testnet",
                policy,
                op.frame(),
                &confirmed,
                proof_poll(),
            )
            .await
            .unwrap();
        owner
            .with("monad-testnet", policy, true, |s| {
                assert_eq!(s.revision, u64::MAX);
                assert_eq!(s.store.pending_count(), 0);
                assert_eq!(
                    proof_reservations(&s.store, op.event.target_hash()),
                    (
                        crate::store::forum::Magnitude::default(),
                        crate::store::forum::Magnitude::default()
                    )
                );
                assert!(s
                    .store
                    .operation(&op.checked.decoded.tx_hash.0)?
                    .unwrap()
                    .confirmed
                    .is_some());
                Ok(())
            })
            .unwrap();
        assert!(matches!(
            owner
                .submit(
                    "monad-testnet",
                    policy,
                    extra.frame(),
                    &uncertain,
                    proof_poll()
                )
                .await,
            Err(ForumError::Capacity)
        ));
    }
}
