//! Where the relay keeps direct messages.
//!
//! One RocksDB directory beside the registry database, holding exactly this:
//!
//! | key | value | what it is |
//! |---|---|---|
//! | `R` + payload hash | the stored message | the request bytes as submitted, and when it was delivered |
//! | `I` + recipient + time + payload hash | payload hash | the recipient's inbox, in delivery order |
//! | `O` + sender + time + payload hash | payload hash | the sender's own copies, in delivery order |
//! | `T` + transaction hash | payload hash | a payment already used, so it pays for one message only |
//! | `L` | time | the last delivery time issued |
//! | `N` + recipient + epoch + nonce | expiry | a login challenge already used |
//!
//! A message is written once, with all of its keys, in one synced batch, and never changed.
//! Nothing is ever deleted except expired login challenges.
//!
//! The directory name carries the format version. Frank has no users yet, so there is no
//! reader for any earlier format: [`crate::store::db::Db::open`] refuses to start beside a
//! store of an older one and says what to delete.
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};

use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue};
use rocksdb::{Direction, IteratorMode, Options, ReadOptions, WriteBatch, WriteOptions};

use crate::{
    directory_runtime::DirectoryRuntime,
    http::monad_message_cbor::{CanonicalError, ExactRequest, Result, SubmissionEcho},
    monad_dm_payment::CanonicalPaymentInput,
    monad_http::{Address, Hash32},
    monad_mailbox::ChallengeConsumption,
};

/// The message store's directory is the registry database's path with this extension.
pub(crate) const STORE_EXTENSION: &str = "messages-v2";
/// Extensions of message stores written by earlier development builds. None can be read.
pub(crate) const OLD_STORE_EXTENSIONS: &[&str] = &["monad-dm-cbor-v1"];
const ROW_VERSION: i128 = 2;

/// What admission established about a message, kept with it: who it is from and to, and the
/// directory facts its context was checked against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrozenCanonicalPolicy {
    pub(crate) network: String,
    pub(crate) chain_id: u64,
    pub(crate) minimum: u128,
    pub(crate) sender_p: Vec<u8>,
    pub(crate) recipient_p: Vec<u8>,
    pub(crate) sender_m: Vec<u8>,
    pub(crate) recipient_m: Vec<u8>,
    pub(crate) stamp: Vec<u8>,
    pub(crate) sender_t1: [u8; 32],
    pub(crate) recipient_t1: [u8; 32],
    pub(crate) payload_hash: [u8; 32],
}
impl FrozenCanonicalPolicy {
    pub(crate) fn sender(&self) -> Result<Address> {
        crate::monad_stamp_stealth::recipient_address_from_public_key(&self.sender_p)
            .map_err(|_| CanonicalError::Unavailable)
    }

    pub(crate) fn recipient(&self) -> Result<Address> {
        crate::monad_stamp_stealth::recipient_address_from_public_key(&self.recipient_p)
            .map_err(|_| CanonicalError::Unavailable)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MailboxDirection {
    In,
    Out,
}

impl MailboxDirection {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::In => "in",
            Self::Out => "out",
        }
    }
}

/// A delivered message as announced to open mailbox sockets.
#[derive(Debug, Clone)]
pub(crate) struct FinalizedEnvelope {
    pub(crate) sender: Address,
    pub(crate) recipient: Address,
    pub(crate) payload_hash: [u8; 32],
    pub(crate) submission_identity: [u8; 32],
    pub(crate) timestamp: i64,
    pub(crate) delivery: Vec<u8>,
    pub(crate) context: Vec<u8>,
}

/// A stored message. To be stored is to be delivered: there is no other state.
#[derive(Debug, Clone)]
pub(crate) struct Claim {
    /// The request exactly as submitted.
    pub(crate) request: ExactRequest,
    pub(crate) policy: FrozenCanonicalPolicy,
    /// When it was put in the recipient's inbox. See [`next_delivery_time`].
    pub(crate) delivered_at: i64,
}

impl Claim {
    pub(crate) fn echo(&self) -> Result<SubmissionEcho> {
        Ok(SubmissionEcho::new(
            &self.request,
            &self.policy.network,
            self.policy.recipient()?,
            &self.policy.payload_hash,
            &self.policy.sender_t1,
            &self.policy.recipient_t1,
        ))
    }
}

