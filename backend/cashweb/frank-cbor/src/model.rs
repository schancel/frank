//! Typed projections of the version-1 payload schemas.
//!
//! Integers stay exact. `seconds` is an `i64` and `nanoseconds` is a `u32`;
//! neither is a float. Unknown fields are the original decoded values.

use crate::cbor::CborValue;

/// Explicit projection of an opaque historical or structured Forum body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForumPostContent {
    /// Schema 1: no content sniffing.
    Opaque,
    /// Schema 2 or a compatible future schema.
    Structured(ForumContent),
}
/// An authored entry, or a bounded placeholder for a compatible future kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForumEntry {
    /// Known kind 1. Empty and absent strings retain distinct original frame bytes.
    Post {
        /// Optional title, preserving empty versus absent.
        title: Option<String>,
        /// Optional URL text; decoding never fetches it.
        url: Option<String>,
        /// Optional message, preserving exact Unicode.
        message: Option<String>,
        /// Original compatible extension fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Never interpret fields as text or URLs. Display only `Unsupported content`.
    Unsupported {
        /// Unrecognized numeric entry kind.
        kind: u64,
        /// Uninterpreted fields; never render as known content.
        fields: Vec<(u64, CborValue)>,
    },
}
/// Structured schema-2 body; its exact bytes remain on the parent post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumContent {
    /// Author-supplied time contributing to identity, not authority.
    pub authored: Timestamp,
    /// Ordered, bounded entries.
    pub entries: Vec<ForumEntry>,
    /// Original compatible extension fields.
    pub unknown: Vec<(u64, CborValue)>,
}
/// Signed 256-bit magnitude, never negative zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumAggregate {
    /// Sign bit, false for zero.
    pub negative: bool,
    /// Exact unsigned 256-bit big-endian magnitude.
    pub magnitude: [u8; 32],
}
/// A closed cursor query and complete last-row tuple.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForumCursorPosition {
    /// Topic-page query and complete last-row tuple.
    Topic {
        /// Exact UTF-8 topic, without normalization.
        topic: String,
        /// Inclusive lower timestamp bound.
        since: Timestamp,
        /// Last row first-visible timestamp.
        timestamp: Timestamp,
        /// Last row exact post T1.
        hash: Vec<u8>,
    },
    /// Discovery-page last-topic tuple.
    Discovery {
        /// Exact UTF-8 topic, without normalization.
        topic: String,
    },
}
/// Cursor bytes confer no authority or snapshot existence guarantee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumCursor {
    /// Original canonical cursor bytes for forwarding.
    pub bytes: Vec<u8>,
    /// Exact validated network tag.
    pub network: String,
    /// Relay observation or snapshot revision.
    pub revision: u64,
    /// Opaque 16-byte relay epoch.
    pub epoch: Vec<u8>,
    /// Non-reused snapshot incarnation, retained without authority.
    pub incarnation: u64,
    /// Family-specific query and last-row tuple.
    pub position: ForumCursorPosition,
}
/// Relay-observed single post, not independently verified chain evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumView<F> {
    /// Exact validated network tag.
    pub network: String,
    /// Original required post frame and its validated projection.
    pub post_frame: F,
    /// Relay-claimed 20-byte author address.
    pub author: Vec<u8>,
    /// Original raw author-burn transaction, not verified here.
    pub author_burn_tx: Vec<u8>,
    /// Relay-claimed transaction hash, or unverified request echo.
    pub transaction_hash: Vec<u8>,
    /// Relay-observed first-visible time for ordering.
    pub first_visible: Timestamp,
    /// Relay-observed block position.
    pub block: u64,
    /// Relay-observed transaction position within its block.
    pub transaction_index: u64,
    /// Exact signed magnitude, not narrowed to a host integer.
    pub aggregate: ForumAggregate,
    /// Relay observation or snapshot revision.
    pub revision: u64,
    /// Opaque 16-byte relay epoch.
    pub epoch: Vec<u8>,
    /// Original compatible extension fields.
    pub unknown: Vec<(u64, CborValue)>,
}
/// One page of exact retained view frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumTopicPage<F, K> {
    /// Exact validated network tag.
    pub network: String,
    /// Exact UTF-8 topic, without normalization.
    pub topic: String,
    /// Inclusive lower timestamp bound.
    pub since: Timestamp,
    /// Relay observation or snapshot revision.
    pub revision: u64,
    /// Ordered required view frames.
    pub rows: Vec<F>,
    /// Continuation identifying the last emitted row, when present.
    pub next_cursor: Option<K>,
    /// Exact cursor echoed from this page request, when present.
    pub request_cursor: Option<K>,
    /// Opaque 16-byte relay epoch.
    pub epoch: Vec<u8>,
    /// Original compatible extension fields.
    pub unknown: Vec<(u64, CborValue)>,
}
/// Discovery uses exact UTF-8 ordering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumDiscoveryEntry {
    /// Exact UTF-8 topic, without normalization.
    pub topic: String,
    /// Exact unsigned 64-bit count.
    pub count: u64,
    /// Relay-claimed last activity time.
    pub last_activity: Timestamp,
    /// Original compatible extension fields.
    pub unknown: Vec<(u64, CborValue)>,
}
/// One discovery page, not a complete published refresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumDiscoveryPage<K> {
    /// Exact validated network tag.
    pub network: String,
    /// Relay observation or snapshot revision.
    pub revision: u64,
    /// Ordered, bounded entries.
    pub entries: Vec<ForumDiscoveryEntry>,
    /// Continuation identifying the last emitted row, when present.
    pub next_cursor: Option<K>,
    /// Exact cursor echoed from this page request, when present.
    pub request_cursor: Option<K>,
    /// Opaque 16-byte relay epoch.
    pub epoch: Vec<u8>,
    /// Original compatible extension fields.
    pub unknown: Vec<(u64, CborValue)>,
}
/// Tagged claims ensure unverified request echoes are distinct from relay observations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForumOperationEvidence {
    /// State 0. No observation and no wallet authority.
    UnknownRequest,
    /// State 3. Does not establish absence from any chain or other relay.
    RejectedRequest,
    /// State 1. A nonterminal relay observation.
    Pending,
    /// State 2. Relay-observed confirmation, not independently established finality.
    Confirmed {
        /// Relay-observed block position.
        block: u64,
        /// Relay-observed transaction index.
        transaction_index: u64,
    },
}
/// Exact operation response; the evidence tag determines the meaning of the echoed facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumOperationStatus<F> {
    /// Exact validated network tag.
    pub network: String,
    /// Original required type-10 or type-11 operation frame.
    pub submitted_frame: F,
    /// Exact target post T1, bound to the submitted operation.
    pub target_hash: Vec<u8>,
    /// Relay-claimed transaction hash, or unverified request echo.
    pub transaction_hash: Vec<u8>,
    /// Claimed sender or unverified request echo.
    pub sender: Vec<u8>,
    /// Zero for down, one for up.
    pub direction: u8,
    /// Exact value; admitted observations are bounded to i64::MAX.
    pub value: u64,
    /// Tag separating request echoes from relay observations.
    pub evidence: ForumOperationEvidence,
    /// Relay observation or snapshot revision.
    pub revision: u64,
    /// Opaque 16-byte relay epoch.
    pub epoch: Vec<u8>,
    /// Original compatible extension fields.
    pub unknown: Vec<(u64, CborValue)>,
}

