import * as legacyEnvelope from "@frank/cashweb/relay/monad-message-envelope";
import * as syncDispatch from "@frank/cashweb/sync-dispatcher";
/**
 * Unit tests for `monad-chain.ts` (ticket #41): verifies `MonadChain` (via `createEvmChain`)
 * wires the real Monad wallet clients together correctly. Per the ticket's own instructions, this
 * mocks the underlying Monad clients (`MonadStampClient`, `MonadTopicPostClient`,
 * `MonadTopicVoteClient`, `monad-message-feed.ts`, `monad-topic-tally-client.ts`, and
 * `monad-identity.ts`'s HTTP-touching `fetchMonadProfile`) rather than `axios` directly -- those
 * clients already have their own tested HTTP layer (see each client's own `*.jest.test.ts`); this
 * file only tests that `MonadChain` calls them with the right arguments and adapts their results
 * correctly.
 *
 * `monad-message-envelope.ts`'s ECDH/AES functions are used for real (not mocked) -- they're pure
 * crypto with no network dependency, and exercising them for real is a stronger check that
 * `directMessages.send`/`fetchSince` actually encrypt/decrypt, not merely pass a plaintext through.
 */
import { Wallet, Transaction, getBytes, hexlify } from "ethers";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import level from "level";
import {
  LevelTopicOperationJournal,
  type OutgoingTopicOperation,
} from "../storage/topic-operation-journal";
import { LevelStampAttemptJournal } from "../storage/stamp-attempt-journal";
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from "../monad-wallet-material";
import type { EvmWalletHandle } from "../evm-wallet-handle";

import { ChainUtxoPool } from "../chain-utxo-pool";
import * as viteEnv from "./vite-env";
import { verifyEcdsa } from "@frank/nakamoto";

import { MonadIdentity } from "../monad-identity";
import { StoredMonadMessageProto } from "../monad-stamp-client";
import { MonadTopicPostAbandonedError } from "../monad-topic-post-client";
import { MessageItem, TextItem } from "@frank/cashweb/types/messages";
import {
  buildEnvelope,
  decryptEnvelope,
  parseEnvelope,
} from "@frank/cashweb/relay/monad-message-envelope";

import {
  MAILBOX_RECOVERY_SYNC_INTERVAL_MS,
  MAILBOX_RECOVERY_SYNC_WAIT_MS,
  createEvmChain,
  prepareMonadRevisionZeroExport,
  deserializeMessageItems,
  loadMonadChainConfigFromEnv,
  serializeMessageItems,
  getCustomRelayBaseUrl,
  setCustomRelayBaseUrl,
  getDefaultRelayBaseUrl,
} from "./monad-chain";
import { installMessageItemRegistry } from "./monad-canonical-dm";
import { createDefaultMessageItemRegistry } from "../message-item-plugins/default-registry";
import { pluginCapabilitiesNotYetAvailable } from "../message-item-plugins/registry";
import { NEVER_FROM_A_PEER_SAMPLES } from "../message-item-plugins/wire-samples.testutil";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";

import { TopicPostOutcomeUnknownError, WalletHandle } from "./active-chain";
import { deriveMonadStampChildPublic } from "../monad-stamp-stealth";
import { InMemoryStampPaymentJournal } from "../storage/stamp-payment-journal";
import {
  InMemoryNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
  NativeTransactionSubmissionError
} from "./chain-wallet";

