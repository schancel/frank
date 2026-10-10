//! What the relay does with a direct message: check it, store it, hand its payments to the
//! node once, answer `delivered`. Messages here are built from the captured genuine one, so
//! they pass the same checks; the node is an in-process fake that records what it was sent.
use super::*;
use crate::store::monad_dm_cbor::{MailboxDirection, Owner};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const NETWORK: &str = "monad-testnet";
const CHAIN_ID: u64 = 10143;

/// One payment of a built message, before it is signed.
struct Payment {
    tag: u32,
    index: u32,
    /// The stamp address the relay will derive for this payment.
    address: Address,
}
impl Payment {
    /// A plain transfer of `value_wei` to `to` from an account used by no other payment.
    fn transfer(&self, to: Address, value_wei: u128) -> Vec<u8> {
        use bitcoinsuite_core::ecc::Ecc;
        let mut secret = [0x11; 32];
        secret[24..28].copy_from_slice(&self.tag.to_be_bytes());
        secret[28..].copy_from_slice(&self.index.to_be_bytes());
        let secret = bitcoinsuite_ecc_secp256k1::EccSecp256k1::default()
            .seckey_from_array(secret)
            .unwrap();
        crate::monad_evm_tx::test_support::signed_eip1559_tx(
            &secret,
            CHAIN_ID,
            0,
            to,
            value_wei,
            &[],
        )
        .0
    }
    fn signed(&self) -> Vec<u8> {
        self.transfer(self.address, 1)
    }
}

fn map(value: CborValue) -> Vec<(u64, CborValue)> {
    let CborValue::Map(entries) = value else {
        panic!("expected a map");
    };
    entries
}
fn entry(entries: &mut [(u64, CborValue)], key: u64) -> &mut CborValue {
    &mut entries.iter_mut().find(|(k, _)| *k == key).unwrap().1
}
fn parsed(frame: &[u8]) -> frank_cbor::ParsedFrame {
    let frank_cbor::ValidationResult::Parsed(frame) =
        frank_cbor::validate_frame(frame, &frank_cbor::relay_context()).unwrap()
    else {
        panic!("frame must parse");
    };
    frame
}

/// Who a built message is from and to.
#[derive(Clone, Copy, PartialEq)]
enum Parties {
    /// The captured sender to the captured recipient, both published on the relay.
    Captured,
    /// The captured parties, with the context naming this hash as the sender's directory
    /// entry instead of the sender's real one.
    SenderEntry([u8; 32]),
    /// The captured recipient, from a sender whose key is these 33 bytes.
    SenderKey([u8; 33]),
    /// The captured recipient writing to itself.
    ToSelf,
}

