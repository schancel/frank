import { fixedStampDefault } from '../../wallet/oracle/stamp-policy.testutil'
/**
 * Several bots on one host in one process, the way the demo runs them: one shared funding
 * wallet and nonce sequence, and no bot able to hold up another. The host, its poll, journal
 * and nonce sequencer are real; the chain's direct-message client, the directory, the relay
 * profile call and the RPC provider are replaced.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet, getBytes } from "ethers";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { FrankBotHost } from "../src/bot-host";
import { EVMNonceSequencer } from "../src/nonce-sequencer";
import type { FrankBotDefinition } from "../src/types";

jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));
const mockPublish = jest.fn();
jest.mock("../src/directory-manager", () => ({
  DirectoryManager: {
    create: jest.fn(() => ({
      network: "monad-testnet",
      publish: jest.fn().mockResolvedValue(undefined),
      publishWithRetry: mockPublish,
      startHeartbeat: jest.fn(),
      rawDirectory: {},
      lookupPeer: jest.fn(),
      close: jest.fn(),
    })),
  },
}));

const mockSend = jest.fn();
const mockFetchSince = jest.fn();
jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  return {
    ...actual,
    createEvmChain: jest.fn(() => ({
      chainIdentifier: "monad-testnet",
      // A unit no network has: what a bot prints can only have come from this chain object.
      unit: "UNIT",
      toDisplayAmount: (raw: bigint) => `${raw}`,
      fromDisplayAmount: (display: string) => BigInt(display),
      directMessages: {
        fetchSince: mockFetchSince,
        send: mockSend,
        reconcileAttempts: jest.fn().mockResolvedValue({}),
      },
      topics: { post: jest.fn() },
      createWallet: jest.fn(async (roots: MonadRootBundle) => {
        const { MonadIdentity } = jest.requireActual<
          typeof import("@frank/wallet/monad-identity")
        >("@frank/wallet/monad-identity");
        const identity = MonadIdentity.fromDomainRoot(roots.authentication);
        return {
          identity,
          getReceiveAddress: jest.fn(async () => identity.address),
          close: jest.fn().mockResolvedValue(undefined),
        };
      }),
    })),
    installCanonicalDirectory: jest.fn(() => () => {}),
    loadMonadChainConfigFromEnv: jest.fn(() => ({
      networkTag: "MONT",
      relayBaseUrl: "http://127.0.0.1:8098",
      resolveDefaultStamp: fixedStampDefault(10_000_000_000_000_000n),
    })),
  };
});

const peer = new Wallet("0x" + "12".repeat(32));

describe("several bots on one host", () => {
  let stateDir: string;
  let environment: NodeJS.ProcessEnv;
  let host: FrankBotHost | undefined;

  const bot = (
    id: string,
    onMessage: FrankBotDefinition["onMessage"] = async () => [
      { type: "text", text: "answer from " + id },
    ]
  ): FrankBotDefinition => ({
    id,
    getProfile: () => ({ name: id, bot: true }),
    onMessage,
  });
  const instanceOf = (id: string) => (host as any).instances.get(id);
  const pollAllBots = (): Promise<void> => (host as any).pollAllBots();
  /** A message to the bot `id`, from `peer`. */
  const inboundFor = (id: string, text: string, n = 1) => {
    const identity = instanceOf(id).wallet.identity;
    return {
      senderAddress: { raw: peer.address.toLowerCase() },
      senderPublicKey: getBytes(peer.signingKey.compressedPublicKey),
      recipientPublicKey: new Uint8Array(identity.compressedPubKey),
      recipientAddress: { raw: identity.address.raw },
      messageId: `0${n}0${n}0${n}0${n}-0202-0202-0202-020202020202`,
      items: [{ type: "text", text }],
      payloadDigest: `0${n}`.repeat(32),
      stampValueWei: 1n,
      stampPayments: [],
      receivedTime: 1_700_000_000_000 + n,
    };
  };
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 2000 && !condition(); i++)
      await new Promise((r) => setImmediate(r));
    if (!condition()) throw new Error("condition was never met");
  };
  const textsSent = (): string[] =>
    mockSend.mock.calls.map(([params]) => params.items[0].text);

  beforeEach(() => {
    environment = process.env;
    process.env = { ...environment };
    for (const key of [
      "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
      "FRANK_DEMO_FAUCET_WALLET_JSON",
      "E2E_DEMO_MAIN_WALLET_JSON",
      "FRANK_BOT_MAX_REPLIES_PER_PEER",
    ])
      delete process.env[key];
    jest.clearAllMocks();
    mockPublish.mockReset().mockResolvedValue(undefined);
    mockFetchSince.mockReset().mockResolvedValue([]);
    mockSend.mockReset().mockImplementation(async (params) => {
      const payloadDigest = (0xd0 + mockSend.mock.calls.length)
        .toString(16)
        .repeat(32);
      await params.onAttemptCreated?.(payloadDigest);
      return {
        payloadDigest,
        stampValueWei: 1n,
        stampPayments: [],
        preparationTxHashes: [],
      };
    });
    jest.spyOn(console, "log").mockImplementation(() => {});
    stateDir = mkdtempSync(join(tmpdir(), "bot-host-multi-"));
    host = undefined;
  });
  afterEach(async () => {
    // A relay call left hanging by a test must not hold the stop.
    for (const release of hung.splice(0)) release();
    await host?.stop();
    rmSync(stateDir, { recursive: true, force: true });
    process.env = environment;
    jest.restoreAllMocks();
  });
  const hung: (() => void)[] = [];
  const newHost = (options: object = {}) =>
    (host = new FrankBotHost({
      relayBaseUrl: "http://127.0.0.1:8098",
      rpcUrl: "http://127.0.0.1:1",
      stateDir,
      watchRegistrations: false,
      ...options,
    }));

  it("gives each bot the amount formatter of the chain the host runs on", async () => {
    newHost();
    await host!.registerAll([
      bot("teller", async (_message, ctx) => [
        {
          type: "text",
          text: `${ctx.formatAmount(5n)} for ${ctx.parseAmount("7")}`,
        },
      ]),
    ]);
    mockFetchSince.mockResolvedValue([inboundFor("teller", "how much?")]);
    await pollAllBots();
    await until(() => textsSent().length === 1);
    expect(textsSent()).toEqual(["5 UNIT for 7"]);
  });

  // On 05c93db0 the host polled its bots one after another inside one pass: while bot A's
  // mailbox read hung, bot B was never polled again.
  it("a relay call that hangs for one bot does not delay another bot's reply, now or on later polls", async () => {
    newHost();
    await host!.registerAll([bot("slow"), bot("quick")]);
    const slowWallet = instanceOf("slow").wallet;
    let mail = [inboundFor("quick", "one", 1)];
    mockFetchSince.mockImplementation(({ wallet }) =>
      wallet === slowWallet
        ? new Promise((resolve) => hung.push(() => resolve([])))
        : Promise.resolve(mail)
    );

    const first = pollAllBots();
    await until(() => textsSent().length === 1);
    expect(textsSent()).toEqual(["answer from quick"]);

    // The next ticks: the slow bot's pass is still the same one, the quick bot polls again.
    mail = [inboundFor("quick", "two", 2)];
    void pollAllBots();
    await until(() => textsSent().length === 2);
    void pollAllBots();
    const reads = (wallet: unknown) =>
      mockFetchSince.mock.calls.filter(([params]) => params.wallet === wallet)
        .length;
    await until(() => reads(instanceOf("quick").wallet) === 3);
    expect(reads(slowWallet)).toBe(1);
    expect(textsSent()).toEqual(["answer from quick", "answer from quick"]);

    // Once its relay answers, the slow bot is served like any other.
    for (const release of hung.splice(0)) release();
    await first;
    mockFetchSince.mockImplementation(async ({ wallet }) =>
      wallet === slowWallet ? [inboundFor("slow", "at last", 3)] : []
    );
    await pollAllBots();
    await until(() => textsSent().length === 3);
    expect(textsSent()[2]).toBe("answer from slow");
  });

  it("a bot whose poll fails is reported by name and the others are still served", async () => {
    newHost();
    await host!.registerAll([bot("broken"), bot("fine")]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const broken = instanceOf("broken").wallet;
    mockFetchSince.mockImplementation(async ({ wallet }) => {
      if (wallet === broken) throw new Error("relay refused");
      return [inboundFor("fine", "hello")];
    });
    await pollAllBots();
    await until(() => textsSent().length === 1);
    expect(textsSent()).toEqual(["answer from fine"]);
    expect(
      warn.mock.calls.some(([line]) =>
        String(line).includes('Failed polling messages for bot "broken"')
      )
    ).toBe(true);
  });

  // On 05c93db0 `register` threw to the caller, and the launcher that registers every bot in
  // turn stopped there: one bad bot meant no bots.
  it("a bot that cannot be built or registered is reported by name, and the rest are registered and serve", async () => {
    newHost();
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    mockPublish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("relay rejected the directory entry"))
      .mockResolvedValue(undefined);
    const failed = await host!.registerAll([
      bot("first"),
      bot("unpublishable"),
      () => {
        throw new Error("Missing required env var QWEN_API_KEY");
      },
      () => bot("last"),
    ]);
    expect(failed).toEqual(["unpublishable", "#3"]);
    expect([...(host as any).instances.keys()]).toEqual(["first", "last"]);
    const lines = error.mock.calls.map((call) => call.join(" "));
    expect(lines[0]).toContain('Bot "unpublishable" could not be started');
    expect(lines[0]).toContain("relay rejected the directory entry");
    expect(lines[1]).toContain("QWEN_API_KEY");

    mockFetchSince.mockImplementation(async ({ wallet }) =>
      wallet === instanceOf("last").wallet ? [inboundFor("last", "hello")] : []
    );
    await pollAllBots();
    await until(() => textsSent().length === 1);
    expect(textsSent()).toEqual(["answer from last"]);
    // The failed bot can be registered later, once what stopped it is fixed.
    await host!.register(bot("unpublishable"));
    expect((host as any).instances.has("unpublishable")).toBe(true);
  });

  // The shared funding wallet has one nonce sequence in the process. Separate bot processes
  // each kept their own, and their top-ups collided at the same nonce.
  it("ten bots topping up at once make ten transfers at ten consecutive nonces, one at a time", async () => {
    let clock = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    newHost({ fundingPrivateKeyHex: "0x" + "22".repeat(32) });
    const funder = "0x1111111111111111111111111111111111111111";
    let botBalance = 500_000_000_000_000_000n;
    const provider = {
      getBalance: jest.fn(async (address: string) =>
        address === funder ? 50_000_000_000_000_000_000n : botBalance
      ),
      getTransactionCount: jest.fn(async () => 7),
    };
    const sent: { to: string; nonce: number }[] = [];
    let building = 0;
    let overlapped = false;
    (host as any).provider = provider;
    (host as any).fundingWallet = {
      address: funder,
      sendTransaction: jest.fn(async ({ to, nonce }) => {
        if (++building > 1) overlapped = true;
        await new Promise((r) => setImmediate(r));
        sent.push({ to, nonce });
        building--;
        // The first transfer is never seen mined. On 16218e9f its receipt was awaited inside
        // the shared sequence, and every later top-up waited behind it.
        return {
          wait: () =>
            sent.length === 1
              ? new Promise((resolve) => hung.push(() => resolve(undefined)))
              : Promise.resolve(),
        };
      }),
    };
    (host as any).nonceSequencer = new EVMNonceSequencer(
      provider as never,
      funder
    );
    const ids = Array.from({ length: 10 }, (_, i) => "bot" + i);
    expect(await host!.registerAll(ids.map((id) => bot(id)))).toEqual([]);
    expect(sent).toEqual([]);

    botBalance = 0n;
    clock += 31_000;
    await pollAllBots();
    await until(() => sent.length === 10);
    await until(
      () => ids.filter((id) => instanceOf(id).toppingUp).length === 1
    );

    expect(sent.map((tx) => tx.nonce)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(new Set(sent.map((tx) => tx.to))).toEqual(
      new Set(ids.map((id) => instanceOf(id).wallet.identity.address.raw))
    );
    expect(overlapped).toBe(false);
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  // On 16218e9f a payout the bot could not cover made the shared funding wallet send the
  // shortfall plus 0.05 MON, an amount the handler chose, and waited for it without a limit
  // inside the shared sequence.
  it("a payout a bot cannot cover is refused by name and takes nothing from the shared funding wallet", async () => {
    newHost({ fundingPrivateKeyHex: "0x" + "22".repeat(32) });
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const fundingSend = jest.fn();
    (host as any).provider = {
      getBalance: jest.fn(async () => 600_000_000_000_000_000n),
      getFeeData: jest.fn(async () => ({ gasPrice: 1n })),
    };
    (host as any).fundingWallet = {
      address: "0x1111111111111111111111111111111111111111",
      sendTransaction: fundingSend,
    };
    await host!.registerAll([bot("payer")]);
    const context = instanceOf("payer").context;
    const to = "0x9999999999999999999999999999999999999999";
    const own = jest.spyOn(Wallet.prototype, "sendTransaction");
    for (const pay of [
      () => context.sendTransfer({ to, valueWei: 10n ** 21n }),
      () => context.sendTransaction({ to, valueWei: 10n ** 21n }),
      () => context.buildAndSignTransfer({ to, valueWei: 10n ** 21n }),
    ])
      await expect(pay()).rejects.toMatchObject({
        name: "BotBalanceShortError",
        botId: "payer",
        balanceWei: 600_000_000_000_000_000n,
      });
    expect(fundingSend).not.toHaveBeenCalled();
    expect(own).not.toHaveBeenCalled();
    own.mockRestore();
    // A handler may swallow the rejection; the host has said it regardless, with the bot, the
    // recipient and the amount.
    const said = error.mock.calls.map((call) => call.join(" "));
    expect(said).toHaveLength(3);
    for (const line of said) {
      expect(line).toContain("[payer] TRANSFER FAILED");
      expect(line).toContain(`${10n ** 21n} wei to ${to}`);
    }
  });

  it("builds a bot's own transactions one at a time, so two payouts never read the same nonce", async () => {
    newHost();
    await host!.registerAll([bot("payer")]);
    let pending = 3;
    let inside = 0;
    let overlapped = false;
    const used: number[] = [];
    (host as any).provider.getBalance = async () => 10n ** 18n;
    (host as any).provider.getFeeData = async () => ({ gasPrice: 1n });
    (host as any).provider.getTransactionCount = async () => {
      if (++inside > 1) overlapped = true;
      await new Promise((r) => setImmediate(r));
      return pending;
    };
    const send = jest
      .spyOn(Wallet.prototype, "sendTransaction")
      .mockImplementation(async (tx) => {
        await new Promise((r) => setImmediate(r));
        used.push(Number(tx.nonce));
        pending++;
        inside--;
        return { hash: "0x" + used.length.toString(16).padStart(64, "0") } as never;
      });
    const context = instanceOf("payer").context;
    const to = "0x9999999999999999999999999999999999999999";
    await Promise.all(
      [1n, 2n, 3n, 4n].map((valueWei) => context.sendTransfer({ to, valueWei }))
    );
    expect(used).toEqual([3, 4, 5, 6]);
    expect(overlapped).toBe(false);
    send.mockRestore();
  });
});