/// Why a frame was kept only as opaque bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetentionReason {
    /// `type_id` is not in the reader's supported schema list.
    UnknownType,
    /// Frame version byte is not 1. The length field was not interpreted.
    UnsupportedFrameVersion,
    /// `min_reader_version` is above the reader, and the type itself is known.
    UnsupportedMinReader,
}

impl RetentionReason {
    /// Stable reason token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownType => "unknown-type",
            Self::UnsupportedFrameVersion => "unsupported-frame-version",
            Self::UnsupportedMinReader => "unsupported-min-reader",
        }
    }
}

/// An exact, uninterpreted frame. The bytes are the input, not a reconstruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedFrame {
    /// Why the frame was not interpreted.
    pub reason: RetentionReason,
    /// Original frame bytes, header included.
    pub frame: Vec<u8>,
    /// Present unless the envelope was never read (unsupported frame version).
    pub type_id: Option<u32>,
    /// Envelope schema version, when the envelope was read.
    pub schema_version: Option<u32>,
    /// Envelope minimum reader version, when the envelope was read.
    pub min_reader_version: Option<u32>,
}

/// `exact` for a supported schema version, `newer-schema` for a V6.3 projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    /// `schema_version` is within the reader's highest supported schema.
    Exact,
    /// Newer compatible schema; unknown open-map fields are retained.
    NewerSchema,
}

