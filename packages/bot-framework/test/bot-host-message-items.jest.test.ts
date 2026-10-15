import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FrankBotHost } from "../src/bot-host";
import { DirectoryManager } from "../src/directory-manager";
import { installCanonicalDirectory } from "@frank/wallet/chain/monad-chain";
import { installMessageItemRegistry } from "@frank/wallet/chain/monad-canonical-dm";
import { createMessageItemRegistry } from "@frank/wallet/message-item-plugins/registry";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";

jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../src/directory-manager", () => ({
  DirectoryManager: {
    create: jest.fn(() => ({
      network: "monad-testnet",
      publishWithRetry: jest.fn().mockResolvedValue(undefined),
      startHeartbeat: jest.fn(),
      rawDirectory: {},
      close: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));
const mockRemoveDirectory = jest.fn();
const mockRemoveItems = jest.fn();
const mockWallets: Array<{ close: jest.Mock }> = [];
jest.mock("@frank/wallet/chain/monad-canonical-dm", () => ({
  ...jest.requireActual("@frank/wallet/chain/monad-canonical-dm"),
  installMessageItemRegistry: jest.fn(() => mockRemoveItems),
}));
jest.mock("@frank/wallet/chain/monad-chain", () => ({
  ...jest.requireActual("@frank/wallet/chain/monad-chain"),
  installCanonicalDirectory: jest.fn(() => mockRemoveDirectory),
  loadMonadChainConfigFromEnv: jest.fn(() => ({
    resolveDefaultStamp:
      require("../../wallet/oracle/stamp-policy.testutil").fixedStampDefault(
        1000n
      ),
    chainIdentifier: "monad-testnet",
    networkTag: "MONT",
    relayBaseUrl: "http://127.0.0.1:8098",
  })),
  createEvmChain: jest.fn(() => ({
    chainIdentifier: "monad-testnet",
    directMessages: { reconcileAttempts: jest.fn().mockResolvedValue({}) },
    nativeTransfers: {},
    topics: {},
    createWallet: jest.fn(async (roots: MonadRootBundle) => {
      const { MonadIdentity } = jest.requireActual(
        "@frank/wallet/monad-identity"
      );
      const wallet = {
        identity: MonadIdentity.fromDomainRoot(roots.authentication),
        close: jest.fn().mockResolvedValue(undefined),
      };
      mockWallets.push(wallet);
      return wallet;
    }),
  })),
}));
let root: string;
let host: FrankBotHost;
let original: NodeJS.ProcessEnv;
beforeEach(() => {
  jest.clearAllMocks();
  mockWallets.length = 0;
  original = process.env;
  process.env = { ...original };
  for (const key of [
    "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
    "FRANK_DEMO_FAUCET_WALLET_JSON",
    "E2E_DEMO_MAIN_WALLET_JSON",
    "FRANK_BOT_MAX_REPLIES_PER_PEER",
  ])
    delete process.env[key];
  root = mkdtempSync(join(tmpdir(), "s5b-host-"));
});
afterEach(async () => {
  await host?.stop();
  rmSync(root, { recursive: true, force: true });
  process.env = original;
});
const definition = {
  id: "inert-registry",
  getProfile: () => ({ name: "inert-registry", bot: true }),
  onMessage: jest.fn(),
};
const options = () => ({
  stateDir: root,
  relayBaseUrl: "http://127.0.0.1:8098",
  rpcUrl: "http://127.0.0.1:1",
  watchRegistrations: false,
});
it("consumes the injected factory at actual wallet installation and removes both hooks on stop", async () => {
  const registry = createMessageItemRegistry(),
    factory = jest.fn(() => registry);
  host = new FrankBotHost({ ...options(), createMessageItemRegistry: factory });
  await host.register(definition);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(installMessageItemRegistry).toHaveBeenCalledWith(
    mockWallets[0],
    registry
  );
  await host.stop();
  expect(mockRemoveItems).toHaveBeenCalledTimes(1);
  expect(mockRemoveDirectory).toHaveBeenCalledTimes(1);
  expect(mockWallets[0].close).toHaveBeenCalledTimes(1);
  expect(definition.onMessage).not.toHaveBeenCalled();
});
it("preserves the framework defaults when no factory opts in", async () => {
  host = new FrankBotHost(options());
  await host.register(definition);
  const registry = jest.mocked(installMessageItemRegistry).mock.calls[0][1];
  expect(registry.has("text")).toBe(true);
  expect(registry.has("swap-negotiation-v1")).toBe(false);
});
it("surfaces a factory failure, closes opened resources, installs no hooks and permits reopen", async () => {
  const failure = new Error("registry composition failed");
  const factory = jest.fn(() => {
    throw failure;
  });
  host = new FrankBotHost({ ...options(), createMessageItemRegistry: factory });
  await expect(host.register(definition)).rejects.toBe(failure);
  expect(installCanonicalDirectory).not.toHaveBeenCalled();
  expect(installMessageItemRegistry).not.toHaveBeenCalled();
  expect(mockWallets[0].close).toHaveBeenCalledTimes(1);
  const directory = jest.mocked(DirectoryManager.create).mock.results[0].value;
  expect(directory.close).toHaveBeenCalledTimes(1);
  factory.mockImplementation(() => createMessageItemRegistry());
  await host.register(definition); // real Level state/journal locks were released
  expect(mockWallets).toHaveLength(2);
  expect(installMessageItemRegistry).toHaveBeenCalledTimes(1);
});
