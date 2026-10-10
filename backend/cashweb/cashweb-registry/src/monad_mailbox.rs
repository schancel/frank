//! Process-owned configuration and authorization state for durable Monad direct messages.

use std::{fmt, sync::Arc, time::Duration};

use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::monad_http::{Address, HttpTransport};

type HmacSha256 = Hmac<Sha256>;

pub(crate) const CHALLENGE_TTL_MS: i64 = 60_000;
/// Used challenges one recipient may hold unexpired at once, that is per challenge lifetime
/// (60s). Only the signature-verified recipient can use one, and one recipient's use never
/// refuses another's: there is no bound over all recipients. The app's steady polling uses
/// about 8.6 a minute at a 7s interval.
pub(crate) const MAX_USED_CHALLENGES_PER_RECIPIENT: usize = 240;
const CHALLENGE_MAC_DOMAIN: &[u8] = b"frank:mailbox-challenge-mac:v1\0";
const CURSOR_MAC_DOMAIN: &[u8] = b"frank:mailbox-cursor-mac:v1\0";
const CURSOR_VERSION: u8 = 1;

/// Typed mailbox mode owned by the HTTP server.
#[derive(Debug, Clone)]
pub enum MonadMailboxRuntime {
    /// Admission is not installed and no RPC transport is reachable from the router.
    Disabled,
    /// Admission, private reads, and the background worker share this validated runtime.
    Enabled(Arc<EnabledMonadMailboxRuntime>),
}

/// What the mailbox needs to know about its chain and its own limits per request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailboxConfig {
    /// EVM chain id every payment must be signed for.
    pub expected_chain_id: u64,
    /// Longest one call to the node may take.
    pub rpc_timeout: Duration,
    /// Most private mailbox reads served at once; more are refused, not queued.
    pub private_read_concurrency: usize,
}

impl Default for MailboxConfig {
    fn default() -> Self {
        Self {
            expected_chain_id: 41_454,
            rpc_timeout: Duration::from_secs(10),
            private_read_concurrency: 256,
        }
    }
}

/// The relay's secret for signing what it hands to clients and later takes back: login
/// challenges, page cursors and RPC capabilities. Kept in a file beside the database so a
/// restart does not invalidate them. It is not a wallet key and guards no funds: losing it
/// only makes clients log in again.
#[derive(Clone)]
pub struct SessionSecret([u8; 32]);

impl fmt::Debug for SessionSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionSecret(<redacted>)")
    }
}

impl SessionSecret {
    /// A secret that lasts as long as this process.
    pub fn random() -> Self {
        let mut secret = [0; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        Self(secret)
    }

    /// Read the secret from `path`, creating the file (owner-only) on first use.
    pub fn load_or_create(path: &std::path::Path) -> std::io::Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => bytes.as_slice().try_into().map(Self).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "{} is not a 32-byte session secret; delete it to make a new one",
                        path.display()
                    ),
                )
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                use std::io::Write;
                let secret = Self::random();
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
                let mut file = options.open(path)?;
                file.write_all(&secret.0)?;
                file.sync_all()?;
                Ok(secret)
            }
            Err(error) => Err(error),
        }
    }

    /// The `(epoch, key)` pair for one purpose. Different purposes never share a key.
    pub(crate) fn derive(&self, purpose: &str) -> ([u8; 32], [u8; 32]) {
        let part = |label: &[u8]| -> [u8; 32] {
            let mut mac = HmacSha256::new_from_slice(&self.0).expect("HMAC accepts 32-byte key");
            mac.update(b"frank:relay-session:v1\0");
            mac.update(label);
            mac.update(b"\0");
            mac.update(purpose.as_bytes());
            mac.finalize().into_bytes().into()
        };
        (part(b"epoch"), part(b"key"))
    }
}

/// Outcome of consuming a recipient-authenticated mailbox challenge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChallengeConsumption {
    /// The nonce was unused and is now durably consumed.
    Consumed,
    /// The challenge is expired or its nonce was already consumed (an authentication failure).
    Rejected,
    /// The recipient already has the maximum number of live consumed challenges. This is a
    /// retryable resource condition, not an authentication failure: capacity returns as the
    /// recipient's earlier challenges expire.
    AtCapacity,
}