jest.mock("../monad-stamp-client", () => {
  const actual = jest.requireActual("../monad-stamp-client");
  return {
    ...actual,
    MonadStampClient: jest.fn().mockImplementation(() => ({
      submitStampedMessage: jest.fn(),
      resumePendingAttempts: jest.fn().mockResolvedValue([]),
    })),
    quoteMonadStampPaymentGasReserve: jest.fn().mockResolvedValue(100n),
  };
});
jest.mock("../monad-topic-post-client", () => {
  const actual = jest.requireActual("../monad-topic-post-client");
  return {
    ...actual,
    MonadTopicPostClient: jest.fn().mockImplementation(() => ({
      submitTopicPost: jest.fn(),
      resumePendingOperations: jest.fn().mockResolvedValue(undefined),
    })),
    quoteMonadTopicBurnGasReserve: jest.fn().mockResolvedValue(100n),
  };
});
jest.mock("../monad-topic-vote-client", () => {
  const actual = jest.requireActual("../monad-topic-vote-client");
  return {
    ...actual,
    MonadTopicVoteClient: jest.fn().mockImplementation(() => ({
      castVote: jest.fn(),
      resumePendingOperations: jest.fn().mockResolvedValue(undefined),
    })),
  };
});
// Explicit factories, not automocks: automock generation loads the real modules in an isolated
// registry, which makes `bitcore-lib-xpi`'s "more than one instance" guard throw.
jest.mock("../monad-topic-tally-client");
jest.mock("../monad-identity", () => {
  const actual = jest.requireActual("../monad-identity");
  return {
    ...actual,
    fetchMonadProfile: jest.fn(),
  };
});
jest.mock("../monad-account-tx", () => {
  const actual = jest.requireActual("../monad-account-tx");
  return {
    ...actual,
    MonadAccountTxSigner: jest.fn(),
  };
});
jest.mock("@frank/cashweb/relay/monad-message-feed", () => ({
  fetchMonadMessagesSince: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadStampClient } = jest.requireMock("../monad-stamp-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicPostClient } = jest.requireMock("../monad-topic-post-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicVoteClient } = jest.requireMock("../monad-topic-vote-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadAccountTxSigner } = jest.requireMock("../monad-account-tx");
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from "../monad-topic-tally-client";
import { fetchMonadProfile } from "../monad-identity";
import { fetchMonadMessagesSince } from "@frank/cashweb/relay/monad-message-feed";
const mockedFetchMonadTopicPostsSince =
  fetchMonadTopicPostsSince as jest.MockedFunction<
    typeof fetchMonadTopicPostsSince
  >;
const mockedFetchMonadTopicPostView =
  fetchMonadTopicPostView as jest.MockedFunction<
    typeof fetchMonadTopicPostView
  >;
const mockedFetchDiscoveredTopics =
  fetchDiscoveredTopics as jest.MockedFunction<typeof fetchDiscoveredTopics>;
const mockedFetchMonadProfile = fetchMonadProfile as jest.MockedFunction<
  typeof fetchMonadProfile
>;
const mockedFetchMonadMessagesSince =
  fetchMonadMessagesSince as jest.MockedFunction<
    typeof fetchMonadMessagesSince
  >;

const TEST_CONFIG: EvmChainConfig = {
  networkId: "monad-test",
  chainId: 10143,
  nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  rpcChain: "monad-testnet",
  relayBaseUrl: "http://relay.test",
  networkTag: "MONT",
  stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
  defaultStampValueWei: 1_000_000_000_000n,
  defaultTopicVoteValueWei: 1_000_000_000_000n,
  subAccountPoolSize: 3,
  walletStorageLocation: false,
};

const ALICE_PRIVATE_KEY_HEX = "0x" + "11".repeat(31) + "1a"; // 32 bytes, distinct from Bob/Eve below
const BOB_PRIVATE_KEY_HEX = "0x" + "22".repeat(31) + "2b";
const EVE_PRIVATE_KEY_HEX = "0x" + "33".repeat(31) + "3c";

function makeWallet(identity: MonadIdentity): EvmChainWalletHandle {
  return {
    family: "evm",
    chainIdentifier: "monad-testnet",
    networkId: TEST_CONFIG.networkId,
    identity,
    getReceiveAddress: jest.fn(async () => identity.address),
    getBalance: jest.fn(),
    sendNative: jest.fn(),
    close: jest.fn(),
    // These are never dereferenced by real logic in this test file: every client that would
    // actually use them (`MonadStampClient`/`MonadTopicPostClient`/`MonadTopicVoteClient`) is
    // mocked above, so `MonadChain` only ever passes this bundle through to a mock constructor.
    pool: {
      prepareStampInventory: jest.fn().mockResolvedValue({
        fundingTxHashes: [],
        selectedAccountCount: 2,
      }),
      prepareBurnAccount: jest.fn().mockResolvedValue({
        index: 4,
        fundingTxHashes: [],
      }),
    } as unknown as EvmChainWalletHandle["pool"],
    leaseManager: {} as EvmChainWalletHandle["leaseManager"],
    provider: {} as EvmChainWalletHandle["provider"],
    httpClient: {} as EvmChainWalletHandle["httpClient"],
    relayBaseUrl: "http://relay.test",
  };
}

/** The wallet with the default message-item registry installed, as a host installs one. */
function withItems(wallet: EvmChainWalletHandle): EvmChainWalletHandle {
  installMessageItemRegistry(
    wallet,
    createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable)
  );
  return wallet;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("createEvmChain: basic chain properties", () => {
  const chain = createEvmChain(TEST_CONFIG);

  it("exposes the Monad name/unit", () => {
    expect(chain.family).toBe("evm");
    expect(chain.chainIdentifier).toBe("monad-testnet");
    expect(chain.name).toBe("Monad Testnet");
    expect(chain.unit).toBe("MONT");
    expect(chain.isTestnet).toBe(true);
    expect(chain.defaultTopicVoteValue).toBe(
      TEST_CONFIG.defaultTopicVoteValueWei
    );
    expect(chain.capabilities).toEqual({
      profiles: true,
      directMessages: true,
      topics: true,
      stealthPayments: true,
      legacyConsolidation: "evm-staging",
    });
  });

  it("round-trips display <-> raw amounts", () => {
    const raw = 1_500_000_000_000_000_000n; // 1.5 MON
    const display = chain.toDisplayAmount(raw);
    expect(chain.fromDisplayAmount(display)).toBe(raw);
  });

  it("formatAddress returns the canonical address string as-is", () => {
    const addr = { raw: "0x000000000000000000000000000000000000dEaD" };
    expect(chain.formatAddress(addr)).toBe(addr.raw);
  });

  it("parseAddress checksums a valid address and normalizes case", () => {
    const parsed = chain.parseAddress(
      "0x000000000000000000000000000000000000dead"
    );
    expect(parsed?.raw).toBe("0x000000000000000000000000000000000000dEaD");
  });

  it("parseAddress returns undefined for garbage input", () => {
    expect(chain.parseAddress("not-an-address")).toBeUndefined();
  });
});

describe("loadMonadChainConfigFromEnv", () => {
  const saved = {
    chain: process.env.MONAD_RPC_CHAIN,
    chainId: process.env.MONAD_CHAIN_ID,
    networkId: process.env.MONAD_NETWORK_ID,
    networkTag: process.env.FRANK_NETWORK_TAG,
    fakeDemo: process.env.FRANK_FAKE_DEMO,
  };

  beforeEach(() => {
    delete process.env.FRANK_FAKE_DEMO;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries({
      MONAD_RPC_CHAIN: saved.chain,
      MONAD_CHAIN_ID: saved.chainId,
      MONAD_NETWORK_ID: saved.networkId,
      FRANK_NETWORK_TAG: saved.networkTag,
      FRANK_FAKE_DEMO: saved.fakeDemo,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([true, "true"])("accepts explicit demo opt-in %p", (raw) => {
    jest.spyOn(viteEnv, "readViteEnv").mockImplementation((key) => {
      if (key === "QCLI_FRANK_FAKE_DEMO") return raw as string;
      if (key === "QCLI_FRANK_DEMO_CONTROL_URL") return "http://127.0.0.1:9701";
      return undefined;
    });
    expect(loadMonadChainConfigFromEnv().fakeDemo).toEqual({
      enabled: true,
      controlUrl: "http://127.0.0.1:9701",
    });
  });

  it.each([
    false,
    "false",
    undefined,
    "",
    0,
    1,
    "1",
    "TRUE",
    "True",
    " true ",
    {},
    [],
    new Boolean(true),
  ])("does not coerce demo opt-in %p", (raw) => {
    jest
      .spyOn(viteEnv, "readViteEnv")
      .mockImplementation((key) =>
        key === "QCLI_FRANK_FAKE_DEMO" ? (raw as string | undefined) : undefined
      );
    expect(loadMonadChainConfigFromEnv().fakeDemo).toBeUndefined();
  });

  it("keeps a known relay chain, native identity, and wallet network atomic", () => {
    process.env.MONAD_RPC_CHAIN = "monad-mainnet";
    process.env.MONAD_CHAIN_ID = "10143";
    process.env.FRANK_NETWORK_TAG = "MONT";
    delete process.env.MONAD_NETWORK_ID;

    expect(loadMonadChainConfigFromEnv()).toMatchObject({
      rpcChain: "monad-mainnet",
      networkId: "monad-mainnet",
      chainId: 143n,
      networkTag: "MON1",
    });
  });
});

describe("custom relay configuration", () => {
  beforeEach(() => {
    setCustomRelayBaseUrl(undefined);
  });

  afterEach(() => {
    setCustomRelayBaseUrl(undefined);
  });

  it("stores and retrieves custom relay url", () => {
    expect(getCustomRelayBaseUrl()).toBeUndefined();
    setCustomRelayBaseUrl("https://relay.custom.org");
    expect(getCustomRelayBaseUrl()).toBe("https://relay.custom.org");
    setCustomRelayBaseUrl(undefined);
    expect(getCustomRelayBaseUrl()).toBeUndefined();
  });

  it("loadMonadChainConfigFromEnv dynamically reflects custom relay base URL", () => {
    const config = loadMonadChainConfigFromEnv();
    const defaultRelay = getDefaultRelayBaseUrl();
    expect(config.relayBaseUrl).toBe(defaultRelay);

    setCustomRelayBaseUrl("https://override.relay.org");
    expect(config.relayBaseUrl).toBe("https://override.relay.org");

    setCustomRelayBaseUrl(undefined);
    expect(config.relayBaseUrl).toBe(defaultRelay);
  });
});

describe("createEvmChain: createWallet", () => {
  const chain = createEvmChain(TEST_CONFIG);
  const seed = {
    mnemonic: "test test test test test test test test test test test junk",
  };

  it("derives a deterministic, EIP-55-checksummed identity address from the seed", async () => {
    const walletA = await chain.createWallet(seed);
    const walletB = await chain.createWallet(seed);
    expect(walletB).toBe(walletA);
    expect(walletA.identity.address.raw).toBe(walletB.identity.address.raw);
    expect(walletA.identity.address.raw).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("produces a different identity for a different seed", async () => {
    const walletA = await chain.createWallet(seed);
    const walletB = await chain.createWallet({
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
    });
    expect(walletA.identity.address.raw).not.toBe(walletB.identity.address.raw);
  });

  it("derives identity address according to specified candidate path in seed", async () => {
    const standardEvmWallet = await chain.createWallet({
      mnemonic: seed.mnemonic,
      path: "m/44'/60'/0'/0/0",
    });
    expect(standardEvmWallet.identity.address.raw).toBe(
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    );
  });

  it("pre-derives unfunded accounts without moving funds on wallet open", async () => {
    const wallet = (await chain.createWallet(seed)) as EvmChainWalletHandle;
    const records = wallet.pool.ensureSize(0);
    expect(records).toHaveLength(TEST_CONFIG.subAccountPoolSize);
    expect(records.every((record) => record.status === "unfunded")).toBe(true);
    expect(MonadAccountTxSigner).not.toHaveBeenCalled();
  });

  it("caches getBalance across repeated calls within TTL and invalidates upon invalidateBalanceCache", async () => {
    const uniqueSeed = {
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    };
    const wallet = (await chain.createWallet(
      uniqueSeed
    )) as EvmChainWalletHandle;

    let balance = 100_000n;
    const getBalance = jest.fn(async () => balance);
    wallet.provider.getBalance = getBalance;

    // First call: queries provider
    const bal1 = await wallet.getBalance();
    expect(bal1).toBe(100_000n);
    expect(getBalance).toHaveBeenCalledTimes(1);

    // Second call within TTL: served from cache without RPC call
    const bal2 = await wallet.getBalance();
    expect(bal2).toBe(100_000n);
    expect(getBalance).toHaveBeenCalledTimes(1);

    // invalidateBalanceCache clears cached balance
    wallet.invalidateBalanceCache?.();
    balance = 250_000n;
    const bal3 = await wallet.getBalance();
    expect(bal3).toBe(250_000n);
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it("preserves old hash-only evidence even when a receipt exists", async () => {
    const nativeAttemptStore = new InMemoryNativeTransactionAttemptStore();
    const chain = createEvmChain({ ...TEST_CONFIG, nativeAttemptStore });
    const wallet = await chain.createWallet(seed);
    try {
      const key = nativeTransactionAttemptKey({
        family: "evm",
        chainIdentifier: wallet.chainIdentifier,
        address: (await wallet.getReceiveAddress()).raw.toLowerCase()
      });
      const retained = { txHash: "0x" + "44".repeat(32) };
      nativeAttemptStore.put(key, retained);
      const receipt = jest
        .spyOn(
          (wallet as EvmChainWalletHandle).provider,
          "getTransactionReceipt"
        )
        .mockResolvedValue({ status: 1 } as never);
      await expect(
        wallet.sendNative({ recipient: wallet.identity.address, value: 1n })
      ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
      expect(nativeAttemptStore.get(key)).toEqual(retained);
      expect(receipt).not.toHaveBeenCalled();
      expect(wallet.resolveUnresolvedNativeTransaction).toBeUndefined();
    } finally {
      await wallet.close();
    }
  });
});

describe("createEvmChain: fetchProfile", () => {
  it("delegates to monad-identity.fetchMonadProfile with the chain relayBaseUrl", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const addr = { raw: "0x000000000000000000000000000000000000dEaD" };
    const profile = { address: addr, pubKey: new Uint8Array([1, 2, 3]) };
    mockedFetchMonadProfile.mockResolvedValueOnce(profile);

    const result = await chain.fetchProfile(addr);

    expect(result).toBe(profile);
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
      address: addr,
    });
  });

  it("returns undefined when nothing is registered", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    mockedFetchMonadProfile.mockResolvedValueOnce(undefined);
    expect(
      await chain.fetchProfile({ raw: "0x" + "00".repeat(20) })
    ).toBeUndefined();
  });

  it("uses opts.relayBaseUrl instead of the chain default when given (ticket #78)", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const addr = { raw: "0x000000000000000000000000000000000000dEaD" };
    const profile = { address: addr, pubKey: new Uint8Array([1, 2, 3]) };
    mockedFetchMonadProfile.mockResolvedValueOnce(profile);

    const result = await chain.fetchProfile(addr, {
      relayBaseUrl: "https://someone-elses-relay.example",
    });

    expect(result).toBe(profile);
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: "https://someone-elses-relay.example",
      address: addr,
    });
  });
});

describe("createEvmChain: nativeTransfers", () => {
  it("reads the balance through the common wallet API", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(identity);
    const getBalance = jest.fn().mockResolvedValue(123n);
    wallet.getBalance = getBalance;

    await expect(chain.nativeTransfers.getBalance({ wallet })).resolves.toBe(
      123n
    );
    expect(getBalance).toHaveBeenCalledWith();
  });

  it("sends through the common wallet API", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(identity);
    const recipient = chain.parseAddress(
      "0x000000000000000000000000000000000000dead"
    );
    expect(recipient).toBeDefined();

    const sendNative = jest.fn().mockResolvedValue({ txHash: "0xbroadcast" });
    wallet.sendNative = sendNative;

    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: recipient!,
        value: 1_500_000_000_000_000_000n,
      })
    ).resolves.toEqual({ txHash: "0xbroadcast" });

    expect(sendNative).toHaveBeenCalledWith({
      recipient,
      value: 1_500_000_000_000_000_000n,
    });
  });

  it("forwards onSigned through the common wallet API", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(identity);
    const onSigned = jest.fn().mockResolvedValue(undefined);
    const sendNative = jest.fn().mockResolvedValue({ txHash: "0xsigned" });
    wallet.sendNative = sendNative;
    await chain.nativeTransfers.send({
      wallet,
      recipient: identity.address,
      value: 1n,
      onSigned,
    });
    expect(sendNative).toHaveBeenCalledWith({
      recipient: identity.address,
      value: 1n,
      onSigned,
    });
  });

  it("reports a transaction hash as confirmed / failed / pending / unknown from the node", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const wallet = makeWallet(
      MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    );
    const getTransactionReceipt = jest.fn();
    const getTransaction = jest.fn();
    wallet.provider = {
      getTransactionReceipt,
      getTransaction,
    } as unknown as EvmChainWalletHandle["provider"];
    const status = () =>
      chain.nativeTransfers.getTransactionStatus({
        wallet,
        transaction: { txHash: "0xh" },
      });
    getTransactionReceipt.mockResolvedValue({ status: 1 });
    await expect(status()).resolves.toBe("confirmed");
    getTransactionReceipt.mockResolvedValue({ status: 0 });
    await expect(status()).resolves.toBe("failed");
    getTransactionReceipt.mockResolvedValue(null);
    getTransaction.mockResolvedValue({ hash: "0xh" });
    await expect(status()).resolves.toBe("pending");
    getTransaction.mockResolvedValue(null);
    await expect(status()).resolves.toBe("unknown");
  });

  it("leaves native value validation at the wallet boundary", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);

    const wallet = makeWallet(identity);
    const sendNative = jest.fn().mockRejectedValue(new RangeError("bad value"));
    wallet.sendNative = sendNative;
    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: identity.address,
        value: 0n,
      })
    ).rejects.toThrow("bad value");
    expect(sendNative).toHaveBeenCalled();
  });

  it.each(["estimate", "send"] as const)(
    "requires a lifetime custody owner for %s instead of trusting attached private keys",
    async (action) => {
      const chain = createEvmChain(TEST_CONFIG);
      const wallet = makeWallet(
        MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
      );
      const pool = new ChainUtxoPool();
      const stranger = Wallet.createRandom();
      const coin = pool.registerSubAccount({
        chain: "monad",
        address: stranger.address,
        privateKey: stranger.privateKey,
        balanceWei: 10n ** 18n
      });
      wallet.accountUtxoPool = pool;
      const getBalance = jest.fn();
      wallet.provider = {
        getBalance
      } as unknown as EvmChainWalletHandle["provider"];
      const params = {
        wallet,
        recipient: { raw: stranger.address },
        value: 1000n
      };
      await expect(
        action === "estimate"
          ? chain.nativeTransfers.estimateLegacyFee!(params)
          : chain.nativeTransfers.sendLegacy!(params)
      ).rejects.toThrow("durable native-operation owner");
      expect(getBalance).not.toHaveBeenCalled();
      expect(pool.getCoin(coin.id)?.balanceWei).toBe(10n ** 18n);
    }
  );
});

