//! Where the relay keeps direct messages, over the [`RelayKvStore`] transaction contract.
//!
//! Every key starts with `dm/`, so the store can share one transaction backend (and one
//! FoundationDB subspace) with other owners:
//!
//! | key | value | what it is |
//! |---|---|---|
//! | `dm/R` + payload hash | the stored message | the request bytes as submitted (or the reference to them), and when it was delivered |
//! | `dm/I` + recipient + time + payload hash | payload hash | the recipient's inbox, in delivery order |
//! | `dm/O` + sender + time + payload hash | payload hash | the sender's own copies, in delivery order |
//! | `dm/T` + transaction hash | payload hash | a payment already used, so it pays for one message only |
//! | `dm/L` + address | time | the last delivery time issued in that address's mailbox |
//! | `dm/N` + recipient + epoch + nonce | expiry | a login challenge already used |
//! | `dm/P` + address | policy JSON | the mailbox's notification policy |
//! | `dm/V` | | this store's large-value index ([`LargeValues`]) |
//!
//! A message is written once, with all of its keys, in one transaction, and never changed.
//! Nothing is ever deleted except expired login challenges. There is no key every message
//! writes: two messages conflict only when they share a party (or are the same message).
//!
//! A request of at most [`INLINE_LIMIT`] bytes is kept inline in its row. A larger one is an
//! object in the large-value store composition passes in (S3 in a cluster, a directory beside
//! the database on a single node), named `messages/sha256/<hex>/<upload>`. The object is
//! uploaded before the admission transaction, and its reference commits in that transaction
//! with the row, the payment keys and the delivery times, or not at all. An upload whose
//! admission did not commit it is left to the sweep ([`Owner::sweep_large_values`]). So
//! admitting a large message needs the object store: while it is down, such a message is
//! refused as unavailable and nothing is stored.
//!
//! Single-replica relays keep these keys in a RocksDB directory beside the registry database.
//! Its name carries the format version (in a cluster, the FoundationDB subspace name does).
//! Frank has no users yet, so there is no reader for any earlier format:
//! [`crate::store::db::Db::open`] refuses to start beside a store of an older one and says what
//! to delete. A cluster hands the owner its shared transaction backend
//! ([`Owner::with_store`]) and starts from an empty subspace.
//!
//! The store's calls block (FoundationDB waits on its own network thread), so async callers run
//! them on blocking workers.
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};

use frank_cbor::message_fields::{canonical_dm_message_row as R, canonical_dm_message_row_version};
use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue};

use crate::{
    canonical_dm_request::ExactRequest,
    directory_runtime::DirectoryRuntime,
    evm_dm_payment::{CanonicalPaymentInput, SubmissionEcho},
    evm_mailbox::{CanonicalError, ChallengeConsumption, Result},
    evm_rpc::{Address, Hash32},
    store::{
        kv_store::{
            key_after, prefix_end, KvError, KvTransaction, RelayKvStore, RocksDbKvStore, Transact,
            MAX_VALUE_BYTES,
        },
        large_values::{
            LargeValueError, LargeValues, ObjectStore, Staged, Stored, SweepReport, INLINE_LIMIT,
        },
    },
};

/// The message store's directory is the registry database's path with this extension.
pub(crate) const STORE_EXTENSION: &str = "messages-v4";
/// Extensions of message stores written by earlier development builds. None can be read.
pub(crate) const OLD_STORE_EXTENSIONS: &[&str] =
    &["monad-dm-cbor-v1", "messages-v2", "messages-v3"];
const ROW_VERSION: i128 = canonical_dm_message_row_version::V3 as i128;
/// Where requests over [`INLINE_LIMIT`] live in the large-value store.
pub(crate) const OBJECT_NAMESPACE: &str = "messages";

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
        crate::evm_stamp_stealth::recipient_address_from_public_key(&self.sender_p)
            .map_err(|_| CanonicalError::Unavailable)
    }

    /// The sender, or `None` for a sealed-sender message, which names no sender to the relay.
    pub(crate) fn named_sender(&self) -> Result<Option<Address>> {
        if self.sender_p.is_empty() {
            Ok(None)
        } else {
            self.sender().map(Some)
        }
    }

    /// Every mailbox a message is in: the recipient's, and the named sender's when it is
    /// someone else (a sealed-sender message has no sender mailbox row).
    pub(crate) fn parties(&self) -> Result<Vec<Address>> {
        let recipient = self.recipient()?;
        Ok(match self.named_sender()? {
            Some(sender) if sender != recipient => vec![recipient, sender],
            _ => vec![recipient],
        })
    }

    pub(crate) fn recipient(&self) -> Result<Address> {
        crate::evm_stamp_stealth::recipient_address_from_public_key(&self.recipient_p)
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

    /// Which side of this message `address` is, if either. A message to oneself is inbound.
    pub(crate) fn direction_for(&self, address: Address) -> Option<MailboxDirection> {
        if self.policy.recipient() == Ok(address) {
            Some(MailboxDirection::In)
        } else if self.policy.sender() == Ok(address) {
            Some(MailboxDirection::Out)
        } else {
            None
        }
    }
}

/// What [`Owner::claim`] did with a message.
#[derive(Debug, Clone)]
pub(crate) struct Admitted {
    pub(crate) claim: Claim,
    /// The message may have been committed by this call: a new row, or one whose commit
    /// outcome was unknown and was then found stored. `false` for an exact repeat that was
    /// already stored. Announcing a row twice is harmless; readers drop repeats.
    pub(crate) new: bool,
}

/// How often every recipient's expired login challenges are deleted. A recipient's own are
/// deleted each time it uses a new one; this pass clears those of recipients who went away.
const AUTH_NONCE_SWEEP_INTERVAL_MS: i64 = 60_000;
/// Used challenges cleared per sweep transaction.
const AUTH_NONCE_SWEEP_PAGE: usize = 1024;
/// How long one admission keeps retrying a transaction that lost every attempt to concurrent
/// commits on the same mailbox. Each attempt is short; this bounds a burst at one recipient.
const ADMISSION_BUDGET: Duration = Duration::from_secs(20);

/// Where the owner's keys live.
#[derive(Debug)]
enum Storage {
    /// A transaction backend handed over by composition (FoundationDB in a cluster).
    Shared(Arc<dyn RelayKvStore>),
    /// A single replica's own RocksDB directory beside the registry database, opened on the
    /// first write. Reads before then find an empty store and create nothing.
    Beside {
        path: PathBuf,
        opened: Mutex<Option<Arc<RocksDbKvStore>>>,
    },
}

