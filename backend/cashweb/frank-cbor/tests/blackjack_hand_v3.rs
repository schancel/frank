//! Shared corpus of the hand with entropy from both sides (type 18, schema 3 / min reader 2)
//! through the public facade. No game runtime, fairness or payment authority.
mod common;
use frank_cbor::*;
use serde_json::{json, Value};

/// A well-formed hand game id: exactly 32 lowercase ASCII hex characters.
const GAME: &str = "00112233445566778899aabbccddeeff";

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/blackjack-hand-v3.json"
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
const MOVES: [(&str, BlackjackHandV3Move); 6] = [
    ("deal", BlackjackHandV3Move::Deal),
    ("hit", BlackjackHandV3Move::Hit),
    ("stand", BlackjackHandV3Move::Stand),
    ("double", BlackjackHandV3Move::Double),
    ("card", BlackjackHandV3Move::Card),
    ("reveal", BlackjackHandV3Move::Reveal),
];
/// The corpus `application` object as the closed Rust item; `None` when it is not one.
fn item(v: &Value) -> Option<BlackjackHandV3Item> {
    use BlackjackHandV3Action::*;
    let object = v.as_object()?;
    let text = |k: &str| v[k].as_str().map(str::to_owned);
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
                prev: text("prev")?,
            },
            &["maxBetWei", "commitment", "prev"],
        ),
        "bet" => (
            Bet {
                commitment: text("commitment")?,
                prev: text("prev")?,
            },
            &["commitment", "prev"],
        ),
        "refund" => (
            Refund {
                reference: text("ref")?,
                prev: text("prev")?,
            },
            &["ref", "prev"],
        ),
        name => (
            Move {
                kind: MOVES.iter().find(|(n, _)| *n == name)?.1,
                link: text("link")?,
                prev: text("prev")?,
            },
            &["link", "prev"],
        ),
    };
    // Closed: exactly type, gameId, action, seq and the selected shape's fields.
    if object.len() != names.len() + 4 {
        return None;
    }
    Some(BlackjackHandV3Fields {
        game_id: text("gameId")?,
        seq: u32::try_from(v["seq"].as_u64()?).ok()?,
        action,
    })
}
fn application(item: &BlackjackHandV3Item) -> Value {
    use BlackjackHandV3Action::*;
    let mut v = json!({"type":"blackjack-hand","gameId":item.game_id,"seq":item.seq});
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
            prev,
        } => {
            v["maxBetWei"] = json!(max_bet_wei);
            v["commitment"] = json!(commitment);
            v["prev"] = json!(prev);
            "accept"
        }
        Bet { commitment, prev } => {
            v["commitment"] = json!(commitment);
            v["prev"] = json!(prev);
            "bet"
        }
        Move { kind, link, prev } => {
            v["link"] = json!(link);
            v["prev"] = json!(prev);
            MOVES.iter().find(|(_, k)| k == kind).unwrap().0
        }
        Refund { reference, prev } => {
            v["ref"] = json!(reference);
            v["prev"] = json!(prev);
            "refund"
        }
    };
    v["action"] = json!(action);
    v
}

#[test]
fn shared_corpus_reader_projection_and_writer() {
    let c = corpus();
    assert_eq!(c["format"], "blackjack-hand-v3");
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
                assert_eq!((p.schema_version, p.min_reader_version), (3, 2), "{id}");
                assert!(is_blackjack_hand_v3_frame(&p), "{id}");
                let expected = f.get("application").expect("accepted frames carry an item");
                let projected = project_blackjack_hand_v3_item(&p).unwrap();
                assert_eq!(projected.frame, raw, "{id}");
                assert_eq!(application(&projected.item), *expected, "{id}");
                let input = item(expected).unwrap_or_else(|| panic!("{id}: closed item"));
                assert_eq!(input, projected.item, "{id}");
                assert_eq!(
                    hex::encode(encode_blackjack_hand_v3_item(&input).unwrap()),
                    f["frameHex"].as_str().unwrap(),
                    "{id}"
                );
                // A schema-3 item is never handed to the schema-1 or schema-2 projection.
                assert!(!is_blackjack_hand_frame(&p), "{id}");
                assert!(matches!(project_blackjack_item(&p), Err(Error::Context(_))));
                assert!(matches!(
                    project_blackjack_hand_item(&p),
                    Err(Error::Context(_))
                ));
                actions.insert((
                    expected["action"].as_str().unwrap().to_owned(),
                    expected["role"].as_str().unwrap_or("").to_owned(),
                ));
            }
            other => panic!("{id}: result {other}"),
        }
    }
    assert_eq!((accepted, rejected), (11, 32));
    assert_eq!(actions.len(), 11, "every closed shape is exercised");
}