describe("serializeMessageItems / deserializeMessageItems", () => {
  it("round-trips text/reply/image items", () => {
    const items: MessageItem[] = [
      { type: "text", text: "hello" },
      { type: "reply", payloadDigest: "ab".repeat(32) },
    ];
    const plaintext = serializeMessageItems(items);
    expect(deserializeMessageItems(plaintext)).toEqual(items);
  });

  it("round-trips multi-chain stealth payment items", () => {
    const stealthItem: MessageItem = {
      type: "stealth",
      chainId: "monad-testnet",
      amount: 1000,
      rawTx: "0x02deadbeef",
    };
    const plaintext = serializeMessageItems([stealthItem]);
    expect(deserializeMessageItems(plaintext)).toEqual([stealthItem]);
  });

  it("rejects p2pkh items as legacy Lotus script", () => {
    expect(() =>
      serializeMessageItems([{ type: "p2pkh", address: "0xabc", amount: 1000 }])
    ).toThrow(/p2pkh/);
  });
});

describe("createEvmChain: directMessages", () => {
  it("requires persistent typed wallet custody on a Monad network (#778)", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);

    await expect(
      chain.directMessages.send({
        wallet,
        recipient: alice.address,
        items: [{ type: "text", text: "hello" }],
      })
    ).rejects.toThrow(
      "Canonical direct messages require persistent typed wallet custody on a Monad network."
    );

    await expect(
      chain.directMessages.resolveUnattributedAttempts({
        wallet,
        payloadDigests: ["abc"],
      })
    ).rejects.toThrow(
      "Canonical direct messages require persistent typed wallet custody on a Monad network."
    );

    await expect(
      chain.directMessages.reconcileAttempts({
        wallet,
        payloadDigests: ["abc"],
      })
    ).rejects.toThrow(
      "Canonical direct messages require persistent typed wallet custody on a Monad network."
    );

    await expect(
      chain.directMessages.unattributedAttempts({ wallet, knownDigests: [] })
    ).rejects.toThrow(
      "Canonical direct messages require persistent typed wallet custody on a Monad network."
    );
  });

  describe("the legacy JSON mailbox goes through the canonical receive rule", () => {
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const jsonHex = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("hex");
    let spies: jest.SpyInstance[];
    let dispatch: jest.SpyInstance;
    let recovery: jest.SpyInstance;

    /** One message in Alice's legacy inbox whose decrypted plaintext is `plaintext`, from Bob. */
    function legacyInbox(plaintext: string) {
      dispatch = jest
        .spyOn(syncDispatch, "applyWalletSyncItem")
        .mockResolvedValue({});
      recovery = jest
        .spyOn(
          jest.requireMock<typeof import("../monad-stamp-client")>(
            "../monad-stamp-client"
          ),
          "recoverMonadStampPayments"
        )
        .mockReturnValue([]);
      spies = [
        dispatch,
        recovery,
        jest.spyOn(legacyEnvelope, "parseEnvelope").mockReturnValue({
          v: 1,
          from: bob.address.raw,
          to: alice.address.raw,
          networkTag: "MONT",
          salt: "",
          ciphertext: "",
        }),
        jest.spyOn(legacyEnvelope, "decryptEnvelope").mockReturnValue(plaintext),
      ];
      mockedFetchMonadProfile.mockResolvedValue({
        address: bob.address.raw,
        pubKey: bob.compressedPubKey,
      } as Awaited<ReturnType<typeof fetchMonadProfile>>);
      mockedFetchMonadMessagesSince.mockResolvedValue([
        {
          timestamp: 10,
          networkTag: new Uint8Array(),
          message: {
            encryptedPayload: new Uint8Array(),
            payloadHash: new Uint8Array(32),
            stampPayments: [],
          },
        },
      ]);
    }
    afterEach(() => {
      for (const spy of spies ?? []) spy.mockRestore();
      spies = [];
    });
    const read = (wallet = withItems(makeWallet(alice))) =>
      createEvmChain(TEST_CONFIG).directMessages.fetchSince({
        wallet,
        sinceMs: 0,
      });

    it.each(NEVER_FROM_A_PEER_SAMPLES.map((item) => [item.type, item] as const))(
      "a legacy %s item arrives as unsupported beside its text, and the read does not stop",
      async (type, item) => {
        legacyInbox(JSON.stringify([{ type: "text", text: "look" }, item]));
        // Twice: nothing about the message pins or fails a later read.
        for (let pass = 0; pass < 2; pass++) {
          const received = await read();
          expect(received).toHaveLength(1);
          expect(received[0].senderAddress.raw.toLowerCase()).toBe(
            bob.address.raw.toLowerCase()
          );
          expect(received[0].items).toEqual([
            { type: "text", text: "look" },
            {
              type: "unsupported",
              reason: "unknown-type",
              itemType: type,
              frame: jsonHex(item),
            },
          ]);
        }
        // A wallet sync record from the legacy mailbox reaches no wallet state.
        expect(dispatch).not.toHaveBeenCalled();
      }
    );

    it("an accepted swap offer from a peer is not delivered as an offer", async () => {
      const offer = {
        ...NEVER_FROM_A_PEER_SAMPLES.find((item) => item.type === "swap-offer")!,
        status: "accepted",
      };
      legacyInbox(JSON.stringify([offer]));
      const [message] = await read();
      expect(message.items.map((item) => item.type)).toEqual(["unsupported"]);
      expect(JSON.stringify(message.items)).not.toContain("accepted");
    });

    it("a legacy text message still arrives as text, and only what the plugin read of it", async () => {
      legacyInbox(
        JSON.stringify([{ type: "text", text: "ordinary", status: "accepted" }])
      );
      const received = await read();
      expect(received[0].items).toEqual([{ type: "text", text: "ordinary" }]);
    });

    it("a known type its plugin refuses arrives as malformed", async () => {
      legacyInbox(JSON.stringify([{ type: "dice", action: "cheat" }]));
      const received = await read();
      expect(received[0].items).toEqual([
        {
          type: "unsupported",
          reason: "malformed",
          itemType: "dice",
          frame: jsonHex({ type: "dice", action: "cheat" }),
        },
      ]);
    });

    it("stamp payments are still discovered for a message whose items are unsupported", async () => {
      legacyInbox(JSON.stringify([{ type: "wallet-sync" }]));
      const wallet = withItems(makeWallet(alice));
      wallet.stampPaymentJournal = new InMemoryStampPaymentJournal();
      const received = await read(wallet);
      expect(received[0].items.map((item) => item.type)).toEqual([
        "unsupported",
      ]);
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("an untyped wallet with no registry installed still reads, and every item is unsupported, never raw", async () => {
      const items = [
        { type: "text", text: "ordinary" },
        { type: "swap-offer", status: "accepted" },
      ];
      legacyInbox(JSON.stringify(items));
      const received = await read(makeWallet(alice));
      expect(received[0].items).toEqual(
        items.map((item) => ({
          type: "unsupported",
          reason: "unknown-type",
          itemType: item.type,
          frame: jsonHex(item),
        }))
      );
    });

    it("a legacy message too long to parse is refused as a whole and reported so the cursor passes", async () => {
      legacyInbox(
        JSON.stringify([{ type: "text", text: "x".repeat(1024 * 1024) }])
      );
      const parse = jest.spyOn(JSON, "parse");
      const passed: [number, string][] = [];
      try {
        const received = await createEvmChain(
          TEST_CONFIG
        ).directMessages.fetchSince({
          wallet: withItems(makeWallet(alice)),
          sinceMs: 0,
          onQuarantinedTimestamp: (time, digest) => passed.push([time, digest]),
        });
        expect(received).toEqual([]);
        expect(passed).toEqual([[10, "00".repeat(32)]]);
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    });
  });

  it("reports no stamp value for a legacy message, whatever payments it claims", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = withItems(makeWallet(alice));

    const txSigner = new Wallet(BOB_PRIVATE_KEY_HEX);
    const dest1 = "0x" + "aa".repeat(20);
    const dest2 = "0x" + "bb".repeat(20);
    const rawTx1 = await txSigner.signTransaction({
      to: dest1,
      value: 12345n,
      nonce: 0,
      gasLimit: 21000,
      gasPrice: 1000000000n,
      chainId: 10143,
    });
    const rawTx2 = await txSigner.signTransaction({
      to: dest2,
      value: 67890n,
      nonce: 1,
      gasLimit: 21000,
      gasPrice: 1000000000n,
      chainId: 10143,
    });

    const parsedTx1 = Transaction.from(rawTx1);
    const parsedTx2 = Transaction.from(rawTx2);

    const envelopeBytes = buildEnvelope({
      fromAddress: bob.address.raw,
      fromPrivateKey: bob.toNakamotoPrivateKey(),
      toAddress: alice.address.raw,
      toPubKey: getBytes(alice.compressedPubKey),
      plaintext: serializeMessageItems([{ type: "text", text: "hello alice" }]),
      networkTag: "MONT",
    });

    const payloadHashBytes = getBytes("0x" + "11".repeat(32));
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      {
        message: {
          encryptedPayload: envelopeBytes,
          payloadHash: payloadHashBytes,
          stampPayments: [
            { childIndex: 0, rawTx: getBytes(rawTx1) },
            { childIndex: 1, rawTx: getBytes(rawTx2) },
          ],
        },
        timestamp: 1600000000000,
        networkTag: getBytes("0x4d4f4e54"),
      },
    ]);

    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: bob.address.raw,
      pubKey: getBytes(bob.compressedPubKey),
    } as any);

    const received = await chain.directMessages.fetchSince({
      wallet,
      sinceMs: 0,
    });

    // The transactions a legacy message carries are its sender's claim: the relay delivers the
    // message whether or not they confirm, and these two do not even pay this wallet. Nothing is
    // reported as paid. (This test used to pin their sum, 80235 wei, as the stamp value.)
    expect(received).toHaveLength(1);
    expect(parsedTx1.value + parsedTx2.value).toBe(80235n);
    expect(received[0].stampValueWei).toBe(0n);
    // Where they pay is still listed: a stamp address is derived from the message, so this list
    // is what lets the funds be swept to a seed-derived address before the message is deleted.
    expect(received[0].stampPayments).toEqual([
      {
        txHash: parsedTx1.hash,
        destinationAddress: parsedTx1.to,
        valueWei: parsedTx1.value,
      },
      {
        txHash: parsedTx2.hash,
        destinationAddress: parsedTx2.to,
        valueWei: parsedTx2.value,
      },
    ]);

    expect(received[0].items).toEqual([{ type: "text", text: "hello alice" }]);
    expect(received[0].senderAddress.raw.toLowerCase()).toBe(
      bob.address.raw.toLowerCase()
    );
    expect(received[0].recipientAddress.raw.toLowerCase()).toBe(
      alice.address.raw.toLowerCase()
    );
    expect(received[0].payloadDigest).toBe("11".repeat(32));
    expect(received[0].receivedTime).toBe(1600000000000);
  });
});

