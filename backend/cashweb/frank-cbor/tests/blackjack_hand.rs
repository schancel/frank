//! Shared peer-to-peer hand corpus (type 18, schema 2 / min reader 2) through the public facade.
//! No game runtime, fairness or payment authority.
mod common;
use frank_cbor::*;
use serde_json::{json, Value};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/blackjack-hand.json"
    ))
    .unwrap()
}
/// `default` is the reader's default context; a named context overrides only the keys it lists.
fn context(c: &Value, name: &str) -> ValidationContext {
    let vc = c["contexts"]
        .get(name)
        .unwrap_or_else(|| panic!("unknown context {name}"));
    let mut ctx = default_context();
    for (key, value) in vc.as_object().unwrap() {
        match key.as_str() {
            "readerVersion" => ctx.reader_version = value.as_u64().unwrap() as u32,
            "supportedSchemas" => {
                ctx.supported_schemas = value
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| SupportedSchema {
                        type_id: s["typeId"].as_u64().unwrap() as u32,
                        schema_version: s["schemaVersion"].as_u64().unwrap() as u32,
                    })
                    .collect()
            }
            "opaqueRetentionAllowed" => ctx.opaque_retention_allowed = value.as_bool().unwrap(),
            other => panic!("unknown context key {other}"),
        }
    }
    ctx
}
fn parsed(bytes: &[u8]) -> ParsedFrame {
    match parse_frame(bytes, &default_context()).unwrap() {
        ValidationResult::Parsed(p) => p,
        _ => panic!("not parsed"),
    }
}
fn outcome<T>(r: Result<T, Error>) -> String {
    match r {
        Ok(_) => "parsed".into(),
        Err(Error::Codec(e)) => format!("{}@{}", e.category, e.stage),
        Err(e) => panic!("{e}"),
    }
}
/// The corpus `application` object as the closed Rust item; `None` when it is not one.
fn item(v: &Value) -> Option<BlackjackHandItem> {
    use BlackjackHandAction::*;
    let object = v.as_object()?;
    let text = |k: &str| v[k].as_str().map(str::to_owned);
    let hand = |k: &str| {
        v[k].as_array()?
            .iter()
            .map(|n| n.as_u64().and_then(|n| u32::try_from(n).ok()))
            .collect::<Option<Vec<_>>>()
    };
    if v["type"] != "blackjack-hand" {
        return None;
    }
    let (action, names): (_, &[&str]) = match v["action"].as_str()? {
        "challenge" => match v["role"].as_str()? {
            "dealer" => (
                ChallengeDealer {
                    max_bet_wei: text("maxBetWei")?,
                    commitment: text("commitment")?,
                },
                &["role", "maxBetWei", "commitment"],
            ),
            "player" => (
                ChallengePlayer {
                    max_bet_wei: text("maxBetWei")?,
                },
                &["role", "maxBetWei"],
            ),
            _ => return None,
        },
        "accept" => (
            Accept {
                max_bet_wei: text("maxBetWei")?,
                commitment: text("commitment")?,
            },
            &["maxBetWei", "commitment"],
        ),
        "bet" => (Bet, &[]),
        "deal" => (
            Deal {
                player_cards: hand("playerCards")?,
                dealer_up_card: u32::try_from(v["dealerUpCard"].as_u64()?).ok()?,
            },
            &["playerCards", "dealerUpCard"],
        ),
        "hit" => (Hit, &[]),
        "stand" => (Stand, &[]),
        "double" => (Double, &[]),
        "card" => (
            Card {
                player_cards: hand("playerCards")?,
            },
            &["playerCards"],
        ),
        "reveal" => (
            Reveal {
                dealer_cards: hand("dealerCards")?,
                seed: text("seed")?,
                outcome: match v["outcome"].as_str()? {
                    "player_win" => BlackjackOutcome::PlayerWin,
                    "dealer_win" => BlackjackOutcome::DealerWin,
                    "push" => BlackjackOutcome::Push,
                    "player_blackjack" => BlackjackOutcome::PlayerBlackjack,
                    _ => return None,
                },
            },
            &["dealerCards", "seed", "outcome"],
        ),
        "refund" => (
            Refund {
                reference: text("ref")?,
            },
            &["ref"],
        ),
        _ => return None,
    };
    // Closed: exactly type, gameId, action and the selected shape's fields.
    if object.len() != names.len() + 3 {
        return None;
    }
    Some(BlackjackHandFields {
        game_id: text("gameId")?,
        action,
    })
}
fn application(item: &BlackjackHandItem) -> Value {
    use BlackjackHandAction::*;
    let mut v = json!({"type":"blackjack-hand","gameId":item.game_id});
    let action = match &item.action {
        ChallengeDealer {
            max_bet_wei,
            commitment,
        } => {
            v["role"] = json!("dealer");
            v["maxBetWei"] = json!(max_bet_wei);
            v["commitment"] = json!(commitment);
            "challenge"
        }
        ChallengePlayer { max_bet_wei } => {
            v["role"] = json!("player");
            v["maxBetWei"] = json!(max_bet_wei);
            "challenge"
        }
        Accept {
            max_bet_wei,
            commitment,
        } => {
            v["maxBetWei"] = json!(max_bet_wei);
            v["commitment"] = json!(commitment);
            "accept"
        }
        Bet => "bet",
        Deal {
            player_cards,
            dealer_up_card,
        } => {
            v["playerCards"] = json!(player_cards);
            v["dealerUpCard"] = json!(dealer_up_card);
            "deal"
        }
        Hit => "hit",
        Stand => "stand",
        Double => "double",
        Card { player_cards } => {
            v["playerCards"] = json!(player_cards);
            "card"
        }
        Reveal {
            dealer_cards,
            seed,
            outcome,
        } => {
            v["dealerCards"] = json!(dealer_cards);
            v["seed"] = json!(seed);
            v["outcome"] = json!(match outcome {
                BlackjackOutcome::PlayerWin => "player_win",
                BlackjackOutcome::DealerWin => "dealer_win",
                BlackjackOutcome::Push => "push",
                BlackjackOutcome::PlayerBlackjack => "player_blackjack",
            });
            "reveal"
        }
        Refund { reference } => {
            v["ref"] = json!(reference);
            "refund"
        }
    };
    v["action"] = json!(action);
    v
}