#[test]
fn reader_without_schema3_rejects_v3_action_codes_as_out_of_range() {
    let c = corpus();
    let mut ctx = context(&c, "schema2");
    for f in c["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["expected"]["result"] == "accept")
    {
        let raw = hex::decode(f["frameHex"].as_str().unwrap()).unwrap();
        // Not an unsupported frame and never retained: the code is outside the schema-2 range.
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
fn schema2_hand_frames_and_v3_frames_are_distinct() {
    let hit = BlackjackHandFields {
        game_id: GAME.into(),
        action: BlackjackHandAction::Hit,
    };
    let v2 = parsed(&encode_blackjack_hand_item(&hit).unwrap());
    assert_eq!((v2.schema_version, v2.min_reader_version), (2, 2));
    assert!(is_blackjack_hand_frame(&v2));
    assert!(!is_blackjack_hand_v3_frame(&v2));
    assert!(matches!(
        project_blackjack_hand_v3_item(&v2),
        Err(Error::Context(_))
    ));
    assert_eq!(project_blackjack_hand_item(&v2).unwrap().item, hit);

    let hit3 = BlackjackHandV3Fields {
        game_id: GAME.into(),
        seq: 4,
        action: BlackjackHandV3Action::Move {
            kind: BlackjackHandV3Move::Hit,
            link: "01".repeat(32),
            prev: "d1".repeat(32),
        },
    };
    let frame = encode_blackjack_hand_v3_item(&hit3).unwrap();
    let v3 = parsed(&frame);
    assert_eq!((v3.schema_version, v3.min_reader_version), (3, 2));
    assert!(is_blackjack_hand_v3_frame(&v3));
    assert!(!is_blackjack_hand_frame(&v3));
    assert!(matches!(
        project_blackjack_hand_item(&v3),
        Err(Error::Context(_))
    ));

    // A schema-1 item is neither.
    let stand = parsed(
        &encode_blackjack_item(&BlackjackFields {
            game_id: "g".into(),
            action: BlackjackAction::Stand,
        })
        .unwrap(),
    );
    assert!(!is_blackjack_hand_v3_frame(&stand));
    assert!(matches!(
        project_blackjack_hand_v3_item(&stand),
        Err(Error::Context(_))
    ));

    // A schema-2 hand shape and a schema-1 shape in a schema-3 frame keep their own shapes.
    let schema3 = |payload: &CborValue| {
        encode_frame(
            EnvelopeFields {
                type_id: 18,
                schema_version: 3,
                min_reader_version: 2,
            },
            FramePayload::Value(payload),
        )
        .unwrap()
    };
    let old_hit = parsed(&schema3(&cbor_map(vec![
        (0, CborValue::Text(GAME.into())),
        (1, CborValue::Int(20)),
    ])));
    assert!(is_blackjack_hand_frame(&old_hit) && !is_blackjack_hand_v3_frame(&old_hit));
    assert_eq!(project_blackjack_hand_item(&old_hit).unwrap().item, hit);
    let old_stand = parsed(&schema3(&cbor_map(vec![
        (0, CborValue::Text("g".into())),
        (1, CborValue::Int(3)),
    ])));
    assert!(!is_blackjack_hand_frame(&old_stand) && !is_blackjack_hand_v3_frame(&old_stand));
    assert_eq!(
        project_blackjack_item(&old_stand).unwrap().item.action,
        BlackjackAction::Stand
    );

    // Nested in a container, a schema-3 item is typed and keeps its exact bytes.
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
    assert_eq!(project_blackjack_hand_v3_item(child).unwrap().item, hit3);
    assert_eq!(child.frame, frame);
}

#[test]
fn writer_refuses_malformed_items() {
    use BlackjackHandV3Action::*;
    let ok = "a".repeat(64);
    let mv = |link: &str, prev: &str| Move {
        kind: BlackjackHandV3Move::Hit,
        link: link.into(),
        prev: prev.into(),
    };
    let refused = [
        // seq: 0 only on a challenge, 1..=255 everywhere else.
        (0, mv(&ok, &ok)),
        (256, mv(&ok, &ok)),
        (
            1,
            ChallengePlayer {
                max_bet_wei: "5".into(),
            },
        ),
        (
            1,
            ChallengeDealer {
                max_bet_wei: "5".into(),
                commitment: ok.clone(),
            },
        ),
        (
            0,
            Bet {
                commitment: ok.clone(),
                prev: ok.clone(),
            },
        ),
        // Missing, short, long, prefixed or uppercase hashes.
        (1, mv("", &ok)),
        (1, mv(&ok, "")),
        (1, mv(&"a".repeat(62), &ok)),
        (1, mv(&ok, &"a".repeat(63))),
        (1, mv(&"a".repeat(66), &ok)),
        (1, mv(&format!("0x{ok}"), &ok)),
        (1, mv(&ok, &"A".repeat(64))),
        (
            2,
            Bet {
                commitment: "a".repeat(63),
                prev: ok.clone(),
            },
        ),
        (
            3,
            Refund {
                reference: String::new(),
                prev: ok.clone(),
            },
        ),
        (
            0,
            ChallengeDealer {
                max_bet_wei: "5".into(),
                commitment: "a".repeat(63),
            },
        ),
        // Maximum bet: 1..40 decimal digits, positive.
        (
            0,
            ChallengePlayer {
                max_bet_wei: "0".into(),
            },
        ),
        (
            0,
            ChallengePlayer {
                max_bet_wei: "-5".into(),
            },
        ),
        (
            0,
            ChallengePlayer {
                max_bet_wei: String::new(),
            },
        ),
        (
            0,
            ChallengePlayer {
                max_bet_wei: "1".repeat(41),
            },
        ),
        (
            1,
            Accept {
                max_bet_wei: "0".into(),
                commitment: ok.clone(),
                prev: ok.clone(),
            },
        ),
    ];
    for (seq, action) in refused {
        let item = BlackjackHandV3Fields {
            game_id: GAME.into(),
            seq,
            action,
        };
        assert!(
            matches!(encode_blackjack_hand_v3_item(&item), Err(Error::Codec(_))),
            "{item:?}"
        );
    }
    // The game id is exactly 32 lowercase ASCII hex characters.
    for game_id in [
        String::new(),
        "g".to_owned(),
        "__proto__".to_owned(),
        GAME[..31].to_owned(),
        format!("{GAME}0"),
        GAME.to_uppercase(),
        format!("{}g", &GAME[..31]),
    ] {
        let item = BlackjackHandV3Fields {
            game_id,
            seq: 1,
            action: mv(&ok, &ok),
        };
        match encode_blackjack_hand_v3_item(&item) {
            Err(Error::Codec(e)) => {
                assert_eq!(
                    format!("{}@{}", e.category, e.stage),
                    "schema@8.2",
                    "{item:?}"
                )
            }
            other => panic!("{item:?}: {other:?}"),
        }
    }
    // The bounds that are allowed round-trip exactly: seq 255 and a maximum bet of 10^40 - 1.
    for (seq, action) in [
        (255, mv(&ok, &ok)),
        (1, mv(&ok, &ok)),
        (
            0,
            ChallengePlayer {
                max_bet_wei: "9".repeat(40),
            },
        ),
    ] {
        let item = BlackjackHandV3Fields {
            game_id: GAME.into(),
            seq,
            action,
        };
        let frame = encode_blackjack_hand_v3_item(&item).unwrap();
        assert_eq!(
            project_blackjack_hand_v3_item(&parsed(&frame))
                .unwrap()
                .item,
            item
        );
    }
    // Application JSON outside the closed shapes has no typed item.
    for bad in [
        json!({"type":"blackjack-hand","gameId":GAME,"action":"hit","seq":1,"prev":ok,"link":ok,"playerCards":[1,2,3]}),
        json!({"type":"blackjack-hand","gameId":GAME,"action":"hit","seq":1,"prev":ok}),
        json!({"type":"blackjack-hand","gameId":GAME,"action":"hit","prev":ok,"link":ok}),
        json!({"type":"blackjack-hand","gameId":GAME,"action":"welcome","seq":1,"prev":ok,"link":ok}),
        json!({"type":"blackjack-hand","gameId":GAME,"action":"challenge","seq":0,"role":"house","maxBetWei":"5"}),
        json!({"type":"blackjack-hand","gameId":GAME,"action":"challenge","seq":0,"role":"player","maxBetWei":"5","commitment":ok}),
        json!({"type":"blackjack-hand","gameId":GAME,"action":"challenge","seq":0,"role":"dealer","maxBetWei":"5"}),
        json!({"type":"blackjack-hand","gameId":GAME,"action":"bet","seq":2,"prev":ok}),
        json!({"type":"blackjack-move","gameId":GAME,"action":"hit","seq":1,"prev":ok,"link":ok}),
        Value::Null,
    ] {
        assert!(item(&bad).is_none(), "{bad}");
    }
}
