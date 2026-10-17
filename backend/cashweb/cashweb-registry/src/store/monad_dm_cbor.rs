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
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
};

use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue};
mod rocks;
use rocks::{Admission, MessageRead, RocksCanonicalMessages};

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

/// How often every recipient's expired login challenges are deleted. A recipient's own are
/// deleted each time it uses a new one; this pass clears those of recipients who went away.
const AUTH_NONCE_SWEEP_INTERVAL_MS: i64 = 60_000;

/// The message store of one registry. Opened on first use.
#[derive(Debug)]
pub(crate) struct Owner {
    storage: RocksCanonicalMessages,
    /// Newly stored canonical messages since this relay process started. Retries are excluded.
    messages_stored_total: AtomicU64,
    directory: Mutex<Weak<DirectoryRuntime>>,
    broadcast: tokio::sync::broadcast::Sender<FinalizedEnvelope>,
    /// When each message's payments were last handed to the node. In memory only.
    payment_broadcasts: Mutex<std::collections::HashMap<[u8; 32], std::time::Instant>>,
    /// When every recipient's expired login challenges were last deleted. In memory only: the
    /// first use after a restart sweeps.
    auth_nonces_swept_at_ms: Mutex<Option<i64>>,
    /// Recorded blind wakeup events for inspection and push dispatch (#384, #1574).
    wakeups: Mutex<Vec<crate::store::notification_policy::BlindWakeupEvent>>,
    /// Per-recipient timestamp (ms) of the last emitted blind wakeup for coalescing.
    last_wakeup_at_ms: Mutex<std::collections::HashMap<Address, i64>>,
}
impl Owner {
    /// The store that belongs beside the registry database at `registry_db`.
    pub(crate) fn new(registry_db: PathBuf) -> Self {
        let (broadcast, _) = tokio::sync::broadcast::channel(1024);
        Self {
            storage: RocksCanonicalMessages::new(registry_db.with_extension(STORE_EXTENSION)),
            messages_stored_total: AtomicU64::new(0),
            directory: Mutex::new(Weak::new()),
            broadcast,
            payment_broadcasts: Default::default(),
            auth_nonces_swept_at_ms: Mutex::new(None),
            wakeups: Default::default(),
            last_wakeup_at_ms: Default::default(),
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
    pub(crate) fn get(&self, payload_hash: &[u8; 32]) -> Result<Option<Claim>> {
        self.storage
            .read_messages(|db| load(db, payload_hash))
            .map(Option::flatten)
    }
    /// The stored message this request is an exact repeat of, if any. The same message under
    /// different bytes is a conflict.
    pub(crate) fn find_request(&self, request: &ExactRequest) -> Result<Option<Claim>> {
        self.storage
            .read_messages(|db| find_request_locked(db, request))
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
        let (message, stored) = self.storage.admit_message(|admission| {
            if let Some(existing) = find_request_locked(&admission.messages(), &input.request)? {
                return Ok((existing, false));
            }
            let hash = input.policy.payload_hash;
            // One signed payment pays for one message. Nothing on chain names the message,
            // so this index is what stops a payment being presented again for another.
            for payment in input.payment_hashes() {
                if admission.payment_used(&payment_key(&payment))? {
                    return Err(CanonicalError::Conflict);
                }
            }
            let delivered_at = next_delivery_time(&admission, now)?;
            let payment_keys = input
                .payment_hashes()
                .map(|payment| payment_key(&payment))
                .collect();
            let message = Claim {
                request: input.request,
                policy: input.policy,
                delivered_at,
            };
            let row = encode_row(&message)?;
            let (sender, recipient) = (message.policy.sender()?, message.policy.recipient()?);
            let recipient_key = mailbox_key(b'I', recipient, delivered_at, &hash);
            let sender_key =
                (sender != recipient).then(|| mailbox_key(b'O', sender, delivered_at, &hash));
            admission.commit_delivery(rocks::Delivery {
                last_delivery_key: LAST_DELIVERY_KEY,
                delivered_at: delivered_at.to_be_bytes(),
                payment_keys,
                hash: &hash,
                row_key: &row_key(&hash),
                row: &row,
                recipient_key: &recipient_key,
                sender_key: sender_key.as_deref(),
            })?;
            Ok((message, true))
        })?;
        if stored {
            self.messages_stored_total.fetch_add(1, Ordering::Relaxed);
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

    /// Newly stored messages since process start; exact request retries do not increment it.
    pub(crate) fn messages_stored_total(&self) -> u64 {
        self.messages_stored_total.load(Ordering::Relaxed)
    }

    /// Estimated live key/value bytes for the separate message store, if it has been created.
    pub(crate) fn estimated_live_data_size_bytes(&self) -> Result<Option<u64>> {
        self.storage.estimated_live_data_size_bytes()
    }
    /// Records one authenticated login challenge as used, so it cannot be replayed.
    ///
    /// A challenge is refused when it has expired or was already used. A recipient holding `cap`
    /// used challenges that have not expired yet is at capacity until one does. There is no
    /// bound over all recipients: one recipient's use never refuses another's. Used challenges
    /// are deleted once expired.
    pub(crate) fn consume_challenge(
        &self,
        epoch: [u8; 32],
        recipient: Address,
        nonce: [u8; 32],
        expires: i64,
        now: i64,
        cap: usize,
    ) -> Result<ChallengeConsumption> {
        let sweep_all = {
            let mut swept = self
                .auth_nonces_swept_at_ms
                .lock()
                .map_err(|_| CanonicalError::Unavailable)?;
            let due = !matches!(
                *swept,
                Some(at) if now >= at && now - at < AUTH_NONCE_SWEEP_INTERVAL_MS
            );
            if due {
                *swept = Some(now);
            }
            due
        };
        self.storage.consume_challenge(|mut challenge| {
            let mut prefix = b"N".to_vec();
            prefix.extend_from_slice(&recipient.0);
            let mut key = prefix.clone();
            key.extend_from_slice(&epoch);
            key.extend_from_slice(&nonce);
            if expires < now || challenge.nonce_used(&key)? {
                return Ok(ChallengeConsumption::Rejected);
            }
            let mut live = 0usize;
            let scanned: &[u8] = if sweep_all { b"N" } else { &prefix };
            let (lower, upper) = prefix_bounds(scanned)?;
            for item in challenge.used_challenges(lower, upper) {
                let (row, value) = item?;
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
                    challenge.prune_expired(&row);
                } else if row.starts_with(&prefix) {
                    live += 1;
                }
            }
            if live >= cap {
                // Expired challenges found on the way are still cleared, so a full recipient
                // drains even while it is being refused.
                challenge.commit_pruning()?;
                return Ok(ChallengeConsumption::AtCapacity);
            }
            challenge.commit_consumption(&key, expires.to_be_bytes())?;
            Ok(ChallengeConsumption::Consumed)
        })
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
        self.storage
            .read_messages(|db| {
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
        self.storage
            .read_messages(|db| {
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

    /// Read a mailbox's notification policy, returning [`MailboxNotificationPolicy::default`]
    /// when none has been configured yet.
    pub(crate) fn get_notification_policy(
        &self,
        address: Address,
    ) -> Result<crate::store::notification_policy::MailboxNotificationPolicy> {
        let Some(raw) = self.storage.notification_policy(&policy_key(address))? else {
            return Ok(crate::store::notification_policy::MailboxNotificationPolicy::default());
        };
        serde_json::from_slice(&raw).map_err(|_| CanonicalError::Unavailable)
    }

    /// Persist a mailbox's notification policy in a synced write.
    pub(crate) fn put_notification_policy(
        &self,
        address: Address,
        policy: &crate::store::notification_policy::MailboxNotificationPolicy,
    ) -> Result<()> {
        let encoded = serde_json::to_vec(policy).map_err(|_| CanonicalError::Invalid)?;
        self.storage
            .replace_notification_policy(&policy_key(address), &encoded)
    }

    /// Emit a content-free blind wakeup event (`{"type":"sync"}`) for `recipient`, coalescing
    /// repeated wakeups within `policy.coalesce_window_seconds`.
    pub(crate) fn record_wakeup(
        &self,
        recipient: Address,
        policy: &crate::store::notification_policy::MailboxNotificationPolicy,
        now_ms: i64,
    ) -> Option<crate::store::notification_policy::BlindWakeupEvent> {
        let window_ms = i64::from(policy.coalesce_window_seconds) * 1000;
        if window_ms > 0 {
            if let Ok(mut last_map) = self.last_wakeup_at_ms.lock() {
                if let Some(&last_ms) = last_map.get(&recipient) {
                    if now_ms >= last_ms && now_ms - last_ms < window_ms {
                        return None;
                    }
                }
                last_map.insert(recipient, now_ms);
            }
        }
        let event = crate::store::notification_policy::BlindWakeupEvent {
            recipient,
            payload: crate::store::notification_policy::BlindWakeupPayload::default(),
            subscriptions: policy.push_subscriptions.clone(),
            triggered_at_ms: now_ms,
        };
        if let Ok(mut wakeups) = self.wakeups.lock() {
            wakeups.push(event.clone());
        }
        Some(event)
    }

    /// Drain recorded blind wakeup events for `recipient` (used by tests and push dispatchers).
    #[allow(dead_code)]
    pub(crate) fn drain_wakeups(
        &self,
        recipient: Address,
    ) -> Vec<crate::store::notification_policy::BlindWakeupEvent> {
        let Ok(mut wakeups) = self.wakeups.lock() else {
            return Vec::new();
        };
        let mut drained = Vec::new();
        wakeups.retain(|event| {
            if event.recipient == recipient {
                drained.push(event.clone());
                false
            } else {
                true
            }
        });
        drained
    }

    /// Return the relay's cluster-safe or persisted VAPID P-256 keypair.
    ///
    /// Priority:
    /// 1. `FRANK_VAPID_PRIVATE_KEY` environment variable (hex or base64url 32-byte P-256 scalar),
    ///    enabling stateless horizontal scaling across multi-pod relay clusters.
    /// 2. Persisted 32-byte key under `b"M_vapid_privkey"` in the canonical DM RocksDB store,
    ///    so single-node relays retain their VAPID identity across restarts without breaking
    ///    existing browser WebPush subscriptions.
    /// 3. Freshly generated P-256 keypair persisted atomically to `b"M_vapid_privkey"`.
    pub(crate) fn get_or_init_vapid_keypair(
        &self,
    ) -> Result<crate::store::notification_policy::VapidKeyPair> {
        if let Ok(raw_env) = std::env::var("FRANK_VAPID_PRIVATE_KEY") {
            let trimmed = raw_env.trim();
            if !trimmed.is_empty() {
                if let Ok(kp) =
                    crate::store::notification_policy::VapidKeyPair::from_private_key_str(trimmed)
                {
                    return Ok(kp);
                }
            }
        }
        self.storage.initialize_vapid(|initialization| {
            if let Some(existing) = initialization.stored_key(VAPID_PRIVATE_KEY_STORAGE_KEY)? {
                if let Ok(bytes) = <[u8; 32]>::try_from(existing.as_slice()) {
                    return Ok(
                        crate::store::notification_policy::VapidKeyPair::from_private_key_bytes(
                            &bytes,
                        ),
                    );
                }
            }
            let generated = crate::store::notification_policy::VapidKeyPair::generate();
            initialization.store_generated_key(
                VAPID_PRIVATE_KEY_STORAGE_KEY,
                generated.private_key_bytes(),
            )?;
            Ok(generated)
        })
    }

    /// Return the relay's cluster-safe VAPID P-256 keypair backed by any [`crate::store::kv_store::RelayKvStore`]
    /// (RocksDB, Memory, or FoundationDB cluster subspace) using atomic CAS on `b"M_vapid_privkey"`.
    #[allow(dead_code)]
    pub(crate) fn get_or_init_vapid_keypair_from_kv(
        &self,
        kv: &dyn crate::store::kv_store::RelayKvStore,
    ) -> Result<crate::store::notification_policy::VapidKeyPair> {
        crate::store::notification_policy::VapidKeyPair::from_kv_store_or_env(kv)
            .map_err(|_| CanonicalError::Unavailable)
    }
}

use crate::store::notification_policy::VAPID_PRIVATE_KEY_STORAGE_KEY;

/// One address's `I` or `O` entries from a starting position onward, in delivery order.
struct Entries<'a> {
    rows: rocks::Rows<'a>,
    prefix: Vec<u8>,
    since: i64,
    after: Option<(i64, [u8; 32])>,
}
impl<'a> Entries<'a> {
    fn new(
        db: &'a MessageRead<'_>,
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
        let mut upper = prefix.clone();
        upper.push(u8::MAX);
        upper.extend_from_slice(&[u8::MAX; 8]);
        Self {
            rows: db.mailbox_rows(&start, upper),
            prefix,
            since,
            after,
        }
    }
    fn next(&mut self) -> Result<Option<(i64, [u8; 32])>> {
        for item in self.rows.by_ref() {
            let (key, value) = item?;
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
/// Per-mailbox notification policy key (`P` + 20-byte recipient address).
fn policy_key(address: Address) -> Vec<u8> {
    let mut key = b"P".to_vec();
    key.extend_from_slice(&address.0);
    key
}
/// Bound an iterator to the keys starting with `prefix`.
fn prefix_bounds(prefix: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut upper = prefix.to_vec();
    let last = upper
        .iter()
        .rposition(|byte| *byte != u8::MAX)
        .ok_or(CanonicalError::Unavailable)?;
    upper[last] += 1;
    upper.truncate(last + 1);
    Ok((prefix.to_vec(), upper))
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
fn next_delivery_time(admission: &Admission<'_>, now: i64) -> Result<i64> {
    let last = match admission.last_delivery(LAST_DELIVERY_KEY)? {
        Some(raw) => i64::from_be_bytes(
            raw.as_slice()
                .try_into()
                .map_err(|_| CanonicalError::Unavailable)?,
        ),
        None => -1,
    };
    Ok(now.max(last.checked_add(1).ok_or(CanonicalError::Unavailable)?))
}

fn find_request_locked(db: &MessageRead<'_>, request: &ExactRequest) -> Result<Option<Claim>> {
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
fn load(db: &MessageRead<'_>, hash: &[u8; 32]) -> Result<Option<Claim>> {
    let Some(raw) = db.message_row(&row_key(hash))? else {
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
fn load_delivered(db: &MessageRead<'_>, hash: &[u8; 32], time: i64) -> Result<Claim> {
    let message = load(db, hash)?.ok_or(CanonicalError::Unavailable)?;
    if message.delivered_at != time {
        return Err(CanonicalError::Unavailable);
    }
    Ok(message)
}

#[cfg(test)]
mod challenge_tests {
    use super::*;
    use rocksdb::{IteratorMode, Options};

    fn store() -> (tempdir::TempDir, Owner) {
        let dir = tempdir::TempDir::new("used-challenges").unwrap();
        let owner = Owner::new(dir.path().join("db.rocksdb"));
        (dir, owner)
    }
    fn stored(dir: &tempdir::TempDir) -> usize {
        let path = dir.path().join("db.messages-v2");
        let db = rocksdb::DB::open_for_read_only(&Options::default(), path, false).unwrap();
        db.iterator(IteratorMode::Start)
            .filter(|row| row.as_ref().unwrap().0.starts_with(b"N"))
            .count()
    }
    const EPOCH: [u8; 32] = [7; 32];
    const TTL: i64 = 60_000;
    fn nonce(n: usize) -> [u8; 32] {
        let mut nonce = [0; 32];
        nonce[..8].copy_from_slice(&(n as u64).to_be_bytes());
        nonce
    }

    #[test]
    fn a_used_challenge_is_refused_again_and_an_expired_one_is_refused() {
        let (_dir, owner) = store();
        let alice = Address([1; 20]);
        let now = 1_000_000;
        let use_it = |nonce, expires, now| {
            owner
                .consume_challenge(EPOCH, alice, nonce, expires, now, 240)
                .unwrap()
        };
        assert_eq!(
            use_it(nonce(1), now + TTL, now),
            ChallengeConsumption::Consumed
        );
        // Replay, at once and at the last moment the challenge is still valid.
        assert_eq!(
            use_it(nonce(1), now + TTL, now),
            ChallengeConsumption::Rejected
        );
        assert_eq!(
            use_it(nonce(1), now + TTL, now + TTL),
            ChallengeConsumption::Rejected
        );
        // The same nonce under another epoch or for another recipient is a different challenge.
        assert_eq!(
            owner
                .consume_challenge([8; 32], alice, nonce(1), now + TTL, now, 240)
                .unwrap(),
            ChallengeConsumption::Consumed
        );
        assert_eq!(
            owner
                .consume_challenge(EPOCH, Address([2; 20]), nonce(1), now + TTL, now, 240)
                .unwrap(),
            ChallengeConsumption::Consumed
        );
        // Never used, but past its expiry.
        assert_eq!(
            use_it(nonce(2), now - 1, now),
            ChallengeConsumption::Rejected
        );
    }

    #[test]
    fn the_bound_is_per_recipient_and_frees_as_challenges_expire() {
        let (_dir, owner) = store();
        let alice = Address([1; 20]);
        let now = 1_000_000;
        for n in 0..3 {
            assert_eq!(
                owner
                    .consume_challenge(EPOCH, alice, nonce(n), now + TTL, now, 3)
                    .unwrap(),
                ChallengeConsumption::Consumed
            );
        }
        assert_eq!(
            owner
                .consume_challenge(EPOCH, alice, nonce(3), now + TTL, now, 3)
                .unwrap(),
            ChallengeConsumption::AtCapacity
        );
        // The refused challenge was not used up: it is good once there is room.
        let later = now + TTL + 1;
        assert_eq!(
            owner
                .consume_challenge(EPOCH, alice, nonce(3), later + TTL, later, 3)
                .unwrap(),
            ChallengeConsumption::Consumed
        );
        // Alice's three expired rows went with that use.
        assert_eq!(stored(&_dir), 1);
    }

    #[test]
    fn many_recipients_never_refuse_each_other() {
        let (_dir, owner) = store();
        let now = 1_000_000;
        // 5,000 recipients with a live used challenge each: more than the 4,096 the relay
        // used to hold over all recipients together.
        for n in 0..5_000usize {
            let mut recipient = [0; 20];
            recipient[..8].copy_from_slice(&(n as u64).to_be_bytes());
            assert_eq!(
                owner
                    .consume_challenge(EPOCH, Address(recipient), nonce(n), now + TTL, now, 2)
                    .unwrap(),
                ChallengeConsumption::Consumed,
                "recipient {n}"
            );
        }
        assert_eq!(stored(&_dir), 5_000);
        // Once they have expired, the next sweep deletes them all, whoever asks.
        let later = now + TTL + AUTH_NONCE_SWEEP_INTERVAL_MS + 1;
        assert_eq!(
            owner
                .consume_challenge(EPOCH, Address([9; 20]), nonce(0), later + TTL, later, 2)
                .unwrap(),
            ChallengeConsumption::Consumed
        );
        assert_eq!(stored(&_dir), 1);
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use bitcoinsuite_core::ecc::Ecc;
    use rocksdb::{IteratorMode, Options};
    use sha3::{Digest, Keccak256};
    use std::path::Path;

    // Use the public protocol capture, then sign one ordinary, synthetic payment. No directory,
    // node, private deployment configuration or application key material is involved.
    fn paid_input() -> (CanonicalPaymentInput, [u8; 32]) {
        use frank_cbor::{FramePayload, TypedPayload, ValidationResult};
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../docs/protocol/cbor/vectors/dm-runtime.json"
        ))
        .unwrap();
        let wire = &source["canonical_facade_final_http_case"]["wire"];
        let delivery = hex::decode(wire["delivery"].as_str().unwrap()).unwrap();
        let context = hex::decode(wire["context"].as_str().unwrap()).unwrap();
        let ValidationResult::Parsed(frame) =
            frank_cbor::validate_frame(&delivery, &frank_cbor::relay_context()).unwrap()
        else {
            panic!("captured direct message");
        };
        let Some(TypedPayload::DirectMessage {
            network,
            destination,
            payload_frame,
            payload_digest,
            ..
        }) = frame.typed.as_deref()
        else {
            panic!("direct message");
        };
        let Some(TypedPayload::RecipientPayload {
            sender,
            recipient,
            shared_point,
            ..
        }) = payload_frame.typed.as_deref()
        else {
            panic!("recipient payload");
        };
        let CborValue::Map(context_fields) = decode_canonical(&context).unwrap() else {
            panic!("context");
        };
        let message_key = |slot| {
            let CborValue::Map(account) =
                &context_fields.iter().find(|(k, _)| *k == slot).unwrap().1
            else {
                panic!("message key");
            };
            let CborValue::Bytes(key) = &account.iter().find(|(k, _)| *k == 1).unwrap().1 else {
                panic!("public key");
            };
            key.clone()
        };
        let policy = FrozenCanonicalPolicy {
            network: network.clone(),
            chain_id: 10143,
            minimum: 1,
            sender_p: sender.key_bytes.clone(),
            recipient_p: recipient.key_bytes.clone(),
            sender_m: message_key(6),
            recipient_m: message_key(7),
            stamp: destination.key_bytes.clone(),
            sender_t1: hex::decode(wire["sender_t1"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
            recipient_t1: hex::decode(wire["recipient_t1"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
            payload_hash: payload_digest.as_slice().try_into().unwrap(),
        };
        let (_, address) = crate::monad_dm_verify::canonical_stamp_destination(
            network,
            destination,
            shared_point,
            0,
        )
        .unwrap();
        let secret = bitcoinsuite_ecc_secp256k1::EccSecp256k1::default()
            .seckey_from_array([17; 32])
            .unwrap();
        let transaction = crate::monad_evm_tx::test_support::signed_eip1559_tx(
            &secret,
            10143,
            0,
            Address(address),
            1,
            &[],
        )
        .0;
        let payment_hash: [u8; 32] = Keccak256::digest(&transaction).into();
        let mut amount = [0; 32];
        amount[31] = 1;
        let member = cbor_map(vec![
            (0, CborValue::Int(0)),
            (1, CborValue::Bytes(payment_hash.to_vec())),
            (2, CborValue::Bytes(amount.to_vec())),
            (3, CborValue::Bytes(address.to_vec())),
            (
                4,
                CborValue::Bytes(frank_cbor::payment_commitment(&policy.payload_hash, 0).to_vec()),
            ),
        ]);
        let CborValue::Map(mut outer) = frame.payload else {
            panic!("direct message map");
        };
        outer.iter_mut().find(|(k, _)| *k == 4).unwrap().1 = CborValue::Array(vec![member]);
        let delivery = frank_cbor::encode_frame(
            frank_cbor::EnvelopeFields {
                type_id: 1,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(&CborValue::Map(outer)),
        )
        .unwrap();
        let transactions =
            encode_canonical(&CborValue::Array(vec![CborValue::Bytes(transaction)])).unwrap();
        let mut body = Vec::new();
        for (name, media, bytes) in [
            ("delivery", "application/vnd.frank.cbor", delivery),
            ("context", "application/cbor", context),
            ("transactions", "application/cbor", transactions),
        ] {
            body.extend_from_slice(format!("--canonical-layout\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: {media}\r\n\r\n").as_bytes());
            body.extend_from_slice(&bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(b"--canonical-layout--\r\n");
        let request = ExactRequest::parse(
            body,
            "multipart/form-data; boundary=canonical-layout".into(),
        )
        .unwrap();
        (
            CanonicalPaymentInput::without_directory(request, policy).unwrap(),
            payment_hash,
        )
    }

    fn raw_rows(path: &Path) -> Vec<(Vec<u8>, Vec<u8>)> {
        assert_eq!(
            rocksdb::DB::list_cf(&Options::default(), path).unwrap(),
            ["default"]
        );
        let db = rocksdb::DB::open_for_read_only(&Options::default(), path, false).unwrap();
        db.iterator(IteratorMode::Start)
            .map(|row| {
                let (key, value) = row.unwrap();
                (key.to_vec(), value.to_vec())
            })
            .collect()
    }

    // Independently spell the CBOR v2 row, including fixed-width minimum and the exact request.
    // Do not use encode_row, load, or production key builders to generate expected storage bytes.
    fn persisted_row(message: &Claim) -> Vec<u8> {
        assert_eq!(message.delivered_at, 1234);
        assert_eq!(message.policy.network, "monad-testnet");
        assert_eq!(message.policy.chain_id, 10143);
        let mut bytes = vec![0xa5, 0x00, 0x02, 0x01, 0x59];
        bytes.extend_from_slice(
            &u16::try_from(message.request.body().len())
                .unwrap()
                .to_be_bytes(),
        );
        bytes.extend_from_slice(message.request.body());
        let content_type_len = u8::try_from(message.request.content_type().len()).unwrap();
        assert!(content_type_len > 23);
        bytes.extend_from_slice(&[0x02, 0x78, content_type_len]);
        bytes.extend_from_slice(message.request.content_type().as_bytes());
        bytes.extend_from_slice(&[0x03, 0x8b, 0x6d]);
        bytes.extend_from_slice(b"monad-testnet");
        bytes.extend_from_slice(&[0x19, 0x27, 0x9f, 0x50]);
        bytes.extend_from_slice(&message.policy.minimum.to_be_bytes());
        for key in [
            &message.policy.sender_p,
            &message.policy.recipient_p,
            &message.policy.sender_m,
            &message.policy.recipient_m,
            &message.policy.stamp,
        ] {
            assert_eq!(key.len(), 33);
            bytes.extend_from_slice(&[0x58, 0x21]);
            bytes.extend_from_slice(key);
        }
        for hash in [
            message.policy.sender_t1,
            message.policy.recipient_t1,
            message.policy.payload_hash,
        ] {
            bytes.extend_from_slice(&[0x58, 0x20]);
            bytes.extend_from_slice(&hash);
        }
        bytes.extend_from_slice(&[0x04, 0x19, 0x04, 0xd2]);
        bytes
    }

    #[test]
    fn canonical_row_and_delivery_indexes_keep_exact_v2_bytes_across_reopen() {
        let dir = tempdir::TempDir::new("canonical-layout").unwrap();
        let registry_path = dir.path().join("registry.rocksdb");
        let path = registry_path.with_extension("messages-v2");
        let (input, payment_hash) = paid_input();
        let owner = Owner::new(registry_path.clone());
        let claim = owner.claim(input, 1234).unwrap();
        let (retry, _) = paid_input();
        assert_eq!(owner.claim(retry, 9999).unwrap().delivered_at, 1234);
        let hash = claim.policy.payload_hash;
        let sender = claim.policy.sender().unwrap();
        let recipient = claim.policy.recipient().unwrap();
        assert_ne!(sender, recipient);
        let mut expected = vec![
            ([b"R".as_slice(), &hash].concat(), persisted_row(&claim)),
            ([b"T".as_slice(), &payment_hash].concat(), hash.to_vec()),
            (b"L".to_vec(), 1234i64.to_be_bytes().to_vec()),
        ];
        for (kind, party) in [(b'I', recipient), (b'O', sender)] {
            let key = [
                [kind].as_slice(),
                party.0.as_slice(),
                1234i64.to_be_bytes().as_slice(),
                hash.as_slice(),
            ]
            .concat();
            expected.push((key, hash.to_vec()));
        }
        expected.sort();
        drop(owner);
        assert_eq!(raw_rows(&path), expected);
        let reopened = Owner::new(registry_path);
        let stored = reopened.get(&hash).unwrap().unwrap();
        assert!(stored.request.exact_equal(&claim.request));
        assert_eq!(stored.policy, claim.policy);
        assert_eq!(stored.delivered_at, 1234);
        assert_eq!(reopened.inbox(recipient, 0, None, 10).unwrap().len(), 1);
        let sent = reopened.mailbox(sender, 0, None, 10).unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, MailboxDirection::Out);
        let (retry, _) = paid_input();
        assert_eq!(reopened.claim(retry, 9999).unwrap().delivered_at, 1234);
        drop(reopened);
        assert_eq!(raw_rows(&path), expected);
    }

    #[test]
    fn canonical_reads_are_lazy_and_open_failures_retry_without_reset() {
        let dir = tempdir::TempDir::new("canonical-open").unwrap();
        let registry_path = dir.path().join("registry.rocksdb");
        let path = registry_path.with_extension("messages-v2");
        let owner = Owner::new(registry_path.clone());
        let address = Address([3; 20]);
        let invalid = ExactRequest::parse(vec![0], "application/cbor".into()).unwrap();
        let policy = crate::store::notification_policy::MailboxNotificationPolicy::default();
        assert!(owner.get(&[0; 32]).unwrap().is_none());
        assert!(owner.find_request(&invalid).unwrap().is_none());
        assert!(owner.inbox(address, 0, None, 1).unwrap().is_empty());
        assert!(owner.mailbox(address, 0, None, 1).unwrap().is_empty());
        assert_eq!(owner.get_notification_policy(address).unwrap(), policy);
        assert!(!path.exists());
        std::fs::write(&path, b"owned sentinel").unwrap();
        assert!(matches!(
            owner.get(&[0; 32]),
            Err(CanonicalError::Unavailable)
        ));
        assert!(matches!(
            owner.put_notification_policy(address, &policy),
            Err(CanonicalError::Unavailable)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), b"owned sentinel");
        std::fs::remove_file(&path).unwrap();
        #[cfg(unix)]
        {
            let target = dir.path().join("owned-symlink-target");
            std::fs::create_dir(&target).unwrap();
            std::fs::write(target.join("sentinel"), b"preserved").unwrap();
            std::os::unix::fs::symlink(&target, &path).unwrap();
            assert!(matches!(
                owner.put_notification_policy(address, &policy),
                Err(CanonicalError::Unavailable)
            ));
            assert_eq!(
                std::fs::read(target.join("sentinel")).unwrap(),
                b"preserved"
            );
            assert!(!target.join("CURRENT").exists());
            std::fs::remove_file(&path).unwrap();
        }
        owner.put_notification_policy(address, &policy).unwrap();
        assert!(matches!(
            owner.find_request(&invalid),
            Err(CanonicalError::Invalid)
        ));
        std::fs::rename(path.join("CURRENT"), path.join("CURRENT.saved")).unwrap();
        assert!(matches!(
            owner.get(&[0; 32]),
            Err(CanonicalError::Unavailable)
        ));
        std::fs::rename(path.join("CURRENT.saved"), path.join("CURRENT")).unwrap();
        assert_eq!(owner.get_notification_policy(address).unwrap(), policy);
        drop(owner);
        assert_eq!(
            Owner::new(registry_path)
                .get_notification_policy(address)
                .unwrap(),
            policy
        );
    }

    fn stored_nonce(recipient: Address, epoch: [u8; 32], nonce: [u8; 32]) -> Vec<u8> {
        [b"N".as_slice(), &recipient.0, &epoch, &nonce].concat()
    }

    #[test]
    fn canonical_challenge_is_consumed_once_under_race_and_after_reopen() {
        let dir = tempdir::TempDir::new("canonical-nonce-race").unwrap();
        let registry_path = dir.path().join("registry.rocksdb");
        let path = registry_path.with_extension("messages-v2");
        let owner = Arc::new(Owner::new(registry_path.clone()));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let recipient = Address([3; 20]);
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let owner = owner.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    owner
                        .consume_challenge([4; 32], recipient, [5; 32], 2000, 1000, 1)
                        .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|r| **r == ChallengeConsumption::Consumed)
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|r| **r == ChallengeConsumption::Rejected)
                .count(),
            7
        );
        drop(owner);
        let expected = vec![(
            stored_nonce(recipient, [4; 32], [5; 32]),
            2000i64.to_be_bytes().to_vec(),
        )];
        assert_eq!(raw_rows(&path), expected);
        let reopened = Owner::new(registry_path);
        assert_eq!(
            reopened
                .consume_challenge([4; 32], recipient, [5; 32], 2000, 1000, 1)
                .unwrap(),
            ChallengeConsumption::Rejected
        );
        drop(reopened);
        assert_eq!(raw_rows(&path), expected);
    }

    #[test]
    fn malformed_challenge_scan_neither_prunes_expired_rows_nor_consumes_new_nonce() {
        for bad_key in [false, true] {
            let dir = tempdir::TempDir::new("canonical-nonce-malformed").unwrap();
            let registry_path = dir.path().join("registry.rocksdb");
            let path = registry_path.with_extension("messages-v2");
            let recipient = Address([3; 20]);
            let expired = stored_nonce(recipient, [4; 32], [0; 32]);
            let mut malformed = stored_nonce(recipient, [4; 32], [1; 32]);
            let expiry = if bad_key {
                malformed.pop();
                2000i64.to_be_bytes().to_vec()
            } else {
                vec![0]
            };
            {
                let db = rocksdb::DB::open_default(&path).unwrap();
                db.put(&expired, 999i64.to_be_bytes()).unwrap();
                db.put(&malformed, &expiry).unwrap();
            }
            let expected = raw_rows(&path);
            let owner = Owner::new(registry_path);
            assert!(matches!(
                owner.consume_challenge([4; 32], recipient, [2; 32], 2000, 1000, 10),
                Err(CanonicalError::Unavailable)
            ));
            drop(owner);
            assert_eq!(raw_rows(&path), expected);
        }
    }
}

#[cfg(test)]
mod storage_boundary_tests {
    #[test]
    fn canonical_facade_does_not_depend_on_native_storage_types() {
        let source = include_str!("monad_dm_cbor.rs");
        let production = source
            .split("#[cfg(test)]\nmod challenge_tests")
            .next()
            .unwrap();
        for native in [
            "rocksdb::",
            "WriteBatch",
            "ReadOptions",
            "WriteOptions",
            "IteratorMode",
        ] {
            assert!(
                !production.contains(native),
                "native storage type {native} escaped adapter"
            );
        }
    }
}
