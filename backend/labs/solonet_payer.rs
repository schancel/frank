//! Real payments for group writes in the labs, on solonet (`monad-regtest`, the local Monad
//! network of `packages/bot/demo/regtest/monad-regtest.ts`). Every group write pays its hosting
//! relay, and the relay checks each payment against its node before it accepts the write, so a
//! lab that writes to groups needs a chain. Nothing here fakes a payment: each one is a signed
//! EIP-1559 transaction from a fresh account the solonet faucet funded, and the relay hands it to
//! solonet after the commit.
//!
//! `FRANK_LAB_SOLONET_RPC_URL` names solonet's JSON-RPC as the lab containers reach it (on
//! Docker Desktop, `http://host.docker.internal:48080` while `yarn --cwd packages/bot
//! regtest:monad-start` runs it). Shared by `cluster_contract.rs` and
//! `cashwebd-exe/tests/foundationdb_daemon.rs` through `#[path]`.
//!
//! No funded key is ever only in memory. `FRANK_LAB_SOLONET_KEY_DIR` names a directory that
//! outlives the process (the lab composes bind-mount one from the host). Each process writes
//! into a run directory of its own there, locked for its lifetime: every key this module
//! generates is written to its own file before anything funds it. Its file is removed only
//! after a verified sweep leaves exactly zero and recorded funding is complete. Payers are
//! swept when their [`Funded`] is
//! dropped, also while a failed test unwinds; a run that was killed leaves its files behind, and
//! a later run's first [`Solonet::from_env`] sweeps every run directory whose lock is stale
//! before it funds anything (backend/labs/README.md, "The keys the labs fund").
#![allow(dead_code)]

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use cashweb_registry::{
    group_write_payment::{group_write_calldata, group_write_commitment, GroupWriteTarget},
    store::groups::GroupMessageEnvelope,
};
use futures::StreamExt;
use rlp::RlpStream;
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
use sha3::{Digest, Keccak256};

/// solonet's native chain ID.
pub const SOLONET_CHAIN_ID: u64 = 20143;
/// The canonical identifier of solonet's network (`docs/protocol/chains/v1.json`).
pub const SOLONET_NETWORK: &str = "monad-regtest";
/// The solonet faucet. Publicly known: a funded genesis account of a local chain and nothing
/// else (the same key `monad-regtest.ts` uses).
const FAUCET_KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/// What one payer gets: one payment's value and gas at several times the current fee.
const PAYER_FUNDING_WEI: u128 = 20_000_000_000_000_000;
/// Gas limit of a payment: 21,000 plus the calldata floor of the 37-byte commitment.
const PAYMENT_GAS: u64 = 30_000;
/// What a funding account keeps above the payers' funding: Monad's reserve balance and more.
const TREASURY_RESERVE_WEI: u128 = 20_000_000_000_000_000_000;
/// Sweeps sent at once: each is a few RPCs through the lab's port forward to solonet.
const SWEEP_IN_FLIGHT: usize = 20;
/// Funding transactions sent before waiting for them to land.
const FUNDING_BATCH: usize = 50;
/// How long a read is asked again while solonet is too busy to answer it.
const RPC_PATIENCE: Duration = Duration::from_secs(60);
/// How long a funding send is retried while the node does not yet see its sender funded or is
/// too busy to take it. On a quiet solonet the first retry, a block later, is taken.
const FUNDING_PATIENCE: Duration = Duration::from_secs(180);
/// Rounds of sweep sends; an account still holding funds after the last keeps its key file.
const SWEEP_ATTEMPTS: u128 = 5;
/// What a sweep's fee cap adds above base fee + tip: each round tips one wei more (other bytes:
/// Monad keeps refusing bytes it refused once), so the cap covers every round's tip and the
/// sweep holds back exactly `21,000 x cap`. Monad charges base fee + tip per gas, up to the cap
/// (docs/protocol/chains/monad-reserve-balance.md), so at most `21,000 x` this is left behind.
const SWEEP_TIP_MARGIN_WEI: u128 = SWEEP_ATTEMPTS;
/// Gas limit of a plain transfer, which is what Monad charges.
const TRANSFER_GAS: u128 = 21_000;
/// How long a sent sweep is waited on to land.
const SWEEP_LAND_PATIENCE: Duration = Duration::from_secs(60);
/// This process's run directory: one per process, shared by its tests.
static PROCESS_KEYS: std::sync::OnceLock<Arc<KeyFiles>> = std::sync::OnceLock::new();
/// Leftover keys of earlier runs are swept once per process, before it funds anything.
static LEFTOVERS_SWEPT: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// A JSON-RPC call that did not succeed.
#[derive(Debug)]
enum RpcError {
    /// The request or its answer did not get through: a timeout, a dropped connection, or an
    /// answer that is not JSON-RPC.
    Transport(String),
    /// The node answered with an error.
    Node(String),
}

impl RpcError {
    /// Worth asking again unchanged: the node or the way to it was too busy.
    fn busy(&self) -> bool {
        match self {
            RpcError::Transport(_) => true,
            RpcError::Node(message) => {
                let message = message.to_ascii_lowercase();
                ["overloaded", "try again", "timed out", "timeout", "busy"]
                    .iter()
                    .any(|busy| message.contains(busy))
            }
        }
    }

    /// The node already holds another transaction of the sender at this nonce.
    fn nonce_held(&self) -> bool {
        matches!(self, RpcError::Node(message) if message.contains("existing transaction"))
    }

    /// The node does not (yet) see the sender holding the transaction's gas and value.
    fn insufficient_balance(&self) -> bool {
        matches!(self, RpcError::Node(message) if message.contains("insufficient balance"))
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Transport(message) | RpcError::Node(message) => f.write_str(message),
        }
    }
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

fn address(key: &SecretKey) -> [u8; 20] {
    let public = PublicKey::from_secret_key(&Secp256k1::new(), key).serialize_uncompressed();
    keccak(&public[1..])[12..].try_into().unwrap()
}

/// One account that pays one group write, at its nonce 0.
#[derive(Clone)]
pub struct Payer {
    key: SecretKey,
    pub address: [u8; 20],
    /// Where its key is saved.
    file: Arc<KeyFile>,
}

/// Where one key is saved, and what the faucet has signed to it.
struct KeyFile {
    /// `0x<address>.key`, or the `.0x<address>.partial` an interrupted save left behind.
    path: PathBuf,
    /// `0x<address>.funding`: one more than the highest faucet nonce a payment to this account
    /// was signed at, written before that payment is sent.
    funding: PathBuf,
    /// Whether `path` is a save that never finished: then nothing was ever paid to the key.
    partial: bool,
    /// The value `funding` holds; 0 when the faucet never signed a payment to this account.
    faucet_signed_below: AtomicU64,
    /// False when the original claim is unreadable or malformed; never means no funding.
    funding_readable: bool,
}

/// How long a run's `.lock` may go untouched before the run counts as gone.
const RUN_LOCK_STALE: Duration = Duration::from_secs(60);
/// How often a live run touches its `.lock`.
const RUN_LOCK_HEARTBEAT: Duration = Duration::from_secs(5);

