/**
 * The blackjack dealer behind the real FrankBotHost dispatch path: the bet is the stamp value the
 * wallet reported for the received message, handed to the handler by the host. Only the chain,
 * the directory and the relay profile call are replaced; nothing here builds a message context
 * by hand.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet, getBytes } from "ethers";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import {
  buildBet,
  foldHand,
  type HandItem,
} from "@frank/wallet/message-item-plugins/blackjack/hand";
import { FrankBotHost } from "../../../bot-framework/src/bot-host";
import { BlackjackDealerBot } from "./blackjack-bot";

jest.mock("../../../bot-framework/src/relay-profile-manager", () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../../../bot-framework/src/directory-manager", () => ({
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

const mockSend = jest.fn();
const mockFetchSince = jest.fn();
const mockCheckMessagePayment = jest.fn();
let mockLocalAddress = "";
let mockLocalSubject = "";
jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  // How the real Monad testnet chain writes an amount: the dealer's text is made with it.
  const testnet = actual.createEvmChain({
    ...actual.loadMonadChainConfigFromEnv({ isTestnet: true }),
    walletStorageLocation: false,
  });
  return {
    ...actual,
    createEvmChain: jest.fn(() => ({
      chainIdentifier: "monad-testnet",
      unit: testnet.unit,
      toDisplayAmount: testnet.toDisplayAmount,
      fromDisplayAmount: testnet.fromDisplayAmount,
      directMessages: { fetchSince: mockFetchSince, send: mockSend },
      topics: { post: jest.fn() },
      createWallet: jest.fn(async (roots: MonadRootBundle) => {
        const { MonadIdentity } = jest.requireActual<
          typeof import("@frank/wallet/monad-identity")
        >("@frank/wallet/monad-identity");
        const identity = MonadIdentity.fromDomainRoot(roots.authentication);
        mockLocalAddress = identity.address.raw;
        mockLocalSubject = identity.compressedPubKey.toString("hex");
        return {
          identity,
          checkMessagePayment: mockCheckMessagePayment,
          getReceiveAddress: jest.fn(async () => ({ raw: mockLocalAddress })),
          close: jest.fn().mockResolvedValue(undefined),
        };
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

const STAMP = 10_000_000_000_000_000n;
const BET = 20_000_000_000_000_000n;
const player = new Wallet("0x" + "12".repeat(32));
const playerAddress = player.address.toLowerCase();
const conversationId = "01010101-0101-0101-0101-010101010101";

describe("blackjack dealer behind the bot host", () => {
  let stateDir: string;
  let host: FrankBotHost;
  let bot: BlackjackDealerBot;
  let onMessage: jest.SpyInstance;
  let originalEnvironment: NodeJS.ProcessEnv;
  let sequence = 0;

  /** Transfers the chain knows: what a bet's money is checked against. */
  const mined = new Map<string, { to: string; value: bigint }>();
  const receivedPayments = new Map<
    string,
    { txHash: string; destinationAddress: string; valueWei: bigint }[]
  >();

  /** `paidWei`: a mined transfer of that value comes with the message. `stampValueWei` alone is
   * only what the wallet says the message carried. */
  const inbound = (
    items: unknown[],
    stampValueWei: bigint | undefined,
    paidWei = 0n
  ) => {
    sequence += 1;
    const byte = sequence.toString(16).padStart(2, "0");
    const stampPayments =
      paidWei > 0n
        ? [
            {
              txHash: "0x" + byte.repeat(32),
              destinationAddress: "0x" + "5e".repeat(20),
              valueWei: paidWei,
            },
          ]
        : [];
    for (const payment of stampPayments)
      mined.set(payment.txHash, {
        to: payment.destinationAddress,
        value: payment.valueWei,
      });
    receivedPayments.set(byte.repeat(32), stampPayments);
    mockCheckMessagePayment.mockImplementation(async (digest: string) => ({
      status: "received",
      receivedWei: 0n,
      statedWei: 0n,
      payments: (receivedPayments.get(digest) ?? []).map((payment) => ({
        address: payment.destinationAddress,
        origin: "stamp",
        status: "received",
        payloadDigest: digest,
        amountWei: payment.valueWei,
        receivedAmountWei: payment.valueWei,
        claimedAmountWei: payment.valueWei,
        spendable: true,
      })),
    }));
    return {
      senderAddress: { raw: playerAddress },
      senderPublicKey: getBytes(player.signingKey.compressedPublicKey),
      recipientPublicKey: getBytes("0x" + mockLocalSubject),
      recipientAddress: { raw: mockLocalAddress },
      messageId: `${byte.repeat(4)}-0202-0202-0202-020202020202`,
      conversationId,
      items,
      payloadDigest: byte.repeat(32),
      stampValueWei,
      stampPayments,
      receivedTime: 1_700_000_000_000 + sequence,
    };
  };

  /** One poll that returns `message`, then every handler task it started. */
  const deliver = async (message: ReturnType<typeof inbound>) => {
    mockFetchSince.mockResolvedValueOnce([message]);
    await (host as any).pollAllBots();
    const instance = (host as any).instances.get("blackjack");
    while (instance.tasks.size) await Promise.allSettled([...instance.tasks]);
    return message;
  };

  const sentItems = (call: number): HandItem[] =>
    mockSend.mock.calls[call][0].items;

  beforeEach(async () => {
    originalEnvironment = process.env;
    process.env = { ...originalEnvironment };
    for (const key of [
      "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
      "FRANK_DEMO_FAUCET_WALLET_JSON",
      "E2E_DEMO_MAIN_WALLET_JSON",
      "FRANK_BOT_MAX_REPLIES_PER_PEER",
    ])
      delete process.env[key];
    jest.clearAllMocks();
    sequence = 0;
    mockFetchSince.mockResolvedValue([]);
    mockSend.mockImplementation(
      async (params: {
        stampValue?: bigint;
        onAttemptCreated?: (digest: string) => Promise<void>;
      }) => {
        const payloadDigest = (0xd0 + mockSend.mock.calls.length)
          .toString(16)
          .repeat(32);
        await params.onAttemptCreated?.(payloadDigest);
        return {
          payloadDigest,
          stampValueWei: params.stampValue ?? STAMP,
          stampPayments: [],
          preparationTxHashes: [],
        };
      }
    );
    stateDir = mkdtempSync(join(tmpdir(), "blackjack-host-"));
    host = new FrankBotHost({
      relayBaseUrl: "http://127.0.0.1:8098",
      rpcUrl: "http://127.0.0.1:1",
      stateDir,
      watchRegistrations: false,
    });
    // The dealer sizes its table from its balance; no RPC is reachable in this test.
    (host as any).provider.getBalance = jest.fn(
      async () => 500_000_000_000_000_000n
    );
    mined.clear();
    receivedPayments.clear();
    (host as any).provider.getTransactionReceipt = jest.fn(
      async (txHash: string) => (mined.has(txHash) ? { status: 1 } : null)
    );
    (host as any).provider.getTransaction = jest.fn(
      async (txHash: string) => mined.get(txHash) ?? null
    );
    // A fresh profile: the bot's default identity path may already exist on this machine.
    process.env.BLACKJACK_BOT_IDENTITY_JSON = join(stateDir, "identity.json");
    bot = new BlackjackDealerBot();
    onMessage = jest.spyOn(bot, "onMessage");
    await host.register(bot);
  });

  afterEach(async () => {
    await host.stop();
    rmSync(stateDir, { recursive: true, force: true });
    process.env = originalEnvironment;
  });

  /** The player asks for a table, and the dealer's challenge comes back as the hand's start. */
  const openTable = async () => {
    await deliver(inbound([{ type: "text", text: "deal me in" }], STAMP));
    expect(mockSend).toHaveBeenCalledTimes(1);
    const challenge = sentItems(0)[0];
    expect(challenge).toMatchObject({
      type: "blackjack-hand",
      action: "challenge",
      role: "dealer",
    });
    const { state } = foldHand([
      {
        item: challenge,
        from: mockLocalAddress,
        to: playerAddress,
        stampWei: STAMP,
        digest: (await mockSend.mock.results[0].value).payloadDigest,
      },
    ]);
    const bet = buildBet(state, "aa".repeat(32));
    if (!bet) throw new Error("the dealer's challenge did not open a hand");
    return bet;
  };

  it("deals when the bet message's payment is on chain; the host hands the handler the payments", async () => {
    const bet = await openTable();

    await deliver(inbound([bet], BET, BET));

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1][0].stampValueWei).toBe(BET);
    expect(onMessage.mock.calls[1][0].stampPayments).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(sentItems(1)[0]).toMatchObject({
      type: "blackjack-hand",
      action: "deal",
      gameId: bet.gameId,
    });
    expect(mockSend.mock.calls[1][0].recipient.raw.toLowerCase()).toBe(
      playerAddress
    );
    // The dealer's message goes out under a message ID: the wallet's rule against a second
    // attempt is what makes a retried payout pay once.
    expect(mockSend.mock.calls[1][0].messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it.each([
    ["zero", 0n],
    ["absent", undefined],
    ["stated by the wallet but backed by no transfer on chain", BET],
  ])(
    "treats a bet message whose stamp value is %s as no bet: nothing is dealt",
    async (_label, stampValueWei) => {
      const bet = await openTable();

      await deliver(inbound([bet], stampValueWei));

      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // The hand is still open: the same bet, sent with money, is dealt.
      await deliver(inbound([bet], BET, BET));
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(sentItems(1)[0]).toMatchObject({ action: "deal" });
    }
  );
});
