//! Private canonical Forum authority. Callers serialize access with the Forum owner lock.
use std::path::{Path, PathBuf};

use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue, Timestamp};
use rocksdb::{Direction, IteratorMode, Options, WriteBatch, WriteOptions};
use thiserror::Error;

use crate::monad_topic_cbor::{
    check_topic_burn_before_broadcast, parse_topic_event, CheckedTopicBurn, TopicBurnPolicy,
    TopicEvent, VerifiedTopicBurn,
};
use crate::monad_topic_verify::VoteDirection;

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
    #[error("Forum snapshot capacity exhausted")]
    SnapshotCapacity,
    #[error("Forum snapshot exceeds retained memory bound")]
    SnapshotTooLarge,
    #[error("Forum row cannot fit an encoded page")]
    RowTooLarge,
    #[error("topic burn outcome unknown: {0}")]
    OutcomeUnknown(String),
}

pub(crate) fn invalid(error: impl std::fmt::Display) -> ForumError {
    ForumError::Invalid(error.to_string())
}

pub(crate) fn time_value(time: Timestamp) -> CborValue {
    cbor_map(vec![
        (0, CborValue::Int(time.seconds.into())),
        (1, CborValue::Int(time.nanoseconds.into())),
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

fn timestamp(value: &CborValue) -> Result<Timestamp> {
    closed(value, &[0, 1])?;
    let CborValue::Int(seconds) = field(value, 0)? else {
        return Err(ForumError::Unavailable);
    };
    let nanos = uint(field(value, 1)?)?;
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
fn key(prefix: u8, suffix: &[u8]) -> Vec<u8> {
    let mut key = vec![prefix];
    key.extend_from_slice(suffix);
    key
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
    fn sub(self, rhs: Self) -> Result<Self> {
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
    fn value(&self) -> CborValue {
        let mut fields = vec![
            (0, CborValue::Int(1)),
            (1, CborValue::Bytes(self.frame().to_vec())),
            (2, time_value(self.first_seen)),
            (
                3,
                CborValue::Int(if self.confirmed.is_some() { 2 } else { 1 }),
            ),
        ];
        if let Some((block, index, visible)) = self.confirmed {
            fields.extend([
                (4, CborValue::Int(block.into())),
                (5, CborValue::Int(index.into())),
                (6, time_value(visible)),
            ]);
        }
        cbor_map(fields)
    }
    fn charge(&self) -> Result<u64> {
        // Includes the authoritative key/value, worst-case duplicated pending post/index,
        // reservation/accounting records and fixed bookkeeping. Deliberately conservative.
        let post = match &self.event {
            TopicEvent::Post(p) => p.post_frame.len() + p.topic.len(),
            _ => 0,
        };
        Ok((encode(&self.value())?.len() + post + 1024) as u64)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Post {
    pub(crate) frame: Vec<u8>,
    pub(crate) topic: String,
    pub(crate) author: Option<[u8; 32]>,
    pub(crate) visible: Option<Timestamp>,
    pub(crate) aggregate: Aggregate,
    reserved_up: Magnitude,
    reserved_down: Magnitude,
}

impl Post {
    fn value(&self) -> CborValue {
        let mut fields = vec![
            (0, CborValue::Int(1)),
            (1, CborValue::Bytes(self.frame.clone())),
            (4, CborValue::Bool(self.aggregate.negative)),
            (5, CborValue::Bytes(self.aggregate.magnitude.0.to_vec())),
            (6, CborValue::Bytes(self.reserved_up.0.to_vec())),
            (7, CborValue::Bytes(self.reserved_down.0.to_vec())),
            (8, CborValue::Text(self.topic.clone())),
        ];
        if let (Some(author), Some(visible)) = (self.author, self.visible) {
            fields.extend([
                (2, CborValue::Bytes(author.to_vec())),
                (3, time_value(visible)),
            ]);
        }
        cbor_map(fields)
    }
    fn parse(value: &CborValue) -> Result<Self> {
        let known = field(value, 2).is_ok();
        closed(
            value,
            if known {
                &[0, 1, 2, 3, 4, 5, 6, 7, 8]
            } else {
                &[0, 1, 4, 5, 6, 7, 8]
            },
        )?;
        if uint(field(value, 0)?)? != 1 {
            return Err(ForumError::Unavailable);
        }
        let mag = |k| -> Result<Magnitude> {
            Ok(Magnitude(
                bytes(field(value, k)?)?
                    .try_into()
                    .map_err(|_| ForumError::Unavailable)?,
            ))
        };
        let CborValue::Bool(negative) = field(value, 4)? else {
            return Err(ForumError::Unavailable);
        };
        let CborValue::Text(topic) = field(value, 8)? else {
            return Err(ForumError::Unavailable);
        };
        let magnitude = mag(5)?;
        if *negative && magnitude == Magnitude::default() {
            return Err(ForumError::Unavailable);
        }
        Ok(Self {
            frame: bytes(field(value, 1)?)?.to_vec(),
            topic: topic.clone(),
            author: if known {
                Some(
                    bytes(field(value, 2)?)?
                        .try_into()
                        .map_err(|_| ForumError::Unavailable)?,
                )
            } else {
                None
            },
            visible: if known {
                Some(timestamp(field(value, 3)?)?)
            } else {
                None
            },
            aggregate: Aggregate {
                negative: *negative,
                magnitude,
            },
            reserved_up: mag(6)?,
            reserved_down: mag(7)?,
        })
    }
}

pub(crate) struct Store {
    db: rocksdb::DB,
    pub(crate) network: String,
    pub(crate) policy: TopicBurnPolicy,
    pending_count: u64,
    pending_bytes: u64,
    #[cfg(test)]
    fail_write: std::cell::Cell<u8>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForumStore")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

impl Store {
    pub(crate) fn pending_count(&self) -> u64 {
        self.pending_count
    }
    pub(crate) fn path(legacy: &Path) -> Result<PathBuf> {
        let mut name = legacy
            .file_name()
            .ok_or(ForumError::Unavailable)?
            .to_os_string();
        name.push(".forum-cbor-v1");
        Ok(legacy.with_file_name(name))
    }
    pub(crate) fn open(legacy: &Path, network: &str, policy: TopicBurnPolicy) -> Result<Self> {
        let path = Self::path(legacy)?;
        let exists = match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => true,
            Ok(_) => return Err(ForumError::Unavailable),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err(ForumError::Unavailable),
        };
        if exists && !path.join("CURRENT").is_file() {
            return Err(ForumError::Unavailable);
        }
        let mut options = Options::default();
        options.create_if_missing(!exists);
        let db = rocksdb::DB::open(&options, path).map_err(|_| ForumError::Unavailable)?;
        let header = encode(&cbor_map(vec![
            (0, CborValue::Int(1)),
            (1, CborValue::Text(network.into())),
            (2, CborValue::Int(policy.expected_chain_id.into())),
            (3, CborValue::Bytes(policy.burn_address.0.to_vec())),
        ]))?;
        let mut store = Self {
            db,
            network: network.into(),
            policy,
            pending_count: 0,
            pending_bytes: 0,
            #[cfg(test)]
            fail_write: std::cell::Cell::new(0),
        };
        match store.get(b"h")? {
            Some(old) if old == header => (),
            None if !exists => {
                let mut batch = WriteBatch::default();
                batch.put(b"h", header);
                store.write(batch)?;
            }
            _ => return Err(ForumError::Unavailable),
        }
        store.rebuild()?;
        Ok(store)
    }
    pub(crate) fn db(&self) -> &rocksdb::DB {
        &self.db
    }
    pub(crate) fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.db.get(key).map_err(|_| ForumError::Unavailable)
    }
    pub(crate) fn topic_index_prefix(topic: &str) -> Vec<u8> {
        use bitcoinsuite_core::{Hashed, Sha256};
        key(b't', Sha256::digest(topic.as_bytes().into()).as_slice())
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
    fn write(&self, batch: WriteBatch) -> Result<()> {
        #[cfg(test)]
        if self.fail_write.get() == 1 {
            return Err(ForumError::Unavailable);
        }
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db
            .write_opt(batch, &options)
            .map_err(|_| ForumError::Unavailable)?;
        #[cfg(test)]
        if self.fail_write.get() == 2 {
            return Err(ForumError::Unavailable);
        }
        Ok(())
    }
    fn decode_observation(&self, hash: &[u8], value: &[u8]) -> Result<Observation> {
        let map = decode(value)?;
        let state = uint(field(&map, 3)?)?;
        closed(
            &map,
            if state == 2 {
                &[0, 1, 2, 3, 4, 5, 6]
            } else {
                &[0, 1, 2, 3]
            },
        )?;
        if uint(field(&map, 0)?)? != 1 || !(1..=2).contains(&state) {
            return Err(ForumError::Unavailable);
        }
        let event = parse_topic_event(bytes(field(&map, 1)?)?, &self.network)
            .map_err(|_| ForumError::Unavailable)?;
        if matches!(&event, TopicEvent::Post(p) if p.schema_version < 2) {
            return Err(ForumError::Unavailable);
        }
        let checked = check_topic_burn_before_broadcast(&event, &self.policy)
            .map_err(|_| ForumError::Unavailable)?;
        if checked.decoded.tx_hash.0.as_slice() != hash
            || checked.decoded.value_wei > i64::MAX as u128
        {
            return Err(ForumError::Unavailable);
        }
        Ok(Observation {
            event,
            checked,
            first_seen: timestamp(field(&map, 2)?)?,
            confirmed: if state == 2 {
                Some((
                    uint(field(&map, 4)?)?,
                    uint(field(&map, 5)?)?,
                    timestamp(field(&map, 6)?)?,
                ))
            } else {
                None
            },
        })
    }
    pub(crate) fn operation(&self, hash: &[u8; 32]) -> Result<Option<Observation>> {
        self.get(&key(b'e', hash))?
            .map(|v| self.decode_observation(hash, &v))
            .transpose()
    }
    pub(crate) fn post(&self, hash: &[u8; 32]) -> Result<Option<Post>> {
        let post = self
            .get(&key(b'p', hash))?
            .map(|v| Post::parse(&decode(&v)?))
            .transpose()?;
        if let Some(post) = &post {
            crate::monad_topic_cbor::validate_topic_post_target(&post.frame, &self.network, hash)
                .map_err(|_| ForumError::Unavailable)?;
            let parsed = frank_cbor::validate_frame(&post.frame, &frank_cbor::default_context())
                .map_err(|_| ForumError::Unavailable)?;
            let frank_cbor::ValidationResult::Parsed(parsed) = parsed else {
                return Err(ForumError::Unavailable);
            };
            if !matches!(parsed.typed.as_deref(),Some(frank_cbor::TypedPayload::TopicPost {topic,..}) if topic==&post.topic)
            {
                return Err(ForumError::Unavailable);
            }
        }
        Ok(post)
    }
    fn accounting(batch: &mut WriteBatch, count: u64, bytes: u64) -> Result<()> {
        batch.put(
            b"q",
            encode(&cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, CborValue::Int(count.into())),
                (2, CborValue::Int(bytes.into())),
            ]))?,
        );
        Ok(())
    }
    fn pending_post(&self, observation: &Observation) -> Result<Post> {
        if let Some(post) = self.post(observation.event.target_hash())? {
            return Ok(post);
        }
        let TopicEvent::Post(post) = &observation.event else {
            return Err(ForumError::NotFound);
        };
        Ok(Post {
            frame: post.post_frame.clone(),
            topic: post.topic.clone(),
            author: None,
            visible: None,
            aggregate: Aggregate::default(),
            reserved_up: Magnitude::default(),
            reserved_down: Magnitude::default(),
        })
    }
    fn reserve(&self, observation: &Observation, mut post: Post) -> Result<Post> {
        let amount = Magnitude::from_u64(observation.checked.decoded.value_wei as u64);
        let negative = observation.checked.direction == VoteDirection::Down;
        let reserved = if negative {
            &mut post.reserved_down
        } else {
            &mut post.reserved_up
        };
        *reserved = reserved.add(amount)?;
        post.aggregate.add(negative, *reserved)?;
        Ok(post)
    }
    pub(crate) fn admit(&mut self, observation: Observation) -> Result<Observation> {
        let hash = observation.checked.decoded.tx_hash.0;
        if let Some(old) = self.operation(&hash)? {
            return if old.frame() == observation.frame() {
                Ok(old)
            } else {
                Err(ForumError::Conflict)
            };
        }
        let post = self.pending_post(&observation)?;
        if matches!(observation.event, TopicEvent::Post(_)) && post.visible.is_none() {
            if let Some(value) = self.get(&key(b'd', post.topic.as_bytes()))? {
                let map = decode(&value)?;
                // Conservative headroom for every pending operation: a count may
                // never overflow after its newly admitted post has already burned.
                uint(field(&map, 1)?)?
                    .checked_add(self.pending_count)
                    .and_then(|v| v.checked_add(1))
                    .ok_or(ForumError::Capacity)?;
            }
        }
        if matches!(observation.event, TopicEvent::Vote(_)) && post.visible.is_none() {
            return Err(ForumError::NotFound);
        }
        let post = self.reserve(&observation, post)?;
        let count = self
            .pending_count
            .checked_add(1)
            .ok_or(ForumError::Capacity)?;
        let bytes = self
            .pending_bytes
            .checked_add(observation.charge()?)
            .ok_or(ForumError::Capacity)?;
        if count > 4096 || bytes > 64 * 1024 * 1024 {
            return Err(ForumError::Capacity);
        }
        let mut batch = WriteBatch::default();
        batch.put(key(b'e', &hash), encode(&observation.value())?);
        batch.put(
            key(b'p', observation.event.target_hash()),
            encode(&post.value())?,
        );
        Self::accounting(&mut batch, count, bytes)?;
        self.write(batch)?;
        self.pending_count = count;
        self.pending_bytes = bytes;
        Ok(observation)
    }
    fn author_order(&self, hash: &[u8; 32]) -> Result<(u64, u64, [u8; 32])> {
        let op = self.operation(hash)?.ok_or(ForumError::Unavailable)?;
        let (block, index, _) = op.confirmed.ok_or(ForumError::Unavailable)?;
        Ok((block, index, *hash))
    }
    fn publish_projection(
        &self,
        batch: &mut WriteBatch,
        op: &Observation,
        mut post: Post,
    ) -> Result<()> {
        let (block, index, visible) = op.confirmed.ok_or(ForumError::Unavailable)?;
        let amount = Magnitude::from_u64(op.checked.decoded.value_wei as u64);
        post.aggregate = post
            .aggregate
            .add(op.checked.direction == VoteDirection::Down, amount)?;
        if let TopicEvent::Post(_) = op.event {
            let hash = op.checked.decoded.tx_hash.0;
            if post
                .author
                .map(|old| self.author_order(&old))
                .transpose()?
                .is_none_or(|old| (block, index, hash) < old)
            {
                post.author = Some(hash);
            }
            if post.visible.is_none() {
                post.visible = Some(visible);
                let discovery_key = key(b'd', post.topic.as_bytes());
                let (count, last) = match self.get(&discovery_key)? {
                    Some(v) => {
                        let map = decode(&v)?;
                        closed(&map, &[0, 1, 2])?;
                        if uint(field(&map, 0)?)? != 1 {
                            return Err(ForumError::Unavailable);
                        }
                        (uint(field(&map, 1)?)?, timestamp(field(&map, 2)?)?)
                    }
                    None => (0, visible),
                };
                let count = count.checked_add(1).ok_or(ForumError::Capacity)?;
                let last = if time_key(visible) > time_key(last) {
                    visible
                } else {
                    last
                };
                batch.put(
                    discovery_key,
                    encode(&cbor_map(vec![
                        (0, CborValue::Int(1)),
                        (1, CborValue::Int(count.into())),
                        (2, time_value(last)),
                    ]))?,
                );
                let index_key = Self::topic_index_key(
                    &post.topic,
                    Some(visible),
                    Some(op.event.target_hash()),
                );
                batch.put(index_key, op.event.target_hash());
            } else if post.visible != Some(visible) {
                return Err(ForumError::Unavailable);
            }
        }
        batch.put(key(b'p', op.event.target_hash()), encode(&post.value())?);
        Ok(())
    }
    pub(crate) fn confirm(
        &mut self,
        hash: &[u8; 32],
        facts: &VerifiedTopicBurn,
        now: Timestamp,
    ) -> Result<Observation> {
        let mut op = self.operation(hash)?.ok_or(ForumError::Unavailable)?;
        if op.confirmed.is_some() {
            return Ok(op);
        }
        if facts.tx_hash.0 != *hash
            || facts.sender != op.checked.decoded.sender
            || facts.value_wei != op.checked.decoded.value_wei
            || facts.direction != op.checked.direction
        {
            return Err(ForumError::Unavailable);
        }
        let mut post = self
            .post(op.event.target_hash())?
            .ok_or(ForumError::Unavailable)?;
        let charge = op.charge()?;
        let reserved = if op.checked.direction == VoteDirection::Down {
            &mut post.reserved_down
        } else {
            &mut post.reserved_up
        };
        *reserved = reserved.sub(Magnitude::from_u64(facts.value_wei as u64))?;
        let visible = if matches!(op.event, TopicEvent::Post(_)) {
            post.visible.unwrap_or(now)
        } else {
            now
        };
        op.confirmed = Some((facts.block_number, facts.transaction_index, visible));
        let count = self
            .pending_count
            .checked_sub(1)
            .ok_or(ForumError::Unavailable)?;
        let bytes = self
            .pending_bytes
            .checked_sub(charge)
            .ok_or(ForumError::Unavailable)?;
        let mut batch = WriteBatch::default();
        batch.put(key(b'e', hash), encode(&op.value())?);
        self.publish_projection(&mut batch, &op, post)?;
        Self::accounting(&mut batch, count, bytes)?;
        self.write(batch)?;
        self.pending_count = count;
        self.pending_bytes = bytes;
        Ok(op)
    }
    /// Always rebuild on open, making interrupted/missing/corrupt projections harmless.
    /// Each batch is bounded to one operation's derived records; authority is never rewritten.
    fn rebuild(&mut self) -> Result<()> {
        // Validate authority before touching projections; reject unknown private prefixes.
        for row in self.db.iterator(IteratorMode::Start) {
            let (k, v) = row.map_err(|_| ForumError::Unavailable)?;
            match k.first() {
                Some(b'e') if k.len() == 33 => {
                    self.decode_observation(&k[1..], &v)?;
                }
                Some(b'h') if k.as_ref() == b"h" => (),
                Some(b'p' | b't' | b'd' | b'q') => (),
                _ => return Err(ForumError::Unavailable),
            }
        }
        for prefix in [b'p', b't', b'd', b'q'] {
            for row in self
                .db
                .iterator(IteratorMode::From(&[prefix], Direction::Forward))
            {
                let (k, _) = row.map_err(|_| ForumError::Unavailable)?;
                if k.first() != Some(&prefix) {
                    break;
                }
                let mut batch = WriteBatch::default();
                batch.delete(k);
                self.write(batch)?;
            }
        }
        self.pending_count = 0;
        self.pending_bytes = 0;
        // Posts before votes, then pending reservations. Transaction order is irrelevant
        // to unsigned author selection and immutable per-post publication timestamps.
        for phase in 0..3 {
            for row in self
                .db
                .iterator(IteratorMode::From(b"e", Direction::Forward))
            {
                let (k, v) = row.map_err(|_| ForumError::Unavailable)?;
                if k.first() != Some(&b'e') {
                    break;
                }
                let op = self.decode_observation(&k[1..], &v)?;
                let selected = match phase {
                    0 => op.confirmed.is_some() && matches!(op.event, TopicEvent::Post(_)),
                    1 => op.confirmed.is_some() && matches!(op.event, TopicEvent::Vote(_)),
                    _ => op.confirmed.is_none(),
                };
                if !selected {
                    continue;
                }
                // A missing target in retained authority is an inconsistent store,
                // whereas a new request for an unknown target remains NotFound.
                let post = self.pending_post(&op).map_err(|error| match error {
                    ForumError::NotFound => ForumError::Unavailable,
                    other => other,
                })?;
                let mut batch = WriteBatch::default();
                if phase < 2 {
                    self.publish_projection(&mut batch, &op, post)?;
                } else {
                    if matches!(op.event, TopicEvent::Vote(_)) && post.visible.is_none() {
                        return Err(ForumError::Unavailable);
                    }
                    let post = self.reserve(&op, post)?;
                    self.pending_count = self
                        .pending_count
                        .checked_add(1)
                        .ok_or(ForumError::Unavailable)?;
                    self.pending_bytes = self
                        .pending_bytes
                        .checked_add(op.charge()?)
                        .ok_or(ForumError::Unavailable)?;
                    if self.pending_count > 4096 || self.pending_bytes > 64 * 1024 * 1024 {
                        return Err(ForumError::Unavailable);
                    }
                    batch.put(key(b'p', op.event.target_hash()), encode(&post.value())?);
                }
                Self::accounting(&mut batch, self.pending_count, self.pending_bytes)?;
                self.write(batch)?;
            }
        }
        Ok(())
    }
    pub(crate) fn visit_posts(
        &self,
        topic: &str,
        since: Timestamp,
        mut visit: impl FnMut([u8; 32], Post) -> Result<()>,
    ) -> Result<()> {
        use bitcoinsuite_core::{Hashed, Sha256};
        let prefix = key(b't', Sha256::digest(topic.as_bytes().into()).as_slice());
        for row in self
            .db
            .iterator(IteratorMode::From(&prefix, Direction::Forward))
        {
            let (k, v) = row.map_err(|_| ForumError::Unavailable)?;
            if !k.starts_with(&prefix) {
                break;
            }
            let hash: [u8; 32] = v.as_ref().try_into().map_err(|_| ForumError::Unavailable)?;
            let post = self.post(&hash)?.ok_or(ForumError::Unavailable)?;
            let visible = post.visible.ok_or(ForumError::Unavailable)?;
            if post.topic == topic && time_key(visible) >= time_key(since) {
                visit(hash, post)?;
            }
        }
        Ok(())
    }
    pub(crate) fn decode_discovery_entry(&self, value: &[u8]) -> Result<(u64, Timestamp)> {
        let map = decode(value)?;
        closed(&map, &[0, 1, 2])?;
        if uint(field(&map, 0)?)? != 1 {
            return Err(ForumError::Unavailable);
        }
        Ok((uint(field(&map, 1)?)?, timestamp(field(&map, 2)?)?))
    }
    pub(crate) fn discovery_entry(&self, topic: &str) -> Result<Option<(u64, Timestamp)>> {
        let key = key(b'd', topic.as_bytes());
        let Some(v) = self.get(&key)? else {
            return Ok(None);
        };
        Ok(Some(self.decode_discovery_entry(&v)?))
    }
    pub(crate) fn visit_topics(
        &self,
        mut visit: impl FnMut(String, u64, Timestamp) -> Result<()>,
    ) -> Result<()> {
        for row in self
            .db
            .iterator(IteratorMode::From(b"d", Direction::Forward))
        {
            let (k, v) = row.map_err(|_| ForumError::Unavailable)?;
            if k.first() != Some(&b'd') {
                break;
            }
            let topic = std::str::from_utf8(&k[1..])
                .map_err(|_| ForumError::Unavailable)?
                .to_string();
            let (count, last) = self.decode_discovery_entry(&v)?;
            visit(topic, count, last)?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "forum_tests.rs"]
pub(crate) mod tests;
