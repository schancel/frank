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
use std::sync::Mutex;

const JOINED_CLOCK_SECONDS: &str = "1700000100";
const JOINED_STAMP_VALUE_WEI: u128 = 1500;
const JOINED_TEXT: &str = "joined wallet to native relay";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ChainMode {
    /// Every broadcast is accepted. Nothing is ever mined: there are no receipts to wait for.
    Accept,
    /// The first payment broadcast is accepted; the node refuses every other one.
    RefuseOthers,
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
            // Plain transfers reserve 21000 gas x 3 wei: a 64000 wei balance leaves
            // 1000 wei of capacity per disposable account, so 1500 wei needs two members.
            "eth_getBalance" => serde_json::json!("0xfa00"),
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
                    if *self.mode.lock().unwrap() == ChainMode::RefuseOthers
                        && !broadcasts.is_empty()
                    {
                        return Err("nonce too low".into());
                    }
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
            "eth_getTransactionReceipt" => serde_json::Value::Null,
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
    let joined = Joined::start(ChainMode::Accept).await;
    let outcome = std::panic::AssertUnwindSafe(async {
        // Wallet process 1: durable intent, leases, frozen signatures, promoted exact body.
        let freeze = wallet_phase(&joined.work, "sender-freeze").await;
        let request = joined.frozen(&freeze).await;
        assert_eq!(request.transaction_count(), 2);
        assert_eq!(freeze["members"].as_array().unwrap().len(), 2);
        assert!(joined.claim(&freeze).is_none());
        assert_eq!(joined.chain.count("eth_sendRawTransaction"), 0);
        assert_eq!(statuses(&freeze["pool"]), ["in-use", "in-use"]);
        let values: Vec<u128> = freeze["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member["value"].as_str().unwrap().parse::<u128>().unwrap())
            .collect();
        assert_eq!(values, [1000, 500]);
        let total: u128 = values.iter().sum();
        assert_eq!(total, JOINED_STAMP_VALUE_WEI);

        // Wallet process 2: reopened journal, same bytes, real transport PUT. Nothing is mined,
        // and the first answer is already `delivered`: the relay stored the message and handed
        // both payments to the node.
        let delivered = wallet_phase(&joined.work, "sender-submit").await;
        assert_eq!(delivered["restoredBody"], freeze["body"]);
        assert_eq!(delivered["accepted"]["phase"], "delivered");
        assert_eq!(delivered["accepted"]["identity"], freeze["identity"]);
        assert_eq!(delivered["terminal"]["phase"], "delivered");
        assert_eq!(delivered["workflowAcknowledged"], true);
        assert_eq!(statuses(&delivered["pool"]), ["spent", "spent"]);
        let claim = joined.claim(&freeze).expect("the relay stored the message");
        let Phase::Delivered(committed) = claim.phase else {
            panic!("a stored message is delivered, was {:?}", claim.phase);
        };
        assert_eq!(delivered["accepted"]["mailbox_committed_at_ms"], committed);
        assert!(claim.request.exact_equal(&request));
        let mut sent: Vec<_> = joined
            .chain
            .broadcasts()
            .iter()
            .map(|tx| {
                // #826: what the real wallet signed and the relay broadcast is a plain value
                // transfer; no calldata reaches the chain.
                assert!(tx.input.is_empty());
                tx.tx_hash.to_hex()
            })
            .collect();
        let mut signed: Vec<_> = freeze["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member["hash"].as_str().unwrap().to_owned())
            .collect();
        sent.sort();
        signed.sort();
        assert_eq!(sent, signed);
        assert_eq!(joined.chain.count("eth_sendRawTransaction"), 2);
        // The relay looked nothing up and waited for no receipt.
        assert_eq!(joined.chain.count("eth_getTransactionReceipt"), 0);
        assert_eq!(joined.chain.count("eth_getTransactionByHash"), 0);

        // Wallet process 3: the reopened owner validates its spent accounts and holds only the
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
        assert_eq!(read["recovery"].as_array().unwrap().len(), 0);
    })
    .catch_unwind()
    .await;
    joined.stop().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// One payment of two never reaches the chain. The message is delivered all the same, so the
/// recipient holds what it needs to spend the payment that did.
#[tokio::test]
async fn joined_real_wallet_message_is_delivered_and_opened_although_the_node_refused_a_payment() {
    use futures::FutureExt;
    let joined = Joined::start(ChainMode::RefuseOthers).await;
    let outcome = std::panic::AssertUnwindSafe(async {
        let freeze = wallet_phase(&joined.work, "sender-freeze").await;
        let request = joined.frozen(&freeze).await;
        assert_eq!(request.transaction_count(), 2);

        let delivered = wallet_phase(&joined.work, "sender-submit").await;
        assert_eq!(delivered["accepted"]["phase"], "delivered");
        assert_eq!(delivered["accepted"]["identity"], freeze["identity"]);
        assert_eq!(delivered["terminal"]["phase"], "delivered");
        // Both payments were handed to the node once; it took one.
        assert_eq!(joined.chain.count("eth_sendRawTransaction"), 2);
        assert_eq!(joined.chain.broadcasts().len(), 1);
        let claim = joined.claim(&freeze).expect("the relay stored the message");
        assert!(matches!(claim.phase, Phase::Delivered(_)));

        let read = wallet_phase(&joined.work, "recipient-read").await;
        let inbox = read["inbox"].as_array().unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0]["delivery"], hex::encode(request.delivery()));
        assert_eq!(inbox[0]["t3"], freeze["identity"]["payload_hash"]);
        assert_eq!(inbox[0]["texts"], serde_json::json!([JOINED_TEXT]));
    })
    .catch_unwind()
    .await;
    joined.stop().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