/// Private resource selected by an authenticated mailbox request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MailboxResource {
    /// Delivered recipient inbox ordered by `(timestamp, payload_hash)`.
    Inbox,
    /// Both-direction canonical mailbox (sent and received) ordered by
    /// `(timestamp, payload_hash)`.
    Mailbox,
    /// Authenticated websocket push of newly delivered both-direction mailbox records.
    MailboxStream,
}

impl MailboxResource {
    fn tag(self) -> u8 {
        match self {
            Self::Inbox => 1,
            Self::Mailbox => 4,
            Self::MailboxStream => 5,
        }
    }
}

/// Typed strict-forward position carried by an authenticated private request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MailboxCursor {
    /// Composite recipient-inbox ordering key.
    Inbox {
        /// Stored message time.
        timestamp: i64,
        /// Tie-breaker within one timestamp.
        payload_hash: [u8; 32],
    },
    /// Composite both-direction mailbox ordering key. A payload hash appears at most once per
    /// mailbox address, so `(timestamp, payload_hash)` is a unique position across directions.
    Mailbox {
        /// Stored mailbox commit time.
        timestamp: i64,
        /// Tie-breaker within one timestamp.
        payload_hash: [u8; 32],
    },
}

impl MailboxCursor {
    pub(crate) fn resource(self) -> MailboxResource {
        match self {
            Self::Inbox { .. } => MailboxResource::Inbox,
            Self::Mailbox { .. } => MailboxResource::Mailbox,
        }
    }

    fn append_position(self, bytes: &mut Vec<u8>) {
        match self {
            Self::Inbox {
                timestamp,
                payload_hash,
            }
            | Self::Mailbox {
                timestamp,
                payload_hash,
            } => {
                bytes.extend_from_slice(&timestamp.to_be_bytes());
                bytes.extend_from_slice(&payload_hash);
            }
        }
    }
}

/// One opaque cursor token paired with the decoded position used only by the server-side scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MailboxCursorBinding {
    pub(crate) position: MailboxCursor,
    pub(crate) token: String,
}

/// Canonical future request facts authenticated by both server MAC and recipient signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MailboxRequestBinding {
    pub(crate) resource: MailboxResource,
    pub(crate) recipient: Address,
    pub(crate) since: i64,
    pub(crate) cursor: Option<MailboxCursorBinding>,
    pub(crate) limit: usize,
    pub(crate) max_bytes: usize,
}

impl MailboxRequestBinding {
    pub(crate) fn append_canonical(&self, bytes: &mut Vec<u8>) {
        let (method, path): (&[u8], &[u8]) = match self.resource {
            MailboxResource::Inbox => (b"GET", b"inbox/"),
            MailboxResource::Mailbox => (b"GET", b"mailbox/"),
            MailboxResource::MailboxStream => (b"GET", b"mailbox-ws/"),
        };
        bytes.extend_from_slice(method);
        bytes.extend_from_slice(b"\0/message/monad/");
        bytes.extend_from_slice(path);
        bytes.push(self.resource.tag());
        bytes.extend_from_slice(&self.recipient.0);
        bytes.extend_from_slice(&self.since.to_be_bytes());
        match self.cursor.as_ref() {
            Some(cursor) => {
                debug_assert_eq!(cursor.position.resource(), self.resource);
                bytes.push(1);
                bytes.extend_from_slice(&(cursor.token.len() as u32).to_be_bytes());
                bytes.extend_from_slice(cursor.token.as_bytes());
            }
            None => bytes.push(0),
        }
        bytes.extend_from_slice(&(self.limit as u64).to_be_bytes());
        bytes.extend_from_slice(&(self.max_bytes as u64).to_be_bytes());
    }
}

/// Immutable runtime facts shared by message admission and mailbox reads.
#[derive(Debug)]
pub struct EnabledMonadMailboxRuntime {
    transport: HttpTransport,
    config: MailboxConfig,
    private_read_permits: Arc<Semaphore>,
    min_value_wei: u128,
    network_tag: Vec<u8>,
    auth: MailboxAuthState,
}

