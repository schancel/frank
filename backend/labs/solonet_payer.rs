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
#![allow(dead_code)]

use std::{
    sync::atomic::{AtomicUsize, Ordering},
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
}

impl Payer {
    fn fresh() -> Self {
        let key = SecretKey::from_slice(&rand::random::<[u8; 32]>()).unwrap();
        let address = address(&key);
        Payer { key, address }
    }
}

/// A write policy as `GET /groups/:group_id/write-policy` reports it.
#[derive(Clone, Debug)]
pub struct WritePolicy {
    pub network: String,
    pub price_wei: u128,
    pub host_origin: String,
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
    let payee = body["payee"]["address"]
        .as_str()
        .expect("the lab pays an address or the burn address, not an xpub");
    WritePolicy {
        network: body["network"].as_str().unwrap().to_owned(),
        price_wei: body["price_wei"].as_str().unwrap().parse().unwrap(),
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
}

impl Solonet {
    /// solonet at `FRANK_LAB_SOLONET_RPC_URL`; fails with what to do when it is not set.
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
        solonet
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
            // A send whose answer was lost may still have reached the pool.
            if self.pending_nonce(from.address).await > nonce {
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
    /// superseded payment is signed again at the faucet's next nonce.
    async fn fund_treasury(&self, treasury: &Payer, need: u128) {
        let faucet = address(&self.faucet);
        let started = Instant::now();
        for attempt in 0u128.. {
            let nonce = self.pending_nonce(faucet).await;
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
            let sent = self
                .try_call(
                    "eth_sendRawTransaction",
                    serde_json::json!([format!("0x{}", hex::encode(raw))]),
                )
                .await;
            let outcome = match sent {
                // The answer may be lost on a transaction that did reach the pool.
                Ok(_) | Err(RpcError::Transport(_)) => {
                    self.landed_or_superseded(&hash, faucet, nonce).await
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

    /// Wait until `hash`, sent by `sender` at `nonce`, has landed and succeeded (`Ok`), or
    /// another transaction of `sender` has taken that nonce (`Err`).
    async fn landed_or_superseded(
        &self,
        hash: &[u8; 32],
        sender: [u8; 20],
        nonce: u64,
    ) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(receipt) = self.receipt(hash).await {
                assert_eq!(
                    receipt["status"],
                    "0x1",
                    "transaction 0x{} failed",
                    hex::encode(hash)
                );
                return Ok(());
            }
            if self.latest_nonce(sender).await > nonce {
                // The nonce is used; the receipt is read again in case it was ours after all.
                tokio::time::sleep(Duration::from_millis(500)).await;
                if self.receipt(hash).await.is_some() {
                    continue;
                }
                return Err("another transaction took the nonce".into());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "0x{} not mined within 120 s (pending nonce {})",
                    hex::encode(hash),
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
    pub async fn fund(&self, count: usize) -> Funded {
        let started = Instant::now();
        let payers: Vec<Payer> = (0..count).map(|_| Payer::fresh()).collect();
        let treasury = Payer::fresh();
        let probe = Payer::fresh();
        // Every transfer's value and its gas at the fee cap, the probe's included, and a margin
        // that keeps the treasury above Monad's 10 MON reserve: the node budgets the gas of a
        // sender's transactions in flight against `min(10 MON, balance)`, and a transfer that
        // took the treasury below the reserve while others are in flight would be reverted.
        let need = (count as u128 + 1) * (PAYER_FUNDING_WEI + 21_000 * self.max_fee)
            + TREASURY_RESERVE_WEI;
        self.fund_treasury(&treasury, need).await;
        // A new account is usually admitted four blocks after its funding; send_funding retries
        // the ones that take longer.
        self.wait_blocks(4).await;
        let recipients: Vec<[u8; 20]> = payers
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
        let unfunded: Vec<String> = futures::stream::iter(payers.iter().map(|payer| async move {
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
        // The probe pays back what it holds: admitted only once the node sees it funded.
        let gas = 21_000 * self.max_fee;
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
        Funded {
            solonet: self.clone(),
            payers,
            next: AtomicUsize::new(0),
        }
    }

    /// Send what each of `accounts` holds, less the transfer's gas, back to the faucet, so
    /// test funds come back. Waits for each account's own transactions to land first (a
    /// payment a relay broadcast may still be pending), then lets them settle a few blocks:
    /// Monad lets an account spend below its reserve only some blocks after its last
    /// transaction. An account holding less than twice the transfer's gas is left alone.
    pub async fn sweep(&self, accounts: Vec<Payer>) {
        let faucet = address(&self.faucet);
        let gas = 21_000 * self.max_fee;
        let deadline = Instant::now() + Duration::from_secs(120);
        futures::stream::iter(accounts.iter().map(|account| async move {
            while self.pending_nonce(account.address).await
                > self.latest_nonce(account.address).await
                && Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }))
        .buffer_unordered(SWEEP_IN_FLIGHT)
        .collect::<Vec<()>>()
        .await;
        self.wait_blocks(6).await;
        let mut left = accounts;
        let (mut swept, mut total) = (0usize, 0u128);
        for attempt in 0..3u128 {
            let results: Vec<(Payer, Result<Option<u128>, RpcError>)> =
                futures::stream::iter(left.into_iter().map(|account| async move {
                    let result = async {
                        let balance = self.balance(account.address).await?;
                        if balance < 2 * gas {
                            return Ok(None);
                        }
                        // A retry sends other bytes: Monad keeps turning down bytes it once
                        // turned down.
                        let value = balance - gas - attempt;
                        let nonce = self.latest_nonce(account.address).await;
                        let (raw, _) = sign_eip1559(
                            &account.key,
                            SOLONET_CHAIN_ID,
                            nonce,
                            self.max_fee,
                            21_000,
                            faucet,
                            value,
                            &[],
                        );
                        self.try_call(
                            "eth_sendRawTransaction",
                            serde_json::json!([format!("0x{}", hex::encode(raw))]),
                        )
                        .await?;
                        Ok(Some(value))
                    }
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
                    Ok(Some(value)) => {
                        swept += 1;
                        total += value;
                    }
                    Ok(None) => {}
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
                "solonet: {} sweeps refused ({}); again in a few blocks",
                left.len(),
                last_error
                    .map(|error| error.to_string())
                    .unwrap_or_default()
            );
            self.wait_blocks(4).await;
        }
        println!(
            "solonet: swept {total} wei from {swept} accounts back to the faucet{}",
            if left.is_empty() {
                String::new()
            } else {
                format!("; {} could not be swept", left.len())
            }
        );
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
        let payers = std::mem::take(&mut self.payers);
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
            println!("solonet: the sweep back to the faucet failed");
        }
    }
}

/// `PUT /groups/:group_id/messages` body: `envelope` and its `payment`.
pub fn paid_body(envelope: &GroupMessageEnvelope, payment: &serde_json::Value) -> Vec<u8> {
    let mut body = serde_json::to_value(envelope).unwrap();
    body["payment"] = payment.clone();
    serde_json::to_vec(&body).unwrap()
}

/// A signed EIP-1559 transaction and its hash.
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
