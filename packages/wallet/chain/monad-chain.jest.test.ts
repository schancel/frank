/**
 * Unit tests for `monad-chain.ts` (ticket #41): verifies `MonadChain` (via `createMonadChain`)
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
import { Wallet, getBytes, hexlify } from "ethers";
import { PublicKey, crypto as bitcoreCrypto } from "bitcore-lib-xpi";

import { MonadIdentity } from "../monad-identity";
import { StoredMonadMessageProto } from "../monad-stamp-client";
import {
  MonadTopicPostAbandonedError,
  MonadTopicPostProto,
} from "../monad-topic-post-client";
import { buildTopicPostPayload } from "../monad-topic-post-client";
import { MessageItem, TextItem } from "@frank/cashweb/types/messages";
import {
  decryptEnvelope,
  parseEnvelope,
} from "@frank/cashweb/relay/monad-message-envelope";

import {
  MonadChainConfig,
  MonadChainWalletHandle,
  MAILBOX_RECOVERY_SYNC_INTERVAL_MS,
  MAILBOX_RECOVERY_SYNC_WAIT_MS,
  createMonadChain,
  deserializeMessageItems,
  serializeMessageItems,
  viewToForumMessage,
} from "./monad-chain";
import { TopicPostOutcomeUnknownError, WalletHandle } from "./active-chain";
import { deriveMonadStampChildPublic } from "../monad-stamp-stealth";
import { InMemoryStampPaymentJournal } from "../storage/stamp-payment-journal";

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
    })),
  };
});
// Explicit factories, not automocks: automock generation loads the real modules in an isolated
// registry, which makes `bitcore-lib-xpi`'s "more than one instance" guard throw.
jest.mock("@frank/cashweb/relay/monad-message-feed", () => ({
  fetchMonadMessagesSince: jest.fn(),
}));
jest.mock("@frank/cashweb/relay/monad-mailbox-client", () => ({
  ...jest.requireActual("@frank/cashweb/relay/monad-mailbox-client"),
  fetchMonadMailboxRecoveries: jest.fn(),
  ackMonadMailboxRecovery: jest.fn(),
}));
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadStampClient } = jest.requireMock("../monad-stamp-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicPostClient } = jest.requireMock("../monad-topic-post-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadTopicVoteClient } = jest.requireMock("../monad-topic-vote-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonadAccountTxSigner } = jest.requireMock("../monad-account-tx");
import { fetchMonadMessagesSince } from "@frank/cashweb/relay/monad-message-feed";
import {
  ackMonadMailboxRecovery,
  fetchMonadMailboxRecoveries,
} from "@frank/cashweb/relay/monad-mailbox-client";
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from "../monad-topic-tally-client";
import { fetchMonadProfile } from "../monad-identity";

const mockedFetchRecoveries =
  fetchMonadMailboxRecoveries as jest.MockedFunction<
    typeof fetchMonadMailboxRecoveries
  >;
const mockedAckRecovery = ackMonadMailboxRecovery as jest.MockedFunction<
  typeof ackMonadMailboxRecovery
>;
const mockedFetchMonadMessagesSince =
  fetchMonadMessagesSince as jest.MockedFunction<
    typeof fetchMonadMessagesSince
  >;
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

const TEST_CONFIG: MonadChainConfig = {
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

function makeWallet(identity: MonadIdentity): MonadChainWalletHandle {
  return {
    identity,
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
    } as unknown as MonadChainWalletHandle["pool"],
    leaseManager: {} as MonadChainWalletHandle["leaseManager"],
    provider: {} as MonadChainWalletHandle["provider"],
    httpClient: {} as MonadChainWalletHandle["httpClient"],
    relayBaseUrl: "http://relay.test",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFetchRecoveries.mockResolvedValue({ records: [] });
  mockedAckRecovery.mockResolvedValue(undefined);
});

describe("createMonadChain: basic chain properties", () => {
  const chain = createMonadChain(TEST_CONFIG);

  it("exposes the Monad name/unit", () => {
    expect(chain.name).toBe("monad");
    expect(chain.unit).toBe("MON");
    expect(chain.defaultTopicVoteValue).toBe(
      TEST_CONFIG.defaultTopicVoteValueWei
    );
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

describe("createMonadChain: createWallet", () => {
  const chain = createMonadChain(TEST_CONFIG);
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

  it("pre-derives unfunded accounts without moving funds on wallet open", async () => {
    const wallet = (await chain.createWallet(seed)) as MonadChainWalletHandle;
    const records = wallet.pool.ensureSize(0);
    expect(records).toHaveLength(TEST_CONFIG.subAccountPoolSize);
    expect(records.every((record) => record.status === "unfunded")).toBe(true);
    expect(MonadAccountTxSigner).not.toHaveBeenCalled();
  });
});

describe("createMonadChain: fetchProfile", () => {
  it("delegates to monad-identity.fetchMonadProfile with the chain relayBaseUrl", async () => {
    const chain = createMonadChain(TEST_CONFIG);
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
    const chain = createMonadChain(TEST_CONFIG);
    mockedFetchMonadProfile.mockResolvedValueOnce(undefined);
    expect(
      await chain.fetchProfile({ raw: "0x" + "00".repeat(20) })
    ).toBeUndefined();
  });

  it("uses opts.relayBaseUrl instead of the chain default when given (ticket #78)", async () => {
    const chain = createMonadChain(TEST_CONFIG);
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

describe("createMonadChain: nativeTransfers", () => {
  it("reads the stable identity EOA balance from the Monad provider", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(identity);
    const getBalance = jest.fn().mockResolvedValue(123n);
    wallet.provider = { getBalance } as MonadChainWalletHandle["provider"];

    await expect(chain.nativeTransfers.getBalance({ wallet })).resolves.toBe(
      123n
    );
    expect(getBalance).toHaveBeenCalledWith(identity.address.raw);
  });

  it("builds and submits a plain transfer from the stable identity EOA", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(identity);
    const recipient = chain.parseAddress(
      "0x000000000000000000000000000000000000dead"
    );
    expect(recipient).toBeDefined();

    const signed = { txHash: "0xsigned" };
    const buildAndSignTransfer = jest.fn().mockResolvedValue(signed);
    const submit = jest.fn().mockResolvedValue("0xbroadcast");
    (MonadAccountTxSigner as jest.Mock).mockImplementation(() => ({
      buildAndSignTransfer,
      submit,
    }));

    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: recipient!,
        value: 1_500_000_000_000_000_000n,
      })
    ).resolves.toEqual({ txHash: "0xbroadcast" });

    expect(MonadAccountTxSigner).toHaveBeenCalledWith({
      privateKey: identity.toPrivateKeyHex(),
      provider: wallet.provider,
      httpClient: wallet.httpClient,
    });
    expect(buildAndSignTransfer).toHaveBeenCalledWith(
      recipient!.raw,
      1_500_000_000_000_000_000n
    );
    expect(submit).toHaveBeenCalledWith(signed);
  });

  it("awaits onSigned with the hash BEFORE broadcasting, and a failing onSigned broadcasts nothing", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(identity);
    const order: string[] = [];
    const buildAndSignTransfer = jest
      .fn()
      .mockResolvedValue({ txHash: "0xsigned" });
    const submit = jest.fn(async () => {
      order.push("submit");
      return "0xsigned";
    });
    (MonadAccountTxSigner as jest.Mock).mockImplementation(() => ({
      buildAndSignTransfer,
      submit,
    }));
    await chain.nativeTransfers.send({
      wallet,
      recipient: identity.address,
      value: 1n,
      onSigned: async ({ txHash }) => {
        await Promise.resolve();
        order.push(`signed:${txHash}`);
      },
    });
    expect(order).toEqual(["signed:0xsigned", "submit"]);

    submit.mockClear();
    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: identity.address,
        value: 1n,
        onSigned: async () => {
          throw new Error("disk full");
        },
      })
    ).rejects.toThrow("disk full");
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports a transaction hash as confirmed / failed / pending / unknown from the node", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const wallet = makeWallet(
      MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    );
    const getTransactionReceipt = jest.fn();
    const getTransaction = jest.fn();
    wallet.provider = {
      getTransactionReceipt,
      getTransaction,
    } as unknown as MonadChainWalletHandle["provider"];
    const status = () =>
      chain.nativeTransfers.getTransactionStatus({ wallet, txHash: "0xh" });
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

  it("rejects zero-value transfers before constructing a signer", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const identity = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);

    await expect(
      chain.nativeTransfers.send({
        wallet: makeWallet(identity),
        recipient: identity.address,
        value: 0n,
      })
    ).rejects.toThrow("Transfer value must be greater than zero");
    expect(MonadAccountTxSigner).not.toHaveBeenCalled();
  });
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

  it("rejects stealth items -- no Monad UTXO-payment equivalent exists", () => {
    expect(() =>
      serializeMessageItems([{ type: "stealth", amount: 1000 }])
    ).toThrow(/stealth/);
  });

  it("rejects p2pkh items for the same reason", () => {
    expect(() =>
      serializeMessageItems([{ type: "p2pkh", address: "0xabc", amount: 1000 }])
    ).toThrow(/p2pkh/);
  });
});

describe("createMonadChain: directMessages.send", () => {
  it("uses the ordinary encrypted stamped relay path when sender and recipient are the same (#420)", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);

    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    });

    const submitStampedMessage = jest.fn().mockResolvedValue({
      stored: {} as StoredMonadMessageProto,
      payloadHashHex: "self-digest",
      txHashes: ["0xstamp"],
      leaseIndices: [0],
    });
    (MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage,
    }));

    const items: MessageItem[] = [{ type: "text", text: "note to self" }];
    await expect(
      chain.directMessages.send({
        wallet,
        recipient: alice.address,
        items,
        stampValue: 9000n,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        payloadDigest: "self-digest",
        stampValueWei: 9000n,
      })
    );

    expect(wallet.pool.prepareStampInventory).toHaveBeenCalledWith(
      expect.objectContaining({ stampValueWei: 9000n })
    );
    expect(submitStampedMessage).toHaveBeenCalledTimes(1);
    const call = submitStampedMessage.mock.calls[0][0];
    expect(call.recipientPublicKey).toEqual(
      new Uint8Array(alice.compressedPubKey)
    );
    expect(call.stampValueWei).toBe(9000n);

    const envelope = parseEnvelope(call.encryptedPayload);
    expect(envelope).toBeDefined();
    expect(envelope?.from).toBe(alice.address.raw);
    expect(envelope?.to).toBe(alice.address.raw);
    expect(
      JSON.parse(
        decryptEnvelope({
          envelope: envelope!,
          myPrivateKey: alice.toNakamotoPrivateKey(),
          senderPubKey: alice.compressedPubKey,
        })
      )
    ).toEqual(items);
  });

  it("encrypts the items and submits a real stamped message via MonadStampClient", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);

    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: bob.address,
      pubKey: new Uint8Array(bob.compressedPubKey),
    });

    const submitStampedMessage = jest.fn().mockResolvedValue({
      stored: {} as StoredMonadMessageProto,
      payloadHashHex: "deadbeef",
      txHashes: ["0xtx"],
      leaseIndices: [0],
    });
    (MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage,
    }));

    const items: MessageItem[] = [{ type: "text", text: "hi bob" } as TextItem];
    const onPreparationProgress = jest.fn();
    const requestedStampValue = TEST_CONFIG.defaultStampValueWei * 2n;
    const result = await chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items,
      stampValue: requestedStampValue,
      onPreparationProgress,
    });

    expect(result).toEqual({
      payloadDigest: "deadbeef",
      stampValueWei: requestedStampValue,
      stampPayments: [],
      preparationTxHashes: [],
    });
    expect(mockedFetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      address: bob.address,
    });
    expect(MonadStampClient).toHaveBeenCalledWith(wallet);
    expect(wallet.pool.prepareStampInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        stampValueWei: requestedStampValue,
        onProgress: onPreparationProgress,
      })
    );
    expect(submitStampedMessage).toHaveBeenCalledTimes(1);
    const call = submitStampedMessage.mock.calls[0][0];
    // Ticket #57: a DM's stamp pays the recipient -- it must NOT be the fixed
    // `stampBurnAddress` (that's `topics.post`/`vote`'s job, no single recipient there).
    expect(call.recipientPublicKey).toEqual(
      new Uint8Array(bob.compressedPubKey)
    );
    expect(call.stampValueWei).toBe(requestedStampValue);
    // The envelope is real, encrypted JSON -- not the plaintext items themselves.
    const envelopeJson = JSON.parse(
      new TextDecoder().decode(call.encryptedPayload)
    );
    expect(envelopeJson.from).toBe(alice.address.raw);
    expect(envelopeJson.to).toBe(bob.address.raw);
    expect(typeof envelopeJson.ciphertext).toBe("string");
    expect(JSON.stringify(items)).not.toContain(envelopeJson.ciphertext);
  });

  it("throws if no profile/pubkey is registered for the recipient", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    mockedFetchMonadProfile.mockResolvedValueOnce(undefined);

    await expect(
      chain.directMessages.send({
        wallet: makeWallet(alice),
        recipient: bob.address,
        items: [{ type: "text", text: "hi" }],
      })
    ).rejects.toThrow(/No registered profile/);
  });

  it("serializes concurrent sends through preparation, payment, and relay submission", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);
    mockedFetchMonadProfile.mockResolvedValue({
      address: bob.address,
      pubKey: new Uint8Array(bob.compressedPubKey),
    });

    let finishFirst!: (value: unknown) => void;
    const firstPending = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const submitStampedMessage = jest
      .fn()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce({ payloadHashHex: "second" });
    (MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage,
    }));

    const first = chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items: [{ type: "text", text: "first" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items: [{ type: "text", text: "second" }],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(submitStampedMessage).toHaveBeenCalledTimes(1);
    expect(mockedFetchMonadProfile).toHaveBeenCalledTimes(1);

    finishFirst({ payloadHashHex: "first" });
    await expect(first).resolves.toEqual(
      expect.objectContaining({ payloadDigest: "first" })
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({ payloadDigest: "second" })
    );
    expect(submitStampedMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported item kinds before ever calling fetchProfile/MonadStampClient", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);

    await expect(
      chain.directMessages.send({
        wallet: makeWallet(alice),
        recipient: bob.address,
        items: [{ type: "stealth", amount: 1 }],
      })
    ).rejects.toThrow(/stealth/);
    expect(mockedFetchMonadProfile).not.toHaveBeenCalled();
  });
});

describe("createMonadChain: directMessages.reconcileAttempts (#269/#270)", () => {
  it("passes onAttemptCreated through to the stamp client as onAttemptJournaled", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: bob.address,
      pubKey: new Uint8Array(bob.compressedPubKey),
    });
    const submitStampedMessage = jest.fn().mockResolvedValue({
      stored: {} as StoredMonadMessageProto,
      payloadHashHex: "deadbeef",
      txHashes: [],
      leaseIndices: [],
    });
    (MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage,
    }));
    const onAttemptCreated = jest.fn();
    await chain.directMessages.send({
      wallet: makeWallet(alice),
      recipient: bob.address,
      items: [{ type: "text", text: "x" } as TextItem],
      onAttemptCreated,
    });
    expect(submitStampedMessage.mock.calls[0][0].onAttemptJournaled).toBe(
      onAttemptCreated
    );
  });

  it("re-sends the live attempts (never signs a payment) and reports each requested digest", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const resumePendingAttempts = jest.fn().mockResolvedValue([]);
    const submitStampedMessage = jest.fn();
    const statuses: Record<string, string> = {
      live1: "live",
      done: "delivered",
    };
    (MonadStampClient as jest.Mock).mockImplementation(() => ({
      resumePendingAttempts,
      submitStampedMessage,
      attemptStatus: (digest: string) => statuses[digest] ?? "unknown",
    }));
    await expect(
      chain.directMessages.reconcileAttempts({
        wallet: makeWallet(alice),
        payloadDigests: ["live1", "done", "other"],
      })
    ).resolves.toEqual({ live1: "live", done: "delivered", other: "unknown" });
    expect(resumePendingAttempts).toHaveBeenCalledWith({ maxAttempts: 1 });
    expect(submitStampedMessage).not.toHaveBeenCalled();
  });
});

describe("createMonadChain: directMessages.unattributedAttempts (#269)", () => {
  it("resumes live attempts and returns recorded hashes no message points at", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const resumePendingAttempts = jest.fn().mockResolvedValue([]);
    (MonadStampClient as jest.Mock).mockImplementation(() => ({
      resumePendingAttempts,
      recordedAttempts: () => [
        { payloadHashHex: "mine", status: "delivered" },
        { payloadHashHex: "orphan", status: "live" },
      ],
    }));
    await expect(
      chain.directMessages.unattributedAttempts({
        wallet: makeWallet(alice),
        knownDigests: ["mine"],
      })
    ).resolves.toEqual(["orphan"]);
    expect(resumePendingAttempts).toHaveBeenCalledTimes(1);
  });
});

describe("createMonadChain: directMessages.fetchSince", () => {
  it("reports a permanently absent sender for durable quarantine instead of pinning the scan", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(bob);
    const { buildEnvelope } = jest.requireActual(
      "@frank/cashweb/relay/monad-message-envelope"
    );
    const encryptedPayload: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toNakamotoPrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems([{ type: "text", text: "poison" }]),
      networkTag: TEST_CONFIG.networkTag,
    });
    const validPayload: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toNakamotoPrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems([{ type: "text", text: "real mail" }]),
      networkTag: TEST_CONFIG.networkTag,
    });
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      {
        message: {
          stampPayments: [],
          encryptedPayload,
          payloadHash: getBytes(`0x${"aa".repeat(32)}`),
        },
        timestamp: 700,
        networkTag: new Uint8Array(0),
      },
      {
        message: {
          stampPayments: [],
          encryptedPayload: validPayload,
          payloadHash: getBytes(`0x${"bb".repeat(32)}`),
        },
        timestamp: 900,
        networkTag: new Uint8Array(0),
      },
    ]);
    // A 404 is the registry's authoritative answer that the sender account does not exist:
    // no retry can ever translate the row. The transport failure below is the transient case.
    mockedFetchMonadProfile.mockResolvedValueOnce(undefined);
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    });
    const onIncompleteTimestamp = jest.fn();
    const onQuarantinedTimestamp = jest.fn();

    const received = await chain.directMessages.fetchSince({
      wallet,
      sinceMs: 0,
      onIncompleteTimestamp,
      onQuarantinedTimestamp,
    });
    // The permanently absent sender's row is omitted and reported with its digest, and it
    // holds nothing back: the later valid row is still delivered (bounded backlog).
    expect(onQuarantinedTimestamp).toHaveBeenCalledTimes(1);
    expect(onQuarantinedTimestamp).toHaveBeenCalledWith(700, "aa".repeat(32));
    expect(onIncompleteTimestamp).not.toHaveBeenCalled();
    expect(received).toEqual([
      expect.objectContaining({
        payloadDigest: "bb".repeat(32),
        receivedTime: 900,
      }),
    ]);
  });

  it("grants no cursor authority when the sender profile lookup fails transiently", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(bob);
    const { buildEnvelope } = jest.requireActual(
      "@frank/cashweb/relay/monad-message-envelope"
    );
    const encryptedPayload: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toNakamotoPrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems([{ type: "text", text: "retry me" }]),
      networkTag: TEST_CONFIG.networkTag,
    });
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      {
        message: {
          stampPayments: [],
          encryptedPayload,
          payloadHash: getBytes(`0x${"aa".repeat(32)}`),
        },
        timestamp: 700,
        networkTag: new Uint8Array(0),
      },
    ]);
    // A transport failure is retryable, not terminal: the scan aborts without reporting
    // quarantine or delivering anything, so the row stays in the replay window.
    mockedFetchMonadProfile.mockRejectedValueOnce(
      new Error("relay unreachable")
    );
    const onIncompleteTimestamp = jest.fn();
    const onQuarantinedTimestamp = jest.fn();

    await expect(
      chain.directMessages.fetchSince({
        wallet,
        sinceMs: 0,
        onIncompleteTimestamp,
        onQuarantinedTimestamp,
      })
    ).rejects.toThrow("relay unreachable");
    expect(onQuarantinedTimestamp).not.toHaveBeenCalled();
    expect(onIncompleteTimestamp).not.toHaveBeenCalled();
  });

  it("rejects authenticated malformed plaintext per record and returns the following message", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(bob);
    const { buildEnvelope } = jest.requireActual(
      "@frank/cashweb/relay/monad-message-envelope"
    );
    const envelope = (plaintext: string): Uint8Array =>
      buildEnvelope({
        fromAddress: alice.address.raw,
        fromPrivateKey: alice.toNakamotoPrivateKey(),
        toAddress: bob.address.raw,
        toPubKey: bob.compressedPubKey,
        plaintext,
        networkTag: TEST_CONFIG.networkTag,
      });
    const record = (
      plaintext: string,
      payloadByte: string,
      timestamp: number
    ): StoredMonadMessageProto => ({
      message: {
        stampPayments: [],
        encryptedPayload: envelope(plaintext),
        payloadHash: getBytes(`0x${payloadByte.repeat(32)}`),
      },
      timestamp,
      networkTag: new Uint8Array(0),
    });
    const validItems: MessageItem[] = [{ type: "text", text: "after poison" }];
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      record("{authenticated but not message items", "aa", 100),
      record(serializeMessageItems(validItems), "bb", 200),
    ]);
    mockedFetchMonadProfile.mockResolvedValue({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    });

    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toEqual([
      expect.objectContaining({
        items: validItems,
        payloadDigest: "bb".repeat(32),
        receivedTime: 200,
      }),
    ]);
  });

  it("decrypts envelopes addressed to the wallet and skips everything else", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(bob);
    const stampPaymentJournal = new InMemoryStampPaymentJournal();
    wallet.stampPaymentJournal = stampPaymentJournal;
    wallet.provider = {
      getBalance: jest.fn().mockResolvedValue(0n),
      getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1n }),
    } as unknown as MonadChainWalletHandle["provider"];

    // Build a real envelope from Alice to Bob, exactly the way `directMessages.send` would.
    const { buildEnvelope } = jest.requireActual(
      "@frank/cashweb/relay/monad-message-envelope"
    );
    const items: MessageItem[] = [{ type: "text", text: "hi bob" }];
    const envelopeBytes: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toNakamotoPrivateKey(),
      toAddress: bob.address.raw,
      toPubKey: bob.compressedPubKey,
      plaintext: serializeMessageItems(items),
      networkTag: TEST_CONFIG.networkTag,
    });

    const payloadHash = getBytes("0x" + "ab".repeat(32));
    const stampDestination = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: new Uint8Array(bob.compressedPubKey),
      paymentIndex: 0,
    });
    const rawStampPayment = await new Wallet(
      ALICE_PRIVATE_KEY_HEX
    ).signTransaction({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: stampDestination.address,
      value: 123n,
      gasLimit: 60_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    const addressedToBob: StoredMonadMessageProto = {
      message: {
        stampPayments: [{ childIndex: 0, rawTx: getBytes(rawStampPayment) }],
        encryptedPayload: envelopeBytes,
        payloadHash,
      },
      timestamp: 1_700_000_000_000,
      networkTag: new Uint8Array(0),
    };
    const notAnEnvelope: StoredMonadMessageProto = {
      message: {
        stampPayments: [],
        encryptedPayload: new TextEncoder().encode(
          JSON.stringify({ hello: "world" })
        ),
        payloadHash: getBytes("0x" + "cd".repeat(32)),
      },
      timestamp: 1_700_000_001_000,
      networkTag: new Uint8Array(0),
    };

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      addressedToBob,
      notAnEnvelope,
    ]);
    mockedFetchMonadProfile.mockResolvedValueOnce({
      address: alice.address,
      pubKey: new Uint8Array(alice.compressedPubKey),
    });

    const received = await chain.directMessages.fetchSince({
      wallet,
      sinceMs: 0,
    });

    // The inbox is the wallet's OWN mailbox, authenticated with its identity key.
    expect(mockedFetchMonadMessagesSince).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      recipient: bob.address.raw,
      signDigest: expect.any(Function),
      sinceMs: 0,
    });
    const { signDigest } = mockedFetchMonadMessagesSince.mock.calls[0][0];
    const digest = new Uint8Array(32).fill(7);
    const der = Buffer.from(await signDigest(digest));
    expect(
      bitcoreCrypto.ECDSA.verify(
        Buffer.from(digest),
        bitcoreCrypto.Signature.fromDER(der),
        PublicKey.fromBuffer(bob.compressedPubKey)
      )
    ).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].senderAddress.raw).toBe(alice.address.raw);
    expect(received[0].recipientAddress.raw).toBe(bob.address.raw);
    expect(received[0].items).toEqual(items);
    expect(received[0].payloadDigest).toBe("ab".repeat(32));
    expect(received[0].stampValueWei).toBe(123n);
    expect(received[0].receivedTime).toBe(1_700_000_000_000);
    expect(stampPaymentJournal.get("ab".repeat(32), 0)).toMatchObject({
      payloadHashHex: "ab".repeat(32),
      childIndex: 0,
      address: stampDestination.address,
      valueWei: "123",
      status: "discovered",
    });
    expect(stampPaymentJournal.get("ab".repeat(32), 0)).not.toHaveProperty(
      "privateKey"
    );
    await expect(
      chain.directMessages.listRecoveredStampPayments({ wallet })
    ).resolves.toEqual([
      expect.objectContaining({
        payloadDigest: "ab".repeat(32),
        childIndex: 0,
        address: { raw: stampDestination.address },
        valueWei: 123n,
        status: "discovered",
      }),
    ]);
  });

  it("skips envelopes addressed to someone else", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX);

    const { buildEnvelope } = jest.requireActual(
      "@frank/cashweb/relay/monad-message-envelope"
    );
    const envelopeBytes: Uint8Array = buildEnvelope({
      fromAddress: alice.address.raw,
      fromPrivateKey: alice.toNakamotoPrivateKey(),
      toAddress: eve.address.raw,
      toPubKey: eve.compressedPubKey,
      plaintext: serializeMessageItems([{ type: "text", text: "not for bob" }]),
      networkTag: TEST_CONFIG.networkTag,
    });

    mockedFetchMonadMessagesSince.mockResolvedValueOnce([
      {
        message: {
          stampPayments: [],
          encryptedPayload: envelopeBytes,
          payloadHash: getBytes("0x" + "ef".repeat(32)),
        },
        timestamp: 1_700_000_000_000,
        networkTag: new Uint8Array(0),
      },
    ]);

    const received = await chain.directMessages.fetchSince({
      wallet: makeWallet(bob),
      sinceMs: 0,
    });

    expect(received).toHaveLength(0);
    expect(mockedFetchMonadProfile).not.toHaveBeenCalled();
  });

  it("explicitly sweeps a journaled recipient child and marks it swept", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const eve = MonadIdentity.fromPrivateKeyHex(EVE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(bob);
    const journal = new InMemoryStampPaymentJournal();
    wallet.stampPaymentJournal = journal;
    const payloadDigest = "ab".repeat(32);
    const child = deriveMonadStampChildPublic({
      payloadHash: getBytes(`0x${payloadDigest}`),
      recipientPublicKey: new Uint8Array(bob.compressedPubKey),
      paymentIndex: 0,
    });
    await journal.put({
      payloadHashHex: payloadDigest,
      childIndex: 0,
      txHash: `0x${"12".repeat(32)}`,
      address: child.address,
      valueWei: "10000",
      status: "discovered",
    });
    wallet.provider = {
      getBalance: jest.fn().mockResolvedValue(100_000n),
      getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1n }),
    } as unknown as MonadChainWalletHandle["provider"];
    const sweepTxHash = `0x${"34".repeat(32)}`;
    const signedSweep = {
      to: eve.address.raw,
      value: 58_000n,
      txHash: sweepTxHash,
      rawTx: "0xsigned",
    };
    MonadAccountTxSigner.mockImplementationOnce(() => ({
      address: child.address,
      buildAndSignTransfer: jest.fn().mockResolvedValue(signedSweep),
      submit: jest.fn().mockResolvedValue(sweepTxHash),
      getStatus: jest.fn().mockResolvedValue("pending"),
    }));

    await expect(
      chain.directMessages.sweepRecoveredStampPayment({
        wallet,
        payloadDigest,
        childIndex: 0,
        destination: eve.address,
      })
    ).resolves.toEqual({
      swept: false,
      reason: "pending",
      txHash: sweepTxHash,
      valueWei: 58_000n,
      destinationAddress: eve.address.raw,
    });
    expect(journal.get(payloadDigest, 0)).toMatchObject({
      status: "sweep-pending",
      sweepTxHash,
      sweepRawTx: "0xsigned",
    });

    MonadAccountTxSigner.mockImplementationOnce(() => ({
      address: child.address,
      getStatus: jest.fn().mockResolvedValue("confirmed"),
    }));

    await expect(
      chain.directMessages.sweepRecoveredStampPayment({
        wallet,
        payloadDigest,
        childIndex: 0,
        destination: eve.address,
      })
    ).resolves.toEqual({
      swept: true,
      txHash: sweepTxHash,
      valueWei: 58_000n,
    });
    expect(journal.get(payloadDigest, 0)).toMatchObject({
      status: "swept",
      sweepTxHash,
    });
  });
});

describe("createMonadChain: one per-wallet queue for every account-spending operation", () => {
  it("a slow direct-message send blocks reconcile, the unattributed check and a topic burn until it settles, then they run one at a time in order", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);
    mockedFetchMonadProfile.mockResolvedValue({
      address: bob.address,
      pubKey: new Uint8Array(bob.compressedPubKey),
    });
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
    let finishSend!: (value: unknown) => void;
    const sendPending = new Promise((resolve) => {
      finishSend = resolve;
    });
    (MonadStampClient as jest.Mock).mockImplementation(() => ({
      submitStampedMessage: () => track("dm-send", () => sendPending),
      resumePendingAttempts: () =>
        track("resume", async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return [];
        }),
      attemptStatus: () => "unknown",
      recordedAttempts: () => [],
    }));
    (MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
      submitTopicPost: () =>
        track("topic-post", async () => ({
          stored: {},
          payloadHashHex: "feed",
          txHash: "0xt",
          leaseIndex: 0,
        })),
    }));
    (wallet.pool.prepareBurnAccount as jest.Mock).mockImplementation(() =>
      track("burn-prepare", async () => ({ index: 4, fundingTxHashes: [] }))
    );

    const send = chain.directMessages.send({
      wallet,
      recipient: bob.address,
      items: [{ type: "text", text: "x" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const others = [
      chain.directMessages.reconcileAttempts({
        wallet,
        payloadDigests: ["a"],
      }),
      chain.directMessages.unattributedAttempts({
        wallet,
        knownDigests: [],
      }),
      chain.topics.post({
        wallet,
        topic: "general",
        entries: [{ kind: "post", message: "hi" }],
        direction: "up",
        voteWeightWei: 5_000n,
      }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    // Only the first send has started; nothing else touched the wallet's accounts meanwhile.
    expect(events).toEqual(["start:dm-send"]);

    finishSend({ payloadHashHex: "first" });
    await send;
    await Promise.all(others);
    expect(maxRunning).toBe(1); // never two account-touching operations at once
    expect(events.filter((e) => e.startsWith("start:"))).toEqual([
      "start:dm-send",
      "start:resume",
      "start:resume",
      "start:burn-prepare",
      "start:topic-post",
    ]);
  });
});

describe("createMonadChain: topics.post", () => {
  it("submits a topic post via MonadTopicPostClient and returns its payloadDigest", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);

    const submitTopicPost = jest.fn().mockResolvedValue({
      stored: {},
      payloadHashHex: "feedface",
      txHash: "0xtx",
      leaseIndex: 0,
    });
    (MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
      submitTopicPost,
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
    const chain = createMonadChain(TEST_CONFIG);
    const wallet = makeWallet(
      MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX)
    );
    const abandoned = new MonadTopicPostAbandonedError(
      "The paid post outcome is unknown",
      "feedface"
    );
    (MonadTopicPostClient as jest.Mock).mockImplementation(() => ({
      submitTopicPost: jest.fn().mockRejectedValue(abandoned),
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

describe("createMonadChain: topics.vote", () => {
  it("casts a vote via MonadTopicVoteClient", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);

    const castVote = jest.fn().mockResolvedValue({
      stored: {},
      targetPayloadHashHex: "aa".repeat(32),
      txHash: "0xtx",
      leaseIndex: 0,
    });
    (MonadTopicVoteClient as jest.Mock).mockImplementation(() => ({
      castVote,
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

function makeTopicPostProto(payloadHashByte: number): MonadTopicPostProto {
  return {
    topic: "general",
    parentPostHash: new Uint8Array(0),
    rawBurnTx: new Uint8Array([1, 2, 3]),
    encryptedPayload: buildTopicPostPayload({
      topic: "general",
      entries: [{ kind: "post", title: "Hi", message: "Hello, topic!" }],
      timestampMs: 1_700_000_000_000,
    }),
    payloadHash: new Uint8Array(32).fill(payloadHashByte),
  };
}

describe("createMonadChain: topics.fetchByTopic / fetchOne / viewToForumMessage", () => {
  it("viewToForumMessage decodes a real BroadcastMessage payload into ForumMessage", () => {
    const post = makeTopicPostProto(0x11);
    const view = {
      post: {
        post,
        senderAddress: getBytes("0x" + "55".repeat(20)),
        txHash: getBytes("0x" + "66".repeat(32)),
        timestamp: 1_700_000_005_000,
        networkTag: new Uint8Array(0),
      },
      voteWeight: 12_345,
    };

    const message = viewToForumMessage(view);

    expect(message).toBeDefined();
    expect(message?.topic).toBe("general");
    expect(message?.satoshis).toBe(12_345);
    expect(message?.payloadDigest).toBe("11".repeat(32));
    expect(message?.parentDigest).toBeUndefined();
    expect(message?.poster).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(message?.entries).toEqual([
      { kind: "post", title: "Hi", url: "", message: "Hello, topic!" },
    ]);
    expect(message?.timestamp).toEqual(new Date(1_700_000_005_000));
  });

  it("viewToForumMessage returns undefined for a view with no stored post", () => {
    expect(
      viewToForumMessage({ post: undefined, voteWeight: 0 })
    ).toBeUndefined();
  });

  it("fetchByTopic maps every returned view via viewToForumMessage", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const wallet = makeWallet(alice);
    const post = makeTopicPostProto(0x22);

    mockedFetchMonadTopicPostsSince.mockResolvedValueOnce([
      {
        post: {
          post,
          senderAddress: getBytes("0x" + "77".repeat(20)),
          txHash: getBytes("0x" + "88".repeat(32)),
          timestamp: 1_700_000_010_000,
          networkTag: new Uint8Array(0),
        },
        voteWeight: 999,
      },
    ]);

    const messages = await chain.topics.fetchByTopic({
      wallet,
      topic: "general",
      sinceMs: 42,
    });

    expect(mockedFetchMonadTopicPostsSince).toHaveBeenCalledWith({
      relayBaseUrl: wallet.relayBaseUrl,
      topic: "general",
      sinceMs: 42,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].payloadDigest).toBe("22".repeat(32));
  });

  it("fetchOne reads via the chain-level relayBaseUrl (no wallet needed)", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const post = makeTopicPostProto(0x33);

    mockedFetchMonadTopicPostView.mockResolvedValueOnce({
      post: {
        post,
        senderAddress: getBytes("0x" + "99".repeat(20)),
        txHash: getBytes("0x" + "aa".repeat(32)),
        timestamp: 1_700_000_020_000,
        networkTag: new Uint8Array(0),
      },
      voteWeight: 1,
    });

    const message = await chain.topics.fetchOne("33".repeat(32));

    expect(mockedFetchMonadTopicPostView).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
      payloadHashHex: "33".repeat(32),
    });
    expect(message?.payloadDigest).toBe("33".repeat(32));
  });

  it("fetchOne returns undefined when nothing is stored under that hash", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    mockedFetchMonadTopicPostView.mockResolvedValueOnce(undefined);
    expect(await chain.topics.fetchOne("00".repeat(32))).toBeUndefined();
  });

  it("discoverTopics reads via the chain-level relayBaseUrl (no wallet needed)", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    mockedFetchDiscoveredTopics.mockResolvedValueOnce([
      { topic: "general", postCount: 3, lastActivityMs: 500 },
    ]);

    const result = await chain.topics.discoverTopics();

    expect(mockedFetchDiscoveredTopics).toHaveBeenCalledWith({
      relayBaseUrl: TEST_CONFIG.relayBaseUrl,
    });
    expect(result).toEqual([
      { topic: "general", postCount: 3, lastActivityMs: 500 },
    ]);
  });
});

describe("createMonadChain: directMessages.fetchSince mailbox behaviour", () => {
  const { MonadMailboxUnavailableError } = jest.requireActual(
    "@frank/cashweb/relay/monad-mailbox-client"
  );

  async function recoveryRecord(
    bob: MonadIdentity,
    lifecycle: string,
    byte: string,
    options: { wrongDestination?: boolean } = {}
  ) {
    const payloadHash = getBytes(`0x${byte.repeat(32)}`);
    const child = (index: number) =>
      deriveMonadStampChildPublic({
        payloadHash,
        recipientPublicKey: new Uint8Array(bob.compressedPubKey),
        paymentIndex: index,
      });
    const raw = async (index: number, to: string) =>
      getBytes(
        await new Wallet(ALICE_PRIVATE_KEY_HEX).signTransaction({
          type: 2,
          chainId: 10143,
          nonce: index,
          to,
          value: 100n + BigInt(index),
          gasLimit: 60_000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        })
      );
    return {
      payloadHashHex: byte.repeat(32),
      obligationIdHex: "cd".repeat(32),
      canonicalMessage: {
        stampPayments: [
          {
            childIndex: 0,
            rawTx: await raw(
              0,
              options.wrongDestination
                ? "0x000000000000000000000000000000000000dEaD"
                : child(0).address
            ),
          },
          // Child 1 is not yet confirmed: it must never be journaled.
          { childIndex: 1, rawTx: await raw(1, child(1).address) },
        ],
        encryptedPayload: new Uint8Array([1]),
        payloadHash,
      },
      confirmedChildren: [0],
      lifecycle,
    };
  }

  /** `durable` stands in for a `LevelStampPaymentJournal` (persists across restarts). */
  function walletWithJournal(durable = true) {
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    const wallet = makeWallet(bob);
    const journal = new InMemoryStampPaymentJournal();
    (journal as { durable: boolean }).durable = durable;
    wallet.stampPaymentJournal = journal;
    return { bob, wallet, journal };
  }

  it("imports confirmed children of a terminal recovery into the journal, then acks it", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { bob, wallet, journal } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    const record = await recoveryRecord(bob, "terminal:expired", "ab");
    mockedFetchRecoveries.mockResolvedValueOnce({ records: [record] });

    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toEqual([]);

    // F3: a terminal obligation journals EVERY child (child 1 was not confirmed yet but may still
    // land on chain after the ack), and the ack follows only once child 0 is journalled.
    expect(journal.getAll()).toEqual([
      expect.objectContaining({
        payloadHashHex: "ab".repeat(32),
        childIndex: 0,
        status: "discovered",
        valueWei: "100",
      }),
      expect.objectContaining({
        payloadHashHex: "ab".repeat(32),
        childIndex: 1,
        status: "discovered",
        valueWei: "101",
      }),
    ]);
    expect(mockedAckRecovery).toHaveBeenCalledTimes(1);
    expect(mockedAckRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: bob.address.raw,
        payloadHashHex: "ab".repeat(32),
        obligationIdHex: "cd".repeat(32),
      })
    );
  });

  it("imports but does not ack an obligation that is still active (pending/fully_confirmed/delivered)", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { bob, wallet, journal } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    mockedFetchRecoveries.mockResolvedValueOnce({
      records: [
        await recoveryRecord(bob, "pending", "ab"),
        await recoveryRecord(bob, "fully_confirmed", "ac"),
      ],
    });
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
    // Non-terminal: only the confirmed child (0) of each is imported.
    expect(
      journal
        .getAll()
        .map((r) => `${r.payloadHashHex.slice(0, 2)}:${r.childIndex}`)
    ).toEqual(["ab:0", "ac:0"]);
    expect(mockedAckRecovery).not.toHaveBeenCalled();
  });

  it("F1: passes onTruncated through to the mailbox feed so callers can observe truncation", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { wallet } = walletWithJournal();
    const onTruncated = jest.fn();
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    await chain.directMessages.fetchSince({ wallet, sinceMs: 5, onTruncated });
    expect(mockedFetchMonadMessagesSince.mock.calls[0][0].onTruncated).toBe(
      onTruncated
    );
  });

  it("F2: an in-memory (non-durable) journal is filled but NEVER acks a terminal obligation", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { bob, wallet, journal } = walletWithJournal(false);
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    mockedFetchRecoveries.mockResolvedValueOnce({
      records: [await recoveryRecord(bob, "terminal:expired", "ab")],
    });
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
    expect(journal.getAll()).toHaveLength(2); // usable for this session
    expect(mockedAckRecovery).not.toHaveBeenCalled(); // relay keeps the obligation for a restart
  });

  it("the real journal implementations declare durability correctly", () => {
    expect(new InMemoryStampPaymentJournal().durable).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LevelStampPaymentJournal } = jest.requireActual(
      "../storage/stamp-payment-journal"
    );
    expect(new LevelStampPaymentJournal("/nonexistent").durable).toBe(true);
  });

  it("F3: does not ack when a confirmed child could not be journalled, even if other children were", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { bob, wallet, journal } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    mockedFetchRecoveries.mockResolvedValueOnce({
      records: [
        await recoveryRecord(bob, "terminal:expired", "ab", {
          wrongDestination: true,
        }),
      ],
    });
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
    expect(journal.getAll().map((r) => r.childIndex)).toEqual([1]); // unconfirmed child still kept
    expect(mockedAckRecovery).not.toHaveBeenCalled();
  });

  it("F3: an unrecoverable UNCONFIRMED child does not block the ack of a fully journalled confirmed prefix", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { bob, wallet, journal } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    const record = await recoveryRecord(
      bob,
      "terminal:attempts_exhausted",
      "ab"
    );
    record.canonicalMessage.stampPayments[1] = {
      childIndex: 1,
      rawTx: new Uint8Array([1, 2, 3]),
    };
    mockedFetchRecoveries.mockResolvedValueOnce({ records: [record] });
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
    expect(journal.getAll().map((r) => r.childIndex)).toEqual([0]);
    expect(mockedAckRecovery).toHaveBeenCalledTimes(1);
  });

  it("does not ack a record it could not import (wrong destination) and still handles the next one", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { bob, wallet, journal } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    mockedFetchRecoveries.mockResolvedValueOnce({
      records: [
        await recoveryRecord(bob, "terminal:expired", "ab", {
          wrongDestination: true,
        }),
        await recoveryRecord(bob, "terminal:expired", "ac"),
      ],
    });
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
    // 'ab' has an unrecoverable CONFIRMED child 0 (its unconfirmed child 1 is still kept but the
    // record is not acked); 'ac' is fully journalled and acked.
    expect(
      journal
        .getAll()
        .map((r) => `${r.payloadHashHex.slice(0, 2)}:${r.childIndex}`)
    ).toEqual(["ab:1", "ac:0", "ac:1"]);
    expect(mockedAckRecovery).toHaveBeenCalledTimes(1);
    expect(mockedAckRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ payloadHashHex: "ac".repeat(32) })
    );
  });

  it("never fetches or acks recoveries without a durable journal (an ack asserts durable import)", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const bob = MonadIdentity.fromPrivateKeyHex(BOB_PRIVATE_KEY_HEX);
    mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
    await chain.directMessages.fetchSince({
      wallet: makeWallet(bob),
      sinceMs: 0,
    });
    expect(mockedFetchRecoveries).not.toHaveBeenCalled();
    expect(mockedAckRecovery).not.toHaveBeenCalled();
  });

  it("a recovery/ack failure does not lose the inbox result", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { bob, wallet } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValue([]);
    mockedFetchRecoveries.mockRejectedValueOnce(new Error("relay down"));
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).resolves.toEqual([]);

    mockedFetchRecoveries.mockResolvedValueOnce({
      records: [await recoveryRecord(bob, "terminal:expired", "ab")],
    });
    mockedAckRecovery.mockRejectedValueOnce(new Error("ack failed"));
    // Recovery is throttled per wallet, so let the interval elapse before the second attempt.
    const realNow = Date.now();
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(realNow + MAILBOX_RECOVERY_SYNC_INTERVAL_MS + 1);
    try {
      await expect(
        chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
      ).resolves.toEqual([]);
      expect(mockedAckRecovery).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("syncs recovery at most once per interval so a steady poll spends one challenge (inbox only)", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { wallet } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValue([]);
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now");
    try {
      for (const offset of [0, 7_000, 14_000, 59_000]) {
        nowSpy.mockReturnValue(t0 + offset);
        await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
      }
      expect(mockedFetchMonadMessagesSince).toHaveBeenCalledTimes(4);
      expect(mockedFetchRecoveries).toHaveBeenCalledTimes(1);
      nowSpy.mockReturnValue(t0 + MAILBOX_RECOVERY_SYNC_INTERVAL_MS + 1);
      await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
      expect(mockedFetchRecoveries).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("a hung recovery read delays message delivery by at most the bound (recovery runs after the messages are ready)", async () => {
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      const chain = createMonadChain(TEST_CONFIG);
      const { wallet } = walletWithJournal();
      mockedFetchMonadMessagesSince.mockResolvedValueOnce([]);
      mockedFetchRecoveries.mockReturnValueOnce(new Promise(() => undefined));
      let done = false;
      void chain.directMessages
        .fetchSince({ wallet, sinceMs: 0 })
        .then(() => (done = true));
      await jest.advanceTimersByTimeAsync(MAILBOX_RECOVERY_SYNC_WAIT_MS - 1);
      expect(mockedFetchRecoveries).toHaveBeenCalledTimes(1);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a failed recovery read is not retried on the very next poll", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { wallet } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockResolvedValue([]);
    mockedFetchRecoveries.mockRejectedValue(new Error("relay down"));
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
    await chain.directMessages.fetchSince({ wallet, sinceMs: 0 });
    expect(mockedFetchRecoveries).toHaveBeenCalledTimes(1);
  });

  it("propagates a missing mailbox (404) instead of reporting an empty inbox, and skips recovery", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const { wallet } = walletWithJournal();
    mockedFetchMonadMessagesSince.mockRejectedValueOnce(
      new MonadMailboxUnavailableError("HTTP 404", 404)
    );
    await expect(
      chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
    ).rejects.toBeInstanceOf(MonadMailboxUnavailableError);
    expect(mockedFetchRecoveries).not.toHaveBeenCalled();
  });
});

describe("asMonadWallet guard (exercised indirectly via directMessages/topics)", () => {
  it("throws a clear error when handed a bare WalletHandle missing the wallet-client bundle", async () => {
    const chain = createMonadChain(TEST_CONFIG);
    const alice = MonadIdentity.fromPrivateKeyHex(ALICE_PRIVATE_KEY_HEX);
    const bareWallet: WalletHandle = { identity: alice };

    await expect(
      chain.directMessages.fetchSince({ wallet: bareWallet, sinceMs: 0 })
    ).rejects.toThrow(/MonadChainWalletHandle/);
  });
});