/// Public facts a recipient signs to authorize one private request.
#[derive(Debug, Clone, Copy)]
pub struct MailboxChallenge {
    /// Identifies the relay's session secret; a challenge made under another is refused.
    pub epoch: [u8; 32],
    /// Cryptographically random one-time value.
    pub nonce: [u8; 32],
    /// Absolute expiry in Unix milliseconds.
    pub expires_at_ms: i64,
    /// Server MAC over the epoch, nonce, expiry, and complete normalized future request.
    pub token: [u8; 32],
}

struct MailboxAuthState {
    epoch: [u8; 32],
    secret: [u8; 32],
}

impl fmt::Debug for MailboxAuthState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MailboxAuthState")
            .field("epoch", &self.epoch)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl MailboxAuthState {
    fn new(session: &SessionSecret) -> Self {
        let (epoch, secret) = session.derive("mailbox");
        Self { epoch, secret }
    }

    fn challenge_preimage(
        &self,
        binding: &MailboxRequestBinding,
        nonce: [u8; 32],
        expires_at_ms: i64,
    ) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(160);
        bytes.extend_from_slice(CHALLENGE_MAC_DOMAIN);
        bytes.extend_from_slice(&self.epoch);
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&expires_at_ms.to_be_bytes());
        binding.append_canonical(&mut bytes);
        bytes
    }

    fn mac(&self, preimage: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts 32-byte key");
        mac.update(preimage);
        mac.finalize().into_bytes().into()
    }

    fn issue(&self, binding: &MailboxRequestBinding, now_ms: i64) -> MailboxChallenge {
        let mut nonce = [0; 32];
        rand::thread_rng().fill_bytes(&mut nonce);
        let expires_at_ms = now_ms.saturating_add(CHALLENGE_TTL_MS);
        let token = self.mac(&self.challenge_preimage(binding, nonce, expires_at_ms));
        MailboxChallenge {
            epoch: self.epoch,
            nonce,
            expires_at_ms,
            token,
        }
    }

    fn verify(
        &self,
        binding: &MailboxRequestBinding,
        challenge: MailboxChallenge,
        now_ms: i64,
    ) -> bool {
        if challenge.epoch != self.epoch || challenge.expires_at_ms < now_ms {
            return false;
        }
        let Ok(mut mac) = HmacSha256::new_from_slice(&self.secret) else {
            return false;
        };
        mac.update(&self.challenge_preimage(binding, challenge.nonce, challenge.expires_at_ms));
        mac.verify_slice(&challenge.token).is_ok()
    }

    fn encode_cursor(&self, recipient: Address, cursor: MailboxCursor) -> String {
        let mut bytes = Vec::with_capacity(94);
        bytes.push(CURSOR_VERSION);
        bytes.push(cursor.resource().tag());
        bytes.extend_from_slice(&recipient.0);
        cursor.append_position(&mut bytes);
        let mut preimage = Vec::with_capacity(CURSOR_MAC_DOMAIN.len() + bytes.len());
        preimage.extend_from_slice(CURSOR_MAC_DOMAIN);
        preimage.extend_from_slice(&bytes);
        bytes.extend_from_slice(&self.mac(&preimage));
        hex::encode(bytes)
    }

    fn decode_cursor(
        &self,
        recipient: Address,
        resource: MailboxResource,
        encoded: &str,
    ) -> Option<MailboxCursor> {
        let position_len = match resource {
            MailboxResource::Inbox | MailboxResource::Mailbox => 8 + 32,
            MailboxResource::MailboxStream => return None,
        };
        let unsigned_len = 2 + 20 + position_len;
        let decoded_len = unsigned_len + 32;
        if encoded.len() != decoded_len * 2 {
            return None;
        }
        // The longest cursor is the inbox/mailbox form: version/resource + recipient + timestamp/hash
        // position + MAC. Validate encoded length before touching a decoder so attacker-sized
        // query strings never drive proportional heap allocation.
        let mut decoded = [0u8; 94];
        hex::decode_to_slice(encoded, &mut decoded[..decoded_len]).ok()?;
        let bytes = &decoded[..decoded_len];
        if bytes[0] != CURSOR_VERSION || bytes[1] != resource.tag() || bytes[2..22] != recipient.0 {
            return None;
        }
        let mut preimage = Vec::with_capacity(CURSOR_MAC_DOMAIN.len() + unsigned_len);
        preimage.extend_from_slice(CURSOR_MAC_DOMAIN);
        preimage.extend_from_slice(&bytes[..unsigned_len]);
        let mut mac = HmacSha256::new_from_slice(&self.secret).ok()?;
        mac.update(&preimage);
        mac.verify_slice(&bytes[unsigned_len..]).ok()?;
        let payload_hash = bytes[unsigned_len - 32..unsigned_len].try_into().ok()?;
        Some(match resource {
            MailboxResource::Inbox => MailboxCursor::Inbox {
                timestamp: i64::from_be_bytes(bytes[22..30].try_into().ok()?),
                payload_hash,
            },
            MailboxResource::Mailbox => MailboxCursor::Mailbox {
                timestamp: i64::from_be_bytes(bytes[22..30].try_into().ok()?),
                payload_hash,
            },
            MailboxResource::MailboxStream => return None,
        })
    }
}

