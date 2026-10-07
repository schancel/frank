//! Joined proof: the real wallet canonical consumer and public transport produce every request
//! byte; this native relay admits, broadcasts, publishes and serves them back over actual HTTP.
//!
//! Nothing here is a captured fixture. `packages/wallet/canonical-relay-joined-driver.ts` runs
//! one wallet phase per Node process against this test's live listeners. The only shared inputs
//! are the checked-in public domain-root vectors and the two accounts' own signed directory
//! entries, which each account publishes itself over HTTP. No account is configured on the relay.
//! The chain is an owned in-process JSON-RPC fake: no funded-chain finality is claimed.
use super::*;
use crate::monad_evm_tx::DecodedSignedTransaction;
use crate::store::monad_dm_cbor::Phase;
use crate::store::monad_outbox::{MonadOutboxMemberState, MonadOutboxTerminal};
use std::sync::Mutex;

const JOINED_CLOCK_SECONDS: &str = "1700000100";
const JOINED_STAMP_VALUE_WEI: u128 = 1500;
const JOINED_TEXT: &str = "joined wallet to native relay";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ChainMode {
    /// Accepted broadcasts stay in the pool without a receipt.
    Hold,
    /// Every accepted broadcast has a successful receipt.
    Mine,
    /// The first broadcast succeeds; the second is mined reverted.
    RevertSecond,
}

/// Owned local chain. It answers the wallet's quote reads and learns transactions only from
/// the relay's own `eth_sendRawTransaction`, decoded by the production strict decoder.
struct JoinedChain {
    mode: Mutex<ChainMode>,
    broadcasts: Mutex<Vec<DecodedSignedTransaction>>,
    methods: Mutex<Vec<String>>,
}
impl JoinedChain {
    fn new(mode: ChainMode) -> Arc<Self> {
        Arc::new(Self {
            mode: Mutex::new(mode),
            broadcasts: Mutex::new(Vec::new()),
            methods: Mutex::new(Vec::new()),
        })
    }
    fn set_mode(&self, mode: ChainMode) {
        *self.mode.lock().unwrap() = mode;
    }
    fn broadcasts(&self) -> Vec<DecodedSignedTransaction> {
        self.broadcasts.lock().unwrap().clone()
    }
    fn count(&self, method: &str) -> usize {
        self.methods
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.as_str() == method)
            .count()
    }
    fn answer(&self, query: &serde_json::Value) -> std::result::Result<serde_json::Value, String> {
        use crate::monad_http::Hash32;
        let method = query["method"].as_str().unwrap_or_default();
        self.methods.lock().unwrap().push(method.to_owned());
        let by_hash = || {
            let hash = query["params"][0].as_str().unwrap_or_default();
            let broadcasts = self.broadcasts.lock().unwrap();
            broadcasts
                .iter()
                .position(|tx| tx.tx_hash.to_hex() == hash)
                .map(|index| (index, broadcasts[index].clone()))
        };
        Ok(match method {
            "eth_chainId" => serde_json::json!("0x279f"),
            // Wallet quote reads: 151000 wei less the quoted 50000 gas x 3 wei fee reserve leaves
            // 1000 wei of capacity per disposable account, so 1500 wei needs two members.
            "eth_getBalance" => serde_json::json!("0x24dd8"),
            "eth_getTransactionCount" => serde_json::json!("0x0"),
            "eth_estimateGas" => serde_json::json!("0xc350"),
            "eth_gasPrice" => serde_json::json!("0x2"),
            "eth_maxPriorityFeePerGas" => serde_json::json!("0x1"),
            "eth_getBlockByNumber" => serde_json::json!({
                "hash":Hash32([2;32]).to_hex(),"parentHash":Hash32([1;32]).to_hex(),"number":"0x1",
                "timestamp":"0x6553f164","nonce":"0x0000000000000000","difficulty":"0x0",
                "gasLimit":"0x1c9c380","gasUsed":"0x0","miner":"0x0000000000000000000000000000000000000000",
                "extraData":"0x","baseFeePerGas":"0x1","transactions":[]}),
            "eth_sendRawTransaction" => {
                let raw = query["params"][0]
                    .as_str()
                    .and_then(|raw| hex::decode(raw.trim_start_matches("0x")).ok())
                    .ok_or("malformed raw transaction")?;
                let decoded = crate::monad_evm_tx::decode_signed_transaction(&raw)
                    .map_err(|error| error.to_string())?;
                let hash = decoded.tx_hash.to_hex();
                let mut broadcasts = self.broadcasts.lock().unwrap();
                if !broadcasts.iter().any(|tx| tx.tx_hash == decoded.tx_hash) {
                    broadcasts.push(decoded);
                }
                serde_json::json!(hash)
            }
            "eth_getTransactionByHash" => match by_hash() {
                Some((_, tx)) => serde_json::json!({
                    "hash":tx.tx_hash.to_hex(),"from":tx.sender.to_hex(),
                    "to":tx.destination.map(|to| to.to_hex()),
                    "value":format!("0x{:x}", tx.value_wei),
                    "input":format!("0x{}", hex::encode(&tx.input))}),
                None => serde_json::Value::Null,
            },
            "eth_getTransactionReceipt" => match (by_hash(), *self.mode.lock().unwrap()) {
                (None, _) | (Some(_), ChainMode::Hold) => serde_json::Value::Null,
                (Some((index, tx)), mode) => serde_json::json!({
                    "transactionHash":tx.tx_hash.to_hex(),"blockHash":Hash32([2;32]).to_hex(),
                    "blockNumber":"0x1","transactionIndex":format!("0x{index:x}"),
                    "from":tx.sender.to_hex(),"to":tx.destination.map(|to| to.to_hex()),
                    "gasUsed":"0x5208",
                    "status":if mode == ChainMode::RevertSecond && index == 1 {"0x0"} else {"0x1"},
                    "logs":[]}),
            },
            other => return Err(format!("joined chain fake does not serve {other}")),
        })
    }
    fn router(self: &Arc<Self>) -> axum::Router {
        let chain = self.clone();
        axum::Router::new().route(
            "/",
            axum::routing::post(move |Json(query): Json<serde_json::Value>| {
                let chain = chain.clone();
                async move {
                    Json(match chain.answer(&query) {
                        Ok(result) => {
                            serde_json::json!({"jsonrpc":"2.0","id":query["id"],"result":result})
                        }
                        Err(message) => serde_json::json!({"jsonrpc":"2.0","id":query["id"],
                            "error":{"code":-32601,"message":message}}),
                    })
                }
            }),
        )
    }
}

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

