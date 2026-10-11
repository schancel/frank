import { fixedStampDefault } from '../../wallet/oracle/stamp-policy.testutil'
/**
 * The bot host's poll against a REAL typed wallet (#1236 Q3): a paid reply the host holds no
 * incomplete row for is finished by polls alone, and an idle wallet is asked without a single
 * payment or node request leaving it.
 *
 * The host is registered as in `bot-host-reliability.jest.test.ts` (its relay profile and
 * directory are stand-ins), then its bot is given a wallet from the shared two-wallet fixture
 * (`@frank/wallet/chain/canonical-two-wallets.testutil`): real typed custody, real Level
 * journals, the real link store, real directory admission, real sealing and real stamp funding.
 * Only the chain RPC, the chain HTTP client and the relay's HTTP surface are stand-ins, and each
 * counts what it was asked. The poll's own mailbox read happens once per poll by design and is
 * not what is counted here: it is answered "nothing new" without reaching the wallet.
 */
// First: the mock factories below load this file while the wallet modules are still loading.
import {
  chainHttpRequests,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  providerRequests,
  type Fixture,
  type InboxRecord,
} from "@frank/wallet/chain/canonical-two-wallets.testutil";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { MonadStampPendingAttemptError } from "@frank/wallet/monad-stamp-client";
import { FrankBotHost } from "../src/bot-host";
import type { FrankBotDefinition } from "../src/types";

jest.mock("@frank/wallet/monad-provider", () =>
  require("@frank/wallet/chain/canonical-two-wallets.testutil").offlineProviderModule()
);
jest.mock("@frank/wallet/monad-http", () =>
  require("@frank/wallet/chain/canonical-two-wallets.testutil").offlineHttpModule()
);
jest.mock("@frank/cashweb/relay/monad-mailbox-client", () =>
  require("@frank/wallet/chain/canonical-two-wallets.testutil").offlineMailboxModule()
);
jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));
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
// The host builds its own chain and wallet at registration; that stays a stand-in. The fixture
// builds the real chain through the same module, recognised by its storage location.
jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  const hostWallets = new WeakSet<object>();
  return {
    ...actual,
    createEvmChain: (config: { walletStorageLocation?: string }) =>
      config.walletStorageLocation?.includes("chain-blackjack-")
        ? actual.createEvmChain(config)
        : {
            chainIdentifier: "monad-testnet",
            directMessages: {},
            topics: { post: jest.fn() },
            createWallet: async (roots: MonadRootBundle) => {
              const { MonadIdentity } = jest.requireActual<
                typeof import("@frank/wallet/monad-identity")
              >("@frank/wallet/monad-identity");
              const identity = MonadIdentity.fromDomainRoot(
                roots.authentication
              );
              const wallet = {
                identity,
                getReceiveAddress: async () => ({ raw: identity.address.raw }),
                close: async () => undefined,
              };
              hostWallets.add(wallet);
              return wallet;
            },
          },
    installCanonicalDirectory: (wallet: object, directory: unknown) =>
      hostWallets.has(wallet)
        ? () => undefined
        : actual.installCanonicalDirectory(wallet, directory),
    loadMonadChainConfigFromEnv: () => ({
      networkTag: "MONT",
      relayBaseUrl: "http://127.0.0.1:8098",
      resolveDefaultStamp: fixedStampDefault(1_000n),
    }),
  };
});