/// Live login challenges the relay remembers at once, over all recipients. They expire within
/// a minute and are deleted as new ones are used.
const MAX_AUTH_NONCES: usize = 4096;

/// The message store of one registry. Opened on first use.
#[derive(Debug)]
pub(crate) struct Owner {
    path: PathBuf,
    db: Mutex<Option<rocksdb::DB>>,
    directory: Mutex<Weak<DirectoryRuntime>>,
    broadcast: tokio::sync::broadcast::Sender<FinalizedEnvelope>,
    /// When each message's payments were last handed to the node. In memory only.
    payment_broadcasts: Mutex<std::collections::HashMap<[u8; 32], std::time::Instant>>,
}
impl Owner {
    /// The store that belongs beside the registry database at `registry_db`.
    pub(crate) fn new(registry_db: PathBuf) -> Self {
        let (broadcast, _) = tokio::sync::broadcast::channel(1024);
        Self {
            path: registry_db.with_extension(STORE_EXTENSION),
            db: Mutex::new(None),
            directory: Mutex::new(Weak::new()),
            broadcast,
            payment_broadcasts: Default::default(),
        }
    }
    /// Whether this message's payments may be handed to the node now: at most once per
    /// `interval`, so a client repeating one message cannot make the relay hammer the node.
    /// The interval starts when the payments are handed over, whether or not the node took
    /// them: a failed broadcast is not retried inside it either. Nothing is remembered across
    /// a restart, so the first resend after one always sends.
    pub(crate) fn may_broadcast_payments(
        &self,
        payload_hash: &[u8; 32],
        interval: std::time::Duration,
    ) -> bool {
        let Ok(mut sent) = self.payment_broadcasts.lock() else {
            return true;
        };
        let now = std::time::Instant::now();
        sent.retain(|_, at| now.duration_since(*at) < interval);
        if sent.contains_key(payload_hash) {
            return false;
        }
        sent.insert(*payload_hash, now);
        true
    }
    pub(crate) fn subscribe_finalized(
        &self,
    ) -> tokio::sync::broadcast::Receiver<FinalizedEnvelope> {
        self.broadcast.subscribe()
    }
    pub(crate) fn attach_directory(&self, directory: Arc<DirectoryRuntime>) -> Result<()> {
        let mut installed = self
            .directory
            .lock()
            .map_err(|_| CanonicalError::Unavailable)?;
        if let Some(current) = installed.upgrade() {
            if !current.same_owner(&directory) {
                return Err(CanonicalError::Conflict);
            }
            return Ok(());
        }
        *installed = Arc::downgrade(&directory);
        Ok(())
    }
    pub(crate) fn directory(&self) -> Option<Arc<DirectoryRuntime>> {
        self.directory.lock().ok()?.upgrade()
    }
    fn with<T>(
        &self,
        create: bool,
        action: impl FnOnce(&rocksdb::DB) -> Result<T>,
    ) -> Result<Option<T>> {
        let mut guard = self.db.lock().map_err(|_| CanonicalError::Unavailable)?;
        if guard.is_none() {
            match std::fs::symlink_metadata(&self.path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(CanonicalError::Unavailable)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
                    return Ok(None)
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(CanonicalError::Unavailable)
                }
                _ => {}
            }
            let mut options = Options::default();
            options.create_if_missing(create);
            let opened =
                rocksdb::DB::open(&options, &self.path).map_err(|_| CanonicalError::Unavailable)?;
            *guard = Some(opened);
        }
        if !self.path.join("CURRENT").is_file() {
            return Err(CanonicalError::Unavailable);
        }
        action(guard.as_ref().ok_or(CanonicalError::Unavailable)?).map(Some)
    }
    pub(crate) fn get(&self, payload_hash: &[u8; 32]) -> Result<Option<Claim>> {
        self.with(false, |db| load(db, payload_hash))
            .map(Option::flatten)
    }
    /// The stored message this request is an exact repeat of, if any. The same message under
    /// different bytes is a conflict.
    pub(crate) fn find_request(&self, request: &ExactRequest) -> Result<Option<Claim>> {
        self.with(false, |db| find_request_locked(db, request))
            .map(Option::flatten)
    }
    /// Store a checked message in the recipient's inbox and the sender's own mailbox, in one
    /// durable write. An exact repeat returns what is already stored. A refusal (a payment
    /// already used for another message) leaves nothing behind. The number of messages already
    /// stored never refuses one.
    ///
    /// `now` is the caller's clock; the delivery time is decided here, under the store's
    /// lock: see [`next_delivery_time`].
    pub(crate) fn claim(&self, input: CanonicalPaymentInput, now: i64) -> Result<Claim> {
        let (message, stored) = self
            .with(true, |db| {
                if let Some(existing) = find_request_locked(db, &input.request)? {
                    return Ok((existing, false));
                }
                let hash = input.policy.payload_hash;
                // One signed payment pays for one message. Nothing on chain names the message,
                // so this index is what stops a payment being presented again for another.
                for payment in input.payment_hashes() {
                    if db
                        .get_pinned(payment_key(&payment))
                        .map_err(|_| CanonicalError::Unavailable)?
                        .is_some()
                    {
                        return Err(CanonicalError::Conflict);
                    }
                }
                let delivered_at = next_delivery_time(db, now)?;
                let mut batch = WriteBatch::default();
                batch.put(LAST_DELIVERY_KEY, delivered_at.to_be_bytes());
                for payment in input.payment_hashes() {
                    batch.put(payment_key(&payment), hash);
                }
                let message = Claim {
                    request: input.request,
                    policy: input.policy,
                    delivered_at,
                };
                batch.put(row_key(&hash), encode_row(&message)?);
                let (sender, recipient) = (message.policy.sender()?, message.policy.recipient()?);
                batch.put(mailbox_key(b'I', recipient, delivered_at, &hash), hash);
                if sender != recipient {
                    batch.put(mailbox_key(b'O', sender, delivered_at, &hash), hash);
                }
                write(db, batch)?;
                Ok((message, true))
            })?
            .ok_or(CanonicalError::Unavailable)?;
        if stored {
            if let (Ok(sender), Ok(recipient)) =
                (message.policy.sender(), message.policy.recipient())
            {
                let _ = self.broadcast.send(FinalizedEnvelope {
                    sender,
                    recipient,
                    payload_hash: message.policy.payload_hash,
                    submission_identity: message.request.submission_identity(),
                    timestamp: message.delivered_at,
                    delivery: message.request.delivery().to_vec(),
                    context: message.request.context().to_vec(),
                });
            }
        }
        Ok(message)
    }
    pub(crate) fn consume_challenge(
        &self,
        epoch: [u8; 32],
        recipient: Address,
        nonce: [u8; 32],
        expires: i64,
        now: i64,
        cap: usize,
    ) -> Result<ChallengeConsumption> {
        self.with(true, |db| {
            let mut prefix = b"N".to_vec();
            prefix.extend_from_slice(&recipient.0);
            let mut key = prefix.clone();
            key.extend_from_slice(&epoch);
            key.extend_from_slice(&nonce);
            if expires < now
                || db
                    .get(&key)
                    .map_err(|_| CanonicalError::Unavailable)?
                    .is_some()
            {
                return Ok(ChallengeConsumption::Rejected);
            }
            let mut batch = WriteBatch::default();
            let mut live = 0usize;
            let mut global_live = 0usize;
            for item in db.iterator_opt(IteratorMode::Start, prefix_options(b"N")?) {
                let (row, value) = item.map_err(|_| CanonicalError::Unavailable)?;
                if row.len() != 85 {
                    return Err(CanonicalError::Unavailable);
                }
                let time = i64::from_be_bytes(
                    value
                        .as_ref()
                        .try_into()
                        .map_err(|_| CanonicalError::Unavailable)?,
                );
                if time < now {
                    batch.delete(row);
                } else {
                    global_live += 1;
                    if row.starts_with(&prefix) {
                        live += 1;
                    }
                }
            }
            if live >= cap || global_live >= MAX_AUTH_NONCES {
                // Expired challenges found on the way are still cleared, so a full table
                // drains even when every caller is being refused.
                write(db, batch)?;
                return Ok(ChallengeConsumption::AtCapacity);
            }
            batch.put(key, expires.to_be_bytes());
            write(db, batch)?;
            Ok(ChallengeConsumption::Consumed)
        })?
        .ok_or(CanonicalError::Unavailable)
    }
    /// Up to `limit` messages delivered to `recipient` at or after `since` and strictly after
    /// the position `after`, in delivery order. The scan starts at that position: messages
    /// before it are not read.
    pub(crate) fn inbox(
        &self,
        recipient: Address,
        since: i64,
        after: Option<(i64, [u8; 32])>,
        limit: usize,
    ) -> Result<Vec<Claim>> {
        self.with(false, |db| {
            let mut entries = Entries::new(db, b'I', recipient, since, after);
            let mut result = Vec::new();
            while result.len() < limit {
                let Some((time, hash)) = entries.next()? else {
                    break;
                };
                let message = load_delivered(db, &hash, time)?;
                if message.policy.recipient() != Ok(recipient) {
                    return Err(CanonicalError::Unavailable);
                }
                result.push(message);
            }
            Ok(result)
        })
        .map(|rows| rows.unwrap_or_default())
    }
    /// Up to `limit` messages `address` received or sent, at or after `since` and strictly
    /// after the position `after`, in delivery order. Both scans start at that position.
    pub(crate) fn mailbox(
        &self,
        address: Address,
        since: i64,
        after: Option<(i64, [u8; 32])>,
        limit: usize,
    ) -> Result<Vec<(Claim, MailboxDirection)>> {
        self.with(false, |db| {
            let mut received = Entries::new(db, b'I', address, since, after);
            let mut sent = Entries::new(db, b'O', address, since, after);
            let mut result = Vec::new();
            if limit == 0 {
                return Ok(result);
            }
            let (mut next_received, mut next_sent) = (received.next()?, sent.next()?);
            while result.len() < limit {
                let take_received = match (next_received, next_sent) {
                    (Some(received), Some(sent)) => received <= sent,
                    (Some(_), None) => true,
                    (None, Some(_)) => false,
                    (None, None) => break,
                };
                let (time, hash) = if take_received {
                    let entry = next_received.expect("checked above");
                    next_received = received.next()?;
                    entry
                } else {
                    let entry = next_sent.expect("checked above");
                    next_sent = sent.next()?;
                    entry
                };
                let message = load_delivered(db, &hash, time)?;
                let direction = if take_received {
                    MailboxDirection::In
                } else {
                    MailboxDirection::Out
                };
                let party = match direction {
                    MailboxDirection::In => message.policy.recipient(),
                    MailboxDirection::Out => message.policy.sender(),
                };
                if party != Ok(address) {
                    return Err(CanonicalError::Unavailable);
                }
                result.push((message, direction));
            }
            Ok(result)
        })
        .map(|rows| rows.unwrap_or_default())
    }
}

