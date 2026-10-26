//! Where the relay keeps the forum, over the [`RelayKvStore`] transaction contract, so every
//! replica of a cluster serves the same posts, votes, counts and cursors.
//!
//! Keys (inside the store; FoundationDB adds `<fdb_subspace_prefix>forum-v1/`):
//!
//! | key | value | what it is |
//! |---|---|---|
//! | `format` | [`FORMAT`] | the store's format; anything else stops with the reset path |
//! | `h` | `forum-store-header` | the network, chain id and burn address the store is bound to |
//! | `e/` lead tx hash | stored frame | the exact submitted post or vote frame (authority, immutable) |
//! | `o/` lead tx hash | `forum-observation-row` | that event's state: pending, or confirmed at the lead's block/index |
//! | `m/` tx hash | lead tx hash | every burn of an event's set, naming the event it pays for |
//! | `p/` post hash | `forum-post-row` | the post's topic, author burn, first visibility, aggregate and pending reservations |
//! | `t/` sha256(topic) time post hash | post hash | a topic's visible posts in first-visible order |
//! | `d/` topic | `forum-discovery-row` | the topic's visible post count and last activity |
//! | `q` | `forum-pending-accounting` | pending burns and their byte charge, for the capacity limits |
//! | `r` | revision (u64 BE) | advanced by every new admission and every first confirmation |
//! | `n` | count (u64 LE, atomic add) | visible posts, for metrics |
//! | `lv/` | | this store's large-value index |
//!
//! A stored frame is inline up to [`INLINE_LIMIT`]; a larger one is an object in the store
//! composition passes in, named `forum/sha256/<hex>/<upload>`, whose reference commits in the
//! admission transaction. Frames never change, so a vote never re-uploads its post.
//!
//! An event (a post or a vote) is paid by a set of burns, the way a direct message is paid by a
//! set of stamp payments. The first burn listed is the lead: its hash keys the event.
//!
//! Only `e/`, `o/` and `m/` are authority. `p/`, `t/`, `d/`, `q`, `r` and `n` are derived from them,
//! and every admission or confirmation writes the authority and everything derived from it in
//! one transaction, so they never disagree and nothing is rebuilt on open. A derived row that
//! does not match its authority is a corrupt store: reads fail closed (`Unavailable`), and
//! nothing is repaired or reset.
//!
//! Exactly-once burn accounting: every burn's transaction hash belongs to one event (`m/`), so a
//! burn submitted again inside another event's set is a conflict, refused before anything is
//! broadcast. Admission reserves the set's total on the post once (a repeat finds `o/` and
//! changes nothing), and confirmation of every burn of the set moves the reservation into the
//! aggregate once (a repeat finds the event confirmed). Two replicas
//! racing on one burn conflict on `o/` and `q`, so one commits and the other sees its row.
//! A commit whose outcome is unknown is settled by a fence: one transaction that rewrites `q`
//! unchanged, which the first attempt read, so once the fence commits that attempt either
//! landed (the fence sees its row) or never will.
//!
//! The store's calls block (FoundationDB waits on its own network thread), so async callers
//! hand the worker over for each call.
use std::sync::Arc;

use frank_cbor::message_fields::{
    forum_discovery_row, forum_observation_row, forum_observation_state, forum_pending_accounting,
    forum_post_row, forum_store_header, forum_store_row_version, timestamp as time_fields,
};
use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue, Timestamp};
use thiserror::Error;

use crate::monad_topic_cbor::{
    check_topic_burn_before_broadcast, parse_topic_event, CheckedTopicBurn, TopicBurnPolicy,
    TopicEvent, VerifiedTopicBurn,
};
use crate::monad_topic_verify::VoteDirection;
use crate::store::kv_store::{KvError, KvTransaction, RelayKvStore, Transact};
use crate::store::large_values::{
    LargeValueError, LargeValues, ObjectStore, Staged, Stored, SweepReport, INLINE_LIMIT,
};

pub(crate) type Result<T> = std::result::Result<T, ForumError>;

#[derive(Debug, Error)]
pub(crate) enum ForumError {
    #[error("Forum storage or retained authority unavailable")]
    Unavailable,
    #[error("invalid Forum request: {0}")]
    Invalid(String),
    #[error("Forum target not found")]
    NotFound,
    #[error("same transaction has different retained request bytes")]
    Conflict,
    #[error("Forum pending capacity or arithmetic headroom exhausted")]
    Capacity,
    #[error("Forum cursor expired or unknown")]
    Expired,
    #[error("Forum row cannot fit an encoded page")]
    RowTooLarge,
    #[error("topic burn outcome unknown: {0}")]
    OutcomeUnknown(String),
    /// A store commit whose outcome is unknown. Settled by a fence before anything is reported.
    #[error("Forum store commit outcome unknown: {0}")]
    CommitUnknown(String),
    /// A large frame's upload intent was swept before the admission committed; stage it again.
    #[error("Forum large-value intent lost")]
    IntentLost,
}

impl From<KvError> for ForumError {
    fn from(error: KvError) -> Self {
        match error {
            KvError::CommitUnknownResult(reason) => Self::CommitUnknown(reason),
            other => {
                tracing::warn!("Forum store: {other}");
                Self::Unavailable
            }
        }
    }
}

impl From<LargeValueError> for ForumError {
    fn from(error: LargeValueError) -> Self {
        match error {
            LargeValueError::Kv(error) => error.into(),
            LargeValueError::IntentLost => Self::IntentLost,
            other => {
                tracing::warn!("Forum large values: {other}");
                Self::Unavailable
            }
        }
    }
}