describe("the bot host's poll on a real wallet (#1236 Q3)", () => {
  jest.setTimeout(120_000);
  const stateDir =
    "/tmp/test-bot-wallet-reconcile-" + Math.random().toString(36).slice(2);
  const bot: FrankBotDefinition = {
    id: "real-wallet-bot",
    getProfile: () => ({ name: "RealWalletBot", bot: true }),
    onMessage: async () => undefined,
  };
  let f: Fixture;
  let host: FrankBotHost;
  let bobInbox: InboxRecord[];
  let reconcileAttempts: jest.Mock;
  let registrationRequests: number;

  /** Every request that left the wallet: node RPC, chain HTTP, and payment sets to the relay. */
  const requests = () =>
    providerRequests.length + chainHttpRequests.length + f.requests.length;
  const poll = () => (host as any).pollAllBots() as Promise<void>;
  /** Lets work the poll started and did not wait for (funding ahead) run to its end. */
  const settled = async () => {
    for (let quiet = 0, last = -1; quiet < 5; ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const now = requests();
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }
  };

  beforeEach(async () => {
    mockBalances.clear();
    mockFunded.length = 0;
    mailboxes.clear();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    // A stamp large enough that funding its accounts ahead costs less than it moves (the wallet
    // refuses to fund ahead otherwise).
    f = await fixture({ resolveDefaultStamp: fixedStampDefault(10n ** 9n )});
    const { installCanonicalDirectory } = jest.requireMock(
      "@frank/wallet/chain/monad-chain"
    );
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor("alice", f.alice, f.bob)
    );
    bobInbox = [];
    f.setMailbox(bobInbox);
    providerRequests.length = 0;
    chainHttpRequests.length = 0;

    host = new FrankBotHost({
      relayBaseUrl: "http://127.0.0.1:8098",
      stateDir: `${stateDir}/${expect.getState().currentTestName?.length}`,
    });
    // The real chain's operations, installed BEFORE registration: a call made while
    // registering would be counted.
    reconcileAttempts = jest.fn((params) =>
      f.chain.directMessages.reconcileAttempts(params)
    );
    Object.assign((host as any).chain.directMessages, {
      reconcileAttempts,
      fundAhead: (params: any) => f.chain.directMessages.fundAhead!(params),
      fetchSince: async () => [],
    });
    await host.register(bot);
    registrationRequests = requests();
    // From here the bot's wallet is the fixture's funded real wallet.
    (host as any).instances.get("real-wallet-bot").wallet = f.alice;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await f.close().catch(() => undefined);
  });

  // On main 1715ec7c the poll asks the wallet nothing here (no incomplete row points at the
  // reply), so the reply is never delivered.
  it("a paid reply with no row is delivered by polls alone, as the same single payment set; nothing is asked or sent during registration", async () => {
    expect(reconcileAttempts).not.toHaveBeenCalled();
    expect(registrationRequests).toBe(0);

    f.setPhase("retained");
    let digest = "";
    await expect(
      f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: [{ type: "text", text: "a reply nobody remembers" }],
        onAttemptCreated: (created) => void (digest = created),
      })
    ).rejects.toBeInstanceOf(MonadStampPendingAttemptError);
    expect(f.requests).toHaveLength(1);
    expect(bobInbox).toHaveLength(0);
    const funded = mockFunded.length;

    // Still kept by the relay: the poll sends the same bytes again and it stays undelivered.
    await poll();
    expect(f.requests).toHaveLength(2);
    expect(bobInbox).toHaveLength(0);
    f.setPhase("delivered");
    await poll();
    expect(bobInbox).toHaveLength(1);
    await poll();
    await settled();

    for (const [params] of reconcileAttempts.mock.calls)
      expect(params.payloadDigests).toEqual([]);
    expect(f.requests).toHaveLength(3);
    for (const request of f.requests)
      expect(Buffer.from(request.body)).toEqual(Buffer.from(f.requests[0].body));
    expect(bobInbox).toHaveLength(1);
    await expect(
      f.chain.directMessages.reconcileAttempts({
        wallet: f.alice,
        payloadDigests: [digest],
      })
    ).resolves.toEqual({ [digest]: "delivered" });
    expect(f.requests).toHaveLength(3);
    // What moved on the chain since is the funding of the NEXT reply, never a second payment
    // for this one: at most the two accounts one message spends.
    expect(mockFunded.length - funded).toBeLessThanOrEqual(2);
  });

  it("an idle wallet: twenty polls make no payment request and no node request", async () => {
    // Positive control: the first poll funds the next reply ahead, and the counters see it.
    await poll();
    await settled();
    expect(mockFunded.length).toBeGreaterThanOrEqual(2);
    expect(requests()).toBeGreaterThan(0);
    await poll();
    await settled();

    providerRequests.length = 0;
    chainHttpRequests.length = 0;
    const asked = reconcileAttempts.mock.calls.length;
    for (let i = 0; i < 20; i++) await poll();
    await settled();
    expect(reconcileAttempts).toHaveBeenCalledTimes(asked + 20);
    expect(providerRequests).toEqual([]);
    expect(chainHttpRequests).toEqual([]);
    expect(f.requests).toHaveLength(0);
  });
});