impl MonadMailboxRuntime {
    /// Construct one enabled runtime after configuration validation.
    pub fn enabled(
        transport: HttpTransport,
        config: MailboxConfig,
        min_value_wei: u128,
        network_tag: Vec<u8>,
        session: &SessionSecret,
    ) -> Self {
        Self::Enabled(Arc::new(EnabledMonadMailboxRuntime {
            transport,
            private_read_permits: Arc::new(Semaphore::new(config.private_read_concurrency.max(1))),
            config,
            min_value_wei,
            network_tag,
            auth: MailboxAuthState::new(session),
        }))
    }

    /// Return the enabled runtime, if admission is configured.
    pub fn as_enabled(&self) -> Option<&EnabledMonadMailboxRuntime> {
        match self {
            Self::Disabled => None,
            Self::Enabled(runtime) => Some(runtime),
        }
    }
}

impl EnabledMonadMailboxRuntime {
    /// The node the relay hands payments to.
    pub fn transport(&self) -> &HttpTransport {
        &self.transport
    }

    /// The mailbox's chain and per-request limits.
    pub fn config(&self) -> &MailboxConfig {
        &self.config
    }

    /// Minimum total a paid message must carry.
    pub fn min_value_wei(&self) -> u128 {
        self.min_value_wei
    }

    /// Validated network tag for newly admitted envelopes.
    pub fn network_tag(&self) -> &[u8] {
        &self.network_tag
    }

    /// EVM chain id every payment must be signed for.
    pub fn expected_chain_id(&self) -> u64 {
        self.config.expected_chain_id
    }

    /// Issue a stateless short-lived challenge bound to the complete future request.
    pub(crate) fn issue_challenge(
        &self,
        binding: &MailboxRequestBinding,
        now_ms: i64,
    ) -> MailboxChallenge {
        self.auth.issue(binding, now_ms)
    }

    /// Verify the server-authenticated challenge before expensive recipient authentication.
    pub(crate) fn verify_challenge(
        &self,
        binding: &MailboxRequestBinding,
        challenge: MailboxChallenge,
        now_ms: i64,
    ) -> bool {
        self.auth.verify(binding, challenge, now_ms)
    }

    /// Encode a relay-authenticated strict-forward private cursor.
    pub(crate) fn encode_cursor(&self, recipient: Address, cursor: MailboxCursor) -> String {
        self.auth.encode_cursor(recipient, cursor)
    }

    /// Decode a cursor only for its bound relay, resource, and recipient.
    pub(crate) fn decode_cursor(
        &self,
        recipient: Address,
        resource: MailboxResource,
        encoded: &str,
    ) -> Option<MailboxCursor> {
        self.auth.decode_cursor(recipient, resource, encoded)
    }

    /// Reserve one shared private-read slot without queueing unbounded requests.
    pub(crate) fn try_acquire_private_read(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.private_read_permits)
            .try_acquire_owned()
            .ok()
    }
}