pub(crate) fn invalid(error: impl std::fmt::Display) -> ForumError {
    ForumError::Invalid(error.to_string())
}

/// Format marker key and value of this store.
pub(crate) const FORMAT_KEY: &[u8] = b"format";
pub(crate) const FORMAT: &[u8] = b"frank-forum-kv-v1";
/// A single-node relay keeps the store beside its registry database, at the database's file
/// name plus this suffix.
pub(crate) const STORE_SUFFIX: &str = ".forum-kv-v1";
/// Suffixes of forum stores written by earlier development builds. None can be read.
pub(crate) const OLD_STORE_SUFFIXES: &[&str] = &[".forum-cbor-v1"];
/// The forum's namespace in the shared object store.
pub(crate) const OBJECT_NAMESPACE: &str = "forum";
const HEADER: &[u8] = b"h";
const FRAMES: &[u8] = b"e/";
const STATES: &[u8] = b"o/";
const MEMBERS: &[u8] = b"m/";
const POSTS: &[u8] = b"p/";
const TOPIC_INDEX: &[u8] = b"t/";
const DISCOVERY: &[u8] = b"d/";
const PENDING: &[u8] = b"q";
const REVISION: &[u8] = b"r";
const VISIBLE_POSTS: &[u8] = b"n";
const LARGE_VALUES: &[u8] = b"lv/";
/// Pending burns the store holds at once, and their byte charge.
pub(crate) const MAX_PENDING_COUNT: u64 = 4096;
pub(crate) const MAX_PENDING_BYTES: u64 = 64 * 1024 * 1024;
/// How many times one call settles an unknown commit or restages a lost upload.
const SETTLE_ATTEMPTS: usize = 8;

pub(crate) fn time_value(time: Timestamp) -> CborValue {
    cbor_map(vec![
        (time_fields::SECONDS, CborValue::Int(time.seconds.into())),
        (
            time_fields::NANOSECONDS,
            CborValue::Int(time.nanoseconds.into()),
        ),
    ])
}

pub(crate) fn time_key(time: Timestamp) -> (i64, u32) {
    (time.seconds, time.nanoseconds)
}

fn field(value: &CborValue, key: u64) -> Result<&CborValue> {
    let CborValue::Map(fields) = value else {
        return Err(ForumError::Unavailable);
    };
    fields
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
        .ok_or(ForumError::Unavailable)
}

fn closed(value: &CborValue, keys: &[u64]) -> Result<()> {
    let CborValue::Map(fields) = value else {
        return Err(ForumError::Unavailable);
    };
    if fields.len() != keys.len() || fields.iter().any(|(key, _)| !keys.contains(key)) {
        return Err(ForumError::Unavailable);
    }
    Ok(())
}

fn uint(value: &CborValue) -> Result<u64> {
    match value {
        CborValue::Int(n) => (*n).try_into().map_err(|_| ForumError::Unavailable),
        _ => Err(ForumError::Unavailable),
    }
}

fn bytes(value: &CborValue) -> Result<&[u8]> {
    match value {
        CborValue::Bytes(bytes) => Ok(bytes),
        _ => Err(ForumError::Unavailable),
    }
}

pub(crate) fn timestamp(value: &CborValue) -> Result<Timestamp> {
    closed(value, time_fields::SHAPE.required)?;
    let CborValue::Int(seconds) = field(value, time_fields::SECONDS)? else {
        return Err(ForumError::Unavailable);
    };
    let nanos = uint(field(value, time_fields::NANOSECONDS)?)?;
    if nanos > 999_999_999 {
        return Err(ForumError::Unavailable);
    }
    Ok(Timestamp {
        seconds: (*seconds).try_into().map_err(|_| ForumError::Unavailable)?,
        nanoseconds: nanos as u32,
    })
}

fn encode(value: &CborValue) -> Result<Vec<u8>> {
    encode_canonical(value).map_err(|_| ForumError::Unavailable)
}
fn decode(bytes: &[u8]) -> Result<CborValue> {
    decode_canonical(bytes).map_err(|_| ForumError::Unavailable)
}
fn key(prefix: &[u8], suffix: &[u8]) -> Vec<u8> {
    [prefix, suffix].concat()
}
fn version_ok(map: &CborValue, key: u64) -> Result<()> {
    if uint(field(map, key)?)? != u64::from(forum_store_row_version::V1) {
        return Err(ForumError::Unavailable);
    }
    Ok(())
}

/// Checked magnitude, deliberately independent of host integer width.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Magnitude(pub(crate) [u8; 32]);

