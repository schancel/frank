import {
  ECASH_MAINNET_CHECKPOINT_HASH,
  ECASH_TESTNET_CHECKPOINT_HEIGHT,
  ECASH_TESTNET_CHECKPOINT_HASH,
  EcashBroadcastResult,
  EcashWallet,
  EcashWalletBackend,
} from "./ecash-wallet";
import {
  InMemoryNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
  NativeFeeExceededError,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
} from "./chain/chain-wallet";
import type { ChronikClient } from "chronik-client";
import { Address } from "ecash-lib/dist/address/address";
import type { DomainRoot } from "../domain-roots/src";

const ADDRESS = "ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ROOT: DomainRoot<"ecash-bch-wallet"> = {
  registry: "frank-domain-roots-v1",
  purpose: "ecash-bch-wallet",
  bytes: new Uint8Array(32).fill(1),
};

function makeChronik(): ChronikClient {
  return {
    block: jest.fn().mockResolvedValue({
      blockInfo: { hash: ECASH_MAINNET_CHECKPOINT_HASH },
    }),
  } as unknown as ChronikClient;
}

function makeBackend(
  result: EcashBroadcastResult = {
    success: true,
    broadcasted: ["first", "requested"],
  },
  receiveAddress: string = ADDRESS
): EcashWalletBackend & {
  sync: jest.Mock;
  syncAndDiscoverAddresses: jest.Mock;
  action: jest.Mock;
  broadcast: jest.Mock;
} {
  const broadcast = jest.fn().mockResolvedValue(result);
  const action = jest.fn(() => ({
    build: () => ({
      builtTxs: result.broadcasted.length
        ? result.broadcasted.map((txid) => ({ txid }))
        : [{ txid: "attempted" }],
      broadcast,
    }),
  }));
  return {
    balanceSats: 12_345n,
    receiveIndex: 3,
    sync: jest.fn().mockResolvedValue(undefined),
    syncAndDiscoverAddresses: jest.fn().mockResolvedValue(undefined),
    getReceiveAddress: jest.fn(() => receiveAddress),
    action,
    broadcast,
  };
}