/// Write `contents` to `path` durably: a fresh file beside it, flushed to disk, then renamed.
fn write_durably(
    dir: &std::path::Path,
    path: &std::path::Path,
    contents: &[u8],
) -> std::io::Result<()> {
    use std::io::Write;
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    let partial = dir.join(format!(".{name}.{:08x}.partial", rand::random::<u32>()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&partial)?;
    file.write_all(contents)?;
    file.sync_all()?;
    std::fs::rename(&partial, path)?;
    std::fs::File::open(dir)?.sync_all()
}

/// The keys of this process, in a run directory of their own under `FRANK_LAB_SOLONET_KEY_DIR`
/// (see the module docs). The run holds `.lock` in it for its lifetime by touching it every few
/// seconds: Docker Desktop's bind mounts do not carry `flock` between containers, so a lock is
/// held while it is fresh. Another run's directory is taken over only once its lock is stale.
struct KeyFiles {
    root: PathBuf,
    dir: PathBuf,
}

impl KeyFiles {
    /// A new run directory under `FRANK_LAB_SOLONET_KEY_DIR`, locked; fails with what to do when
    /// the variable is not set, or when the lab was given a relative host directory.
    fn from_env() -> Self {
        let root = std::env::var("FRANK_LAB_SOLONET_KEY_DIR")
            .ok()
            .map(|dir| dir.trim().to_owned())
            .filter(|dir| !dir.is_empty())
            .expect(
                "FRANK_LAB_SOLONET_KEY_DIR: the keys this lab funds on solonet are written to a \
                 directory that outlives the test process before they are funded (the lab \
                 composes mount one from the host; see backend/labs/README.md)",
            );
        // Compose resolves a relative bind source against the compose file, inside the checkout.
        if let Ok(host) = std::env::var("FRANK_LAB_SOLONET_KEY_HOST_DIR") {
            let host = host.trim();
            assert!(
                host.is_empty() || host.starts_with('/'),
                "FRANK_LAB_SOLONET_KEY_HOST_DIR must be an absolute path, not {host:?}: a relative \
                 one is a directory in the git checkout"
            );
        }
        let root = PathBuf::from(root);
        let dir = root.join(format!(
            "run-{}-{:08x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&dir)
            .unwrap_or_else(|error| panic!("solonet key directory {}: {error}", dir.display()));
        let lock = dir.join(".lock");
        write_durably(&dir, &lock, std::process::id().to_string().as_bytes())
            .unwrap_or_else(|error| panic!("solonet: could not lock {}: {error}", lock.display()));
        std::thread::spawn(move || loop {
            std::thread::sleep(RUN_LOCK_HEARTBEAT);
            if let Ok(file) = std::fs::File::options().write(true).open(&lock) {
                let _ = file.set_modified(std::time::SystemTime::now());
            }
        });
        KeyFiles { root, dir }
    }

    /// A fresh key, already written to its own file (flushed to disk) and so safe to fund.
    fn fresh(&self) -> Payer {
        let key = SecretKey::from_slice(&rand::random::<[u8; 32]>()).unwrap();
        let address = address(&key);
        let name = format!("0x{}", hex::encode(address));
        let file = KeyFile {
            path: self.dir.join(format!("{name}.key")),
            funding: self.dir.join(format!("{name}.funding")),
            partial: false,
            faucet_signed_below: AtomicU64::new(0),
            funding_readable: true,
        };
        write_durably(&self.dir, &file.path, hex::encode(&key[..]).as_bytes()).unwrap_or_else(
            |error| {
                panic!(
                    "solonet: could not save key {}: {error}",
                    file.path.display()
                )
            },
        );
        Payer {
            key,
            address,
            file: Arc::new(file),
        }
    }

    /// Record, before it is sent, that the faucet signs a payment to `payer` at `nonce`: its
    /// file is then kept until the faucet's nonce has passed it, whichever transaction took it.
    fn note_faucet_signing(&self, payer: &Payer, nonce: u64) {
        assert!(
            payer.file.funding_readable,
            "cannot overwrite an unreadable funding claim"
        );
        let bound = nonce + 1;
        if payer.file.faucet_signed_below.load(Ordering::SeqCst) >= bound {
            return;
        }
        let dir = payer.file.funding.parent().unwrap();
        write_durably(dir, &payer.file.funding, bound.to_string().as_bytes()).unwrap_or_else(
            |error| {
                panic!(
                    "solonet: could not save {}: {error}",
                    payer.file.funding.display()
                )
            },
        );
        payer
            .file
            .faucet_signed_below
            .store(bound, Ordering::SeqCst);
    }

    /// The run directories of earlier runs whose lock is stale, each taken over (renamed) by
    /// this process first. A run that is still alive (its lock fresh) is left alone and named.
    fn stale_runs(&self) -> Vec<PathBuf> {
        let mut runs = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return runs;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_run = path.is_dir()
                && path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("run-"));
            if !is_run || path == self.dir {
                continue;
            }
            let touched = std::fs::metadata(path.join(".lock"))
                .or_else(|_| std::fs::metadata(&path))
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.elapsed().ok());
            match touched {
                Some(age) if age > RUN_LOCK_STALE => {
                    if let Some(taken) = Self::take(&path) {
                        runs.push(taken)
                    }
                }
                _ => println!(
                    "solonet: {} belongs to a run that is still alive (its lock is fresh); left \
                     to a later run",
                    path.display()
                ),
            }
        }
        runs
    }

    /// Take over the stale run directory `stale`, so no other starter sweeps it too: its lock is
    /// touched (fresh, so a starter that lists it now leaves it), then the directory is renamed,
    /// which only one starter can do. This process keeps the lock fresh for the rest of its life;
    /// a directory it leaves keys in goes stale again when it ends. `None` when another starter
    /// took it first.
    fn take(stale: &std::path::Path) -> Option<PathBuf> {
        let lock = stale.join(".lock");
        let touched = std::fs::File::options()
            .write(true)
            .open(&lock)
            .and_then(|file| file.set_modified(std::time::SystemTime::now()));
        if touched.is_err() && write_durably(stale, &lock, b"taking").is_err() {
            return None;
        }
        let name = stale.file_name()?.to_string_lossy().into_owned();
        let base = match name.rfind("-taken-") {
            Some(at) => name[..at].to_owned(),
            None => name,
        };
        let taken = stale.with_file_name(format!("{base}-taken-{:08x}", rand::random::<u32>()));
        std::fs::rename(stale, &taken).ok()?;
        let taken_lock = taken.join(".lock");
        std::thread::spawn(move || loop {
            if let Ok(file) = std::fs::File::options().write(true).open(&taken_lock) {
                let _ = file.set_modified(std::time::SystemTime::now());
            }
            std::thread::sleep(RUN_LOCK_HEARTBEAT);
        });
        Some(taken)
    }

    /// The keys a stale run left in `dir`: its `.key` files, and the `.partial` files of saves
    /// it never finished. A file that cannot be read as a key is named and left in place.
    fn saved(dir: &std::path::Path) -> Vec<Payer> {
        let mut saved = Vec::new();
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) => {
                println!(
                    "solonet: cannot read {}: {error}; left in place",
                    dir.display()
                );
                return saved;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let (stem, partial) = if let Some(stem) = name.strip_suffix(".key") {
                (stem.to_owned(), false)
            } else if name.starts_with(".0x")
                && name.ends_with(".partial")
                && name.contains(".key.")
            {
                (name[1..name.find(".key.").unwrap()].to_owned(), true)
            } else {
                continue;
            };
            let key = std::fs::read_to_string(&path)
                .map_err(|error| error.to_string())
                .and_then(|text| hex::decode(text.trim()).map_err(|error| error.to_string()))
                .and_then(|bytes| SecretKey::from_slice(&bytes).map_err(|error| error.to_string()));
            let key = match key {
                Ok(key) => key,
                Err(error) => {
                    println!(
                        "solonet: {} is not a readable private key ({error}); skipped and left in \
                         place",
                        path.display()
                    );
                    continue;
                }
            };
            let address = address(&key);
            if format!("0x{}", hex::encode(address)) != stem {
                println!(
                    "solonet: {} holds the key of 0x{}, not of its name; swept as that account",
                    path.display(),
                    hex::encode(address)
                );
            }
            let funding = dir.join(format!("0x{}.funding", hex::encode(address)));
            let claim = match std::fs::read_to_string(&funding) {
                Ok(text) => text.trim().parse::<u64>().ok(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(0),
                Err(_) => None,
            };
            saved.push(Payer {
                key,
                address,
                file: Arc::new(KeyFile {
                    path,
                    funding,
                    partial,
                    faucet_signed_below: AtomicU64::new(claim.unwrap_or(0)),
                    funding_readable: claim.is_some(),
                }),
            });
        }
        saved
    }

    /// An orphan claim or interrupted claim write remains evidence, even without a key.
    fn remove_if_done(dir: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let done = entries
            .into_iter()
            .all(|entry| entry.ok().is_some_and(|entry| entry.file_name() == ".lock"));
        if done {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// Called only for verified zero with completed funding, or an unpublished partial save.
    /// Keep the claim if removing its key failed; never make an uncertain key look unfunded.
    fn forget(payer: &Payer) {
        for path in [&payer.file.path, &payer.file.funding] {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    println!(
                        "solonet: could not remove {} after verified zero: {error}",
                        path.display()
                    );
                    return;
                }
            }
        }
    }
}

/// A write policy as `GET /groups/:group_id/write-policy` reports it.
#[derive(Clone, Debug)]
pub struct WritePolicy {
    pub network: String,
    /// The group's price now: its creator's, or the relay's minimum while it has none.
    pub price_wei: u128,
    /// The version of the creator's price record; 0 while there is none.
    pub price_version: u64,
    /// The relay's minimum: the least price a creator may set.
    pub min_price_wei: u128,
    pub host_origin: String,
    /// The relay's own address.
    pub payee: [u8; 20],
}

