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
    ) -> Result<serde_json::Value, String> {
        let body =
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let answer: serde_json::Value = self
            .http
            .post(&self.rpc)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|error| format!("{method} on {}: {error}", self.rpc))?
            .bytes()
            .await
            .map_err(|error| format!("{method} on {}: {error}", self.rpc))
            .and_then(|bytes| {
                serde_json::from_slice(&bytes).map_err(|error| format!("{method}: {error}"))
            })?;
        match answer.get("error") {
            Some(error) => Err(format!("{method}: {error}")),
            None => Ok(answer["result"].clone()),
        }
    }

    async fn call(&self, method: &str, params: serde_json::Value) -> serde_json::Value {
        self.try_call(method, params)
            .await
            .unwrap_or_else(|error| panic!("{error}"))
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

    async fn wait_receipt(&self, hash: &[u8; 32]) {
        let deadline = Instant::now() + Duration::from_secs(120);
        let hash = format!("0x{}", hex::encode(hash));
        loop {
            let receipt = self
                .call("eth_getTransactionReceipt", serde_json::json!([hash]))
                .await;
            if !receipt.is_null() {
                assert_eq!(receipt["status"], "0x1", "transaction {hash} failed");
                return;
            }
            assert!(Instant::now() < deadline, "transaction {hash} never landed");
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

    /// Send `value` from `from` to `to` at `from`'s next nonce; the transaction hash.
    async fn transfer(&self, from: &SecretKey, nonce: u64, to: [u8; 20], value: u128) -> [u8; 32] {
        let (raw, hash) = sign_eip1559(
            from,
            SOLONET_CHAIN_ID,
            nonce,
            self.max_fee,
            21_000,
            to,
            value,
            &[],
        );
        self.call(
            "eth_sendRawTransaction",
            serde_json::json!([format!("0x{}", hex::encode(raw))]),
        )
        .await;
        hash
    }

    /// `count` fresh accounts, each funded for one payment. The faucet is shared with whatever
    /// else runs on solonet, so it pays once, into a fresh account of this call, which then
    /// funds the payers at nonces nothing else uses. Waits until the funding is a few blocks
    /// deep: Monad checks a new transaction against state a few blocks behind the head, and
    /// keeps turning down bytes it once turned down.
    pub async fn fund(&self, count: usize) -> Funded {
        let payers: Vec<Payer> = (0..count).map(|_| Payer::fresh()).collect();
        let treasury = Payer::fresh();
        // Monad holds back a reserve of each sender's balance for gas of transactions still in
        // flight; keeping the treasury above it lets a batch go out without spacing.
        let need =
            count as u128 * (PAYER_FUNDING_WEI + 21_000 * self.max_fee) + TREASURY_RESERVE_WEI;
        let faucet = address(&self.faucet);
        let mut attempt = 0;
        let funded = loop {
            // Another faucet user can take the nonce between the read and the send.
            let nonce = self.pending_nonce(faucet).await;
            let (raw, hash) = sign_eip1559(
                &self.faucet,
                SOLONET_CHAIN_ID,
                nonce,
                self.max_fee,
                21_000,
                treasury.address,
                need,
                &[],
            );
            match self
                .try_call(
                    "eth_sendRawTransaction",
                    serde_json::json!([format!("0x{}", hex::encode(raw))]),
                )
                .await
            {
                Ok(_) => break hash,
                Err(error) if attempt < 10 => {
                    attempt += 1;
                    println!("solonet: faucet send at nonce {nonce} refused ({error}); again");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(error) => panic!("the solonet faucet would not pay: {error}"),
            }
        };
        self.wait_receipt(&funded).await;
        self.wait_blocks(6).await;
        let mut nonce = 0;
        for batch in payers.chunks(FUNDING_BATCH) {
            let mut last = [0; 32];
            for payer in batch {
                last = self
                    .transfer(&treasury.key, nonce, payer.address, PAYER_FUNDING_WEI)
                    .await;
                nonce += 1;
            }
            self.wait_receipt(&last).await;
        }
        self.wait_blocks(6).await;
        println!("solonet: funded {count} payers");
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
            let results: Vec<(Payer, Result<Option<u128>, String>)> =
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
                last_error.unwrap_or_default()
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

    async fn balance(&self, account: [u8; 20]) -> Result<u128, String> {
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
        .map_err(|error| format!("eth_getBalance: {error}"))
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