/// One address's `I` or `O` entries from a starting position onward, in delivery order.
struct Entries<'a> {
    rows: rocksdb::DBIteratorWithThreadMode<'a, rocksdb::DB>,
    prefix: Vec<u8>,
    since: i64,
    after: Option<(i64, [u8; 32])>,
}
impl<'a> Entries<'a> {
    fn new(
        db: &'a rocksdb::DB,
        kind: u8,
        address: Address,
        since: i64,
        after: Option<(i64, [u8; 32])>,
    ) -> Self {
        let mut prefix = vec![kind];
        prefix.extend_from_slice(&address.0);
        // Delivery times are never negative, so their big-endian bytes sort in time order and
        // the scan can start at the first key that could qualify.
        let start = match after {
            Some((time, hash)) if time >= since => mailbox_key(kind, address, time.max(0), &hash),
            _ => mailbox_key(kind, address, since.max(0), &[0; 32]),
        };
        let mut options = ReadOptions::default();
        let mut upper = prefix.clone();
        upper.push(u8::MAX);
        upper.extend_from_slice(&[u8::MAX; 8]);
        options.set_iterate_upper_bound(upper);
        Self {
            rows: db.iterator_opt(IteratorMode::From(&start, Direction::Forward), options),
            prefix,
            since,
            after,
        }
    }
    fn next(&mut self) -> Result<Option<(i64, [u8; 32])>> {
        for item in self.rows.by_ref() {
            let (key, value) = item.map_err(|_| CanonicalError::Unavailable)?;
            if !key.starts_with(&self.prefix) {
                return Ok(None);
            }
            if key.len() != 61 {
                return Err(CanonicalError::Unavailable);
            }
            let time = i64::from_be_bytes(key[21..29].try_into().expect("8 bytes"));
            let hash: [u8; 32] = key[29..].try_into().expect("32 bytes");
            if time < self.since || self.after.is_some_and(|cursor| (time, hash) <= cursor) {
                continue;
            }
            if value.as_ref() != hash {
                return Err(CanonicalError::Unavailable);
            }
            return Ok(Some((time, hash)));
        }
        Ok(None)
    }
}

