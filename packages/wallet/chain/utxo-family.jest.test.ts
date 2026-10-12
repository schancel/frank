import type { UtxoStealthCustody } from "../utxo-stealth";
import type { UtxoChainConfig } from "./utxo-chain";

const mockClose = jest.fn(async () => undefined);
const mockCreateWallet = jest.fn(async () => ({
  chainIdentifier: "btc-testnet",
}));
let mockConfig: UtxoChainConfig;
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
  createEcashChain: () => ({
    chainIdentifier: "xec-testnet",
    createWallet: mockCreateWallet,
  }),
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
