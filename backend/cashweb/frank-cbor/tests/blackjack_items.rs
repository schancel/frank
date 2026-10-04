//! Active public-facade conformance; no game runtime, authentication or payment authority.
mod common;
use frank_cbor::*;
use serde_json::{json, Value};
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/blackjack-items.json"
    ))
    .unwrap()
}
fn bytes(id: &str) -> Vec<u8> {
    let c = corpus();
    hex::decode(
        c["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == id)
            .unwrap()["frameHex"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
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
fn item(v: &Value) -> Option<BlackjackItem> {
    use BlackjackAction::*;
    let text = |k: &str| v[k].as_str().map(str::to_owned);
    let hand = |k: &str| {
        v[k].as_array()?
            .iter()
            .map(|n| n.as_u64().and_then(|n| u32::try_from(n).ok()))
            .collect::<Option<Vec<_>>>()
    };
    let action = match v["action"].as_str()? {
        "bet" => Bet {
            wager_tx_hash: text("wagerTxHash")?,
        },
        "deal" => Deal {
            server_seed_hash: text("serverSeedHash")?,
            player_cards: hand("playerCards")?,
            dealer_up_card: u32::try_from(v["dealerUpCard"].as_u64()?).ok()?,
        },
        "hit" if v.get("playerCards").is_some() => HitResponse {
            player_cards: hand("playerCards")?,
        },
        "hit" => HitRequest,
        "stand" => Stand,
        "double" if v.get("doubleWagerTxHash").is_some() => DoubleRequest {
            double_wager_tx_hash: text("doubleWagerTxHash")?,
        },
        "double" => DoubleResponse {
            player_cards: hand("playerCards")?,
        },
        "reveal" => Reveal {
            dealer_cards: hand("dealerCards")?,
            server_seed: text("serverSeed")?,
            outcome: match v["outcome"].as_str()? {
                "player_win" => BlackjackOutcome::PlayerWin,
                "dealer_win" => BlackjackOutcome::DealerWin,
                "push" => BlackjackOutcome::Push,
                "player_blackjack" => BlackjackOutcome::PlayerBlackjack,
                _ => return None,
            },
        },
        "welcome" => Welcome {
            min_wager_wei: text("minWagerWei")?,
            max_wager_wei: text("maxWagerWei")?,
            fee_hint_wei: if v.get("feeHintWei").is_some() {
                Some(text("feeHintWei")?)
            } else {
                None
            },
            rules: if v.get("rules").is_some() {
                Some(text("rules")?)
            } else {
                None
            },
        },
        _ => return None,
    };
    Some(BlackjackFields {
        game_id: text("gameId")?,
        action,
    })
}
fn application(item: &BlackjackItem) -> Value {
    use BlackjackAction::*;
    let mut v = json!({"type":"blackjack-move","gameId":item.game_id});
    let action = match &item.action {
        Bet { wager_tx_hash } => {
            v["wagerTxHash"] = json!(wager_tx_hash);
            "bet"
        }
        Deal {
            server_seed_hash,
            player_cards,
            dealer_up_card,
        } => {
            v["serverSeedHash"] = json!(server_seed_hash);
            v["playerCards"] = json!(player_cards);
            v["dealerUpCard"] = json!(dealer_up_card);
            "deal"
        }
        HitRequest => "hit",
        HitResponse { player_cards } => {
            v["playerCards"] = json!(player_cards);
            "hit"
        }
        Stand => "stand",
        DoubleRequest {
            double_wager_tx_hash,
        } => {
            v["doubleWagerTxHash"] = json!(double_wager_tx_hash);
            "double"
        }
        DoubleResponse { player_cards } => {
            v["playerCards"] = json!(player_cards);
            "double"
        }
        Reveal {
            dealer_cards,
            server_seed,
            outcome,
        } => {
            v["dealerCards"] = json!(dealer_cards);
            v["serverSeed"] = json!(server_seed);
            v["outcome"] = json!(match outcome {
                BlackjackOutcome::PlayerWin => "player_win",
                BlackjackOutcome::DealerWin => "dealer_win",
                BlackjackOutcome::Push => "push",
                BlackjackOutcome::PlayerBlackjack => "player_blackjack",
            });
            "reveal"
        }
        Welcome {
            min_wager_wei,
            max_wager_wei,
            fee_hint_wei,
            rules,
        } => {
            v["minWagerWei"] = json!(min_wager_wei);
            v["maxWagerWei"] = json!(max_wager_wei);
            if let Some(fee) = fee_hint_wei {
                v["feeHintWei"] = json!(fee);
            }
            if let Some(rules) = rules {
                v["rules"] = json!(rules);
            }
            "welcome"
        }
    };
    v["action"] = json!(action);
    v
}
#[test]
fn shared_corpus_and_closed_public_writers() {
    let c = corpus();
    let proposal: Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/proposals/blackjack-items/vectors.json"
    ))
    .unwrap();
    assert_eq!(
        &c["frames"].as_array().unwrap()[..90],
        proposal["frames"].as_array().unwrap()
    );
    assert_eq!(c["writerInputs"], proposal["writerInputs"]);
    for f in c["frames"].as_array().unwrap() {
        let mut ctx = default_context();
        let vc = &c["contexts"][f["context"].as_str().unwrap()];
        ctx.reader_version = vc["readerVersion"].as_u64().unwrap() as u32;
        ctx.supported_schemas = vc["supportedSchemas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| SupportedSchema {
                type_id: s["typeId"].as_u64().unwrap() as u32,
                schema_version: s["schemaVersion"].as_u64().unwrap() as u32,
            })
            .collect();
        ctx.opaque_retention_allowed = vc["opaqueRetentionAllowed"].as_bool().unwrap();
        ctx.operation = match f["operation"].as_str().unwrap() {
            "typed" => Operation::Typed,
            "generic" => Operation::Generic,
            "frame" => Operation::Frame,
            "full" => Operation::Full,
            _ => panic!("operation"),
        };
        let raw = hex::decode(f["frameHex"].as_str().unwrap()).unwrap();
        let result = parse_frame(&raw, &ctx);
        match f["expected"]["result"].as_str().unwrap() {
            "reject" => assert_eq!(
                outcome(result),
                format!(
                    "{}@{}",
                    f["expected"]["category"].as_str().unwrap(),
                    f["expected"]["stage"].as_str().unwrap()
                ),
                "{}",
                f["id"]
            ),
            "retain" => {
                let ValidationResult::Retained(r) = result.unwrap() else {
                    panic!("retain {}", f["id"])
                };
                assert_eq!(r.frame, raw);
                assert_eq!(r.reason.as_str(), f["expected"]["reason"].as_str().unwrap());
            }
            "accept" => {
                let result = result.unwrap();
                if let Some(expected) = f.get("application") {
                    let ValidationResult::Parsed(p) = result else {
                        panic!("typed")
                    };
                    let projected = project_blackjack_item(&p).unwrap();
                    assert_eq!(projected.frame, raw);
                    assert_eq!(application(&projected.item), *expected, "{}", f["id"]);
                    let encoded = encode_blackjack_item(&item(expected).unwrap()).unwrap();
                    assert_eq!(
                        application(&project_blackjack_item(&parsed(&encoded)).unwrap().item),
                        *expected
                    );
                    if p.schema_version == 1 {
                        assert_eq!(encoded, raw, "{}", f["id"]);
                    }
                }
            }
            _ => panic!("result"),
        }
    }
    for f in c["writerInputs"].as_array().unwrap() {
        let field = f["field"].as_str().unwrap();
        let mut v = match field {
            "wagerTxHash" => json!({"gameId":"bj-writer","action":"bet"}),
            "doubleWagerTxHash" => json!({"gameId":"bj-writer","action":"double"}),
            "serverSeedHash" => {
                json!({"gameId":"bj-writer","action":"deal","playerCards":[0,1],"dealerUpCard":2})
            }
            _ => {
                json!({"gameId":"welcome","action":"welcome","minWagerWei":"1","maxWagerWei":"9999999999999999999999999999999999999999"})
            }
        };
        v[field] = f["input"].clone();
        let result = item(&v).map(|i| encode_blackjack_item(&i));
        if f["expected"]["result"] == "reject" {
            assert!(result.is_none() || result.unwrap().is_err(), "{}", f["id"]);
        } else {
            let encoded = result.unwrap().unwrap();
            let projected = application(&project_blackjack_item(&parsed(&encoded)).unwrap().item);
            assert_eq!(projected[field], f["expected"]["projected"], "{}", f["id"]);
        }
    }
}

#[test]
fn root_and_nested_frame_limit_precedes_closed_shape() {
    for size in [4096, 4097] {
        let raw = (size - 100..size)
            .map(|n| {
                common::fr(
                    18,
                    &cbor_map(vec![
                        (0, CborValue::Text("x".into())),
                        (1, CborValue::Int(3)),
                        (14, CborValue::Bytes(vec![0; n])),
                    ]),
                )
            })
            .find(|b| b.len() == size)
            .unwrap();
        let expected = if size == 4096 {
            "schema@8.2"
        } else {
            "resource@8.1"
        };
        assert_eq!(outcome(parse_frame(&raw, &default_context())), expected);
        let nested = common::fr(
            16,
            &cbor_map(vec![(0, CborValue::Array(vec![CborValue::Bytes(raw)]))]),
        );
        assert_eq!(outcome(parse_frame(&nested, &default_context())), expected);
    }
}

#[test]
fn typed_origin_independent_rust_welcome_and_reveal() {
    let origins = [
        (
            "rust-welcome-wide-unicode",
            BlackjackFields {
                game_id: "welcome".into(),
                action: BlackjackAction::Welcome {
                    min_wager_wei: "18446744073709551616".into(),
                    max_wager_wei: "9999999999999999999999999999999999999999".into(),
                    fee_hint_wei: Some("0".into()),
                    rules: Some("Rust café / cafe\u{301} — 🎴".into()),
                },
            },
        ),
        (
            "rust-reveal-unicode",
            BlackjackFields {
                game_id: "rust-🎴-e\u{301}".into(),
                action: BlackjackAction::Reveal {
                    dealer_cards: vec![13, 0, 51],
                    server_seed: "abcdef0123456789".repeat(4),
                    outcome: BlackjackOutcome::PlayerBlackjack,
                },
            },
        ),
    ];
    for (id, item) in origins {
        let frame = encode_blackjack_item(&item).unwrap();
        let record = json!({"id":id,"origin":"rust","operation":"typed","context":"type18-reader1","frameHex":hex::encode(&frame),"expected":{"result":"accept"},"application":application(&item),"note":"Independently encoded through the active Rust public typed writer for #782."});
        println!("BLACKJACK_ORIGIN {}", record);
        let c = corpus();
        let expected = c["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == id)
            .expect("active corpus must contain each genuinely emitted Rust origin");
        assert_eq!(*expected, record);
        assert_eq!(project_blackjack_item(&parsed(&frame)).unwrap().item, item);
    }
}

fn frame(kind: u32, payload: &CborValue, schema: u32, min: u32) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id: kind,
            schema_version: schema,
            min_reader_version: min,
        },
        FramePayload::Value(payload),
    )
    .unwrap()
}
fn container(items: Vec<Vec<u8>>) -> Vec<u8> {
    common::fr(
        16,
        &cbor_map(vec![(
            0,
            CborValue::Array(items.into_iter().map(CborValue::Bytes).collect()),
        )]),
    )
}
fn content(items: Vec<Vec<u8>>, extra: Option<CborValue>) -> Vec<u8> {
    let revision = common::fr(
        8,
        &cbor_map(vec![
            (0, CborValue::Text("frank".into())),
            (
                1,
                CborValue::Array(items.into_iter().map(CborValue::Bytes).collect()),
            ),
        ]),
    );
    let mut fields = vec![
        (0, CborValue::Text(common::NET.into())),
        (1, CborValue::Bytes(vec![1; 16])),
        (2, CborValue::Bytes(revision)),
        (3, CborValue::Bytes(vec![2; 32])),
    ];
    let schema = if extra.is_some() { 2 } else { 1 };
    if let Some(extra) = extra {
        fields.push((99, extra));
    }
    frame(6, &cbor_map(fields), schema, 1)
}
fn dm_root(extra: Option<CborValue>) -> Vec<u8> {
    let payload = frame(
        5,
        &cbor_map(vec![
            (0, CborValue::Text(common::NET.into())),
            (1, common::acct1(9)),
            (2, common::acct1(3)),
            (3, CborValue::Int(1)),
            (4, CborValue::Bytes(vec![0xa0])),
            (
                5,
                CborValue::Bytes(hex::decode(common::T3C_EPHEMERAL).unwrap()),
            ),
            (
                6,
                CborValue::Bytes(hex::decode(common::T3C_SHARED).unwrap()),
            ),
            (7, CborValue::Bytes(hex::decode(common::T3C_PROOF).unwrap())),
        ]),
        2,
        2,
    );
    let CborValue::Map(mut fields) = parsed(&common::direct_message_frame()).payload else {
        panic!("map")
    };
    fields.iter_mut().find(|(k, _)| *k == 2).unwrap().1 = CborValue::Bytes(payload);
    let schema = if extra.is_some() { 2 } else { 1 };
    if let Some(extra) = extra {
        fields.push((99, extra));
    }
    frame(1, &cbor_map(fields), schema, 1)
}
#[test]
fn public_session_shares_blackjack_item_depth_aggregate_and_slots() {
    let root = dm_root(None);
    let stand = bytes("stand");
    let group = container(vec![stand.clone(); 127]);
    let at = content(vec![group.clone(), group.clone()], None);
    assert!(begin_direct_message_validation(&root, &default_context())
        .unwrap()
        .complete_authenticated_content(&at)
        .is_ok());
    let over = content(vec![group.clone(), group, stand.clone()], None);
    assert_eq!(
        outcome(
            begin_direct_message_validation(&root, &default_context())
                .unwrap()
                .complete_authenticated_content(&over)
        ),
        "resource@8.4"
    );
    let mut child = stand.clone();
    for _ in 0..7 {
        child = container(vec![child]);
    }
    let at = content(vec![child.clone()], None);
    assert!(begin_direct_message_validation(&root, &default_context())
        .unwrap()
        .complete_authenticated_content(&at)
        .is_ok());
    let over = content(vec![container(vec![child])], None);
    assert!(parse_frame(&over, &default_context()).is_ok());
    assert_eq!(
        outcome(
            begin_direct_message_validation(&root, &default_context())
                .unwrap()
                .complete_authenticated_content(&over)
        ),
        "resource@7"
    );
    let session = begin_direct_message_validation(&root, &default_context()).unwrap();
    session.abort();
    for containers in [true, false] {
        let grouped = |count: usize| {
            CborValue::Array(
                (0..count)
                    .step_by(4096)
                    .map(|i| {
                        CborValue::Array(
                            (0..4096.min(count - i))
                                .map(|_| {
                                    if containers {
                                        CborValue::Array(vec![])
                                    } else {
                                        CborValue::Int(0)
                                    }
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            )
        };
        let r = dm_root(Some(grouped(if containers { 8000 } else { 60000 })));
        let c = content(
            vec![stand.clone()],
            Some(grouped(if containers { 9000 } else { 75000 })),
        );
        assert!(parse_frame(&r, &default_context()).is_ok());
        assert!(parse_frame(&c, &default_context()).is_ok());
        assert_eq!(
            outcome(
                begin_direct_message_validation(&r, &default_context())
                    .unwrap()
                    .complete_authenticated_content(&c)
            ),
            "resource@7"
        );
    }
}
#[test]
fn closed_maps_cover_each_required_forbidden_kind_and_future_shape() {
    let c = corpus();
    for f in c["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["frozen"] == true)
    {
        let raw = hex::decode(f["frameHex"].as_str().unwrap()).unwrap();
        let CborValue::Map(m) = parsed(&raw).payload else {
            panic!("map")
        };
        let id = f["id"].as_str().unwrap();
        for (k, _) in &m {
            if (id == "hit-response" && *k == 5) || (id == "welcome" && (*k == 12 || *k == 13)) {
                continue;
            }
            let missing = CborValue::Map(m.iter().filter(|(key, _)| key != k).cloned().collect());
            assert_eq!(
                outcome(parse_frame(&common::fr(18, &missing), &default_context())),
                "schema@8.2"
            );
        }
        for key in 2..=14 {
            if m.iter().any(|(k, _)| *k == key) || (id == "hit-request" && key == 5) {
                continue;
            }
            let mut extra = m.clone();
            extra.push((key, CborValue::Int(0)));
            assert_eq!(
                outcome(parse_frame(
                    &common::fr(18, &cbor_map(extra.clone())),
                    &default_context()
                )),
                "schema@8.2"
            );
            assert_eq!(
                outcome(parse_frame(
                    &frame(18, &cbor_map(extra), 2, 1),
                    &default_context()
                )),
                "schema@8.2"
            );
        }
        for (key, _) in &m {
            for bad in [CborValue::Null, CborValue::Bool(true)] {
                let mut changed = m.clone();
                changed.iter_mut().find(|(k, _)| k == key).unwrap().1 = bad;
                assert_eq!(
                    outcome(parse_frame(
                        &common::fr(18, &cbor_map(changed)),
                        &default_context()
                    )),
                    "schema@8.2"
                );
            }
        }
    }
}
#[test]
fn retained_order_high_reader_and_required_family_remain_distinct() {
    let welcome = bytes("welcome");
    let text = common::fr(17, &cbor_map(vec![(0, CborValue::Text("last".into()))]));
    let mut old = default_context();
    old.reader_version = 99;
    old.supported_schemas = vec![
        SupportedSchema {
            type_id: 16,
            schema_version: 1,
        },
        SupportedSchema {
            type_id: 17,
            schema_version: 1,
        },
    ];
    let raw = container(vec![welcome.clone(), text.clone()]);
    let ValidationResult::Parsed(p) = parse_frame(&raw, &old).unwrap() else {
        panic!("container")
    };
    let Some(TypedPayload::ContainerItem { items, .. }) = p.typed.as_deref() else {
        panic!("typed")
    };
    assert!(matches!(&items[0],ChildFrame::Retained(r)if r.frame==welcome));
    assert!(matches!(&items[1],ChildFrame::Parsed(p)if p.frame==text));
    assert_eq!(outcome(parse_frame(&welcome, &old)), "unsupported@7");
    old.opaque_retention_allowed = true;
    assert!(
        matches!(parse_frame(&welcome,&old).unwrap(),ValidationResult::Retained(r)if r.frame==welcome)
    );
    for kind in 1..=15 {
        let raw = container(vec![common::fr(kind, &cbor_map(vec![]))]);
        assert_eq!(
            outcome(parse_frame(&raw, &default_context())),
            "semantic@8.4"
        );
    }
    let required = common::fr(
        6,
        &cbor_map(vec![
            (0, CborValue::Text(common::NET.into())),
            (1, CborValue::Bytes(vec![1; 16])),
            (2, CborValue::Bytes(welcome)),
            (3, CborValue::Bytes(vec![2; 32])),
        ]),
    );
    assert_eq!(
        outcome(parse_frame(&required, &default_context())),
        "semantic@8.4"
    );
}