fn write(db: &rocksdb::DB, batch: WriteBatch) -> Result<()> {
    let mut options = WriteOptions::default();
    options.set_sync(true);
    db.write_opt(batch, &options)
        .map_err(|_| CanonicalError::Unavailable)
}
fn row_key(hash: &[u8; 32]) -> Vec<u8> {
    let mut key = b"R".to_vec();
    key.extend_from_slice(hash);
    key
}
/// Used-payment index: signed transaction hash to the one message it paid for.
fn payment_key(tx_hash: &Hash32) -> Vec<u8> {
    let mut key = b"T".to_vec();
    key.extend_from_slice(&tx_hash.0);
    key
}
/// A delivered message's place in a mailbox: `I` for the recipient's inbox, `O` for the
/// sender's own copies, ordered by delivery time.
fn mailbox_key(kind: u8, address: Address, time: i64, hash: &[u8; 32]) -> Vec<u8> {
    let mut key = vec![kind];
    key.extend_from_slice(&address.0);
    key.extend_from_slice(&time.to_be_bytes());
    key.extend_from_slice(hash);
    key
}
/// Bound an iterator to the keys starting with `prefix`.
fn prefix_options(prefix: &[u8]) -> Result<ReadOptions> {
    let mut upper = prefix.to_vec();
    let last = upper
        .iter()
        .rposition(|byte| *byte != u8::MAX)
        .ok_or(CanonicalError::Unavailable)?;
    upper[last] += 1;
    upper.truncate(last + 1);
    let mut options = ReadOptions::default();
    options.set_iterate_lower_bound(prefix.to_vec());
    options.set_iterate_upper_bound(upper);
    Ok(options)
}