describe("createEvmChain: one per-wallet queue for every account-spending operation", () => {
  it("sequential topic operations run one at a time through the wallet queue", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);
    allowMockTopicAdmission(wallet);
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const track = async <T>(name: string, work: () => Promise<T>) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      events.push(`start:${name}`);
      try {
        return await work();
      } finally {
        events.push(`end:${name}`);
        running -= 1;
      }
    };
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let callCount = 0;
    (MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
      resumePendingOperations: jest.fn().mockResolvedValue(undefined),
      submitTopicPost: () =>
        track("topic-post", async () => {
          callCount++;
          if (callCount === 1) await firstPending;
          return {
            stored: {},
            payloadHashHex: "feed",
            txHash: "0xt",
            leaseIndex: 0,
          };
        }),
    }));
    (wallet.pool.prepareBurnAccount as jest.Mock).mockImplementation(() =>
      track("burn-prepare", async () => ({ index: 4, fundingTxHashes: [] }))
    );

    const post1 = chain.topics.post({
      wallet,
      topic: "general",
      entries: [{ kind: "post", message: "hi 1" }],
      direction: "up",
      voteWeightWei: 5_000n,
    });
    const post2 = chain.topics.post({
      wallet,
      topic: "general",
      entries: [{ kind: "post", message: "hi 2" }],
      direction: "up",
      voteWeightWei: 5_000n,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([
      "start:burn-prepare",
      "end:burn-prepare",
      "start:topic-post",
    ]);
    finishFirst();
    await Promise.all([post1, post2]);
    expect(maxRunning).toBe(1);
  });
});

