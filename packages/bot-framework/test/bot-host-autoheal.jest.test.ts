import { FrankBotHost } from "../src/bot-host";
import { RelayProfileManager } from "../src/relay-profile-manager";
import {
  MonadMailboxRetryableError,
  MonadMailboxAuthError,
} from "@frank/cashweb/relay/monad-mailbox-client";
import type {
  FrankBotDefinition,
  BotMessageContext,
  BotContext,
} from "../src/types";

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
      directMessages: {
        fetchSince: jest.fn(),
        send: jest.fn(),
      },
      topics: {
        post: jest.fn(),
      },
      createWallet: jest.fn().mockResolvedValue({
        identity: {
          address: { raw: "0x538910cdeadf7e47a6826700ebc860f1a6b3b4d5" },
          compressedPubKey: new Uint8Array(33),
          toPrivateKeyHex: () => "0x" + "11".repeat(32),
        },
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

  beforeEach(() => {
    jest.clearAllMocks();
    host = new FrankBotHost({
      relayBaseUrl: "http://127.0.0.1:8098",
      stateDir: "/tmp/test-bot-autoheal-" + Math.random().toString(36).slice(2),
    });
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