describe("EcashWallet", () => {
  let nativeAttemptStore: InMemoryNativeTransactionAttemptStore;

  beforeEach(() => {
    nativeAttemptStore = new InMemoryNativeTransactionAttemptStore();
  });

  it.each([
    null,
    { ...ROOT, purpose: "evm-wallet" },
    { ...ROOT, registry: "frank-domain-roots-v2" },
    { ...ROOT, bytes: new Uint8Array(31) },
    { ...ROOT, bytes: new Uint8Array(33) },
    { ...ROOT, bytes: Array(32).fill(1) },
    { mnemonic: MNEMONIC },
  ])(
    "rejects invalid typed roots before endpoint, backend or journal effects (%#)",
    async (root) => {
      const chronik = makeChronik();
      const factory = jest.fn(() => makeBackend());
      const journalRead = jest.spyOn(nativeAttemptStore, "get");
      await expect(
        EcashWallet.fromDomainRoot({
          domainRoot: root as DomainRoot<"ecash-bch-wallet">,
          chronik,
          networkId: "ecash-mainnet",
          nativeAttemptStore,
          walletFactory: factory,
        })
      ).rejects.toThrow(
        "Expected a frank-domain-roots-v1 ecash-bch-wallet root of exactly 32 bytes"
      );
      expect(chronik.block).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      expect(journalRead).not.toHaveBeenCalled();
    }
  );

  it("snapshots root bytes before awaiting the checkpoint and clears only its owned copy", async () => {
    const root = { ...ROOT, bytes: Uint8Array.from(ROOT.bytes) };
    const expected = Uint8Array.from(root.bytes);
    const chronik = makeChronik();
    let release!: () => void;
    jest.spyOn(chronik, "block").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { blockInfo: { hash: ECASH_MAINNET_CHECKPOINT_HASH } } as Awaited<
        ReturnType<ChronikClient["block"]>
      >;
    });
    let received: Uint8Array | undefined;
    const constructing = EcashWallet.fromDomainRoot({
      domainRoot: root,
      chronik,
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: ({ domainRoot }) => {
        expect(domainRoot.bytes).toEqual(expected);
        expect(domainRoot.bytes).not.toBe(root.bytes);
        received = domainRoot.bytes;
        return makeBackend();
      },
    });
    root.bytes.fill(9);
    release();
    await constructing;
    expect(received).toEqual(new Uint8Array(32));
    expect(root.bytes).toEqual(new Uint8Array(32).fill(9));
  });

  it("exposes identity and a freshly synced bigint balance", async () => {
    const backend = makeBackend();
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    expect(wallet.identity).toEqual({
      address: { raw: ADDRESS },
      displayAddress: ADDRESS,
    });
    await expect(wallet.getReceiveAddress()).resolves.toEqual({ raw: ADDRESS });
    expect(backend.getReceiveAddress).toHaveBeenCalledWith(3);
    await expect(wallet.getBalance()).resolves.toBe(12_345n);
    expect(backend.syncAndDiscoverAddresses).toHaveBeenCalledTimes(2);
    expect(backend.sync).toHaveBeenCalledTimes(1);
  });

  it("does not consume HD indices when the receive address is displayed repeatedly", async () => {
    const backend = makeBackend();
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    const addresses = await Promise.all(
      Array.from({ length: 21 }, () => wallet.getReceiveAddress())
    );

    expect(new Set(addresses.map((address) => address.raw))).toEqual(
      new Set([ADDRESS])
    );
    expect(backend.getReceiveAddress).toHaveBeenCalledTimes(22);
    expect(backend.getReceiveAddress).toHaveBeenCalledWith(0);
    expect(backend.getReceiveAddress).toHaveBeenCalledWith(3);
  });

  it("hides UTXO/chained-action details behind one native transfer", async () => {
    const backend = makeBackend();
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 550n })
    ).resolves.toEqual({
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    });
    expect(backend.action).toHaveBeenCalledWith({
      outputs: [{ address: ADDRESS, sats: 550n }],
    });
    expect(backend.broadcast).toHaveBeenCalledWith({
      retryOnUtxoConflict: false,
    });
  });

  it("rejects a non-mainnet recipient at the direct wallet boundary", async () => {
    const backend = makeBackend();
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({
        recipient: {
          raw: "ectest:qq86jv6h0y97q8l63ndynvk3fn9aq8fqruhjcef2tw",
        },
        value: 1n,
      })
    ).rejects.toThrow("Invalid eCash recipient for the configured network");
    expect(backend.action).not.toHaveBeenCalled();
  });

  it("rejects a Chronik endpoint that lacks the eCash mainnet checkpoint", async () => {
    const chronik = makeChronik();
    jest.spyOn(chronik, "block").mockResolvedValueOnce({
      blockInfo: { hash: "a-bch-block-at-the-same-height" },
    } as Awaited<ReturnType<ChronikClient["block"]>>);

    await expect(
      EcashWallet.fromDomainRoot({
        domainRoot: ROOT,
        chronik,
        networkId: "xec-mainnet",
        nativeAttemptStore,
        walletFactory: () => makeBackend(),
      })
    ).rejects.toThrow("eCash Chronik checkpoint mismatch");
  });

  it("verifies and rejects a testnet Chronik endpoint based on ECASH_TESTNET_CHECKPOINT", async () => {
    const chronik = makeChronik();
    const blockSpy = jest.spyOn(chronik, "block").mockResolvedValueOnce({
      blockInfo: { hash: "wrong-testnet-hash" },
    } as Awaited<ReturnType<ChronikClient["block"]>>);

    await expect(
      EcashWallet.fromDomainRoot({
        domainRoot: ROOT,
        chronik,
        networkId: "xec-testnet",
        nativeAttemptStore,
        walletFactory: () => makeBackend(),
      })
    ).rejects.toThrow("eCash Chronik checkpoint mismatch");
    expect(blockSpy).toHaveBeenCalledWith(ECASH_TESTNET_CHECKPOINT_HEIGHT);

    // Now with valid testnet checkpoint hash
    blockSpy.mockResolvedValueOnce({
      blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH },
    } as Awaited<ReturnType<ChronikClient["block"]>>);

    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik,
      networkId: "xec-testnet",
      nativeAttemptStore,
      walletFactory: () =>
        makeBackend(
          undefined,
          "ectest:qq86jv6h0y97q8l63ndynvk3fn9aq8fqruhjcef2tw"
        ),
    });
    expect(wallet.networkId).toBe("xec-testnet");
  });

  it("rejects an unverified fallback in a multi-endpoint Chronik client", async () => {
    const chronik = {
      proxyInterface: () => ({
        getEndpointArray: () => [
          { url: "https://xec.example" },
          { url: "https://bch.example" },
        ],
      }),
    } as unknown as ChronikClient;
    const walletFactory = jest.fn(() => makeBackend());

    await expect(
      EcashWallet.fromDomainRoot({
        domainRoot: ROOT,
        chronik,
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory,
        checkpointClientFactory: (url) => ({
          block: jest.fn().mockResolvedValue({
            blockInfo: {
              hash:
                url === "https://xec.example"
                  ? ECASH_MAINNET_CHECKPOINT_HASH
                  : "bch-checkpoint",
            },
          }),
        }),
      })
    ).rejects.toThrow("checkpoint mismatch for https://bch.example");
    expect(walletFactory).not.toHaveBeenCalled();
  });

  it("rejects the legacy Chronik client shape before creating the SDK wallet", async () => {
    const legacyChronik = makeChronik() as ChronikClient & {
      proxyInterface?: unknown;
    };
    legacyChronik.proxyInterface = undefined;

    await expect(
      EcashWallet.fromDomainRoot({
        domainRoot: ROOT,
        chronik: legacyChronik,
        networkId: "ecash-mainnet",
        nativeAttemptStore,
      })
    ).rejects.toThrow("requires chronik-client 4.3 or newer");
  });

  it("reports the exact attempted id when broadcast outcome is unknown", async () => {
    const backend = makeBackend({
      success: false,
      broadcasted: [],
      errors: ["conflicting UTXO"],
    });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    const submission = wallet.sendNative({
      recipient: { raw: ADDRESS },
      value: 1n,
    });
    await expect(submission).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError
    );
    await expect(submission).rejects.toMatchObject({
      transaction: { txHash: "attempted" },
      reason: "conflicting UTXO",
    });
  });

  it("retains the exact attempt when the broadcaster rejects", async () => {
    const backend = makeBackend();
    backend.broadcast.mockRejectedValueOnce(new Error("connection reset"));
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toMatchObject({
      transaction: {
        txHash: "requested",
        relatedTxHashes: ["first", "requested"],
      },
      reason: expect.objectContaining({ message: "connection reset" }),
    });
    expect(wallet.getUnresolvedNativeTransaction()).toEqual({
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    });
  });

  it.each([
    [["requested"], "partial"],
    [["requested", "first"], "reordered"],
  ])("rejects a %s accepted-id response", async (broadcasted) => {
    const backend = makeBackend();
    backend.broadcast.mockResolvedValueOnce({ success: true, broadcasted });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toMatchObject({
      transaction: {
        txHash: "requested",
        relatedTxHashes: ["first", "requested"],
      },
      reason: expect.objectContaining({
        message: "eCash backend returned unexpected transaction ids",
      }),
    });
  });

  it("does not broadcast when the exact attempt cannot be persisted first", async () => {
    const backend = makeBackend();
    const persistenceError = new Error("durable store unavailable");
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore: {
        coordinationScope: "single-realm",
        get: () => undefined,
        put: () => {
          throw persistenceError;
        },
        delete: jest.fn(),
      },
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBe(persistenceError);
    expect(backend.broadcast).not.toHaveBeenCalled();
  });

  it("retains a successful attempt durably until explicit reconciliation", async () => {
    const backend = makeBackend();
    const transaction = {
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    };
    let persisted: typeof transaction | undefined;
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore: {
        coordinationScope: "single-realm",
        get: () => persisted,
        put: (_key, value) => {
          persisted = value as typeof transaction;
        },
        delete: () => {
          throw new Error("durable delete failed");
        },
      },
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).resolves.toEqual(transaction);
    expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    const competingBackend = makeBackend();
    const competingWallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore: {
        coordinationScope: "single-realm",
        get: () => persisted,
        put: (_key, value) => {
          persisted = value as typeof transaction;
        },
        delete: () => {
          throw new Error("durable delete failed");
        },
      },
      walletFactory: () => competingBackend,
    });
    expect(competingWallet.getUnresolvedNativeTransaction()).toEqual(
      transaction
    );
    await expect(
      competingWallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(competingBackend.action).not.toHaveBeenCalled();
    await expect(
      wallet.resolveUnresolvedNativeTransaction({
        transaction,
        outcome: "submitted",
      })
    ).rejects.toThrow("durable delete failed");
    expect(backend.broadcast).toHaveBeenCalledTimes(1);
  });

  it("reconciles a confirmed restored attempt before a later send", async () => {
    const store = new InMemoryNativeTransactionAttemptStore();
    const firstWallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore: store,
      walletFactory: () => makeBackend(),
    });
    await firstWallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n });

    const restoredBackend = makeBackend();
    const restoredWallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore: store,
      getTransactionStatus: async () => "confirmed",
      walletFactory: () => restoredBackend,
    });
    await expect(
      restoredWallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).resolves.toEqual({
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    });
    expect(restoredBackend.action).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported mnemonic passphrases explicitly", async () => {
    const factory = jest.fn(() => makeBackend());
    await expect(
      EcashWallet.fromLegacyMnemonic({
        mnemonic: MNEMONIC,
        passphrase: "secret",
        chronik: makeChronik(),
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory: factory,
      })
    ).rejects.toThrow("does not support BIP-39 passphrases");
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps mnemonic import behind the explicitly named legacy constructor", async () => {
    const factory = jest.fn(() => makeBackend());
    const chronik = makeChronik();
    const wallet = await EcashWallet.fromLegacyMnemonic({
      mnemonic: MNEMONIC,
      chronik,
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: factory,
    });
    expect(factory).toHaveBeenCalledWith({
      mnemonic: MNEMONIC,
      chronik,
      addressPrefix: "ecash",
    });
    expect(wallet.identity.address.raw).toBe(ADDRESS);
  });

  it("rejects malformed recovery phrases before constructing a backend", async () => {
    const factory = jest.fn(() => makeBackend());
    await expect(
      EcashWallet.fromLegacyMnemonic({
        mnemonic: "not a valid BIP-39 mnemonic",
        chronik: makeChronik(),
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory: factory,
      })
    ).rejects.toThrow("Invalid BIP-39 mnemonic");
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([0n, -1n])(
    "rejects non-positive transfer value %s",
    async (value) => {
      const backend = makeBackend();
      const wallet = await EcashWallet.fromDomainRoot({
        domainRoot: ROOT,
        chronik: makeChronik(),
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory: () => backend,
      });
      backend.sync.mockClear();

      await expect(
        wallet.sendNative({ recipient: { raw: ADDRESS }, value })
      ).rejects.toThrow("greater than zero");
      expect(backend.sync).not.toHaveBeenCalled();
      expect(backend.action).not.toHaveBeenCalled();
      expect(backend.broadcast).not.toHaveBeenCalled();
    }
  );

  it("returns accepted txids when finalization times out after broadcast", async () => {
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () =>
        makeBackend({
          success: false,
          broadcasted: ["accepted"],
          errors: ["finalization timeout"],
        }),
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).resolves.toEqual({ txHash: "accepted" });
  });

  it("blocks fresh signing and retries the exact unresolved action", async () => {
    const backend = makeBackend();
    backend.broadcast
      .mockResolvedValueOnce({
        success: false,
        broadcasted: [],
        errors: ["response lost"],
      })
      .mockResolvedValueOnce({
        success: true,
        broadcasted: ["first", "requested"],
      });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(wallet.getUnresolvedNativeTransaction()).toEqual({
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    });
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(backend.action).toHaveBeenCalledTimes(1);

    await expect(wallet.retryUnresolvedNativeTransaction()).resolves.toEqual({
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    });
    expect(backend.broadcast).toHaveBeenCalledTimes(2);
    expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
  });

  it("refuses to retry after another instance replaces the durable attempt", async () => {
    const backend = makeBackend({
      success: false,
      broadcasted: [],
      errors: ["response lost"],
    });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    nativeAttemptStore.put(
      nativeTransactionAttemptKey({
        family: "bitcoin",
        chainIdentifier: "xec-mainnet",
        address: ADDRESS,
      }),
      { txHash: "newer-attempt" }
    );

    await expect(wallet.retryUnresolvedNativeTransaction()).rejects.toThrow(
      "changed before retry"
    );
    expect(backend.broadcast).toHaveBeenCalledTimes(1);
    expect(wallet.getUnresolvedNativeTransaction()).toEqual({
      txHash: "newer-attempt",
    });
  });

  it("clears a stale cached guard after another instance resolves it", async () => {
    const backend = makeBackend({
      success: false,
      broadcasted: [],
      errors: ["response lost"],
    });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    nativeAttemptStore.delete(
      nativeTransactionAttemptKey({
        family: "bitcoin",
        chainIdentifier: "xec-mainnet",
        address: ADDRESS,
      })
    );
    backend.broadcast.mockResolvedValueOnce({
      success: true,
      broadcasted: ["attempted"],
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).resolves.toEqual({ txHash: "attempted" });
    expect(backend.action).toHaveBeenCalledTimes(2);
  });

  it("can clear an exact attempt after external reconciliation proves rejection", async () => {
    const backend = makeBackend();
    backend.broadcast.mockResolvedValueOnce({
      success: false,
      broadcasted: [],
      errors: ["definitive rejection"],
    });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });
    const sending = wallet.sendNative({
      recipient: { raw: ADDRESS },
      value: 1n,
    });
    await expect(sending).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError
    );
    const transaction = wallet.getUnresolvedNativeTransaction()!;

    await wallet.resolveUnresolvedNativeTransaction({
      transaction,
      outcome: "not-submitted",
    });
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).resolves.toEqual({
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    });
  });

  it("restores the unresolved guard before allowing another transfer", async () => {
    const failedBackend = makeBackend({
      success: false,
      broadcasted: [],
      errors: ["response lost"],
    });
    const firstWallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => failedBackend,
    });
    await expect(
      firstWallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);

    const restoredBackend = makeBackend();
    const restoredWallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => restoredBackend,
    });
    const unresolved = restoredWallet.getUnresolvedNativeTransaction()!;
    expect(unresolved).toEqual({ txHash: "attempted" });
    await expect(
      restoredWallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(restoredBackend.action).not.toHaveBeenCalled();
    await expect(
      restoredWallet.retryUnresolvedNativeTransaction()
    ).rejects.toThrow("must be reconciled by id");

    await restoredWallet.resolveUnresolvedNativeTransaction({
      transaction: unresolved,
      outcome: "not-submitted",
    });
    await expect(
      restoredWallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).resolves.toEqual({
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    });
  });

  describe("a send interrupted by a restart", () => {
    const RAW = "0200beef";
    const signedBackend = (result?: EcashBroadcastResult) => {
      const backend = makeBackend(result);
      backend.action.mockImplementation(() => ({
        build: () => ({
          builtTxs: [
            { txid: "attempted", tx: { ser: () => Buffer.from(RAW, "hex") } },
          ],
          broadcast: backend.broadcast,
        }),
      }));
      return backend;
    };
    const interrupt = async () => {
      const first = await EcashWallet.fromDomainRoot({
        domainRoot: ROOT,
        chronik: makeChronik(),
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory: () =>
          signedBackend({ success: false, broadcasted: [], errors: ["lost"] }),
      });
      await expect(
        first.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
      ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    };
    const restart = (options: {
      status: "pending" | "confirmed" | "unknown";
      rebroadcast: jest.Mock;
    }) => {
      const backend = makeBackend();
      return EcashWallet.fromDomainRoot({
        domainRoot: ROOT,
        chronik: makeChronik(),
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory: () => backend,
        getTransactionStatus: async () => options.status,
        rebroadcast: options.rebroadcast,
      }).then((wallet) => ({ wallet, backend }));
    };

    it("records the signed bytes before broadcasting", async () => {
      await interrupt();
      const [key] = [...(nativeAttemptStore as any).attempts.keys()];
      expect(nativeAttemptStore.get(key)).toEqual({
        txHash: "attempted",
        rawTransactions: [RAW],
      });
    });

    it("sends the same bytes again when the indexer never saw them", async () => {
      await interrupt();
      const rebroadcast = jest.fn().mockResolvedValue(undefined);
      const { wallet, backend } = await restart({ status: "unknown", rebroadcast });
      expect(rebroadcast).toHaveBeenCalledTimes(1);
      expect(rebroadcast).toHaveBeenCalledWith([RAW]);
      expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
      // Nothing was signed to finish the old send.
      expect(backend.action).not.toHaveBeenCalled();
      await expect(
        wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
      ).resolves.toMatchObject({ txHash: "requested" });
    });

    it("does not send again a transaction the indexer already has", async () => {
      await interrupt();
      const rebroadcast = jest.fn();
      const { wallet } = await restart({ status: "pending", rebroadcast });
      expect(rebroadcast).not.toHaveBeenCalled();
      expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    });

    it("stays unresolved and signs nothing new while the node cannot be reached", async () => {
      await interrupt();
      const rebroadcast = jest
        .fn()
        .mockRejectedValue(new Error("Error connecting to known Chronik instances"));
      const { wallet, backend } = await restart({ status: "unknown", rebroadcast });
      expect(wallet.getUnresolvedNativeTransaction()).toMatchObject({
        txHash: "attempted",
      });
      await expect(
        wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
      ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
      expect(backend.action).not.toHaveBeenCalled();
      // The node comes back: the next send first finishes the old one, then proceeds.
      rebroadcast.mockResolvedValue(undefined);
      await expect(
        wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
      ).resolves.toMatchObject({ txHash: "requested" });
      expect(rebroadcast).toHaveBeenLastCalledWith([RAW]);
    });

    it("drops a transaction the node refuses with a reason, since its inputs are gone", async () => {
      await interrupt();
      const rebroadcast = jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed getting /broadcast-txs: 400: Transaction rejected by mempool: bad-txns-inputs-missingorspent"
          )
        );
      const { wallet } = await restart({ status: "unknown", rebroadcast });
      expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    });

    it.each([
      "Failed getting /broadcast-txs: upstream Chronik error",
      "Failed getting /broadcast-txs: ",
      "Unable to decode error msg, chronik server is indexing or in error state",
      "Request failed with status code 502",
    ])("keeps the record when the failure is not the node's own refusal (%s)", async (message) => {
      await interrupt();
      const rebroadcast = jest.fn().mockRejectedValue(new Error(message));
      const { wallet, backend } = await restart({ status: "unknown", rebroadcast });
      expect(wallet.getUnresolvedNativeTransaction()).toMatchObject({
        txHash: "attempted",
        rawTransactions: [RAW],
      });
      await expect(
        wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
      ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
      expect(backend.action).not.toHaveBeenCalled();
    });
  });

  it("does not take the relay's placeholder for a refusal on a first send", async () => {
    const backend = makeBackend({
      success: false,
      broadcasted: [],
      errors: ["Error: Failed getting /broadcast-txs: upstream Chronik error"],
    });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(wallet.getUnresolvedNativeTransaction()).toEqual({ txHash: "attempted" });
  });

  it("refuses to pay more than the reviewed fee, before recording or sending anything", async () => {
    const backend = makeBackend();
    backend.action.mockImplementation(() => ({
      build: () => ({
        builtTxs: [{ txid: "attempted", fee: () => 300n }],
        broadcast: backend.broadcast,
      }),
    }));
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });
    const error = await wallet
      .sendNative({ recipient: { raw: ADDRESS }, value: 1n, maxFee: 299n })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeFeeExceededError);
    expect(error.fee).toBe(300n);
    expect(backend.broadcast).not.toHaveBeenCalled();
    expect([...(nativeAttemptStore as any).attempts.keys()]).toEqual([]);
    backend.broadcast.mockResolvedValue({ success: true, broadcasted: ["attempted"] });
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n, maxFee: 300n })
    ).resolves.toEqual({ txHash: "attempted" });
  });

  it.each([
    ["the SDK reports it", "result"],
    ["the broadcast call throws it", "throw"],
  ])("says why the node refused a send and leaves nothing to reconcile (%s)", async (_how, mode) => {
    const refusal =
      "Error: Failed getting /broadcast-txs: Broadcast failed: Transaction rejected by mempool: min relay fee not met";
    const backend = makeBackend({ success: false, broadcasted: [], errors: [refusal] });
    if (mode === "throw")
      backend.broadcast.mockRejectedValue(new Error(refusal.slice("Error: ".length)));
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });
    const error = await wallet
      .sendNative({ recipient: { raw: ADDRESS }, value: 1n })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeTransactionRefusedError);
    expect(error.message).toBe(
      "The network refused the transaction: Broadcast failed: Transaction rejected by mempool: min relay fee not met"
    );
    expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    expect([...(nativeAttemptStore as any).attempts.keys()]).toEqual([]);
    // The next send is not blocked.
    backend.broadcast.mockResolvedValue({ success: true, broadcasted: ["attempted"] });
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).resolves.toEqual({ txHash: "attempted" });
  });

  it("estimates the fee without building a spend", async () => {
    const backend = makeBackend();
    const inspect = jest.fn(() => ({ fee: () => 219n }));
    backend.action.mockImplementation(() => ({ build: jest.fn(), inspect }) as never);
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });
    await expect(
      wallet.estimateFee({ recipient: { raw: ADDRESS }, value: 1_000n })
    ).resolves.toBe(219n);
    expect(backend.action).toHaveBeenCalledWith({
      outputs: [{ address: ADDRESS, sats: 1_000n }],
    });
    expect(backend.broadcast).not.toHaveBeenCalled();
  });

  it("asks the backend for testnet addresses on the testnet", async () => {
    const chronik = makeChronik();
    jest.spyOn(chronik, "block").mockResolvedValue({
      blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH },
    } as Awaited<ReturnType<ChronikClient["block"]>>);
    const factory = jest.fn(() =>
      makeBackend(
        undefined,
        Address.fromCashAddress(ADDRESS).withPrefix("ectest").toString()
      )
    );
    await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik,
      networkId: "xec-testnet",
      nativeAttemptStore,
      walletFactory: factory,
    });
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik,
      networkId: "xec-testnet",
      nativeAttemptStore,
      walletFactory: factory,
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ addressPrefix: "ectest" })
    );
    // The Send page compares this with the chain it reviewed.
    expect(wallet.chainIdentifier).toBe("xec-testnet");
    expect(wallet.networkId).toBe("xec-testnet");
  });

  it("shares the unresolved guard across backend address case aliases", async () => {
    const failedBackend = makeBackend({
      success: false,
      broadcasted: [],
      errors: ["response lost"],
    });
    const firstWallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => failedBackend,
    });
    await expect(
      firstWallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);

    const aliasBackend = makeBackend();
    aliasBackend.getReceiveAddress.mockReturnValue(ADDRESS.toUpperCase());
    const aliasWallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => aliasBackend,
    });

    expect(aliasWallet.identity.address.raw).toBe(ADDRESS);
    expect(aliasWallet.getUnresolvedNativeTransaction()).toEqual(
      firstWallet.getUnresolvedNativeTransaction()
    );
    await expect(
      aliasWallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(aliasBackend.action).not.toHaveBeenCalled();
  });

  it("serializes sync, build, and broadcast across concurrent sends", async () => {
    const backend = makeBackend({
      success: true,
      broadcasted: ["first", "requested"],
    });
    let releaseFirst: (() => void) | undefined;
    backend.broadcast.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              success: true,
              broadcasted: ["first", "requested"],
            });
        })
    );
    const wallet = await EcashWallet.fromDomainRoot({
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    const first = wallet.sendNative({
      recipient: { raw: ADDRESS },
      value: 1n,
    });
    const second = wallet.sendNative({
      recipient: { raw: ADDRESS },
      value: 2n,
    });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    expect(backend.action).toHaveBeenCalledTimes(1);

    releaseFirst!();
    await Promise.all([first, second]);
    expect(backend.action).toHaveBeenCalledTimes(2);
    expect(backend.sync).toHaveBeenCalledTimes(2);
  });
});
