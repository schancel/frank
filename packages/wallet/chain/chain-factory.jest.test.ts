import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";

import { createChain } from "./chain-factory";
import { NativeAssetChain } from "./active-chain";
import { EcashWalletBackend } from "../ecash-wallet";
import { SolanaWalletConnection } from "../solana-wallet";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";
import type { DomainRoot } from "../../domain-roots/src";

const ECASH_ADDRESS = "ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl";
const ECASH_CHECKPOINT =
  "000000000000000004284c9d8b2c8ff731efeaec6be50729bdc9bd07f910757d";
const ECASH_ROOT: DomainRoot<"ecash-bch-wallet"> = {
  registry: "frank-domain-roots-v1",
  purpose: "ecash-bch-wallet",
  bytes: new Uint8Array(32).fill(1),
};
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOLANA_BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const base58Decoder = getBase58Decoder();

function exerciseCodecs(
  chain: Omit<NativeAssetChain, "createWallet">,
  address: string
): void {
  const parsed = chain.parseAddress(address);
  expect(parsed).toBeDefined();
  expect(chain.addressToString(parsed!)).toBe(address);
  expect(chain.formatAddress(parsed!)).toBe(address);
  expect(chain.transactionToString({ txHash: "tx-id" })).toBe("tx-id");
  expect(chain.fromDisplayAmount(chain.toDisplayAmount(123n))).toBe(123n);
}

describe("createChain", () => {
  it("requires a purpose-tagged eCash root at the factory boundary before effects", async () => {
    const block = jest.fn();
    const walletFactory = jest.fn();
    const chain = await createChain({
      family: "bitcoin",
      config: {
        networkId: "ecash-mainnet",
        chronik: { block } as unknown as import("chronik-client").ChronikClient,
        walletFactory,
      },
    });
    // @ts-expect-error eCash's factory output does not accept the predecessor HDSeed.
    await expect(chain.createWallet({ mnemonic: MNEMONIC })).rejects.toThrow(
      "ecash-bch-wallet root"
    );
    await expect(
      // @ts-expect-error a different domain must not typecheck as an eCash input.
      chain.createWallet({ ...ECASH_ROOT, purpose: "evm-wallet" })
    ).rejects.toThrow("ecash-bch-wallet root");
    expect(block).not.toHaveBeenCalled();
    expect(walletFactory).not.toHaveBeenCalled();
  });

  it("creates the still-default Monad application chain", async () => {
    await expect(
      createChain({
        family: "evm",
        config: {
          networkId: "monad-test",
          chainId: 10143,
          rpcChain: "monad-testnet",
          relayBaseUrl: "http://127.0.0.1:8098",
          networkTag: "MONT",
          stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
          defaultStampValueWei: 1n,
          defaultTopicVoteValueWei: 1n,
          subAccountPoolSize: 1,
          walletStorageLocation: false,
        },
      })
    ).resolves.toMatchObject({
      family: "evm",
      chainIdentifier: "monad-testnet",
      name: "Monad Testnet",
      unit: "MONT",
      isTestnet: true,
    });
  });

  it("creates an EVM application chain with custom name, unit, and identifier", async () => {
    await expect(
      createChain({
        family: "evm",
        chainIdentifier: "base-mainnet",
        config: {
          name: "Base",
          unit: "ETH",
          networkId: "base-mainnet",
          chainId: 8453,
          rpcChain: "base-mainnet",
          relayBaseUrl: "http://127.0.0.1:8098",
          networkTag: "BASE",
          stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
          defaultStampValueWei: 1n,
          defaultTopicVoteValueWei: 1n,
          subAccountPoolSize: 1,
          walletStorageLocation: false,
        },
      })
    ).resolves.toMatchObject({
      family: "evm",
      chainIdentifier: "base-mainnet",
      name: "Base",
      unit: "ETH",
      isTestnet: false,
    });
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
      family: "solana",
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
      family: "solana",
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
      family: "solana",
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
      family: "bitcoin",
      config: {
        networkId: "ecash-mainnet",
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        chronik: {
          block: async () => ({ blockInfo: { hash: ECASH_CHECKPOINT } }),
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

    const wallet = await chain.createWallet(ECASH_ROOT);
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

    const wrongCheckpoint = await createChain({
      family: "bitcoin",
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
    await expect(wrongCheckpoint.createWallet(ECASH_ROOT)).rejects.toThrow(
      "eCash Chronik checkpoint mismatch"
    );
  });

  it("rejects a wallet created for another chain", async () => {
    const chain = await createChain({
      family: "bitcoin",
      config: {
        networkId: "ecash-mainnet",
        chronik: {
          block: async () => ({ blockInfo: { hash: ECASH_CHECKPOINT } }),
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
      family: "solana" as const,
      chainIdentifier: "solana-test",
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
    ).rejects.toThrow("Expected a Bitcoin/eCash wallet, got solana");
    expect(foreignWallet.getBalance).not.toHaveBeenCalled();
  });

  it("accepts a runtime ChainFactoryConfig union", async () => {
    const config: import("./chain-factory").ChainFactoryConfig = {
      family: "solana",
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
      family: "solana",
    });
  });
});