function allowMockTopicAdmission(wallet: ReturnType<typeof makeWallet>) {
  Object.assign(wallet, {
    walletState: {
      runOperation: (work: (admission: object) => Promise<unknown>) =>
        work({ walletBindingId: "topic-test" }),
    },
  });
}
describe("createEvmChain: topics.post", () => {
  it("submits a topic post via MonadTopicPostClient and returns its payloadDigest", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);
    allowMockTopicAdmission(wallet);

    const submitTopicPost = jest.fn().mockResolvedValue({
      stored: {},
      payloadHashHex: "feedface",
      txHash: "0xtx",
      leaseIndex: 0,
    });
    (MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
      submitTopicPost,
      resumePendingOperations: jest.fn().mockResolvedValue(undefined),
    }));

    const result = await chain.topics.post({
      wallet,
      topic: "general",
      entries: [{ kind: "post", message: "hello world" }],
      direction: "up",
      voteWeightWei: 5_000n,
      parentDigest: "aa".repeat(32),
    });

    expect(result).toEqual({ payloadDigest: "feedface" });
    expect(MonadTopicPostClient).toHaveBeenCalledWith(wallet);
    expect(submitTopicPost).toHaveBeenCalledTimes(1);
    const call = submitTopicPost.mock.calls[0][0];
    expect(call.topic).toBe("general");
    expect(call.direction).toBe("up");
    expect(call.voteWeightWei).toBe(5_000n);
    expect(call.burnAddress).toBe(TEST_CONFIG.stampBurnAddress);
    expect(hexlify(call.parentPostHash)).toBe("0x" + "aa".repeat(32));
    // #273: the burn account is prepared (funded) first and that exact account is leased.
    expect(wallet.pool.prepareBurnAccount).toHaveBeenCalledWith(
      expect.objectContaining({ burnValueWei: 5_000n, gasReserveWei: 100n })
    );
    expect(call.leaseIndex).toBe(4);
  });

  it("preserves an abandoned Monad post as a typed chain-neutral unknown outcome", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const wallet = makeWallet(
      MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    );
    allowMockTopicAdmission(wallet);
    const abandoned = new MonadTopicPostAbandonedError(
      "The paid post outcome is unknown",
      "feedface"
    );
    (MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
      submitTopicPost: jest.fn().mockRejectedValue(abandoned),
      resumePendingOperations: jest.fn().mockResolvedValue(undefined),
    }));

    const failure = await chain.topics
      .post({
        wallet,
        topic: "general",
        entries: [{ kind: "post", message: "hello world" }],
        direction: "up",
        voteWeightWei: 5_000n,
      })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TopicPostOutcomeUnknownError);
    expect(failure).toMatchObject({ cause: abandoned });
  });
});

