import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";

import { createChain } from "./chain-factory";
import { NativeAssetChain } from "./active-chain";
import { EcashWalletBackend } from "../ecash-wallet";
import { SolanaWalletConnection } from "../solana-wallet";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";

const ECASH_ADDRESS = "ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl";
const ECASH_GENESIS =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOLANA_BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const base58Decoder = getBase58Decoder();

function exerciseCodecs(chain: NativeAssetChain, address: string): void {
  const parsed = chain.parseAddress(address);
  expect(parsed).toBeDefined();
  expect(chain.addressToString(parsed!)).toBe(address);
  expect(chain.formatAddress(parsed!)).toBe(address);
  expect(chain.transactionToString({ txHash: "tx-id" })).toBe("tx-id");
  expect(chain.fromDisplayAmount(chain.toDisplayAmount(123n))).toBe(123n);
}

describe("createChain", () => {
  it("creates the still-default Monad application chain", async () => {
    await expect(
      createChain({
        kind: "monad",
        config: {
          networkId: "monad-test",
          chainId: 10143,
          rpcUrl: "http://127.0.0.1:8545",
          relayBaseUrl: "http://127.0.0.1:8098",
          networkTag: "MONT",
          stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
          defaultStampValueWei: 1n,
          defaultTopicVoteValueWei: 1n,
          subAccountPoolSize: 1,
          walletStorageLocation: false,
        },
      })
    ).resolves.toMatchObject({ kind: "monad", name: "monad" });
  });

  it("creates a Solana chain with the shared codecs and wallet API", async () => {
    const signer = await Keypair.fromSeed(new Uint8Array(32).fill(1));
    const recipient = (await Keypair.fromSeed(new Uint8Array(32).fill(2)))
      .publicKey;
    const sent: Uint8Array[] = [];
    const getSignatureStatus = jest.fn().mockResolvedValue({
      value: { err: null, confirmationStatus: "confirmed" as const },
    });
    let solanaAttemptRecorded = false;
    const connection: SolanaWalletConnection = {
      async getGenesisHash() {
        return "solana-test-genesis";
      },
      getSignatureStatus,
      async getBalance() {
        return 99n;
      },
      async getLatestBlockhash() {
        return { blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 1n };
      },
      async sendRawTransaction(raw) {
        expect(solanaAttemptRecorded).toBe(true);
        sent.push(raw);
        return base58Decoder.decode(
          VersionedTransaction.deserialize(raw).signatures[0]
        );
      },
    };
    const chain = await createChain({
      kind: "solana",
      config: {
        networkId: "solana-test",
        genesisHash: "solana-test-genesis",
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        connection,
        deriveSigner: () => signer,
      },
    });
    exerciseCodecs(chain, recipient.toBase58());
    expect(chain.toDisplayAmount(1_500_000_000n)).toBe("1.5");
    expect(chain.fromDisplayAmount("1.5")).toBe(1_500_000_000n);

    const wallet = await chain.createWallet({ mnemonic: MNEMONIC });
    await expect(chain.nativeTransfers.getBalance({ wallet })).resolves.toBe(
      99n
    );
    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: { raw: recipient.toBase58() },
        value: 7n,
        onSigned: async ({ txHash }) => {
          expect(txHash).toEqual(expect.any(String));
          solanaAttemptRecorded = true;
        },
      })
    ).resolves.toEqual({ txHash: expect.any(String) });
    expect(sent).toHaveLength(1);
    await expect(
      chain.nativeTransfers.getTransactionStatus({
        wallet,
        transaction: { txHash: "solana-signature" },
      })
    ).resolves.toBe("confirmed");
    expect(getSignatureStatus).toHaveBeenLastCalledWith("solana-signature", {
      searchTransactionHistory: true,
    });
    getSignatureStatus.mockResolvedValueOnce({
      value: { err: null, confirmationStatus: null },
    });
    await expect(
      chain.nativeTransfers.getTransactionStatus({
        wallet,
        transaction: { txHash: "legacy-signature" },
      })
    ).resolves.toBe("pending");

    const wrongGenesis = await createChain({
      kind: "solana",
      config: {
        networkId: "mislabeled-solana",
        genesisHash: "different-genesis",
        connection,
        deriveSigner: () => signer,
      },
    });
    await expect(
      wrongGenesis.createWallet({ mnemonic: MNEMONIC })
    ).rejects.toThrow("Solana RPC genesis mismatch");

    const otherNetwork = await createChain({
      kind: "solana",
      config: {
        networkId: "solana-mainnet",
        genesisHash: "solana-test-genesis",
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        connection,
        deriveSigner: () => signer,
      },
    });
    await expect(
      otherNetwork.nativeTransfers.getBalance({ wallet })
    ).rejects.toThrow(
      "Expected Solana network solana-mainnet, got solana-test"
    );
    await expect(
      otherNetwork.nativeTransfers.send({
        wallet,
        recipient: { raw: recipient.toBase58() },
        value: 7n,
      })
    ).rejects.toThrow(
      "Expected Solana network solana-mainnet, got solana-test"
    );
    expect(sent).toHaveLength(1);
  });

  it("creates an eCash chain without exposing UTXO machinery", async () => {
    let ecashAttemptRecorded = false;
    const getTransaction = jest
      .fn()
      .mockResolvedValueOnce({ block: { height: 1 } })
      .mockResolvedValueOnce({ block: undefined });
    const broadcast = jest.fn(async () => {
      expect(ecashAttemptRecorded).toBe(true);
      return { success: true, broadcasted: ["xec-tx"] };
    });
    const backend: EcashWalletBackend = {
      balanceSats: 500n,
      receiveIndex: 0,
      sync: jest.fn().mockResolvedValue(undefined),
      syncAndDiscoverAddresses: jest.fn().mockResolvedValue(undefined),
      getReceiveAddress: () => ECASH_ADDRESS,
      action: () => ({
        build: () => ({ builtTxs: [{ txid: "xec-tx" }], broadcast }),
      }),
    };
    const chain = await createChain({
      kind: "ecash",
      config: {
        networkId: "ecash-mainnet",
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        chronik: {
          block: async () => ({ blockInfo: { hash: ECASH_GENESIS } }),
          tx: getTransaction,
        },
        walletFactory: () => backend,
      },
    });
    exerciseCodecs(chain, ECASH_ADDRESS);
    expect(chain.parseAddress(ECASH_ADDRESS.toUpperCase())).toEqual({
      raw: ECASH_ADDRESS,
    });
    expect(
      chain.parseAddress("ectest:qq86jv6h0y97q8l63ndynvk3fn9aq8fqruhjcef2tw")
    ).toBeUndefined();
    expect(chain.toDisplayAmount(123n)).toBe("1.23");
    expect(chain.fromDisplayAmount("1.23")).toBe(123n);
    expect(() => chain.fromDisplayAmount("1.234")).toThrow(
      "at most 2 decimal places"
    );

    const wallet = await chain.createWallet({ mnemonic: MNEMONIC });
    await expect(chain.nativeTransfers.getBalance({ wallet })).resolves.toBe(
      500n
    );
    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: { raw: ECASH_ADDRESS },
        value: 100n,
        onSigned: async (transaction) => {
          expect(transaction).toEqual({ txHash: "xec-tx" });
          ecashAttemptRecorded = true;
        },
      })
    ).resolves.toEqual({ txHash: "xec-tx" });
    await expect(
      chain.nativeTransfers.getTransactionStatus({
        wallet,
        transaction: {
          txHash: "child-b",
          relatedTxHashes: ["child-a", "child-b"],
        },
      })
    ).resolves.toBe("pending");
    expect(getTransaction.mock.calls).toEqual([["child-a"], ["child-b"]]);
    expect("buildTransactionBundle" in wallet).toBe(false);
    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: {
          raw: "ectest:qq86jv6h0y97q8l63ndynvk3fn9aq8fqruhjcef2tw",
        },
        value: 1n,
      })
    ).rejects.toThrow("Invalid eCash recipient for the configured network");

    const wrongGenesis = await createChain({
      kind: "ecash",
      config: {
        networkId: "ecash-mainnet",
        chronik: {
          block: async () => ({ blockInfo: { hash: "different-genesis" } }),
          tx: async () => {
            throw new Error("not found");
          },
        },
        walletFactory: () => backend,
      },
    });
    await expect(
      wrongGenesis.createWallet({ mnemonic: MNEMONIC })
    ).rejects.toThrow("eCash Chronik genesis mismatch");
  });

  it("rejects a wallet created for another chain", async () => {
    const chain = await createChain({
      kind: "ecash",
      config: {
        networkId: "ecash-mainnet",
        chronik: {
          block: async () => ({ blockInfo: { hash: ECASH_GENESIS } }),
          tx: async () => ({ block: { height: 1 } }),
        },
        walletFactory: () => ({
          balanceSats: 0n,
          receiveIndex: 0,
          sync: jest.fn().mockResolvedValue(undefined),
          syncAndDiscoverAddresses: jest.fn().mockResolvedValue(undefined),
          getReceiveAddress: () => ECASH_ADDRESS,
          action: () => {
            throw new Error("must not build");
          },
        }),
      },
    });
    const foreignWallet = {
      chainKind: "solana" as const,
      networkId: "solana-test",
      identity: {
        address: { raw: "foreign" },
        displayAddress: "foreign",
      },
      getReceiveAddress: jest.fn(async () => ({ raw: "foreign" })),
      getUnresolvedNativeTransaction: jest.fn(),
      retryUnresolvedNativeTransaction: jest.fn(),
      resolveUnresolvedNativeTransaction: jest.fn(),
      getBalance: jest.fn().mockResolvedValue(123n),
      sendNative: jest.fn(),
    };

    await expect(
      chain.nativeTransfers.getBalance({ wallet: foreignWallet })
    ).rejects.toThrow("Expected an eCash wallet, got solana");
    expect(foreignWallet.getBalance).not.toHaveBeenCalled();
  });

  it("accepts a runtime ChainFactoryConfig union", async () => {
    const config: import("./chain-factory").ChainFactoryConfig = {
      kind: "solana",
      config: {
        networkId: "solana-test",
        genesisHash: "solana-test-genesis",
        connection: {
          getGenesisHash: async () => "solana-test-genesis",
          getSignatureStatus: async () => ({
            value: { err: null, confirmationStatus: "confirmed" as const },
          }),
          getBalance: async () => 0n,
          getLatestBlockhash: async () => ({
            blockhash: SOLANA_BLOCKHASH,
            lastValidBlockHeight: 1n,
          }),
          sendRawTransaction: async () => "unused",
        },
        deriveSigner: async () => Keypair.fromSeed(new Uint8Array(32).fill(1)),
      },
    };
    await expect(createChain(config)).resolves.toMatchObject({
      kind: "solana",
    });
  });
});
