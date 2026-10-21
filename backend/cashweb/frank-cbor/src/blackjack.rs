//! Pure typed blackjack writer/projection. No game, fairness or payment authority.
use crate::message_fields::{
    blackjack_action, blackjack_hand_action, blackjack_hand_item, blackjack_hand_v3_action,
    blackjack_hand_v3_item, blackjack_item, blackjack_outcome, blackjack_role,
};
use crate::message_types::TYPE_BLACKJACK_MESSAGE_ITEM;
use crate::{
    cbor_map, default_context, encode_frame, validate_frame, BlackjackAction, BlackjackFields,
    BlackjackHandAction, BlackjackHandFields, BlackjackHandV3Action, BlackjackHandV3Fields,
    BlackjackHandV3Move, BlackjackOutcome, CborValue, CodecError, ContextError, EnvelopeFields,
    Error, ErrorCategory, ErrorStage, FramePayload, ParsedFrame, TypedPayload,
};

/// Nine closed application shapes; quantities and hashes use exact presentation strings.
pub type BlackjackItem = BlackjackFields<String, String>;
/// Owned exact original bytes and their application projection; forward frame unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlackjackProjection {
    /// Original exact frame bytes.
    pub frame: Vec<u8>,
    /// Closed application value.
    pub item: BlackjackItem,
}
fn bad(message: &str) -> Error {
    CodecError::new(
        ErrorCategory::Schema,
        ErrorStage::S82,
        message,
        "blackjack/writer",
        None,
    )
    .into()
}
fn hash(value: &str, prefixed: bool) -> Result<Vec<u8>, Error> {
    let bytes = value.as_bytes();
    if bytes.len() != if prefixed { 66 } else { 64 } || (prefixed && !bytes.starts_with(b"0x")) {
        return Err(bad("strict hash prefix/length"));
    }
    let digits = if prefixed { &bytes[2..] } else { bytes };
    if !digits.iter().all(|b| {
        b.is_ascii_digit() || (b'a'..=b'f').contains(b) || (prefixed && (b'A'..=b'F').contains(b))
    }) {
        return Err(bad("complete ASCII hash grammar"));
    }
    let nibble = |b: u8| {
        if b <= b'9' {
            b - b'0'
        } else {
            b.to_ascii_lowercase() - b'a' + 10
        }
    };
    Ok(digits
        .chunks_exact(2)
        .map(|pair| nibble(pair[0]) * 16 + nibble(pair[1]))
        .collect())
}
fn quantity(value: &str) -> Result<Vec<u8>, Error> {
    if value.is_empty() || value.len() > 40 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad("quantity requires 1..40 complete ASCII decimal digits"));
    }
    let mut bytes = vec![0u8; 32];
    for digit in value.bytes() {
        let mut carry = u16::from(digit - b'0');
        for b in bytes.iter_mut().rev() {
            let n = u16::from(*b) * 10 + carry;
            *b = n as u8;
            carry = n >> 8;
        }
    }
    Ok(bytes)
}
fn cards(value: &[u32]) -> CborValue {
    CborValue::Array(
        value
            .iter()
            .map(|v| CborValue::Int(i128::from(*v)))
            .collect(),
    )
}
fn outcome_code(outcome: &BlackjackOutcome) -> u32 {
    match outcome {
        BlackjackOutcome::PlayerWin => blackjack_outcome::PLAYER_WIN,
        BlackjackOutcome::DealerWin => blackjack_outcome::DEALER_WIN,
        BlackjackOutcome::Push => blackjack_outcome::PUSH,
        BlackjackOutcome::PlayerBlackjack => blackjack_outcome::PLAYER_BLACKJACK,
    }
}
fn int(value: u32) -> CborValue {
    CborValue::Int(i128::from(value))
}
/// Deterministically encode a closed input through the same active typed validator.
pub fn encode_blackjack_item(item: &BlackjackItem) -> Result<Vec<u8>, Error> {
    use blackjack_action as A;
    use blackjack_item as K;
    use BlackjackAction::*;
    let mut fields = vec![(K::GAME_ID, CborValue::Text(item.game_id.clone()))];
    let action = match &item.action {
        Bet { wager_tx_hash } => {
            fields.push((
                K::WAGER_TX_HASH,
                CborValue::Bytes(hash(wager_tx_hash, true)?),
            ));
            A::BET
        }
        Deal {
            server_seed_hash,
            player_cards,
            dealer_up_card,
        } => {
            fields.extend([
                (
                    K::SERVER_SEED_HASH,
                    CborValue::Bytes(hash(server_seed_hash, false)?),
                ),
                (K::PLAYER_CARDS, cards(player_cards)),
                (K::DEALER_UP_CARD, int(*dealer_up_card)),
            ]);
            A::DEAL
        }
        HitRequest => A::HIT,
        HitResponse { player_cards } => {
            fields.push((K::PLAYER_CARDS, cards(player_cards)));
            A::HIT
        }
        Stand => A::STAND,
        DoubleRequest {
            double_wager_tx_hash,
        } => {
            fields.push((
                K::DOUBLE_WAGER_TX_HASH,
                CborValue::Bytes(hash(double_wager_tx_hash, true)?),
            ));
            A::DOUBLE
        }
        DoubleResponse { player_cards } => {
            fields.push((K::PLAYER_CARDS, cards(player_cards)));
            A::DOUBLE
        }
        Reveal {
            dealer_cards,
            server_seed,
            outcome,
        } => {
            fields.extend([
                (K::DEALER_CARDS, cards(dealer_cards)),
                (K::SERVER_SEED, CborValue::Text(server_seed.clone())),
                (K::OUTCOME, int(outcome_code(outcome))),
            ]);
            A::REVEAL
        }
        Welcome {
            min_wager_wei,
            max_wager_wei,
            fee_hint_wei,
            rules,
        } => {
            fields.extend([
                (K::MIN_WAGER_WEI, CborValue::Bytes(quantity(min_wager_wei)?)),
                (K::MAX_WAGER_WEI, CborValue::Bytes(quantity(max_wager_wei)?)),
            ]);
            if let Some(fee) = fee_hint_wei {
                fields.push((K::FEE_HINT_WEI, CborValue::Bytes(quantity(fee)?)));
            }
            if let Some(rules) = rules {
                fields.push((K::RULES, CborValue::Text(rules.clone())));
            }
            A::WELCOME
        }
    };
    fields.push((K::ACTION, int(action)));
    let payload = cbor_map(fields);
    let bytes = encode_frame(
        EnvelopeFields {
            type_id: TYPE_BLACKJACK_MESSAGE_ITEM,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&payload),
    )
    .map_err(|e| bad(&e.to_string()))?;
    validate_frame(&bytes, &default_context())?;
    Ok(bytes)
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|b| {
            [
                DIGITS[usize::from(*b >> 4)] as char,
                DIGITS[usize::from(*b & 15)] as char,
            ]
        })
        .collect()
}
fn decimal(bytes: &[u8]) -> String {
    let mut number = bytes.to_vec();
    let mut digits = Vec::new();
    while number.iter().any(|b| *b != 0) {
        let mut carry = 0u16;
        for b in &mut number {
            let n = carry * 256 + u16::from(*b);
            *b = (n / 10) as u8;
            carry = n % 10;
        }
        digits.push((b'0' + carry as u8) as char);
    }
    if digits.is_empty() {
        "0".into()
    } else {
        digits.into_iter().rev().collect()
    }
}
/// Project a typed child without a second parse or traversal-budget reset.
pub fn project_blackjack_item(parsed: &ParsedFrame) -> Result<BlackjackProjection, Error> {
    let Some(TypedPayload::BlackjackItem(wire)) = parsed.typed.as_deref() else {
        return Err(Error::Context(ContextError(
            "expected a typed schema-1 blackjack frame".into(),
        )));
    };
    use BlackjackAction::*;
    let action = match &wire.action {
        Bet { wager_tx_hash } => Bet {
            wager_tx_hash: format!("0x{}", hex(wager_tx_hash)),
        },
        Deal {
            server_seed_hash,
            player_cards,
            dealer_up_card,
        } => Deal {
            server_seed_hash: hex(server_seed_hash),
            player_cards: player_cards.clone(),
            dealer_up_card: *dealer_up_card,
        },
        HitRequest => HitRequest,
        HitResponse { player_cards } => HitResponse {
            player_cards: player_cards.clone(),
        },
        Stand => Stand,
        DoubleRequest {
            double_wager_tx_hash,
        } => DoubleRequest {
            double_wager_tx_hash: format!("0x{}", hex(double_wager_tx_hash)),
        },
        DoubleResponse { player_cards } => DoubleResponse {
            player_cards: player_cards.clone(),
        },
        Reveal {
            dealer_cards,
            server_seed,
            outcome,
        } => Reveal {
            dealer_cards: dealer_cards.clone(),
            server_seed: server_seed.clone(),
            outcome: *outcome,
        },
        Welcome {
            min_wager_wei,
            max_wager_wei,
            fee_hint_wei,
            rules,
        } => Welcome {
            min_wager_wei: decimal(min_wager_wei),
            max_wager_wei: decimal(max_wager_wei),
            fee_hint_wei: fee_hint_wei.as_ref().map(|b| decimal(b)),
            rules: rules.clone(),
        },
    };
    Ok(BlackjackProjection {
        frame: parsed.frame.clone(),
        item: BlackjackFields {
            game_id: wire.game_id.clone(),
            action,
        },
    })
}

