import type { UtxoStealthCustody } from "../utxo-stealth";
import type { UtxoChainConfig } from "./utxo-chain";

const mockClose = jest.fn(async () => undefined);
const mockCreateWallet = jest.fn(async () => ({
  chainIdentifier: "btc-testnet",
}));
let mockConfig: UtxoChainConfig;
let mockEcashConfig: import("./ecash-chain").EcashChainConfig;
jest.mock("./electrum-client", () => ({
  ElectrumClient: jest.fn(() => ({ close: mockClose })),
}));
jest.mock("./electrum-indexer", () => ({
  relayElectrumUrl: () => "wss://relay.invalid/electrum",
  electrumIndexer: () => ({}),
}));
jest.mock("./utxo-chain", () => ({
  createUtxoChain: (config: UtxoChainConfig) => {
    mockConfig = config;
    return {
      chainIdentifier: config.chainIdentifier,
      createWallet: mockCreateWallet,
    };
  },
}));
jest.mock("./ecash-chain", () => ({
  createEcashChain: (config: import("./ecash-chain").EcashChainConfig) => {
    mockEcashConfig = config;
    return { chainIdentifier: "xec-testnet", createWallet: mockCreateWallet };
  },
}));
import { openRelayUtxoChain } from "./utxo-family";

const derivation = {
  chainIdentifier: "btc-testnet",
  identityPublicKey: new Uint8Array(33).fill(2),
  ephemeralPubKey: new Uint8Array(33).fill(3),
};
const sign = jest.fn(() => new Uint8Array(70));
const custody: UtxoStealthCustody = {
  identityPublicKey: derivation.identityPublicKey,
  deriveStealthSigner: jest.fn(async () => ({
    publicKey: new Uint8Array(33).fill(4),
    sign,
  })),
};
function open() {
  return openRelayUtxoChain({
    chainIdentifier: "btc-testnet",
    relayBaseUrl: "https://relay.invalid",
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockCreateWallet.mockImplementation(async () => ({
    chainIdentifier: "btc-testnet",
  }));
});
test("forwards custody privately, wipes the construction copy, and revokes synchronous signing before close awaits", async () => {
  const relay = open(),
    root = new Uint8Array(32).fill(7);
  let constructionCopy: Uint8Array | undefined;
  mockCreateWallet.mockImplementationOnce(async (bytes) => {
    constructionCopy = bytes;
    expect(bytes).not.toBe(root);
    expect(bytes).toEqual(root);
    return { chainIdentifier: "btc-testnet" };
  });
  await relay.createWallet(root, { stealthCustody: custody });
  expect(root.every((byte) => byte === 7)).toBe(true);
  expect(constructionCopy!.every((byte) => byte === 0)).toBe(true);
  const guarded = mockConfig.stealthCustody!;
  const key = await guarded.deriveStealthSigner(derivation);
  key.sign(new Uint8Array(32));
  expect(sign).toHaveBeenCalledTimes(1);
  let finish!: () => void;
  mockClose.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const closing = relay.close();
  expect(() => key.sign(new Uint8Array(32))).toThrow("closed");
  await expect(guarded.deriveStealthSigner(derivation)).rejects.toThrow(
    "closed"
  );
  await expect(
    relay.createWallet(root, { stealthCustody: custody })
  ).rejects.toThrow("closed");
  finish();
  await closing;
});
test("close during asynchronous derivation prevents a new signing capability escaping", async () => {
  const relay = open();
  let finish!: (
    value: Awaited<ReturnType<UtxoStealthCustody["deriveStealthSigner"]>>
  ) => void;
  const delayed = {
    ...custody,
    deriveStealthSigner: () =>
      new Promise<
        Awaited<ReturnType<UtxoStealthCustody["deriveStealthSigner"]>>
      >((resolve) => {
        finish = resolve;
      }),
  };
  await relay.createWallet(new Uint8Array(32).fill(7), {
    stealthCustody: delayed,
  });
  const deriving = mockConfig.stealthCustody!.deriveStealthSigner(derivation);
  await relay.close();
  finish({ publicKey: new Uint8Array(33), sign });
  await expect(deriving).rejects.toThrow("closed");
  expect(sign).not.toHaveBeenCalled();
});
test("close during wallet construction rejects the result and wipes its material", async () => {
  const relay = open();
  let finish!: () => void, copy!: Uint8Array;
  mockCreateWallet.mockImplementationOnce((bytes) => {
    copy = bytes;
    return new Promise((resolve) => {
      finish = () => resolve({ chainIdentifier: "btc-testnet" });
    });
  });
  const opening = relay.createWallet(new Uint8Array(32).fill(7), {
    stealthCustody: custody,
  });
  await relay.close();
  finish();
  await expect(opening).rejects.toThrow("closed");
  expect(copy.every((byte) => byte === 0)).toBe(true);
});
test("Chronik explicitly refuses requested unsupported custody instead of ignoring it", async () => {
  const relay = openRelayUtxoChain({
    chainIdentifier: "xec-testnet",
    relayBaseUrl: "https://relay.invalid",
  });
  expect(() =>
    relay.createWallet(new Uint8Array(32).fill(7), { stealthCustody: custody })
  ).toThrow("unsupported");
  expect(mockCreateWallet).not.toHaveBeenCalled();
});

test("Chronik privately forwards explicit domain-root and historical SDK factories without changing seed material", async () => {
  const relay = openRelayUtxoChain({
    chainIdentifier: "xec-testnet",
    relayBaseUrl: "https://relay.invalid",
  });
  const factory = jest.fn(),
    historicalFactory = jest.fn();
  const root = new Uint8Array(32).fill(7);
  let copied: Uint8Array | undefined;
  mockCreateWallet.mockImplementationOnce(async (material) => {
    copied = material.bytes;
    return { chainIdentifier: "xec-testnet" };
  });
  await relay.createWallet(root, {
    ecashWalletFactory: factory,
    ecashBip39WalletFactory: historicalFactory,
  });
  expect(mockEcashConfig.walletFactory).toBe(factory);
  expect(mockEcashConfig.bip39WalletFactory).toBe(historicalFactory);
  expect(copied).not.toBe(root);
  expect(copied!.every((byte) => byte === 0)).toBe(true);
  expect(root.every((byte) => byte === 7)).toBe(true);
  const seed = new Uint8Array(64).fill(8);
  mockCreateWallet.mockImplementationOnce(async (material) => {
    copied = material.seed;
    return { chainIdentifier: "xec-testnet" };
  });
  await relay.createWallet(
    { derivation: "frank-bip39-bip32-v1", seed },
    { ecashWalletFactory: factory, ecashBip39WalletFactory: historicalFactory }
  );
  expect(copied).not.toBe(seed);
  expect(copied!.every((byte) => byte === 0)).toBe(true);
  expect(seed.every((byte) => byte === 8)).toBe(true);
});
test("Electrum refuses eCash construction factories", async () => {
  await expect(
    open().createWallet(new Uint8Array(32), { ecashWalletFactory: jest.fn() })
  ).rejects.toThrow("unsupported");
});

test("Chronik close synchronously revokes lifecycle and new construction", async () => {
  const relay = openRelayUtxoChain({
    chainIdentifier: "xec-testnet",
    relayBaseUrl: "https://relay.invalid",
  });
  expect(relay.assertActive).toEqual(expect.any(Function));
  relay.assertActive!();
  const closing = relay.close();
  expect(() => relay.assertActive!()).toThrow("closed");
  expect(() => relay.createWallet(new Uint8Array(32).fill(7))).toThrow(
    "closed"
  );
  expect(mockCreateWallet).not.toHaveBeenCalled();
  await closing;
});
test("Chronik close during construction rejects the wallet and wipes its copied material", async () => {
  const relay = openRelayUtxoChain({
    chainIdentifier: "xec-testnet",
    relayBaseUrl: "https://relay.invalid",
  });
  let finish!: () => void, copy!: Uint8Array;
  mockCreateWallet.mockImplementationOnce((material) => {
    copy = material.bytes;
    return new Promise((resolve) => {
      finish = () => resolve({ chainIdentifier: "xec-testnet" });
    });
  });
  const opening = relay.createWallet(new Uint8Array(32).fill(7));
  await relay.close();
  finish();
  await expect(opening).rejects.toThrow("closed");
  expect(copy.every((byte) => byte === 0)).toBe(true);
});
