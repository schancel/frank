import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { FrankBotHost } from "../src/bot-host";
import { RelayProfileManager } from "../src/relay-profile-manager";
import {
  MonadMailboxRetryableError,
  MonadMailboxAuthError,
} from "@frank/cashweb/relay/monad-mailbox-client";
import type { FrankBotDefinition } from "../src/types";

jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  return {
    ...actual,
    createMonadChain: jest.fn(() => ({
      chainIdentifier: "monad-testnet",
      directMessages: {
        fetchSince: jest.fn(),
        send: jest.fn(),
      },
      topics: {
        post: jest.fn(),
      },
      createWallet: jest
        .fn()
        .mockImplementation(async (roots: MonadRootBundle) => {
          const { MonadIdentity } = jest.requireActual<
            typeof import("@frank/wallet/monad-identity")
          >("@frank/wallet/monad-identity");
          const identity = MonadIdentity.fromDomainRoot(roots.authentication);
          return { identity, close: jest.fn().mockResolvedValue(undefined) };
        }),
    })),
    installCanonicalDirectory: jest.fn(() => () => {}),
    loadMonadChainConfigFromEnv: jest.fn(() => ({
      networkTag: "MONT",
      relayBaseUrl: "http://127.0.0.1:8098",
      defaultStampValueWei: 10_000_000_000_000_000n,
    })),
  };
});

jest.mock("../src/directory-manager", () => ({
  DirectoryManager: {
    create: jest.fn(() => ({
      network: "monad-testnet",
      publish: jest.fn().mockResolvedValue(undefined),
      publishWithRetry: jest.fn().mockResolvedValue(undefined),
      startHeartbeat: jest.fn(),
      rawDirectory: {},
      lookupPeer: jest.fn(),
      close: jest.fn(),
    })),
  },
}));

describe("FrankBotHost auto-healing", () => {
  const dummyBot: FrankBotDefinition = {
    id: "qwen",
    getProfile: () => ({
      name: "Qwen",
      bio: "AI Assistant",
      bot: true,
    }),
    onMessage: async () => [],
  };

  let host: FrankBotHost;

  let originalEnvironment: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnvironment = process.env;
    process.env = { ...originalEnvironment };
    for (const key of [
      "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
      "FRANK_DEMO_FAUCET_WALLET_JSON",
      "E2E_DEMO_MAIN_WALLET_JSON",
    ])
      delete process.env[key];
    jest.clearAllMocks();
    host = new FrankBotHost({
      relayBaseUrl: "http://127.0.0.1:8098",
      stateDir: "/tmp/test-bot-autoheal-" + Math.random().toString(36).slice(2),
    });
  });

  afterEach(async () => {
    await host.stop();
    process.env = originalEnvironment;
  });

  it("manually auto-heals directory entry and profile on autoHealBot call", async () => {
    await host.register(dummyBot);

    const instance = (host as any).instances.get("qwen");
    expect(instance).toBeDefined();

    const result = await host.autoHealBot("qwen", "test_reason");
    expect(result).toBe(true);

    expect(instance.directory.publish).toHaveBeenCalledTimes(1);
    expect(RelayProfileManager.registerProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        relayBaseUrl: "http://127.0.0.1:8098",
        label: "qwen",
        force: true,
      })
    );
  });

  it("auto-heals all registered bots on autoHealAll call", async () => {
    await host.register(dummyBot);

    await host.autoHealAll();

    const instance = (host as any).instances.get("qwen");
    expect(instance.directory.publish).toHaveBeenCalledTimes(1);
    expect(RelayProfileManager.registerProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "qwen",
        force: true,
      })
    );
  });

  it("triggers autoHealBotRegistration when poll encounters canonical_mailbox_unavailable (503)", async () => {
    await host.register(dummyBot);
    const instance = (host as any).instances.get("qwen");
    expect(instance).toBeDefined();

    const mailboxUnavailableErr = new MonadMailboxRetryableError(
      "Canonical private mailbox: HTTP 503 canonical_mailbox_unavailable"
    );
    (mailboxUnavailableErr as any).status = 503;
    (mailboxUnavailableErr as any).code = "canonical_mailbox_unavailable";

    // Mock directMessages.fetchSince to reject with 503
    (host as any).chain.directMessages.fetchSince.mockRejectedValueOnce(
      mailboxUnavailableErr
    );

    const autoHealSpy = jest.spyOn(host, "autoHealBotRegistration");

    // Run one polling iteration
    await (host as any).pollAllBots();

    expect(autoHealSpy).toHaveBeenCalledWith(
      "qwen",
      instance,
      mailboxUnavailableErr
    );
    expect(instance.directory.publish).toHaveBeenCalledTimes(1);
    expect(RelayProfileManager.registerProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "qwen",
        force: true,
      })
    );
  });

  it("triggers autoHealBotRegistration when poll encounters mailbox_auth_failed (401)", async () => {
    await host.register(dummyBot);
    const instance = (host as any).instances.get("qwen");

    const authErr = new MonadMailboxAuthError("mailbox_auth_failed");
    (authErr as any).status = 401;
    (authErr as any).code = "mailbox_auth_failed";
    (host as any).chain.directMessages.fetchSince.mockRejectedValueOnce(
      authErr
    );

    const autoHealSpy = jest.spyOn(host, "autoHealBotRegistration");

    await (host as any).pollAllBots();

    expect(autoHealSpy).toHaveBeenCalledWith("qwen", instance, authErr);
    expect(instance.directory.publish).toHaveBeenCalledTimes(1);
  });

  it("throttles rapid consecutive recovery attempts within 10 seconds", async () => {
    await host.register(dummyBot);
    const instance = (host as any).instances.get("qwen");

    const mailboxUnavailableErr = new MonadMailboxRetryableError(
      "canonical_mailbox_unavailable"
    );
    (mailboxUnavailableErr as any).status = 503;
    (mailboxUnavailableErr as any).code = "canonical_mailbox_unavailable";
    (host as any).chain.directMessages.fetchSince
      .mockRejectedValueOnce(mailboxUnavailableErr)
      .mockRejectedValueOnce(mailboxUnavailableErr);

    const autoHealSpy = jest.spyOn(host, "autoHealBotRegistration");

    // First poll triggers auto-heal
    await (host as any).pollAllBots();
    expect(autoHealSpy).toHaveBeenCalledTimes(1);

    // Immediate second poll within 10s should be throttled
    await (host as any).pollAllBots();
    expect(autoHealSpy).toHaveBeenCalledTimes(1);
  });
});