describe("createEvmChain: topics.vote", () => {
  it("casts a vote via MonadTopicVoteClient", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);
    allowMockTopicAdmission(wallet);

    const castVote = jest.fn().mockResolvedValue({
      stored: {},
      targetPayloadHashHex: "aa".repeat(32),
      txHash: "0xtx",
      leaseIndex: 0,
    });
    (MonadTopicVoteClient as jest.Mock).mockImplementation(() => ({
      castVote,
      resumePendingOperations: jest.fn().mockResolvedValue(undefined),
    }));

    await chain.topics.vote({
      wallet,
      payloadDigest: "bb".repeat(32),
      voteWeightWei: 7_000n,
      direction: "down",
    });

    expect(MonadTopicVoteClient).toHaveBeenCalledWith(wallet);
    expect(castVote).toHaveBeenCalledTimes(1);
    const call = castVote.mock.calls[0][0];
    expect(hexlify(call.targetPayloadHash)).toBe("0x" + "bb".repeat(32));
    expect(call.direction).toBe("down");
    expect(call.voteWeightWei).toBe(7_000n);
    expect(call.burnAddress).toBe(TEST_CONFIG.stampBurnAddress);
    expect(wallet.pool.prepareBurnAccount).toHaveBeenCalledWith(
      expect.objectContaining({ burnValueWei: 7_000n })
    );
    expect(call.leaseIndex).toBe(4);
  });
});