/// Where the last delivery time issued by this store is kept.
const LAST_DELIVERY_KEY: &[u8] = b"L";

/// The time to deliver the next message at.
///
/// A reader asks for "everything after the last time I saw", so a delivery time must never
/// be equal to or earlier than one already issued, or a reader who has moved past it would
/// never be given the message. The time is therefore taken under the store's lock at commit,
/// and is the clock or one millisecond after the last time issued, whichever is later: two
/// messages in the same millisecond, or a clock that steps back, still get increasing times.
/// The caller writes the result under [`LAST_DELIVERY_KEY`] in the same batch as the message,
/// so this holds across restarts.
fn next_delivery_time(db: &rocksdb::DB, now: i64) -> Result<i64> {
    let last = match db
        .get_pinned(LAST_DELIVERY_KEY)
        .map_err(|_| CanonicalError::Unavailable)?
    {
        Some(raw) => i64::from_be_bytes(
            raw.as_ref()
                .try_into()
                .map_err(|_| CanonicalError::Unavailable)?,
        ),
        None => -1,
    };
    Ok(now.max(last.checked_add(1).ok_or(CanonicalError::Unavailable)?))
}

fn find_request_locked(db: &rocksdb::DB, request: &ExactRequest) -> Result<Option<Claim>> {
    use frank_cbor::{relay_context, validate_frame, TypedPayload, ValidationResult};
    let ValidationResult::Parsed(frame) = validate_frame(request.delivery(), &relay_context())
        .map_err(|_| CanonicalError::Invalid)?
    else {
        return Err(CanonicalError::Invalid);
    };
    let Some(TypedPayload::DirectMessage { payload_digest, .. }) = frame.typed.as_deref() else {
        return Err(CanonicalError::Invalid);
    };
    let hash: [u8; 32] = payload_digest
        .as_slice()
        .try_into()
        .map_err(|_| CanonicalError::Invalid)?;
    let Some(existing) = load(db, &hash)? else {
        return Ok(None);
    };
    if !existing.request.exact_equal(request) {
        return Err(CanonicalError::Conflict);
    }
    Ok(Some(existing))
}