impl Magnitude {
    pub(crate) fn from_u64(value: u64) -> Self {
        let mut bytes = [0; 32];
        bytes[24..].copy_from_slice(&value.to_be_bytes());
        Self(bytes)
    }
    pub(crate) fn add(self, rhs: Self) -> Result<Self> {
        let mut out = [0; 32];
        let mut carry = 0u16;
        for i in (0..32).rev() {
            let n = self.0[i] as u16 + rhs.0[i] as u16 + carry;
            out[i] = n as u8;
            carry = n >> 8;
        }
        if carry != 0 {
            return Err(ForumError::Capacity);
        }
        Ok(Self(out))
    }
    pub(crate) fn sub(self, rhs: Self) -> Result<Self> {
        if self < rhs {
            return Err(ForumError::Unavailable);
        }
        let mut out = [0; 32];
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let n = self.0[i] as i16 - rhs.0[i] as i16 - borrow;
            out[i] = n as u8;
            borrow = i16::from(n < 0);
        }
        Ok(Self(out))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Aggregate {
    pub(crate) negative: bool,
    pub(crate) magnitude: Magnitude,
}

impl Aggregate {
    pub(crate) fn add(self, negative: bool, value: Magnitude) -> Result<Self> {
        let (negative, magnitude) = if self.negative == negative {
            (negative, self.magnitude.add(value)?)
        } else if self.magnitude >= value {
            (self.negative, self.magnitude.sub(value)?)
        } else {
            (negative, value.sub(self.magnitude)?)
        };
        Ok(Self {
            negative: negative && magnitude != Magnitude::default(),
            magnitude,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Observation {
    pub(crate) event: TopicEvent,
    pub(crate) checked: CheckedTopicBurn,
    pub(crate) first_seen: Timestamp,
    pub(crate) confirmed: Option<(u64, u64, Timestamp)>,
}

impl Observation {
    pub(crate) fn frame(&self) -> &[u8] {
        match &self.event {
            TopicEvent::Post(post) => &post.frame,
            TopicEvent::Vote(vote) => &vote.frame,
        }
    }
    /// The lead burn's hash: the event's key.
    pub(crate) fn hash(&self) -> [u8; 32] {
        self.checked.lead().tx_hash.0
    }
    fn state_value(&self) -> CborValue {
        use forum_observation_row as R;
        let mut fields = vec![
            (
                R::VERSION,
                CborValue::Int(forum_store_row_version::V1.into()),
            ),
            (R::FIRST_SEEN, time_value(self.first_seen)),
            (
                R::STATE,
                CborValue::Int(
                    if self.confirmed.is_some() {
                        forum_observation_state::CONFIRMED
                    } else {
                        forum_observation_state::PENDING
                    }
                    .into(),
                ),
            ),
        ];
        if let Some((block, index, visible)) = self.confirmed {
            fields.extend([
                (R::BLOCK, CborValue::Int(block.into())),
                (R::TRANSACTION_INDEX, CborValue::Int(index.into())),
                (R::VISIBLE, time_value(visible)),
            ]);
        }
        cbor_map(fields)
    }
    /// The byte charge of a pending burn against [`MAX_PENDING_BYTES`]: its frame, the post it
    /// may create, and fixed bookkeeping. The same at admission and at confirmation.
    pub(crate) fn charge(&self) -> u64 {
        let post = match &self.event {
            TopicEvent::Post(p) => p.post_frame.len() + p.topic.len(),
            _ => 0,
        };
        (self.frame().len() + post + 1024) as u64
    }
    /// This request with the state stored for it (`o/`).
    fn with_state(&self, state: &[u8]) -> Result<Self> {
        let (first_seen, confirmed) = decode_state(state)?;
        Ok(Self {
            first_seen,
            confirmed,
            ..self.clone()
        })
    }
}

type State = (Timestamp, Option<(u64, u64, Timestamp)>);

fn decode_state(value: &[u8]) -> Result<State> {
    use forum_observation_row as R;
    let map = decode(value)?;
    let state = uint(field(&map, R::STATE)?)?;
    let confirmed = state == u64::from(forum_observation_state::CONFIRMED);
    closed(
        &map,
        if confirmed {
            &[
                R::VERSION,
                R::FIRST_SEEN,
                R::STATE,
                R::BLOCK,
                R::TRANSACTION_INDEX,
                R::VISIBLE,
            ]
        } else {
            R::SHAPE.required
        },
    )?;
    version_ok(&map, R::VERSION)?;
    if !(state == u64::from(forum_observation_state::PENDING) || confirmed) {
        return Err(ForumError::Unavailable);
    }
    Ok((
        timestamp(field(&map, R::FIRST_SEEN)?)?,
        if confirmed {
            Some((
                uint(field(&map, R::BLOCK)?)?,
                uint(field(&map, R::TRANSACTION_INDEX)?)?,
                timestamp(field(&map, R::VISIBLE)?)?,
            ))
        } else {
            None
        },
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Post {
    pub(crate) topic: String,
    /// The confirmed burn that authored the post: its frame holds the post frame.
    pub(crate) author: Option<[u8; 32]>,
    pub(crate) visible: Option<Timestamp>,
    pub(crate) aggregate: Aggregate,
    pub(crate) reserved_up: Magnitude,
    pub(crate) reserved_down: Magnitude,
}

impl Post {
    fn value(&self) -> CborValue {
        use forum_post_row as R;
        let mut fields = vec![
            (
                R::VERSION,
                CborValue::Int(forum_store_row_version::V1.into()),
            ),
            (R::NEGATIVE, CborValue::Bool(self.aggregate.negative)),
            (
                R::MAGNITUDE,
                CborValue::Bytes(self.aggregate.magnitude.0.to_vec()),
            ),
            (
                R::RESERVED_UP,
                CborValue::Bytes(self.reserved_up.0.to_vec()),
            ),
            (
                R::RESERVED_DOWN,
                CborValue::Bytes(self.reserved_down.0.to_vec()),
            ),
            (R::TOPIC, CborValue::Text(self.topic.clone())),
        ];
        if let (Some(author), Some(visible)) = (self.author, self.visible) {
            fields.extend([
                (R::AUTHOR, CborValue::Bytes(author.to_vec())),
                (R::VISIBLE, time_value(visible)),
            ]);
        }
        cbor_map(fields)
    }
    fn parse(value: &CborValue) -> Result<Self> {
        use forum_post_row as R;
        let known = field(value, R::AUTHOR).is_ok();
        closed(
            value,
            if known {
                &[
                    R::VERSION,
                    R::AUTHOR,
                    R::VISIBLE,
                    R::NEGATIVE,
                    R::MAGNITUDE,
                    R::RESERVED_UP,
                    R::RESERVED_DOWN,
                    R::TOPIC,
                ]
            } else {
                R::SHAPE.required
            },
        )?;
        version_ok(value, R::VERSION)?;
        let mag = |k| -> Result<Magnitude> {
            Ok(Magnitude(
                bytes(field(value, k)?)?
                    .try_into()
                    .map_err(|_| ForumError::Unavailable)?,
            ))
        };
        let CborValue::Bool(negative) = field(value, R::NEGATIVE)? else {
            return Err(ForumError::Unavailable);
        };
        let CborValue::Text(topic) = field(value, R::TOPIC)? else {
            return Err(ForumError::Unavailable);
        };
        let magnitude = mag(R::MAGNITUDE)?;
        if *negative && magnitude == Magnitude::default() {
            return Err(ForumError::Unavailable);
        }
        Ok(Self {
            topic: topic.clone(),
            author: if known {
                Some(
                    bytes(field(value, R::AUTHOR)?)?
                        .try_into()
                        .map_err(|_| ForumError::Unavailable)?,
                )
            } else {
                None
            },
            visible: if known {
                Some(timestamp(field(value, R::VISIBLE)?)?)
            } else {
                None
            },
            aggregate: Aggregate {
                negative: *negative,
                magnitude,
            },
            reserved_up: mag(R::RESERVED_UP)?,
            reserved_down: mag(R::RESERVED_DOWN)?,
        })
    }
}

/// The parts of a visible post read in one transaction; the author's frame may still be an
/// object to read ([`Store::resolve_row`]).
#[derive(Debug, Clone)]
pub(crate) struct StoredRow {
    pub(crate) hash: [u8; 32],
    pub(crate) post: Post,
    author: [u8; 32],
    author_frame: Stored,
    author_state: Vec<u8>,
}

/// A visible post and the confirmed burn that authored it.
#[derive(Debug, Clone)]
pub(crate) struct Row {
    pub(crate) hash: [u8; 32],
    pub(crate) post: Post,
    pub(crate) author: Observation,
}

enum Admission {
    New(Observation),
    Existing(Observation),
}

fn stored_matches(stored: &Stored, frame: &[u8]) -> bool {
    match stored {
        Stored::Inline(bytes) => bytes == frame,
        Stored::Large(reference) => reference.matches(frame),
    }
}

/// The open forum store of one network and burn policy.
pub(crate) struct Store {
    kv: Arc<dyn RelayKvStore>,
    large: LargeValues,
    pub(crate) network: String,
    pub(crate) policy: TopicBurnPolicy,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForumStore")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

impl Store {
    /// Open the store on `kv`. Without `create`, a store with no format marker is `None` and
    /// nothing is written. A store of another format, or bound to another network or burn
    /// policy, is refused (`Unavailable`) with `reset` logged: it is never adopted or rewritten.
    pub(crate) fn open(
        kv: Arc<dyn RelayKvStore>,
        objects: Arc<dyn ObjectStore>,
        network: &str,
        policy: TopicBurnPolicy,
        create: bool,
        reset: &str,
    ) -> Result<Option<Self>> {
        let header = encode(&cbor_map(vec![
            (
                forum_store_header::VERSION,
                CborValue::Int(forum_store_row_version::V1.into()),
            ),
            (forum_store_header::NETWORK, CborValue::Text(network.into())),
            (
                forum_store_header::CHAIN_ID,
                CborValue::Int(policy.expected_chain_id.into()),
            ),
            (
                forum_store_header::BURN_ADDRESS,
                CborValue::Bytes(policy.burn_address.0.to_vec()),
            ),
        ]))?;
        enum Found {
            Ready,
            Missing,
            OtherFormat,
            OtherPolicy,
        }
        let found = kv.transact(|tx| -> Result<Found> {
            match (tx.get(FORMAT_KEY)?, tx.get(HEADER)?) {
                (Some(format), Some(stored)) if format == FORMAT => Ok(if stored == header {
                    Found::Ready
                } else {
                    Found::OtherPolicy
                }),
                (Some(_), _) => Ok(Found::OtherFormat),
                (None, _) if !tx.scan_prefix(b"", None, 1)?.is_empty() => Ok(Found::OtherFormat),
                (None, _) if create => {
                    tx.set(FORMAT_KEY, FORMAT)?;
                    tx.set(HEADER, &header)?;
                    Ok(Found::Ready)
                }
                (None, _) => Ok(Found::Missing),
            }
        })?;
        match found {
            Found::Ready => Ok(Some(Self {
                large: LargeValues::new(kv.clone(), objects, LARGE_VALUES, OBJECT_NAMESPACE),
                kv,
                network: network.into(),
                policy,
            })),
            Found::Missing => Ok(None),
            Found::OtherFormat => {
                tracing::error!("{reset}");
                Err(ForumError::Unavailable)
            }
            Found::OtherPolicy => {
                tracing::error!(
                    network,
                    "The forum store is bound to another network, chain id or burn address \
                     than [registry.forum] configures; it is never rewritten. {reset}"
                );
                Err(ForumError::Unavailable)
            }
        }
    }

    /// Run a read-only transaction.
    pub(crate) fn read<T>(
        &self,
        body: impl FnMut(&mut dyn KvTransaction) -> Result<T>,
    ) -> Result<T> {
        self.kv.transact(body)
    }

    pub(crate) fn topic_index_prefix(topic: &str) -> Vec<u8> {
        use bitcoinsuite_core::{Hashed, Sha256};
        key(
            TOPIC_INDEX,
            Sha256::digest(topic.as_bytes().into()).as_slice(),
        )
    }

    pub(crate) fn topic_index_key(
        topic: &str,
        time: Option<Timestamp>,
        post_hash: Option<&[u8; 32]>,
    ) -> Vec<u8> {
        let mut key = Self::topic_index_prefix(topic);
        if let Some(time) = time {
            key.extend_from_slice(&((time.seconds as u64) ^ (1 << 63)).to_be_bytes());
            key.extend_from_slice(&time.nanoseconds.to_be_bytes());
            if let Some(hash) = post_hash {
                key.extend_from_slice(hash);
            }
        }
        key
    }

    pub(crate) fn discovery_prefix() -> &'static [u8] {
        DISCOVERY
    }

    pub(crate) fn discovery_key(topic: &str) -> Vec<u8> {
        key(DISCOVERY, topic.as_bytes())
    }

    /// The stored frame and state of the burn `hash`.
    pub(crate) fn operation(
        tx: &mut dyn KvTransaction,
        hash: &[u8; 32],
    ) -> Result<Option<(Stored, Vec<u8>)>> {
        let Some(state) = tx.get(&key(STATES, hash))? else {
            return Ok(None);
        };
        let frame = tx
            .get(&key(FRAMES, hash))?
            .and_then(|raw| Stored::decode(&raw))
            .ok_or(ForumError::Unavailable)?;
        Ok(Some((frame, state)))
    }

    /// The stored burn `hash` when its frame is exactly `request`'s, with its stored state.
    pub(crate) fn retained(
        tx: &mut dyn KvTransaction,
        request: &Observation,
    ) -> Result<Option<Observation>> {
        match Self::operation(tx, &request.hash())? {
            Some((frame, state)) if stored_matches(&frame, request.frame()) => {
                Ok(Some(request.with_state(&state)?))
            }
            _ => Ok(None),
        }
    }

    pub(crate) fn post(tx: &mut dyn KvTransaction, hash: &[u8; 32]) -> Result<Option<Post>> {
        tx.get(&key(POSTS, hash))?
            .map(|v| Post::parse(&decode(&v)?))
            .transpose()
    }

    pub(crate) fn revision(tx: &mut dyn KvTransaction) -> Result<u64> {
        match tx.get(REVISION)? {
            None => Ok(0),
            Some(raw) => Ok(u64::from_be_bytes(
                raw.try_into().map_err(|_| ForumError::Unavailable)?,
            )),
        }
    }

    fn pending(tx: &mut dyn KvTransaction) -> Result<(u64, u64)> {
        use forum_pending_accounting as Q;
        let Some(raw) = tx.get(PENDING)? else {
            return Ok((0, 0));
        };
        let map = decode(&raw)?;
        closed(&map, Q::SHAPE.required)?;
        version_ok(&map, Q::VERSION)?;
        Ok((uint(field(&map, Q::COUNT)?)?, uint(field(&map, Q::BYTES)?)?))
    }

    fn put_pending(tx: &mut dyn KvTransaction, count: u64, bytes: u64) -> Result<()> {
        use forum_pending_accounting as Q;
        tx.set(
            PENDING,
            &encode(&cbor_map(vec![
                (
                    Q::VERSION,
                    CborValue::Int(forum_store_row_version::V1.into()),
                ),
                (Q::COUNT, CborValue::Int(count.into())),
                (Q::BYTES, CborValue::Int(bytes.into())),
            ]))?,
        )?;
        Ok(())
    }

    /// Pending burns and their byte charge.
    #[cfg(test)]
    pub(crate) fn pending_accounting(&self) -> Result<(u64, u64)> {
        self.read(|tx| Self::pending(tx))
    }

    pub(crate) fn decode_discovery_entry(value: &[u8]) -> Result<(u64, Timestamp)> {
        use forum_discovery_row as D;
        let map = decode(value)?;
        closed(&map, D::SHAPE.required)?;
        version_ok(&map, D::VERSION)?;
        Ok((
            uint(field(&map, D::COUNT)?)?,
            timestamp(field(&map, D::LAST_ACTIVITY)?)?,
        ))
    }

    pub(crate) fn discovery_entry(
        tx: &mut dyn KvTransaction,
        topic: &str,
    ) -> Result<Option<(u64, Timestamp)>> {
        tx.get(&Self::discovery_key(topic))?
            .map(|v| Self::decode_discovery_entry(&v))
            .transpose()
    }

    /// Visible posts, from the `n` counter.
    pub(crate) fn stored_post_count(&self) -> Result<u64> {
        self.read(|tx| match tx.get(VISIBLE_POSTS)? {
            None => Ok(0),
            Some(raw) => Ok(u64::from_le_bytes(
                raw.try_into().map_err(|_| ForumError::Unavailable)?,
            )),
        })
    }

    /// Delete unreferenced forum objects as sweep lease holder `holder`.
    pub(crate) fn sweep_large_values(&self, holder: [u8; 16]) -> Result<SweepReport> {
        Ok(self.large.sweep(holder)?)
    }

    /// The post a request targets, or the post a new post request creates.
    fn pending_post(tx: &mut dyn KvTransaction, observation: &Observation) -> Result<Post> {
        if let Some(post) = Self::post(tx, observation.event.target_hash())? {
            return Ok(post);
        }
        let TopicEvent::Post(post) = &observation.event else {
            return Err(ForumError::NotFound);
        };
        Ok(Post {
            topic: post.topic.clone(),
            author: None,
            visible: None,
            aggregate: Aggregate::default(),
            reserved_up: Magnitude::default(),
            reserved_down: Magnitude::default(),
        })
    }

    pub(crate) fn reserve(observation: &Observation, mut post: Post) -> Result<Post> {
        let amount = Magnitude::from_u64(observation.checked.value_wei as u64);
        let negative = observation.checked.direction == VoteDirection::Down;
        let reserved = if negative {
            &mut post.reserved_down
        } else {
            &mut post.reserved_up
        };
        *reserved = reserved.add(amount)?;
        // Headroom: the aggregate must absorb every reservation in either receipt order.
        post.aggregate.add(negative, *reserved)?;
        Ok(post)
    }

    /// Admit a burn: store its exact frame and reserve its value, once. A repeat of the same
    /// frame returns the stored burn; another frame for the same transaction is a conflict.
    pub(crate) fn admit(&self, observation: Observation) -> Result<Observation> {
        let frame = observation.frame();
        if frame.len() > INLINE_LIMIT {
            // A repeat of a large frame is answered without uploading it again.
            if let Some(op) = self.read(|tx| match Self::operation(tx, &observation.hash())? {
                Some((stored, _)) if !stored_matches(&stored, frame) => Err(ForumError::Conflict),
                Some((_, state)) => Ok(Some(observation.with_state(&state)?)),
                None => Ok(None),
            })? {
                return Ok(op);
            }
        }
        let mut staged: Option<Staged> = None;
        let mut attempts = 0;
        let result = loop {
            attempts += 1;
            if frame.len() > INLINE_LIMIT && staged.is_none() {
                staged = Some(self.large.stage(frame)?);
            }
            match self
                .kv
                .transact(|tx| self.admit_body(tx, &observation, staged.as_ref()))
            {
                Err(ForumError::IntentLost) if attempts < SETTLE_ATTEMPTS => {
                    // The sweep judged the upload dead; it collects the object. Upload anew.
                    staged = None;
                }
                Err(ForumError::CommitUnknown(reason)) if attempts < SETTLE_ATTEMPTS => {
                    tracing::warn!(
                        tx_hash = %hex::encode(observation.hash()),
                        %reason,
                        "Forum admission commit outcome unknown; fencing and reading the store"
                    );
                    match self.fence(&observation)? {
                        Some(op) => {
                            break Ok(if self.is_ours(&observation, staged.as_ref())? {
                                Admission::New(op)
                            } else {
                                Admission::Existing(op)
                            })
                        }
                        // The first attempt can no longer commit: admit afresh.
                        None => {}
                    }
                }
                other => break other,
            }
        };
        if let Some(staged) = &staged {
            // Expiring the intent is safe even for a committed reference: the sweep keeps every
            // referenced object. Skip the work when this call's upload is the stored one.
            if !matches!(result, Ok(Admission::New(_))) {
                self.large.abandon(staged);
            }
        }
        match result? {
            Admission::New(op) | Admission::Existing(op) => Ok(op),
        }
    }

    fn is_ours(&self, observation: &Observation, staged: Option<&Staged>) -> Result<bool> {
        let Some(staged) = staged else {
            return Ok(false);
        };
        let hash = observation.hash();
        Ok(self.read(|tx| Self::operation(tx, &hash))?.is_some_and(
            |(frame, _)| matches!(frame, Stored::Large(r) if r.upload == staged.reference.upload),
        ))
    }

    /// Settle an unknown commit for `request`'s burn: rewrite `q` unchanged (every admission
    /// and confirmation read it), then report what is stored for the burn. Once this commits,
    /// the unknown attempt has landed or never will.
    fn fence(&self, request: &Observation) -> Result<Option<Observation>> {
        let found = self.kv.transact(|tx| {
            let (count, bytes) = Self::pending(tx)?;
            Self::put_pending(tx, count, bytes)?;
            Self::operation(tx, &request.hash())
        });
        match found {
            Ok(Some((frame, state))) => {
                if !stored_matches(&frame, request.frame()) {
                    return Err(ForumError::Conflict);
                }
                Ok(Some(request.with_state(&state)?))
            }
            Ok(None) => Ok(None),
            Err(ForumError::CommitUnknown(reason)) => Err(ForumError::OutcomeUnknown(reason)),
            Err(error) => Err(error),
        }
    }

    fn admit_body(
        &self,
        tx: &mut dyn KvTransaction,
        observation: &Observation,
        staged: Option<&Staged>,
    ) -> Result<Admission> {
        let hash = observation.hash();
        let frame = observation.frame();
        if let Some((stored, state)) = Self::operation(tx, &hash)? {
            if !stored_matches(&stored, frame) {
                return Err(ForumError::Conflict);
            }
            let ours = matches!((&stored, staged),
                (Stored::Large(r), Some(s)) if r.upload == s.reference.upload);
            let op = observation.with_state(&state)?;
            return Ok(if ours {
                Admission::New(op)
            } else {
                Admission::Existing(op)
            });
        }
        // A burn pays for one event: one already in another event's set is refused here,
        // before this relay broadcasts anything.
        for member in &observation.checked.members {
            if let Some(owner) = tx.get(&key(MEMBERS, &member.tx_hash.0))? {
                if owner.as_slice() != hash.as_slice() {
                    return Err(ForumError::Conflict);
                }
            }
        }
        let post = Self::pending_post(tx, observation)?;
        let (count, bytes) = Self::pending(tx)?;
        if matches!(observation.event, TopicEvent::Post(_)) && post.visible.is_none() {
            if let Some((topic_count, _)) = Self::discovery_entry(tx, &post.topic)? {
                // Conservative headroom for every pending operation: a count may
                // never overflow after its newly admitted post has already burned.
                topic_count
                    .checked_add(count)
                    .and_then(|v| v.checked_add(1))
                    .ok_or(ForumError::Capacity)?;
            }
        }
        if matches!(observation.event, TopicEvent::Vote(_)) && post.visible.is_none() {
            return Err(ForumError::NotFound);
        }
        let post = Self::reserve(observation, post)?;
        let count = count.checked_add(1).ok_or(ForumError::Capacity)?;
        let bytes = bytes
            .checked_add(observation.charge())
            .ok_or(ForumError::Capacity)?;
        if count > MAX_PENDING_COUNT || bytes > MAX_PENDING_BYTES {
            return Err(ForumError::Capacity);
        }
        // Revision headroom for every pending burn's confirmation as well as this admission:
        // no later successful burn may force a wrapped revision.
        let revision = Self::revision(tx)?;
        revision
            .checked_add(count)
            .and_then(|v| v.checked_add(1))
            .ok_or(ForumError::Capacity)?;
        let frame_key = key(FRAMES, &hash);
        let stored = match staged {
            Some(staged) => {
                self.large.commit_reference(tx, staged, &frame_key)?;
                Stored::Large(staged.reference)
            }
            None => Stored::Inline(frame.to_vec()),
        };
        tx.set(&frame_key, &stored.encode())?;
        tx.set(&key(STATES, &hash), &encode(&observation.state_value())?)?;
        for member in &observation.checked.members {
            tx.set(&key(MEMBERS, &member.tx_hash.0), &hash)?;
        }
        tx.set(
            &key(POSTS, observation.event.target_hash()),
            &encode(&post.value())?,
        )?;
        Self::put_pending(tx, count, bytes)?;
        tx.set(REVISION, &(revision + 1).to_be_bytes())?;
        Ok(Admission::New(observation.clone()))
    }

    /// Record the chain's confirmation of every burn of an admitted event, once: its
    /// reservation moves into the post's aggregate and a post's first confirmation makes it
    /// visible. `facts` are the burns' chain facts in the event's order, lead first.
    pub(crate) fn confirm(
        &self,
        request: &Observation,
        facts: &[VerifiedTopicBurn],
        now: Timestamp,
    ) -> Result<Observation> {
        let mut attempts = 0;
        loop {
            attempts += 1;
            match self
                .kv
                .transact(|tx| Self::confirm_body(tx, request, facts, now))
            {
                Err(ForumError::CommitUnknown(reason)) if attempts < SETTLE_ATTEMPTS => {
                    tracing::warn!(
                        tx_hash = %hex::encode(request.hash()),
                        %reason,
                        "Forum confirmation commit outcome unknown; fencing and reading the store"
                    );
                    match self.fence(request)? {
                        Some(op) if op.confirmed.is_some() => return Ok(op),
                        Some(_) => {}
                        None => return Err(ForumError::Unavailable),
                    }
                }
                other => return other,
            }
        }
    }

    fn confirm_body(
        tx: &mut dyn KvTransaction,
        request: &Observation,
        facts: &[VerifiedTopicBurn],
        now: Timestamp,
    ) -> Result<Observation> {
        let hash = request.hash();
        let mut op = Self::retained(tx, request)?.ok_or(ForumError::Unavailable)?;
        if op.confirmed.is_some() {
            return Ok(op);
        }
        if facts.len() != op.checked.members.len()
            || facts.iter().zip(&op.checked.members).any(|(fact, member)| {
                fact.tx_hash != member.tx_hash
                    || fact.sender != member.sender
                    || fact.value_wei != member.value_wei
                    || fact.direction != op.checked.direction
            })
        {
            return Err(ForumError::Unavailable);
        }
        let lead = &facts[0];
        let mut post = Self::post(tx, op.event.target_hash())?.ok_or(ForumError::Unavailable)?;
        let reserved = if op.checked.direction == VoteDirection::Down {
            &mut post.reserved_down
        } else {
            &mut post.reserved_up
        };
        *reserved = reserved.sub(Magnitude::from_u64(op.checked.value_wei as u64))?;
        let visible = if matches!(op.event, TopicEvent::Post(_)) {
            post.visible.unwrap_or(now)
        } else {
            now
        };
        op.confirmed = Some((lead.block_number, lead.transaction_index, visible));
        let (count, bytes) = Self::pending(tx)?;
        let count = count.checked_sub(1).ok_or(ForumError::Unavailable)?;
        let bytes = bytes
            .checked_sub(op.charge())
            .ok_or(ForumError::Unavailable)?;
        let revision = Self::revision(tx)?
            .checked_add(1)
            .ok_or(ForumError::Unavailable)?;
        tx.set(&key(STATES, &hash), &encode(&op.state_value())?)?;
        Self::publish_projection(tx, &op, post)?;
        Self::put_pending(tx, count, bytes)?;
        tx.set(REVISION, &revision.to_be_bytes())?;
        Ok(op)
    }

    fn author_order(tx: &mut dyn KvTransaction, hash: &[u8; 32]) -> Result<(u64, u64, [u8; 32])> {
        let state = tx.get(&key(STATES, hash))?.ok_or(ForumError::Unavailable)?;
        let (_, confirmed) = decode_state(&state)?;
        let (block, index, _) = confirmed.ok_or(ForumError::Unavailable)?;
        Ok((block, index, *hash))
    }

    fn publish_projection(
        tx: &mut dyn KvTransaction,
        op: &Observation,
        mut post: Post,
    ) -> Result<()> {
        let (block, index, visible) = op.confirmed.ok_or(ForumError::Unavailable)?;
        let amount = Magnitude::from_u64(op.checked.value_wei as u64);
        post.aggregate = post
            .aggregate
            .add(op.checked.direction == VoteDirection::Down, amount)?;
        if let TopicEvent::Post(_) = op.event {
            let hash = op.hash();
            let current = match post.author {
                Some(old) => Some(Self::author_order(tx, &old)?),
                None => None,
            };
            if current.is_none_or(|old| (block, index, hash) < old) {
                post.author = Some(hash);
            }
            if post.visible.is_none() {
                post.visible = Some(visible);
                let discovery_key = Self::discovery_key(&post.topic);
                let (count, last) = Self::discovery_entry(tx, &post.topic)?.unwrap_or((0, visible));
                let count = count.checked_add(1).ok_or(ForumError::Capacity)?;
                let last = if time_key(visible) > time_key(last) {
                    visible
                } else {
                    last
                };
                tx.set(
                    &discovery_key,
                    &encode(&cbor_map(vec![
                        (
                            forum_discovery_row::VERSION,
                            CborValue::Int(forum_store_row_version::V1.into()),
                        ),
                        (forum_discovery_row::COUNT, CborValue::Int(count.into())),
                        (forum_discovery_row::LAST_ACTIVITY, time_value(last)),
                    ]))?,
                )?;
                let index_key =
                    Self::topic_index_key(&post.topic, Some(visible), Some(op.event.target_hash()));
                tx.set(&index_key, op.event.target_hash())?;
                tx.atomic_add(VISIBLE_POSTS, 1)?;
            } else if post.visible != Some(visible) {
                return Err(ForumError::Unavailable);
            }
        }
        tx.set(&key(POSTS, op.event.target_hash()), &encode(&post.value())?)?;
        Ok(())
    }

    /// Read a visible post and its author's stored burn. `None` when no post is visible there.
    pub(crate) fn stored_row(
        tx: &mut dyn KvTransaction,
        hash: &[u8; 32],
    ) -> Result<Option<StoredRow>> {
        let Some(post) = Self::post(tx, hash)? else {
            return Ok(None);
        };
        if post.visible.is_none() {
            return Ok(None);
        }
        let author = post.author.ok_or(ForumError::Unavailable)?;
        let (author_frame, author_state) =
            Self::operation(tx, &author)?.ok_or(ForumError::Unavailable)?;
        Ok(Some(StoredRow {
            hash: *hash,
            post,
            author,
            author_frame,
            author_state,
        }))
    }

    /// Read a referenced author frame (outside any transaction) and check the row: the author
    /// burn must be a confirmed post burn of exactly this post and topic.
    pub(crate) fn resolve_row(&self, row: StoredRow) -> Result<Row> {
        let frame = match row.author_frame {
            Stored::Inline(bytes) => bytes,
            Stored::Large(reference) => self.large.read(&reference)?,
        };
        let author = self.decode_observation(&row.author, &frame, &row.author_state)?;
        if author.confirmed.is_none() || author.event.target_hash() != &row.hash {
            return Err(ForumError::Unavailable);
        }
        let TopicEvent::Post(author_post) = &author.event else {
            return Err(ForumError::Unavailable);
        };
        crate::monad_topic_cbor::validate_topic_post_target(
            &author_post.post_frame,
            &self.network,
            &row.hash,
        )
        .map_err(|_| ForumError::Unavailable)?;
        if author_post.topic != row.post.topic {
            return Err(ForumError::Unavailable);
        }
        Ok(Row {
            hash: row.hash,
            post: row.post,
            author,
        })
    }

    /// A stored burn from its frame and state, validated as on admission.
    fn decode_observation(&self, hash: &[u8], frame: &[u8], state: &[u8]) -> Result<Observation> {
        let event = parse_topic_event(frame, &self.network).map_err(|_| ForumError::Unavailable)?;
        if matches!(&event, TopicEvent::Post(p) if p.schema_version < 2) {
            return Err(ForumError::Unavailable);
        }
        let checked = check_topic_burn_before_broadcast(&event, &self.policy)
            .map_err(|_| ForumError::Unavailable)?;
        if checked.lead().tx_hash.0.as_slice() != hash || checked.value_wei > i64::MAX as u128 {
            return Err(ForumError::Unavailable);
        }
        let (first_seen, confirmed) = decode_state(state)?;
        Ok(Observation {
            event,
            checked,
            first_seen,
            confirmed,
        })
    }
}

#[cfg(test)]
#[path = "forum_tests.rs"]
pub(crate) mod tests;
