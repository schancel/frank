import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";
import * as bip39 from "bip39";

import { createSolanaChain, SolanaChainConfig } from "./solana-chain";
import { SolanaWalletConnection, SolanaWallet } from "../solana-wallet";
import { ChainUtxoPool } from "../chain-utxo-pool";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";

const base58Decoder = getBase58Decoder();
const blockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

class MockSolanaConnection implements SolanaWalletConnection {
  balance = 1_000_000_000n; // 1 SOL
  sentRaw: Uint8Array[] = [];
  genesisHash = "solana-test-genesis";
  getBalanceCalls = 0;

  async getGenesisHash(): Promise<string> {
    return this.genesisHash;
  }

  async getSignatureStatus(signature: string) {
    return {
      value: {
        err: null,
        confirmationStatus: "confirmed" as const,
      },
    };
  }

  async getBalance(address: PublicKey): Promise<bigint> {
    this.getBalanceCalls++;
    return this.balance;
  }

  async getLatestBlockhash() {
    return {
      blockhash,
      lastValidBlockHeight: 100n,
    };
  }

  async sendRawTransaction(rawTransaction: Uint8Array): Promise<string> {
    this.sentRaw.push(rawTransaction);
    try {
      return base58Decoder.decode(
        VersionedTransaction.deserialize(rawTransaction).signatures[0]
      );
    } catch {
      if (rawTransaction.length >= 65) {
        return base58Decoder.decode(rawTransaction.subarray(1, 65));
      }
    }
    return "5mockSignature" + Math.random().toString(36).slice(2);
  }
}

describe("solana-chain", () => {
  const testMnemonic = bip39.generateMnemonic();
  let connection: MockSolanaConnection;
  let primaryKeypair: Keypair;
  let config: SolanaChainConfig;

  beforeEach(async () => {
    connection = new MockSolanaConnection();
    primaryKeypair = await Keypair.generate();
    config = {
      networkId: "solana-devnet",
      genesisHash: "solana-test-genesis",
      connection,
      deriveSigner: () => primaryKeypair,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    };
  });

  describe("chain properties", () => {
    it("reports correct metadata and unit", () => {
      const chain = createSolanaChain(config);
      expect(chain.family).toBe("solana");
      expect(chain.name).toBe("Solana Testnet");
      expect(chain.unit).toBe("tSOL");
      expect(chain.isTestnet).toBe(true);
      expect(chain.capabilities.legacyConsolidation).toBe("solana-bundle");
    });

    it("parses and formats addresses correctly", () => {
      const chain = createSolanaChain(config);
      const raw = primaryKeypair.publicKey.toBase58();
      const parsed = chain.parseAddress(raw);
      expect(parsed?.raw).toBe(raw);
      expect(chain.parseAddress("invalid-address")).toBeUndefined();
    });
  });

  describe("sendLegacy", () => {
    it("executes single-input legacy transfer when chainUtxoPool is not present", async () => {
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      const onProgress = jest.fn();
      const onSigned = jest.fn().mockResolvedValue(undefined);

      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 100_000_000n, // 0.1 SOL
        onProgress,
        onSigned,
      });

      expect(result.totalValueSent).toBe(100_000_000n);
      expect(result.totalFeePaid).toBe(5000n);
      expect(result.txHash).toBeDefined();
      expect(connection.sentRaw.length).toBe(1);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "broadcasting" } })
      );
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "confirmed", txHash: result.txHash } })
      );
    });

    it("executes atomic multi-input legacy transfer when chainUtxoPool is present and multiple coins are selected", async () => {
      const pool = new ChainUtxoPool();
      const solanaKp1 = await Keypair.generate();
      const solanaKp2 = await Keypair.generate();

      // Register two UTXOs in the pool
      const coin1 = pool.solana.registerDerivedAccount({
        chain: "solana",
        address: solanaKp1.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp1.secretKey).toString("hex"),
        balanceWei: 300_000_000n, // 0.3 SOL
      });
      const coin2 = pool.solana.registerDerivedAccount({
        chain: "solana",
        address: solanaKp2.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp2.secretKey).toString("hex"),
        balanceWei: 400_000_000n, // 0.4 SOL
      });

      config.chainUtxoPool = pool;
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      // Set primary balance low so it must consolidate from pool
      connection.balance = 50_000n;

      const onProgress = jest.fn();
      const onSigned = jest.fn().mockResolvedValue(undefined);

      // Target 600,000,000 lamports (0.6 SOL) which requires coin1 + coin2
      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 600_000_000n,
        onProgress,
        onSigned,
      });

      expect(result.totalValueSent).toBe(600_000_000n);
      expect(result.totalFeePaid).toBe(5000n);
      expect(result.inputCount).toBe(2);
      expect(result.txHash).toBeDefined();
      expect(connection.sentRaw.length).toBe(1);

      // Verify onSigned received the transaction hash before broadcast
      expect(onSigned).toHaveBeenCalledTimes(1);
      expect(onSigned).toHaveBeenCalledWith({ txHash: result.txHash });

      // Verify progress notifications
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "broadcasting" } })
      );
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "confirmed", txHash: result.txHash } })
      );

      // Verify input coins are marked spent in the pool
      expect(pool.getCoin(coin1.id)?.status).toBe("spent");
      expect(pool.getCoin(coin2.id)?.status).toBe("spent");
    });

    it("executes multi-input transfer when target amount exceeds primary account balance", async () => {
      const pool = new ChainUtxoPool();
      const subKp = await Keypair.generate();

      const subCoin = pool.solana.registerDerivedAccount({
        chain: "solana",
        address: subKp.publicKey.toBase58(),
        privateKey: Buffer.from(subKp.secretKey).toString("hex"),
        balanceWei: 500_000_000n,
      });

      config.chainUtxoPool = pool;
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      // Primary account has 0 balance, target is 200,000,000 lamports
      connection.balance = 0n;

      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 200_000_000n,
      });

      expect(result.totalValueSent).toBe(200_000_000n);
      expect(result.txHash).toBeDefined();
      expect(pool.getCoin(subCoin.id)?.status).toBe("spent");
    });

    it("estimates legacy fees correctly when chainUtxoPool is attached", async () => {
      const pool = new ChainUtxoPool();
      const kp1 = await Keypair.generate();
      const kp2 = await Keypair.generate();

      pool.solana.registerDerivedAccount({
        chain: "solana",
        address: kp1.publicKey.toBase58(),
        privateKey: Buffer.from(kp1.secretKey).toString("hex"),
        balanceWei: 100_000_000n,
      });
      pool.solana.registerDerivedAccount({
        chain: "solana",
        address: kp2.publicKey.toBase58(),
        privateKey: Buffer.from(kp2.secretKey).toString("hex"),
        balanceWei: 200_000_000n,
      });

      config.chainUtxoPool = pool;
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      const estimate = await chain.nativeTransfers.estimateLegacyFee!({
        wallet,
        recipient,
        value: 250_000_000n,
      });

      expect(estimate.totalFee).toBe(5000n);
      expect(estimate.inputCount).toBe(2);
      expect(estimate.deliveryFee).toBe(5000n);
    });
  });
});
