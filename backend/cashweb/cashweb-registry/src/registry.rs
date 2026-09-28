//! Module containing [`Registry`].

use std::sync::Arc;

use bitcoinsuite_core::{lotus_txid, Hashed, LotusAddress, Net, Sha256d};
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
    monad_profile_verify::verify_monad_profile,
    proto::{self, BroadcastMessage},
    store::{db::Db, pubkeyhash::PubKeyHash},
};

/// Cashweb [`Registry`] stores [`SignedPayload`]s containing [`proto::AddressMetadata`] for
/// addresses.
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
}

use self::RegistryError::*;

impl Registry {
    /// Construct new [`Registry`]
    pub fn new(db: Db, chain_adapter: Arc<dyn ChainAdapter>, net: Net) -> Self {
        Registry {
            db,
            ecc: EccSecp256k1::default(),
            chain_adapter,
            net,
        }
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

    pub(crate) fn get_monad_message_attempt(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
    ) -> Result<crate::store::monad_messages::MonadMessageAttemptClaim> {
        self.db.monad_messages().get_attempt(payload_hash, message)
    }

    /// Release an exact-set claim only when the relay knows no member was accepted. Ambiguous or
    /// partially verified attempts must remain bound to their original signed bytes.
    pub(crate) fn delete_monad_message_attempt(&self, payload_hash: &[u8]) -> Result<()> {
        self.db.monad_messages().delete_attempt(payload_hash)
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
    pub fn put_monad_profile(
        &self,
        address: Address,
        signed_profile: cashweb_payload::proto::SignedPayload,
    ) -> Result<()> {
        let verified = verify_monad_profile(&self.ecc, address, &signed_profile)?;

        if let Some(existing) = self.db.monad_profiles().get(&address)? {
            // Best-effort decode: `verify_monad_profile` already required the *new* payload to
            // decode as `proto::MonadProfile`; a previously-stored one that somehow doesn't
            // shouldn't block the new, valid write over it.
            if let Ok(existing_profile) = proto::MonadProfile::decode(existing.payload.as_slice()) {
                if existing_profile.timestamp >= verified.profile.timestamp {
                    return Err(MonadProfileTimestampNotMonotonicallyIncreasing {
                        previous: existing_profile.timestamp,
                        next: verified.profile.timestamp,
                    }
                    .into());
                }
            }
        }

        self.db.monad_profiles().put(&address, &signed_profile)?;
        Ok(())
    }

    /// Read a previously-registered Monad profile's `cashweb_payload::proto::SignedPayload`
    /// envelope. [`None`] if nothing is registered under `address`.
    ///
    /// Returns the raw envelope as stored (not re-verified) -- mirrors
    /// [`Registry::get_metadata`]'s Lotus-side "trust what already verified on the way in"
    /// behavior.
    pub fn get_monad_profile(
        &self,
        address: Address,
    ) -> Result<Option<cashweb_payload::proto::SignedPayload>> {
        self.db.monad_profiles().get(&address)
    }

    /// List every `(address, SignedPayload)` registered with the profile's own `timestamp >=
    /// since` (ticket #75), ordered by `timestamp` ascending -- see
    /// `crate::store::monad_profiles`'s module docs for the by-time index this reads, and
    /// `crate::http::monad_profile`'s module docs for how a bot uses this to auto-greet/auto-fund
    /// new signups.
    pub(crate) fn list_monad_profiles_since(
        &self,
        since: i64,
    ) -> Result<Vec<(Address, cashweb_payload::proto::SignedPayload)>> {
        self.db.monad_profiles().list_since(since)
    }

    /// Prefix-search registered Monad profiles by their normalized `display_name` (ticket #48),
    /// ordered by normalized name ascending, capped at `limit` (clamped to
    /// `store::monad_profiles::MAX_SEARCH_RESULTS` regardless of what the caller requests) -- see
    /// `crate::store::monad_profiles`'s module docs for the `CF_MONAD_PROFILES_BY_NAME` index this
    /// reads, and `crate::http::monad_profile`'s module docs for the route this backs.
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
        proto,
        registry::{
            GetMetadataRangeResult, PutBlockchainAction, PutMessageResult, PutMetadataResult,
            Registry, RegistryError,
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
}
