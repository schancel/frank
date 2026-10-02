//! Module containing [`Registry`].

use std::sync::Arc;

#[cfg(test)]
use std::cell::Cell;

use bitcoinsuite_core::{ecc::Ecc, lotus_txid, Bytes, Hashed, LotusAddress, Net, Sha256d};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::{ErrorMeta, Result};
use cashweb_payload::{
    chain_adapter::{ChainAdapter, SubmitTxOutcome},
    payload::{BurnTx, SignedPayload},
    verify::{ADDRESS_METADATA_LOKAD_ID, BROADCAST_MESSAGE_LOKAD_ID},
};
use prost::Message;
use thiserror::Error;

use crate::{
    monad_http::Address,
    monad_profile_verify::{
        validate_cbor_account_registration_envelope, verify_cbor_account_registration,
        verify_monad_profile, VerifiedCborRegistration,
    },
    proto::{self, BroadcastMessage},
    store::{db::Db, monad_profiles::DbMonadProfilesError, pubkeyhash::PubKeyHash},
};

#[cfg(test)]
thread_local! {
    static RECIPIENT_SIGNATURE_WORK: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
#[derive(Debug)]
struct TestProfileWorkerGate {
    released: std::sync::Mutex<bool>,
    wake: std::sync::Condvar,
    started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[cfg(test)]
impl TestProfileWorkerGate {
    fn new() -> (Arc<Self>, tokio::sync::oneshot::Receiver<()>) {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        (
            Arc::new(Self {
                released: std::sync::Mutex::new(false),
                wake: std::sync::Condvar::new(),
                started: std::sync::Mutex::new(Some(started_tx)),
            }),
            started_rx,
        )
    }

    fn wait(&self) {
        if let Some(started) = self.started.lock().unwrap().take() {
            let _ = started.send(());
        }
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.wake.wait(released).unwrap();
        }
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}

#[cfg(test)]
pub(crate) fn reset_recipient_signature_work() {
    RECIPIENT_SIGNATURE_WORK.set(0);
}

#[cfg(test)]
pub(crate) fn recipient_signature_work() -> usize {
    RECIPIENT_SIGNATURE_WORK.get()
}

/// Cashweb [`Registry`] stores [`SignedPayload`]s containing [`proto::AddressMetadata`] for
/// addresses.
///
/// Raw mailbox stores are intentionally inaccessible outside this crate; inbox publication must
/// pass through the validated atomic outbox finalizer.
///
/// ```compile_fail
/// # let db: cashweb_registry::store::db::Db = todo!();
/// let _ = db.monad_messages();
/// ```
///
/// ```compile_fail
/// # let db: cashweb_registry::store::db::Db = todo!();
/// let _ = db.monad_outbox();
/// ```
///
/// ```compile_fail
/// use cashweb_registry::registry::Registry;
/// let _ = Registry::claim_monad_outbox;
/// ```
///
/// ```compile_fail
/// use cashweb_registry::{
///     monad_http::Address,
///     store::monad_outbox::MonadOutboxPolicy,
/// };
/// let _ = MonadOutboxPolicy {
///     recipient: Address([0; 20]),
///     recipient_pubkey: vec![2; 33],
///     min_value_wei: 1,
///     network_tag: b"testnet".to_vec(),
/// };
/// ```
#[derive(Debug)]
pub struct Registry {
    /// Database storing the address metadata in RocksDB.
    db: Db,
    /// Ecc for verifying secp256k1 signatures.
    ecc: EccSecp256k1,
    /// Chain boundary used for testing and broadcasting burn txs. Lotus-backed today (see
    /// [`crate::lotus_adapter::LotusAdapter`]), but abstracted behind [`ChainAdapter`] so a
    /// different chain can be substituted without touching this struct.
    chain_adapter: Arc<dyn ChainAdapter>,
    /// Whether server is running on a mainnet or regtest network.
    net: Net,
    /// Bounded striped async coordination for profile mutations. Requests for different stripes
    /// wait independently, and owned guards can move into the blocking RocksDB worker.
    profile_write_locks: Vec<Arc<tokio::sync::Mutex<()>>>,
    /// Global no-queue admission bound for CPU/RocksDB profile registration work.
    profile_registration_admission: Arc<tokio::sync::Semaphore>,
    /// Independent no-queue bound for stored candidate reads and signature validation.
    profile_read_validation_admission: Arc<tokio::sync::Semaphore>,
    #[cfg(test)]
    profile_worker_gate: Option<Arc<TestProfileWorkerGate>>,
    #[cfg(test)]
    profile_read_worker_gate: Option<Arc<TestProfileWorkerGate>>,
}

/// Result of putting metadata into the registry.
#[derive(Debug, Clone, PartialEq)]
pub struct PutMetadataResult {
    /// Transaction IDs of the burn txs for this payload.
    pub txids: Vec<Sha256d>,
    /// Which action happened with the blockchain.
    pub blockchain_action: PutBlockchainAction,
    /// Parsed signed payload.
    pub signed_metadata: SignedPayload<proto::AddressMetadata>,
}

/// Result of fetching a range of metadata by timestamp.
#[derive(Debug, Clone, PartialEq)]
pub struct GetMetadataRangeResult {
    /// Pairs of pubkey hashes and associated payload, ordered by timestamp.
    pub entries: Vec<(LotusAddress, SignedPayload<proto::AddressMetadata>)>,
}

/// Which action happened with the blockchain when putting address metadata.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PutBlockchainAction {
    /// Signed payload hash was already the current one in the database.
    /// Burn transactions were not validated.
    AlreadyKnowPayloadHash,
    /// Signed payload new, but txs already seen on the blockchain.
    /// Tx broadcast is skipped, but malleation is checked.
    AlreadyKnowTx,
    /// Txs not seen on the network yet, but between testmempoolaccept and sendrawtransaction,
    /// a block was found, which would make sendrawtransaction fail.
    BroadcastRaceCondition,
    /// Txs not seen on the network yet, and we were able to broadcast them successfully.
    Broadcast,
}

/// Result of putting a topic message into the registry.
#[derive(Debug, Clone, PartialEq)]
pub struct PutMessageResult {
    /// Transaction IDs of the burn txs for this payload.
    pub txids: Vec<Sha256d>,
    /// Which action happened with the blockchain.
    pub blockchain_action: PutBlockchainAction,
    /// Parsed signed payload.
    pub signed_message: SignedPayload<proto::BroadcastMessage>,
}

#[derive(Debug, PartialEq, Eq)]
enum BurnTxValidation {
    Known,
    NotYetBroadcast,
}

/// Errors indicating some registry error.
#[derive(Debug, Error, ErrorMeta, Eq, PartialEq)]
pub enum RegistryError {
    /// Hash of `pubkey` of [`SignedPayload`] doesn't match provided [`PubKeyHash`].
    #[invalid_client_input()]
    #[error(
        "Hash of public key of SignedPayload doesn't match provided public key hash \
         Expected {expected:?}, but got {actual:?}"
    )]
    PubKeyHashMismatch {
        /// Expected pubkey hash of the address.
        expected: PubKeyHash,
        /// Actual hash of the provided pubkey.
        actual: PubKeyHash,
    },

    /// Timestamps in the address payload must increase monotonically.
    /// Otherwise, attackers could re-submit old SignedPayloads and make them go back in time.
    #[invalid_user_input()]
    #[error("Payload timestamp is not monotonically increasing: {previous} >= {next}")]
    TimestampNotMonotonicallyIncreasing {
        /// Current payload timestamp as recorded in the database.
        previous: i64,
        /// Timestamp of the new payload.
        next: i64,
    },

    /// Ticket #45: same invariant as [`RegistryError::TimestampNotMonotonicallyIncreasing`], for
    /// Monad-native profile registrations (`Registry::put_monad_profile`) rather than Lotus
    /// [`SignedPayload`] metadata.
    #[invalid_user_input()]
    #[error("Monad profile timestamp is not monotonically increasing: {previous} >= {next}")]
    MonadProfileTimestampNotMonotonicallyIncreasing {
        /// Current profile timestamp as recorded in the database.
        previous: i64,
        /// Timestamp of the new profile.
        next: i64,
    },

    /// Bitcoind rejected the provided burn tx.
    #[invalid_user_input()]
    #[error("Bitcoind rejected tx: {0}")]
    BitcoindRejectedTx(String),

    /// Tx malleated.
    #[invalid_user_input()]
    #[error("Malleated tx, expected {expected}, but got {actual}")]
    TxMalleated {
        /// Tx hex as seen by this registry
        expected: String,
        /// Malleated tx hex with different input signatures.
        actual: String,
    },

    /// Payload missing in DB.
    #[invalid_user_input()]
    #[error("Missing payload in existing metadata record (internal error)")]
    ExistingPayloadMissing,

    /// Payload missing in DB.
    #[invalid_user_input()]
    #[error("Missing payload in metadata record")]
    PayloadMissing,

    /// Value provided for topic is invalid.
    #[invalid_user_input()]
    #[error("Value provided for topic is invalid")]
    InvalidTopicFormat,

    /// A profile verification/storage worker failed before returning its typed result.
    #[critical()]
    #[error("Monad profile blocking worker failed: {0}")]
    MonadProfileWorkerFailed(String),
}

use self::RegistryError::*;

const PROFILE_WRITE_STRIPES: usize = 64;
/// Maximum profile registrations concurrently admitted to verification/storage.
pub const PROFILE_REGISTRATION_CONCURRENCY: usize = 32;
/// Maximum concurrent stored-CBOR reads and full signature validations. This independent pool
/// prevents an opt-in GET flood from consuming profile-registration capacity.
pub const PROFILE_READ_VALIDATION_CONCURRENCY: usize = 16;

/// A no-wait profile registration could not enter its address stripe or the global worker pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileRegistrationAdmissionError {
    /// Another registration already owns this address stripe.
    StripeBusy,
    /// All global verification/storage worker slots are occupied.
    GlobalBusy,
}

/// Owns both admission layers for one registration. Both guards deliberately move into blocking
/// workers, so dropping/cancelling the request future cannot release capacity while detached work
/// is still running.
#[derive(Debug)]
pub struct ProfileRegistrationAdmission {
    _stripe: tokio::sync::OwnedMutexGuard<()>,
    _global: tokio::sync::OwnedSemaphorePermit,
}

/// Owns one no-wait stored-CBOR read-validation slot. It moves into the blocking worker so
/// cancelling the request cannot release capacity while detached work is still running.
#[derive(Debug)]
pub struct ProfileReadValidationAdmission {
    _permit: tokio::sync::OwnedSemaphorePermit,
}

fn profile_write_locks() -> Vec<Arc<tokio::sync::Mutex<()>>> {
    (0..PROFILE_WRITE_STRIPES)
        .map(|_| Arc::new(tokio::sync::Mutex::new(())))
        .collect()
}

async fn spawn_profile_worker<T, F>(
    admission: ProfileRegistrationAdmission,
    work: F,
) -> Result<(T, ProfileRegistrationAdmission)>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let (result, admission) = tokio::task::spawn_blocking(move || (work(), admission))
        .await
        .map_err(|err| MonadProfileWorkerFailed(err.to_string()))?;
    Ok((result?, admission))
}