pub(crate) const MAILBOX_AUTH_DOMAIN: &str = "frank:mailbox-http-auth:v2";
const MAILBOX_EPOCH_HEADER: &str = "x-frank-mailbox-epoch";
const MAILBOX_NONCE_HEADER: &str = "x-frank-mailbox-nonce";
const MAILBOX_EXPIRY_HEADER: &str = "x-frank-mailbox-expires-at-ms";
const MAILBOX_SIGNATURE_HEADER: &str = "x-frank-mailbox-signature";
const MAILBOX_TOKEN_HEADER: &str = "x-frank-mailbox-token";
const MIN_ECDSA_DER_SIGNATURE_BYTES: usize = 8;
const MAX_ECDSA_DER_SIGNATURE_BYTES: usize = 72;

/// The bytes a mailbox owner signs to prove a private request is theirs.
pub(crate) fn mailbox_auth_preimage(
    challenge: MailboxChallenge,
    binding: &MailboxRequestBinding,
    network_tag: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(224 + network_tag.len());
    bytes.extend_from_slice(MAILBOX_AUTH_DOMAIN.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&challenge.epoch);
    bytes.extend_from_slice(&challenge.nonce);
    bytes.extend_from_slice(&challenge.expires_at_ms.to_be_bytes());
    bytes.extend_from_slice(&challenge.token);
    binding.append_canonical(&mut bytes);
    bytes.extend_from_slice(&(network_tag.len() as u32).to_be_bytes());
    bytes.extend_from_slice(network_tag);
    bytes
}

