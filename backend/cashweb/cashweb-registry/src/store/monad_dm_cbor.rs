//! Lazy isolated canonical DM persistence. The original signed request has exactly one owner.
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};

use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue};
use rocksdb::{IteratorMode, Options, ReadOptions, WriteBatch, WriteOptions};

use crate::{
    directory_runtime::DirectoryRuntime,
    http::monad_message_cbor::{CanonicalError, ExactRequest, Result, SubmissionEcho},
    monad_http::{Address, Hash32},
    monad_outbox::financial::CanonicalPaymentInput,
    store::{
        monad_messages::ChallengeConsumption,
        monad_outbox::{MonadOutboxMember, MonadOutboxMemberState, MonadOutboxTerminal},
    },
};

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Phase {
    Pending,
    FullyConfirmed,
    Delivered(i64),
    Terminal(MonadOutboxTerminal),
}
#[derive(Debug, Clone)]
pub(crate) struct Claim {
    pub(crate) request: ExactRequest,
    pub(crate) policy: FrozenCanonicalPolicy,
    pub(crate) members: Vec<MonadOutboxMember>,
    pub(crate) phase: Phase,
    pub(crate) obligation_id: [u8; 32],
    pub(crate) created: i64,
    pub(crate) updated: i64,
    pub(crate) expires: i64,
    pub(crate) max_attempts: u32,
    pub(crate) backoff_base_ms: u64,
    pub(crate) max_backoff_ms: u64,
    pub(crate) reservation: bool,
    /// Explicit durable recipient ACK, never inferred from released capacity or delivery.
    pub(crate) acknowledged: bool,
    /// Admission-time maximum lifecycle footprint, never reclaimed by a transition.
    pub(crate) reserved_charge: u64,
}

const MAX_AUTH_NONCES: usize = 4096;

/// Binary CBOR metadata and every possible bounded lifecycle index/member.
/// See the actual-encoder boundary probes; this does not allocate a future body.
pub(crate) fn reserved_footprint(request: &ExactRequest, members: usize) -> Result<u64> {
    let charge = request
        .body()
        .len()
        .checked_add(8192)
        .and_then(|bytes| {
            members
                .checked_mul(662)
                .and_then(|overhead| bytes.checked_add(overhead))
        })
        .ok_or(CanonicalError::TooLarge)?;
    u64::try_from(charge).map_err(|_| CanonicalError::TooLarge)
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
    pub(crate) fn recoverable(&self) -> bool {
        self.reservation
            && !matches!(self.phase, Phase::Delivered(_))
            && self
                .members
                .iter()
                .any(|m| m.exposed || matches!(m.state, MonadOutboxMemberState::Confirmed { .. }))
    }
}