impl Storage {
    fn open(&self, create: bool) -> Result<Option<Arc<dyn RelayKvStore>>> {
        let (path, opened) = match self {
            Self::Shared(store) => return Ok(Some(Arc::clone(store))),
            Self::Beside { path, opened } => (path, opened),
        };
        let mut guard = opened.lock().map_err(|_| CanonicalError::Unavailable)?;
        if guard.is_none() {
            match std::fs::symlink_metadata(path) {
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
            *guard = Some(Arc::new(
                RocksDbKvStore::open(path).map_err(|_| CanonicalError::Unavailable)?,
            ));
        }
        // A directory whose database was removed underneath the open handle is not read as
        // empty.
        if !path.join("CURRENT").is_file() {
            return Err(CanonicalError::Unavailable);
        }
        let store = Arc::clone(guard.as_ref().ok_or(CanonicalError::Unavailable)?);
        Ok(Some(store as Arc<dyn RelayKvStore>))
    }
}

/// Why a transaction body stopped: a refusal of the message, the store, or a large request's
/// upload that the sweep collected before the admission committed it.
enum Stop {
    Refused(CanonicalError),
    Store(KvError),
    IntentLost,
}
impl From<KvError> for Stop {
    fn from(error: KvError) -> Self {
        Self::Store(error)
    }
}
impl From<LargeValueError> for Stop {
    fn from(error: LargeValueError) -> Self {
        match error {
            LargeValueError::Kv(error) => Self::Store(error),
            LargeValueError::IntentLost => Self::IntentLost,
            other => Self::Refused(large_value_error(other)),
        }
    }
}
/// A large-value failure outside a transaction. The object store's message is logged, never
/// answered: it may name the endpoint or the bucket.
fn large_value_error(error: LargeValueError) -> CanonicalError {
    match error {
        LargeValueError::Kv(error) => store_error(error),
        other => {
            tracing::warn!("Direct-message large values: {other}");
            CanonicalError::Unavailable
        }
    }
}
impl From<CanonicalError> for Stop {
    fn from(error: CanonicalError) -> Self {
        Self::Refused(error)
    }
}
fn store_error(error: KvError) -> CanonicalError {
    match error {
        KvError::TransactionTooLarge { .. } => CanonicalError::TooLarge,
        _ => CanonicalError::Unavailable,
    }
}
impl From<Stop> for CanonicalError {
    fn from(stop: Stop) -> Self {
        match stop {
            Stop::Refused(error) => error,
            Stop::Store(error) => store_error(error),
            Stop::IntentLost => CanonicalError::Unavailable,
        }
    }
}
type Body<T> = std::result::Result<T, Stop>;

/// The message store of one registry.
#[derive(Debug)]
pub(crate) struct Owner {
    storage: Storage,
    /// Where requests over [`INLINE_LIMIT`] live (`registry.large_values`).
    objects: Arc<dyn ObjectStore>,
    /// The large-value index, in this owner's store, once the store is open.
    large: std::sync::OnceLock<LargeValues>,
    /// Newly stored canonical messages since this relay process started. Retries are excluded.
    messages_stored_total: AtomicU64,
    directory: Mutex<Weak<DirectoryRuntime>>,
    /// When each message's payments were last handed to the node. In memory only, and per
    /// replica: it only stops one relay hammering the node for one client's resends.
    payment_broadcasts: Mutex<std::collections::HashMap<[u8; 32], std::time::Instant>>,
    /// When every recipient's expired login challenges were last deleted. In memory only: the
    /// first use after a restart sweeps.
    auth_nonces_swept_at_ms: Mutex<Option<i64>>,
    /// Recorded blind wakeup events, for tests to inspect.
    #[cfg(test)]
    wakeups: Mutex<Vec<crate::store::notification_policy::BlindWakeupEvent>>,
    /// Per-recipient timestamp (ms) of the last emitted blind wakeup, for coalescing. Per
    /// replica until wakeup coalescing moves into the shared store (HA plan step 10).
    last_wakeup_at_ms: Mutex<std::collections::HashMap<Address, i64>>,
}
impl Owner {
    /// The store that belongs beside the registry database at `registry_db`. Requests over
    /// [`INLINE_LIMIT`] go to `objects`.
    pub(crate) fn new(registry_db: PathBuf, objects: Arc<dyn ObjectStore>) -> Self {
        Self::with_storage(
            Storage::Beside {
                path: registry_db.with_extension(STORE_EXTENSION),
                opened: Mutex::new(None),
            },
            objects,
        )
    }

    /// The store on a transaction backend shared by every replica of a cluster. Requests over
    /// [`INLINE_LIMIT`] go to `objects`, which every replica must share too (S3).
    pub(crate) fn with_store(store: Arc<dyn RelayKvStore>, objects: Arc<dyn ObjectStore>) -> Self {
        Self::with_storage(Storage::Shared(store), objects)
    }

    fn with_storage(storage: Storage, objects: Arc<dyn ObjectStore>) -> Self {
        Self {
            storage,
            objects,
            large: std::sync::OnceLock::new(),
            messages_stored_total: AtomicU64::new(0),
            directory: Mutex::new(Weak::new()),
            payment_broadcasts: Default::default(),
            auth_nonces_swept_at_ms: Mutex::new(None),
            #[cfg(test)]
            wakeups: Default::default(),
            last_wakeup_at_ms: Default::default(),
        }
    }

    /// Run a read-only transaction. A store that was never written reads as empty.
    fn read<T>(
        &self,
        empty: impl FnOnce() -> T,
        body: impl FnMut(&mut dyn KvTransaction) -> Body<T>,
    ) -> Result<T> {
        match self.storage.open(false)? {
            None => Ok(empty()),
            Some(store) => Ok(store.transact(body)?),
        }
    }

    fn writable(&self) -> Result<Arc<dyn RelayKvStore>> {
        self.storage.open(true)?.ok_or(CanonicalError::Unavailable)
    }

    /// The large-value index inside `store`, which is this owner's only store.
    fn large(&self, store: &Arc<dyn RelayKvStore>) -> &LargeValues {
        self.large.get_or_init(|| {
            LargeValues::new(
                Arc::clone(store),
                Arc::clone(&self.objects),
                &large_value_prefix(),
                OBJECT_NAMESPACE,
            )
        })
    }

    /// The request a row holds: inline, or read from the object store and checked against
    /// its digest and length. Read outside any transaction, so a slow object store never holds
    /// one open.
    fn resolve(&self, row: Row) -> Result<Claim> {
        let body = match row.body {
            Stored::Inline(bytes) => bytes,
            Stored::Large(reference) => {
                let store = self
                    .storage
                    .open(false)?
                    .ok_or(CanonicalError::Unavailable)?;
                self.large(&store)
                    .read(&reference)
                    .map_err(large_value_error)?
            }
        };
        let request =
            ExactRequest::parse(body, row.content_type).map_err(|_| CanonicalError::Unavailable)?;
        Ok(Claim {
            request,
            policy: row.policy,
            delivered_at: row.delivered_at,
        })
    }