/// The closed peer-to-peer hand shapes (type 18, schema 2). Hashes are 64 bare lowercase hex
/// characters, quantities exact decimal strings. No shape carries an amount of money: a wager,
/// payout or refund is the stamp of the message that carries the item.
pub type BlackjackHandItem = BlackjackHandFields<String, String>;
/// Owned exact original bytes and their schema-2 application projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlackjackHandProjection {
    /// Original exact frame bytes.
    pub frame: Vec<u8>,
    /// Closed application value.
    pub item: BlackjackHandItem,
}
/// Deterministic writer for one hand item; the typed validator then enforces every wire rule.
pub fn encode_blackjack_hand_item(item: &BlackjackHandItem) -> Result<Vec<u8>, Error> {
    use blackjack_hand_action as A;
    use blackjack_hand_item as K;
    use BlackjackHandAction::*;
    let mut fields = vec![(K::GAME_ID, CborValue::Text(item.game_id.clone()))];
    // Wire action codes 16..25; challenge role 0 is the dealer, 1 the player.
    let action = match &item.action {
        ChallengeDealer {
            max_bet_wei,
            commitment,
        } => {
            fields.extend([
                (K::ROLE, int(blackjack_role::DEALER)),
                (K::MAX_BET_WEI, CborValue::Bytes(quantity(max_bet_wei)?)),
                (K::COMMITMENT, CborValue::Bytes(hash(commitment, false)?)),
            ]);
            A::CHALLENGE
        }
        ChallengePlayer { max_bet_wei } => {
            fields.extend([
                (K::ROLE, int(blackjack_role::PLAYER)),
                (K::MAX_BET_WEI, CborValue::Bytes(quantity(max_bet_wei)?)),
            ]);
            A::CHALLENGE
        }
        Accept {
            max_bet_wei,
            commitment,
        } => {
            fields.extend([
                (K::MAX_BET_WEI, CborValue::Bytes(quantity(max_bet_wei)?)),
                (K::COMMITMENT, CborValue::Bytes(hash(commitment, false)?)),
            ]);
            A::ACCEPT
        }
        Bet => A::BET,
        Deal {
            player_cards,
            dealer_up_card,
        } => {
            fields.extend([
                (K::PLAYER_CARDS, cards(player_cards)),
                (K::DEALER_UP_CARD, int(*dealer_up_card)),
            ]);
            A::DEAL
        }
        Hit => A::HIT,
        Stand => A::STAND,
        Double => A::DOUBLE,
        Card { player_cards } => {
            fields.push((K::PLAYER_CARDS, cards(player_cards)));
            A::CARD
        }
        Reveal {
            dealer_cards,
            seed,
            outcome,
        } => {
            fields.extend([
                (K::DEALER_CARDS, cards(dealer_cards)),
                (K::SEED, CborValue::Text(seed.clone())),
                (K::OUTCOME, int(outcome_code(outcome))),
            ]);
            A::REVEAL
        }
        Refund { reference } => {
            fields.push((K::REF, CborValue::Bytes(hash(reference, false)?)));
            A::REFUND
        }
    };
    fields.push((K::ACTION, int(action)));
    let payload = cbor_map(fields);
    let bytes = encode_frame(
        EnvelopeFields {
            type_id: TYPE_BLACKJACK_MESSAGE_ITEM,
            schema_version: 2,
            min_reader_version: 2,
        },
        FramePayload::Value(&payload),
    )
    .map_err(|e| bad(&e.to_string()))?;
    validate_frame(&bytes, &default_context())?;
    Ok(bytes)
}
/// True for a parsed type-18 child that is a schema-2 hand item.
pub fn is_blackjack_hand_frame(parsed: &ParsedFrame) -> bool {
    matches!(
        parsed.typed.as_deref(),
        Some(TypedPayload::BlackjackHandItem(_))
    )
}
/// Project an already typed schema-2 child without a second parse; cards and frame are copied.
pub fn project_blackjack_hand_item(parsed: &ParsedFrame) -> Result<BlackjackHandProjection, Error> {
    let Some(TypedPayload::BlackjackHandItem(wire)) = parsed.typed.as_deref() else {
        return Err(Error::Context(ContextError(
            "expected a typed schema-2 blackjack frame".into(),
        )));
    };
    use BlackjackHandAction::*;
    let action = match &wire.action {
        ChallengeDealer {
            max_bet_wei,
            commitment,
        } => ChallengeDealer {
            max_bet_wei: decimal(max_bet_wei),
            commitment: hex(commitment),
        },
        ChallengePlayer { max_bet_wei } => ChallengePlayer {
            max_bet_wei: decimal(max_bet_wei),
        },
        Accept {
            max_bet_wei,
            commitment,
        } => Accept {
            max_bet_wei: decimal(max_bet_wei),
            commitment: hex(commitment),
        },
        Bet => Bet,
        Deal {
            player_cards,
            dealer_up_card,
        } => Deal {
            player_cards: player_cards.clone(),
            dealer_up_card: *dealer_up_card,
        },
        Hit => Hit,
        Stand => Stand,
        Double => Double,
        Card { player_cards } => Card {
            player_cards: player_cards.clone(),
        },
        Reveal {
            dealer_cards,
            seed,
            outcome,
        } => Reveal {
            dealer_cards: dealer_cards.clone(),
            seed: seed.clone(),
            outcome: *outcome,
        },
        Refund { reference } => Refund {
            reference: hex(reference),
        },
    };
    Ok(BlackjackHandProjection {
        frame: parsed.frame.clone(),
        item: BlackjackHandFields {
            game_id: wire.game_id.clone(),
            action,
        },
    })
}