describe("createEvmChain: canonical topic read wiring", () => {
  const policy = {
    network: "monad-testnet",
    chainId: BigInt(TEST_CONFIG.chainId),
    burnAddress: TEST_CONFIG.stampBurnAddress,
  };
  it("passes explicit read policy and preserves exact projected observations", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const wallet = makeWallet(
      MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    );
    const message = {
      poster: "0x" + "11".repeat(20),
      topic: "general",
      voteWeightWei: "-9007199254740993",
      entries: [],
      payloadDigest: "22".repeat(32),
      timestamp: new Date(0),
      visibleTimestamp: { seconds: "0", nanoseconds: 0 },
      epoch: "01".repeat(16),
      revision: "18446744073709551615",
      transactionHash: "33".repeat(32),
      authorBurnTx: "0x11",
      blockNumber: "0",
      transactionIndex: "0",
    };
    mockedFetchMonadTopicPostsSince.mockResolvedValueOnce([message]);
    expect(
      await chain.topics.fetchByTopic({ wallet, topic: "general", sinceMs: 42 })
    ).toEqual([message]);
    expect(mockedFetchMonadTopicPostsSince).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      topic: "general",
      sinceMs: 42,
      policy,
    });
    mockedFetchMonadTopicPostView.mockResolvedValueOnce(message);
    expect(await chain.topics.fetchOne(message.payloadDigest)).toEqual(message);
    expect(mockedFetchMonadTopicPostView).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
      payloadHashHex: message.payloadDigest,
      policy,
    });
    const topic = {
      topic: "general",
      postCount: "18446744073709551615",
      lastActivityMs: 0,
      lastActivity: { seconds: "0", nanoseconds: 0 },
      epoch: message.epoch,
      revision: message.revision,
    };
    mockedFetchDiscoveredTopics.mockResolvedValueOnce([topic]);
    expect(await chain.topics.discoverTopics()).toEqual([topic]);
    expect(mockedFetchDiscoveredTopics).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
      policy,
    });
  });
  it("propagates discovery failure", async () => {
    mockedFetchDiscoveredTopics.mockRejectedValueOnce(Error("incomplete"));
    await expect(
      createEvmChain(TEST_CONFIG).topics.discoverTopics()
    ).rejects.toThrow("incomplete");
  });
});

describe("asMonadWallet guard (exercised indirectly via directMessages/topics)", () => {
  it("throws a clear error when handed a bare WalletHandle missing the wallet-client bundle", async () => {
    const chain = createEvmChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bareWallet: WalletHandle = { identity: alice };

    await expect(
      chain.directMessages.fetchSince({ wallet: bareWallet, sinceMs: 0 })
    ).rejects.toThrow(/EvmChainWalletHandle/);
  });
});