    /// Delete unreferenced message objects (requests over the inline limit) as sweep lease
    /// holder `holder`. Nothing is done before this replica's store exists. Blocks.
    pub(crate) fn sweep_large_values(&self, holder: [u8; 16]) -> Result<SweepReport> {
        match self.storage.open(false)? {
            None => Ok(SweepReport::default()),
            Some(store) => self.large(&store).sweep(holder).map_err(large_value_error),
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
        self.read(|| None, |tx| load(tx, payload_hash))?
            .map(|row| self.resolve(row))
            .transpose()
    }
    /// The stored message this request is an exact repeat of, if any. The same message under
    /// different bytes is a conflict.
    pub(crate) fn find_request(&self, request: &ExactRequest) -> Result<Option<Claim>> {
        if self.storage.open(false)?.is_none() {
            return Ok(None);
        }
        let hash = request_hash(request)?;
        let Some(existing) = self.read(|| None, |tx| load(tx, &hash))? else {
            return Ok(None);
        };
        // A large request is compared by its digest and length; its object is not read.
        if !existing.holds(request) {
            return Err(CanonicalError::Conflict);
        }
        Ok(Some(existing.with_request(request.clone())))
    }
    /// Inspect the real uniqueness index at the node boundary in HTTP integration tests.
    #[cfg(test)]
    pub(crate) fn payment_is_committed_to(
        &self,
        payment: Hash32,
        payload: [u8; 32],
    ) -> Result<bool> {
        self.read(
            || false,
            |tx| Ok(tx.get(&payment_key(&payment))?.as_deref() == Some(payload.as_slice())),
        )
    }
    /// Store a checked message in the recipient's inbox and the sender's own mailbox, in one
    /// transaction. An exact repeat returns what is already stored, on whichever replica it is
    /// presented. A refusal (a payment already used for another message) leaves nothing behind.
    /// The number of messages already stored never refuses one.
    ///
    /// `now` is the caller's clock; the delivery time is decided inside the transaction: see
    /// [`next_delivery_time`].
    ///
    /// A commit whose outcome the backend could not report is settled by a fence (see
    /// [`Owner::fence`]): a transaction that reads the message's row and rewrites the
    /// recipient's delivery-time key, which the first attempt read. Once the fence commits, the
    /// first attempt has either landed (the fence saw its row) or can never land (its read is
    /// now stale). Found, the row is the stored message; not found, admission runs again. So
    /// nothing is announced and no payment is broadcast for a message that may not exist, and
    /// a late commit cannot add a second row or a time behind one a reader has already seen.
    ///
    /// A request over [`INLINE_LIMIT`] is uploaded first (see the module documentation); its
    /// reference commits with the row. An upload the stored row does not reference (a refusal,
    /// an exact repeat that raced this one, a failure) is left to the sweep.
    pub(crate) fn claim(&self, input: CanonicalPaymentInput, now: i64) -> Result<Admitted> {
        let store = self.writable()?;
        let large = self.large(&store);
        let mut staged: Option<Staged> = None;
        let result = self.admit(&store, large, &input, now, &mut staged);
        if let Some(staged) = &staged {
            let referenced = matches!(&result,
                Ok((row, _)) if matches!(&row.body, Stored::Large(r) if r.upload == staged.reference.upload));
            if !referenced {
                large.abandon(staged);
            }
        }
        let (row, new) = result?;
        if new {
            self.messages_stored_total.fetch_add(1, Ordering::Relaxed);
        }
        Ok(Admitted {
            claim: row.with_request(input.request),
            new,
        })
    }

    /// The admission loop of [`Owner::claim`]: the stored row, and whether this call may have
    /// committed it. `staged` is this call's upload of a large request, if any.
    fn admit(
        &self,
        store: &Arc<dyn RelayKvStore>,
        large: &LargeValues,
        input: &CanonicalPaymentInput,
        now: i64,
        staged: &mut Option<Staged>,
    ) -> Result<(Row, bool)> {
        let hash = input.policy.payload_hash;
        let recipient = input.policy.recipient()?;
        // The recipient first: the fence after an unknown commit outcome writes its key.
        let parties = input.policy.parties()?;
        let payment_keys: Vec<Vec<u8>> = input
            .payment_hashes()
            .map(|payment| payment_key(&payment))
            .collect();
        let body = input.request.body();
        let started = Instant::now();
        loop {
            if body.len() > INLINE_LIMIT && staged.is_none() {
                // Before anything else is decided: an object store that is down refuses the
                // message here, with nothing stored.
                *staged = Some(large.stage(body).map_err(large_value_error)?);
            }
            let attempt = store.transact(|tx| -> Body<(Row, bool)> {
                if let Some(existing) = load(tx, &hash)? {
                    if !existing.holds(&input.request) {
                        return Err(Stop::Refused(CanonicalError::Conflict));
                    }
                    return Ok((existing, false));
                }
                // One signed payment pays for one message. Nothing on chain names the message,
                // so this index is what stops a payment being presented again for another.
                for key in &payment_keys {
                    if tx.get(key)?.is_some() {
                        return Err(Stop::Refused(CanonicalError::Conflict));
                    }
                }
                let delivered_at = next_delivery_time(tx, &parties, now)?;
                let row_key = row_key(&hash);
                let stored = match staged.as_ref() {
                    Some(staged) => {
                        large.commit_reference(tx, staged, &row_key)?;
                        Stored::Large(staged.reference)
                    }
                    None => Stored::Inline(body.to_vec()),
                };
                let row = Row {
                    body: stored,
                    content_type: input.request.content_type().to_owned(),
                    policy: input.policy.clone(),
                    delivered_at,
                };
                tx.set(&row_key, &encode_row(&row)?)?;
                for key in &payment_keys {
                    tx.set(key, &hash)?;
                }
                tx.set(&mailbox_key(b'I', recipient, delivered_at, &hash), &hash)?;
                for sender in &parties[1..] {
                    tx.set(&mailbox_key(b'O', *sender, delivered_at, &hash), &hash)?;
                }
                for party in &parties {
                    tx.set(&last_delivery_key(*party), &delivered_at.to_be_bytes())?;
                }
                Ok((row, true))
            });
            match attempt {
                Ok(admitted) => return Ok(admitted),
                Err(Stop::Refused(error)) => return Err(error),
                // The sweep judged the upload abandoned (this writer stalled past the intent's
                // lifetime). Expire it for the sweep and upload anew.
                Err(Stop::IntentLost) if started.elapsed() < ADMISSION_BUDGET => {
                    if let Some(lost) = staged.take() {
                        large.abandon(&lost);
                    }
                }
                Err(Stop::IntentLost) => return Err(CanonicalError::Unavailable),
                // Every attempt lost to another commit on one of these mailboxes. The body has
                // no effect outside the transaction, so it is simply run again.
                Err(Stop::Store(KvError::ConflictRetriesExhausted { .. }))
                    if started.elapsed() < ADMISSION_BUDGET =>
                {
                    std::thread::sleep(Duration::from_millis(1 + rand::random::<u64>() % 20));
                }
                Err(Stop::Store(KvError::CommitUnknownResult(reason))) => {
                    tracing::event!(
                        tracing::Level::WARN,
                        payload_hash = %hex::encode(hash),
                        reason = %reason,
                        "Direct-message commit outcome unknown; fencing and reading the store"
                    );
                    match self.fence(store, &hash, recipient, started)? {
                        Some(row) if row.holds(&input.request) => return Ok((row, true)),
                        Some(_) => return Err(CanonicalError::Conflict),
                        // The first attempt can no longer commit: admit the message afresh.
                        None if started.elapsed() < ADMISSION_BUDGET => {}
                        None => return Err(CanonicalError::Unavailable),
                    }
                }
                Err(Stop::Store(error)) => return Err(store_error(error)),
            }
        }
    }

    /// Settle an attempt whose commit outcome is unknown. In one transaction, read the row and
    /// write the recipient's delivery-time key back unchanged (cleared if it was absent). A
    /// transaction that read that key, as every admission naming the recipient did, and has not
    /// committed when the fence commits now conflicts and never commits. So when this returns,
    /// the row it read is final: present, the attempt landed; absent, it never will.
    fn fence(
        &self,
        store: &Arc<dyn RelayKvStore>,
        hash: &[u8; 32],
        recipient: Address,
        started: Instant,
    ) -> Result<Option<Row>> {
        let key = last_delivery_key(recipient);
        loop {
            let fenced = store.transact(|tx| -> Body<Option<Row>> {
                let row = load(tx, hash)?;
                match tx.get(&key)? {
                    Some(current) => tx.set(&key, &current)?,
                    None => tx.clear(&key)?,
                }
                Ok(row)
            });
            match fenced {
                Ok(row) => return Ok(row),
                Err(stop @ (Stop::Refused(_) | Stop::IntentLost)) => return Err(stop.into()),
                // The fence writes nothing new, so running it again is harmless.
                Err(Stop::Store(
                    KvError::CommitUnknownResult(_) | KvError::ConflictRetriesExhausted { .. },
                )) if started.elapsed() < ADMISSION_BUDGET => {
                    std::thread::sleep(Duration::from_millis(1 + rand::random::<u64>() % 20));
                }
                Err(Stop::Store(error)) => return Err(store_error(error)),
            }
        }
    }

    /// Newly stored messages since process start; exact request retries do not increment it.
    pub(crate) fn messages_stored_total(&self) -> u64 {
        self.messages_stored_total.load(Ordering::Relaxed)
    }

    /// Estimated live key/value bytes of a single replica's message store, if it has been
    /// created. `None` on a shared backend, which reports its own size.
    pub(crate) fn estimated_live_data_size_bytes(&self) -> Result<Option<u64>> {
        let Storage::Beside { opened, .. } = &self.storage else {
            return Ok(None);
        };
        if self.storage.open(false)?.is_none() {
            return Ok(None);
        }
        let guard = opened.lock().map_err(|_| CanonicalError::Unavailable)?;
        let store = guard.as_ref().ok_or(CanonicalError::Unavailable)?;
        store
            .estimated_live_data_size_bytes()
            .map(Some)
            .map_err(|_| CanonicalError::Unavailable)
    }
    /// Records one authenticated login challenge as used, so it cannot be replayed on any
    /// replica.
    ///
    /// A challenge is refused when it has expired or was already used. A recipient holding `cap`
    /// used challenges that have not expired yet is at capacity until one does. The capacity
    /// check reads the recipient's whole range of used challenges, so two uses for one
    /// recipient conflict and are decided one after the other. There is no bound over all
    /// recipients: one recipient's use never refuses another's. Used challenges are deleted
    /// once expired.
    pub(crate) fn consume_challenge(
        &self,
        epoch: [u8; 32],
        recipient: Address,
        nonce: [u8; 32],
        expires: i64,
        now: i64,
        cap: usize,
    ) -> Result<ChallengeConsumption> {
        if expires < now {
            return Ok(ChallengeConsumption::Rejected);
        }
        let store = self.writable()?;
        let prefix = challenge_prefix(Some(recipient));
        let key = [prefix.as_slice(), &epoch, &nonce].concat();
        let consumed = store.transact(|tx| -> Body<ChallengeConsumption> {
            if tx.get(&key)?.is_some() {
                return Ok(ChallengeConsumption::Rejected);
            }
            let mut live = 0usize;
            for (row, value) in tx.scan_prefix(&prefix, None, usize::MAX)? {
                if challenge_expiry(&row, &value)? < now {
                    tx.clear(&row)?;
                } else {
                    live += 1;
                }
            }
            if live >= cap {
                // Expired challenges found on the way are still cleared, so a full recipient
                // drains even while it is being refused.
                return Ok(ChallengeConsumption::AtCapacity);
            }
            tx.set(&key, &expires.to_be_bytes())?;
            Ok(ChallengeConsumption::Consumed)
        })?;
        // The challenge is already decided and committed; cleaning up other recipients' expired
        // challenges is housekeeping, so its failure is logged and never fails this request.
        if self.sweep_due(now).unwrap_or(false) {
            if let Err(error) = self.sweep_expired_challenges(&store, now) {
                tracing::event!(
                    tracing::Level::WARN,
                    error = %error,
                    "Sweeping expired mailbox challenges failed; the next sweep retries"
                );
                if let Ok(mut swept) = self.auth_nonces_swept_at_ms.lock() {
                    *swept = None;
                }
            }
        }
        Ok(consumed)
    }

    fn sweep_due(&self, now: i64) -> Result<bool> {
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
        Ok(due)
    }

    /// Delete every recipient's expired used challenges, a page per transaction.
    fn sweep_expired_challenges(&self, store: &Arc<dyn RelayKvStore>, now: i64) -> Result<()> {
        let all = challenge_prefix(None);
        let mut after: Option<Vec<u8>> = None;
        loop {
            let page = store.transact(|tx| -> Body<Option<Vec<u8>>> {
                let rows = tx.scan_prefix(&all, after.as_deref(), AUTH_NONCE_SWEEP_PAGE)?;
                for (row, value) in &rows {
                    if challenge_expiry(row, value)? < now {
                        tx.clear(row)?;
                    }
                }
                Ok((rows.len() == AUTH_NONCE_SWEEP_PAGE)
                    .then(|| rows.last().map(|(row, _)| row.clone()))
                    .flatten())
            })?;
            match page {
                Some(last) => after = Some(last),
                None => return Ok(()),
            }
        }
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
        let entries = self.read(Vec::new, |tx| {
            entries(tx, b'I', recipient, since, after, limit)
        })?;
        entries
            .into_iter()
            .map(|(time, hash)| {
                let message = self.load_delivered(&hash, time)?;
                if message.policy.recipient() != Ok(recipient) {
                    return Err(CanonicalError::Unavailable);
                }
                Ok(message)
            })
            .collect()
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
        if limit == 0 {
            return Ok(Vec::new());
        }
        let (received, sent) = self.read(
            || (Vec::new(), Vec::new()),
            |tx| {
                Ok((
                    entries(tx, b'I', address, since, after, limit)?,
                    entries(tx, b'O', address, since, after, limit)?,
                ))
            },
        )?;
        let mut merged: Vec<_> = received
            .into_iter()
            .map(|entry| (entry, MailboxDirection::In))
            .chain(sent.into_iter().map(|entry| (entry, MailboxDirection::Out)))
            .collect();
        // Received before sent at an equal position, as the scans have always been merged.
        merged.sort_by_key(|(entry, direction)| (*entry, *direction == MailboxDirection::Out));
        merged.truncate(limit);
        merged
            .into_iter()
            .map(|((time, hash), direction)| {
                let message = self.load_delivered(&hash, time)?;
                let party = match direction {
                    MailboxDirection::In => message.policy.recipient(),
                    MailboxDirection::Out => message.policy.sender(),
                };
                if party != Ok(address) {
                    return Err(CanonicalError::Unavailable);
                }
                Ok((message, direction))
            })
            .collect()
    }

    /// The message a mailbox entry points at, which must have been delivered at the entry's
    /// time. Rows never change once written, so each is read in a transaction of its own and a
    /// long page never holds one transaction open.
    fn load_delivered(&self, hash: &[u8; 32], time: i64) -> Result<Claim> {
        let message = self.get(hash)?.ok_or(CanonicalError::Unavailable)?;
        if message.delivered_at != time {
            return Err(CanonicalError::Unavailable);
        }
        Ok(message)
    }

    /// Read a mailbox's notification policy, returning [`MailboxNotificationPolicy::default`]
    /// when none has been configured yet.
    pub(crate) fn get_notification_policy(
        &self,
        address: Address,
    ) -> Result<crate::store::notification_policy::MailboxNotificationPolicy> {
        let raw = self.read(|| None, |tx| Ok(tx.get(&policy_key(address))?))?;
        let Some(raw) = raw else {
            return Ok(crate::store::notification_policy::MailboxNotificationPolicy::default());
        };
        serde_json::from_slice(&raw).map_err(|_| CanonicalError::Unavailable)
    }

    /// Persist a mailbox's notification policy.
    pub(crate) fn put_notification_policy(
        &self,
        address: Address,
        policy: &crate::store::notification_policy::MailboxNotificationPolicy,
    ) -> Result<()> {
        let encoded = serde_json::to_vec(policy).map_err(|_| CanonicalError::Invalid)?;
        if encoded.len() > MAX_VALUE_BYTES {
            return Err(CanonicalError::TooLarge);
        }
        let store = self.writable()?;
        Ok(store.transact(|tx| -> Body<()> { Ok(tx.set(&policy_key(address), &encoded)?) })?)
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
        #[cfg(test)]
        if let Ok(mut wakeups) = self.wakeups.lock() {
            wakeups.push(event.clone());
        }
        Some(event)
    }

    /// Drain recorded blind wakeup events for `recipient`.
    #[cfg(test)]
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
}

/// Up to `limit` of one address's `I` or `O` entries at or after `since` and strictly after
/// `after`, in delivery order.
fn entries(
    tx: &mut dyn KvTransaction,
    kind: u8,
    address: Address,
    since: i64,
    after: Option<(i64, [u8; 32])>,
    limit: usize,
) -> Body<Vec<(i64, [u8; 32])>> {
    let prefix = mailbox_prefix(kind, address);
    // Delivery times are never negative, so their big-endian bytes sort in time order and the
    // scan can start at the first key that could qualify.
    let start = match after {
        Some((time, hash)) if time >= since => key_after(&mailbox_key(kind, address, time, &hash)),
        _ => mailbox_key(kind, address, since.max(0), &[0; 32]),
    };
    let mut result = Vec::new();
    for (key, value) in tx.get_range(&start, &prefix_end(&prefix), limit)? {
        if key.len() != prefix.len() + 40 {
            return Err(Stop::Refused(CanonicalError::Unavailable));
        }
        let time = i64::from_be_bytes(key[prefix.len()..prefix.len() + 8].try_into().expect("8"));
        let hash: [u8; 32] = key[prefix.len() + 8..].try_into().expect("32 bytes");
        if value != hash || time < since {
            return Err(Stop::Refused(CanonicalError::Unavailable));
        }
        result.push((time, hash));
    }
    Ok(result)
}

const KEY_SPACE: &[u8] = b"dm/";

fn key(kind: u8, parts: &[&[u8]]) -> Vec<u8> {
    let mut key = KEY_SPACE.to_vec();
    key.push(kind);
    for part in parts {
        key.extend_from_slice(part);
    }
    key
}
fn row_key(hash: &[u8; 32]) -> Vec<u8> {
    key(b'R', &[hash])
}
/// Where this store's large-value index keeps its keys.
fn large_value_prefix() -> Vec<u8> {
    key(b'V', &[])
}
/// Used-payment index: signed transaction hash to the one message it paid for.
fn payment_key(tx_hash: &Hash32) -> Vec<u8> {
    key(b'T', &[&tx_hash.0])
}
fn mailbox_prefix(kind: u8, address: Address) -> Vec<u8> {
    key(kind, &[&address.0])
}
/// A delivered message's place in a mailbox: `I` for the recipient's inbox, `O` for the
/// sender's own copies, ordered by delivery time.
fn mailbox_key(kind: u8, address: Address, time: i64, hash: &[u8; 32]) -> Vec<u8> {
    key(kind, &[&address.0, &time.to_be_bytes(), hash])
}
/// Per-mailbox notification policy key.
fn policy_key(address: Address) -> Vec<u8> {
    key(b'P', &[&address.0])
}
/// Where the last delivery time issued in `address`'s mailbox is kept.
fn last_delivery_key(address: Address) -> Vec<u8> {
    key(b'L', &[&address.0])
}
/// One recipient's used challenges, or every recipient's.
fn challenge_prefix(recipient: Option<Address>) -> Vec<u8> {
    match recipient {
        Some(recipient) => key(b'N', &[&recipient.0]),
        None => key(b'N', &[]),
    }
}
fn challenge_expiry(row: &[u8], value: &[u8]) -> Body<i64> {
    if row.len() != KEY_SPACE.len() + 1 + 20 + 32 + 32 {
        return Err(Stop::Refused(CanonicalError::Unavailable));
    }
    Ok(i64::from_be_bytes(
        value
            .try_into()
            .map_err(|_| Stop::Refused(CanonicalError::Unavailable))?,
    ))
}

/// The time to deliver the next message to and from `parties` at.
///
/// A reader asks for "everything after the last time I saw" in one mailbox, so a delivery
/// time must never be equal to or earlier than one already issued in that mailbox, or a
/// reader who has moved past it would never be given the message. The time is therefore the
/// clock or one millisecond after the last time issued in any party's mailbox, whichever is
/// later: two messages in the same millisecond, or a clock that steps back, still get
/// increasing times. The caller writes the result under each party's [`last_delivery_key`] in
/// the same transaction, which read those keys: two messages sharing a party conflict, and the
/// later commit takes a later time, so a mailbox never gains a message behind what a reader
/// has already read. Messages with no party in common share no key and never wait for each
/// other.
fn next_delivery_time(tx: &mut dyn KvTransaction, parties: &[Address], now: i64) -> Body<i64> {
    let mut last = -1i64;
    for party in parties {
        if let Some(raw) = tx.get(&last_delivery_key(*party))? {
            let time = i64::from_be_bytes(
                raw.as_slice()
                    .try_into()
                    .map_err(|_| Stop::Refused(CanonicalError::Unavailable))?,
            );
            last = last.max(time);
        }
    }
    Ok(now.max(
        last.checked_add(1)
            .ok_or(Stop::Refused(CanonicalError::Unavailable))?,
    ))
}

/// The payload hash a request is stored under.
fn request_hash(request: &ExactRequest) -> Result<[u8; 32]> {
    use frank_cbor::{relay_context, validate_frame, TypedPayload, ValidationResult};
    let ValidationResult::Parsed(frame) = validate_frame(request.delivery(), &relay_context())
        .map_err(|_| CanonicalError::Invalid)?
    else {
        return Err(CanonicalError::Invalid);
    };
    let Some(TypedPayload::DirectMessage { payload_digest, .. }) = frame.typed.as_deref() else {
        return Err(CanonicalError::Invalid);
    };
    payload_digest
        .as_slice()
        .try_into()
        .map_err(|_| CanonicalError::Invalid)
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

/// A stored message as its row holds it: the request inline, or a reference to its object.
#[derive(Debug, Clone)]
struct Row {
    body: Stored,
    content_type: String,
    policy: FrozenCanonicalPolicy,
    delivered_at: i64,
}

impl Row {
    /// Whether this row holds exactly `request`: the same content type and the same bytes (a
    /// large body is compared by its SHA-256 and length).
    fn holds(&self, request: &ExactRequest) -> bool {
        self.content_type == request.content_type()
            && match &self.body {
                Stored::Inline(bytes) => bytes.as_slice() == request.body(),
                Stored::Large(reference) => reference.matches(request.body()),
            }
    }

    /// The stored message, given the request this row [`holds`](Row::holds).
    fn with_request(self, request: ExactRequest) -> Claim {
        Claim {
            request,
            policy: self.policy,
            delivered_at: self.delivered_at,
        }
    }
}

fn encode_row(row: &Row) -> Result<Vec<u8>> {
    let p = &row.policy;
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
        (R::VERSION, int(ROW_VERSION)),
        (R::BODY, blob(row.body.encode())),
        (R::CONTENT_TYPE, CborValue::Text(row.content_type.clone())),
        (R::POLICY, policy),
        (R::DELIVERED_AT, int(row.delivered_at)),
    ]))
    .map_err(|_| CanonicalError::Unavailable)
}