/// One private lifetime per Registry, no eager CF or filesystem effect.
#[derive(Debug)]
pub(crate) struct Owner {
    path: PathBuf,
    db: Mutex<Option<rocksdb::DB>>,
    directory: Mutex<Weak<DirectoryRuntime>>,
    broadcast: tokio::sync::broadcast::Sender<FinalizedEnvelope>,
}
impl Owner {
    pub(crate) fn new(legacy: PathBuf) -> Self {
        let (broadcast, _) = tokio::sync::broadcast::channel(1024);
        Self {
            path: legacy.with_extension("monad-dm-cbor-v1"),
            db: Mutex::new(None),
            directory: Mutex::new(Weak::new()),
            broadcast,
        }
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
    /// Exact immutable lookup runs before fresh-directory or live admission policy.
    /// The ordinary hash selects a row; complete bytes remain the comparator.
    pub(crate) fn find_request(&self, request: &ExactRequest) -> Result<Option<Claim>> {
        self.with(false, |db| find_request_locked(db, request))
            .map(Option::flatten)
    }
    pub(crate) fn financial_usage(
        &self,
        recipient: Address,
    ) -> Result<crate::monad_outbox::financial::AdmissionUsage> {
        self.with(false, |db| financial_usage_locked(db, recipient))
            .map(|usage| usage.unwrap_or_default())
    }
    /// Store a checked message in the recipient's inbox, in one durable write. An exact repeat
    /// returns what is already stored. A refusal (a payment already used for another message)
    /// leaves nothing behind. The number of messages already stored never refuses one.
    ///
    /// `now` is the caller's clock. The delivery time is decided here, under the store's lock:
    /// see [`deliver`].
    pub(crate) fn claim(&self, input: CanonicalPaymentInput, now: i64) -> Result<Claim> {
        let mut candidate = input.into_claim(now)?;
        let (claim, stored) = self
            .with(true, |db| {
                if let Some(existing) = find_request_locked(db, &candidate.request)? {
                    return Ok((existing, false));
                }
                if let Some(existing) = load(db, &candidate.policy.payload_hash)? {
                    if !existing.request.exact_equal(&candidate.request)
                        || existing.policy.network != candidate.policy.network
                        || existing.policy.sender_p != candidate.policy.sender_p
                        || existing.policy.recipient_p != candidate.policy.recipient_p
                        || existing.policy.sender_t1 != candidate.policy.sender_t1
                        || existing.policy.recipient_t1 != candidate.policy.recipient_t1
                    {
                        return Err(CanonicalError::Conflict);
                    }
                    return Ok((existing, false));
                }
                // One signed payment pays for one message. Nothing on chain names the message, so
                // this durable index is what stops a payment being claimed again for another body.
                for member in &candidate.members {
                    if db
                        .get_pinned(payment_key(&member.tx_hash))
                        .map_err(|_| CanonicalError::Unavailable)?
                        .is_some()
                    {
                        return Err(CanonicalError::Conflict);
                    }
                }
                let mut batch = WriteBatch::default();
                deliver(db, &mut batch, &mut candidate, now)?;
                append_owner(&mut batch, &candidate.policy.payload_hash, &candidate)?;
                for member in &candidate.members {
                    batch.put(
                        member_key(&candidate.policy.payload_hash, member.child_index),
                        encode_member(member)?,
                    );
                    batch.put(payment_key(&member.tx_hash), candidate.policy.payload_hash);
                }
                batch.put(
                    identity_key(&candidate.request),
                    candidate.policy.payload_hash,
                );
                write(db, batch)?;
                Ok((candidate, true))
            })?
            .ok_or(CanonicalError::Unavailable)?;
        if stored {
            self.announce(&claim);
        }
        Ok(claim)
    }
    #[allow(dead_code)]
    pub(crate) fn terminal(
        &self,
        hash: &[u8; 32],
        reason: MonadOutboxTerminal,
        now: i64,
    ) -> Result<()> {
        self.with(false, |db| {
            let mut claim = load(db, hash)?.ok_or(CanonicalError::Unavailable)?;
            if matches!(claim.phase, Phase::Delivered(_) | Phase::Terminal(_)) {
                return Ok(());
            }
            claim.phase = Phase::Terminal(reason);
            claim.updated = now;
            claim.reservation = claim.recoverable();
            let mut batch = WriteBatch::default();
            append_owner(&mut batch, hash, &claim)?;
            write(db, batch)
        })?
        .ok_or(CanonicalError::Unavailable)
    }
    /// Put an already stored message in the recipient's inbox. Only a row written by the
    /// earlier relay, which held a message back until its payments confirmed, is ever stored
    /// without being delivered; a resend of such a message delivers it here.
    pub(crate) fn finalize(&self, hash: &[u8; 32], now: i64) -> Result<Claim> {
        let (claim, newly_finalized) = self
            .with(false, |db| {
                let mut claim = load(db, hash)?.ok_or(CanonicalError::Unavailable)?;
                if matches!(claim.phase, Phase::Delivered(_)) {
                    return Ok((claim, false));
                }
                claim.reservation = false;
                let mut batch = WriteBatch::default();
                deliver(db, &mut batch, &mut claim, now)?;
                append_owner(&mut batch, hash, &claim)?;
                write(db, batch)?;
                Ok((claim, true))
            })?
            .ok_or(CanonicalError::Unavailable)?;
        if newly_finalized {
            self.announce(&claim);
        }
        Ok(claim)
    }
    /// Tell open mailbox sockets about a message that has just been delivered.
    fn announce(&self, claim: &Claim) {
        if let (Ok(sender), Ok(recipient), Phase::Delivered(time)) = (
            claim.policy.sender(),
            claim.policy.recipient(),
            &claim.phase,
        ) {
            let _ = self.broadcast.send(FinalizedEnvelope {
                sender,
                recipient,
                payload_hash: claim.policy.payload_hash,
                submission_identity: claim.request.submission_identity(),
                timestamp: *time,
                delivery: claim.request.delivery().to_vec(),
                context: claim.request.context().to_vec(),
            });
        }
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
            let mut inspected = 0usize;
            for item in db.iterator_opt(IteratorMode::Start, prefix_options(b"N")?) {
                let (row, value) = item.map_err(|_| CanonicalError::Unavailable)?;
                #[cfg(test)]
                record_read(&row, &value);
                if row.first() != Some(&b'N') {
                    continue;
                }
                inspected += 1;
                if inspected > MAX_AUTH_NONCES {
                    return Err(CanonicalError::Unavailable);
                }
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
                return Ok(ChallengeConsumption::AtCapacity);
            }
            batch.put(key, expires.to_be_bytes());
            write(db, batch)?;
            Ok(ChallengeConsumption::Consumed)
        })?
        .ok_or(CanonicalError::Unavailable)
    }
    pub(crate) fn inbox(
        &self,
        recipient: Address,
        since: i64,
        after: Option<(i64, [u8; 32])>,
        limit: usize,
    ) -> Result<Vec<Claim>> {
        self.with(false, |db| {
            let mut prefix = b"I".to_vec();
            prefix.extend_from_slice(&recipient.0);
            let mut result = Vec::new();
            for item in db.iterator_opt(IteratorMode::Start, prefix_options(&prefix)?) {
                let (key, value) = item.map_err(|_| CanonicalError::Unavailable)?;
                #[cfg(test)]
                record_read(&key, &value);
                if !key.starts_with(&prefix) {
                    continue;
                }
                if key.len() != 61 {
                    return Err(CanonicalError::Unavailable);
                }
                let timestamp = i64::from_be_bytes(key[21..29].try_into().unwrap());
                let hash: [u8; 32] = key[29..].try_into().unwrap();
                if timestamp < since || after.is_some_and(|cursor| (timestamp, hash) <= cursor) {
                    continue;
                }
                if value.as_ref() != hash {
                    return Err(CanonicalError::Unavailable);
                }
                let claim = load(db, &hash)?.ok_or(CanonicalError::Unavailable)?;
                if claim.policy.recipient() != Ok(recipient)
                    || claim.phase != Phase::Delivered(timestamp)
                {
                    return Err(CanonicalError::Unavailable);
                }
                result.push(claim);
                if result.len() == limit {
                    break;
                }
            }
            Ok(result)
        })
        .map(|rows| rows.unwrap_or_default())
    }
    pub(crate) fn mailbox(
        &self,
        address: Address,
        since: i64,
        after: Option<(i64, [u8; 32])>,
        limit: usize,
    ) -> Result<Vec<(Claim, MailboxDirection)>> {
        self.with(false, |db| {
            let mut i_prefix = b"I".to_vec();
            i_prefix.extend_from_slice(&address.0);
            let mut o_prefix = b"O".to_vec();
            o_prefix.extend_from_slice(&address.0);

            let mut i_iter = db
                .iterator_opt(IteratorMode::Start, prefix_options(&i_prefix)?)
                .fuse();
            let mut o_iter = db
                .iterator_opt(IteratorMode::Start, prefix_options(&o_prefix)?)
                .fuse();

            let mut result = Vec::new();
            if limit == 0 {
                return Ok(result);
            }

            fn next_entry(
                iter: &mut impl Iterator<
                    Item = std::result::Result<(Box<[u8]>, Box<[u8]>), rocksdb::Error>,
                >,
                prefix: &[u8],
                since: i64,
                after: Option<(i64, [u8; 32])>,
            ) -> Result<Option<(i64, [u8; 32])>> {
                for item in iter {
                    let (key, value) = item.map_err(|_| CanonicalError::Unavailable)?;
                    #[cfg(test)]
                    record_read(&key, &value);
                    if !key.starts_with(prefix) {
                        continue;
                    }
                    if key.len() != 61 {
                        return Err(CanonicalError::Unavailable);
                    }
                    let timestamp = i64::from_be_bytes(key[21..29].try_into().unwrap());
                    let hash: [u8; 32] = key[29..].try_into().unwrap();
                    if timestamp < since || after.is_some_and(|cursor| (timestamp, hash) <= cursor)
                    {
                        continue;
                    }
                    if value.as_ref() != hash {
                        return Err(CanonicalError::Unavailable);
                    }
                    return Ok(Some((timestamp, hash)));
                }
                Ok(None)
            }

            let mut i_cand = next_entry(&mut i_iter, &i_prefix, since, after)?;
            let mut o_cand = next_entry(&mut o_iter, &o_prefix, since, after)?;

            while result.len() < limit {
                let (take_i, timestamp, hash) = match (i_cand, o_cand) {
                    (Some(i_pos), Some(o_pos)) => {
                        if i_pos <= o_pos {
                            (true, i_pos.0, i_pos.1)
                        } else {
                            (false, o_pos.0, o_pos.1)
                        }
                    }
                    (Some(i_pos), None) => (true, i_pos.0, i_pos.1),
                    (None, Some(o_pos)) => (false, o_pos.0, o_pos.1),
                    (None, None) => break,
                };

                if take_i {
                    i_cand = next_entry(&mut i_iter, &i_prefix, since, after)?;
                } else {
                    o_cand = next_entry(&mut o_iter, &o_prefix, since, after)?;
                }

                let claim = load(db, &hash)?.ok_or(CanonicalError::Unavailable)?;
                if claim.phase != Phase::Delivered(timestamp) {
                    return Err(CanonicalError::Unavailable);
                }

                let direction = if take_i {
                    if claim.policy.recipient() != Ok(address) {
                        return Err(CanonicalError::Unavailable);
                    }
                    MailboxDirection::In
                } else {
                    if claim.policy.sender() != Ok(address) {
                        return Err(CanonicalError::Unavailable);
                    }
                    MailboxDirection::Out
                };

                result.push((claim, direction));
            }

            Ok(result)
        })
        .map(|rows| rows.unwrap_or_default())
    }
    pub(crate) fn recovery(
        &self,
        recipient: Address,
        after: Option<[u8; 32]>,
        limit: usize,
    ) -> Result<Vec<Claim>> {
        self.with(false, |db| {
            let mut result = Vec::new();
            for item in db.iterator_opt(IteratorMode::Start, prefix_options(b"J")?) {
                let (key, header) = item.map_err(|_| CanonicalError::Unavailable)?;
                #[cfg(test)]
                record_read(&key, &header);
                if key.first() != Some(&b'J') {
                    continue;
                }
                let hash: [u8; 32] = key[1..]
                    .try_into()
                    .map_err(|_| CanonicalError::Unavailable)?;
                if after.is_some_and(|cursor| hash <= cursor) {
                    continue;
                }
                let metadata = decode_usage_header(&header)?;
                if metadata.owner != recipient {
                    continue;
                }
                let claim = load(db, &hash)?.ok_or(CanonicalError::Unavailable)?;
                if claim.policy.recipient() != Ok(recipient) {
                    return Err(CanonicalError::Unavailable);
                }
                if claim.recoverable() {
                    result.push(claim);
                    if result.len() == limit {
                        break;
                    }
                }
            }
            Ok(result)
        })
        .map(|rows| rows.unwrap_or_default())
    }
    #[allow(dead_code)]
    pub(crate) fn acknowledge(
        &self,
        recipient: Address,
        hash: [u8; 32],
        obligation: [u8; 32],
        now: i64,
    ) -> Result<()> {
        self.with(false, |db| {
            let mut claim = load(db, &hash)?.ok_or(CanonicalError::Unauthorized)?;
            if claim.policy.recipient() != Ok(recipient) || claim.obligation_id != obligation {
                return Err(CanonicalError::Unauthorized);
            }
            if !matches!(claim.phase, Phase::Terminal(_)) {
                return Err(CanonicalError::ActiveObligation);
            }
            if claim.acknowledged {
                return Ok(());
            }
            if !claim.recoverable() {
                return Err(CanonicalError::Unauthorized);
            }
            // Preserve exact terminal owner, but release only this authenticated obligation.
            claim.reservation = false;
            claim.acknowledged = true;
            claim.updated = now;
            // Keep the confirmed/exposed member history intact. The durable
            // reservation flag records acknowledgment without rewriting facts.
            let mut batch = WriteBatch::default();
            append_owner(&mut batch, &hash, &claim)?;
            write(db, batch)
        })?
        .ok_or(CanonicalError::Unauthorized)
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

fn usage_key(hash: &[u8; 32]) -> Vec<u8> {
    let mut key = b"J".to_vec();
    key.extend_from_slice(hash);
    key
}
fn encode_usage_header(claim: &Claim) -> Result<Vec<u8>> {
    encode(CborValue::Array(vec![
        int(1),
        blob(claim.policy.recipient()?.0),
        CborValue::Bool(matches!(
            claim.phase,
            Phase::Pending | Phase::FullyConfirmed
        )),
        CborValue::Bool(claim.reservation),
        int(claim.reserved_charge),
        CborValue::Bool(matches!(
            claim.members.first().map(|m| &m.state),
            Some(MonadOutboxMemberState::Confirmed { .. })
        )),
    ]))
}
fn append_owner(batch: &mut WriteBatch, hash: &[u8; 32], claim: &Claim) -> Result<()> {
    if *hash != claim.policy.payload_hash
        || claim.reserved_charge != reserved_footprint(&claim.request, claim.members.len())?
    {
        return Err(CanonicalError::Unavailable);
    }
    validate_acknowledged(claim)?;
    let row = encode_claim(claim)?;
    let header = encode_usage_header(claim)?;
    if header.len() > 128 || row.len().saturating_add(33) as u64 > claim.reserved_charge {
        return Err(CanonicalError::Unavailable);
    }
    batch.put(row_key(hash), row);
    batch.put(usage_key(hash), header);
    Ok(())
}
fn validate_acknowledged(claim: &Claim) -> Result<()> {
    if claim.acknowledged
        && (claim.reservation
            || !matches!(claim.phase, Phase::Terminal(_))
            || !claim.members.iter().any(|member| {
                member.exposed || matches!(member.state, MonadOutboxMemberState::Confirmed { .. })
            }))
    {
        return Err(CanonicalError::Unavailable);
    }
    Ok(())
}
#[cfg(test)]
thread_local! {
    static READ_BYTES: std::cell::RefCell<std::collections::BTreeMap<u8, usize>> =
        std::cell::RefCell::new(std::collections::BTreeMap::new());
}
#[cfg(test)]
fn record_read(key: &[u8], value: &[u8]) {
    READ_BYTES.with(|counts| *counts.borrow_mut().entry(key[0]).or_default() += value.len());
}

/// Bound the native iterator before RocksDB copies any value into an owned box.
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

struct UsageHeader {
    owner: Address,
    active: bool,
    reserved: bool,
    charge: u64,
    confirmed: bool,
}
fn decode_usage_header(raw: &[u8]) -> Result<UsageHeader> {
    if raw.len() > 128 {
        return Err(CanonicalError::Unavailable);
    }
    let value = decode_canonical(raw).map_err(|_| CanonicalError::Unavailable)?;
    let [version, owner, active, reserved, charge, confirmed] = array(&value)? else {
        return Err(CanonicalError::Unavailable);
    };
    if number(version)? != 1 {
        return Err(CanonicalError::Unavailable);
    }
    let header = UsageHeader {
        owner: Address(fixed(owner)?),
        active: boolean(active)?,
        reserved: boolean(reserved)?,
        charge: convert(charge)?,
        confirmed: boolean(confirmed)?,
    };
    if header.active && !header.reserved
        || header.charge < 8192
        || header.charge
            > (crate::http::monad_message_cbor::MAX_REQUEST_BYTES + 8192 + 64 * 662) as u64
    {
        return Err(CanonicalError::Unavailable);
    }
    Ok(header)
}

fn financial_usage_locked(
    db: &rocksdb::DB,
    recipient: Address,
) -> Result<crate::monad_outbox::financial::AdmissionUsage> {
    let mut usage = crate::monad_outbox::financial::AdmissionUsage::default();
    for item in db.iterator_opt(IteratorMode::Start, prefix_options(b"J")?) {
        let (key, value) = item.map_err(|_| CanonicalError::Unavailable)?;
        #[cfg(test)]
        record_read(&key, &value);
        if key.first() != Some(&b'J') {
            continue;
        }
        if key.len() != 33 || value.len() > 128 {
            return Err(CanonicalError::Unavailable);
        }
        let UsageHeader {
            owner,
            active,
            reserved,
            charge,
            confirmed,
        } = decode_usage_header(&value)?;
        let add = |a: u64, b: u64| a.checked_add(b).ok_or(CanonicalError::Unavailable);
        if active {
            usage.active = add(usage.active, 1)?;
        }
        if reserved {
            usage.global_records = add(usage.global_records, 1)?;
            usage.global_bytes = add(usage.global_bytes, charge)?;
            if owner == recipient {
                usage.recipient_records = add(usage.recipient_records, 1)?;
                usage.recipient_bytes = add(usage.recipient_bytes, charge)?;
                if !confirmed {
                    usage.unconfirmed = add(usage.unconfirmed, 1)?;
                }
            }
        }
    }
    Ok(usage)
}

fn find_request_locked(db: &rocksdb::DB, request: &ExactRequest) -> Result<Option<Claim>> {
    use frank_cbor::{relay_context, validate_frame, TypedPayload, ValidationResult};
    let indexed = db
        .get(identity_key(request))
        .map_err(|_| CanonicalError::Unavailable)?;
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
    let lookup = if let Some(indexed) = indexed.as_ref() {
        let reference: [u8; 32] = indexed
            .as_slice()
            .try_into()
            .map_err(|_| CanonicalError::Unavailable)?;
        if reference != hash {
            return Err(CanonicalError::Conflict);
        }
        reference
    } else {
        hash
    };
    let Some(existing) = load(db, &lookup)? else {
        if indexed.is_some() {
            return Err(CanonicalError::Unavailable);
        }
        return Ok(None);
    };
    if !existing.request.exact_equal(request) {
        return Err(CanonicalError::Conflict);
    }
    Ok(Some(existing))
}
fn member_key(hash: &[u8; 32], index: u32) -> Vec<u8> {
    let mut key = b"M".to_vec();
    key.extend_from_slice(hash);
    key.extend_from_slice(&index.to_be_bytes());
    key
}
/// Used-payment index: signed transaction hash to the one payload hash it paid for.
/// Entries are written with the owner and never removed, including after terminal or ACK.
fn payment_key(tx_hash: &Hash32) -> Vec<u8> {
    let mut key = b"T".to_vec();
    key.extend_from_slice(&tx_hash.0);
    key
}
fn int(n: impl Into<i128>) -> CborValue {
    CborValue::Int(n.into())
}
fn blob(bytes: impl AsRef<[u8]>) -> CborValue {
    CborValue::Bytes(bytes.as_ref().to_vec())
}
fn encode(value: CborValue) -> Result<Vec<u8>> {
    encode_canonical(&value).map_err(|_| CanonicalError::Unavailable)
}
fn fields(value: &CborValue, count: usize) -> Result<&[(u64, CborValue)]> {
    let CborValue::Map(rows) = value else {
        return Err(CanonicalError::Unavailable);
    };
    if rows.len() != count
        || rows
            .iter()
            .enumerate()
            .any(|(i, (key, _))| *key != i as u64)
    {
        return Err(CanonicalError::Unavailable);
    }
    Ok(rows)
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
fn array(value: &CborValue) -> Result<&[CborValue]> {
    if let CborValue::Array(a) = value {
        Ok(a)
    } else {
        Err(CanonicalError::Unavailable)
    }
}
fn boolean(value: &CborValue) -> Result<bool> {
    if let CborValue::Bool(b) = value {
        Ok(*b)
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
fn terminal_code(t: MonadOutboxTerminal) -> u8 {
    match t {
        MonadOutboxTerminal::StaleNonce => 0,
        MonadOutboxTerminal::VerificationFailed => 1,
        MonadOutboxTerminal::BroadcastRejected => 2,
        MonadOutboxTerminal::CorruptReference => 3,
        MonadOutboxTerminal::InsufficientTotal => 4,
        MonadOutboxTerminal::Expired => 5,
        MonadOutboxTerminal::AttemptsExhausted => 6,
    }
}
fn terminal_from(n: u8) -> Result<MonadOutboxTerminal> {
    Ok(match n {
        0 => MonadOutboxTerminal::StaleNonce,
        1 => MonadOutboxTerminal::VerificationFailed,
        2 => MonadOutboxTerminal::BroadcastRejected,
        3 => MonadOutboxTerminal::CorruptReference,
        4 => MonadOutboxTerminal::InsufficientTotal,
        5 => MonadOutboxTerminal::Expired,
        6 => MonadOutboxTerminal::AttemptsExhausted,
        _ => return Err(CanonicalError::Unavailable),
    })
}
fn encode_claim(c: &Claim) -> Result<Vec<u8>> {
    let p = &c.policy;
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
    let phase = match c.phase {
        Phase::Pending => vec![int(0)],
        Phase::FullyConfirmed => vec![int(1)],
        Phase::Delivered(time) => vec![int(2), int(time)],
        Phase::Terminal(reason) => vec![int(3), int(terminal_code(reason))],
    };
    encode(cbor_map(vec![
        (0, int(1)),
        (1, blob(c.request.body())),
        (2, CborValue::Text(c.request.content_type().into())),
        (3, policy),
        (
            4,
            CborValue::Array(
                c.members
                    .iter()
                    .map(|m| CborValue::Array(vec![int(m.child_index), blob(m.tx_hash.0)]))
                    .collect(),
            ),
        ),
        (5, CborValue::Array(phase)),
        (6, blob(c.obligation_id)),
        (7, int(c.created)),
        (8, int(c.updated)),
        (9, int(c.expires)),
        (10, int(c.max_attempts)),
        (11, int(c.backoff_base_ms)),
        (12, int(c.max_backoff_ms)),
        (13, CborValue::Bool(c.reservation)),
        (14, int(c.reserved_charge)),
        (15, CborValue::Bool(c.acknowledged)),
    ]))
}
fn load(db: &rocksdb::DB, hash: &[u8; 32]) -> Result<Option<Claim>> {
    let Some(raw) = db
        .get(row_key(hash))
        .map_err(|_| CanonicalError::Unavailable)?
    else {
        return Ok(None);
    };
    #[cfg(test)]
    record_read(&row_key(hash), &raw);
    let value = decode_canonical(&raw).map_err(|_| CanonicalError::Unavailable)?;
    let rows = fields(&value, 16)?;
    let v = |i: usize| &rows[i].1;
    if number(v(0))? != 1 {
        return Err(CanonicalError::Unavailable);
    }
    let request = ExactRequest::parse(bytes(v(1))?.to_vec(), text(v(2))?.into())
        .map_err(|_| CanonicalError::Unavailable)?;
    let p = array(v(3))?;
    if p.len() != 11 {
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
    if policy.payload_hash != *hash
        || policy.sender_p.len() != 33
        || policy.recipient_p.len() != 33
        || policy.sender_m.len() != 33
        || policy.recipient_m.len() != 33
        || policy.stamp.len() != 33
    {
        return Err(CanonicalError::Unavailable);
    }
    let refs = array(v(4))?;
    if refs.len() != request.transaction_count() {
        return Err(CanonicalError::Unavailable);
    }
    let mut members = Vec::with_capacity(refs.len());
    for reference in refs {
        let r = array(reference)?;
        if r.len() != 2 {
            return Err(CanonicalError::Unavailable);
        }
        let index = convert(&r[0])?;
        let tx_hash = Hash32(fixed(&r[1])?);
        let raw = db
            .get(member_key(hash, index))
            .map_err(|_| CanonicalError::Unavailable)?
            .ok_or(CanonicalError::Unavailable)?;
        let member = decode_member(&raw)?;
        if member.child_index != index || member.tx_hash != tx_hash {
            return Err(CanonicalError::Unavailable);
        }
        // Every reader of an owner (retry, replay, publication, recovery, ACK) rechecks that
        // each of its payments is still indexed to this message and no other.
        if db
            .get_pinned(payment_key(&tx_hash))
            .map_err(|_| CanonicalError::Unavailable)?
            .as_deref()
            != Some(hash.as_slice())
        {
            return Err(CanonicalError::Unavailable);
        }
        members.push(member);
    }
    let phase = array(v(5))?;
    let phase = match phase {
        [n] if number(n)? == 0 => Phase::Pending,
        [n] if number(n)? == 1 => Phase::FullyConfirmed,
        [n, time] if number(n)? == 2 => Phase::Delivered(convert(time)?),
        [n, t] if number(n)? == 3 => Phase::Terminal(terminal_from(convert(t)?)?),
        _ => return Err(CanonicalError::Unavailable),
    };
    let claim = Claim {
        request,
        policy,
        members,
        phase,
        obligation_id: fixed(v(6))?,
        created: convert(v(7))?,
        updated: convert(v(8))?,
        expires: convert(v(9))?,
        max_attempts: convert(v(10))?,
        backoff_base_ms: convert(v(11))?,
        max_backoff_ms: convert(v(12))?,
        reservation: boolean(v(13))?,
        reserved_charge: convert(v(14))?,
        acknowledged: boolean(v(15))?,
    };
    if claim.reserved_charge != reserved_footprint(&claim.request, claim.members.len())? {
        return Err(CanonicalError::Unavailable);
    }
    crate::monad_outbox::financial::validate_canonical_retained(&claim)?;
    validate_acknowledged(&claim)?;
    let header = db
        .get(usage_key(hash))
        .map_err(|_| CanonicalError::Unavailable)?
        .ok_or(CanonicalError::Unavailable)?;
    if header.as_slice() != encode_usage_header(&claim)?.as_slice() {
        return Err(CanonicalError::Unavailable);
    }
    Ok(Some(claim))
}
fn encode_member(m: &MonadOutboxMember) -> Result<Vec<u8>> {
    if m.last_error.len() > 512 {
        return Err(CanonicalError::Unavailable);
    }
    let state = match m.state {
        MonadOutboxMemberState::Pending => vec![int(0)],
        MonadOutboxMemberState::Confirmed {
            value_wei,
            block_number,
        } => vec![int(1), blob(value_wei.to_be_bytes()), int(block_number)],
        MonadOutboxMemberState::Terminal(t) => vec![int(2), int(terminal_code(t))],
    };
    encode(CborValue::Array(vec![
        int(m.child_index),
        blob(m.tx_hash.0),
        CborValue::Array(state),
        int(m.attempts),
        CborValue::Bool(m.exposed),
        int(m.lease_generation),
        int(m.lease_until_ms),
        int(m.next_replay_at_ms),
        int(m.updated_at_ms),
        CborValue::Text(m.last_error.clone()),
    ]))
}
fn decode_member(raw: &[u8]) -> Result<MonadOutboxMember> {
    let value = decode_canonical(raw).map_err(|_| CanonicalError::Unavailable)?;
    let a = array(&value)?;
    if a.len() != 10 {
        return Err(CanonicalError::Unavailable);
    }
    let state = match array(&a[2])? {
        [n] if number(n)? == 0 => MonadOutboxMemberState::Pending,
        [n, value, block] if number(n)? == 1 => MonadOutboxMemberState::Confirmed {
            value_wei: u128::from_be_bytes(fixed(value)?),
            block_number: convert(block)?,
        },
        [n, t] if number(n)? == 2 => MonadOutboxMemberState::Terminal(terminal_from(convert(t)?)?),
        _ => return Err(CanonicalError::Unavailable),
    };
    Ok(MonadOutboxMember {
        child_index: convert(&a[0])?,
        tx_hash: Hash32(fixed(&a[1])?),
        state,
        attempts: convert(&a[3])?,
        exposed: boolean(&a[4])?,
        lease_generation: convert(&a[5])?,
        lease_until_ms: convert(&a[6])?,
        next_replay_at_ms: convert(&a[7])?,
        updated_at_ms: convert(&a[8])?,
        last_error: text(&a[9])?.into(),
    })
}
fn identity_key(request: &ExactRequest) -> Vec<u8> {
    let mut key = b"S".to_vec();
    key.extend_from_slice(&request.submission_identity());
    key
}
/// A delivered message's place in a mailbox: `I` for the recipient's inbox, `O` for the
/// sender's sent copies, ordered by delivery time.
fn mailbox_key(kind: u8, address: Address, time: i64, hash: &[u8; 32]) -> Vec<u8> {
    let mut key = vec![kind];
    key.extend_from_slice(&address.0);
    key.extend_from_slice(&time.to_be_bytes());
    key.extend_from_slice(hash);
    key
}
/// Where the last delivery time issued by this store is kept.
const LAST_DELIVERY_KEY: &[u8] = b"L";

/// Deliver a message as part of `batch`: give it its delivery time and put it in the
/// recipient's inbox and the sender's own mailbox under that time.
///
/// A reader asks for "everything after the last time I saw", so a delivery time must never
/// be equal to or earlier than one already issued, or a reader who has moved past it would
/// never be given the message. The time is therefore taken here, under the store's lock at
/// commit, and is the clock or one millisecond after the last time issued, whichever is
/// later: two messages in the same millisecond, or a clock that steps back, still get
/// increasing times. The last time issued is stored with the message, so this holds across
/// restarts.
fn deliver(db: &rocksdb::DB, batch: &mut WriteBatch, claim: &mut Claim, now: i64) -> Result<()> {
    let last = match db
        .get_pinned(LAST_DELIVERY_KEY)
        .map_err(|_| CanonicalError::Unavailable)?
    {
        Some(raw) => i64::from_be_bytes(
            raw.as_ref()
                .try_into()
                .map_err(|_| CanonicalError::Unavailable)?,
        ),
        None => i64::MIN,
    };
    let time = now.max(last.checked_add(1).ok_or(CanonicalError::Unavailable)?);
    claim.phase = Phase::Delivered(time);
    claim.updated = time;
    batch.put(LAST_DELIVERY_KEY, time.to_be_bytes());
    let hash = &claim.policy.payload_hash;
    let (sender, recipient) = (claim.policy.sender()?, claim.policy.recipient()?);
    batch.put(mailbox_key(b'I', recipient, time, hash), hash);
    if sender != recipient {
        batch.put(mailbox_key(b'O', sender, time, hash), hash);
    }
    Ok(())
}

#[cfg(test)]
mod encoding_tests {
    use super::*;

    // Actual populated RocksDB scan accounting. Poison owner bodies are deliberately
    // not valid submission authority: these metadata-only/negative reads must never load them.
    #[test]
    fn bounded_metadata_and_negative_pages_never_read_unrelated_owner_bodies() {
        let directory = tempfile::tempdir().unwrap();
        let owner = Owner::new(directory.path().join("legacy"));
        let mut options = Options::default();
        options.create_if_missing(true);
        let db = rocksdb::DB::open(&options, &owner.path).unwrap();
        let recipient = Address([1; 20]);
        let other = Address([2; 20]);
        let mut header_bytes = 0usize;
        for index in 0..16u8 {
            let hash = [index; 32];
            db.put(row_key(&hash), vec![0xff; 64 * 1024]).unwrap();
            let header = encode(CborValue::Array(vec![
                int(1),
                blob(other.0),
                CborValue::Bool(false),
                CborValue::Bool(true),
                int(8192),
                CborValue::Bool(false),
            ]))
            .unwrap();
            header_bytes += header.len();
            db.put(usage_key(&hash), header).unwrap();
        }
        *owner.db.lock().unwrap() = Some(db);
        READ_BYTES.with(|counts| counts.borrow_mut().clear());
        let usage = owner.financial_usage(recipient).unwrap();
        assert_eq!(usage.active, 0);
        assert!(owner.inbox(recipient, 0, None, 1).unwrap().is_empty());
        assert!(owner.recovery(recipient, None, 1).unwrap().is_empty());
        assert_eq!(
            owner
                .consume_challenge([3; 32], recipient, [4; 32], 100, 0, 30)
                .unwrap(),
            ChallengeConsumption::Consumed
        );
        assert_eq!(
            owner
                .consume_challenge([3; 32], recipient, [5; 32], 100, 0, 30)
                .unwrap(),
            ChallengeConsumption::Consumed
        );
        READ_BYTES.with(|counts| {
            let counts = counts.borrow();
            assert_eq!(counts.get(&b'R'), None);
            assert_eq!(counts.get(&b'I'), None);
            assert_eq!(counts.get(&b'J'), Some(&(2 * header_bytes)));
            assert_eq!(counts.get(&b'N'), Some(&8));
        });
    }

    // This exercises the private storage codec only. It creates no admitted
    // Current, chain confirmation, sealed payment input or publication authority.
    #[test]
    fn actual_binary_encoder_fits_reserved_lifecycle_extremes() {
        let boundary = "a".repeat(70);
        let transactions =
            encode(CborValue::Array((0..64).map(|_| blob([1u8])).collect())).unwrap();
        let mut body = Vec::new();
        for (name, media, bytes) in [
            ("delivery", "application/vnd.frank.cbor", vec![1; 65536]),
            ("context", "application/cbor", vec![2; 4096]),
            ("transactions", "application/cbor", transactions),
        ] {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: {media}\r\n\r\n").as_bytes());
            body.extend_from_slice(&bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let request =
            ExactRequest::parse(body, format!("multipart/form-data; boundary={boundary}")).unwrap();
        let mut diagnostic = "\"\\\0💸".repeat(100);
        let mut end = 512;
        while !diagnostic.is_char_boundary(end) {
            end -= 1;
        }
        diagnostic.truncate(end);
        let members: Vec<_> = (0..64)
            .map(|index| MonadOutboxMember {
                child_index: index,
                tx_hash: Hash32([3; 32]),
                state: MonadOutboxMemberState::Confirmed {
                    value_wei: u128::MAX,
                    block_number: u64::MAX,
                },
                attempts: u32::MAX,
                exposed: true,
                lease_generation: u64::MAX,
                lease_until_ms: i64::MIN,
                next_replay_at_ms: i64::MAX,
                updated_at_ms: i64::MIN,
                last_error: diagnostic.clone(),
            })
            .collect();
        for member in &members {
            assert!(encode_member(member).unwrap().len() <= 625);
        }
        let secp = secp256k1_abc::Secp256k1::new();
        let point = secp256k1_abc::PublicKey::from_secret_key(
            &secp,
            &secp256k1_abc::SecretKey::from_slice(&[1; 32]).unwrap(),
        )
        .serialize()
        .to_vec();
        let charge = reserved_footprint(&request, members.len()).unwrap();
        let mut claim = Claim {
            request,
            policy: FrozenCanonicalPolicy {
                network: "a".repeat(64),
                chain_id: u64::MAX,
                minimum: u128::MAX,
                sender_p: point.clone(),
                recipient_p: point.clone(),
                sender_m: point.clone(),
                recipient_m: point.clone(),
                stamp: point,
                sender_t1: [1; 32],
                recipient_t1: [2; 32],
                payload_hash: [3; 32],
            },
            members,
            phase: Phase::FullyConfirmed,
            obligation_id: [4; 32],
            created: i64::MIN,
            updated: i64::MAX,
            expires: i64::MAX,
            max_attempts: u32::MAX,
            backoff_base_ms: u64::MAX,
            max_backoff_ms: u64::MAX,
            reservation: true,
            reserved_charge: charge,
            acknowledged: false,
        };
        for phase in [
            Phase::Pending,
            Phase::FullyConfirmed,
            Phase::Delivered(i64::MAX),
            Phase::Terminal(MonadOutboxTerminal::AttemptsExhausted),
        ] {
            claim.phase = phase;
            let owner_bytes =
                row_key(&claim.policy.payload_hash).len() + encode_claim(&claim).unwrap().len();
            let member_bytes: usize = claim
                .members
                .iter()
                .map(|member| {
                    member_key(&claim.policy.payload_hash, member.child_index).len()
                        + encode_member(member).unwrap().len()
                })
                .sum();
            let header_bytes = usage_key(&claim.policy.payload_hash).len()
                + encode_usage_header(&claim).unwrap().len();
            // S identity, I inbox, A active, U recovery, H terminal and bounded
            // global/per-recipient accounting layouts are included at maxima.
            let remaining_indexes = 65 + 93 + 33 + 62 + 50 + 512;
            // T used-payment index: one 33-byte key and 32-byte owner reference per member.
            let payment_bytes = claim.members.len() * 65;
            assert!(
                (owner_bytes + member_bytes + header_bytes + remaining_indexes + payment_bytes)
                    as u64
                    <= charge
            );
        }
        claim.phase = Phase::Terminal(MonadOutboxTerminal::AttemptsExhausted);
        claim.reservation = false;
        claim.acknowledged = true;
        validate_acknowledged(&claim).unwrap();
        let acknowledged = encode_claim(&claim).unwrap();
        let decoded = decode_canonical(&acknowledged).unwrap();
        assert_eq!(fields(&decoded, 16).unwrap()[15].1, CborValue::Bool(true));
        let total = acknowledged.len()
            + 33
            + claim
                .members
                .iter()
                .map(|member| encode_member(member).unwrap().len() + 37 + 65)
                .sum::<usize>()
            + encode_usage_header(&claim).unwrap().len()
            + 33
            + 65
            + 93
            + 512;
        assert!(total as u64 <= charge);
        let mut invalid = claim.members[0].clone();
        invalid.last_error = "💸".repeat(129);
        assert!(encode_member(&invalid).is_err());
    }
}