fn int(n: impl Into<i128>) -> CborValue {
    CborValue::Int(n.into())
}
fn blob(bytes: impl AsRef<[u8]>) -> CborValue {
    CborValue::Bytes(bytes.as_ref().to_vec())
}
fn number(value: &CborValue) -> Result<i128> {
    if let CborValue::Int(n) = value {
        Ok(*n)
    } else {
        Err(CanonicalError::Unavailable)
    }
}
fn bytes(value: &CborValue) -> Result<&[u8]> {
    if let CborValue::Bytes(b) = value {
        Ok(b)
    } else {
        Err(CanonicalError::Unavailable)
    }
}
fn text(value: &CborValue) -> Result<&str> {
    if let CborValue::Text(s) = value {
        Ok(s)
    } else {
        Err(CanonicalError::Unavailable)
    }
}
fn convert<T: TryFrom<i128>>(value: &CborValue) -> Result<T> {
    number(value)?
        .try_into()
        .map_err(|_| CanonicalError::Unavailable)
}
fn fixed<const N: usize>(value: &CborValue) -> Result<[u8; N]> {
    bytes(value)?
        .try_into()
        .map_err(|_| CanonicalError::Unavailable)
}

fn encode_row(message: &Claim) -> Result<Vec<u8>> {
    let p = &message.policy;
    let policy = CborValue::Array(vec![
        CborValue::Text(p.network.clone()),
        int(p.chain_id),
        blob(p.minimum.to_be_bytes()),
        blob(&p.sender_p),
        blob(&p.recipient_p),
        blob(&p.sender_m),
        blob(&p.recipient_m),
        blob(&p.stamp),
        blob(p.sender_t1),
        blob(p.recipient_t1),
        blob(p.payload_hash),
    ]);
    encode_canonical(&cbor_map(vec![
        (0, int(ROW_VERSION)),
        (1, blob(message.request.body())),
        (2, CborValue::Text(message.request.content_type().into())),
        (3, policy),
        (4, int(message.delivered_at)),
    ]))
    .map_err(|_| CanonicalError::Unavailable)
}

#[cfg(test)]
thread_local! {
    /// Stored messages read on this thread, for tests of how much a read touches.
    pub(crate) static ROWS_READ: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Read one stored message. It was checked in full when it was admitted and has not changed
/// since, so reading it only decodes it: no signature or proof is verified again.
fn load(db: &rocksdb::DB, hash: &[u8; 32]) -> Result<Option<Claim>> {
    let Some(raw) = db
        .get(row_key(hash))
        .map_err(|_| CanonicalError::Unavailable)?
    else {
        return Ok(None);
    };
    #[cfg(test)]
    ROWS_READ.with(|count| count.set(count.get() + 1));
    let value = decode_canonical(&raw).map_err(|_| CanonicalError::Unavailable)?;
    let CborValue::Map(rows) = &value else {
        return Err(CanonicalError::Unavailable);
    };
    let [(0, version), (1, body), (2, content_type), (3, CborValue::Array(p)), (4, delivered_at)] =
        rows.as_slice()
    else {
        return Err(CanonicalError::Unavailable);
    };
    if number(version)? != ROW_VERSION || p.len() != 11 {
        return Err(CanonicalError::Unavailable);
    }
    let request = ExactRequest::parse(bytes(body)?.to_vec(), text(content_type)?.into())
        .map_err(|_| CanonicalError::Unavailable)?;
    let policy = FrozenCanonicalPolicy {
        network: text(&p[0])?.into(),
        chain_id: convert(&p[1])?,
        minimum: u128::from_be_bytes(fixed(&p[2])?),
        sender_p: bytes(&p[3])?.to_vec(),
        recipient_p: bytes(&p[4])?.to_vec(),
        sender_m: bytes(&p[5])?.to_vec(),
        recipient_m: bytes(&p[6])?.to_vec(),
        stamp: bytes(&p[7])?.to_vec(),
        sender_t1: fixed(&p[8])?,
        recipient_t1: fixed(&p[9])?,
        payload_hash: fixed(&p[10])?,
    };
    if policy.payload_hash != *hash {
        return Err(CanonicalError::Unavailable);
    }
    Ok(Some(Claim {
        request,
        policy,
        delivered_at: convert(delivered_at)?,
    }))
}

/// The message a mailbox entry points at, which must have been delivered at the entry's time.
fn load_delivered(db: &rocksdb::DB, hash: &[u8; 32], time: i64) -> Result<Claim> {
    let message = load(db, hash)?.ok_or(CanonicalError::Unavailable)?;
    if message.delivered_at != time {
        return Err(CanonicalError::Unavailable);
    }
    Ok(message)
}