#[cfg(test)]
thread_local! {
    /// Stored messages read on this thread, for tests of how much a read touches.
    pub(crate) static ROWS_READ: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Read one stored message's row. It was checked in full when it was admitted and has not
/// changed since, so reading it only decodes it: no signature or proof is verified again. A
/// large request's object is read afterwards, outside the transaction ([`Owner::resolve`]).
fn load(tx: &mut dyn KvTransaction, hash: &[u8; 32]) -> Body<Option<Row>> {
    let Some(raw) = tx.get(&row_key(hash))? else {
        return Ok(None);
    };
    #[cfg(test)]
    ROWS_READ.with(|count| count.set(count.get() + 1));
    Ok(Some(decode_row(&raw, hash)?))
}

fn decode_row(raw: &[u8], hash: &[u8; 32]) -> Result<Row> {
    let value = decode_canonical(raw).map_err(|_| CanonicalError::Unavailable)?;
    let CborValue::Map(rows) = &value else {
        return Err(CanonicalError::Unavailable);
    };
    let [(R::VERSION, version), (R::BODY, body), (R::CONTENT_TYPE, content_type), (R::POLICY, CborValue::Array(p)), (R::DELIVERED_AT, delivered_at)] =
        rows.as_slice()
    else {
        return Err(CanonicalError::Unavailable);
    };
    if number(version)? != ROW_VERSION || p.len() != 11 {
        return Err(CanonicalError::Unavailable);
    }
    let body = Stored::decode(bytes(body)?).ok_or(CanonicalError::Unavailable)?;
    // A request that fits inline is never stored as a reference, and the reverse.
    if (body.len() > INLINE_LIMIT as u64) != matches!(body, Stored::Large(_)) {
        return Err(CanonicalError::Unavailable);
    }
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
    Ok(Row {
        body,
        content_type: text(content_type)?.into(),
        policy,
        delivered_at: convert(delivered_at)?,
    })
}

#[cfg(test)]
impl Owner {
    /// The store beside `registry_db`, with large requests in the directory a single-node relay
    /// uses beside it ([`crate::registry::Registry::local_large_values_path`]).
    pub(crate) fn beside(registry_db: PathBuf) -> Self {
        let objects = Arc::new(crate::store::large_values::LocalFsObjectStore::new(
            crate::registry::Registry::local_large_values_path(&registry_db),
        ));
        Self::new(registry_db, objects)
    }
}

#[cfg(test)]
mod challenge_tests {
    use super::*;
    use rocksdb::{IteratorMode, Options};

    fn store() -> (tempdir::TempDir, Owner) {
        let dir = tempdir::TempDir::new("used-challenges").unwrap();
        let owner = Owner::beside(dir.path().join("db.rocksdb"));
        (dir, owner)
    }
    fn stored(dir: &tempdir::TempDir) -> usize {
        let path = dir.path().join("db.messages-v4");
        let db = rocksdb::DB::open_for_read_only(&Options::default(), path, false).unwrap();
        db.iterator(IteratorMode::Start)
            .filter(|row| row.as_ref().unwrap().0.starts_with(b"dm/N"))
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
    pub(super) fn paid_input() -> (CanonicalPaymentInput, [u8; 32]) {
        paid_input_sealing(None)
    }

    /// [`paid_input`] with its sealed crypto-box envelope replaced by `envelope` bytes when
    /// given, so the request is about that much larger. The relay never opens the envelope.
    pub(super) fn paid_input_sealing(envelope: Option<usize>) -> (CanonicalPaymentInput, [u8; 32]) {
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
            sender_p: sender
                .as_ref()
                .expect("the captured message names its sender")
                .key_bytes
                .clone(),
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
        let mut policy = policy;
        let resealed = envelope.map(|len| {
            use frank_cbor::message_fields::recipient_encrypted_payload_v2 as P;
            let CborValue::Map(mut sealed) = payload_frame.payload.clone() else {
                panic!("recipient payload map");
            };
            sealed
                .iter_mut()
                .find(|(k, _)| *k == P::CRYPTO_BOX_ENVELOPE)
                .unwrap()
                .1 = CborValue::Bytes((0..len).map(|i| (i % 251) as u8).collect());
            let frame = frank_cbor::encode_frame(
                frank_cbor::EnvelopeFields {
                    type_id: frank_cbor::message_types::TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
                    schema_version: 2,
                    min_reader_version: 2,
                },
                FramePayload::Value(&CborValue::Map(sealed)),
            )
            .unwrap();
            policy.payload_hash = frank_cbor::recipient_payload_digest(network, &frame).unwrap();
            frame
        });
        let (_, address) = crate::evm_dm_verify::canonical_stamp_destination(
            network,
            destination,
            shared_point,
            0,
        )
        .unwrap();
        let secret = bitcoinsuite_ecc_secp256k1::EccSecp256k1::default()
            .seckey_from_array([17; 32])
            .unwrap();
        let transaction = crate::evm_transaction::test_support::signed_eip1559_tx(
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
            (0, CborValue::Text(network.to_string())),
            (1, CborValue::Bytes(payment_hash.to_vec())),
            (2, CborValue::Bytes(amount.to_vec())),
            (3, CborValue::Bytes(address.to_vec())),
            (
                4,
                CborValue::Bytes(frank_cbor::payment_commitment(&policy.payload_hash, 0).to_vec()),
            ),
            (7, CborValue::Int(0)),
        ]);
        let CborValue::Map(mut outer) = frame.payload else {
            panic!("direct message map");
        };
        outer.iter_mut().find(|(k, _)| *k == 4).unwrap().1 = CborValue::Array(vec![member]);
        if let Some(frame) = resealed {
            outer.iter_mut().find(|(k, _)| *k == 2).unwrap().1 = CborValue::Bytes(frame);
            outer.iter_mut().find(|(k, _)| *k == 3).unwrap().1 =
                CborValue::Bytes(policy.payload_hash.to_vec());
        }
        let delivery = frank_cbor::encode_frame(
            frank_cbor::EnvelopeFields {
                type_id: frank_cbor::message_types::TYPE_DIRECT_MESSAGE_DELIVERY,
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

    // Independently spell the CBOR v3 row, including fixed-width minimum and the exact request
    // inline (cell tag 0x00 before the request bytes).
    // Do not use encode_row, load, or production key builders to generate expected storage bytes.
    fn persisted_row(message: &Claim) -> Vec<u8> {
        assert_eq!(message.delivered_at, 1234);
        assert_eq!(message.policy.network, "monad-testnet");
        assert_eq!(message.policy.chain_id, 10143);
        let mut bytes = vec![0xa5, 0x00, 0x03, 0x01, 0x59];
        bytes.extend_from_slice(
            &u16::try_from(message.request.body().len() + 1)
                .unwrap()
                .to_be_bytes(),
        );
        bytes.push(0x00);
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
    fn canonical_row_and_delivery_indexes_keep_exact_v3_bytes_across_reopen() {
        let dir = tempdir::TempDir::new("canonical-layout").unwrap();
        let registry_path = dir.path().join("registry.rocksdb");
        let path = registry_path.with_extension("messages-v4");
        let (input, payment_hash) = paid_input();
        let owner = Owner::beside(registry_path.clone());
        let claim = owner.claim(input, 1234).unwrap().claim;
        let (retry, _) = paid_input();
        assert_eq!(owner.claim(retry, 9999).unwrap().claim.delivered_at, 1234);
        let hash = claim.policy.payload_hash;
        let sender = claim.policy.sender().unwrap();
        let recipient = claim.policy.recipient().unwrap();
        assert_ne!(sender, recipient);
        let mut expected = vec![
            ([b"dm/R".as_slice(), &hash].concat(), persisted_row(&claim)),
            ([b"dm/T".as_slice(), &payment_hash].concat(), hash.to_vec()),
        ];
        // Each party's mailbox remembers the last time issued in it. There is no key every
        // message writes.
        for party in [recipient, sender] {
            expected.push((
                [b"dm/L".as_slice(), &party.0].concat(),
                1234i64.to_be_bytes().to_vec(),
            ));
        }
        for (kind, party) in [(b'I', recipient), (b'O', sender)] {
            let key = [
                b"dm/".as_slice(),
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
        let reopened = Owner::beside(registry_path);
        let stored = reopened.get(&hash).unwrap().unwrap();
        assert!(stored.request.exact_equal(&claim.request));
        assert_eq!(stored.policy, claim.policy);
        assert_eq!(stored.delivered_at, 1234);
        assert_eq!(reopened.inbox(recipient, 0, None, 10).unwrap().len(), 1);
        let sent = reopened.mailbox(sender, 0, None, 10).unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, MailboxDirection::Out);
        let (retry, _) = paid_input();
        assert_eq!(
            reopened.claim(retry, 9999).unwrap().claim.delivered_at,
            1234
        );
        drop(reopened);
        assert_eq!(raw_rows(&path), expected);
    }

    #[test]
    fn canonical_reads_are_lazy_and_open_failures_retry_without_reset() {
        let dir = tempdir::TempDir::new("canonical-open").unwrap();
        let registry_path = dir.path().join("registry.rocksdb");
        let path = registry_path.with_extension("messages-v4");
        let owner = Owner::beside(registry_path.clone());
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
            Owner::beside(registry_path)
                .get_notification_policy(address)
                .unwrap(),
            policy
        );
    }

    fn stored_nonce(recipient: Address, epoch: [u8; 32], nonce: [u8; 32]) -> Vec<u8> {
        [b"dm/N".as_slice(), &recipient.0, &epoch, &nonce].concat()
    }

    #[test]
    fn canonical_challenge_is_consumed_once_under_race_and_after_reopen() {
        let dir = tempdir::TempDir::new("canonical-nonce-race").unwrap();
        let registry_path = dir.path().join("registry.rocksdb");
        let path = registry_path.with_extension("messages-v4");
        let owner = Arc::new(Owner::beside(registry_path.clone()));
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
        let reopened = Owner::beside(registry_path);
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
            let path = registry_path.with_extension("messages-v4");
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
            let owner = Owner::beside(registry_path);
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
mod fence_tests {
    use super::*;
    use crate::store::kv_store::{Outcome, RocksDbKvStore};

    #[test]
    fn a_fence_stops_an_admission_that_has_not_committed_yet() {
        let store: Arc<dyn RelayKvStore> = Arc::new(RocksDbKvStore::open_temporary().unwrap());
        let owner = Owner::with_store(
            Arc::clone(&store),
            Arc::new(crate::store::large_values::LocalFsObjectStore::temporary()),
        );
        let recipient = Address([7; 20]);
        let hash = [9u8; 32];
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        std::thread::scope(|scope| {
            // An admission that has read the recipient's time and written its row, and whose
            // commit is still on its way when the fence runs.
            let late_store = Arc::clone(&store);
            let late = scope.spawn(move || {
                let mut attempts = 0;
                let outcome = late_store
                    .run_transaction(&mut |tx| {
                        attempts += 1;
                        if attempts > 1 {
                            return Outcome::Abort;
                        }
                        tx.get(&last_delivery_key(recipient)).unwrap();
                        tx.set(&row_key(&hash), &[0xa0]).unwrap();
                        ready_tx.send(()).unwrap();
                        go_rx.recv().unwrap();
                        Outcome::Commit
                    })
                    .unwrap();
                (outcome, attempts)
            });
            ready_rx.recv().unwrap();
            let fenced = owner
                .fence(&store, &hash, recipient, Instant::now())
                .unwrap();
            assert!(fenced.is_none(), "the row was not there when the fence ran");
            go_tx.send(()).unwrap();
            let (outcome, attempts) = late.join().unwrap();
            assert_eq!(attempts, 2, "the late commit conflicted with the fence");
            assert!(outcome == Outcome::Abort);
        });
        let row = store
            .transact(|tx| tx.get(&row_key(&hash)))
            .map_err(|_: KvError| "get")
            .unwrap();
        assert_eq!(row, None, "a fenced attempt never lands");
    }
}

#[cfg(test)]
mod large_request_tests {
    use super::persistence_tests::{paid_input, paid_input_sealing};
    use super::*;
    use crate::store::large_values::LocalFsObjectStore;
    use std::path::Path;

    /// Every message object under a single-node relay's large-value directory, as
    /// `<hex>/<upload>`.
    fn objects(registry: &Path) -> Vec<String> {
        let root = crate::registry::Registry::local_large_values_path(registry)
            .join(OBJECT_NAMESPACE)
            .join("sha256");
        let mut found = Vec::new();
        let Ok(digests) = std::fs::read_dir(root) else {
            return found;
        };
        for digest in digests {
            let digest = digest.unwrap();
            for upload in std::fs::read_dir(digest.path()).unwrap() {
                let name = upload.unwrap().file_name().into_string().unwrap();
                if !name.starts_with('.') {
                    found.push(format!(
                        "{}/{name}",
                        digest.file_name().into_string().unwrap()
                    ));
                }
            }
        }
        found.sort();
        found
    }

    fn stored_row(owner: &Owner, hash: &[u8; 32]) -> Option<Row> {
        owner.read(|| None, |tx| load(tx, hash)).unwrap()
    }

    /// The largest crypto-box envelope a relay admits (8 MiB of ciphertext and its envelope
    /// overhead).
    const LARGEST_ENVELOPE: usize = frank_cbor::MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES;

    #[test]
    fn a_request_over_the_inline_limit_is_an_object_its_row_references() {
        let dir = tempdir::TempDir::new("dm-large").unwrap();
        let registry = dir.path().join("registry.rocksdb");
        let owner = Owner::beside(registry.clone());
        let (input, _) = paid_input_sealing(Some(LARGEST_ENVELOPE));
        let body = input.request.body().to_vec();
        assert!(body.len() >= 8 * 1024 * 1024);
        eprintln!(
            "largest admissible direct-message request: {} bytes",
            body.len()
        );
        let hash = input.policy.payload_hash;
        let admitted = owner.claim(input, 1234).unwrap();
        assert!(admitted.new);
        // The row holds a reference to one object whose content is the request.
        let Some(Row {
            body: Stored::Large(reference),
            ..
        }) = stored_row(&owner, &hash)
        else {
            panic!("a large request is stored as a reference");
        };
        assert!(reference.matches(&body));
        let key = format!(
            "{}/{}",
            hex::encode(reference.digest),
            hex::encode(reference.upload)
        );
        assert_eq!(objects(&registry), vec![key.clone()]);
        let file = crate::registry::Registry::local_large_values_path(&registry)
            .join("messages/sha256")
            .join(&key);
        assert_eq!(std::fs::read(&file).unwrap(), body);
        // It reads back byte for byte, also after a restart, through every read path.
        drop(owner);
        let reopened = Owner::beside(registry.clone());
        assert_eq!(reopened.get(&hash).unwrap().unwrap().request.body(), body);
        let recipient = admitted.claim.policy.recipient().unwrap();
        let inbox = reopened.inbox(recipient, 0, None, 10).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].request.body(), body);
        // An exact repeat is answered from the row without reading or uploading the object.
        assert!(reopened
            .find_request(&admitted.claim.request)
            .unwrap()
            .is_some());
        // A repeat that reaches admission anyway uploads again; that upload is collected and
        // the stored one never is.
        let (repeat, _) = paid_input_sealing(Some(LARGEST_ENVELOPE));
        let repeated = reopened.claim(repeat, 9999).unwrap();
        assert!(!repeated.new);
        assert_eq!(repeated.claim.delivered_at, 1234);
        assert_eq!(objects(&registry).len(), 2);
        assert_eq!(reopened.sweep_large_values([1; 16]).unwrap().deleted, 1);
        assert_eq!(objects(&registry), vec![key]);
        assert_eq!(reopened.sweep_large_values([1; 16]).unwrap().deleted, 0);
        assert_eq!(reopened.get(&hash).unwrap().unwrap().request.body(), body);
    }

    #[test]
    fn a_request_one_byte_over_the_envelope_limit_is_not_a_valid_message() {
        let result = std::panic::catch_unwind(|| paid_input_sealing(Some(LARGEST_ENVELOPE + 1)));
        assert!(result.is_err(), "the codec refuses a larger envelope");
    }

    #[test]
    fn a_request_up_to_the_inline_limit_stays_in_its_row() {
        let dir = tempdir::TempDir::new("dm-inline").unwrap();
        let registry = dir.path().join("registry.rocksdb");
        let owner = Owner::beside(registry.clone());
        let (input, _) = paid_input();
        assert!(input.request.body().len() <= INLINE_LIMIT);
        let hash = input.policy.payload_hash;
        owner.claim(input, 1234).unwrap();
        assert!(matches!(
            stored_row(&owner, &hash),
            Some(Row {
                body: Stored::Inline(_),
                ..
            })
        ));
        assert!(objects(&registry).is_empty());
    }

    #[test]
    fn a_refused_large_request_stores_nothing_and_its_upload_is_swept() {
        let dir = tempdir::TempDir::new("dm-refused").unwrap();
        let registry = dir.path().join("registry.rocksdb");
        let owner = Owner::beside(registry.clone());
        // Both messages carry the same signed payment: it pays for the first only.
        let (first, payment) = paid_input();
        let (second, again) = paid_input_sealing(Some(200_000));
        assert_eq!(payment, again);
        let second_hash = second.policy.payload_hash;
        owner.claim(first, 1234).unwrap();
        assert_eq!(
            owner.claim(second, 1235).unwrap_err(),
            CanonicalError::Conflict
        );
        assert!(stored_row(&owner, &second_hash).is_none());
        assert_eq!(objects(&registry).len(), 1);
        assert_eq!(owner.sweep_large_values([1; 16]).unwrap().deleted, 1);
        assert!(objects(&registry).is_empty());
    }

    #[test]
    fn with_the_object_store_down_a_large_request_is_refused_and_nothing_is_stored() {
        let dir = tempdir::TempDir::new("dm-objects-down").unwrap();
        let registry = dir.path().join("registry.rocksdb");
        // A regular file where the object directory should be: every object write fails.
        let blocked = dir.path().join("objects");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let owner = Owner::new(
            registry.clone(),
            Arc::new(LocalFsObjectStore::new(&blocked)),
        );
        let (large, _) = paid_input_sealing(Some(200_000));
        let hash = large.policy.payload_hash;
        let recipient = large.policy.recipient().unwrap();
        assert_eq!(
            owner.claim(large, 1234).unwrap_err(),
            CanonicalError::Unavailable
        );
        assert!(stored_row(&owner, &hash).is_none());
        assert!(owner.inbox(recipient, 0, None, 10).unwrap().is_empty());
        // A message that fits inline does not need the object store.
        let (small, _) = paid_input();
        assert!(owner.claim(small, 1235).unwrap().new);
        assert_eq!(owner.inbox(recipient, 0, None, 10).unwrap().len(), 1);
    }

    #[test]
    fn a_tampered_object_is_refused_on_read() {
        let dir = tempdir::TempDir::new("dm-tampered").unwrap();
        let registry = dir.path().join("registry.rocksdb");
        let owner = Owner::beside(registry.clone());
        let (input, _) = paid_input_sealing(Some(100_000));
        let hash = input.policy.payload_hash;
        owner.claim(input, 1234).unwrap();
        let [key] = objects(&registry).try_into().unwrap();
        let file = crate::registry::Registry::local_large_values_path(&registry)
            .join("messages/sha256")
            .join(key);
        std::fs::write(&file, b"tampered").unwrap();
        assert_eq!(owner.get(&hash).unwrap_err(), CanonicalError::Unavailable);
    }

    /// A store whose planned transactions lose their answer: the backend reports an unknown
    /// commit outcome after committing (`Some(true)`) or after discarding the writes
    /// (`Some(false)`). `None`, or no plan left, answers normally.
    #[derive(Debug)]
    struct LostAnswers {
        inner: RocksDbKvStore,
        plan: Mutex<std::collections::VecDeque<Option<bool>>>,
    }

    impl RelayKvStore for LostAnswers {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(&mut dyn KvTransaction) -> crate::store::kv_store::Outcome,
        ) -> std::result::Result<crate::store::kv_store::Outcome, KvError> {
            use crate::store::kv_store::Outcome;
            match self.plan.lock().unwrap().pop_front().flatten() {
                None => self.inner.run_transaction(body),
                Some(committed) => {
                    self.inner.run_transaction(&mut |tx| {
                        let outcome = body(tx);
                        if committed {
                            outcome
                        } else {
                            Outcome::Abort
                        }
                    })?;
                    Err(KvError::CommitUnknownResult("answer lost".into()))
                }
            }
        }
    }

    #[test]
    fn a_large_request_whose_commit_answer_was_lost_is_stored_once_with_its_object() {
        for committed in [true, false] {
            let store = Arc::new(LostAnswers {
                inner: RocksDbKvStore::open_temporary().unwrap(),
                plan: Mutex::new(Default::default()),
            });
            let objects = Arc::new(LocalFsObjectStore::temporary());
            let root = objects.root().join(OBJECT_NAMESPACE);
            let owner = Owner::with_store(store.clone(), objects);
            // Claims the object namespace, so the admission's transactions are the planned ones.
            owner.sweep_large_values([1; 16]).unwrap();
            let (input, _) = paid_input_sealing(Some(200_000));
            let body = input.request.body().to_vec();
            let hash = input.policy.payload_hash;
            // The upload intent answers; the admission loses its answer.
            *store.plan.lock().unwrap() = [None, Some(committed)].into_iter().collect();
            let admitted = owner.claim(input, 1234).unwrap();
            assert!(admitted.new, "committed: {committed}");
            assert!(store.plan.lock().unwrap().is_empty());
            let Some(Row {
                body: Stored::Large(reference),
                ..
            }) = stored_row(&owner, &hash)
            else {
                panic!("one row referencing the request");
            };
            // The stored row references this call's only upload, and the sweep keeps it.
            let uploads: Vec<_> =
                std::fs::read_dir(root.join("sha256").join(hex::encode(reference.digest)))
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .filter(|name| !name.starts_with('.'))
                    .collect();
            assert_eq!(uploads, vec![hex::encode(reference.upload)]);
            assert_eq!(owner.sweep_large_values([1; 16]).unwrap().deleted, 0);
            assert_eq!(owner.get(&hash).unwrap().unwrap().request.body(), body);
        }
    }

    #[test]
    fn replicas_on_one_store_read_each_others_large_requests() {
        let shared: Arc<dyn RelayKvStore> = Arc::new(RocksDbKvStore::open_temporary().unwrap());
        let objects: Arc<dyn ObjectStore> = Arc::new(LocalFsObjectStore::temporary());
        let a = Owner::with_store(Arc::clone(&shared), Arc::clone(&objects));
        let b = Owner::with_store(Arc::clone(&shared), Arc::clone(&objects));
        let (input, _) = paid_input_sealing(Some(LARGEST_ENVELOPE));
        let body = input.request.body().to_vec();
        let hash = input.policy.payload_hash;
        a.claim(input, 1234).unwrap();
        assert_eq!(b.get(&hash).unwrap().unwrap().request.body(), body);
        // Either replica's sweep keeps the referenced object.
        assert_eq!(b.sweep_large_values([2; 16]).unwrap().deleted, 0);
        assert_eq!(a.get(&hash).unwrap().unwrap().request.body(), body);
    }
}

#[cfg(test)]
mod storage_boundary_tests {
    #[test]
    fn canonical_facade_does_not_depend_on_native_storage_types() {
        let source = include_str!("evm_direct_messages.rs");
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
