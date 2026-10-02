import {
  EcashBroadcastResult,
  EcashWallet,
  EcashWalletBackend,
} from "./ecash-wallet";
import {
  InMemoryNativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
} from "./chain/chain-wallet";

const ADDRESS = "ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function makeBackend(
  result: EcashBroadcastResult = {
    success: true,
    broadcasted: ["first", "requested"],
  }
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
    getReceiveAddress: jest.fn(() => ADDRESS),
    action,
    broadcast,
  };
}

describe("EcashWallet", () => {
  let nativeAttemptStore: InMemoryNativeTransactionAttemptStore;

  beforeEach(() => {
    nativeAttemptStore = new InMemoryNativeTransactionAttemptStore();
  });

  it("exposes identity and a freshly synced bigint balance", async () => {
    const backend = makeBackend();
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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

  it("reports the exact attempted id when broadcast outcome is unknown", async () => {
    const backend = makeBackend({
      success: false,
      broadcasted: [],
      errors: ["conflicting UTXO"],
    });
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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

  it("does not broadcast when the exact attempt cannot be persisted first", async () => {
    const backend = makeBackend();
    const persistenceError = new Error("durable store unavailable");
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
      nativeAttemptStore: {
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

  it("stays blocked when a successful attempt cannot be durably cleared", async () => {
    const backend = makeBackend();
    const transaction = {
      txHash: "requested",
      relatedTxHashes: ["first", "requested"],
    };
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
      nativeAttemptStore: {
        get: () => undefined,
        put: jest.fn(),
        delete: () => {
          throw new Error("durable delete failed");
        },
      },
      walletFactory: () => backend,
    });

    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toThrow("durable delete failed");
    expect(wallet.getUnresolvedNativeTransaction()).toEqual(transaction);
    await expect(
      wallet.sendNative({ recipient: { raw: ADDRESS }, value: 2n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(backend.broadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported mnemonic passphrases explicitly", async () => {
    const factory = jest.fn(() => makeBackend());
    await expect(
      EcashWallet.fromMnemonic({
        mnemonic: MNEMONIC,
        passphrase: "secret",
        chronik: {},
        networkId: "ecash-test",
        nativeAttemptStore,
        walletFactory: factory,
      })
    ).rejects.toThrow("does not support BIP-39 passphrases");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects malformed recovery phrases before constructing a backend", async () => {
    const factory = jest.fn(() => makeBackend());
    await expect(
      EcashWallet.fromMnemonic({
        mnemonic: "not a valid BIP-39 mnemonic",
        chronik: {},
        networkId: "ecash-test",
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
      const wallet = await EcashWallet.fromMnemonic({
        mnemonic: MNEMONIC,
        chronik: {},
        networkId: "ecash-test",
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
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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

  it("can clear an exact attempt after external reconciliation proves rejection", async () => {
    const backend = makeBackend();
    backend.broadcast.mockResolvedValueOnce({
      success: false,
      broadcasted: [],
      errors: ["definitive rejection"],
    });
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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

    wallet.resolveUnresolvedNativeTransaction({
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
    const firstWallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
      nativeAttemptStore,
      walletFactory: () => failedBackend,
    });
    await expect(
      firstWallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);

    const restoredBackend = makeBackend();
    const restoredWallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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

    restoredWallet.resolveUnresolvedNativeTransaction({
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
    const wallet = await EcashWallet.fromMnemonic({
      mnemonic: MNEMONIC,
      chronik: {},
      networkId: "ecash-test",
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
    await Promise.resolve();
    await Promise.resolve();
    expect(backend.action).toHaveBeenCalledTimes(1);

    releaseFirst!();
    await Promise.all([first, second]);
    expect(backend.action).toHaveBeenCalledTimes(2);
    expect(backend.sync).toHaveBeenCalledTimes(2);
  });
});