impl Registry {
    /// Construct new [`Registry`]
    pub fn new(db: Db, chain_adapter: Arc<dyn ChainAdapter>, net: Net) -> Self {
        Registry {
            db,
            ecc: EccSecp256k1::default(),
            chain_adapter,
            net,
            profile_write_locks: profile_write_locks(),
            profile_registration_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_REGISTRATION_CONCURRENCY,
            )),
            profile_read_validation_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_READ_VALIDATION_CONCURRENCY,
            )),
            #[cfg(test)]
            profile_worker_gate: None,
            #[cfg(test)]
            profile_read_worker_gate: None,
        }
    }

    async fn run_profile_worker<T, F>(
        &self,
        admission: ProfileRegistrationAdmission,
        work: F,
    ) -> Result<(T, ProfileRegistrationAdmission)>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        #[cfg(test)]
        let gate = self.profile_worker_gate.clone();
        spawn_profile_worker(admission, move || {
            #[cfg(test)]
            if let Some(gate) = gate {
                gate.wait();
            }
            work()
        })
        .await
    }

    /// Read a signed [`proto::AddressMetadata`] entry from the database.
    /// [`None`] if no such entry exists.
    pub fn get_metadata(
        &self,
        address: &LotusAddress,
    ) -> Result<Option<SignedPayload<proto::AddressMetadata>>> {
        let pkh = PubKeyHash::from_address(address, self.net)?;
        self.get_metadata_pkh(&pkh)
    }

    fn get_metadata_pkh(
        &self,
        pkh: &PubKeyHash,
    ) -> Result<Option<SignedPayload<proto::AddressMetadata>>> {
        let signed_payload = match self.db.metadata().get(pkh)? {
            Some(signed_payload) => signed_payload,
            None => return Ok(None),
        };
        Ok(Some(signed_payload))
    }

    /// Fully verify and write a [`cashweb_payload::proto::SignedPayload`](SignedPayload) into the
    /// database.
    pub async fn put_metadata(
        &self,
        address: &LotusAddress,
        signed_metadata: &cashweb_payload::proto::SignedPayload,
    ) -> Result<PutMetadataResult> {
        let pkh = PubKeyHash::from_address(address, self.net)?;

        // Decode SignedPayload
        let signed_metadata =
            SignedPayload::<proto::AddressMetadata>::parse_proto(signed_metadata)?;

        let new_payload = signed_metadata.payload().as_ref().ok_or(PayloadMissing)?;

        // Check pubkey hash
        let actual_pkh = pkh.algorithm().hash_pubkey(*signed_metadata.pubkey());
        if pkh != actual_pkh {
            return Err(PubKeyHashMismatch {
                expected: pkh.clone(),
                actual: actual_pkh,
            }
            .into());
        }

        // Verify burn amount and signatures check out
        signed_metadata.verify(&self.ecc, ADDRESS_METADATA_LOKAD_ID)?;

        if let Some(existing_metadata) = self.get_metadata_pkh(&pkh)? {
            let existing_payload = existing_metadata
                .payload()
                .as_ref()
                .ok_or(ExistingPayloadMissing)?;
            // If existing payload hash is the same as the new payload hash,
            // we don't need to verify anything.
            if signed_metadata.payload_hash() == existing_metadata.payload_hash() {
                return Ok(PutMetadataResult {
                    txids: signed_metadata
                        .txs()
                        .iter()
                        .map(|tx| lotus_txid(tx.tx().unhashed_tx()))
                        .collect(),
                    blockchain_action: PutBlockchainAction::AlreadyKnowPayloadHash,
                    signed_metadata,
                });
            }
            // Timestamp needs to be ascending.
            if existing_payload.timestamp >= new_payload.timestamp {
                return Err(TimestampNotMonotonicallyIncreasing {
                    previous: existing_payload.timestamp,
                    next: new_payload.timestamp,
                }
                .into());
            }
        }

        let (txids, blockchain_action) = self.validate_burn_txs(signed_metadata.txs()).await?;

        // Write new metadata into the database
        self.db.metadata().put(&pkh, &signed_metadata)?;
        Ok(PutMetadataResult {
            txids,
            blockchain_action,
            signed_metadata,
        })
    }

    async fn validate_burn_txs(
        &self,
        burn_txs: &[BurnTx],
    ) -> Result<(Vec<Sha256d>, PutBlockchainAction)> {
        // Verify txs are valid on the network
        let mut validations = Vec::with_capacity(burn_txs.len());
        for burn_tx in burn_txs {
            validations.push(self.validate_burn_tx(burn_tx).await?);
        }

        // Broadcast txs onto the network
        let mut txids = Vec::with_capacity(burn_txs.len());
        let mut blockchain_action = PutBlockchainAction::Broadcast;
        for (burn_tx, validation) in burn_txs.iter().zip(validations) {
            if validation == BurnTxValidation::Known {
                txids.push(lotus_txid(burn_tx.tx().unhashed_tx()));
                if blockchain_action == PutBlockchainAction::Broadcast {
                    blockchain_action = PutBlockchainAction::AlreadyKnowTx;
                }
                continue;
            }
            // sendrawtransaction can fail if a block was found since the testmempoolaccept
            // check. We handle this gracefully via `SubmitTxOutcome::AlreadyConfirmed`.
            match self.chain_adapter.submit_tx(burn_tx.tx().raw()).await? {
                SubmitTxOutcome::Broadcast(txid) => {
                    txids.push(txid);
                }
                SubmitTxOutcome::AlreadyConfirmed => {
                    txids.push(lotus_txid(burn_tx.tx().unhashed_tx()));
                    blockchain_action = PutBlockchainAction::BroadcastRaceCondition;
                }
            }
        }

        Ok((txids, blockchain_action))
    }

    async fn validate_burn_tx(&self, burn_tx: &BurnTx) -> Result<BurnTxValidation> {
        let txid = lotus_txid(burn_tx.tx().unhashed_tx());
        match self.chain_adapter.get_tx(&txid).await? {
            // Found txid
            Some(tx_raw) => {
                if tx_raw != burn_tx.tx().raw().as_ref() {
                    return Err(TxMalleated {
                        expected: hex::encode(&tx_raw),
                        actual: burn_tx.tx().raw().hex(),
                    }
                    .into());
                }
                Ok(BurnTxValidation::Known)
            }
            // Txid not found
            None => {
                // Test tx mempool acceptance
                if let Err(msg) = self.chain_adapter.test_accept(burn_tx.tx().raw()).await? {
                    return Err(RegistryError::BitcoindRejectedTx(msg).into());
                }
                Ok(BurnTxValidation::NotYetBroadcast)
            }
        }
    }

    /// Get all metadata entries in the given range.
    pub fn get_metadata_range(
        &self,
        start_timestamp: i64,
        end_timestamp: Option<i64>,
        last_address: Option<&LotusAddress>,
        max_num_items: usize,
    ) -> Result<GetMetadataRangeResult> {
        let mut entries = Vec::new();
        let last_pkh = last_address
            .map(|addr| PubKeyHash::from_address(addr, self.net))
            .transpose()?;
        for time_pkh in self.db.metadata().iter_by_time(start_timestamp) {
            if entries.len() == max_num_items {
                break;
            }
            let time_pkh = time_pkh?;
            if let Some(end_timestamp) = end_timestamp {
                if time_pkh.timestamp >= end_timestamp {
                    break;
                }
            }
            if let Some(last_pkh) = &last_pkh {
                // Skip pkhs that we already know for the start timestamp
                if time_pkh.timestamp == start_timestamp
                    && time_pkh.pkh.to_storage_bytes() <= last_pkh.to_storage_bytes()
                {
                    continue;
                }
            }
            let metadata = match self.db.metadata().get(&time_pkh.pkh)? {
                Some(metadata) => metadata,
                None => continue, // ignore stale metadata (should be impossible but doesn't matter)
            };
            let payload = metadata.payload().as_ref();
            if payload.is_some() && payload.unwrap().timestamp != time_pkh.timestamp {
                continue; // ignore stale metadata
            }
            entries.push((time_pkh.pkh.to_address(self.net), metadata));
        }
        Ok(GetMetadataRangeResult { entries })
    }

    pub(crate) fn get_latest_metadata(&self) -> Result<Option<(i64, LotusAddress)>> {
        match self.db.metadata().get_latest()? {
            Some(time_pkh) => {
                let address = time_pkh.pkh.to_address(self.net);
                Ok(Some((time_pkh.timestamp, address)))
            }
            None => Ok(None),
        }
    }

    pub(crate) fn get_messages(
        &self,
        topic: &str,
        from: i64,
        to: i64,
    ) -> Result<Vec<cashweb_payload::payload::SignedPayload<BroadcastMessage>>> {
        Ok(self.db.topics().get_messages_to(topic, from, to)?)
    }

    pub(crate) fn get_message(
        &self,
        payload_hash: Vec<u8>,
    ) -> Result<cashweb_payload::payload::SignedPayload<BroadcastMessage>> {
        Ok(self.db.topics().get_message(&payload_hash)?)
    }

    pub(crate) async fn put_message(
        &self,
        signed_message: &cashweb_payload::proto::SignedPayload,
    ) -> Result<PutMessageResult> {
        // Time now
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        // Decode SignedPayload
        let signed_message = SignedPayload::<proto::BroadcastMessage>::parse_proto(signed_message)?;

        // Verify burn amount and signatures check out
        signed_message.verify(&self.ecc, BROADCAST_MESSAGE_LOKAD_ID)?;

        if let Some(signed_payload) = signed_message.payload() {
            // In the case where the payload must be specified, we want to validate a
            // few items. In the case where this is simply a vote, ignore the checks.
            let topic = &signed_payload.topic;
            let valid_topic = topic
                .chars()
                .all(|c| c.is_lowercase() || c.is_numeric() || c == '.' || c == '-');
            if !valid_topic {
                return Err(InvalidTopicFormat.into());
            }

            let split_topic = topic.split('.').collect::<Vec<&str>>();
            if split_topic.len() > 10 {
                return Err(InvalidTopicFormat.into());
            }

            let invalid_segments = split_topic.iter().any(|segment| segment.is_empty());
            if invalid_segments {
                return Err(InvalidTopicFormat.into());
            }
        }

        let payload_hash = signed_message.payload_hash().as_slice();
        let (txids, blockchain_action) = self.validate_burn_txs(signed_message.txs()).await?;

        let topics_db = self.db.topics();
        if signed_message.payload().is_none() && !topics_db.does_message_exist(payload_hash) {
            return Err(PayloadMissing.into());
        }

        self.db.topics().put_message(timestamp, &signed_message)?;

        Ok(PutMessageResult {
            txids,
            blockchain_action,
            signed_message,
        })
    }

    pub(crate) fn net(&self) -> Net {
        self.net
    }

    /// Store a [`proto::StoredMonadMessage`] (ticket #27), once its Monad stamp has already
    /// verified (see `crate::http::monad_message`). Unlike [`Registry::put_message`]'s Lotus path,
    /// this doesn't call into `validate_burn_txs`/`chain_adapter` at all -- broadcasting and
    /// verifying a Monad stamp is `monad_stamp_relay::broadcast_and_verify_stamp`'s job, which
    /// operates over a [`crate::monad_http::JsonRpcTransport`] rather than the (Lotus-shaped)
    /// [`ChainAdapter`] this `Registry` is generic over, so it's called by the HTTP layer directly
    /// rather than from here (see that module's docs for why).
    ///
    /// Stamps `network_tag` (ticket #39, see `crate::network_tag`'s module docs for the full
    /// rationale) onto `message` here, at the single point every stored Monad message passes
    /// through, rather than trusting each caller to have already set the field correctly --
    /// returns the tagged record actually persisted, so the caller's own response (or further use
    /// of the value) reflects exactly what's now in the database.
    #[cfg(test)]
    pub(crate) fn put_monad_message(
        &self,
        payload_hash: &[u8],
        recipient: Address,
        message: proto::StoredMonadMessage,
        network_tag: &[u8],
    ) -> Result<proto::StoredMonadMessage> {
        let message = proto::StoredMonadMessage {
            network_tag: network_tag.to_vec(),
            ..message
        };
        self.db
            .monad_messages()
            .put(payload_hash, &recipient, &message)?;
        Ok(message)
    }

    /// Retrieve a previously-stored [`proto::StoredMonadMessage`] by its `payload_hash`.
    pub(crate) fn get_monad_message(
        &self,
        payload_hash: &[u8],
    ) -> Result<Option<proto::StoredMonadMessage>> {
        self.db.monad_messages().get(payload_hash)
    }

    /// Reserve a payload hash for one exact signed payment set before broadcasting any member.
    #[cfg(test)]
    pub(crate) fn claim_monad_message_attempt(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
        policy: &crate::store::monad_messages::MonadMessageAttemptPolicy,
    ) -> Result<crate::store::monad_messages::MonadMessageAttemptClaim> {
        self.db
            .monad_messages()
            .claim_attempt(payload_hash, message, policy)
    }

    #[cfg(test)]
    pub(crate) fn get_monad_message_attempt(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
    ) -> Result<crate::store::monad_messages::MonadMessageAttemptClaim> {
        self.db.monad_messages().get_attempt(payload_hash, message)
    }

    /// Atomically claim one canonical Monad payment request and all hash-only child references.
    /// This is the durable replacement seam for legacy digest-only attempts. Production keeps
    /// only read access to those rows so an exact request can atomically adopt matching evidence;
    /// legacy claim/delete mutators above are test-only.
    pub(crate) fn claim_monad_outbox(
        &self,
        message: &proto::MonadStampedMessage,
        policy: &crate::store::monad_outbox::MonadOutboxPolicy,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxClaim> {
        self.db
            .monad_outbox()
            .claim(&message.payload_hash, message, policy, now_ms, limits)
    }

    /// Coherently classify all durable owner forms for one candidate request.
    pub(crate) fn classify_monad_message_ownership(
        &self,
        message: &proto::MonadStampedMessage,
    ) -> Result<crate::store::monad_outbox::MonadMessageOwnership> {
        self.db
            .monad_outbox()
            .classify_ownership(&message.payload_hash, message)
    }

    #[cfg(test)]
    /// Read one canonical outbox record.
    pub(crate) fn monad_outbox_record(
        &self,
        payload_hash: &[u8],
    ) -> Result<Option<crate::store::monad_outbox::MonadOutboxRecord>> {
        self.db.monad_outbox().get(payload_hash)
    }

    #[cfg(test)]
    pub(crate) fn replace_monad_outbox_canonical_for_test(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
    ) -> Result<()> {
        self.db
            .monad_outbox()
            .replace_canonical_for_test(payload_hash, message)
    }

    #[cfg(test)]
    pub(crate) fn replace_monad_outbox_lifecycle_for_test(
        &self,
        payload_hash: &[u8],
        lifecycle: crate::store::monad_outbox::MonadOutboxLifecycle,
    ) -> Result<()> {
        self.db
            .monad_outbox()
            .replace_lifecycle_for_test(payload_hash, lifecycle)
    }

    #[cfg(test)]
    pub(crate) fn replace_monad_outbox_minimum_for_test(
        &self,
        payload_hash: &[u8],
        min_value_wei: u128,
    ) -> Result<()> {
        self.db
            .monad_outbox()
            .replace_minimum_for_test(payload_hash, min_value_wei)
    }

    #[cfg(test)]
    pub(crate) fn replace_monad_outbox_recipient_for_test(
        &self,
        payload_hash: &[u8],
        recipient: Address,
    ) -> Result<()> {
        self.db
            .monad_outbox()
            .replace_recipient_for_test(payload_hash, recipient)
    }

    /// Read one exact child state after a conditional transition loses its lease race.
    pub(crate) fn monad_outbox_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
    ) -> Result<Option<crate::store::monad_outbox::MonadOutboxMember>> {
        self.db.monad_outbox().get_member(payload_hash, child_index)
    }

    /// Load one immutable canonical/member snapshot for a complete reconciliation pass.
    pub(crate) fn monad_outbox_reconciliation_snapshot(
        &self,
        payload_hash: &[u8],
    ) -> Result<Option<crate::store::monad_outbox::MonadOutboxSnapshot>> {
        self.db.monad_outbox().reconciliation_snapshot(payload_hash)
    }

    /// Enumerate the bounded set of claims which need startup reconciliation.
    pub(crate) fn list_active_monad_outboxes_after(
        &self,
        after: Option<[u8; 32]>,
        limit: usize,
    ) -> Result<Vec<[u8; 32]>> {
        self.db.monad_outbox().list_active_after(after, limit)
    }

    /// Validate one bounded page of durable chain authority before startup mutation.
    pub(crate) fn bind_monad_outbox_chain_page(
        &self,
        expected_chain_id: u64,
        max_rows: usize,
        max_bytes: usize,
    ) -> Result<crate::store::monad_outbox::ChainBindingProgress> {
        self.db
            .monad_outbox()
            .bind_chain_page(expected_chain_id, max_rows, max_bytes)
    }

    /// Supersede one bounded page of durable leases left by the prior process.
    pub(crate) fn supersede_monad_outbox_startup_leases_page(
        &self,
        now_ms: i64,
        max_claims: usize,
        max_bytes: usize,
    ) -> Result<crate::store::monad_outbox::StartupLeasePage> {
        self.db
            .monad_outbox()
            .supersede_startup_leases_page(now_ms, max_claims, max_bytes)
    }

    /// Enforce configured compact-history bounds independently of new claim transitions.
    pub(crate) fn gc_monad_outbox_history(
        &self,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<()> {
        self.db.monad_outbox().gc_history(now_ms, limits)?;
        self.db
            .monad_outbox()
            .expire_unconfirmed_recovery(now_ms, limits)?;
        Ok(())
    }

    /// Terminal outcome of a claim, if it has one (one record read, no member decoding).
    pub(crate) fn monad_outbox_terminal(
        &self,
        payload_hash: &[u8],
    ) -> Result<Option<crate::store::monad_outbox::MonadOutboxTerminal>> {
        Ok(self
            .db
            .monad_outbox()
            .get(payload_hash)?
            .and_then(|record| match record.lifecycle {
                crate::store::monad_outbox::MonadOutboxLifecycle::Terminal(terminal) => {
                    Some(terminal)
                }
                _ => None,
            }))
    }

    /// Push out replay timing for a claim whose reconciliation hit the per-claim deadline.
    pub(crate) fn backoff_monad_outbox_after_cancelled_reconcile(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
    ) -> Result<()> {
        self.db
            .monad_outbox()
            .backoff_after_cancelled_reconcile(payload_hash, now_ms)
    }

    /// Acquire one durable replay generation after exact-hash absence was observed.
    pub(crate) fn acquire_monad_outbox_reconcile_lease(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxLeaseAcquire> {
        self.db
            .monad_outbox()
            .acquire_reconcile_lease(payload_hash, child_index, now_ms, limits)
    }

    /// Charge replay age/attempt budgets after the leased exact lookup resolved missing.
    pub(crate) fn begin_monad_outbox_replay_attempt(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: crate::store::monad_outbox::MonadOutboxLease,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxReplayStart> {
        self.db.monad_outbox().begin_replay_attempt(
            payload_hash,
            child_index,
            lease,
            now_ms,
            limits,
        )
    }

    /// Release a scan lease without consuming or extending replay backoff.
    pub(crate) fn release_monad_outbox_reconcile_lease(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: crate::store::monad_outbox::MonadOutboxLease,
    ) -> Result<crate::store::monad_outbox::MonadOutboxTransition> {
        self.db
            .monad_outbox()
            .release_reconcile_lease(payload_hash, child_index, lease)
    }

    /// Complete an owned replay generation with exact confirmation.
    pub(crate) fn complete_confirmed_monad_outbox_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: crate::store::monad_outbox::MonadOutboxLease,
        value_wei: u128,
        block_number: u64,
        now_ms: i64,
    ) -> Result<crate::store::monad_outbox::MonadOutboxTransition> {
        self.db.monad_outbox().complete_confirmed_member(
            payload_hash,
            child_index,
            lease,
            value_wei,
            block_number,
            now_ms,
        )
    }

    /// Complete an owned replay generation with a bounded transient error.
    pub(crate) fn complete_pending_monad_outbox_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: crate::store::monad_outbox::MonadOutboxLease,
        detail: &str,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxTransition> {
        self.db.monad_outbox().complete_pending_member(
            payload_hash,
            child_index,
            lease,
            detail,
            now_ms,
            limits,
        )
    }

    /// Complete an owned replay whose send the node definitively rejected.
    pub(crate) fn complete_rejected_monad_outbox_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: crate::store::monad_outbox::MonadOutboxLease,
        was_exposed: bool,
        detail: &str,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxTransition> {
        self.db.monad_outbox().complete_rejected_member(
            payload_hash,
            child_index,
            lease,
            was_exposed,
            detail,
            now_ms,
            limits,
        )
    }

    /// Persist exact transaction-body visibility without a receipt as possible exposure.
    pub(crate) fn complete_submitted_monad_outbox_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: crate::store::monad_outbox::MonadOutboxLease,
        detail: &str,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxTransition> {
        self.db.monad_outbox().complete_submitted_member(
            payload_hash,
            child_index,
            lease,
            detail,
            now_ms,
            limits,
        )
    }

    /// Complete an owned replay generation with a permanent losing outcome.
    pub(crate) fn complete_terminal_monad_outbox_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: crate::store::monad_outbox::MonadOutboxLease,
        terminal: crate::store::monad_outbox::MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxTransition> {
        self.db.monad_outbox().complete_terminal_member(
            payload_hash,
            child_index,
            lease,
            terminal,
            detail,
            now_ms,
            limits,
        )
    }

    /// Persist a terminal aggregate when a corrupt child reference cannot be updated safely.
    pub(crate) fn terminal_monad_outbox_claim(
        &self,
        payload_hash: &[u8],
        terminal: crate::store::monad_outbox::MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<crate::store::monad_outbox::MonadOutboxTransition> {
        self.db
            .monad_outbox()
            .terminal_claim(payload_hash, terminal, detail, now_ms, limits)
    }

    /// Verify all child states and persist the fully-confirmed aggregate transition.
    pub(crate) fn mark_monad_outbox_fully_confirmed(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
    ) -> Result<bool> {
        self.db
            .monad_outbox()
            .mark_fully_confirmed(payload_hash, now_ms)
    }

    /// Atomically publish the canonical message to the recipient inbox and mark it delivered.
    pub(crate) fn finalize_monad_outbox(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
        expected_chain_id: u64,
        limits: &crate::store::monad_outbox::MonadOutboxLimits,
    ) -> Result<proto::StoredMonadMessage> {
        self.db
            .monad_outbox()
            .finalize_delivery(payload_hash, now_ms, expected_chain_id, limits)
    }

    /// Recipient-private recovery view for retained, incomplete confirmed prefixes. This method
    /// is intentionally absent from `PublicFederationStore`.
    ///
    /// ```compile_fail
    /// use cashweb_registry::{monad_http::Address, p2p::public_store::PublicFederationStore};
    /// fn cannot_federate_private_recovery(store: PublicFederationStore<'_>) {
    ///     let _ = store.confirmed_monad_outbox_prefixes(Address([0; 20]), 10);
    /// }
    /// ```
    pub fn confirmed_monad_outbox_prefixes(
        &self,
        recipient: Address,
        limit: usize,
    ) -> Result<Vec<crate::store::monad_outbox::ConfirmedPrefixRecovery>> {
        self.db
            .monad_outbox()
            .confirmed_prefixes_for_recipient(&recipient, limit)
    }

    /// Return one strict-forward, scan-bounded recipient recovery page.
    pub fn confirmed_monad_outbox_prefixes_page(
        &self,
        recipient: Address,
        cursor: Option<[u8; 32]>,
        limit: usize,
        scan_limit: usize,
        max_canonical_bytes: usize,
        max_inspected_bytes: usize,
    ) -> Result<crate::store::monad_outbox::ConfirmedPrefixRecoveryPage> {
        self.db
            .monad_outbox()
            .confirmed_prefixes_for_recipient_page(
                &recipient,
                cursor,
                limit,
                scan_limit,
                max_canonical_bytes,
                max_inspected_bytes,
            )
    }

    /// Atomically retire one recipient-authenticated terminal recovery obligation.
    pub(crate) fn acknowledge_monad_outbox_recovery(
        &self,
        recipient: Address,
        payload_hash: &[u8],
        obligation_id: &[u8],
    ) -> Result<crate::store::monad_outbox::MonadRecoveryAck> {
        self.db.monad_outbox().acknowledge_terminal_recovery(
            &recipient,
            payload_hash,
            obligation_id,
        )
    }

    /// Fully verify and write a Monad-native profile registration (ticket #45) -- the Monad
    /// equivalent of [`Registry::put_metadata`]. See `crate::monad_profile_verify`'s module docs
    /// for why this uses an explicit pubkey+signature check (mirroring Lotus's own solution to
    /// the identical problem) rather than `ecrecover`, which has nothing to recover a signature
    /// from here (there's no burn transaction backing a profile registration).
    ///
    /// Reachable both from the dedicated `PUT /metadata/monad/:addr` route
    /// (`crate::http::monad_profile::handle_put_monad_profile`) and from the plain
    /// `PUT /metadata/:addr` route's Monad-address dispatch branch
    /// (`crate::http::server::handle_put_registry`) -- see that module's docs for why both exist.
    /// Returns the expected Frank-CBOR network identifier based on configured network tag and Net.
    pub fn expected_cbor_network(&self) -> &'static str {
        if let Some(id) =
            crate::network_tag::cbor_network_identifier(crate::network_tag::frank_network_tag())
        {
            return id;
        }
        match self.net {
            Net::Mainnet => "monad-mainnet",
            _ => "monad-testnet",
        }
    }

    /// Fully verify and write a Monad-native profile registration (ticket #45) -- the Monad
    /// equivalent of [`Registry::put_metadata`]. See `crate::monad_profile_verify`'s module docs
    /// for why this uses an explicit pubkey+signature check (mirroring Lotus's own solution to
    /// the identical problem) rather than `ecrecover`, which has nothing to recover a signature
    /// from here (there's no burn transaction backing a profile registration).
    ///
    /// Reachable both from the dedicated `PUT /metadata/monad/:addr` route
    /// (`crate::http::monad_profile::handle_put_monad_profile`) and from the plain
    /// `PUT /metadata/:addr` route's Monad-address dispatch branch
    /// (`crate::http::server::handle_put_registry`) -- see that module's docs for why both exist.
    #[cfg(test)]
    pub(crate) fn put_monad_profile(
        &self,
        address: Address,
        signed_profile: cashweb_payload::proto::SignedPayload,
    ) -> Result<()> {
        let verified = verify_monad_profile(&self.ecc, address, &signed_profile)?;

        self.put_verified_monad_profile(address, signed_profile, verified.profile.timestamp)
    }

    fn put_verified_monad_profile(
        &self,
        address: Address,
        signed_profile: cashweb_payload::proto::SignedPayload,
        timestamp: i64,
    ) -> Result<()> {
        if let Some(existing_signed) = self.db.monad_profiles().get(&address)? {
            if let Ok(existing_profile) =
                proto::MonadProfile::decode(existing_signed.payload.as_slice())
            {
                if existing_profile.timestamp >= timestamp {
                    return Err(MonadProfileTimestampNotMonotonicallyIncreasing {
                        previous: existing_profile.timestamp,
                        next: timestamp,
                    }
                    .into());
                }
            }
        }

        self.db.monad_profiles().put(&address, &signed_profile)?;
        Ok(())
    }

    /// Async request-boundary wrapper: verify independent fields off-runtime, wait only for this
    /// address stripe, then re-read and atomically replace the record/indexes on a blocking worker.
    pub async fn put_monad_profile_async(
        self: &Arc<Self>,
        address: Address,
        signed_profile: cashweb_payload::proto::SignedPayload,
        admission: ProfileRegistrationAdmission,
    ) -> Result<()> {
        let registry = Arc::clone(self);
        let verify_signed = signed_profile.clone();
        let (verified, admission) = self
            .run_profile_worker(admission, move || {
                verify_monad_profile(&registry.ecc, address, &verify_signed)
            })
            .await?;
        let registry = Arc::clone(self);
        let _ = self
            .run_profile_worker(admission, move || {
                registry.put_verified_monad_profile(
                    address,
                    signed_profile,
                    verified.profile.timestamp,
                )
            })
            .await?;
        Ok(())
    }

    /// Fully verify and write a Frank-CBOR type-2 account registration attestation (ticket #605).
    /// Enforces stage 10.6 signature verification and monotonic revision/timestamp invariants.
    fn put_monad_profile_cbor(&self, address: Address, frame_bytes: &[u8]) -> Result<()> {
        let expected_net = self.expected_cbor_network();
        let prior_info = self.validated_cbor_predecessor(address, expected_net)?;
        let prior_statement = prior_info
            .as_ref()
            .map(|info| frank_cbor::PriorStatement::Frame(info.type_4_frame.clone()))
            .unwrap_or(frank_cbor::PriorStatement::None);

        let verified =
            verify_cbor_account_registration(address, expected_net, frame_bytes, prior_statement)?;

        if let Some(info) = prior_info {
            if info.revision >= verified.revision {
                return Err(MonadProfileTimestampNotMonotonicallyIncreasing {
                    previous: info.timestamp_ms,
                    next: verified.timestamp_ms,
                }
                .into());
            }
        }

        self.db.monad_profiles().put_cbor(&address, frame_bytes)?;
        Ok(())
    }

    fn validated_cbor_predecessor(
        &self,
        address: Address,
        expected_network: &str,
    ) -> Result<Option<VerifiedCborRegistration>> {
        let raw = match self.db.monad_profiles().get_cbor(&address)? {
            Some(raw) => raw,
            None => return Ok(None),
        };
        verify_cbor_account_registration(
            address,
            expected_network,
            &raw,
            frank_cbor::PriorStatement::None,
        )
        .map(Some)
        .map_err(|err| DbMonadProfilesError::InvalidStoredCborRegistration(err.to_string()).into())
    }

    /// Async request-boundary wrapper for candidate CBOR writes. The bootstrap verification is
    /// predecessor-independent; after waiting for the address stripe, the blocking worker parses
    /// the stored predecessor exactly once, validates the dependent transition, and writes.
    pub async fn put_monad_profile_cbor_async(
        self: &Arc<Self>,
        address: Address,
        frame_bytes: Vec<u8>,
        admission: ProfileRegistrationAdmission,
    ) -> Result<()> {
        let verify_bytes = frame_bytes.clone();
        let (_, admission) = self
            .run_profile_worker(admission, move || {
                validate_cbor_account_registration_envelope(&verify_bytes)
            })
            .await?;
        let registry = Arc::clone(self);
        let _ = self
            .run_profile_worker(admission, move || {
                registry.put_monad_profile_cbor(address, &frame_bytes)
            })
            .await?;
        Ok(())
    }

    fn profile_write_stripe(&self, address: Address) -> usize {
        address.0.iter().fold(0usize, |hash, byte| {
            hash.wrapping_mul(31) ^ usize::from(*byte)
        }) % self.profile_write_locks.len()
    }

    /// Admit profile work without creating a waiter. Callers map exhaustion to an explicit
    /// retryable HTTP response before starting signature verification or RocksDB work.
    pub fn try_acquire_profile_registration(
        &self,
        address: Address,
    ) -> std::result::Result<ProfileRegistrationAdmission, ProfileRegistrationAdmissionError> {
        let stripe = Arc::clone(&self.profile_write_locks[self.profile_write_stripe(address)])
            .try_lock_owned()
            .map_err(|_| ProfileRegistrationAdmissionError::StripeBusy)?;
        let global = Arc::clone(&self.profile_registration_admission)
            .try_acquire_owned()
            .map_err(|_| ProfileRegistrationAdmissionError::GlobalBusy)?;
        Ok(ProfileRegistrationAdmission {
            _stripe: stripe,
            _global: global,
        })
    }

    /// Try to reserve one stored-CBOR read-validation worker without queueing.
    pub fn try_acquire_profile_read_validation(
        &self,
    ) -> std::result::Result<ProfileReadValidationAdmission, tokio::sync::TryAcquireError> {
        Arc::clone(&self.profile_read_validation_admission)
            .try_acquire_owned()
            .map(|permit| ProfileReadValidationAdmission { _permit: permit })
    }

    /// Read a previously-registered Monad profile's `cashweb_payload::proto::SignedPayload`
    /// envelope. Returns [`None`] if nothing is registered under `address` or if stored as CBOR.
    pub fn get_monad_profile(
        &self,
        address: Address,
    ) -> Result<Option<cashweb_payload::proto::SignedPayload>> {
        self.db.monad_profiles().get(&address)
    }

    /// Unchecked storage accessor for diagnostics and storage tests. HTTP response paths must use
    /// [`Registry::get_validated_monad_profile_cbor`] and never expose these bytes directly.
    pub fn get_monad_profile_cbor(&self, address: Address) -> Result<Option<Vec<u8>>> {
        self.db.monad_profiles().get_cbor(&address)
    }

    /// Read and fully validate an opt-in candidate CBOR frame before exposing its exact bytes.
    /// RocksDB access and signature verification both run off the async runtime's worker threads.
    pub async fn get_validated_monad_profile_cbor(
        self: &Arc<Self>,
        address: Address,
        admission: ProfileReadValidationAdmission,
    ) -> Result<Option<Vec<u8>>> {
        let registry = Arc::clone(self);
        #[cfg(test)]
        let gate = self.profile_read_worker_gate.clone();
        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            #[cfg(test)]
            if let Some(gate) = gate {
                gate.wait();
            }
            let raw = match registry.db.monad_profiles().get_cbor(&address)? {
                Some(raw) => raw,
                None => return Ok(None),
            };
            verify_cbor_account_registration(
                address,
                registry.expected_cbor_network(),
                &raw,
                frank_cbor::PriorStatement::None,
            )
            .map_err(|err| DbMonadProfilesError::InvalidStoredCborRegistration(err.to_string()))?;
            Ok(Some(raw))
        })
        .await
        .map_err(|err| MonadProfileWorkerFailed(err.to_string()))?
    }

    /// Read the registered public key from the legacy protobuf profile. Candidate CBOR records
    /// stay opt-in and cannot authorize live mailbox behavior before ticket #133.
    pub fn get_monad_profile_pubkey(&self, address: Address) -> Result<Option<Vec<u8>>> {
        self.db.monad_profiles().get_pubkey(&address)
    }

    /// Verify a mailbox request digest with the recipient's already-registered profile key.
    /// Missing/malformed profiles and bad signatures intentionally collapse to `false`.
    pub(crate) fn verify_monad_recipient_signature(
        &self,
        recipient: Address,
        digest: [u8; 32],
        signature: &[u8],
    ) -> Result<bool> {
        self.verify_monad_recipient_signature_observed(recipient, digest, signature, || {})
    }

    /// Atomically persist one successfully authenticated mailbox challenge as consumed.
    pub(crate) fn consume_monad_mailbox_challenge(
        &self,
        epoch: [u8; 32],
        recipient: Address,
        nonce: [u8; 32],
        expires_at_ms: i64,
        now_ms: i64,
        per_recipient_cap: usize,
    ) -> Result<crate::store::monad_messages::ChallengeConsumption> {
        self.db.monad_messages().consume_mailbox_challenge(
            epoch,
            recipient,
            nonce,
            expires_at_ms,
            now_ms,
            per_recipient_cap,
        )
    }

    fn verify_monad_recipient_signature_observed<F>(
        &self,
        recipient: Address,
        digest: [u8; 32],
        signature: &[u8],
        before_verify: F,
    ) -> Result<bool>
    where
        F: FnOnce(),
    {
        #[cfg(test)]
        RECIPIENT_SIGNATURE_WORK.set(RECIPIENT_SIGNATURE_WORK.get() + 1);
        let pubkey = self.db.monad_profiles().get_pubkey(&recipient)?;
        let registered = pubkey.is_some();
        let candidate = pubkey.unwrap_or_else(|| {
            let secret = self
                .ecc
                .seckey_from_array([1; 32])
                .expect("fixed non-zero secp256k1 key");
            self.ecc.derive_pubkey(&secret).as_slice().to_vec()
        });
        let Ok(pubkey_bytes) = candidate.as_slice().try_into() else {
            return Ok(false);
        };
        let Ok(pubkey) = self.ecc.pubkey_from_array(pubkey_bytes) else {
            return Ok(false);
        };
        let sig: Bytes = signature.into();
        before_verify();
        let verified = self.ecc.verify(&pubkey, digest.into(), &sig).is_ok();
        // Bitwise `&` is deliberate: missing profiles must execute the same ECDSA verification
        // work against the fixed dummy key before their uniform false result is selected.
        Ok(registered & verified)
    }

    pub(crate) fn list_monad_profiles_since(
        &self,
        since: i64,
    ) -> Result<Vec<(Address, cashweb_payload::proto::SignedPayload)>> {
        self.db.monad_profiles().list_since(since)
    }

    #[allow(dead_code)]
    pub(crate) fn search_monad_profiles_by_name(
        &self,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<(Address, cashweb_payload::proto::SignedPayload)>> {
        self.db.monad_profiles().search_by_name(prefix, limit)
    }

    /// List every [`proto::StoredMonadMessage`] stored with `timestamp >= since` (ticket #37),
    /// ordered by `timestamp` ascending. This remains the legacy global compatibility view until
    /// an authenticated recipient-scoped HTTP route is introduced.
    #[cfg(test)]
    pub(crate) fn list_monad_messages_since(
        &self,
        since: i64,
    ) -> Result<Vec<proto::StoredMonadMessage>> {
        self.db.monad_messages().list_since(since)
    }

    /// List the recipient-owned portion of the Monad mailbox journal. The recipient is derived
    /// from the validated routing envelope when the message is stored, not from query-time
    /// metadata supplied by the sender.
    pub fn list_monad_messages_for_recipient_since(
        &self,
        recipient: Address,
        since: i64,
    ) -> Result<Vec<proto::StoredMonadMessage>> {
        self.db
            .monad_messages()
            .list_for_recipient_since(&recipient, since)
    }

    /// Return one bounded recipient-private inbox page.
    pub fn list_monad_messages_for_recipient_since_capped(
        &self,
        recipient: Address,
        since: i64,
        cursor: Option<crate::store::monad_messages::RecipientMessageCursor>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<crate::store::monad_messages::RecipientMessagePage> {
        self.db
            .monad_outbox()
            .validated_inbox_page(&recipient, since, cursor, limit, max_bytes)
    }

    /// Store a [`proto::StoredMonadTopicPost`] (ticket #30), once its initial vote's burn has
    /// already verified (see `crate::http::monad_topics`). Mirrors [`Registry::put_monad_message`]: no
    /// `validate_burn_txs`/`chain_adapter` call here either, since broadcasting+verifying the
    /// initial-vote burn is `monad_topic_relay::broadcast_and_verify_topic_vote`'s job, called by
    /// the HTTP layer directly.
    ///
    /// Stamps `network_tag` (ticket #39, mirroring [`Registry::put_monad_message`] exactly -- see
    /// `crate::network_tag`'s module docs) onto `post` here and returns the tagged record actually
    /// persisted.
    pub(crate) fn put_monad_topic_post(
        &self,
        payload_hash: &[u8],
        post: proto::StoredMonadTopicPost,
        network_tag: &[u8],
    ) -> Result<proto::StoredMonadTopicPost> {
        let post = proto::StoredMonadTopicPost {
            network_tag: network_tag.to_vec(),
            ..post
        };
        self.db.monad_topic_posts().put(payload_hash, &post)?;
        Ok(post)
    }

    /// Retrieve a previously-stored [`proto::StoredMonadTopicPost`] by its `payload_hash`.
    pub(crate) fn get_monad_topic_post(
        &self,
        payload_hash: &[u8],
    ) -> Result<Option<proto::StoredMonadTopicPost>> {
        self.db.monad_topic_posts().get(payload_hash)
    }

    /// Record a single verified vote (a post's own initial vote, or a later
    /// [`proto::MonadTopicVote`]) against `entry.target_payload_hash` (ticket #30).
    pub(crate) fn add_monad_topic_vote(
        &self,
        entry: &proto::StoredMonadTopicVoteEntry,
    ) -> Result<()> {
        self.db.monad_topic_votes().add_vote(entry)
    }

    /// Attach `post`'s current tallied vote weight (sum of every vote recorded against
    /// `payload_hash`, including its own initial vote), producing a [`proto::MonadTopicPostView`].
    /// Shared by [`Registry::get_monad_topic_post_view`] and [`Registry::list_monad_topic_posts_by_topic`]
    /// (ticket #40) so both compute a post's tally the exact same way -- a client can't observe
    /// drift between "look up one post by hash" and "list a topic's posts".
    fn monad_topic_post_view(
        &self,
        payload_hash: &[u8],
        post: proto::StoredMonadTopicPost,
    ) -> Result<proto::MonadTopicPostView> {
        let vote_weight = self.db.monad_topic_votes().tally(payload_hash)?;
        Ok(proto::MonadTopicPostView {
            post: Some(post),
            vote_weight,
        })
    }

    /// Fetch a stored topic post together with its current tallied vote weight (sum of every
    /// vote recorded against its `payload_hash`, including its own initial vote). `None` if no
    /// post is stored for `payload_hash`.
    pub(crate) fn get_monad_topic_post_view(
        &self,
        payload_hash: &[u8],
    ) -> Result<Option<proto::MonadTopicPostView>> {
        let post = match self.get_monad_topic_post(payload_hash)? {
            Some(post) => post,
            None => return Ok(None),
        };
        Ok(Some(self.monad_topic_post_view(payload_hash, post)?))
    }

    /// List every stored [`proto::StoredMonadTopicPost`] under `topic` with `timestamp >= since`
    /// (milliseconds since the Unix epoch), each with its current tallied vote weight attached, in
    /// `timestamp` ascending order (ticket #40). See `crate::store::monad_topics`'s module docs for the
    /// `CF_MONAD_TOPIC_POSTS_BY_TOPIC` key layout this range-scans, and [`Registry::monad_topic_post_view`] for
    /// why the attached tally can't drift from [`Registry::get_monad_topic_post_view`]'s.
    pub(crate) fn list_monad_topic_posts_by_topic(
        &self,
        topic: &str,
        since: i64,
    ) -> Result<Vec<proto::MonadTopicPostView>> {
        self.db
            .monad_topic_posts()
            .list_by_topic(topic, since)?
            .into_iter()
            .map(|post| {
                let payload_hash = post
                    .post
                    .as_ref()
                    .map(|p| p.payload_hash.clone())
                    .unwrap_or_default();
                self.monad_topic_post_view(&payload_hash, post)
            })
            .collect()
    }

    /// List every distinct topic name this relay has stored at least one post for, together with
    /// its current post count and last-activity timestamp, ordered by last-activity descending
    /// (ticket #72). See `crate::store::monad_topics`'s module docs for the discovery index this
    /// delegates to, and this ticket's design-decision comment on GitHub issue #72 for why topics
    /// stay emergent/tag-based rather than a first-class registration.
    pub(crate) fn list_topics(&self) -> Result<Vec<(String, proto::TopicDiscoveryStats)>> {
        self.db.monad_topic_posts().list_topics()
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use bitcoinsuite_bitcoind::instance::{BitcoindChain, BitcoindConf, BitcoindInstance};
    use bitcoinsuite_core::{
        ecc::{Ecc, VerifySignatureError},
        lotus_txid, BitcoinCode, Hashed, LotusAddress, Net, Network, P2PKHSignatory, Script,
        SequenceNo, Sha256, ShaRmd160, SigHashType, SignData, SignField, TxBuilder, TxBuilderInput,
        TxBuilderOutput, TxInput, TxOutput, UnhashedTx,
    };
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use bitcoinsuite_error::Result;
    use bitcoinsuite_test_utils::bin_folder;
    use bitcoinsuite_test_utils_blockchain::{build_tx, setup_bitcoind_coins};
    use cashweb_payload::{
        payload::{ParseSignedPayloadError, SignatureScheme, SignedPayload},
        verify::{
            build_commitment_script, ValidateSignedPayloadError, ADDRESS_METADATA_LOKAD_ID,
            BROADCAST_MESSAGE_LOKAD_ID,
        },
    };
    use pretty_assertions::assert_eq;
    use prost::Message;

    use std::sync::Arc;

    use crate::{
        lotus_adapter::LotusAdapter,
        monad_http::Address,
        proto,
        registry::{
            profile_write_locks, GetMetadataRangeResult, ProfileRegistrationAdmissionError,
            PutBlockchainAction, PutMessageResult, PutMetadataResult, Registry, RegistryError,
            TestProfileWorkerGate, PROFILE_READ_VALIDATION_CONCURRENCY,
            PROFILE_REGISTRATION_CONCURRENCY,
        },
        store::{
            db::{Db, CF_PKH_BY_TIME},
            pubkeyhash::{PkhAlgorithm, PubKeyHash, TimePkh},
        },
    };

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    // Needs a real bitcoind/lotusd binary under `BITCOINSUITE_BIN_DIR` -- see
    // `lotus_adapter::tests::test_lotus_adapter`'s comment for why this is unavailable in CI and
    // intentionally not chased down right now.
    #[ignore = "requires a real bitcoind/lotusd binary; see comment above"]
    async fn test_registry_metadata() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry--registry")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let conf = BitcoindConf::from_chain_regtest(
            bin_folder(),
            BitcoindChain::XPI,
            vec![OsString::from("-txindex")],
        )?;
        let mut instance = BitcoindInstance::setup(conf)?;
        instance.wait_for_ready()?;
        let bitcoind = instance.rpc_client();

        let registry = Registry {
            db,
            ecc: EccSecp256k1::default(),
            chain_adapter: Arc::new(LotusAdapter::new(bitcoind.clone())),
            net: Net::Regtest,
            profile_write_locks: profile_write_locks(),
            profile_registration_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_REGISTRATION_CONCURRENCY,
            )),
            profile_read_validation_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_READ_VALIDATION_CONCURRENCY,
            )),
            profile_worker_gate: None,
            profile_read_worker_gate: None,
        };

        let seckey = registry.ecc.seckey_from_array([4; 32])?;
        let pubkey = registry.ecc.derive_pubkey(&seckey);
        let address = LotusAddress::new(
            "lotus",
            Net::Regtest,
            Script::p2pkh(&ShaRmd160::digest(pubkey.array().into())),
        );
        let pkh = PkhAlgorithm::Sha256Ripemd160.hash_pubkey(pubkey.array());

        let mut utxos = setup_bitcoind_coins(
            instance.cli(),
            Network::XPI,
            100,
            address.as_str(),
            &address.script().hex(),
        )?;

        // DB empty; querying for a PKH returns None
        assert_eq!(registry.get_metadata(&address)?, None);

        // Tx parses, but the output burn_index points to doesn't exist
        let address_metadata = proto::AddressMetadata {
            timestamp: 1234,
            ttl: 10,
            entries: vec![],
        };
        let payload_hash = Sha256::digest(address_metadata.encode_to_vec().into());
        let mut tx = UnhashedTx {
            version: 1,
            inputs: vec![],
            outputs: vec![TxOutput {
                value: 1_000_000,
                script: build_commitment_script(
                    ADDRESS_METADATA_LOKAD_ID,
                    pubkey.array(),
                    &payload_hash,
                ),
            }],
            lock_time: 0,
        };
        let mut signed_metadata = cashweb_payload::proto::SignedPayload {
            pubkey: pubkey.array().to_vec(),
            sig: vec![], // invalid sig
            sig_scheme: SignatureScheme::Ecdsa.into(),
            payload: vec![77, 88, 99], // invalid payload
            payload_hash: vec![],
            burn_amount: 1_000_000,
            burn_txs: vec![cashweb_payload::proto::BurnTx {
                tx: tx.ser().to_vec(),
                burn_idx: 0,
            }],
        };

        // Invalid protobuf (checked in SignedPayload::from_proto)
        let err = registry
            .put_metadata(&address, &signed_metadata)
            .await
            .unwrap_err()
            .downcast::<ParseSignedPayloadError>()?;
        assert_eq!(
            err,
            ParseSignedPayloadError::ParsingPayloadFailed(prost::DecodeError::new(
                "buffer underflow"
            )),
        );

        // Wrong pubkeyhash
        signed_metadata.payload = address_metadata.encode_to_vec();
        let wrong_address = LotusAddress::new(
            "lotus",
            Net::Regtest,
            Script::p2pkh(&ShaRmd160::new([4; 20])),
        );
        let err = registry
            .put_metadata(&wrong_address, &signed_metadata)
            .await
            .unwrap_err()
            .downcast::<RegistryError>()?;
        assert_eq!(
            err,
            RegistryError::PubKeyHashMismatch {
                expected: PubKeyHash::from_address(&wrong_address, Net::Regtest)?,
                actual: pkh.clone(),
            },
        );

        // Invalid signature (checked in SignedPayload::verify)
        let err = registry
            .put_metadata(&address, &signed_metadata)
            .await
            .unwrap_err()
            .downcast::<ValidateSignedPayloadError>()?;
        assert_eq!(
            err,
            ValidateSignedPayloadError::InvalidEcdsaSignature(VerifySignatureError::InvalidFormat),
        );

        // Valid signature, but failed to broadcast tx
        signed_metadata.sig = registry
            .ecc
            .sign(&seckey, payload_hash.byte_array().clone())
            .to_vec();
        let err = registry
            .put_metadata(&address, &signed_metadata)
            .await
            .unwrap_err()
            .downcast::<RegistryError>()?;
        assert_eq!(
            err,
            RegistryError::BitcoindRejectedTx("bad-txns-vin-empty".to_string()),
        );

        // Add valid input to tx
        let (outpoint, value) = utxos.pop().unwrap();
        let burn_amount = value - 10_000;
        tx.outputs[0].value = burn_amount;
        let mut tx_builder = TxBuilder::from_tx(tx);
        tx_builder.inputs.push(TxBuilderInput::new(
            TxInput {
                prev_out: outpoint,
                script: Script::default(),
                sequence: SequenceNo::finalized(),
                sign_data: Some(SignData::new(vec![
                    SignField::OutputScript(address.script().clone()),
                    SignField::Value(value),
                ])),
            },
            Box::new(P2PKHSignatory {
                seckey: seckey.clone(),
                pubkey,
                sig_hash_type: SigHashType::ALL_BIP143,
            }),
        ));
        let tx = tx_builder.sign(&registry.ecc, 1000, 546)?;
        signed_metadata.burn_txs[0].tx = tx.ser().to_vec();
        signed_metadata.burn_amount = burn_amount;

        // Now, putting the metadata succeeds
        let result = registry.put_metadata(&address, &signed_metadata).await?;
        assert_eq!(
            result,
            PutMetadataResult {
                txids: vec![lotus_txid(&tx)],
                blockchain_action: PutBlockchainAction::Broadcast,
                signed_metadata: SignedPayload::parse_proto(&signed_metadata)?,
            }
        );

        let signed_payload = registry.get_metadata(&address)?;
        assert_eq!(
            signed_payload,
            Some(SignedPayload::parse_proto(&signed_metadata)?),
        );

        // Putting the exact same metadata again works, the node already knows the payload hash.
        let result = registry.put_metadata(&address, &signed_metadata).await?;
        assert_eq!(
            result,
            PutMetadataResult {
                txids: vec![lotus_txid(&tx)],
                blockchain_action: PutBlockchainAction::AlreadyKnowPayloadHash,
                signed_metadata: SignedPayload::parse_proto(&signed_metadata)?,
            }
        );

        // Override address metadata with new SignedPayload
        let mut build_signed_metadata = |address_metadata: proto::AddressMetadata| -> Result<_> {
            let mut signed_metadata = signed_metadata.clone();

            signed_metadata.payload = address_metadata.encode_to_vec();
            let payload_hash = Sha256::digest(signed_metadata.payload.clone().into());
            signed_metadata.payload_hash = payload_hash.as_slice().to_vec();
            signed_metadata.sig = registry
                .ecc
                .sign(&seckey, payload_hash.byte_array().clone())
                .to_vec();

            let (outpoint, value) = utxos.pop().unwrap();
            let burn_amount = 10_000;
            let tx_builder = TxBuilder {
                version: 1,
                inputs: vec![TxBuilderInput::new(
                    TxInput {
                        prev_out: outpoint,
                        script: Script::default(),
                        sequence: SequenceNo::finalized(),
                        sign_data: Some(SignData::new(vec![
                            SignField::OutputScript(address.script().clone()),
                            SignField::Value(value),
                        ])),
                    },
                    Box::new(P2PKHSignatory {
                        seckey: seckey.clone(),
                        pubkey,
                        sig_hash_type: SigHashType::ALL_BIP143,
                    }),
                )],
                outputs: vec![
                    TxBuilderOutput::Leftover(address.script().clone()),
                    TxBuilderOutput::Fixed(TxOutput {
                        value: burn_amount,
                        script: build_commitment_script(
                            ADDRESS_METADATA_LOKAD_ID,
                            pubkey.array(),
                            &payload_hash,
                        ),
                    }),
                ],
                lock_time: 0,
            };
            signed_metadata.burn_amount = burn_amount;
            let tx = tx_builder.sign(&registry.ecc, 1000, 546)?;
            signed_metadata.burn_txs[0].tx = tx.ser().to_vec();
            signed_metadata.burn_txs[0].burn_idx = 1;
            Ok((signed_metadata, tx))
        };

        let (signed_metadata, _) = build_signed_metadata(proto::AddressMetadata {
            timestamp: 1234,
            ttl: 10,
            entries: vec![proto::AddressEntry {
                kind: "test".to_string(),
                headers: [].into(),
                body: vec![],
            }],
        })?;
        let err = registry
            .put_metadata(&address, &signed_metadata)
            .await
            .unwrap_err()
            .downcast::<RegistryError>()?;
        assert_eq!(
            err,
            RegistryError::TimestampNotMonotonicallyIncreasing {
                previous: 1234,
                next: 1234,
            },
        );

        // With more recent timestamp, it succeeds.
        let (signed_metadata, tx) = build_signed_metadata(proto::AddressMetadata {
            timestamp: 1235,
            ttl: 10,
            entries: vec![],
        })?;
        let result = registry.put_metadata(&address, &signed_metadata).await?;
        assert_eq!(
            result,
            PutMetadataResult {
                txids: vec![lotus_txid(&tx)],
                blockchain_action: PutBlockchainAction::Broadcast,
                signed_metadata: SignedPayload::parse_proto(&signed_metadata)?,
            }
        );

        assert_eq!(
            registry.get_metadata(&address)?,
            Some(SignedPayload::parse_proto(&signed_metadata)?)
        );

        let (signed_metadata, tx) = build_signed_metadata(proto::AddressMetadata {
            timestamp: 1236,
            ttl: 10,
            entries: vec![],
        })?;
        // pre-broadcast tx works
        bitcoind
            .cmd_text("sendrawtransaction", &[tx.ser().hex().into()])
            .await?;
        // Mine block: This would make another "sendrawtransaction" of `tx` fail.
        bitcoind
            .cmd_text("generatetoaddress", &[1i32.into(), address.as_str().into()])
            .await?;
        let result = registry.put_metadata(&address, &signed_metadata).await?;
        assert_eq!(
            result,
            PutMetadataResult {
                txids: vec![lotus_txid(&tx)],
                blockchain_action: PutBlockchainAction::AlreadyKnowTx,
                signed_metadata: SignedPayload::parse_proto(&signed_metadata)?,
            }
        );

        assert_eq!(
            registry.get_metadata(&address)?,
            Some(SignedPayload::parse_proto(&signed_metadata)?),
        );

        // Malleate tx, will result in a different txid, but same raw tx hex
        let (mut signed_metadata, tx) = build_signed_metadata(proto::AddressMetadata {
            timestamp: 1237,
            ttl: 10,
            entries: vec![],
        })?;
        bitcoind
            .cmd_text("sendrawtransaction", &[tx.ser().hex().into()])
            .await?;
        let old_tx = tx.clone();
        let mut tx_builder = TxBuilder::from_tx(tx);
        *tx_builder.inputs[0].signatory_mut() = Some(Box::new(P2PKHSignatory {
            seckey: seckey.clone(),
            pubkey,
            sig_hash_type: SigHashType::ALL_BIP143,
        }));
        let tx = tx_builder.sign(&registry.ecc, 1000, 546)?;
        assert_ne!(old_tx, tx);
        signed_metadata.burn_txs[0].tx = tx.ser().to_vec();
        let err = registry
            .put_metadata(&address, &signed_metadata)
            .await
            .unwrap_err()
            .downcast::<RegistryError>()?;
        assert_eq!(
            err,
            RegistryError::TxMalleated {
                expected: old_tx.ser().hex(),
                actual: tx.ser().hex(),
            },
        );

        // this test is incredibly flaky, only meant to be run to verify race condition handling
        if false {
            let mut found_any_race_condition = false;
            for i in 3..95 {
                let (signed_metadata, tx) = build_signed_metadata(proto::AddressMetadata {
                    timestamp: 1234 + i,
                    ttl: 10,
                    entries: vec![],
                })?;
                println!("**** i = {}", i);
                // pre-broadcast tx works
                // Race condition:
                // Mine block: This would make another "sendrawtransaction" of `tx` fail.
                let handle = tokio::spawn({
                    let address = address.clone();
                    let bitcoind = bitcoind.clone();
                    let tx = tx.clone();
                    async move {
                        tokio::time::sleep(std::time::Duration::from_micros(3 + (i * 3) as u64))
                            .await;
                        bitcoind
                            .cmd_text("sendrawtransaction", &[tx.ser().hex().into()])
                            .await
                            .unwrap();
                        bitcoind
                            .cmd_text("generatetoaddress", &[1i32.into(), address.as_str().into()])
                            .await
                            .unwrap();
                    }
                });
                let result = registry.put_metadata(&address, &signed_metadata).await;
                if let Ok(result) = result {
                    if result.blockchain_action == PutBlockchainAction::BroadcastRaceCondition {
                        found_any_race_condition = true;
                        break;
                    }
                }
                handle.await?;
            }

            assert!(
                found_any_race_condition,
                "No block race condition could be simulated",
            );
        }

        instance.cleanup()?;

        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    // See `test_registry_metadata`'s comment above -- same real bitcoind/lotusd dependency.
    #[ignore = "requires a real bitcoind/lotusd binary; see comment above"]
    async fn test_registry_metadata_range() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry--registry")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let conf = BitcoindConf::from_chain_regtest(
            bin_folder(),
            BitcoindChain::XPI,
            vec![OsString::from("-txindex")],
        )?;
        let mut instance = BitcoindInstance::setup(conf)?;
        instance.wait_for_ready()?;
        let bitcoind = instance.rpc_client();

        let registry = Registry {
            db,
            ecc: EccSecp256k1::default(),
            chain_adapter: Arc::new(LotusAdapter::new(bitcoind.clone())),
            net: Net::Regtest,
            profile_write_locks: profile_write_locks(),
            profile_registration_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_REGISTRATION_CONCURRENCY,
            )),
            profile_read_validation_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_READ_VALIDATION_CONCURRENCY,
            )),
            profile_worker_gate: None,
            profile_read_worker_gate: None,
        };

        // Generate a few anyone can spend coins
        let anyone_script = Script::from_slice(&[0x51]);
        let anyone_address = LotusAddress::new(
            "lotus",
            Net::Regtest,
            Script::p2sh(&ShaRmd160::digest(anyone_script.bytecode().clone())),
        );
        let mut utxos = setup_bitcoind_coins(
            instance.cli(),
            Network::XPI,
            10,
            anyone_address.as_str(),
            &anyone_address.script().hex(),
        )?;

        let items = registry.get_metadata_range(0, None, None, 10)?;
        assert_eq!(items, GetMetadataRangeResult { entries: vec![] });

        let mut entries = Vec::new();
        let test_cases = [
            (1, 1000),
            (2, 1000),
            (2, 1001),
            (3, 1001),
            (4, 1001),
            (3, 1002),
        ];
        for (seckey_byte, timestamp) in test_cases {
            let seckey = registry.ecc.seckey_from_array([seckey_byte; 32])?;
            let pubkey = registry.ecc.derive_pubkey(&seckey);
            let address = LotusAddress::new(
                "lotus",
                Net::Regtest,
                Script::p2pkh(&ShaRmd160::digest(pubkey.array().into())),
            );
            let pkh = PkhAlgorithm::Sha256Ripemd160.hash_pubkey(pubkey.array());

            // Build valid address metadata
            let address_metadata = proto::AddressMetadata {
                timestamp,
                ttl: 10,
                entries: vec![],
            };
            let payload_hash = Sha256::digest(address_metadata.encode_to_vec().into());

            // Build burn commitment tx
            let (outpoint, amount) = utxos.pop().unwrap();
            let burn_amount = amount - 10_000;
            let tx = build_tx(
                outpoint,
                &anyone_script,
                vec![TxOutput {
                    value: burn_amount,
                    script: build_commitment_script(
                        ADDRESS_METADATA_LOKAD_ID,
                        pubkey.array(),
                        &payload_hash,
                    ),
                }],
            );

            // Sign address metadata
            let signed_metadata = cashweb_payload::proto::SignedPayload {
                pubkey: pubkey.array().to_vec(),
                sig: registry
                    .ecc
                    .sign(&seckey, payload_hash.byte_array().clone())
                    .to_vec(),
                sig_scheme: SignatureScheme::Ecdsa.into(),
                payload: address_metadata.encode_to_vec(),
                payload_hash: payload_hash.as_slice().to_vec(),
                burn_amount,
                burn_txs: vec![cashweb_payload::proto::BurnTx {
                    tx: tx.ser().to_vec(),
                    burn_idx: 0,
                }],
            };

            registry.put_metadata(&address, &signed_metadata).await?;
            // Even gets overridden by odd
            entries.push((
                pkh.to_address(Net::Regtest),
                SignedPayload::<proto::AddressMetadata>::parse_proto(&signed_metadata)?,
            ));
        }

        let index_entries = |indices: &[usize]| GetMetadataRangeResult {
            entries: indices.iter().map(|&idx| entries[idx].clone()).collect(),
        };

        let items = registry.get_metadata_range(0, None, None, 1)?;
        assert_eq!(items, index_entries(&[0]));

        let items = registry.get_metadata_range(0, None, None, 4)?;
        assert_eq!(items, index_entries(&[0, 4, 2, 5]));

        let items = registry.get_metadata_range(0, Some(1002), None, 3)?;
        assert_eq!(items, index_entries(&[0, 4, 2]));

        {
            let address = &entries[4].0;
            let items = registry.get_metadata_range(999, None, Some(address), 10)?;
            assert_eq!(items, index_entries(&[0, 4, 2, 5]));
            let items = registry.get_metadata_range(1000, None, Some(address), 10)?;
            assert_eq!(items, index_entries(&[4, 2, 5]));
            let items = registry.get_metadata_range(1001, None, Some(address), 10)?;
            assert_eq!(items, index_entries(&[2, 5]));
        }

        let items = registry.get_metadata_range(1001, Some(1002), None, 3)?;
        assert_eq!(items, index_entries(&[4, 2]));

        // Add stale timestamp for some pkh
        let cf_pkh_by_time = registry.db.cf(CF_PKH_BY_TIME)?;
        registry.db.rocksdb().put_cf(
            cf_pkh_by_time,
            TimePkh {
                timestamp: 1000,
                pkh: PubKeyHash::from_address(&entries[3].0, Net::Regtest)?,
            }
            .to_storage_bytes(),
            &[],
        )?;

        // Stale entry gets ignored
        let items = registry.get_metadata_range(0, None, None, 10)?;
        assert_eq!(items, index_entries(&[0, 4, 2, 5]));

        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    // See `test_registry_metadata`'s comment above -- same real bitcoind/lotusd dependency.
    #[ignore = "requires a real bitcoind/lotusd binary; see comment above"]
    async fn test_registy_topics() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry--registry")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let conf = BitcoindConf::from_chain_regtest(
            bin_folder(),
            BitcoindChain::XPI,
            vec![OsString::from("-txindex")],
        )?;
        let mut instance = BitcoindInstance::setup(conf)?;
        instance.wait_for_ready()?;
        let bitcoind = instance.rpc_client();

        let registry = Registry {
            db,
            ecc: EccSecp256k1::default(),
            chain_adapter: Arc::new(LotusAdapter::new(bitcoind.clone())),
            net: Net::Regtest,
            profile_write_locks: profile_write_locks(),
            profile_registration_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_REGISTRATION_CONCURRENCY,
            )),
            profile_read_validation_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_READ_VALIDATION_CONCURRENCY,
            )),
            profile_worker_gate: None,
            profile_read_worker_gate: None,
        };

        let seckey = registry.ecc.seckey_from_array([4; 32])?;
        let pubkey = registry.ecc.derive_pubkey(&seckey);
        let address = LotusAddress::new(
            "lotus",
            Net::Regtest,
            Script::p2pkh(&ShaRmd160::digest(pubkey.array().into())),
        );

        let mut utxos = setup_bitcoind_coins(
            instance.cli(),
            Network::XPI,
            100,
            address.as_str(),
            &address.script().hex(),
        )?;

        // Tx parses, but the output burn_index points to doesn't exist
        let broadcast_message = proto::BroadcastMessage {
            timestamp: 1234,
            topic: "your.mom".to_string(),
            entries: vec![],
        };
        let broadcast_message_vec = broadcast_message.encode_to_vec();
        let payload_hash = Sha256::digest(broadcast_message_vec.clone().into());
        let mut tx = UnhashedTx {
            version: 1,
            inputs: vec![],
            outputs: vec![TxOutput {
                value: 1_000_000,
                script: build_commitment_script(
                    BROADCAST_MESSAGE_LOKAD_ID,
                    pubkey.array(),
                    &payload_hash,
                ),
            }],
            lock_time: 0,
        };
        let mut signed_message = cashweb_payload::proto::SignedPayload {
            pubkey: pubkey.array().to_vec(),
            sig: vec![], // invalid sig
            sig_scheme: SignatureScheme::Ecdsa.into(),
            payload: vec![77, 88, 99], // invalid payload
            payload_hash: vec![],
            burn_amount: 1_000_000,
            burn_txs: vec![cashweb_payload::proto::BurnTx {
                tx: tx.ser().to_vec(),
                burn_idx: 0,
            }],
        };
        // Invalid protobuf (checked in SignedPayload::from_proto)
        let err = registry
            .put_message(&signed_message)
            .await
            .unwrap_err()
            .downcast::<ParseSignedPayloadError>()?;
        assert_eq!(
            err,
            ParseSignedPayloadError::ParsingPayloadFailed(prost::DecodeError::new(
                "buffer underflow"
            )),
        );
        // Invalid signature (checked in SignedPayload::verify)
        signed_message.payload = broadcast_message_vec;
        let err = registry
            .put_message(&signed_message)
            .await
            .unwrap_err()
            .downcast::<ValidateSignedPayloadError>()?;
        assert_eq!(
            err,
            ValidateSignedPayloadError::InvalidEcdsaSignature(VerifySignatureError::InvalidFormat),
        );
        // Valid signature, but no input on transaction
        signed_message.sig = registry
            .ecc
            .sign(&seckey, payload_hash.byte_array().clone())
            .to_vec();
        let err = registry
            .put_message(&signed_message)
            .await
            .unwrap_err()
            .downcast::<RegistryError>()?;

        assert_eq!(
            err,
            RegistryError::BitcoindRejectedTx("bad-txns-vin-empty".to_string()),
        );
        // Add valid input to tx
        let (outpoint, value) = utxos.pop().unwrap();
        let burn_amount = value - 10_000;
        tx.outputs[0].value = burn_amount;
        let mut tx_builder = TxBuilder::from_tx(tx);
        tx_builder.inputs.push(TxBuilderInput::new(
            TxInput {
                prev_out: outpoint,
                script: Script::default(),
                sequence: SequenceNo::finalized(),
                sign_data: Some(SignData::new(vec![
                    SignField::OutputScript(address.script().clone()),
                    SignField::Value(value),
                ])),
            },
            Box::new(P2PKHSignatory {
                seckey: seckey.clone(),
                pubkey,
                sig_hash_type: SigHashType::ALL_BIP143,
            }),
        ));
        let tx = tx_builder.sign(&registry.ecc, 1000, 546)?;
        signed_message.burn_txs[0].tx = tx.ser().to_vec();
        signed_message.burn_amount = burn_amount;
        // Now, putting the message succeeds
        let result = registry.put_message(&signed_message).await?;
        assert_eq!(
            result,
            PutMessageResult {
                txids: vec![lotus_txid(&tx)],
                blockchain_action: PutBlockchainAction::Broadcast,
                signed_message: SignedPayload::parse_proto(&signed_message)?,
            }
        );
        let mut message_one = registry.get_message(payload_hash.as_slice().to_vec())?;
        assert_eq!(
            message_one,
            SignedPayload::parse_proto(&signed_message)?,
            "Payloads do not match {:?}, {:?}",
            message_one,
            signed_message.payload_hash.clone()
        );
        // Putting the exact same message again works, the node already knows the payload hash.
        let result = registry.put_message(&signed_message).await?;
        assert_eq!(
            result,
            PutMessageResult {
                txids: vec![lotus_txid(&tx)],
                blockchain_action: PutBlockchainAction::AlreadyKnowTx,
                signed_message: SignedPayload::parse_proto(&signed_message)?,
            }
        );
        let mut build_signed_message = |broadcast_message: proto::BroadcastMessage| -> Result<_> {
            let mut signed_message = signed_message.clone();

            signed_message.payload = broadcast_message.encode_to_vec();
            let payload_hash = Sha256::digest(signed_message.payload.clone().into());
            signed_message.payload_hash = payload_hash.as_slice().to_vec();
            signed_message.sig = registry
                .ecc
                .sign(&seckey, payload_hash.byte_array().clone())
                .to_vec();

            let (outpoint, value) = utxos.pop().unwrap();
            let burn_amount = 10_000;
            let tx_builder = TxBuilder {
                version: 1,
                inputs: vec![TxBuilderInput::new(
                    TxInput {
                        prev_out: outpoint,
                        script: Script::default(),
                        sequence: SequenceNo::finalized(),
                        sign_data: Some(SignData::new(vec![
                            SignField::OutputScript(address.script().clone()),
                            SignField::Value(value),
                        ])),
                    },
                    Box::new(P2PKHSignatory {
                        seckey: seckey.clone(),
                        pubkey,
                        sig_hash_type: SigHashType::ALL_BIP143,
                    }),
                )],
                outputs: vec![
                    TxBuilderOutput::Leftover(address.script().clone()),
                    TxBuilderOutput::Fixed(TxOutput {
                        value: burn_amount,
                        script: build_commitment_script(
                            BROADCAST_MESSAGE_LOKAD_ID,
                            pubkey.array(),
                            &payload_hash,
                        ),
                    }),
                ],
                lock_time: 0,
            };
            signed_message.burn_amount = burn_amount;
            let tx = tx_builder.sign(&registry.ecc, 1000, 546)?;
            signed_message.burn_txs[0].tx = tx.ser().to_vec();
            signed_message.burn_txs[0].burn_idx = 1;
            Ok((signed_message, tx))
        };
        let (signed_message, tx) = build_signed_message(proto::BroadcastMessage {
            timestamp: 1236,
            topic: "your.mom".to_string(),
            entries: vec![],
        })?;
        // pre-broadcast tx works
        bitcoind
            .cmd_text("sendrawtransaction", &[tx.ser().hex().into()])
            .await?;
        // Mine block: This would make another "sendrawtransaction" of `tx` fail.
        bitcoind
            .cmd_text("generatetoaddress", &[1i32.into(), address.as_str().into()])
            .await?;
        let result = registry.put_message(&signed_message).await?;
        assert_eq!(
            result,
            PutMessageResult {
                txids: vec![lotus_txid(&tx)],
                blockchain_action: PutBlockchainAction::AlreadyKnowTx,
                signed_message: SignedPayload::parse_proto(&signed_message)?,
            }
        );
        let mut message_two = registry.get_message(signed_message.payload_hash.clone())?;
        assert_eq!(message_two, SignedPayload::parse_proto(&signed_message)?,);
        // Malleate tx, will result in the same txid, but diffrent raw tx hex
        let (signed_message, tx) = build_signed_message(proto::BroadcastMessage {
            timestamp: 1237,
            topic: "your.mom".to_string(),
            entries: vec![],
        })?;
        bitcoind
            .cmd_text("sendrawtransaction", &[tx.ser().hex().into()])
            .await?;
        let old_tx = tx.clone();
        let mut tx_builder = TxBuilder::from_tx(tx);
        *tx_builder.inputs[0].signatory_mut() = Some(Box::new(P2PKHSignatory {
            seckey: seckey.clone(),
            pubkey,
            sig_hash_type: SigHashType::ALL_BIP143,
        }));
        let tx = tx_builder.sign(&registry.ecc, 1000, 546)?;
        assert_ne!(old_tx, tx);
        let mut malleated_message = signed_message.clone();
        malleated_message.burn_txs[0].tx = tx.ser().to_vec();
        let err = registry
            .put_message(&malleated_message)
            .await
            .unwrap_err()
            .downcast::<RegistryError>()?;
        assert_eq!(
            err,
            RegistryError::TxMalleated {
                expected: old_tx.ser().hex(),
                actual: tx.ser().hex(),
            },
        );

        message_one.clear_payload();
        message_two.clear_payload();

        // Test getting messages that were sent.
        let messages = registry.get_messages("", 0, i64::MAX)?;
        assert_eq!(messages, vec![message_one, message_two]);

        instance.cleanup()?;

        Ok(())
    }

    /// A [`cashweb_payload::chain_adapter::ChainAdapter`] that's never actually called for
    /// anything meaningful. `Registry::put_monad_profile`/`get_monad_profile` never touch
    /// `chain_adapter` at all -- there's no burn transaction backing a profile registration (see
    /// `crate::monad_profile_verify`'s module docs) -- so, unlike `test_registry_metadata`/
    /// `test_registry_message` above, these tests don't need a real bitcoind/Lotus adapter.
    /// Mirrors `examples/e2e_demo_server.rs`'s `DemoChainAdapter`: the async methods return
    /// harmless dummy values (rather than `unimplemented!()`, which triggers clippy's
    /// `diverging_sub_expression` lint when used as an async fn's tail expression -- confirmed by
    /// checking `DemoChainAdapter`, which avoids exactly this for the same reason) since they're
    /// never actually invoked by the code under test; only the one sync method
    /// (`decode_burn`, also never invoked) uses `unimplemented!()`, matching `DemoChainAdapter`
    /// exactly.
    #[derive(Debug)]
    struct NeverCalledChainAdapter;

    #[async_trait::async_trait]
    impl cashweb_payload::chain_adapter::ChainAdapter for NeverCalledChainAdapter {
        async fn submit_tx(
            &self,
            _raw_tx: &[u8],
        ) -> Result<cashweb_payload::chain_adapter::SubmitTxOutcome> {
            Ok(cashweb_payload::chain_adapter::SubmitTxOutcome::AlreadyConfirmed)
        }

        async fn get_tx(&self, _txid: &bitcoinsuite_core::Sha256d) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }

        async fn test_accept(
            &self,
            _raw_tx: &[u8],
        ) -> Result<cashweb_payload::chain_adapter::MempoolAcceptResult> {
            Ok(Ok(()))
        }

        async fn subscribe_new_blocks(
            &self,
        ) -> Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>> {
            let (_sender, receiver) = tokio::sync::mpsc::channel(1);
            Ok(receiver)
        }

        fn decode_burn(
            &self,
            _commitment_id: [u8; 4],
            _burn_output_script: &Script,
        ) -> Result<Sha256> {
            unimplemented!("Monad profile registration never touches ChainAdapter")
        }
    }

    /// Builds a fresh, on-disk-backed [`Registry`] for the Monad-profile tests below, holding no
    /// real chain connection (see [`NeverCalledChainAdapter`]). Returns the [`tempdir::TempDir`]
    /// guard alongside it -- the caller must keep it alive for the registry's lifetime, mirroring
    /// every other `Db::open(tempdir...)` test in this crate (e.g. `store::monad_messages`'s
    /// tests).
    fn test_monad_profile_registry(name: &str) -> (tempdir::TempDir, Registry) {
        let tempdir = tempdir::TempDir::new(name).unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry {
            db,
            ecc: EccSecp256k1::default(),
            chain_adapter: Arc::new(NeverCalledChainAdapter),
            net: Net::Regtest,
            profile_write_locks: profile_write_locks(),
            profile_registration_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_REGISTRATION_CONCURRENCY,
            )),
            profile_read_validation_admission: Arc::new(tokio::sync::Semaphore::new(
                PROFILE_READ_VALIDATION_CONCURRENCY,
            )),
            profile_worker_gate: None,
            profile_read_worker_gate: None,
        };
        (tempdir, registry)
    }

    /// Builds a validly-signed [`cashweb_payload::proto::SignedPayload`] for `profile`, signed by
    /// `seckey` -- mirrors `monad-identity.ts`'s `buildSignedAddressMetadata`/`signHash` exactly
    /// (SHA256 digest, DER ECDSA signature, explicit pubkey field; see
    /// `crate::monad_profile_verify`'s module docs) -- and the [`crate::monad_http::Address`] it
    /// should be registered under.
    fn sign_monad_profile(
        seckey: &bitcoinsuite_core::ecc::SecKey,
        profile: &proto::MonadProfile,
    ) -> (
        cashweb_payload::proto::SignedPayload,
        crate::monad_http::Address,
    ) {
        let ecc = EccSecp256k1::default();
        let pubkey = ecc.derive_pubkey(seckey);
        let uncompressed = ecc.serialize_pubkey_uncompressed(&pubkey);
        let address = crate::monad_evm_tx::address_from_uncompressed_pubkey(&uncompressed);

        let payload = profile.encode_to_vec();
        let payload_hash = Sha256::digest(payload.clone().into());
        let sig = ecc.sign(seckey, payload_hash.byte_array().clone());

        let signed = cashweb_payload::proto::SignedPayload {
            pubkey: pubkey.as_slice().to_vec(),
            sig: sig.to_vec(),
            sig_scheme: SignatureScheme::Ecdsa.into(),
            payload,
            payload_hash: payload_hash.as_slice().to_vec(),
            burn_amount: 0,
            burn_txs: vec![],
        };
        (signed, address)
    }

    fn sample_monad_profile(timestamp: i64) -> proto::MonadProfile {
        proto::MonadProfile {
            timestamp,
            ttl: 1000 * 60 * 60 * 24 * 365,
            entries: vec![],
        }
    }

    #[test]
    fn test_put_and_get_monad_profile_round_trip() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-monad-profile-round-trip");
        let seckey = registry.ecc.seckey_from_array([9; 32])?;
        let (signed, address) = sign_monad_profile(&seckey, &sample_monad_profile(1000));

        // Nothing registered yet.
        assert_eq!(registry.get_monad_profile(address)?, None);

        registry.put_monad_profile(address, signed.clone())?;
        assert_eq!(registry.get_monad_profile(address)?, Some(signed));

        Ok(())
    }

    #[test]
    fn test_list_monad_profiles_since_discovers_new_registrations_by_time() -> Result<()> {
        // Ticket #75: the actual bot-facing use case -- discover newly-registered addresses via
        // the full put_monad_profile -> list_monad_profiles_since path (real signature
        // verification, not the store-layer test's bypassed put).
        let _ = bitcoinsuite_error::install();
        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-monad-profile-list-since");

        let early_key = registry.ecc.seckey_from_array([1; 32])?;
        let (early_signed, early_address) =
            sign_monad_profile(&early_key, &sample_monad_profile(100));
        registry.put_monad_profile(early_address, early_signed.clone())?;

        let late_key = registry.ecc.seckey_from_array([2; 32])?;
        let (late_signed, late_address) = sign_monad_profile(&late_key, &sample_monad_profile(200));
        registry.put_monad_profile(late_address, late_signed.clone())?;

        assert_eq!(
            registry.list_monad_profiles_since(0)?,
            vec![
                (early_address, early_signed),
                (late_address, late_signed.clone())
            ],
        );
        assert_eq!(
            registry.list_monad_profiles_since(200)?,
            vec![(late_address, late_signed)],
        );
        assert_eq!(registry.list_monad_profiles_since(201)?, vec![]);

        Ok(())
    }

    #[test]
    fn test_put_monad_profile_rejects_stale_timestamp() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-monad-profile-stale");
        let seckey = registry.ecc.seckey_from_array([9; 32])?;

        let (first, address) = sign_monad_profile(&seckey, &sample_monad_profile(1000));
        registry.put_monad_profile(address, first)?;

        // A re-registration with a timestamp that doesn't strictly increase is rejected --
        // mirrors `Registry::put_metadata`'s identical Lotus-side invariant, preventing a stale
        // registration from being replayed.
        let (stale, _) = sign_monad_profile(&seckey, &sample_monad_profile(999));
        let err = registry
            .put_monad_profile(address, stale)
            .unwrap_err()
            .downcast::<RegistryError>()?;
        assert_eq!(
            err,
            RegistryError::MonadProfileTimestampNotMonotonicallyIncreasing {
                previous: 1000,
                next: 999,
            },
        );

        // The original registration is untouched.
        let (original, _) = sign_monad_profile(&seckey, &sample_monad_profile(1000));
        assert_eq!(registry.get_monad_profile(address)?, Some(original));

        Ok(())
    }

    #[test]
    fn test_put_monad_profile_rejects_a_submission_signed_by_the_wrong_key() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-monad-profile-bad-sig");
        let seckey = registry.ecc.seckey_from_array([9; 32])?;
        let (signed, claimed_address) = sign_monad_profile(&seckey, &sample_monad_profile(1000));

        // Sign with a *different* key, but submit under the first key's address: the derived
        // address won't match what's claimed.
        let other_seckey = registry.ecc.seckey_from_array([10; 32])?;
        let (mismatched, _) = sign_monad_profile(&other_seckey, &sample_monad_profile(1000));

        let err = registry
            .put_monad_profile(claimed_address, mismatched)
            .unwrap_err();
        assert!(err
            .downcast::<crate::monad_profile_verify::MonadProfileVerifyError>()
            .is_ok());

        // Nothing was stored.
        assert_eq!(registry.get_monad_profile(claimed_address)?, None);
        // Sanity: the original, correctly-addressed submission still works.
        registry.put_monad_profile(claimed_address, signed)?;
        assert!(registry.get_monad_profile(claimed_address)?.is_some());

        Ok(())
    }

    #[test]
    fn test_put_monad_profile_rejects_an_unsigned_submission() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-monad-profile-unsigned");
        let seckey = registry.ecc.seckey_from_array([9; 32])?;
        let (mut signed, address) = sign_monad_profile(&seckey, &sample_monad_profile(1000));
        signed.sig = vec![]; // no signature at all

        let err = registry.put_monad_profile(address, signed).unwrap_err();
        assert!(err
            .downcast::<crate::monad_profile_verify::MonadProfileVerifyError>()
            .is_ok());
        assert_eq!(registry.get_monad_profile(address)?, None);

        Ok(())
    }

    #[test]
    fn test_get_monad_profile_not_found() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-monad-profile-not-found");
        let address = crate::monad_http::Address([3u8; 20]);
        assert_eq!(registry.get_monad_profile(address)?, None);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn held_profile_address_does_not_block_other_address_or_runtime() -> Result<()> {
        use std::time::Duration;

        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-profile-async-stripes");
        let registry = Arc::new(registry);
        let key_a = registry.ecc.seckey_from_array([21; 32])?;
        let (_, address_a) = sign_monad_profile(&key_a, &sample_monad_profile(100));
        let stripe_a = registry.profile_write_stripe(address_a);
        let (signed_b, address_b) = (22u8..=255)
            .find_map(|byte| {
                let key = registry.ecc.seckey_from_array([byte; 32]).ok()?;
                let pair = sign_monad_profile(&key, &sample_monad_profile(100));
                (registry.profile_write_stripe(pair.1) != stripe_a).then_some(pair)
            })
            .expect("test keys must cover a second profile stripe");

        let held_admission = registry
            .try_acquire_profile_registration(address_a)
            .unwrap();
        assert!(matches!(
            registry.try_acquire_profile_registration(address_a),
            Err(ProfileRegistrationAdmissionError::StripeBusy)
        ));

        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::task::yield_now().await;
            registry
                .put_monad_profile_async(
                    address_b,
                    signed_b,
                    registry
                        .try_acquire_profile_registration(address_b)
                        .unwrap(),
                )
                .await
        })
        .await
        .expect("held address A must not stall address B or the runtime")?;

        drop(held_admission);
        assert_eq!(registry.get_monad_profile(address_a)?, None);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_profile_future_keeps_admission_until_blocking_worker_exits() -> Result<()> {
        use std::time::Duration;

        for format in ["protobuf", "cbor"] {
            let (_tempdir, mut registry) = test_monad_profile_registry(&format!(
                "cashweb-registry--cancelled-profile-worker-{format}"
            ));
            let (gate, started_rx) = TestProfileWorkerGate::new();
            registry.profile_worker_gate = Some(Arc::clone(&gate));
            let seckey = registry.ecc.seckey_from_array([31; 32])?;
            let (signed, protobuf_address) =
                sign_monad_profile(&seckey, &sample_monad_profile(100));
            let worker_address = if format == "protobuf" {
                protobuf_address
            } else {
                Address([0; 20])
            };
            let registry = Arc::new(registry);
            let admission = registry
                .try_acquire_profile_registration(worker_address)
                .unwrap();
            let worker_registry = Arc::clone(&registry);
            let request = tokio::spawn(async move {
                if format == "protobuf" {
                    worker_registry
                        .put_monad_profile_async(worker_address, signed, admission)
                        .await
                } else {
                    worker_registry
                        .put_monad_profile_cbor_async(worker_address, vec![0x80], admission)
                        .await
                }
            });
            started_rx.await.unwrap();

            let mut other_admissions = Vec::new();
            for candidate in 0..=u8::MAX {
                let mut bytes = [0; 20];
                bytes[19] = candidate;
                match registry.try_acquire_profile_registration(Address(bytes)) {
                    Ok(admission) => other_admissions.push(admission),
                    Err(ProfileRegistrationAdmissionError::StripeBusy) => continue,
                    Err(ProfileRegistrationAdmissionError::GlobalBusy) => break,
                }
                if other_admissions.len() == PROFILE_REGISTRATION_CONCURRENCY - 1 {
                    break;
                }
            }
            assert_eq!(other_admissions.len(), PROFILE_REGISTRATION_CONCURRENCY - 1);
            let extra_address = (0..=u8::MAX)
                .find_map(|candidate| {
                    let mut bytes = [0; 20];
                    bytes[19] = candidate;
                    let address = Address(bytes);
                    matches!(
                        registry.try_acquire_profile_registration(address),
                        Err(ProfileRegistrationAdmissionError::GlobalBusy)
                    )
                    .then_some(address)
                })
                .expect("64 stripes include one idle stripe beyond the 32 global slots");

            request.abort();
            assert!(matches!(
                registry.try_acquire_profile_registration(worker_address),
                Err(ProfileRegistrationAdmissionError::StripeBusy)
            ));
            assert!(matches!(
                registry.try_acquire_profile_registration(extra_address),
                Err(ProfileRegistrationAdmissionError::GlobalBusy)
            ));

            gate.release();
            let recovered = tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    match registry.try_acquire_profile_registration(extra_address) {
                        Ok(admission) => break admission,
                        Err(ProfileRegistrationAdmissionError::GlobalBusy) => {
                            tokio::task::yield_now().await
                        }
                        Err(err) => panic!("unexpected admission error: {err:?}"),
                    }
                }
            })
            .await
            .expect("blocking worker released admission after exiting");
            drop(recovered);
            drop(other_admissions);
        }
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_cbor_read_keeps_admission_until_blocking_worker_exits() -> Result<()> {
        use std::time::Duration;

        let (_tempdir, mut registry) =
            test_monad_profile_registry("cashweb-registry--cancelled-cbor-read-worker");
        registry.profile_read_validation_admission = Arc::new(tokio::sync::Semaphore::new(1));
        let (gate, started_rx) = TestProfileWorkerGate::new();
        registry.profile_read_worker_gate = Some(Arc::clone(&gate));
        let registry = Arc::new(registry);
        let admission = registry.try_acquire_profile_read_validation().unwrap();
        let worker_registry = Arc::clone(&registry);
        let request = tokio::spawn(async move {
            worker_registry
                .get_validated_monad_profile_cbor(Address([0; 20]), admission)
                .await
        });
        started_rx.await.unwrap();

        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(registry.try_acquire_profile_read_validation().is_err());
        gate.release();
        let recovered = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(admission) = registry.try_acquire_profile_read_validation() {
                    break admission;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking read worker released admission after exiting");
        drop(recovered);
        Ok(())
    }

    #[test]
    fn missing_and_registered_recipients_both_execute_one_signature_verification() -> Result<()> {
        let (_tempdir, registry) =
            test_monad_profile_registry("cashweb-registry--registry-recipient-auth-work");
        let seckey = registry.ecc.seckey_from_array([9; 32])?;
        let (signed, registered) = sign_monad_profile(&seckey, &sample_monad_profile(1000));
        registry.put_monad_profile(registered, signed)?;
        let wrong_digest = Sha256::digest(b"wrong digest".as_slice().into());
        let bad_signature = registry
            .ecc
            .sign(&seckey, wrong_digest.byte_array().clone())
            .to_vec();
        let requested_digest = [0x77; 32];

        for recipient in [registered, crate::monad_http::Address([0xee; 20])] {
            let calls = std::cell::Cell::new(0);
            assert!(!registry.verify_monad_recipient_signature_observed(
                recipient,
                requested_digest,
                &bad_signature,
                || calls.set(calls.get() + 1),
            )?);
            assert_eq!(
                calls.get(),
                1,
                "each result executes exactly one ECDSA verify"
            );
        }
        Ok(())
    }
}