/// The challenge and signature a private request carries in its headers. `None` unless every
/// header is well formed and the challenge is one this relay issued for exactly this request
/// and has not expired; checked before any key lookup or storage read.
pub(crate) fn parse_mailbox_authentication(
    headers: &HeaderMap,
    runtime: &EnabledMonadMailboxRuntime,
    binding: &MailboxRequestBinding,
    now_ms: i64,
) -> Option<(MailboxChallenge, Vec<u8>)> {
    let hex32 = |name: &'static str| -> Option<[u8; 32]> {
        let value = headers.get(name)?.to_str().ok()?;
        let mut decoded = [0u8; 32];
        (value.len() == 64).then_some(())?;
        hex::decode_to_slice(value, &mut decoded).ok()?;
        Some(decoded)
    };
    let challenge = MailboxChallenge {
        epoch: hex32(MAILBOX_EPOCH_HEADER)?,
        nonce: hex32(MAILBOX_NONCE_HEADER)?,
        token: hex32(MAILBOX_TOKEN_HEADER)?,
        expires_at_ms: headers
            .get(MAILBOX_EXPIRY_HEADER)?
            .to_str()
            .ok()?
            .parse()
            .ok()?,
    };
    let signature = headers.get(MAILBOX_SIGNATURE_HEADER)?.to_str().ok()?;
    if signature.len() % 2 != 0
        || signature.len() < MIN_ECDSA_DER_SIGNATURE_BYTES * 2
        || signature.len() > MAX_ECDSA_DER_SIGNATURE_BYTES * 2
    {
        return None;
    }
    let signature = hex::decode(signature).ok()?;
    runtime
        .verify_challenge(binding, challenge, now_ms)
        .then_some((challenge, signature))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_with(session: &SessionSecret, config: MailboxConfig) -> MonadMailboxRuntime {
        MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            config,
            1,
            b"MONT".to_vec(),
            session,
        )
    }
    fn binding(recipient: Address) -> MailboxRequestBinding {
        MailboxRequestBinding {
            resource: MailboxResource::Inbox,
            recipient,
            since: 0,
            cursor: None,
            limit: 50,
            max_bytes: 1024,
        }
    }

    #[test]
    fn a_challenge_is_bound_to_its_request_and_expires() {
        let runtime = runtime_with(&SessionSecret::random(), MailboxConfig::default());
        let runtime = runtime.as_enabled().unwrap();
        let request = binding(Address([1; 20]));
        let challenge = runtime.issue_challenge(&request, 1_000);
        assert!(runtime.verify_challenge(&request, challenge, 1_000));
        assert!(runtime.verify_challenge(&request, challenge, 1_000 + CHALLENGE_TTL_MS));
        assert!(!runtime.verify_challenge(&request, challenge, 1_001 + CHALLENGE_TTL_MS));
        assert!(!runtime.verify_challenge(&binding(Address([2; 20])), challenge, 1_000));
        let mut other = request.clone();
        other.limit = 51;
        assert!(!runtime.verify_challenge(&other, challenge, 1_000));
    }

    #[test]
    fn challenges_and_cursors_survive_a_restart_with_the_same_session_secret() {
        let session = SessionSecret::random();
        let before = runtime_with(&session, MailboxConfig::default());
        let after = runtime_with(&session, MailboxConfig::default());
        let stranger = runtime_with(&SessionSecret::random(), MailboxConfig::default());
        let (before, after, stranger) = (
            before.as_enabled().unwrap(),
            after.as_enabled().unwrap(),
            stranger.as_enabled().unwrap(),
        );
        let recipient = Address([3; 20]);
        let request = binding(recipient);
        let challenge = before.issue_challenge(&request, 1_000);
        assert!(after.verify_challenge(&request, challenge, 1_000));
        assert!(!stranger.verify_challenge(&request, challenge, 1_000));
        let position = MailboxCursor::Inbox {
            timestamp: 7,
            payload_hash: [9; 32],
        };
        let cursor = before.encode_cursor(recipient, position);
        assert_eq!(
            after.decode_cursor(recipient, MailboxResource::Inbox, &cursor),
            Some(position)
        );
        assert_eq!(
            stranger.decode_cursor(recipient, MailboxResource::Inbox, &cursor),
            None
        );
    }

    #[test]
    fn a_cursor_is_good_only_for_its_recipient_and_resource_and_cannot_be_altered() {
        let runtime = runtime_with(&SessionSecret::random(), MailboxConfig::default());
        let runtime = runtime.as_enabled().unwrap();
        let recipient = Address([4; 20]);
        let position = MailboxCursor::Mailbox {
            timestamp: 11,
            payload_hash: [5; 32],
        };
        let cursor = runtime.encode_cursor(recipient, position);
        let decode = |who, what, text: &str| runtime.decode_cursor(who, what, text);
        assert_eq!(
            decode(recipient, MailboxResource::Mailbox, &cursor),
            Some(position)
        );
        assert_eq!(
            decode(Address([6; 20]), MailboxResource::Mailbox, &cursor),
            None
        );
        assert_eq!(decode(recipient, MailboxResource::Inbox, &cursor), None);
        let mut altered = cursor.clone().into_bytes();
        altered[50] = if altered[50] == b'0' { b'1' } else { b'0' };
        assert_eq!(
            decode(
                recipient,
                MailboxResource::Mailbox,
                std::str::from_utf8(&altered).unwrap()
            ),
            None
        );
        assert_eq!(decode(recipient, MailboxResource::Mailbox, "00"), None);
    }

    #[test]
    fn private_reads_are_refused_past_the_configured_number_at_once() {
        let runtime = runtime_with(
            &SessionSecret::random(),
            MailboxConfig {
                private_read_concurrency: 2,
                ..MailboxConfig::default()
            },
        );
        let runtime = runtime.as_enabled().unwrap();
        let first = runtime.try_acquire_private_read().unwrap();
        let _second = runtime.try_acquire_private_read().unwrap();
        assert!(runtime.try_acquire_private_read().is_none());
        drop(first);
        assert!(runtime.try_acquire_private_read().is_some());
    }

    #[test]
    fn the_session_secret_is_written_once_read_back_and_never_printed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("relay.session-secret");
        let first = SessionSecret::load_or_create(&path).unwrap();
        let again = SessionSecret::load_or_create(&path).unwrap();
        assert_eq!(first.derive("mailbox"), again.derive("mailbox"));
        assert_ne!(first.derive("mailbox"), first.derive("evm-rpc"));
        assert_eq!(std::fs::read(&path).unwrap().len(), 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(!format!("{first:?}").contains(&hex::encode(first.0)));
        let runtime = runtime_with(&first, MailboxConfig::default());
        assert!(!format!("{runtime:?}").contains(&hex::encode(first.derive("mailbox").1)));
        std::fs::write(&path, b"short").unwrap();
        assert!(SessionSecret::load_or_create(&path).is_err());
    }
}
