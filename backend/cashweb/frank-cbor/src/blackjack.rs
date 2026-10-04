//! Pure typed blackjack writer/projection. No game, fairness or payment authority.
use crate::{
    cbor_map, default_context, encode_frame, validate_frame, BlackjackAction, BlackjackFields,
    BlackjackHandAction, BlackjackHandFields, BlackjackOutcome, CborValue, CodecError,
    ContextError, EnvelopeFields, Error, ErrorCategory, ErrorStage, FramePayload, ParsedFrame,
    TypedPayload,
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
/// Deterministically encode a closed input through the same active typed validator.
pub fn encode_blackjack_item(item: &BlackjackItem) -> Result<Vec<u8>, Error> {
    use BlackjackAction::*;
    let mut fields = vec![(0, CborValue::Text(item.game_id.clone()))];
    let action = match &item.action {
        Bet { wager_tx_hash } => {
            fields.push((2, CborValue::Bytes(hash(wager_tx_hash, true)?)));
            0
        }
        Deal {
            server_seed_hash,
            player_cards,
            dealer_up_card,
        } => {
            fields.extend([
                (4, CborValue::Bytes(hash(server_seed_hash, false)?)),
                (5, cards(player_cards)),
                (6, CborValue::Int(i128::from(*dealer_up_card))),
            ]);
            1
        }
        HitRequest => 2,
        HitResponse { player_cards } => {
            fields.push((5, cards(player_cards)));
            2
        }
        Stand => 3,
        DoubleRequest {
            double_wager_tx_hash,
        } => {
            fields.push((3, CborValue::Bytes(hash(double_wager_tx_hash, true)?)));
            4
        }
        DoubleResponse { player_cards } => {
            fields.push((5, cards(player_cards)));
            4
        }
        Reveal {
            dealer_cards,
            server_seed,
            outcome,
        } => {
            let n = match outcome {
                BlackjackOutcome::PlayerWin => 0,
                BlackjackOutcome::DealerWin => 1,
                BlackjackOutcome::Push => 2,
                BlackjackOutcome::PlayerBlackjack => 3,
            };
            fields.extend([
                (7, cards(dealer_cards)),
                (8, CborValue::Text(server_seed.clone())),
                (9, CborValue::Int(n)),
            ]);
            5
        }
        Welcome {
            min_wager_wei,
            max_wager_wei,
            fee_hint_wei,
            rules,
        } => {
            fields.extend([
                (10, CborValue::Bytes(quantity(min_wager_wei)?)),
                (11, CborValue::Bytes(quantity(max_wager_wei)?)),
            ]);
            if let Some(fee) = fee_hint_wei {
                fields.push((12, CborValue::Bytes(quantity(fee)?)));
            }
            if let Some(rules) = rules {
                fields.push((13, CborValue::Text(rules.clone())));
            }
            6
        }
    };
    fields.push((1, CborValue::Int(action)));
    let payload = cbor_map(fields);
    let bytes = encode_frame(
        EnvelopeFields {
            type_id: 18,
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
    use BlackjackHandAction::*;
    let mut fields = vec![(0, CborValue::Text(item.game_id.clone()))];
    // Wire action codes 16..25; challenge role 0 is the dealer, 1 the player.
    let action = match &item.action {
        ChallengeDealer {
            max_bet_wei,
            commitment,
        } => {
            fields.extend([
                (2, CborValue::Int(0)),
                (3, CborValue::Bytes(quantity(max_bet_wei)?)),
                (4, CborValue::Bytes(hash(commitment, false)?)),
            ]);
            16
        }
        ChallengePlayer { max_bet_wei } => {
            fields.extend([
                (2, CborValue::Int(1)),
                (3, CborValue::Bytes(quantity(max_bet_wei)?)),
            ]);
            16
        }
        Accept {
            max_bet_wei,
            commitment,
        } => {
            fields.extend([
                (3, CborValue::Bytes(quantity(max_bet_wei)?)),
                (4, CborValue::Bytes(hash(commitment, false)?)),
            ]);
            17
        }
        Bet => 18,
        Deal {
            player_cards,
            dealer_up_card,
        } => {
            fields.extend([
                (5, cards(player_cards)),
                (6, CborValue::Int(i128::from(*dealer_up_card))),
            ]);
            19
        }
        Hit => 20,
        Stand => 21,
        Double => 22,
        Card { player_cards } => {
            fields.push((5, cards(player_cards)));
            23
        }
        Reveal {
            dealer_cards,
            seed,
            outcome,
        } => {
            let n = match outcome {
                BlackjackOutcome::PlayerWin => 0,
                BlackjackOutcome::DealerWin => 1,
                BlackjackOutcome::Push => 2,
                BlackjackOutcome::PlayerBlackjack => 3,
            };
            fields.extend([
                (7, cards(dealer_cards)),
                (8, CborValue::Text(seed.clone())),
                (9, CborValue::Int(n)),
            ]);
            24
        }
        Refund { reference } => {
            fields.push((10, CborValue::Bytes(hash(reference, false)?)));
            25
        }
    };
    fields.push((1, CborValue::Int(action)));
    let payload = cbor_map(fields);
    let bytes = encode_frame(
        EnvelopeFields {
            type_id: 18,
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
