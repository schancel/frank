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
let mockLocalAddress = "";
let mockLocalSubject = "";
jest.mock("@frank/wallet/chain/monad-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/monad-chain");
  return {
    ...actual,
    createEvmChain: jest.fn(() => ({
      chainIdentifier: "monad-testnet",
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

  const inbound = (items: unknown[], stampValueWei: bigint | undefined) => {
    sequence += 1;
    const byte = sequence.toString(16).padStart(2, "0");
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
      stampPayments: [],
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

  it("deals when the bet message carries a stamp value, which the handler receives from the host", async () => {
    const bet = await openTable();

    await deliver(inbound([bet], BET));

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1][0].stampValueWei).toBe(BET);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(sentItems(1)[0]).toMatchObject({
      type: "blackjack-hand",
      action: "deal",
      gameId: bet.gameId,
    });
    expect(mockSend.mock.calls[1][0].recipient.raw.toLowerCase()).toBe(
      playerAddress
    );
  });

  it.each([
    ["zero", 0n],
    ["absent", undefined],
  ])(
    "treats a bet message whose stamp value is %s as no bet: nothing is dealt",
    async (_label, stampValueWei) => {
      const bet = await openTable();

      await deliver(inbound([bet], stampValueWei));

      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(onMessage.mock.calls[1][0].stampValueWei).toBe(0n);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // The hand is still open: the same bet, sent with money, is dealt.
      await deliver(inbound([bet], BET));
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(sentItems(1)[0]).toMatchObject({ action: "deal" });
    }
  );
});