/// The closed hand shapes with entropy from both sides (type 18, schema 3). Hashes are 64 bare
/// lowercase hex characters, quantities exact decimal strings. No shape states a card, an
/// outcome or an amount of money.
pub type BlackjackHandV3Item = BlackjackHandV3Fields<String, String>;
/// Owned exact original bytes and their schema-3 application projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlackjackHandV3Projection {
    /// Original exact frame bytes.
    pub frame: Vec<u8>,
    /// Closed application value.
    pub item: BlackjackHandV3Item,
}
/// Deterministic writer for one schema-3 hand item; the typed validator then enforces every
/// wire rule, including the range of `seq`.
pub fn encode_blackjack_hand_v3_item(item: &BlackjackHandV3Item) -> Result<Vec<u8>, Error> {
    use blackjack_hand_v3_action as A;
    use blackjack_hand_v3_item as K;
    use BlackjackHandV3Action::*;
    let bytes32 = |value: &str| Ok::<_, Error>(CborValue::Bytes(hash(value, false)?));
    let mut fields = vec![
        (K::GAME_ID, CborValue::Text(item.game_id.clone())),
        (K::SEQ, int(item.seq)),
    ];
    // Wire action codes 32..41; challenge role 0 is the dealer, 1 the player.
    let action = match &item.action {
        ChallengeDealer {
            max_bet_wei,
            commitment,
        } => {
            fields.extend([
                (K::ROLE, int(blackjack_role::DEALER)),
                (K::MAX_BET_WEI, CborValue::Bytes(quantity(max_bet_wei)?)),
                (K::COMMITMENT, bytes32(commitment)?),
            ]);
            A::CHALLENGE
        }
        ChallengePlayer { max_bet_wei } => {
            fields.extend([
                (K::ROLE, int(blackjack_role::PLAYER)),
                (K::MAX_BET_WEI, CborValue::Bytes(quantity(max_bet_wei)?)),
            ]);
            A::CHALLENGE
        }
        Accept {
            max_bet_wei,
            commitment,
            prev,
        } => {
            fields.extend([
                (K::MAX_BET_WEI, CborValue::Bytes(quantity(max_bet_wei)?)),
                (K::COMMITMENT, bytes32(commitment)?),
                (K::PREV, bytes32(prev)?),
            ]);
            A::ACCEPT
        }
        Bet { commitment, prev } => {
            fields.extend([
                (K::COMMITMENT, bytes32(commitment)?),
                (K::PREV, bytes32(prev)?),
            ]);
            A::BET
        }
        Move { kind, link, prev } => {
            fields.extend([(K::PREV, bytes32(prev)?), (K::LINK, bytes32(link)?)]);
            match kind {
                BlackjackHandV3Move::Deal => A::DEAL,
                BlackjackHandV3Move::Hit => A::HIT,
                BlackjackHandV3Move::Stand => A::STAND,
                BlackjackHandV3Move::Double => A::DOUBLE,
                BlackjackHandV3Move::Card => A::CARD,
                BlackjackHandV3Move::Reveal => A::REVEAL,
            }
        }
        Refund { reference, prev } => {
            fields.extend([(K::REF, bytes32(reference)?), (K::PREV, bytes32(prev)?)]);
            A::REFUND
        }
    };
    fields.push((K::ACTION, int(action)));
    let payload = cbor_map(fields);
    let bytes = encode_frame(
        EnvelopeFields {
            type_id: TYPE_BLACKJACK_MESSAGE_ITEM,
            schema_version: 3,
            min_reader_version: 2,
        },
        FramePayload::Value(&payload),
    )
    .map_err(|e| bad(&e.to_string()))?;
    validate_frame(&bytes, &default_context())?;
    Ok(bytes)
}
/// True for a parsed type-18 child that is a schema-3 hand item.
pub fn is_blackjack_hand_v3_frame(parsed: &ParsedFrame) -> bool {
    matches!(
        parsed.typed.as_deref(),
        Some(TypedPayload::BlackjackHandV3Item(_))
    )
}
/// Project an already typed schema-3 child without a second parse; the frame is copied.
pub fn project_blackjack_hand_v3_item(
    parsed: &ParsedFrame,
) -> Result<BlackjackHandV3Projection, Error> {
    let Some(TypedPayload::BlackjackHandV3Item(wire)) = parsed.typed.as_deref() else {
        return Err(Error::Context(ContextError(
            "expected a typed schema-3 blackjack frame".into(),
        )));
    };
    use BlackjackHandV3Action::*;
    let action = match &wire.action {
        ChallengeDealer {
            max_bet_wei,
            commitment,
        } => ChallengeDealer {
            max_bet_wei: decimal(max_bet_wei),
            commitment: hex(commitment),
        },
        ChallengePlayer { max_bet_wei } => ChallengePlayer {
            max_bet_wei: decimal(max_bet_wei),
        },
        Accept {
            max_bet_wei,
            commitment,
            prev,
        } => Accept {
            max_bet_wei: decimal(max_bet_wei),
            commitment: hex(commitment),
            prev: hex(prev),
        },
        Bet { commitment, prev } => Bet {
            commitment: hex(commitment),
            prev: hex(prev),
        },
        Move { kind, link, prev } => Move {
            kind: *kind,
            link: hex(link),
            prev: hex(prev),
        },
        Refund { reference, prev } => Refund {
            reference: hex(reference),
            prev: hex(prev),
        },
    };
    Ok(BlackjackHandV3Projection {
        frame: parsed.frame.clone(),
        item: BlackjackHandV3Fields {
            game_id: wire.game_id.clone(),
            seq: wire.seq,
            action,
        },
    })
}