/// The hosting relay's write policy for `group_id`, read through `origin`.
pub async fn write_policy(client: &reqwest::Client, origin: &str, group_id: &str) -> WritePolicy {
    let response = client
        .get(format!("{origin}/groups/{group_id}/write-policy"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "write policy from {origin}");
    let body: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    let payee = body["payee"].as_str().expect("the payee is one address");
    WritePolicy {
        network: body["network"].as_str().unwrap().to_owned(),
        price_wei: body["price_wei"].as_str().unwrap().parse().unwrap(),
        price_version: body["price_version"].as_u64().unwrap(),
        min_price_wei: body["min_price_wei"].as_str().unwrap().parse().unwrap(),
        host_origin: body["host_origin"].as_str().unwrap().to_owned(),
        payee: hex::decode(payee.trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap(),
    }
}

/// solonet, through its JSON-RPC.
#[derive(Clone)]
pub struct Solonet {
    rpc: String,
    http: reqwest::Client,
    faucet: SecretKey,
    /// Max fee per gas every payment offers: three times the gas price when connected.
    max_fee: u128,
    /// Where every key this module generates is saved before it is funded.
    keys: Arc<KeyFiles>,
}

impl Solonet {
    /// solonet at `FRANK_LAB_SOLONET_RPC_URL`, with its keys saved in
    /// `FRANK_LAB_SOLONET_KEY_DIR`; fails with what to do when either is not set. The first call
    /// of a process sweeps the keys an earlier run left there back to the faucet.
    pub async fn from_env() -> Self {
        // Compose always sets the variable, empty when the host leaves it unset.
        let rpc = std::env::var("FRANK_LAB_SOLONET_RPC_URL")
            .ok()
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .expect(
                "FRANK_LAB_SOLONET_RPC_URL: group writes pay their relay on solonet, so this lab \
                 needs it (yarn --cwd packages/bot regtest:monad-start, then \
                 FRANK_LAB_SOLONET_RPC_URL=http://host.docker.internal:48080)",
            );
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let mut solonet = Solonet {
            rpc,
            http,
            faucet: SecretKey::from_slice(&hex::decode(FAUCET_KEY).unwrap()).unwrap(),
            max_fee: 0,
            keys: PROCESS_KEYS
                .get_or_init(|| Arc::new(KeyFiles::from_env()))
                .clone(),
        };
        let chain_id = solonet.quantity("eth_chainId", serde_json::json!([])).await;
        assert_eq!(
            chain_id,
            u128::from(SOLONET_CHAIN_ID),
            "{} is not solonet",
            solonet.rpc
        );
        solonet.max_fee = 3 * solonet
            .quantity("eth_gasPrice", serde_json::json!([]))
            .await;
        LEFTOVERS_SWEPT
            .get_or_init(|| solonet.sweep_leftovers())
            .await;
        solonet
    }

    /// Sweep the keys earlier runs saved and never swept (a run that was killed, or whose sweep
    /// did not land), from every run directory whose lock is stale, and remove each directory
    /// that is left with nothing to keep.
    async fn sweep_leftovers(&self) {
        for run in self.keys.stale_runs() {
            let leftovers = KeyFiles::saved(&run);
            if !leftovers.is_empty() {
                println!(
                    "solonet: {} keys of an earlier run left in {}; sweeping them first",
                    leftovers.len(),
                    run.display()
                );
                self.sweep(leftovers).await;
            }
            KeyFiles::remove_if_done(&run);
        }
    }

    async fn try_call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, RpcError> {
        let body =
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let transport =
            |error: String| RpcError::Transport(format!("{method} on {}: {error}", self.rpc));
        let bytes = self
            .http
            .post(&self.rpc)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|error| transport(error.to_string()))?
            .bytes()
            .await
            .map_err(|error| transport(error.to_string()))?;
        // A proxy or a node too busy to answer may send something that is not JSON-RPC.
        let answer: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
            transport(format!(
                "not a JSON-RPC answer ({error}): {}",
                String::from_utf8_lossy(&bytes[..bytes.len().min(200)])
            ))
        })?;
        match answer.get("error") {
            Some(error) => Err(RpcError::Node(format!("{method}: {error}"))),
            None => Ok(answer["result"].clone()),
        }
    }

    /// A read. A busy node or a dropped connection is asked again, with backoff, for up to
    /// [`RPC_PATIENCE`]; any other error, or a node busy for longer, fails the test.
    async fn call(&self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let started = Instant::now();
        let mut backoff = Duration::from_millis(250);
        let mut attempts = 0;
        loop {
            attempts += 1;
            match self.try_call(method, params.clone()).await {
                Ok(value) => return value,
                Err(error) if error.busy() && started.elapsed() < RPC_PATIENCE => {
                    if attempts == 1 || attempts % 10 == 0 {
                        println!("solonet: {error}; asking again (attempt {attempts})");
                    }
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(4));
                }
                Err(error) => panic!(
                    "solonet: {method} {params} failed after {attempts} attempts over {:?}: {error}",
                    started.elapsed()
                ),
            }
        }
    }

    async fn quantity(&self, method: &str, params: serde_json::Value) -> u128 {
        let value = self.call(method, params).await;
        u128::from_str_radix(value.as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    }

    async fn block(&self) -> u128 {
        self.quantity("eth_blockNumber", serde_json::json!([]))
            .await
    }

    /// Wait until `count` more blocks exist.
    pub async fn wait_blocks(&self, count: u128) {
        let target = self.block().await + count;
        while self.block().await < target {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn receipt(&self, hash: &[u8; 32]) -> Option<serde_json::Value> {
        let receipt = self
            .call(
                "eth_getTransactionReceipt",
                serde_json::json!([format!("0x{}", hex::encode(hash))]),
            )
            .await;
        (!receipt.is_null()).then_some(receipt)
    }

    async fn wait_receipt(&self, hash: &[u8; 32]) {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(receipt) = self.receipt(hash).await {
                assert_eq!(
                    receipt["status"],
                    "0x1",
                    "transaction 0x{} failed",
                    hex::encode(hash)
                );
                return;
            }
            assert!(
                Instant::now() < deadline,
                "transaction 0x{} never landed",
                hex::encode(hash)
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn pending_nonce(&self, account: [u8; 20]) -> u64 {
        self.quantity(
            "eth_getTransactionCount",
            serde_json::json!([format!("0x{}", hex::encode(account)), "pending"]),
        )
        .await as u64
    }

    /// `account`'s balance at the head and four blocks back (the state a new transaction is
    /// usually admitted against), and the head: what a refused funding send is logged with.
    async fn balance_report(&self, account: [u8; 20]) -> String {
        let head = self.block().await;
        let at = |tag: String| async move {
            match self
                .try_call(
                    "eth_getBalance",
                    serde_json::json!([format!("0x{}", hex::encode(account)), tag]),
                )
                .await
            {
                Ok(value) => value.as_str().map_or_else(
                    || value.to_string(),
                    |hex| {
                        u128::from_str_radix(hex.trim_start_matches("0x"), 16)
                            .map_or_else(|_| hex.to_owned(), |wei| wei.to_string())
                    },
                ),
                Err(error) => format!("unreadable ({error})"),
            }
        };
        format!(
            "head {head}, balance {} wei at the head and {} wei at head - 4",
            at("latest".into()).await,
            at(format!("0x{:x}", head.saturating_sub(4))).await
        )
    }

    /// Send `value` from `from` to `to` at `from`'s nonce `nonce`, and keep at it until solonet
    /// holds a transaction of `from` at that nonce. A node turns down a sender it does not yet
    /// see funded ("Signer had insufficient balance"): it admits a transaction against the
    /// sender's balance at its last committed block less the execution delay, and that block
    /// trails `eth_blockNumber` by a margin that grows when solonet is busy. It also turns down a
    /// burst ("overloaded, try again later"). Both are asked again a block later with other
    /// bytes (a node keeps turning down bytes it once turned down: the value is one wei less per
    /// attempt), for up to [`FUNDING_PATIENCE`]. Only one transaction can ever land at the nonce,
    /// so a resend never pays twice. Anything else, or a refusal that outlasts the patience,
    /// fails the test naming the signer, the nonce and its balance.
    async fn send_funding(&self, from: &Payer, nonce: u64, to: [u8; 20], value: u128) {
        let started = Instant::now();
        let signer = format!("0x{}", hex::encode(from.address));
        for attempt in 0u128.. {
            let (raw, _) = sign_eip1559(
                &from.key,
                SOLONET_CHAIN_ID,
                nonce,
                self.max_fee,
                21_000,
                to,
                value - attempt,
                &[],
            );
            let error = match self
                .try_call(
                    "eth_sendRawTransaction",
                    serde_json::json!([format!("0x{}", hex::encode(raw))]),
                )
                .await
            {
                Ok(_) => {
                    if attempt > 0 {
                        println!(
                            "solonet: {signer} at nonce {nonce} accepted on attempt {} after {:?}",
                            attempt + 1,
                            started.elapsed()
                        );
                    }
                    return;
                }
                Err(error) => error,
            };
            // `from` is an account of this call, so a transaction of it held at this nonce is
            // one of ours: a send answered "overloaded", or whose answer was lost, may still have
            // reached the pool. The node then turns the next one down as a lower-priority
            // replacement, and its pending nonce may not show it yet.
            if error.nonce_held() || self.pending_nonce(from.address).await > nonce {
                println!(
                    "solonet: {signer} at nonce {nonce}: an earlier send of ours is held ({error})"
                );
                return;
            }
            let retryable = error.insufficient_balance() || error.busy();
            if !retryable || started.elapsed() >= FUNDING_PATIENCE {
                panic!(
                    "solonet: {signer} could not send at nonce {nonce} after {} attempts over \
                     {:?}: {error}; {}",
                    attempt + 1,
                    started.elapsed(),
                    self.balance_report(from.address).await
                );
            }
            if attempt == 0 || attempt % 10 == 9 {
                println!(
                    "solonet: {signer} at nonce {nonce} refused ({error}); {}; again next block",
                    self.balance_report(from.address).await
                );
            }
            self.wait_blocks(1).await;
        }
    }

    /// Pay `need` from the faucet into the fresh `treasury` and wait until it has landed. The
    /// faucet is shared: another user can take the nonce between the read and the send, or get
    /// its own transaction mined at that nonce after ours was accepted, so a refused or
    /// superseded payment is signed again at the faucet's next nonce. A node may also take a
    /// transaction while answering "overloaded", so every payment this call has sent counts
    /// when it waits: whichever lands funds the treasury, and a new one is signed only once the
    /// nonce is used by none of them.
    async fn fund_treasury(&self, treasury: &Payer, need: u128) {
        let faucet = address(&self.faucet);
        let started = Instant::now();
        let mut sent = Vec::new();
        for attempt in 0u128.. {
            let nonce = self.pending_nonce(faucet).await;
            // Recorded before the payment exists: the treasury's file then stays until the
            // faucet's nonce has passed every payment signed to it, so one that lands late is
            // still swept.
            self.keys.note_faucet_signing(treasury, nonce);
            let (raw, hash) = sign_eip1559(
                &self.faucet,
                SOLONET_CHAIN_ID,
                nonce,
                self.max_fee,
                21_000,
                treasury.address,
                // Other bytes on each attempt: a node keeps turning down bytes it once did.
                need + attempt,
                &[],
            );
            sent.push(hash);
            let answer = self
                .try_call(
                    "eth_sendRawTransaction",
                    serde_json::json!([format!("0x{}", hex::encode(raw))]),
                )
                .await;
            let outcome = match answer {
                // The transaction may be in the pool; or another of ours at this nonce is.
                Ok(_) => self.landed_or_superseded(&sent, faucet, nonce).await,
                Err(error) if error.busy() || error.nonce_held() => {
                    println!("solonet: faucet payment at nonce {nonce}: {error}; waiting on it");
                    self.landed_or_superseded(&sent, faucet, nonce).await
                }
                Err(error) => Err(error.to_string()),
            };
            match outcome {
                Ok(()) => return,
                Err(why) if started.elapsed() < FUNDING_PATIENCE => {
                    println!("solonet: faucet payment at nonce {nonce}: {why}; again");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(why) => panic!(
                    "solonet: the faucet 0x{} would not fund 0x{} after {} attempts over {:?}: \
                     {why}; faucet {}",
                    hex::encode(faucet),
                    hex::encode(treasury.address),
                    attempt + 1,
                    started.elapsed(),
                    self.balance_report(faucet).await
                ),
            }
        }
    }

    /// Wait until one of `hashes`, sent by `sender`, has landed and succeeded (`Ok`), or
    /// `sender`'s `nonce` is used and none of them landed (`Err`).
    async fn landed_or_superseded(
        &self,
        hashes: &[[u8; 32]],
        sender: [u8; 20],
        nonce: u64,
    ) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            for hash in hashes {
                if let Some(receipt) = self.receipt(hash).await {
                    assert_eq!(
                        receipt["status"],
                        "0x1",
                        "transaction 0x{} failed",
                        hex::encode(hash)
                    );
                    return Ok(());
                }
            }
            if self.latest_nonce(sender).await > nonce {
                // The nonce is used; the receipts are read again in case it was ours after all.
                tokio::time::sleep(Duration::from_millis(500)).await;
                let mut ours = false;
                for hash in hashes {
                    ours |= self.receipt(hash).await.is_some();
                }
                if ours {
                    continue;
                }
                return Err("another transaction took the nonce".into());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "none of {} payments at nonce {nonce} mined within 120 s (pending nonce {})",
                    hashes.len(),
                    self.pending_nonce(sender).await
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Wait until `account` has made `count` transactions.
    async fn wait_nonce(&self, account: [u8; 20], count: u64) {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let landed = self.latest_nonce(account).await;
            if landed >= count {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "solonet: only {landed} of 0x{}'s {count} transactions landed within 120 s \
                 (pending nonce {})",
                hex::encode(account),
                self.pending_nonce(account).await
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// `count` fresh accounts, each funded for one payment. The faucet is shared with whatever
    /// else runs on solonet, so it pays once, into a fresh account of this call (the treasury),
    /// which then funds the payers at nonces nothing else uses.
    ///
    /// A payer's payment is sent to solonet by the relay that accepts its write, so funding is
    /// finished only when the node admits transactions from the payers. That is proven, not
    /// guessed from a block count: the treasury funds one more fresh account (the probe) after
    /// every payer, and the probe's own send back to the faucet is retried until the node
    /// admits it. The node admits it only against state that holds the probe's funding, which
    /// is in the same block as the last payer's or a later one.
    ///
    /// Every key (payers, treasury, probe) is saved before the faucet pays anything, and the
    /// returned [`Funded`] owns them all from that moment: a panic while funding unwinds through
    /// its drop, which sweeps them.
    pub async fn fund(&self, count: usize) -> Funded {
        let started = Instant::now();
        let payers: Vec<Payer> = (0..count).map(|_| self.keys.fresh()).collect();
        let treasury = self.keys.fresh();
        let probe = self.keys.fresh();
        let funded = Funded {
            solonet: self.clone(),
            payers,
            helpers: vec![treasury.clone(), probe.clone()],
            next: AtomicUsize::new(0),
        };
        // Every transfer's value and its gas at the fee cap, the probe's included, and a margin
        // that keeps the treasury above Monad's 10 MON reserve: the node budgets the gas of a
        // sender's transactions in flight against `min(10 MON, balance)`, and a transfer that
        // took the treasury below the reserve while others are in flight would be reverted.
        let need = (count as u128 + 1) * (PAYER_FUNDING_WEI + TRANSFER_GAS * self.max_fee)
            + TREASURY_RESERVE_WEI;
        self.fund_treasury(&treasury, need).await;
        // A new account is usually admitted four blocks after its funding; send_funding retries
        // the ones that take longer.
        self.wait_blocks(4).await;
        let recipients: Vec<[u8; 20]> = funded
            .payers
            .iter()
            .chain([&probe])
            .map(|payer| payer.address)
            .collect();
        let mut nonce = 0;
        for batch in recipients.chunks(FUNDING_BATCH) {
            for recipient in batch {
                self.send_funding(&treasury, nonce, *recipient, PAYER_FUNDING_WEI)
                    .await;
                nonce += 1;
            }
            self.wait_nonce(treasury.address, nonce).await;
        }
        let unfunded: Vec<String> =
            futures::stream::iter(funded.payers.iter().map(|payer| async move {
                let balance = loop {
                    match self.balance(payer.address).await {
                        Ok(balance) => break balance,
                        Err(error) if error.busy() => {
                            tokio::time::sleep(Duration::from_millis(500)).await
                        }
                        Err(error) => panic!("solonet: {error}"),
                    }
                };
                // A resent funding pays a few wei less than PAYER_FUNDING_WEI.
                (balance < PAYER_FUNDING_WEI - 1_000_000)
                    .then(|| format!("0x{} holds {balance} wei", hex::encode(payer.address)))
            }))
            .buffer_unordered(SWEEP_IN_FLIGHT)
            .filter_map(|unfunded| async move { unfunded })
            .collect()
            .await;
        assert!(
            unfunded.is_empty(),
            "solonet: the treasury's transfers landed but {} payers are not funded: {:?}",
            unfunded.len(),
            &unfunded[..unfunded.len().min(5)]
        );
        // The probe pays back most of what it holds: admitted only once the node sees it funded.
        // Its remainder is swept with the payers.
        let gas = TRANSFER_GAS * self.max_fee;
        // Below what it holds by more than any resent funding took off it.
        self.send_funding(
            &probe,
            0,
            address(&self.faucet),
            PAYER_FUNDING_WEI - gas - 1_000_000,
        )
        .await;
        println!("solonet: funded {count} payers in {:?}", started.elapsed());
        // The treasury's reserve goes back now; the payers' leftovers when they are dropped.
        self.sweep(vec![treasury]).await;
        funded
    }

    /// Base fee of the latest block.
    async fn base_fee(&self) -> u128 {
        let block = self
            .call("eth_getBlockByNumber", serde_json::json!(["latest", false]))
            .await;
        let base = block["baseFeePerGas"]
            .as_str()
            .expect("solonet reports no base fee");
        u128::from_str_radix(base.trim_start_matches("0x"), 16).unwrap()
    }

    /// Send what each of `accounts` holds back to the faucet, so test funds come back, and
    /// retain its original key whenever any value or uncertain funding remains. The fee cap
    /// is base fee + tip + [`SWEEP_TIP_MARGIN_WEI`], Monad charges
    /// base fee + tip per gas, and the sweep holds back `21,000 x cap`, so at most
    /// `21,000 x SWEEP_TIP_MARGIN_WEI` wei stays behind.
    ///
    /// Waits for each account's own transactions to land first (a payment a relay broadcast may
    /// still be pending), then lets them settle a few blocks: Monad admits a transaction against
    /// a balance a few blocks old, and lets an account spend below its reserve only three blocks
    /// after its last transaction. A sweep that is refused, reverted or superseded is signed
    /// again a few blocks later; an account still holding funds after [`SWEEP_ATTEMPTS`] rounds
    /// keeps its key file, and the next run sweeps it.
    pub async fn sweep(&self, accounts: Vec<Payer>) {
        let faucet = address(&self.faucet);
        let deadline = Instant::now() + Duration::from_secs(120);
        futures::stream::iter(accounts.iter().map(|account| async move {
            while Instant::now() < deadline {
                match (
                    self.sweep_nonce(account.address, "pending").await,
                    self.sweep_nonce(account.address, "latest").await,
                ) {
                    (Ok(pending), Ok(latest)) if pending > latest => {
                        tokio::time::sleep(Duration::from_millis(250)).await
                    }
                    _ => break, // sweep_one reports unknown/ambiguous state without disposal.
                }
            }
        }))
        .buffer_unordered(SWEEP_IN_FLIGHT)
        .collect::<Vec<()>>()
        .await;
        self.wait_blocks(6).await;
        let mut left = accounts;
        let (mut swept, mut total) = (0usize, 0u128);
        let (mut retained, mut residual) = (0usize, 0u128);
        for attempt in 0..SWEEP_ATTEMPTS {
            let tip = self
                .quantity("eth_maxPriorityFeePerGas", serde_json::json!([]))
                .await;
            let cap = self.base_fee().await + tip + SWEEP_TIP_MARGIN_WEI;
            let held_back = TRANSFER_GAS * cap;
            let results: Vec<(Payer, Result<Swept, String>)> =
                futures::stream::iter(left.into_iter().map(|account| async move {
                    let result = self
                        .sweep_one(&account, faucet, tip + attempt, cap, held_back)
                        .await;
                    (account, result)
                }))
                .buffer_unordered(SWEEP_IN_FLIGHT)
                .collect()
                .await;
            left = Vec::new();
            let mut last_error = None;
            for (account, result) in results {
                match result {
                    Ok(Swept::Returned {
                        value,
                        remaining,
                        disposable,
                    }) => {
                        swept += 1;
                        total += value;
                        if disposable {
                            KeyFiles::forget(&account);
                        } else if remaining > held_back {
                            left.push(account);
                        } else {
                            retained += 1;
                            residual += remaining;
                        }
                    }
                    Ok(Swept::Residual(value)) => {
                        retained += 1;
                        residual += value;
                    }
                    Ok(Swept::UnverifiedZero) => {
                        retained += 1;
                    }
                    Ok(Swept::UnpublishedPartial) => KeyFiles::forget(&account),
                    Err(error) => {
                        last_error = Some(error);
                        left.push(account);
                    }
                }
            }
            if left.is_empty() {
                break;
            }
            println!(
                "solonet: {} sweeps did not land ({}); again in a few blocks",
                left.len(),
                last_error.unwrap_or_default()
            );
            self.wait_blocks(4).await;
        }
        println!(
            "solonet: verified {total} wei returned in {swept} sweeps; {retained} original keys retained ({residual} wei observed residual, including unverified-zero custody){}",
            if left.is_empty() {
                String::new()
            } else {
                format!(
                    "; {} could not be swept and keep their key files in {} for the next run",
                    left.len(),
                    self.keys.dir.display()
                )
            }
        );
    }

    /// Sweep `account` once; `Err` when it still holds funds.
    async fn sweep_one(
        &self,
        account: &Payer,
        faucet: [u8; 20],
        tip: u128,
        cap: u128,
        held_back: u128,
    ) -> Result<Swept, String> {
        if !account.file.funding_readable {
            return Err("original funding claim unreadable; custody retained".into());
        }
        let signed_below = account.file.faucet_signed_below.load(Ordering::SeqCst);
        if signed_below > 0 && self.sweep_nonce(faucet, "latest").await? < signed_below {
            return Err("original faucet funding may still land; custody retained".into());
        }
        let balance = self
            .balance(account.address)
            .await
            .map_err(|e| e.to_string())?;
        let nonce = self.sweep_nonce(account.address, "latest").await?;
        if self.sweep_nonce(account.address, "pending").await? != nonce {
            return Err("account has ambiguous pending nonce; custody retained".into());
        }
        if balance == 0 {
            // A complete key can have exposed child funding not covered by .funding, or a
            // previous unverified sweep. Age/nonce consumption cannot prove either finished.
            return Ok(if account.file.partial && signed_below == 0 && nonce == 0 {
                // Partial key writes were never handed to a funder. Recheck before disposal.
                if self
                    .balance(account.address)
                    .await
                    .map_err(|e| e.to_string())?
                    != 0
                {
                    return Err("partial key balance changed; custody retained".into());
                }
                Swept::UnpublishedPartial
            } else {
                Swept::UnverifiedZero
            });
        }
        if balance <= held_back {
            return Ok(Swept::Residual(balance));
        }
        let value = balance - held_back;
        let (raw, hash) = sign_eip1559_tip(
            &account.key,
            SOLONET_CHAIN_ID,
            nonce,
            tip.min(cap),
            cap,
            TRANSFER_GAS as u64,
            faucet,
            value,
            &[],
        );
        let hash = format!("0x{}", hex::encode(hash));
        match self
            .try_call(
                "eth_sendRawTransaction",
                serde_json::json!([format!("0x{}", hex::encode(raw))]),
            )
            .await
        {
            Ok(answer) if answer.as_str() == Some(hash.as_str()) => {}
            Ok(_) => return Err("node returned a different sweep hash; custody retained".into()),
            Err(error) if error.nonce_held() || error.busy() => {}
            Err(error) => return Err(error.to_string()),
        }
        let started = Instant::now();
        while self.sweep_nonce(account.address, "latest").await? <= nonce {
            if started.elapsed() >= SWEEP_LAND_PATIENCE {
                return Err("sweep not mined within existing patience; custody retained".into());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // A used nonce alone may be a replacement or reverted transaction. Prove OUR return.
        let receipt = self.sweep_receipt(&hash, account.address, faucet).await?;
        let after = self
            .balance(account.address)
            .await
            .map_err(|e| e.to_string())?;
        let latest = self.sweep_nonce(account.address, "latest").await?;
        if latest != nonce.checked_add(1).ok_or("sweep nonce overflow")?
            || self.sweep_nonce(account.address, "pending").await? != latest
        {
            return Err("post-sweep nonce changed or ambiguous; custody retained".into());
        }
        let disposable = after == 0 && signed_below > 0;
        if disposable {
            // Missing markers cannot establish child funding completion. A recorded faucet
            // claim must still be consumed, and zero must be observed again, before disposal.
            if self.sweep_nonce(faucet, "latest").await? < signed_below
                || self
                    .balance(account.address)
                    .await
                    .map_err(|e| e.to_string())?
                    != 0
            {
                return Err("funding or balance changed before disposal; custody retained".into());
            }
        }
        if self.sweep_receipt(&hash, account.address, faucet).await? != receipt {
            return Err("sweep receipt changed during verification; custody retained".into());
        }
        Ok(Swept::Returned {
            value,
            remaining: after,
            disposable,
        })
    }

    /// Fallible, checked reads for custody decisions; malformed/unavailable is never zero.
    async fn sweep_nonce(&self, account: [u8; 20], tag: &str) -> Result<u64, String> {
        let value = self
            .try_call(
                "eth_getTransactionCount",
                serde_json::json!([format!("0x{}", hex::encode(account)), tag]),
            )
            .await
            .map_err(|e| e.to_string())?;
        let text = value
            .as_str()
            .and_then(|s| s.strip_prefix("0x"))
            .ok_or("malformed account nonce; custody retained")?;
        u64::from_str_radix(text, 16).map_err(|_| "invalid account nonce; custody retained".into())
    }

    /// Exact signed hash, successful native receipt and actual canonical block membership.
    /// Called again after state reads so a reorg/unavailable block cannot authorize deletion.
    async fn sweep_receipt(
        &self,
        hash: &str,
        from: [u8; 20],
        to: [u8; 20],
    ) -> Result<serde_json::Value, String> {
        let receipt = self
            .try_call("eth_getTransactionReceipt", serde_json::json!([hash]))
            .await
            .map_err(|e| e.to_string())?;
        let expected_from = format!("0x{}", hex::encode(from));
        let expected_to = format!("0x{}", hex::encode(to));
        let same = |field: &str, expected: &str| {
            receipt[field]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(expected))
        };
        if !same("transactionHash", hash)
            || !same("from", &expected_from)
            || !same("to", &expected_to)
            || receipt["status"] != "0x1"
        {
            return Err("own successful sweep receipt unavailable; custody retained".into());
        }
        let number = receipt["blockNumber"]
            .as_str()
            .filter(|s| s.starts_with("0x"))
            .ok_or("missing receipt block number")?;
        u64::from_str_radix(&number[2..], 16).map_err(|_| "invalid receipt block number")?;
        let block_hash = receipt["blockHash"]
            .as_str()
            .filter(|s| s.len() == 66 && s.starts_with("0x") && hex::decode(&s[2..]).is_ok())
            .ok_or("missing receipt block hash")?;
        let index = receipt["transactionIndex"]
            .as_str()
            .and_then(|s| s.strip_prefix("0x"))
            .and_then(|s| usize::from_str_radix(s, 16).ok())
            .ok_or("invalid receipt index")?;
        let block = self
            .try_call("eth_getBlockByNumber", serde_json::json!([number, false]))
            .await
            .map_err(|e| e.to_string())?;
        if block["number"] != number
            || !block["hash"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(block_hash))
            || !block["transactions"]
                .get(index)
                .and_then(|v| v.as_str())
                .is_some_and(|s| s.eq_ignore_ascii_case(hash))
        {
            return Err("sweep block membership is not canonical; custody retained".into());
        }
        Ok(receipt)
    }

    async fn latest_nonce(&self, account: [u8; 20]) -> u64 {
        self.quantity(
            "eth_getTransactionCount",
            serde_json::json!([format!("0x{}", hex::encode(account)), "latest"]),
        )
        .await as u64
    }

    async fn balance(&self, account: [u8; 20]) -> Result<u128, RpcError> {
        let value = self
            .try_call(
                "eth_getBalance",
                serde_json::json!([format!("0x{}", hex::encode(account)), "latest"]),
            )
            .await?;
        u128::from_str_radix(
            value.as_str().unwrap_or_default().trim_start_matches("0x"),
            16,
        )
        .map_err(|error| RpcError::Node(format!("eth_getBalance: {error}")))
    }

    /// The `payment` member of a write's body and its transaction hash: `payer`'s payment for
    /// `envelope` exactly as `policy` asks.
    pub fn payment(
        &self,
        payer: &Payer,
        policy: &WritePolicy,
        envelope: &GroupMessageEnvelope,
    ) -> (serde_json::Value, [u8; 32]) {
        let calldata = commitment_calldata(&policy.network, &policy.host_origin, envelope);
        self.payment_tx(
            payer,
            &policy.network,
            SOLONET_CHAIN_ID,
            policy.payee,
            policy.price_wei,
            &calldata,
        )
    }

    /// A `payment` member signed by `payer` at its nonce 0 with every field chosen by the
    /// caller, for the cases a relay must refuse; and its transaction hash.
    pub fn payment_tx(
        &self,
        payer: &Payer,
        network: &str,
        chain_id: u64,
        to: [u8; 20],
        value: u128,
        calldata: &[u8],
    ) -> (serde_json::Value, [u8; 32]) {
        let (raw, hash) = sign_eip1559(
            &payer.key,
            chain_id,
            0,
            self.max_fee,
            PAYMENT_GAS,
            to,
            value,
            calldata,
        );
        (
            serde_json::json!({"network": network, "raw_transaction": hex::encode(raw)}),
            hash,
        )
    }

    /// A relay checkpoint for this solonet run: a block a few behind the head and its hash.
    /// Not block 1: the node keeps only a few thousand blocks of history, so on a solonet that
    /// has run longer than that block 1 is gone and a relay could not verify it at startup.
    pub async fn checkpoint(&self) -> (u64, String) {
        let number = u64::try_from(self.block().await.saturating_sub(16).max(1)).unwrap();
        (number, self.block_hash(number).await)
    }

    /// Hash of block `number`, as a relay's `checkpoint_block_hash`.
    pub async fn block_hash(&self, number: u64) -> String {
        let block = self
            .call(
                "eth_getBlockByNumber",
                serde_json::json!([format!("0x{number:x}"), false]),
            )
            .await;
        block["hash"].as_str().unwrap().to_owned()
    }

    /// solonet's JSON-RPC URL, to hand a relay as its upstream.
    pub fn rpc_url(&self) -> &str {
        &self.rpc
    }

    /// Wait until the transaction `hash` has landed and succeeded on solonet.
    pub async fn wait_landed(&self, hash: &[u8; 32]) {
        self.wait_receipt(hash).await
    }
}

/// What one sweep round found for one account.
#[derive(Debug)]
enum Swept {
    /// Actual signed value returned, excluding gas; residual custody is a separate fact.
    Returned {
        value: u128,
        remaining: u128,
        disposable: bool,
    },
    Residual(u128),
    UnverifiedZero,
    UnpublishedPartial,
}

/// The calldata of a payment for `envelope` on the relay at `host_origin`.
pub fn commitment_calldata(
    network: &str,
    host_origin: &str,
    envelope: &GroupMessageEnvelope,
) -> Vec<u8> {
    let target = GroupWriteTarget {
        group_id: hex::decode(&envelope.group_id).unwrap().try_into().unwrap(),
        epoch: envelope.epoch,
        signing_digest: envelope.signing_digest().unwrap(),
    };
    group_write_calldata(&group_write_commitment(network, host_origin, &target)).to_vec()
}

/// Payers funded for one test. Dropping them, at the end of the test or while a failed test
/// unwinds, sweeps what they hold back to the faucet.
pub struct Funded {
    solonet: Solonet,
    payers: Vec<Payer>,
    /// The treasury and the probe of the funding: swept with the payers.
    helpers: Vec<Payer>,
    next: AtomicUsize,
}

impl Funded {
    /// The next payer nothing has used yet.
    pub fn take(&self) -> &Payer {
        let index = self.next.fetch_add(1, Ordering::SeqCst);
        self.payers
            .get(index)
            .expect("the test used more payers than it funded")
    }

    /// The solonet these payers are on.
    pub fn solonet(&self) -> &Solonet {
        &self.solonet
    }
}

impl Drop for Funded {
    fn drop(&mut self) {
        let solonet = self.solonet.clone();
        let mut payers = std::mem::take(&mut self.payers);
        payers.append(&mut self.helpers);
        // Drop cannot await, and may run on a runtime thread: sweep on a thread of its own.
        let swept = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(solonet.sweep(payers))
        })
        .join();
        if swept.is_err() {
            println!(
                "solonet: the sweep back to the faucet failed; the keys stay in {} and the next \
                 run sweeps them",
                self.solonet.keys.dir.display()
            );
        }
    }
}

/// `PUT /groups/:group_id/messages` body: `envelope` and its `payment`.
pub fn paid_body(envelope: &GroupMessageEnvelope, payment: &serde_json::Value) -> Vec<u8> {
    let mut body = serde_json::to_value(envelope).unwrap();
    body["payment"] = payment.clone();
    serde_json::to_vec(&body).unwrap()
}

/// A signed EIP-1559 transaction and its hash, tipping up to 2 gwei.
#[allow(clippy::too_many_arguments)]
fn sign_eip1559(
    key: &SecretKey,
    chain_id: u64,
    nonce: u64,
    max_fee: u128,
    gas: u64,
    to: [u8; 20],
    value: u128,
    data: &[u8],
) -> (Vec<u8>, [u8; 32]) {
    let priority = max_fee.min(2_000_000_000);
    sign_eip1559_tip(
        key, chain_id, nonce, priority, max_fee, gas, to, value, data,
    )
}

/// A signed EIP-1559 transaction tipping `priority` per gas, and its hash.
#[allow(clippy::too_many_arguments)]
fn sign_eip1559_tip(
    key: &SecretKey,
    chain_id: u64,
    nonce: u64,
    priority: u128,
    max_fee: u128,
    gas: u64,
    to: [u8; 20],
    value: u128,
    data: &[u8],
) -> (Vec<u8>, [u8; 32]) {
    let fields = |stream: &mut RlpStream| {
        stream.append(&chain_id);
        stream.append(&nonce);
        stream.append(&priority);
        stream.append(&max_fee);
        stream.append(&gas);
        stream.append(&to.as_slice());
        stream.append(&value);
        stream.append(&data);
        stream.begin_list(0);
    };
    let mut unsigned = RlpStream::new_list(9);
    fields(&mut unsigned);
    let digest = keccak(&[&[2u8], unsigned.out().as_ref()].concat());
    let signature = Secp256k1::new().sign_recoverable(&Message::from_slice(&digest).unwrap(), key);
    let (recovery, rs) = signature.serialize_compact();
    let mut signed = RlpStream::new_list(12);
    fields(&mut signed);
    signed.append(&(recovery.to_i32() as u64));
    signed.append(&trim(&rs[..32]));
    signed.append(&trim(&rs[32..]));
    let raw = [&[2u8], signed.out().as_ref()].concat();
    let hash = keccak(&raw);
    (raw, hash)
}

/// A big-endian integer without leading zero bytes, as RLP encodes `r` and `s`.
fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len());
    &bytes[start..]
}

#[cfg(test)]
mod custody_tests {
    use super::*;
    use axum::{extract::Extension, routing::post, Json, Router};
    use serde_json::{json, Value};
    use std::sync::Mutex;

    #[derive(Clone, Copy)]
    enum Receipt {
        Success,
        Missing,
        Reverted,
        Replaced,
        WrongBlock,
        Reorg,
        Pruned,
        WrongIndex,
    }
    struct Node {
        account: String,
        faucet: String,
        before: u128,
        after: u128,
        sent: usize,
        hash: String,
        faucet_nonce: u64,
        pending: bool,
        initial_nonce: u64,
        nonce_error: bool,
        balance_reads: usize,
        late_after_zero: bool,
        before_error: bool,
        after_error: bool,
        receipt: Receipt,
        reads: usize,
        head: u64,
    }
    async fn rpc(
        Extension(state): Extension<Arc<Mutex<Node>>>,
        Json(request): Json<Value>,
    ) -> Json<Value> {
        let mut n = state.lock().unwrap();
        let p = &request["params"];
        let value = match request["method"].as_str().unwrap() {
            "eth_getTransactionCount" if n.nonce_error => json!("unavailable"),
            "eth_getTransactionCount" => json!(format!(
                "0x{:x}",
                if p[0] == n.faucet {
                    n.faucet_nonce
                } else {
                    n.initial_nonce
                        + u64::from(n.sent > 0)
                        + u64::from(n.pending && p[1] == "pending")
                }
            )),
            "eth_getBalance" => {
                n.balance_reads += 1;
                if (n.sent == 0 && n.before_error) || (n.sent > 0 && n.after_error) {
                    return Json(
                        json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"balance unavailable"}}),
                    );
                }
                json!(format!(
                    "0x{:x}",
                    if n.late_after_zero && n.balance_reads > 2 {
                        105_000
                    } else if n.sent == 0 {
                        n.before
                    } else {
                        n.after
                    }
                ))
            }
            "eth_blockNumber" => {
                n.head += 10;
                json!(format!("0x{:x}", n.head))
            }
            "eth_maxPriorityFeePerGas" => json!("0x1"),
            "eth_getBlockByNumber" => {
                if p[0] == "latest" {
                    json!({"baseFeePerGas":"0x1"})
                } else if matches!(n.receipt, Receipt::Pruned) {
                    Value::Null
                } else {
                    n.reads += 1;
                    let changed = matches!(n.receipt, Receipt::Reorg) && n.reads > 1;
                    json!({"number":"0x7","hash":format!("0x{}", if changed {"22"} else {"11"}.repeat(32)),"transactions":[n.hash]})
                }
            }
            "eth_sendRawTransaction" => {
                let raw = hex::decode(p[0].as_str().unwrap().trim_start_matches("0x")).unwrap();
                n.hash = format!("0x{}", hex::encode(keccak(&raw)));
                n.sent += 1;
                json!(n.hash)
            }
            "eth_getTransactionReceipt" => {
                if matches!(n.receipt, Receipt::Missing) {
                    Value::Null
                } else {
                    json!({"transactionHash": if matches!(n.receipt, Receipt::Replaced) {format!("0x{}", "99".repeat(32))} else {n.hash.clone()},
                        "from":n.account,"to":n.faucet,"status":if matches!(n.receipt, Receipt::Reverted) {"0x0"} else {"0x1"},
                        "blockNumber":"0x7","transactionIndex":if matches!(n.receipt,Receipt::WrongIndex) {"0x1"} else {"0x0"},"blockHash":format!("0x{}", if matches!(n.receipt, Receipt::WrongBlock) {"22"} else {"11"}.repeat(32))})
                }
            }
            _ => {
                return Json(
                    json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"unsupported synthetic method"}}),
                )
            }
        };
        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":value}))
    }
    struct Rig {
        _temp: tempfile::TempDir,
        server: tokio::task::JoinHandle<()>,
        node: Arc<Mutex<Node>>,
        chain: Solonet,
        payer: Payer,
    }
    impl Rig {
        async fn new(before: u128, after: u128, funding: bool) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let dir = temp.path().join("synthetic-run");
            std::fs::create_dir(&dir).unwrap();
            let keys = Arc::new(KeyFiles {
                root: temp.path().to_owned(),
                dir,
            });
            let payer = keys.fresh();
            if funding {
                keys.note_faucet_signing(&payer, 9);
            }
            // Synthetic signer, never the lab genesis faucet or any original custody.
            let faucet = SecretKey::from_slice(&[9; 32]).unwrap();
            let node = Arc::new(Mutex::new(Node {
                account: format!("0x{}", hex::encode(payer.address)),
                faucet: format!("0x{}", hex::encode(address(&faucet))),
                before,
                after,
                sent: 0,
                hash: String::new(),
                faucet_nonce: 10,
                pending: false,
                initial_nonce: 1,
                nonce_error: false,
                balance_reads: 0,
                late_after_zero: false,
                before_error: false,
                after_error: false,
                receipt: Receipt::Success,
                reads: 0,
                head: 10,
            }));
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let rpc_url = format!("http://{}", listener.local_addr().unwrap());
            let app = Router::new()
                .route("/", post(rpc))
                .layer(Extension(node.clone()));
            let server = tokio::spawn(async move {
                axum::Server::from_tcp(listener)
                    .unwrap()
                    .serve(app.into_make_service())
                    .await
                    .unwrap();
            });
            let chain = Solonet {
                rpc: rpc_url,
                http: reqwest::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap(),
                faucet,
                max_fee: 7,
                keys,
            };
            Self {
                _temp: temp,
                server,
                node,
                chain,
                payer,
            }
        }
        fn retained(&self) {
            assert!(
                self.payer.file.path.exists(),
                "original synthetic key must remain"
            );
            assert!(
                self.payer.file.funding.exists(),
                "original funding claim must remain"
            );
            let saved = KeyFiles::saved(&self.chain.keys.dir);
            assert_eq!(saved.len(), 1);
            assert_eq!(saved[0].address, self.payer.address);
        }
        async fn sweep(&self) {
            self.chain.sweep(vec![self.payer.clone()]).await;
        }
    }
    impl Drop for Rig {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    #[tokio::test]
    async fn residual_before_send_retains_original_files_without_dust_loop() {
        for balance in [1, 105_000, 147_000] {
            let rig = Rig::new(balance, balance, true).await;
            rig.sweep().await;
            rig.retained();
            assert_eq!(rig.node.lock().unwrap().sent, 0);
        }
    }
    #[tokio::test]
    async fn landed_return_retains_105000_wei_and_restart_discovers_key() {
        let rig = Rig::new(1_000_000, 105_000, true).await;
        rig.sweep().await;
        rig.retained();
        assert_eq!(rig.node.lock().unwrap().sent, 1);
        rig.chain.sweep(KeyFiles::saved(&rig.chain.keys.dir)).await;
        rig.retained();
        assert_eq!(rig.node.lock().unwrap().sent, 1);
    }
    #[tokio::test]
    async fn verified_zero_after_own_return_and_completed_funding_allows_disposal() {
        let rig = Rig::new(1_000_000, 0, true).await;
        rig.sweep().await;
        assert!(!rig.payer.file.path.exists());
        assert!(!rig.payer.file.funding.exists());
    }
    #[tokio::test]
    async fn zero_without_own_verified_return_is_retained_across_restart() {
        let rig = Rig::new(0, 0, true).await;
        rig.sweep().await;
        rig.retained();
        rig.chain.sweep(KeyFiles::saved(&rig.chain.keys.dir)).await;
        rig.retained();
    }
    #[tokio::test]
    async fn unreadable_balance_before_or_after_send_retains_custody() {
        for after in [false, true] {
            let rig = Rig::new(1_000_000, 0, true).await;
            {
                let mut n = rig.node.lock().unwrap();
                n.before_error = !after;
                n.after_error = after;
            }
            rig.sweep().await;
            rig.retained();
        }
    }
    #[tokio::test]
    async fn missing_failed_replaced_or_noncanonical_receipt_retains_custody_on_restart() {
        for receipt in [
            Receipt::Missing,
            Receipt::Reverted,
            Receipt::Replaced,
            Receipt::WrongBlock,
            Receipt::Reorg,
            Receipt::Pruned,
            Receipt::WrongIndex,
        ] {
            let rig = Rig::new(1_000_000, 0, true).await;
            rig.node.lock().unwrap().receipt = receipt;
            rig.sweep().await;
            rig.retained();
            rig.chain.sweep(KeyFiles::saved(&rig.chain.keys.dir)).await;
            rig.retained();
        }
    }
    #[tokio::test]
    async fn late_faucet_funding_keeps_original_zero_balance_key() {
        let rig = Rig::new(0, 0, true).await;
        rig.node.lock().unwrap().faucet_nonce = 9;
        rig.sweep().await;
        rig.retained();
        assert_eq!(rig.node.lock().unwrap().sent, 0);
    }
    #[tokio::test]
    async fn corrupt_funding_claim_is_unknown_instead_of_no_funding() {
        let rig = Rig::new(0, 0, true).await;
        std::fs::write(&rig.payer.file.funding, "interrupted-claim").unwrap();
        rig.chain.sweep(KeyFiles::saved(&rig.chain.keys.dir)).await;
        rig.retained();
    }
    #[tokio::test]
    async fn returned_value_excludes_gas_and_retained_residual_is_separate() {
        let rig = Rig::new(1_000_000, 105_000, true).await;
        let result = rig
            .chain
            .sweep_one(&rig.payer, address(&rig.chain.faucet), 1, 7, 147_000)
            .await
            .unwrap();
        assert!(matches!(
            result,
            Swept::Returned {
                value: 853_000,
                remaining: 105_000,
                disposable: false
            }
        ));
        rig.retained();
    }
    #[tokio::test]
    async fn pending_nonce_or_missing_child_funding_proof_never_disposes_zero() {
        let rig = Rig::new(0, 0, false).await;
        assert!(matches!(
            rig.chain
                .sweep_one(&rig.payer, address(&rig.chain.faucet), 1, 7, 147_000)
                .await
                .unwrap(),
            Swept::UnverifiedZero
        ));
        assert!(rig.payer.file.path.exists());
        rig.node.lock().unwrap().pending = true;
        assert!(rig
            .chain
            .sweep_one(&rig.payer, address(&rig.chain.faucet), 1, 7, 147_000)
            .await
            .is_err());
        assert!(rig.payer.file.path.exists());
    }
    #[tokio::test]
    async fn unpublished_partial_requires_verified_zero_and_no_claim() {
        let mut rig = Rig::new(1, 1, false).await;
        Arc::get_mut(&mut rig.payer.file).unwrap().partial = true;
        rig.sweep().await;
        assert!(rig.payer.file.path.exists());
        {
            let mut n = rig.node.lock().unwrap();
            n.before = 0;
            n.pending = true;
        }
        assert!(rig
            .chain
            .sweep_one(&rig.payer, address(&rig.chain.faucet), 1, 7, 147_000)
            .await
            .is_err());
        rig.node.lock().unwrap().pending = false;
        // The fixture's nonce is 1, so even this partial cannot prove it was unpublished.
        assert!(matches!(
            rig.chain
                .sweep_one(&rig.payer, address(&rig.chain.faucet), 1, 7, 147_000)
                .await
                .unwrap(),
            Swept::UnverifiedZero
        ));
        rig.node.lock().unwrap().initial_nonce = 0;
        rig.sweep().await;
        assert!(!rig.payer.file.path.exists());
    }
    #[tokio::test]
    async fn unknown_nonce_and_late_balance_recheck_never_dispose() {
        let rig = Rig::new(1_000_000, 0, true).await;
        rig.node.lock().unwrap().nonce_error = true;
        rig.sweep().await;
        rig.retained();
        assert_eq!(rig.node.lock().unwrap().sent, 0);
        {
            let mut n = rig.node.lock().unwrap();
            n.nonce_error = false;
            n.late_after_zero = true;
            n.balance_reads = 0;
        }
        rig.sweep().await;
        rig.retained();
    }
    #[tokio::test]
    async fn orphan_claim_and_failed_key_removal_preserve_funding_record() {
        let rig = Rig::new(0, 0, true).await;
        std::fs::remove_file(&rig.payer.file.path).unwrap();
        KeyFiles::remove_if_done(&rig.chain.keys.dir);
        assert!(rig.payer.file.funding.exists());
        // A directory cannot be removed as a key file: its claim must survive that failure.
        std::fs::create_dir(&rig.payer.file.path).unwrap();
        KeyFiles::forget(&rig.payer);
        assert!(rig.payer.file.funding.exists());
    }

    /// This is an operator-only claim, not a replacement for the lab lease. All old owners
    /// must be externally confirmed dead and the namespace quiescent before acquisition.
    struct PinnedRun {
        claim: PathBuf,
    }
    impl Drop for PinnedRun {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.claim);
        }
    }
    fn pin_run(
        root: &std::path::Path,
        run: &std::path::Path,
        owner: u32,
        modified_ns: u128,
    ) -> Result<PinnedRun, &'static str> {
        let canonical =
            |p: &std::path::Path| p.is_absolute() && p.canonicalize().ok().as_deref() == Some(p);
        if !canonical(root)
            || !canonical(run)
            || run.parent() != Some(root)
            || !run
                .file_name()
                .is_some_and(|s| s.to_string_lossy().starts_with("run-"))
        {
            return Err("operator requires an exact canonical absolute direct-child run path");
        }
        let lock = run.join(".lock");
        let check = || -> Result<(), &'static str> {
            let metadata =
                std::fs::symlink_metadata(&lock).map_err(|_| "original owner lock unavailable")?;
            if !metadata.file_type().is_file() {
                return Err("original owner lock is not a regular file");
            }
            let modified = metadata
                .modified()
                .map_err(|_| "original owner lock timestamp unavailable")?;
            if modified
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "invalid original lock timestamp")?
                .as_nanos()
                != modified_ns
                || modified
                    .elapsed()
                    .map_err(|_| "future original lock timestamp")?
                    <= RUN_LOCK_STALE
            {
                return Err("original owner lock is active or changed");
            }
            if std::fs::read_to_string(&lock)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
                != Some(owner)
            {
                return Err("original owner lock identity is ambiguous or changed");
            }
            Ok(())
        };
        for entry in std::fs::read_dir(run).map_err(|_| "original run directory unavailable")? {
            if entry
                .map_err(|_| "original run entry unavailable")?
                .file_type()
                .map_err(|_| "original run entry type unavailable")?
                .is_symlink()
            {
                return Err("original run contains a symlink; explicit custody review required");
            }
        }
        check()?;
        let claim = run.join(".sweep-operator");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options
            .open(&claim)
            .map_err(|_| "operator claim exists or cannot be acquired; no automatic takeover")?;
        let pinned = PinnedRun { claim };
        use std::io::Write;
        (&file)
            .write_all(std::process::id().to_string().as_bytes())
            .map_err(|_| "cannot write operator claim")?;
        file.sync_all().map_err(|_| "cannot sync operator claim")?;
        check()?;
        Ok(pinned)
    }
    fn old_lock(dir: &std::path::Path) -> u128 {
        let lock = dir.join(".lock");
        std::fs::write(&lock, "12345").unwrap();
        let time = std::time::SystemTime::now() - Duration::from_secs(120);
        std::fs::File::options()
            .write(true)
            .open(lock)
            .unwrap()
            .set_modified(time)
            .unwrap();
        time.duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
    #[test]
    fn operator_rejects_active_changed_ambiguous_and_sibling_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let run = root.join("run-original");
        std::fs::create_dir(&run).unwrap();
        let ns = old_lock(&run);
        assert!(pin_run(&root, &run, 99, ns).is_err());
        assert!(pin_run(&root, &run, 12345, ns + 1).is_err());
        assert!(pin_run(&run, &run, 12345, ns).is_err());
        std::fs::write(run.join(".lock"), "12345").unwrap();
        assert!(pin_run(&root, &run, 12345, ns).is_err());
        std::fs::remove_file(run.join(".lock")).unwrap();
        assert!(pin_run(&root, &run, 12345, ns).is_err());
        assert!(!run.join(".sweep-operator").exists());
        let ns = old_lock(&run);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("outside.key"), run.join("unexpected.key"))
                .unwrap();
            assert!(pin_run(&root, &run, 12345, ns).is_err());
        }
    }
    #[tokio::test]
    async fn operator_claim_keeps_exact_original_paths_and_siblings_untouched() {
        let rig = Rig::new(105_000, 105_000, true).await;
        let root = rig.chain.keys.root.canonicalize().unwrap();
        let original = root.join("run-original");
        // Only synthetic setup moves a fixture BEFORE acquisition; the operator never moves it.
        std::fs::rename(&rig.chain.keys.dir, &original).unwrap();
        let ns = old_lock(&original);
        let sibling = root.join("run-sibling");
        std::fs::create_dir(&sibling).unwrap();
        std::fs::write(sibling.join("sentinel"), "untouched").unwrap();
        let pinned = pin_run(&root, &original, 12345, ns).unwrap();
        assert!(pin_run(&root, &original, 12345, ns).is_err());
        let original_key = original.join(rig.payer.file.path.file_name().unwrap());
        rig.chain.sweep(KeyFiles::saved(&original)).await;
        assert!(original_key.exists());
        assert_eq!(KeyFiles::saved(&original).len(), 1);
        assert_eq!(
            std::fs::read_to_string(sibling.join("sentinel")).unwrap(),
            "untouched"
        );
        assert_eq!(
            std::fs::metadata(original.join(".lock"))
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            ns
        );
        assert_eq!(rig.node.lock().unwrap().sent, 0);
        drop(pinned);
        assert!(!original.join(".sweep-operator").exists());
        std::fs::write(original.join(".sweep-operator"), "interrupted").unwrap();
        assert!(pin_run(&root, &original, 12345, ns).is_err());
    }

    /// Never run during CI/ordinary tests. Root must separately approve the exact command,
    /// verify old PID/container death (paused is insufficient) and quiesce ALL old helpers.
    /// No from_env, stale takeover, renaming, key generation, provisioning or funding occurs.
    #[tokio::test]
    #[ignore = "explicit root-approved original-run sweep only; requires externally verified owner death"]
    async fn operator_sweep_pinned_original_run() {
        let env = |name| std::env::var(name).expect("missing explicit operator argument");
        assert_eq!(
            env("FRANK_LAB_SWEEP_OWNER_STATE"),
            "owner-dead-and-namespace-quiescent",
            "external owner death and namespace quiescence are mandatory"
        );
        let root = PathBuf::from(env("FRANK_LAB_SWEEP_ROOT"));
        let run = PathBuf::from(env("FRANK_LAB_SWEEP_RUN"));
        let owner = env("FRANK_LAB_SWEEP_OWNER_PID")
            .parse()
            .expect("invalid pinned owner PID");
        let ns = env("FRANK_LAB_SWEEP_LOCK_MTIME_NS")
            .parse()
            .expect("invalid pinned lock timestamp");
        let _pin =
            pin_run(&root, &run, owner, ns).expect("original run ownership validation failed");
        let rpc = env("FRANK_LAB_SOLONET_RPC_URL");
        let url = reqwest::Url::parse(&rpc).expect("invalid operator RPC URL");
        assert!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "operator RPC URL must not carry credentials or query data"
        );
        let chain = Solonet {
            rpc,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            faucet: SecretKey::from_slice(&hex::decode(FAUCET_KEY).unwrap()).unwrap(),
            max_fee: 0,
            keys: Arc::new(KeyFiles {
                root,
                dir: run.clone(),
            }),
        };
        let id = chain
            .try_call("eth_chainId", serde_json::json!([]))
            .await
            .map_err(|_| "operator chain identity RPC failed")
            .unwrap();
        assert_eq!(
            id,
            serde_json::json!(format!("0x{:x}", SOLONET_CHAIN_ID)),
            "operator RPC is not configured solonet"
        );
        chain.sweep(KeyFiles::saved(&run)).await;
    }
}