#[test]
fn shared_corpus_reader_projection_and_writer() {
    let c = corpus();
    assert_eq!(c["format"], "blackjack-hand-v2");
    let frames = c["frames"].as_array().unwrap();
    let (mut accepted, mut rejected) = (0, 0);
    let mut actions = std::collections::BTreeSet::new();
    for f in frames {
        let id = f["id"].as_str().unwrap();
        let raw = hex::decode(f["frameHex"].as_str().unwrap()).unwrap();
        let ctx = context(&c, f["context"].as_str().unwrap());
        let result = parse_frame(&raw, &ctx);
        match f["expected"]["result"].as_str().unwrap() {
            "reject" => {
                rejected += 1;
                assert_eq!(
                    outcome(result),
                    format!(
                        "{}@{}",
                        f["expected"]["category"].as_str().unwrap(),
                        f["expected"]["stage"].as_str().unwrap()
                    ),
                    "{id}"
                );
            }
            "accept" => {
                accepted += 1;
                let ValidationResult::Parsed(p) = result.unwrap_or_else(|e| panic!("{id}: {e}"))
                else {
                    panic!("typed {id}")
                };
                assert_eq!((p.schema_version, p.min_reader_version), (2, 2), "{id}");
                assert!(is_blackjack_hand_frame(&p), "{id}");
                let expected = f.get("application").expect("accepted frames carry an item");
                let projected = project_blackjack_hand_item(&p).unwrap();
                assert_eq!(projected.frame, raw, "{id}");
                assert_eq!(application(&projected.item), *expected, "{id}");
                let input = item(expected).unwrap_or_else(|| panic!("{id}: closed item"));
                assert_eq!(input, projected.item, "{id}");
                assert_eq!(
                    hex::encode(encode_blackjack_hand_item(&input).unwrap()),
                    f["frameHex"].as_str().unwrap(),
                    "{id}"
                );
                // A hand item is never handed to the schema-1 projection.
                assert!(matches!(project_blackjack_item(&p), Err(Error::Context(_))));
                actions.insert((
                    expected["action"].as_str().unwrap().to_owned(),
                    expected["role"].as_str().unwrap_or("").to_owned(),
                ));
            }
            other => panic!("{id}: result {other}"),
        }
    }
    assert_eq!((accepted, rejected), (11, 27));
    assert_eq!(actions.len(), 11, "every closed shape is exercised");
}