/// The genuine message with `tag` mixed into its sealed body, so each tag is a different
/// message, carrying one payment per `pay` call. `pay` returns the raw signed transaction.
fn build(
    tag: u32,
    parties: Parties,
    payments: u32,
    pay: impl Fn(&Payment) -> Vec<u8>,
) -> ExactRequest {
    let genuine = genuine_fixture();
    let outer = parsed(genuine.delivery());
    let Some(frank_cbor::TypedPayload::DirectMessage {
        destination,
        payload_frame,
        ..
    }) = outer.typed.as_deref()
    else {
        panic!("genuine direct message");
    };
    let Some(frank_cbor::TypedPayload::RecipientPayload { shared_point, .. }) =
        payload_frame.typed.as_deref()
    else {
        panic!("genuine recipient payload");
    };
    let mut context = map(frank_cbor::decode_canonical(genuine.context()).unwrap());
    let mut sealed = map(payload_frame.payload.clone());
    // The last bytes of the sealed body are ciphertext: any change makes a different message.
    let CborValue::Bytes(body) = entry(&mut sealed, 4) else {
        panic!("sealed body");
    };
    let end = body.len();
    for (byte, mix) in body[end - 4..].iter_mut().zip(tag.to_be_bytes()) {
        *byte ^= mix;
    }
    match parties {
        Parties::Captured => {}
        Parties::SenderEntry(hash) => {
            *entry(&mut context, 4) = CborValue::Bytes(hash.to_vec());
        }
        Parties::SenderKey(key) => {
            let mut account = map(entry(&mut sealed, 1).clone());
            *entry(&mut account, 1) = CborValue::Bytes(key.to_vec());
            let account = CborValue::Map(account);
            *entry(&mut sealed, 1) = account.clone();
            *entry(&mut context, 2) = account;
        }
        Parties::ToSelf => {
            *entry(&mut sealed, 1) = entry(&mut sealed, 2).clone();
            for (sender, recipient) in [(2, 3), (4, 5), (6, 7)] {
                *entry(&mut context, sender) = entry(&mut context, recipient).clone();
            }
        }
    }
    let sealed = frank_cbor::encode_frame(
        frank_cbor::EnvelopeFields {
            type_id: 5,
            schema_version: 2,
            min_reader_version: 2,
        },
        frank_cbor::FramePayload::Value(&CborValue::Map(sealed)),
    )
    .unwrap();
    let digest = frank_cbor::recipient_payload_digest(NETWORK, &sealed).unwrap();
    let mut members = Vec::new();
    let mut raws = Vec::new();
    for index in 0..payments {
        let (_, address) = crate::monad_dm_verify::canonical_stamp_destination(
            NETWORK,
            destination,
            shared_point,
            index,
        )
        .unwrap();
        let raw = pay(&Payment {
            tag,
            index,
            address: Address(address),
        });
        // The frame lists what the transaction itself says, where it can be read.
        let signed = crate::monad_evm_tx::decode_signed_transaction(&raw).ok();
        let paid_to = signed
            .as_ref()
            .and_then(|signed| signed.destination)
            .map_or(address, |paid| paid.0);
        let mut value = [0u8; 32];
        value[16..].copy_from_slice(
            &signed
                .as_ref()
                .map_or(1, |signed| signed.value_wei)
                .to_be_bytes(),
        );
        members.push(frank_cbor::cbor_map(vec![
            (0, CborValue::Int(index.into())),
            (1, CborValue::Bytes(Keccak256::digest(&raw).to_vec())),
            (2, CborValue::Bytes(value.to_vec())),
            (3, CborValue::Bytes(paid_to.to_vec())),
            (
                4,
                CborValue::Bytes(frank_cbor::payment_commitment(&digest, index).to_vec()),
            ),
        ]));
        raws.push(CborValue::Bytes(raw));
    }
    let mut message = map(outer.payload.clone());
    *entry(&mut message, 2) = CborValue::Bytes(sealed);
    *entry(&mut message, 3) = CborValue::Bytes(digest.to_vec());
    *entry(&mut message, 4) = CborValue::Array(members);
    let delivery = frank_cbor::encode_frame(
        frank_cbor::EnvelopeFields {
            type_id: 1,
            schema_version: 2,
            min_reader_version: 1,
        },
        frank_cbor::FramePayload::Value(&CborValue::Map(message)),
    )
    .unwrap();
    let context = encode_canonical(&CborValue::Map(context)).unwrap();
    let transactions = encode_canonical(&CborValue::Array(raws)).unwrap();
    let boundary = format!("frank-built-{tag}");
    let mut body = Vec::new();
    for (name, media, bytes) in [
        ("delivery", "application/vnd.frank.cbor", &delivery),
        ("context", "application/cbor", &context),
        ("transactions", "application/cbor", &transactions),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: {media}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    ExactRequest::parse(body, format!("multipart/form-data; boundary={boundary}")).unwrap()
}
/// A valid message with `payments` valid payments.
fn message(tag: u32, payments: u32) -> ExactRequest {
    build(tag, Parties::Captured, payments, Payment::signed)
}
fn raws(request: &ExactRequest) -> Vec<String> {
    request
        .raw_transactions()
        .map(|raw| format!("0x{}", hex::encode(raw)))
        .collect()
}
fn payload_hash(request: &ExactRequest) -> [u8; 32] {
    request_principals(request, NETWORK).unwrap().payload_hash
}
fn address(public_key: &[u8]) -> Address {
    crate::monad_stamp_stealth::recipient_address_from_public_key(public_key).unwrap()
}

/// How the fake node answers one `eth_sendRawTransaction`.
enum Answer {
    Accepted,
    /// A JSON-RPC error with this message.
    Refused(&'static str),
    /// No answer at all.
    Silent,
}

/// A relay with the two captured accounts published, and the node it broadcasts to.
struct Relay {
    fixture: NativeDirectoryFixture,
    server: crate::http::server::RegistryServer,
    url: String,
    /// Every call the node received: method and first parameter, in arrival order.
    calls: Arc<Mutex<Vec<(String, String)>>>,
    stops: Vec<tokio::sync::oneshot::Sender<()>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Relay {
    async fn start(answer: impl Fn(&str) -> Answer + Send + Sync + 'static) -> Self {
        Self::start_with(1, Duration::from_secs(10), Some(Arc::new(answer))).await
    }
    /// `answer` of `None` is a node nothing is listening at.
    async fn start_with(
        min_value_wei: u128,
        rpc_timeout: Duration,
        answer: Option<Arc<dyn Fn(&str) -> Answer + Send + Sync>>,
    ) -> Self {
        Self::on(
            NativeDirectoryFixture::new().await,
            min_value_wei,
            rpc_timeout,
            answer,
        )
        .await
    }
    /// A relay over this directory.
    async fn on(
        fixture: NativeDirectoryFixture,
        min_value_wei: u128,
        rpc_timeout: Duration,
        answer: Option<Arc<dyn Fn(&str) -> Answer + Send + Sync>>,
    ) -> Self {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (mut stops, mut tasks) = (Vec::new(), Vec::new());
        let rpc_url = match answer {
            None => "http://127.0.0.1:1".to_owned(),
            Some(answer) => {
                let seen = calls.clone();
                let node = axum::Router::new().route(
                    "/",
                    axum::routing::post(move |Json(query): Json<serde_json::Value>| {
                        let (seen, answer) = (seen.clone(), answer.clone());
                        async move {
                            let method = query["method"].as_str().unwrap().to_owned();
                            let raw = query["params"][0].as_str().unwrap_or_default().to_owned();
                            seen.lock().unwrap().push((method.clone(), raw.clone()));
                            let reply = if method != "eth_sendRawTransaction" {
                                serde_json::json!({"result": null})
                            } else {
                                match answer(&raw) {
                                    Answer::Accepted => {
                                        let hash = Keccak256::digest(hex::decode(&raw[2..]).unwrap());
                                        serde_json::json!({"result": format!("0x{}", hex::encode(hash))})
                                    }
                                    Answer::Refused(message) => {
                                        serde_json::json!({"error": {"code": -32000, "message": message}})
                                    }
                                    Answer::Silent => futures::future::pending().await,
                                }
                            };
                            let mut reply = reply;
                            reply["jsonrpc"] = "2.0".into();
                            reply["id"] = query["id"].clone();
                            Json(reply)
                        }
                    }),
                );
                let (url, stop, task) = serve_http(node).await;
                stops.push(stop);
                tasks.push(task);
                url
            }
        };
        let server = server_with(&fixture, &rpc_url, min_value_wei, rpc_timeout);
        let (url, stop, task) = serve_http(
            server
                .clone()
                .into_router_with_directory(Some(fixture.directory.clone())),
        )
        .await;
        stops.push(stop);
        tasks.push(task);
        Self {
            fixture,
            server,
            url,
            calls,
            stops,
            tasks,
        }
    }
    async fn put(&self, request: &ExactRequest) -> (u16, serde_json::Value) {
        let response = reqwest::Client::new()
            .put(format!("{}/message", self.url))
            .header("content-type", request.content_type())
            .body(request.body().to_vec())
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (
            status,
            serde_json::from_slice(&response.bytes().await.unwrap()).unwrap(),
        )
    }
    /// The raw transactions the node was asked to broadcast, in arrival order.
    fn broadcasts(&self) -> Vec<String> {
        let calls = self.calls.lock().unwrap();
        // The relay asks the node for nothing else: no lookups, no receipts.
        assert!(calls
            .iter()
            .all(|(method, _)| method == "eth_sendRawTransaction"));
        calls.iter().map(|(_, raw)| raw.clone()).collect()
    }
    fn owner(&self) -> &Owner {
        self.fixture.registry.canonical_dm()
    }
    fn sender(&self) -> Address {
        address(&hex::decode(&self.fixture.accounts[0].subject).unwrap())
    }
    fn recipient(&self) -> Address {
        address(&hex::decode(&self.fixture.accounts[1].subject).unwrap())
    }
    /// Payload hashes in the recipient's inbox, as its inbox read returns them.
    fn inbox(&self) -> Vec<[u8; 32]> {
        self.owner()
            .inbox(self.recipient(), 0, None, 100_000)
            .unwrap()
            .iter()
            .map(|claim| claim.policy.payload_hash)
            .collect()
    }
    /// Payload hashes and directions in one account's mailbox, as its mailbox read returns them.
    fn mailbox(&self, account: Address) -> Vec<([u8; 32], MailboxDirection)> {
        self.owner()
            .mailbox(account, 0, None, 100_000)
            .unwrap()
            .iter()
            .map(|(claim, direction)| (claim.policy.payload_hash, *direction))
            .collect()
    }
    /// The message is in the recipient's inbox and in the sender's own mailbox as sent.
    fn assert_delivered_to_both(&self, request: &ExactRequest) {
        let hash = payload_hash(request);
        assert_eq!(self.inbox(), [hash]);
        assert_eq!(
            self.mailbox(self.recipient()),
            [(hash, MailboxDirection::In)]
        );
        assert_eq!(self.mailbox(self.sender()), [(hash, MailboxDirection::Out)]);
    }
    fn assert_nothing_stored(&self, request: &ExactRequest) {
        assert!(self.owner().find_request(request).unwrap().is_none());
        assert!(self.inbox().is_empty());
        assert!(self.mailbox(self.sender()).is_empty());
    }
    /// The two accounts' current directory entries, for checking a message without HTTP.
    async fn entries(
        &self,
    ) -> (
        crate::directory_admission::Current,
        crate::directory_admission::Current,
    ) {
        let entry = |index: usize| {
            let subject = hex::decode(&self.fixture.accounts[index].subject).unwrap();
            async move { current(self.owner(), NETWORK, &subject).await.unwrap() }
        };
        (entry(0).await, entry(1).await)
    }
    /// Stop the listeners and let go of the store, as a relay shutting down does.
    async fn shut_down(self) -> NativeDirectoryFixture {
        for stop in self.stops {
            let _ = stop.send(());
        }
        for task in self.tasks {
            // A node that never answers never finishes shutting down either.
            task.abort();
            let _ = task.await;
        }
        drop(self.server);
        self.fixture
    }
    async fn stop(self) {
        self.shut_down().await.stop().await;
    }
}
fn delivered(answer: &(u16, serde_json::Value), request: &ExactRequest) -> i64 {
    let (status, body) = answer;
    assert_eq!(*status, 200, "{body}");
    // Exactly the fields the wallet's decoder takes: one more or one fewer and it treats the
    // outcome as unknown.
    let mut fields: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    fields.sort();
    assert_eq!(
        fields,
        ["identity", "mailbox_committed_at_ms", "phase", "version"]
    );
    assert_eq!(body["version"], 1);
    assert_eq!(body["phase"], "delivered");
    let mut identity: Vec<_> = body["identity"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    identity.sort();
    assert_eq!(
        identity,
        [
            "context_sha256",
            "delivery_sha256",
            "network",
            "payload_hash",
            "recipient",
            "recipient_t1",
            "sender_t1",
            "submission_identity",
            "transaction_hashes"
        ]
    );
    assert_eq!(
        body["identity"]["submission_identity"],
        hex::encode(request.submission_identity())
    );
    assert_eq!(
        body["identity"]["payload_hash"],
        hex::encode(payload_hash(request))
    );
    body["mailbox_committed_at_ms"].as_i64().unwrap()
}
fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values
}

#[tokio::test]
async fn a_paid_message_is_delivered_to_both_parties_and_each_payment_is_broadcast_once() {
    let relay = Relay::start(|_| Answer::Accepted).await;
    let request = message(1, 3);
    assert!(delivered(&relay.put(&request).await, &request) > 0);
    relay.assert_delivered_to_both(&request);
    assert_eq!(sorted(relay.broadcasts()), sorted(raws(&request)));
    relay.stop().await;
}

#[tokio::test]
async fn a_free_message_is_delivered_to_both_parties_and_nothing_is_broadcast() {
    let relay = Relay::start(|_| Answer::Accepted).await;
    let request = message(2, 0);
    delivered(&relay.put(&request).await, &request);
    relay.assert_delivered_to_both(&request);
    assert!(relay.calls.lock().unwrap().is_empty());
    relay.stop().await;
}

#[tokio::test]
async fn a_message_to_oneself_is_in_the_mailbox_once() {
    let relay = Relay::start(|_| Answer::Accepted).await;
    for (tag, payments) in [(3, 0), (4, 2)] {
        let request = build(tag, Parties::ToSelf, payments, Payment::signed);
        delivered(&relay.put(&request).await, &request);
    }
    let own = relay.mailbox(relay.recipient());
    assert_eq!(own.len(), 2);
    assert!(own
        .iter()
        .all(|(_, direction)| *direction == MailboxDirection::In));
    assert_eq!(relay.inbox().len(), 2);
    assert_eq!(relay.broadcasts().len(), 2);
    relay.stop().await;
}

/// The relay does not look the sender up. A message from someone with no directory entry
/// here, paid or free, is checked against the recipient and its payments like any other and
/// delivered. Who wrote it is for the recipient's client to check when it opens the message.
#[tokio::test]
async fn a_message_from_a_sender_with_no_entry_on_this_relay_is_delivered() {
    // Only the recipient has published here.
    let relay = Relay::on(
        NativeDirectoryFixture::homed(1, |index| index == 1).await,
        1,
        Duration::from_secs(10),
        Some(Arc::new(|_: &str| Answer::Accepted)),
    )
    .await;
    let (paid, free) = (message(70, 2), message(71, 0));
    for request in [&paid, &free] {
        delivered(&relay.put(request).await, request);
    }
    assert_eq!(relay.inbox(), [payload_hash(&paid), payload_hash(&free)]);
    // The sender's own mailbox is keyed by the sender key in the message, entry or no entry.
    assert_eq!(
        relay.mailbox(relay.sender()),
        [
            (payload_hash(&paid), MailboxDirection::Out),
            (payload_hash(&free), MailboxDirection::Out)
        ]
    );
    assert_eq!(sorted(relay.broadcasts()), sorted(raws(&paid)));
    relay.stop().await;
}

/// The sender's entry here has moved on from, or never was, the one the message's context
/// names. That used to be a permanent refusal; the relay no longer reads the field.
#[tokio::test]
async fn a_message_naming_a_sender_entry_this_relay_does_not_hold_is_delivered() {
    let relay = Relay::start(|_| Answer::Accepted).await;
    let request = build(72, Parties::SenderEntry([0x5a; 32]), 2, Payment::signed);
    let committed = delivered(&relay.put(&request).await, &request);
    assert!(committed > 0);
    relay.assert_delivered_to_both(&request);
    // The answer echoes the hash the message stated, which is what the client compares.
    let stored = relay.owner().get(&payload_hash(&request)).unwrap().unwrap();
    assert_eq!(stored.policy.sender_t1, [0x5a; 32]);
    assert_eq!(sorted(relay.broadcasts()), sorted(raws(&request)));

    // The recipient is still held to its real entry: naming another recipient entry is refused.
    let genuine = genuine_fixture();
    let mut context = map(frank_cbor::decode_canonical(genuine.context()).unwrap());
    *entry(&mut context, 5) = CborValue::Bytes(vec![0x5a; 32]);
    let wrong_recipient_entry = encode_canonical(&CborValue::Map(context)).unwrap();
    let boundary = "frank-wrong-recipient-entry";
    let transactions = encode_canonical(&CborValue::Array(
        genuine
            .raw_transactions()
            .map(|raw| CborValue::Bytes(raw.to_vec()))
            .collect(),
    ))
    .unwrap();
    let mut body = Vec::new();
    for (name, media, bytes) in [
        ("delivery", "application/vnd.frank.cbor", genuine.delivery()),
        ("context", "application/cbor", &wrong_recipient_entry),
        ("transactions", "application/cbor", &transactions),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: {media}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let refused =
        ExactRequest::parse(body, format!("multipart/form-data; boundary={boundary}")).unwrap();
    let answer = relay.put(&refused).await;
    assert_ne!(answer.0, 200, "{}", answer.1);
    assert!(relay.owner().find_request(&refused).unwrap().is_none());
    relay.stop().await;
}

#[tokio::test]
async fn payments_the_node_refuses_do_not_stop_delivery_or_the_other_payments() {
    let request = message(5, 5);
    let sent = raws(&request);
    let (stale, unfunded) = (sent[1].clone(), sent[3].clone());
    let relay = Relay::start(move |raw| {
        if raw == stale {
            Answer::Refused("nonce too low")
        } else if raw == unfunded {
            Answer::Refused("insufficient funds for gas * price + value")
        } else {
            Answer::Accepted
        }
    })
    .await;
    delivered(&relay.put(&request).await, &request);
    relay.assert_delivered_to_both(&request);
    assert_eq!(sorted(relay.broadcasts()), sorted(sent));
    relay.stop().await;
}

#[tokio::test]
async fn an_unreachable_node_does_not_stop_delivery() {
    let relay = Relay::start_with(1, Duration::from_secs(10), None).await;
    let request = message(6, 2);
    delivered(&relay.put(&request).await, &request);
    relay.assert_delivered_to_both(&request);
    relay.stop().await;
}

/// The Monad RPC is down when the relay starts: the relay's own RPC proxy for the chain is up
/// but unverified, and the message path's node is unreachable. A paid message is still
/// checked, stored and answered `delivered`; only the proxy route says unavailable.
#[tokio::test]
async fn with_the_monad_rpc_down_at_startup_a_paid_message_is_still_delivered() {
    let fixture = NativeDirectoryFixture::new().await;
    let dead = "http://127.0.0.1:1";
    let conf = cashweb_config::EvmRpcConf {
        enabled: true,
        chains: vec![cashweb_config::EvmRpcChainConf {
            id: NETWORK.to_string(),
            expected_chain_id: CHAIN_ID,
            upstream_env: "MONAD_RPC".to_string(),
            upstream_envs: vec![],
            upstream_ws_env: None,
            checkpoint_block_number: Some(0),
            checkpoint_block_hash: Some(
                "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9".to_string(),
            ),
            max_get_logs_range: 10,
        }],
        ..Default::default()
    };
    // Startup succeeds with the upstream down.
    let proxy =
        crate::http::evm_rpc::EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |_| {
            Some(dead.to_owned())
        })
        .await
        .unwrap()
        .unwrap();
    let mut server = server_with(&fixture, dead, 1, Duration::from_secs(10));
    server.evm_rpc = Some(proxy);
    let (url, stop, task) =
        serve_http(server.into_router_with_directory(Some(fixture.directory.clone()))).await;
    let client = reqwest::Client::new();

    let request = message(50, 2);
    let response = client
        .put(format!("{url}/message"))
        .header("content-type", request.content_type())
        .body(request.body().to_vec())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    delivered(&(status, body), &request);
    let owner = fixture.registry.canonical_dm();
    let recipient = address(&hex::decode(&fixture.accounts[1].subject).unwrap());
    let sender = address(&hex::decode(&fixture.accounts[0].subject).unwrap());
    assert_eq!(owner.inbox(recipient, 0, None, 10).unwrap().len(), 1);
    assert_eq!(owner.mailbox(sender, 0, None, 10).unwrap().len(), 1);

    // The chain's RPC proxy route, meanwhile, answers unavailable rather than forwarding.
    let proxied = client
        .post(format!("{url}/chain-rpc/{NETWORK}/rpc"))
        .header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(proxied.status().as_u16(), 503);
    let refusal: serde_json::Value =
        serde_json::from_slice(&proxied.bytes().await.unwrap()).unwrap();
    assert_eq!(refusal["error"], "rpc_upstream_unavailable");

    stop.send(()).unwrap();
    task.await.unwrap();
    fixture.stop().await;
}

/// The node's URL holds the provider's API key. A failed broadcast is logged, and neither the
/// log line nor the answer may contain the URL.
#[tokio::test]
async fn a_failed_broadcast_never_puts_the_node_url_in_a_log_line_or_the_answer() {
    const KEY: &str = "sentinel-api-key";
    let fixture = NativeDirectoryFixture::new().await;
    // Nothing listens here, so every send is a transport failure naming this URL.
    let node = format!("http://127.0.0.1:1/v2/{KEY}");
    let server = server_with(&fixture, &node, 1, Duration::from_secs(10));
    let (url, stop, task) = serve_http(
        server
            .clone()
            .into_router_with_directory(Some(fixture.directory.clone())),
    )
    .await;
    let request = message(60, 2);
    let response = reqwest::Client::new()
        .put(format!("{url}/message"))
        .header("content-type", request.content_type())
        .body(request.body().to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let answer = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    assert!(answer.contains("\"delivered\""));
    assert!(!answer.contains(KEY) && !answer.contains("127.0.0.1:1"));

    // What the handler logs for each payment is exactly what this returns.
    let claim = fixture
        .registry
        .canonical_dm()
        .get(&payload_hash(&request))
        .unwrap()
        .unwrap();
    let logged = broadcast_payments(server.monad_mailbox.as_enabled().unwrap(), &claim).await;
    assert_eq!(logged.len(), 2);
    for line in logged {
        let reason = line.expect_err("nothing is listening, so nothing was sent");
        assert!(reason.starts_with("could not be sent"), "{reason}");
        assert!(!reason.contains(KEY), "{reason}");
        assert!(!reason.contains("127.0.0.1"), "{reason}");
        assert!(!reason.contains("for url"), "{reason}");
    }
    stop.send(()).unwrap();
    task.await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn a_node_that_never_answers_holds_the_answer_no_longer_than_one_call_timeout() {
    let relay = Relay::start_with(
        1,
        Duration::from_millis(300),
        Some(Arc::new(|_: &str| Answer::Silent)),
    )
    .await;
    let request = message(7, 4);
    let started = Instant::now();
    delivered(&relay.put(&request).await, &request);
    // Four payments, one timeout: they are sent together, not one after another.
    assert!(
        started.elapsed() < Duration::from_millis(1100),
        "{:?}",
        started.elapsed()
    );
    relay.assert_delivered_to_both(&request);
    assert_eq!(sorted(relay.broadcasts()), sorted(raws(&request)));
    relay.stop().await;
}

#[tokio::test]
async fn a_message_that_fails_a_check_is_refused_with_nothing_stored_and_nothing_broadcast() {
    // A paid message must carry at least 5 wei here; each built payment carries 1.
    let relay = Relay::start_with(
        5,
        Duration::from_secs(10),
        Some(Arc::new(|_: &str| Answer::Accepted)),
    )
    .await;
    let elsewhere = Address([0x42; 20]);
    let cases: Vec<(&str, ExactRequest)> = vec![
        (
            "a signature that recovers no signer",
            build(10, Parties::Captured, 5, |payment| {
                let mut raw = payment.signed();
                if payment.index == 2 {
                    let end = raw.len();
                    // r and s are the last two 32-byte fields; no r this large is valid.
                    assert_eq!((raw[end - 66], raw[end - 33]), (0xa0, 0xa0));
                    raw[end - 65..end - 33].fill(0xff);
                }
                raw
            }),
        ),
        (
            "a payment to an address other than the message's stamp address",
            build(11, Parties::Captured, 5, |payment| {
                if payment.index == 2 {
                    payment.transfer(elsewhere, 1)
                } else {
                    payment.signed()
                }
            }),
        ),
        ("payments totalling less than the minimum", message(12, 4)),
        (
            "a sender key that is not a point on the curve",
            build(
                16,
                Parties::SenderKey({
                    let mut key = [0xff; 33];
                    key[0] = 2;
                    key
                }),
                5,
                Payment::signed,
            ),
        ),
        (
            "a payment of nothing",
            build(13, Parties::Captured, 6, |payment| {
                payment.transfer(payment.address, u128::from(payment.index))
            }),
        ),
        (
            "a payment signed for another chain",
            build(14, Parties::Captured, 5, |payment| {
                use bitcoinsuite_core::ecc::Ecc;
                let secret = bitcoinsuite_ecc_secp256k1::EccSecp256k1::default()
                    .seckey_from_array([0x21; 32])
                    .unwrap();
                if payment.index == 0 {
                    crate::monad_evm_tx::test_support::signed_eip1559_tx(
                        &secret,
                        1,
                        0,
                        payment.address,
                        1,
                        &[],
                    )
                    .0
                } else {
                    payment.signed()
                }
            }),
        ),
    ];
    for (case, request) in &cases {
        let answer = relay.put(request).await;
        assert_eq!(answer.0, 400, "{case}: {}", answer.1);
        assert_eq!(answer.1["error"], "invalid_canonical_submission", "{case}");
        relay.assert_nothing_stored(request);
        assert!(relay.calls.lock().unwrap().is_empty(), "{case}");
    }
    // The same builder with nothing wrong is accepted, so each refusal above is the fault named.
    let valid = message(15, 5);
    delivered(&relay.put(&valid).await, &valid);
    relay.stop().await;
}

#[tokio::test]
async fn a_repeated_submit_stores_once_and_broadcasts_again() {
    let relay = Relay::start(|_| Answer::Accepted).await;
    let request = message(20, 2);
    let first = relay.put(&request).await;
    delivered(&first, &request);
    // A client repeating the message straight away gets the same answer, including when it
    // was delivered, and the node is not asked again so soon.
    for _ in 0..5 {
        assert_eq!(relay.put(&request).await, first);
    }
    assert_eq!(relay.broadcasts().len(), 2);
    // A repeat after the interval sends the payments again, once.
    tokio::time::sleep(REBROADCAST_INTERVAL).await;
    let second = relay.put(&request).await;
    assert_eq!(first, second);
    relay.assert_delivered_to_both(&request);
    let sent = relay.broadcasts();
    assert_eq!(sent.len(), 4);
    assert_eq!(sorted(sent[..2].to_vec()), sorted(raws(&request)));
    assert_eq!(sorted(sent[2..].to_vec()), sorted(raws(&request)));

    // Two submits of one message at the same moment are one message too.
    let twin = message(21, 1);
    let (left, right) = tokio::join!(relay.put(&twin), relay.put(&twin));
    delivered(&left, &twin);
    assert_eq!(left, right);
    assert_eq!(relay.broadcasts().len(), 5);
    assert_eq!(relay.inbox().len(), 2);
    assert_eq!(relay.mailbox(relay.sender()).len(), 2);
    relay.stop().await;
}

#[tokio::test]
async fn a_submit_abandoned_while_the_node_hangs_is_already_delivered_and_nothing_waits_on_it() {
    let relay = Relay::start_with(
        1,
        Duration::from_secs(1),
        Some(Arc::new(|_: &str| Answer::Silent)),
    )
    .await;
    let request = message(30, 2);
    let submit = || {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", request.content_type().parse().unwrap());
        handle_put(
            Extension(relay.server.clone()),
            headers,
            RawBody(hyper::Body::from(request.body().to_vec())),
        )
    };
    // The sender goes away while the relay is waiting on the node: the request is dropped as
    // soon as the node has been handed a payment.
    let node_reached = async {
        while relay.calls.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::select! {
        _ = submit() => panic!("the node never answers, so the submit is still waiting"),
        _ = node_reached => {}
    }
    relay.assert_delivered_to_both(&request);
    // The very next submit is answered within one call timeout although the node still hangs:
    // no earlier attempt has to finish or expire first.
    let started = Instant::now();
    let response = submit().await.unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(1900),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&hyper::body::to_bytes(response.into_body()).await.unwrap())
            .unwrap();
    assert_eq!(body["phase"], "delivered");
    relay.assert_delivered_to_both(&request);
    relay.stop().await;
}

#[tokio::test]
async fn a_restart_between_storing_and_broadcasting_is_repaired_by_the_resend() {
    let relay = Relay::start(|_| Answer::Accepted).await;
    let request = message(40, 2);
    // Stored, and the relay stops before any payment reaches the node.
    let (sender, recipient) = relay.entries().await;
    let input = crate::monad_dm_payment::validate_canonical_payment_set(
        request.clone(),
        &recipient,
        None,
        NETWORK,
        CHAIN_ID,
        1,
    )
    .unwrap();
    let stored = relay.owner().claim(input, now_ms()).unwrap();
    // What the store froze is what the request says about itself.
    assert!(stored.request.exact_equal(&request));
    assert_eq!(stored.policy.sender_t1, sender.evidence.hash);
    assert_eq!(stored.policy.recipient_t1, recipient.evidence.hash);
    let stated = request_principals(&request, NETWORK).unwrap();
    assert_eq!(stated.sender_t1, Some(stored.policy.sender_t1));
    assert_eq!(stated.recipient_t1, Some(stored.policy.recipient_t1));
    relay.assert_delivered_to_both(&request);
    assert!(relay.broadcasts().is_empty());
    let fixture = relay.shut_down().await.reopen().await;
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = calls.clone();
    let node = axum::Router::new().route(
        "/",
        axum::routing::post(move |Json(query): Json<serde_json::Value>| {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                Json(serde_json::json!({"jsonrpc":"2.0","id":query["id"],"result":format!("0x{}", hex::encode([7u8; 32]))}))
            }
        }),
    );
    let (rpc_url, rpc_stop, rpc_task) = serve_http(node).await;
    let (url, http_stop, http_task) = serve_http(
        server(&fixture, &rpc_url).into_router_with_directory(Some(fixture.directory.clone())),
    )
    .await;
    let response = reqwest::Client::new()
        .put(format!("{url}/message"))
        .header("content-type", request.content_type())
        .body(request.body().to_vec())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    let committed = delivered(&(status, body), &request);
    assert_eq!(stored.delivered_at, committed);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    let owner = fixture.registry.canonical_dm();
    assert_eq!(
        owner
            .inbox(stored.policy.recipient().unwrap(), 0, None, 10)
            .unwrap()
            .len(),
        1
    );
    http_stop.send(()).unwrap();
    http_task.await.unwrap();
    rpc_stop.send(()).unwrap();
    rpc_task.await.unwrap();
    fixture.stop().await;
}

fn delivery_time(claim: &crate::store::monad_dm_cbor::Claim) -> i64 {
    claim.delivered_at
}

/// A reader asks for everything after the last delivery time it has seen. That is a complete
/// answer only if no message is ever given a time equal to or earlier than one already issued.
#[tokio::test]
async fn delivery_times_only_ever_increase_so_reading_after_the_last_one_misses_nothing() {
    let relay = Relay::start(|_| Answer::Accepted).await;
    let first = message(400_000, 0);
    delivered(&relay.put(&first).await, &first);
    let policy = relay
        .owner()
        .get(&payload_hash(&first))
        .unwrap()
        .unwrap()
        .policy;
    let input = |tag: u32| {
        let request = message(tag, 0);
        let mut policy = policy.clone();
        policy.payload_hash = payload_hash(&request);
        crate::monad_dm_payment::CanonicalPaymentInput::without_directory(request, policy).unwrap()
    };
    let owner = relay.owner();
    let clock = now_ms() + 60_000;

    // Two messages in the same millisecond get different, increasing times.
    let a = owner.claim(input(400_001), clock).unwrap();
    let b = owner.claim(input(400_002), clock).unwrap();
    assert_eq!(delivery_time(&a), clock);
    assert_eq!(delivery_time(&b), clock + 1);
    // The clock steps back an hour: the next message is still after the last one.
    let c = owner.claim(input(400_003), clock - 3_600_000).unwrap();
    assert_eq!(delivery_time(&c), clock + 2);
    // A reader who has seen up to `b` and asks for what came after gets exactly `c`.
    let after_b: Vec<_> = owner
        .inbox(relay.recipient(), delivery_time(&b) + 1, None, 100)
        .unwrap()
        .iter()
        .map(|claim| claim.policy.payload_hash)
        .collect();
    assert_eq!(after_b, [c.policy.payload_hash]);
    // The sender's own mailbox holds each message under the same time as the inbox.
    let sent = owner.mailbox(relay.sender(), clock, None, 100).unwrap();
    assert_eq!(
        sent.iter()
            .map(|(claim, _)| delivery_time(claim))
            .collect::<Vec<_>>(),
        [clock, clock + 1, clock + 2]
    );

    // Writers and a reader at the same time, every writer on one stuck clock. The reader
    // polls as the app does, from one past the newest time it has seen, and ends up with
    // every message: none was committed at or before a time it had already read past.
    const WRITERS: u32 = 4;
    const EACH: u32 = 50;
    let inputs: Vec<Vec<_>> = (0..WRITERS)
        .map(|writer| {
            (0..EACH)
                .map(|n| input(410_000 + writer * 1000 + n))
                .collect()
        })
        .collect();
    let recipient = relay.recipient();
    let done = std::sync::atomic::AtomicBool::new(false);
    let seen = std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            let mut seen = std::collections::BTreeSet::new();
            let mut since = clock + 3;
            loop {
                let finished = done.load(std::sync::atomic::Ordering::SeqCst);
                for claim in owner.inbox(recipient, since, None, 10_000).unwrap() {
                    since = since.max(delivery_time(&claim) + 1);
                    assert!(seen.insert(claim.policy.payload_hash));
                }
                if finished {
                    return seen;
                }
            }
        });
        let writers: Vec<_> = inputs
            .into_iter()
            .map(|inputs| {
                scope.spawn(move || {
                    for input in inputs {
                        owner.claim(input, clock - 5_000).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        reader.join().unwrap()
    });
    assert_eq!(seen.len(), (WRITERS * EACH) as usize);

    // After a restart the store still remembers the last time it issued.
    let fixture = relay.shut_down().await.reopen().await;
    let owner = fixture.registry.canonical_dm();
    let last = clock + 2 + i64::from(WRITERS * EACH);
    let next = owner.claim(input(420_000), clock - 3_600_000).unwrap();
    assert_eq!(delivery_time(&next), last + 1);
    fixture.stop().await;
}

/// A page asks for what comes after a position. The store goes straight there: the messages
/// before it are not read, and no payment signature is checked again on the way out.
#[tokio::test]
async fn reading_after_a_position_reads_only_what_follows_it() {
    use crate::store::monad_dm_cbor::ROWS_READ;
    let relay = Relay::start(|_| Answer::Accepted).await;
    let first = message(500_000, 1);
    delivered(&relay.put(&first).await, &first);
    let policy = relay
        .owner()
        .get(&payload_hash(&first))
        .unwrap()
        .unwrap()
        .policy;
    let owner = relay.owner();
    let mut times = vec![];
    for tag in 1..200u32 {
        let request = message(500_000 + tag, 0);
        let mut policy = policy.clone();
        policy.payload_hash = payload_hash(&request);
        let input =
            crate::monad_dm_payment::CanonicalPaymentInput::without_directory(request, policy)
                .unwrap();
        times.push(owner.claim(input, now_ms()).unwrap().delivered_at);
    }
    let rows_read = |read: &dyn Fn() -> usize| {
        ROWS_READ.with(|count| count.set(0));
        let returned = read();
        (returned, ROWS_READ.with(|count| count.get()))
    };
    let (recipient, sender) = (relay.recipient(), relay.sender());
    // The last three messages, by time and by cursor, from either side of the conversation.
    let since = times[times.len() - 3];
    assert_eq!(
        rows_read(&|| owner.inbox(recipient, since, None, 100).unwrap().len()),
        (3, 3)
    );
    let cursor = owner.inbox(recipient, 0, None, 197).unwrap().pop().unwrap();
    let after = Some((cursor.delivered_at, cursor.policy.payload_hash));
    assert_eq!(
        rows_read(&|| owner.inbox(recipient, 0, after, 100).unwrap().len()),
        (3, 3)
    );
    assert_eq!(
        rows_read(&|| owner.mailbox(sender, 0, after, 100).unwrap().len()),
        (3, 3)
    );
    // A page of one reads one, wherever it starts.
    assert_eq!(
        rows_read(&|| owner.mailbox(recipient, 0, after, 1).unwrap().len()),
        (1, 1)
    );
    assert_eq!(
        rows_read(&|| owner.inbox(recipient, 0, None, 1).unwrap().len()),
        (1, 1)
    );
    relay.stop().await;
}

/// The relay used to stop at 128 messages per recipient and 4,096 in all, for ever. Nothing
/// counts stored messages now, so nothing refuses one for how many there are.
#[tokio::test]
async fn a_mailbox_keeps_accepting_messages_far_past_the_old_limits() {
    const MESSAGES: u32 = 5000;
    let relay = Relay::start(|_| Answer::Accepted).await;
    // The first message goes through every check, directory included.
    let first = message(100_000, 2);
    delivered(&relay.put(&first).await, &first);
    let policy = relay
        .owner()
        .get(&payload_hash(&first))
        .unwrap()
        .unwrap()
        .policy;
    // The rest are stored directly: same parties, so the directory has nothing new to say.
    for tag in 1..MESSAGES {
        let request = message(100_000 + tag, 0);
        let mut policy = policy.clone();
        policy.payload_hash = payload_hash(&request);
        let input =
            crate::monad_dm_payment::CanonicalPaymentInput::without_directory(request, policy)
                .unwrap();
        relay.owner().claim(input, now_ms()).unwrap();
    }
    assert_eq!(relay.inbox().len(), MESSAGES as usize);
    assert_eq!(relay.mailbox(relay.sender()).len(), MESSAGES as usize);
    // One more over HTTP, paid, is delivered and broadcast like the first.
    let last = message(200_000, 2);
    delivered(&relay.put(&last).await, &last);
    assert_eq!(relay.broadcasts().len(), 4);
    assert_eq!(relay.inbox().len(), MESSAGES as usize + 1);

    // A restart finds them all and takes the next one.
    let fixture = relay.shut_down().await.reopen().await;
    let owner = fixture.registry.canonical_dm();
    let recipient = address(&hex::decode(&fixture.accounts[1].subject).unwrap());
    assert_eq!(
        owner.inbox(recipient, 0, None, 10_000).unwrap().len(),
        MESSAGES as usize + 1
    );
    let after = message(300_000, 0);
    let mut policy = policy;
    policy.payload_hash = payload_hash(&after);
    let input =
        crate::monad_dm_payment::CanonicalPaymentInput::without_directory(after, policy).unwrap();
    owner.claim(input, now_ms()).unwrap();
    fixture.stop().await;
}

/// The genuine wallet-made message, end to end over HTTP: delivered, then read back by its
/// recipient through the signed inbox and mailbox pages. A login works exactly once.
#[tokio::test]
async fn a_delivered_message_is_read_back_over_http_and_a_login_works_once() {
    use crate::monad_mailbox::{MailboxRequestBinding, MailboxResource};
    let relay = Relay::start(|_| Answer::Accepted).await;
    let request = genuine_fixture();
    delivered(&relay.put(&request).await, &request);
    relay.assert_delivered_to_both(&request);
    assert_eq!(relay.broadcasts(), raws(&request));

    let client = reqwest::Client::new();
    let (url, point) = (&relay.url, &relay.fixture.accounts[1].subject);
    let recipient = relay.recipient().to_hex();
    let page = "since=0&limit=50&max_bytes=8388608";
    assert_eq!(
        client
            .get(format!(
                "{url}/message/auth/{recipient}?resource=inbox&{page}"
            ))
            .header("x-frank-mailbox-subject", point)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    let binding = |resource| MailboxRequestBinding {
        resource,
        recipient: relay.recipient(),
        since: 0,
        cursor: None,
        limit: 50,
        max_bytes: MAX_REQUEST_BYTES,
    };
    let root = relay.fixture.root.path();
    let login = private_headers(&client, url, root, point, &binding(MailboxResource::Inbox)).await;
    let inbox = || {
        client
            .get(format!("{url}/message/inbox/{recipient}?{page}"))
            .headers(login.clone())
            .send()
    };
    let response = inbox().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let media = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_owned();
    let boundary = parse_boundary(&media, "multipart/mixed").unwrap();
    let bytes = response.bytes().await.unwrap();
    assert!(bytes.starts_with(
        format!("--{boundary}\r\nContent-Disposition: inline; name=\"record\"").as_bytes()
    ));
    assert!(bytes.ends_with(format!("--{boundary}--\r\n").as_bytes()));
    assert!(find(&bytes, request.delivery()).is_some());
    assert!(find(&bytes, request.context()).is_some());
    // The same login a second time is refused.
    assert_eq!(inbox().await.unwrap().status(), StatusCode::UNAUTHORIZED);

    let login = private_headers(
        &client,
        url,
        root,
        point,
        &binding(MailboxResource::Mailbox),
    )
    .await;
    let response = client
        .get(format!("{url}/message/mailbox/{recipient}?{page}"))
        .headers(login)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.bytes().await.unwrap();
    assert!(find(&bytes, b"X-Frank-Mailbox-Direction: in").is_some());
    assert!(find(&bytes, request.delivery()).is_some());
    relay.stop().await;
}