/// One real wallet phase in its own Node process; durable wallet state lives under `work`.
async fn wallet_phase(work: &std::path::Path, phase: &str) -> serde_json::Value {
    let repo = repo_root();
    let preload = work.join("joined-resolve.cjs");
    // Workspace source resolution only; no wallet, transport or codec behavior is replaced.
    std::fs::write(
        &preload,
        r#"
const repo=process.env.FRANK_JOINED_REPO;
const Module=require('module'),resolve=Module._resolveFilename;
Module._resolveFilename=function(name,parent,...args){
 if(name==='@frank/crypto-box')name=repo+'/packages/crypto-box/src/index.ts';
 else if(name==='@frank/codec')name=repo+'/packages/frank-codec/src/index.ts';
 else if(name==='@frank/nakamoto')name=repo+'/packages/nakamoto/src/index.ts';
 else if(name.startsWith('@frank/nakamoto/'))name=repo+'/packages/nakamoto/src/'+name.slice('@frank/nakamoto/'.length);
 else if(name==='@frank/directory-admission')name=repo+'/packages/directory-admission/src/index.ts';
 else if(name.startsWith('@frank/cashweb/'))name=repo+'/packages/cashweb/'+name.slice('@frank/cashweb/'.length);
 return resolve.call(this,name,parent,...args);
};
"#,
    )
    .unwrap();
    let config = work.join("config.json");
    let phase_name = phase.to_owned();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .env("FRANK_JOINED_REPO", &repo)
            .arg("-r")
            .arg(&preload)
            .arg("-r")
            .arg(repo.join("node_modules/tsx/dist/cjs/index.cjs"))
            .arg(repo.join("packages/wallet/canonical-relay-joined-driver.ts"))
            .arg(&phase_name)
            .arg(&config)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    eprintln!(
        "joined wallet phase {phase}: exit={:?}\nstdout={}\nstderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.status.success(),
        "real wallet phase {phase} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

struct Joined {
    fixture: NativeDirectoryFixture,
    chain: Arc<JoinedChain>,
    work: std::path::PathBuf,
    stops: Vec<(
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    )>,
}
impl Joined {
    async fn start(mode: ChainMode) -> Self {
        // The relay starts knowing no account at all: its configuration is only its own tuple.
        let fixture = NativeDirectoryFixture::publishing(|_| false).await;
        let chain = JoinedChain::new(mode);
        let (rpc_url, rpc_stop, rpc_task) = serve_http(chain.router()).await;
        let (url, http_stop, http_task) = serve_http(
            server(&fixture, &rpc_url).into_router_with_directory(Some(fixture.directory.clone())),
        )
        .await;
        // Each account publishes its own signed entry over the public route, as a wallet does.
        let attestations =
            &admitted_source()["canonical_facade_final_http_case"]["wire"]["http_attestations"];
        let client = reqwest::Client::new();
        for (index, account) in fixture.accounts.iter().enumerate() {
            let head = format!(
                "{url}/directory/v1/{}/{}/head",
                account.network, account.subject
            );
            assert_eq!(client.get(&head).send().await.unwrap().status(), 404);
            let entry = hex::decode(attestations[index].as_str().unwrap()).unwrap();
            let published = client
                .put(&head)
                .header("content-type", "application/vnd.frank.cbor")
                .body(entry.clone())
                .send()
                .await
                .unwrap();
            assert_eq!(published.status(), 200, "account {index} publishes itself");
            assert_eq!(published.bytes().await.unwrap().as_ref(), entry);
        }
        let work = fixture.root.path().join("joined-wallet");
        std::fs::create_dir(&work).unwrap();
        let source = admitted_source();
        let roots: serde_json::Value = serde_json::from_slice(
            &std::fs::read(repo_root().join("packages/domain-roots/vectors/domain-roots-v1.json"))
                .unwrap(),
        )
        .unwrap();
        std::fs::write(
            work.join("config.json"),
            serde_json::to_vec(&serde_json::json!({
                "relayHttp": url,
                "rpcUrl": rpc_url,
                "workDir": work,
                "clockSeconds": JOINED_CLOCK_SECONDS,
                "principals": source["canonical_facade_final_http_case"]["installed_principals"],
                "domainRoots": [roots["vectors"][0]["outputs"], roots["vectors"][1]["outputs"]],
                "stampValueWei": JOINED_STAMP_VALUE_WEI.to_string(),
                "poolSize": 2,
                "text": JOINED_TEXT,
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            fixture,
            chain,
            work,
            stops: vec![(http_stop, http_task), (rpc_stop, rpc_task)],
        }
    }
    async fn stop(self) {
        for (stop, task) in self.stops {
            stop.send(()).unwrap();
            task.await.unwrap();
        }
        self.fixture.stop().await;
    }
    /// The wallet's promoted request, re-read by the native exact parser and CPU admission.
    async fn frozen(&self, freeze: &serde_json::Value) -> ExactRequest {
        let request = ExactRequest::parse(
            hex::decode(freeze["body"].as_str().unwrap()).unwrap(),
            freeze["contentType"].as_str().unwrap().to_owned(),
        )
        .expect("native exact multipart parser must accept the wallet's frozen body");
        assert_eq!(
            hex::encode(request.submission_identity()),
            freeze["identity"]["submission_identity"].as_str().unwrap()
        );
        let owner = self.fixture.registry.canonical_dm();
        let Principals {
            sender, recipient, ..
        } = request_principals(&request, "monad-testnet").unwrap();
        let sender = current(owner, "monad-testnet", &sender).await.unwrap();
        let recipient = current(owner, "monad-testnet", &recipient).await.unwrap();
        crate::monad_dm_verify::verify_canonical_stamp(
            crate::monad_dm_verify::CanonicalStampCheckInput {
                delivery: request.delivery(),
                context: request.context(),
                sender_current: &sender,
                recipient_current: &recipient,
                recipient_evidence: None,
            },
        )
        .expect("wallet delivery/context must pass the native public stamp verifier");
        crate::monad_outbox::financial::validate_canonical_payment_set(
            request.clone(),
            &sender,
            &recipient,
            None,
            "monad-testnet",
            10143,
            1,
        )
        .map(|_| ())
        .expect("wallet signed members must pass native financial CPU admission");
        request
    }
    fn claim(&self, freeze: &serde_json::Value) -> Option<crate::store::monad_dm_cbor::Claim> {
        let hash = hash_hex(freeze["identity"]["payload_hash"].as_str().unwrap()).unwrap();
        self.fixture.registry.canonical_dm().get(&hash).unwrap()
    }
}

fn statuses(pool: &serde_json::Value) -> Vec<&str> {
    pool.as_array()
        .unwrap()
        .iter()
        .map(|record| record["status"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn joined_real_wallet_request_is_admitted_delivered_and_opened_by_recipient() {
    use futures::FutureExt;
    let joined = Joined::start(ChainMode::Hold).await;
    let outcome = std::panic::AssertUnwindSafe(async {
        // Wallet process 1: durable intent, leases, frozen signatures, promoted exact body.
        let freeze = wallet_phase(&joined.work, "sender-freeze").await;
        let request = joined.frozen(&freeze).await;
        assert_eq!(request.transaction_count(), 2);
        assert_eq!(freeze["members"].as_array().unwrap().len(), 2);
        assert!(joined.claim(&freeze).is_none());
        assert_eq!(joined.chain.count("eth_sendRawTransaction"), 0);
        assert_eq!(statuses(&freeze["pool"]), ["in-use", "in-use"]);
        let total: u128 = freeze["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member["value"].as_str().unwrap().parse::<u128>().unwrap())
            .sum();
        assert_eq!(total, JOINED_STAMP_VALUE_WEI);

        // Wallet process 2: reopened journal, same bytes, real transport PUT. Chain holds receipts.
        let retained = wallet_phase(&joined.work, "sender-submit").await;
        assert_eq!(retained["restoredBody"], freeze["body"]);
        assert_eq!(retained["reconciledState"], "ready");
        assert_eq!(retained["accepted"]["phase"], "retained");
        assert!(retained["terminal"].is_null());
        assert_eq!(statuses(&retained["pool"]), ["in-use", "in-use"]);
        let pending = joined.claim(&freeze).expect("native owner retained");
        assert_eq!(pending.phase, Phase::Pending);
        assert!(pending.request.exact_equal(&request));
        assert!(pending.members[0].exposed);
        let exposed = joined.chain.broadcasts();
        assert!(!exposed.is_empty());
        for (index, tx) in exposed.iter().enumerate() {
            assert_eq!(
                tx.tx_hash.to_hex(),
                freeze["members"][index]["hash"].as_str().unwrap()
            );
            // #826: what the real wallet signed and the relay broadcast is a plain value
            // transfer; no calldata reaches the chain.
            assert!(tx.input.is_empty());
        }
        // Recipient does not see recovery records (recovery endpoint is retired).
        let early = wallet_phase(&joined.work, "recipient-read").await;
        assert_eq!(early["inbox"].as_array().unwrap().len(), 0);
        assert_eq!(early["recovery"].as_array().unwrap().len(), 0);

        // Receipts appear. Wallet process 3 re-PUTs the identical retained bytes.
        joined.chain.set_mode(ChainMode::Mine);
        let delivered = wallet_phase(&joined.work, "sender-submit").await;
        assert_eq!(delivered["restoredBody"], freeze["body"]);
        assert_eq!(delivered["accepted"]["phase"], "delivered");
        assert_eq!(delivered["accepted"]["identity"], freeze["identity"]);
        assert_eq!(delivered["terminal"]["phase"], "delivered");
        assert_eq!(delivered["workflowAcknowledged"], true);
        assert_eq!(statuses(&delivered["pool"]), ["spent", "spent"]);
        let claim = joined.claim(&freeze).unwrap();
        let Phase::Delivered(committed) = claim.phase else {
            panic!("native owner must be delivered, was {:?}", claim.phase);
        };
        assert_eq!(delivered["accepted"]["mailbox_committed_at_ms"], committed);
        assert_eq!(claim.obligation_id, pending.obligation_id);
        assert!(claim.request.exact_equal(&request));
        assert!(claim
            .members
            .iter()
            .all(|member| matches!(member.state, MonadOutboxMemberState::Confirmed { .. })));
        assert_eq!(joined.chain.broadcasts().len(), 2);
        assert_eq!(joined.chain.count("eth_sendRawTransaction"), 2);

        // Wallet process 4: the reopened owner validates its spent accounts and holds only the
        // durable workflow acknowledgement, so no further PUT or chain read is possible.
        let financial_calls = joined.chain.methods.lock().unwrap().len();
        let settled = wallet_phase(&joined.work, "sender-submit").await;
        assert_eq!(settled["reconciledState"], "acknowledged");
        assert!(settled["accepted"].is_null());
        assert_eq!(statuses(&settled["pool"]), ["spent", "spent"]);
        assert_eq!(joined.chain.methods.lock().unwrap().len(), financial_calls);

        // Recipient wallet: P-authenticated native inbox page, opened with real role custody.
        let read = wallet_phase(&joined.work, "recipient-read").await;
        let inbox = read["inbox"].as_array().unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0]["delivery"], hex::encode(request.delivery()));
        assert_eq!(inbox[0]["context"], hex::encode(request.context()));
        assert_eq!(
            inbox[0]["submissionIdentity"],
            freeze["identity"]["submission_identity"]
        );
        assert_eq!(inbox[0]["timestampMs"], committed);
        assert_eq!(inbox[0]["t3"], freeze["identity"]["payload_hash"]);
        assert_eq!(inbox[0]["texts"], serde_json::json!([JOINED_TEXT]));
        // Delivered value is not a recovery obligation.
        assert_eq!(read["recovery"].as_array().unwrap().len(), 0);
        assert!(!joined.claim(&freeze).unwrap().acknowledged);
    })
    .catch_unwind()
    .await;
    joined.stop().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn joined_real_wallet_terminal_prefix_is_imported_and_acknowledged_by_recipient() {
    use futures::FutureExt;
    let joined = Joined::start(ChainMode::RevertSecond).await;
    let outcome = std::panic::AssertUnwindSafe(async {
        let freeze = wallet_phase(&joined.work, "sender-freeze").await;
        let request = joined.frozen(&freeze).await;
        assert_eq!(request.transaction_count(), 2);

        // Member 0 confirms, member 1 reverts: the relay's durable terminal decision.
        let dead = wallet_phase(&joined.work, "sender-submit").await;
        assert_eq!(dead["accepted"]["phase"], "dead");
        assert_eq!(dead["accepted"]["reason"], "verification_failed");
        assert_eq!(dead["terminal"]["phase"], "dead");
        assert_eq!(dead["workflowAcknowledged"], true);
        assert_eq!(statuses(&dead["pool"]), ["retired", "retired"]);
        let terminal = joined.claim(&freeze).unwrap();
        assert_eq!(
            terminal.phase,
            Phase::Terminal(MonadOutboxTerminal::VerificationFailed)
        );
        assert!(terminal.recoverable());
        assert!(!terminal.acknowledged);

        // Recipient wallet: recovery endpoint is retired (410 Gone) -> 0 recovery records.
        let read = wallet_phase(&joined.work, "recipient-read").await;
        assert_eq!(read["inbox"].as_array().unwrap().len(), 0);
        assert_eq!(read["recovery"].as_array().unwrap().len(), 0);
        let terminal = joined.claim(&freeze).unwrap();
        assert!(!terminal.acknowledged);
    })
    .catch_unwind()
    .await;
    joined.stop().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