/// Result of `operation: frame` (stages 1-4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameOnly {
    /// Original frame bytes.
    pub frame: Vec<u8>,
    /// Frame version byte.
    pub version: u8,
    /// Bytes after the nine-byte header. Not decoded.
    pub body: Vec<u8>,
}

/// A frame that passed the stages required by the requested operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFrame {
    /// Original frame bytes, header included. Never a re-encoding.
    pub frame: Vec<u8>,
    /// Envelope `type_id`.
    pub type_id: u32,
    /// Envelope `schema_version`.
    pub schema_version: u32,
    /// Envelope `min_reader_version`.
    pub min_reader_version: u32,
    /// The exact payload item bytes.
    pub payload_bytes: Vec<u8>,
    /// Generic decoded payload item.
    pub payload: CborValue,
    /// How unknown fields were treated.
    pub projection: Projection,
    /// Present when validation reached stage 8.
    pub typed: Option<Box<TypedPayload>>,
}

/// A child of an open message-item field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildFrame {
    /// The child was interpreted.
    Parsed(ParsedFrame),
    /// The child was retained as exact bytes.
    Retained(RetainedFrame),
}

/// What [`crate::validate_frame`] returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationResult {
    /// Stages 1-4 passed and the operation stopped there.
    Frame(FrameOnly),
    /// Generic or typed success.
    Parsed(ParsedFrame),
    /// Opaque retention of the original frame.
    Retained(RetainedFrame),
}

/// Account reference ordered by `(key_type, key_bytes)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRef {
    /// Allocated key-type identifier.
    pub key_type: u32,
    /// Key bytes. Length is checked against the allocated type.
    pub key_bytes: Vec<u8>,
}

/// Timestamp. `seconds` is an i64; `nanoseconds` is `0..=999_999_999`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamp {
    /// Seconds since the Unix epoch, exact i64.
    pub seconds: i64,
    /// Nanoseconds, exact integer, not a float.
    pub nanoseconds: u32,
}

/// One payment member. `value` is a 32-byte big-endian quantity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentMember {
    /// Non-hardened BIP32 index.
    pub child_index: u32,
    /// Chain transaction identifier.
    pub transaction_id: Vec<u8>,
    /// 32-byte big-endian value.
    pub value: Vec<u8>,
    /// Destination address bytes.
    pub address: Vec<u8>,
    /// 32-byte T4 commitment.
    pub commitment: Vec<u8>,
}

/// One signature entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureEntry {
    /// Signature algorithm identifier.
    pub algorithm: u32,
    /// Signer account.
    pub signer: AccountRef,
    /// Signature bytes.
    pub signature: Vec<u8>,
}