describe("canonical topic owner production composition", () => {
  const seed = {
    mnemonic: "test test test test test test test test test test test junk",
  };
  it("retains old topic and stamp leases before factory orphan retirement and rejects a distinct same-root opener", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chain-topic-owner-"));
    const config = {
      ...TEST_CONFIG,
      walletStorageLocation: join(directory, "wallet"),
      subAccountPoolSize: 5,
    };
    let wallet: EvmChainWalletHandle | undefined;
    try {
      const firstChain = createEvmChain(config);
      wallet = await firstChain.createWallet(seed);
      const original = wallet.pool.records();
      for (let index = 0; index < 5; index++)
        wallet.pool.setStatus(index, "in-use");
      await wallet.pool.flush();
      const highWater = wallet.pool.nextUnusedIndex();
      const location = `${
        config.walletStorageLocation
      }-${wallet.identity.address.raw.toLowerCase()}`;
      await wallet.close();
      const database = level(join(location, "wallet-manifest"));
      const journal = new LevelTopicOperationJournal(database, () => {});
      const material = createMonadWalletMaterial(seed);
      const signed = await Promise.all(original.slice(0, 3).map(async (record, index) => {
        const signer = new Wallet(material.keyring.deriveSubAccount(index).privateKey);
        expect(signer.address).toBe(record.address);
        return signer.signTransaction({ chainId: BigInt(config.chainId), nonce: 0,
          to: config.stampBurnAddress, value: 7n, gasLimit: 21000n,
          maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, type: 2 });
      }));
      material.dispose();
      const rows: OutgoingTopicOperation[] = [
        undefined,
        "protobuf",
        "cbor",
      ].map((format, index) => ({
        version: 1,
        kind: "post",
        requestBytes: [255, index],
        ...(format ? { writeFormat: format as "protobuf" | "cbor" } : {}),
        leaseIndex: index,
        senderAddress: original[index].address,
        rawTx: signed[index],
        txHash: Transaction.from(signed[index]).hash!,
        valueWei: "7",
        direction: "up",
        payloadHashHex: "ab".repeat(32),
      }));
      try {
        for (const row of rows) await journal.put(row);
      } finally {
        await database.close();
      }
      const stamp = new LevelStampAttemptJournal(location);
      await stamp.Open();
      try {
        await stamp.put({
          payloadHashHex: "de".repeat(32),
          messageBytes: [1],
          leaseIndices: [3],
        });
      } finally {
        await stamp.Close();
      }
      jest.clearAllMocks();
      const chain = createEvmChain(config);
      wallet = await chain.createWallet(seed);
      expect(wallet.pool.records().map((record) => record.status)).toEqual([
        "in-use",
        "in-use",
        "in-use",
        "in-use",
        "retired",
      ]);
      expect(wallet.pool.records().map((record) => record.address)).toEqual(
        original.map((record) => record.address)
      );
      expect(wallet.pool.nextUnusedIndex()).toBe(highWater);
      expect(wallet.walletState).toBeUndefined();
      expect(wallet.topicOperationJournal).toBeUndefined();
      expect(MonadAccountTxSigner).not.toHaveBeenCalled();
      expect(MonadTopicPostClient).not.toHaveBeenCalled();
      expect(MonadTopicVoteClient).not.toHaveBeenCalled();
      await expect(createEvmChain(config).createWallet(seed)).rejects.toThrow(
        "manifest already has an owner"
      );
      // A rejected second opener must leave all original stores and the owner usable.
      expect(wallet.pool.records()).toHaveLength(5);
      await chain.topics.reconcileOperations({ wallet });
      const privateHandle = (MonadTopicPostClient as jest.Mock).mock
        .calls[0][0] as EvmWalletHandle;
      expect(privateHandle.topicOperationJournal!.getAll()).toEqual(rows);
      await wallet.close();
      const reopened = level(join(location, "wallet-manifest"));
      const reopenedJournal = new LevelTopicOperationJournal(
        reopened,
        () => {}
      );
      try {
        await reopenedJournal.Open();
        expect(reopenedJournal.getAll()).toEqual(rows);
      } finally {
        await reopened.close();
      }
    } finally {
      await wallet?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves the creator private owner across facades and drains an admitted action on close", async () => {
    const roots: MonadRootBundle = {
      evm: {
        registry: "frank-domain-roots-v1",
        purpose: "evm-wallet",
        bytes: new Uint8Array(32).fill(31),
      },
      authentication: {
        registry: "frank-domain-roots-v1",
        purpose: "identity-authentication",
        bytes: new Uint8Array(32).fill(32),
      },
      messaging: {
        registry: "frank-domain-roots-v1",
        purpose: "messaging-encryption",
        bytes: new Uint8Array(32).fill(33),
      },
    };
    const expected = createMonadWalletMaterial(roots);
    const chain = createEvmChain(TEST_CONFIG);
    const wallet = await chain.createWallet(roots);
    let privateHandle: EvmWalletHandle | undefined;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      finish = resolve;
    });
    (MonadTopicPostClient as jest.Mock).mockImplementation(
      (handle: EvmWalletHandle) => {
        privateHandle = handle;
        return {
          resumePendingOperations: async () => {
            entered();
            await paused;
          },
        };
      }
    );
    (MonadTopicVoteClient as jest.Mock).mockImplementation(() => ({
      resumePendingOperations: jest.fn().mockResolvedValue(undefined),
    }));
    try {
      expect(wallet.identity.address.raw).toBe(expected.identity.address.raw);
      expect((await wallet.getReceiveAddress()).raw).toBe(
        expected.mainAccount.address
      );
      expect(wallet.pool.getRecord(0)!.address).toBe(
        expected.keyring.deriveSubAccount(0).address
      );
      const other = createEvmChain({
        ...TEST_CONFIG,
        chainId: 143n,
        stampBurnAddress: "0x" + "22".repeat(20),
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      });
      const action = other.topics.reconcileOperations({ wallet });
      await started;
      expect(privateHandle).not.toBe(wallet);
      expect(privateHandle!.pool).toBe(wallet.pool);
      expect(privateHandle!.changePool).toBe(wallet.changePool);
      expect(privateHandle!.leaseManager).toBe(wallet.leaseManager);
      expect(privateHandle!.provider).toBe(wallet.provider);
      expect(privateHandle!.forumChainId).toBe(BigInt(TEST_CONFIG.chainId));
      expect(privateHandle!.forumBurnAddress).toBe(
        TEST_CONFIG.stampBurnAddress
      );
      expect(privateHandle!.cborNetwork).toBe("monad-testnet");
      expect(wallet.walletState).toBeUndefined();
      const close = wallet.close();
      expect(wallet.close()).toBe(close);
      let closed = false;
      void close.then(() => {
        closed = true;
      });
      await expect(
        chain.topics.reconcileOperations({ wallet })
      ).rejects.toThrow();
      expect(closed).toBe(false);
      finish();
      await action;
      await close;
      await expect(
        privateHandle!.walletState!.runOperation(async () => undefined)
      ).rejects.toThrow("enclosing wallet admission");
      expect(() => privateHandle!.walletState!.assertOpen()).toThrow(
        "closing or closed"
      );
    } finally {
      finish();
      await wallet.close();
      expected.dispose();
    }
  });
});

it("public revision-zero bridge rejects a valid foreign network descriptor without financial/network effects", async () => {
  const roots: MonadRootBundle = {
    evm: {
      registry: "frank-domain-roots-v1",
      purpose: "evm-wallet",
      bytes: new Uint8Array(32).fill(51),
    },
    authentication: {
      registry: "frank-domain-roots-v1",
      purpose: "identity-authentication",
      bytes: new Uint8Array(32).fill(52),
    },
    messaging: {
      registry: "frank-domain-roots-v1",
      purpose: "messaging-encryption",
      bytes: new Uint8Array(32).fill(53),
    },
  };
  const chain = createEvmChain(TEST_CONFIG),
    wallet = (await chain.createWallet(roots)) as EvmChainWalletHandle;
  const operator = createMonadWalletMaterial(roots);
  const point = operator.canonicalRoles!.publicGenerationZeroPoints().auth;
  const relay = {
    relayId: new Uint8Array(16).fill(1),
    endpoint: "https://a.example",
    identity: { keyType: 1, keyBytes: point },
    expiry: { seconds: 3700n, nanoseconds: 0 },
    unknownFields: new Map(),
  };
  const input = {
    networkTag: "MONT" as const,
    network: "monad-testnet",
    chainId: 10143n,
    issuedAt: { seconds: 100n, nanoseconds: 0 },
    expiresAt: { seconds: 3700n, nanoseconds: 0 },
    now: { seconds: 100n, nanoseconds: 0 },
    relay,
  };
  const statuses = wallet.pool.records();
  jest.clearAllMocks();
  try {
    expect(() =>
      prepareMonadRevisionZeroExport(wallet, {
        ...input,
        networkTag: "MON1",
        network: "monad-mainnet",
        chainId: 143n,
      })
    ).toThrow("actual installed wallet descriptor");
    expect(MonadAccountTxSigner).not.toHaveBeenCalled();
    expect(MonadStampClient).not.toHaveBeenCalled();
    expect(MonadTopicPostClient).not.toHaveBeenCalled();
    expect(MonadTopicVoteClient).not.toHaveBeenCalled();
    expect(wallet.pool.records()).toEqual(statuses);
    const output = prepareMonadRevisionZeroExport(wallet, input);
    expect(output.network).toBe("monad-testnet");
    expect(wallet.pool.records()).toEqual(statuses);
    await wallet.close();
    expect(() => prepareMonadRevisionZeroExport(wallet, input)).toThrow(
      "live typed wallet custody"
    );
  } finally {
    await wallet.close();
    operator.dispose();
  }
});
