import {
  DefaultNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
  runNativeTransactionExclusive,
} from "./chain-wallet";

it("fails closed for a cross-process attempt store without an external coordinator", async () => {
  await expect(
    runNativeTransactionExclusive("shared", "cross-process", async () => 1)
  ).rejects.toThrow("require an external coordinator");
});

it("fails closed for a cross-process store even when browser Web Locks exist", async () => {
  const browserHost = globalThis as typeof globalThis & {
    window?: unknown;
    navigator?: { locks?: { request: jest.Mock } };
  };
  const originalWindow = browserHost.window;
  const originalNavigator = browserHost.navigator;
  const request = jest.fn();
  browserHost.window = {};
  Object.defineProperty(browserHost, "navigator", {
    configurable: true,
    value: { locks: { request } },
  });
  try {
    await expect(
      runNativeTransactionExclusive("shared", "cross-process", async () => 1)
    ).rejects.toThrow("require an external coordinator");
    expect(request).not.toHaveBeenCalled();
  } finally {
    if (originalWindow === undefined) delete browserHost.window;
    else browserHost.window = originalWindow;
    Object.defineProperty(browserHost, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }
});

type MutableGlobal = typeof globalThis & {
  window?: unknown;
  localStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
};

const host = globalThis as MutableGlobal;

afterEach(() => {
  delete host.window;
  delete host.localStorage;
});

describe("DefaultNativeTransactionAttemptStore", () => {
  it("persists and removes attempts in browser storage", () => {
    const values = new Map<string, string>();
    host.window = {};
    host.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const store = new DefaultNativeTransactionAttemptStore();
    const transaction = { txHash: "tx", relatedTxHashes: ["first", "tx"] };

    store.put("network:wallet", transaction);
    expect(store.get("network:wallet")).toEqual(transaction);
    store.delete("network:wallet");
    expect(store.get("network:wallet")).toBeUndefined();
  });

  it("fails before broadcast when durable browser storage cannot be written", () => {
    host.window = {};
    host.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => undefined,
    };

    expect(() =>
      new DefaultNativeTransactionAttemptStore().put("network:wallet", {
        txHash: "tx",
      })
    ).toThrow("Unable to persist");
  });

  it("reports failed durable deletion instead of pretending the guard cleared", () => {
    host.window = {};
    host.localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(() =>
      new DefaultNativeTransactionAttemptStore().delete("network:wallet")
    ).toThrow("Unable to remove");
  });

  it("requires non-browser hosts to inject durable storage before sending", () => {
    expect(() =>
      new DefaultNativeTransactionAttemptStore().put("network:wallet", {
        txHash: "tx",
      })
    ).toThrow("persistence is unavailable");
  });
});

describe("nativeTransactionAttemptKey", () => {
  it("separates networks for the same chain address", () => {
    const common = { family: "solana" as const, address: "same-address" };
    expect(
      nativeTransactionAttemptKey({ ...common, chainIdentifier: "devnet" })
    ).not.toBe(
      nativeTransactionAttemptKey({ ...common, chainIdentifier: "mainnet" })
    );
  });
});