/// One relay binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayBinding {
    /// Relay identifier.
    pub relay_id: Vec<u8>,
    /// Exact endpoint text. Not normalized.
    pub endpoint: String,
    /// Relay identity.
    pub identity: AccountRef,
    /// Binding expiry.
    pub expiry: Timestamp,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One header of a profile entry (M4): the protobuf name/value set as a C11-sorted list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileHeader {
    /// Header name.
    pub name: String,
    /// Header value.
    pub value: String,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One migrated AddressEntry (M4). Authored array order is preserved, never resorted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileEntry {
    /// The wallet's entry-type hint, consumer-interpreted.
    pub kind: String,
    /// The entry headers, ordered bytewise by name (C11).
    pub headers: Vec<ProfileHeader>,
    /// Exact body bytes.
    pub body: Vec<u8>,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One key-transition entry after its type-7 frame has been opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyTransition {
    /// Opened type-7 statement frame.
    pub statement: ParsedFrame,
    /// Authorization algorithm.
    pub algorithm: u32,
    /// Signer. Must equal the statement's prior authority.
    pub signer: AccountRef,
    /// Signature bytes.
    pub signature: Vec<u8>,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One journal fact. `payload` is opaque in version 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalFact {
    /// Fact time.
    pub timestamp: Timestamp,
    /// 16-byte fact identifier.
    pub fact_id: Vec<u8>,
    /// Uninterpreted fact kind.
    pub kind: u32,
    /// Opaque payload bytes.
    pub payload: Vec<u8>,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One opaque checkpoint section. `value` is never opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueSection {
    /// Section type.
    pub section_type: u32,
    /// Section schema version.
    pub section_schema_version: u32,
    /// Exact section bytes.
    pub value: Vec<u8>,
}

/// Typed payload. Framed children are opened frames, not raw bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypedPayload {
    /// Type 1.
    DirectMessage {
        /// Field 0.
        network: String,
        /// Field 1.
        destination: AccountRef,
        /// Field 2, opened as type 5.
        payload_frame: ParsedFrame,
        /// Field 3.
        payload_digest: Vec<u8>,
        /// Field 4.
        payments: Vec<PaymentMember>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 2.
    DirectoryAttestation {
        /// Field 0, opened as type 4.
        statement: ParsedFrame,
        /// Field 1.
        signatures: Vec<SignatureEntry>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 3.
    MailboxCheckpoint {
        /// Field 0.
        network: String,
        /// Field 1.
        owner: AccountRef,
        /// Field 2.
        checkpoint_id: Vec<u8>,
        /// Field 3.
        timestamp: Timestamp,
        /// Field 4.
        facts: Vec<JournalFact>,
        /// Field 5, when present.
        sections: Option<Vec<OpaqueSection>>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 4.
    DirectoryStatement {
        /// Field 0.
        network: String,
        /// Field 1.
        subject: AccountRef,
        /// Field 2, exact u64.
        revision: u64,
        /// Field 3.
        timestamp: Timestamp,
        /// Field 4.
        relays: Vec<RelayBinding>,
        /// Field 5, when present.
        key_transitions: Option<Vec<KeyTransition>>,
        /// Field 6, when present.
        expiry: Option<Timestamp>,
        /// Field 7, when present.
        recovery: Option<Vec<AccountRef>>,
        /// The frame's envelope `schema_version`, kept for the S10a.2 same-subject order.
        schema_version: u32,
        /// Field 8, the stamp key `P'` (S10a.1): required in schema 2, undefined in schema 1.
        stamp_key: Option<AccountRef>,
        /// Field 9, the migrated profile entries (M4): absent when empty. Schema 3 only.
        profile_entries: Option<Vec<ProfileEntry>>,
        /// Provisional schema-4 role fields, absent in schemas 1–3.
        preview: Option<PreviewDirectoryRoles>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 5.
    RecipientPayload {
        /// The interpreted type-5 schema version.
        schema_version: u32,
        /// Field 0.
        network: String,
        /// Field 1.
        sender: AccountRef,
        /// Field 2.
        recipient: AccountRef,
        /// Field 3.
        suite: u32,
        /// Schema-1 field 4; absent in schema 2.
        nonce: Option<Vec<u8>>,
        /// Schema-1 field 5; absent in schema 2.
        ciphertext: Option<Vec<u8>>,
        /// Schema-2 field 4: complete deterministic-CBOR crypto-box envelope.
        crypto_box_envelope: Option<Vec<u8>>,
        /// Schema-1 field 6 or schema-2 field 5, `E = e*G` (T3a, T3b encoding rules).
        ephemeral_point: Vec<u8>,
        /// Schema-1 field 7 or schema-2 field 6, `X = e*P'` (T3a).
        shared_point: Vec<u8>,
        /// Schema-1 field 8 or schema-2 field 7, the DLEQ proof `c || s` (T3b).
        dleq_proof: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 6.
    EncryptedContent {
        /// Field 0.
        network: String,
        /// Field 1.
        message_id: Vec<u8>,
        /// Field 2, opened as type 8.
        revision_frame: ParsedFrame,
        /// Field 3.
        content_digest: Vec<u8>,
        /// Field 4.
        conversation_id: Vec<u8>,
        /// Field 5, optional.
        conversation_name: Option<String>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 7.
    KeyTransitionStatement {
        /// Field 0.
        network: String,
        /// Field 1.
        subject: AccountRef,
        /// Field 2.
        prior_authority: AccountRef,
        /// Field 3, exact u64, at least 1.
        revision: u64,
        /// Field 4.
        new_key: AccountRef,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 9.
    TopicPost {
        /// Field 0.
        network: String,
        /// Field 1, exact UTF-8, not normalized.
        topic: String,
        /// Field 2, when present: T1 hash of the parent type-9 frame.
        parent_hash: Option<Vec<u8>>,
        /// Field 3, opaque.
        body: Vec<u8>,
        /// Schema-discriminated content; never reconstructed from a historical opaque body.
        content: ForumPostContent,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 10.
    TopicPostSubmission {
        /// Field 0.
        network: String,
        /// Field 1, opened as type 9.
        post_frame: ParsedFrame,
        /// Field 2, raw signed chain transaction.
        burn_tx: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 11.
    TopicVoteSubmission {
        /// Field 0.
        network: String,
        /// Field 1: T1 hash of the target type-9 frame.
        target_hash: Vec<u8>,
        /// Field 2, raw signed chain transaction.
        burn_tx: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 12, a relay observation over the exact post.
    ForumView(ForumView<ParsedFrame>),
    /// Type 13, exact view rows and bound continuation.
    ForumTopicPage(ForumTopicPage<ParsedFrame, ForumCursor>),
    /// Type 14, ordered discovery entries.
    ForumDiscoveryPage(ForumDiscoveryPage<ForumCursor>),
    /// Type 15, tagged request echo or relay observation.
    ForumOperationStatus(ForumOperationStatus<ParsedFrame>),
    /// Type 8.
    MessageRevision {
        /// Field 1 children.
        items: Vec<ChildFrame>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 16.
    ContainerItem {
        /// Field 0 children.
        items: Vec<ChildFrame>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 18, nine closed blackjack item shapes.
    BlackjackItem(BlackjackMessageItem),
    /// Type 18 schema 2 with min reader 2, the closed peer-to-peer hand item shapes.
    BlackjackHandItem(BlackjackHandMessageItem),
    /// Type 18 schema 3, the closed hand shapes with entropy from both sides.
    BlackjackHandV3Item(BlackjackHandV3MessageItem),
    /// Type 17.
    TextItem {
        /// Field 0.
        text: String,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
}

/// Required role fields in the provisional directory schema-4 projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewDirectoryRoles {
    /// Field 10, distinct message-DH key M.
    pub message_dh_key: AccountRef,
    /// Field 11, exact uint64 sequence, not a derivation index.
    pub mailbox_key_generation: u64,
    /// Field 12, exact uint64 sequence.
    pub stamp_key_generation: u64,
    /// Field 13, exact predecessor type-4 T1, null only at revision zero.
    pub predecessor: Option<Vec<u8>>,
}

/// Codec-owned nine closed blackjack action shapes; H and Q distinguish bytes from text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlackjackAction<H, Q> {
    /// Wager request.
    Bet {
        /// Exact wager transaction hash.
        wager_tx_hash: H,
    },
    /// Initial two-card hand and dealer up-card.
    Deal {
        /// Exact seed commitment hash.
        server_seed_hash: H,
        /// Ordered initial two-card hand.
        player_cards: Vec<u32>,
        /// Dealer's distinct visible card.
        dealer_up_card: u32,
    },
    /// Hit request.
    HitRequest,
    /// Hit response.
    HitResponse {
        /// Ordered updated hand.
        player_cards: Vec<u32>,
    },
    /// Stand request.
    Stand,
    /// Double request.
    DoubleRequest {
        /// Exact additional wager transaction hash.
        double_wager_tx_hash: H,
    },
    /// Three-card double response.
    DoubleResponse {
        /// Ordered three-card hand.
        player_cards: Vec<u32>,
    },
    /// Reveal; seed is lowercase ASCII text, never decoded binary.
    Reveal {
        /// Ordered final dealer hand.
        dealer_cards: Vec<u32>,
        /// Exactly64 lowercase ASCII hex characters as text.
        server_seed: String,
        /// Allocated result, without economic verification.
        outcome: BlackjackOutcome,
    },
    /// Exact decimal presentation or 32-byte unsigned quantity, with optional-presence retention.
    Welcome {
        /// Positive minimum wager.
        min_wager_wei: Q,
        /// Maximum wager, at least the minimum.
        max_wager_wei: Q,
        /// Optional fee; zero differs from absence.
        fee_hint_wei: Option<Q>,
        /// Optional rules; empty differs from absence.
        rules: Option<String>,
    },
}

/// Common game ID plus one closed action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlackjackFields<H, Q> {
    /// Exact UTF-8 game ID, with no normalization.
    pub game_id: String,
    /// The complete selected action shape.
    pub action: BlackjackAction<H, Q>,
}

/// Four allocated outcomes; no payout or fairness authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlackjackOutcome {
    /// Player wins.
    PlayerWin,
    /// Dealer wins.
    DealerWin,
    /// Push.
    Push,
    /// Player blackjack.
    PlayerBlackjack,
}

/// Closed type-18 wire projection; exact frame bytes stay on ParsedFrame.
pub type BlackjackMessageItem = BlackjackFields<Vec<u8>, Vec<u8>>;

/// Codec-owned closed schema-2 shapes of one peer-to-peer hand: ten actions, the challenge in
/// its two role forms. H and Q distinguish bytes from text. No shape carries an amount of money:
/// a wager, payout or refund is the stamp of the message that carries the item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlackjackHandAction<H, Q> {
    /// Challenge by the dealer (role 0), with the seed commitment.
    ChallengeDealer {
        /// Positive maximum bet.
        max_bet_wei: Q,
        /// Exact seed commitment hash.
        commitment: H,
    },
    /// Challenge by the player (role 1); it carries no commitment.
    ChallengePlayer {
        /// Positive maximum bet.
        max_bet_wei: Q,
    },
    /// Acceptance of a challenge.
    Accept {
        /// Positive maximum bet.
        max_bet_wei: Q,
        /// Exact seed commitment hash.
        commitment: H,
    },
    /// Bet; the amount is the carrying message's stamp.
    Bet,
    /// Initial two-card hand and dealer up-card.
    Deal {
        /// Ordered initial two-card hand.
        player_cards: Vec<u32>,
        /// Dealer's distinct visible card.
        dealer_up_card: u32,
    },
    /// Hit request.
    Hit,
    /// Stand request.
    Stand,
    /// Double request; the amount is the carrying message's stamp.
    Double,
    /// Updated player hand of three or more cards.
    Card {
        /// Ordered updated hand.
        player_cards: Vec<u32>,
    },
    /// Reveal; seed is lowercase ASCII text, never decoded binary.
    Reveal {
        /// Ordered final dealer hand.
        dealer_cards: Vec<u32>,
        /// Exactly64 lowercase ASCII hex characters as text.
        seed: String,
        /// Allocated result, without economic verification.
        outcome: BlackjackOutcome,
    },
    /// Refund notice; the amount is the carrying message's stamp.
    Refund {
        /// Exact 32-byte reference.
        reference: H,
    },
}

/// Common game ID plus one closed schema-2 hand action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlackjackHandFields<H, Q> {
    /// Game ID: exactly 32 lowercase ASCII hex characters.
    pub game_id: String,
    /// The complete selected action shape.
    pub action: BlackjackHandAction<H, Q>,
}

/// Closed type-18 schema-2 wire projection; exact frame bytes stay on ParsedFrame.
pub type BlackjackHandMessageItem = BlackjackHandFields<Vec<u8>, Vec<u8>>;

/// The six schema-3 moves that open one entropy link; they share one closed shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlackjackHandV3Move {
    /// Deal.
    Deal,
    /// Hit.
    Hit,
    /// Stand.
    Stand,
    /// Double; the amount is the carrying message's stamp.
    Double,
    /// Card.
    Card,
    /// Reveal.
    Reveal,
}

/// Codec-owned closed schema-3 shapes of one peer-to-peer hand with entropy from both sides:
/// ten actions, the challenge in its two role forms. H and Q distinguish bytes from text. No
/// shape states a card, an outcome or an amount of money: both sides compute the cards from the
/// links opened so far. `prev` is the payload digest of the hand's previous message; a
/// challenge is message 0 and has none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlackjackHandV3Action<H, Q> {
    /// Challenge by the dealer (role 0), with the commitment.
    ChallengeDealer {
        /// Positive maximum bet.
        max_bet_wei: Q,
        /// Exact 32-byte commitment.
        commitment: H,
    },
    /// Challenge by the player (role 1); it carries no commitment.
    ChallengePlayer {
        /// Positive maximum bet.
        max_bet_wei: Q,
    },
    /// Acceptance of a challenge.
    Accept {
        /// Positive maximum bet.
        max_bet_wei: Q,
        /// Exact 32-byte commitment.
        commitment: H,
        /// Payload digest of the previous message.
        prev: H,
    },
    /// Bet; the amount is the carrying message's stamp.
    Bet {
        /// Exact 32-byte commitment.
        commitment: H,
        /// Payload digest of the previous message.
        prev: H,
    },
    /// Deal, hit, stand, double, card or reveal: one opened entropy link.
    Move {
        /// Which of the six moves this is.
        kind: BlackjackHandV3Move,
        /// Exact 32-byte entropy link.
        link: H,
        /// Payload digest of the previous message.
        prev: H,
    },
    /// Refund notice; the amount is the carrying message's stamp.
    Refund {
        /// Exact 32-byte reference.
        reference: H,
        /// Payload digest of the previous message.
        prev: H,
    },
}

/// Common game ID and chain position plus one closed schema-3 hand action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlackjackHandV3Fields<H, Q> {
    /// Game ID: exactly 32 lowercase ASCII hex characters.
    pub game_id: String,
    /// Number of messages of this hand before this one: 0 for a challenge, otherwise 1..=255.
    pub seq: u32,
    /// The complete selected action shape.
    pub action: BlackjackHandV3Action<H, Q>,
}

/// Closed type-18 schema-3 wire projection; exact frame bytes stay on ParsedFrame.
pub type BlackjackHandV3MessageItem = BlackjackHandV3Fields<Vec<u8>, Vec<u8>>;