#[test]
fn reader_without_schema2_rejects_hand_action_codes_as_out_of_range() {
    let c = corpus();
    let mut ctx = context(&c, "schema1");
    for f in c["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["expected"]["result"] == "accept")
    {
        let raw = hex::decode(f["frameHex"].as_str().unwrap()).unwrap();
        // Not an unsupported frame and never retained: the code is outside the schema-1 range.
        for retention in [false, true] {
            ctx.opaque_retention_allowed = retention;
            assert_eq!(
                outcome(parse_frame(&raw, &ctx)),
                "schema@8.2",
                "{}",
                f["id"]
            );
        }
    }
}

#[test]
fn schema1_shaped_frame_requiring_reader2_stays_schema1() {
    // Frozen: schema 2, min reader 2, action 3.
    let raw = hex::decode("46524e4b0100000012a40012010202020349a20064626a2d310103").unwrap();
    let p = parsed(&raw);
    assert_eq!((p.schema_version, p.min_reader_version), (2, 2));
    assert!(!is_blackjack_hand_frame(&p));
    assert!(matches!(
        project_blackjack_hand_item(&p),
        Err(Error::Context(_))
    ));
    let projected = project_blackjack_item(&p).unwrap();
    assert_eq!(projected.frame, raw);
    assert_eq!(
        projected.item,
        BlackjackFields {
            game_id: "bj-1".into(),
            action: BlackjackAction::Stand,
        }
    );
    // The same holds for a reader without type-18 schema-2 support.
    let ValidationResult::Parsed(old) = parse_frame(&raw, &context(&corpus(), "schema1")).unwrap()
    else {
        panic!("typed")
    };
    assert_eq!(project_blackjack_item(&old).unwrap().item, projected.item);
}

#[test]
fn schema1_items_are_not_hand_items_and_nested_hand_items_are_typed() {
    let stand = encode_blackjack_item(&BlackjackFields {
        game_id: "g".into(),
        action: BlackjackAction::Stand,
    })
    .unwrap();
    let p = parsed(&stand);
    assert!(!is_blackjack_hand_frame(&p));
    assert!(matches!(
        project_blackjack_hand_item(&p),
        Err(Error::Context(_))
    ));
    let hit = BlackjackHandFields {
        game_id: "g".into(),
        action: BlackjackHandAction::Hit,
    };
    let frame = encode_blackjack_hand_item(&hit).unwrap();
    let nested = common::fr(
        16,
        &cbor_map(vec![(
            0,
            CborValue::Array(vec![CborValue::Bytes(frame.clone())]),
        )]),
    );
    let Some(TypedPayload::ContainerItem { items, .. }) = parsed(&nested).typed.as_deref().cloned()
    else {
        panic!("container")
    };
    let ChildFrame::Parsed(child) = &items[0] else {
        panic!("typed child")
    };
    assert_eq!(project_blackjack_hand_item(child).unwrap().item, hit);
    assert_eq!(child.frame, frame);
}

#[test]
fn writer_refuses_invalid_presentation_and_semantics() {
    use BlackjackHandAction::*;
    let ok = "a".repeat(64);
    let refused = [
        ChallengePlayer {
            max_bet_wei: "-5".into(),
        },
        ChallengePlayer {
            max_bet_wei: "0".into(),
        },
        ChallengePlayer {
            max_bet_wei: String::new(),
        },
        ChallengePlayer {
            max_bet_wei: "1".repeat(41),
        },
        ChallengeDealer {
            max_bet_wei: "5".into(),
            commitment: "a".repeat(63),
        },
        Accept {
            max_bet_wei: "5".into(),
            commitment: format!("0x{ok}"),
        },
        Accept {
            max_bet_wei: "0".into(),
            commitment: ok.clone(),
        },
        Refund {
            reference: "A".repeat(64),
        },
        Reveal {
            dealer_cards: vec![1, 2],
            seed: "A".repeat(64),
            outcome: BlackjackOutcome::Push,
        },
        Card {
            player_cards: vec![1, 1, 2],
        },
        Card {
            player_cards: vec![1, 2],
        },
        Deal {
            player_cards: vec![1, 2],
            dealer_up_card: 2,
        },
        Deal {
            player_cards: vec![1, 52],
            dealer_up_card: 2,
        },
    ];
    for action in refused {
        let item = BlackjackHandFields {
            game_id: "g".into(),
            action,
        };
        assert!(
            matches!(encode_blackjack_hand_item(&item), Err(Error::Codec(_))),
            "{item:?}"
        );
    }
    let empty_game = BlackjackHandFields {
        game_id: String::new(),
        action: Bet,
    };
    assert!(matches!(
        encode_blackjack_hand_item(&empty_game),
        Err(Error::Codec(_))
    ));
    // The largest allowed maximum bet, 10^40 - 1, round-trips exactly.
    let max = BlackjackHandFields {
        game_id: "g".into(),
        action: ChallengePlayer {
            max_bet_wei: "9".repeat(40),
        },
    };
    let frame = encode_blackjack_hand_item(&max).unwrap();
    assert_eq!(
        project_blackjack_hand_item(&parsed(&frame)).unwrap().item,
        max
    );
    // Application JSON outside the closed shapes has no typed item.
    for bad in [
        json!({"type":"blackjack-hand","gameId":"g","action":"bet","wagerWei":"5"}),
        json!({"type":"blackjack-hand","gameId":"g","action":"welcome"}),
        json!({"type":"blackjack-hand","gameId":"g","action":"challenge","role":"house","maxBetWei":"5"}),
        json!({"type":"blackjack-hand","gameId":"g","action":"challenge","role":"player","maxBetWei":"5","commitment":ok}),
        json!({"type":"blackjack-hand","gameId":"g","action":"challenge","role":"dealer","maxBetWei":"5"}),
        json!({"type":"blackjack-hand","gameId":"g","action":"challenge","role":"player","maxBetWei":5}),
        json!({"type":"blackjack-move","gameId":"g","action":"bet"}),
        json!({"type":"blackjack-hand","action":"bet"}),
        Value::Null,
    ] {
        assert!(item(&bad).is_none(), "{bad}");
    }
}
