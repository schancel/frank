import { fixedStampDefault } from '../../../wallet/oracle/stamp-policy.testutil'
/**
 * The blackjack dealer behind the real FrankBotHost dispatch path: the bet is the stamp value the
 * wallet reported for the received message, handed to the handler by the host. Only the chain,
 * the directory and the relay profile call are replaced; nothing here builds a message context
 * by hand.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet, getBytes, parseEther } from "ethers";
import {
  EvmCoinList,
  type StoredEvmListCoin,
} from "@frank/wallet/evm-coin-list";
import { MemoryRecordStore } from "@frank/wallet/storage/evm-coin-store";
import { EvmNativeOperationJournal } from "@frank/wallet/storage/evm-native-operation-journal";
import { EvmTransactionSetPreparer } from "@frank/wallet/evm-transaction-set";
import type { MonadRootBundle } from "@frank/wallet/evm-wallet-material";
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
const mockReconcileAttempts = jest.fn();
const mockCheckMessagePayment = jest.fn();
/** The dealer wallet's display balance (`getBalance`): what the app shows. */
const mockWalletBalance = jest.fn();
/** What the dealer wallet's sends can draw on now (`getSpendableBalance`). */
const mockSpendable = jest.fn();
let mockLocalAddress = "";
let mockLocalSubject = "";
jest.mock("@frank/wallet/chain/evm-chain", () => {
  const actual = jest.requireActual("@frank/wallet/chain/evm-chain");
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
      directMessages: {
        fetchSince: mockFetchSince,
        send: mockSend,
        reconcileAttempts: mockReconcileAttempts,
      },
      topics: { post: jest.fn() },
      createWallet: jest.fn(async (roots: MonadRootBundle) => {
        const { MonadIdentity } = jest.requireActual<
          typeof import("@frank/wallet/evm-identity")
        >("@frank/wallet/evm-identity");
        const identity = MonadIdentity.fromDomainRoot(roots.authentication);
        mockLocalAddress = identity.address.raw;
        mockLocalSubject = identity.compressedPubKey.toString("hex");
        return {
          identity,
          checkMessagePayment: mockCheckMessagePayment,
          getBalance: mockWalletBalance,
          getSpendableBalance: mockSpendable,
          getReceiveAddress: jest.fn(async () => ({ raw: mockLocalAddress })),
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
    mockReconcileAttempts.mockResolvedValue({});
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
    // The dealer sizes its table from what its wallet can spend now; no RPC is reachable in
    // this test.
    mockWalletBalance.mockResolvedValue(500_000_000_000_000_000n);
    mockSpendable.mockResolvedValue(500_000_000_000_000_000n);
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

    expect(mockReconcileAttempts).toHaveBeenCalledWith({
      wallet: expect.objectContaining({ identity: expect.anything() }),
      payloadDigests: [],
    });
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

  /** The dealer wallet's coins, in a real coin list with its real transaction-set preparer:
   * what `getSpendableBalance` reads in the wallet (`spendableNowWei`), at head 100. */
  const coinListWallet = async () => {
    const coins = await EvmCoinList.open(
      new MemoryRecordStore<StoredEvmListCoin>()
    );
    const journal = new EvmNativeOperationJournal({
      testOnlyEphemeral: true,
      binding: {
        chainIdentifier: "monad-testnet",
        nativeChainId: "10143",
        publicTuple: "blackjack-dealer",
      },
    });
    await journal.Open();
    const key = (index: number) =>
      new Wallet("0x" + (7_000 + index).toString(16).padStart(64, "0"));
    const preparer = new EvmTransactionSetPreparer({
      coins,
      journal,
      policy: () => ({
        sourceOrder: ["stealth", "stamp", "change", "deterministic", "root", "identity"],
        gasPriceWei: 1_000n,
        paymentGasLimit: () => 21_000n,
        changeGasLimit: 21_000n,
        paymentFeeIsExact: true,
        dustWei: 1_000n,
        radix: 2,
        jitterBps: 0,
        maxChangeOutputs: 1,
        head: 100,
      }),
      random: () => 0.5,
      deriveChange: (index: number) => ({
        account: key(500 + index).address.toLowerCase(),
        privateKey: key(500 + index).privateKey,
        changeIndex: index,
      }),
    });
    let next = 1;
    const put = async (valueWei: bigint, extra: Partial<StoredEvmListCoin> = {}) => {
      const signer = key(next++);
      await coins.put({
        account: signer.address,
        privateKey: signer.privateKey,
        nonce: 0,
        valueWei,
        origin: "change",
        ...extra,
      });
      return signer.address.toLowerCase();
    };
    mockSpendable.mockImplementation(async () => preparer.spendableNowWei());
    return { preparer, put, close: () => journal.Close() };
  };

  // Solonet, 2026-10-27: the dealer's first payout spent from its identity account and
  // maintenance moved the rest of that account into its other coins. The identity account read
  // 0 while the wallet held 2 MON, and the next "deal me in" was told the dealer could not cover
  // a hand.
  it("offers a hand when its identity account is empty and its other coins cover it", async () => {
    (host as any).provider.getBalance = jest.fn(async () => 0n);
    const dealer = await coinListWallet();
    await dealer.put(parseEther("2"));

    const bet = await openTable();
    await deliver(inbound([bet], BET, BET));

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(sentItems(1)[0]).toMatchObject({
      type: "blackjack-hand",
      action: "deal",
      gameId: bet.gameId,
    });
    await dealer.close();
  });

  // Owner ruling on #1947: "No point in betting when you won't be paid out." The display balance
  // counts money an operation holds and money still settling; neither can pay a payout now.
  it("refuses a hand it could only cover with coins an operation holds or that are still settling", async () => {
    (host as any).provider.getBalance = jest.fn(async () => parseEther("2"));
    mockWalletBalance.mockResolvedValue(parseEther("2.5"));
    const dealer = await coinListWallet();
    const held = await dealer.put(parseEther("1"));
    await dealer.put(parseEther("1.5"), {
      spendableFromBlock: 10_000,
      fundsVisibleFromBlock: 10_000,
    });
    await dealer.preparer.constructTransactionSet({
      operationId: "a-payment-in-flight",
      amountWei: parseEther("0.5"),
      kdf: () => playerAddress,
      sourceAccounts: [held],
    });

    await deliver(inbound([{ type: "text", text: "deal me in" }], STAMP));

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sentItems(0)).toEqual([
      {
        type: "text",
        text: "The dealer cannot cover a hand right now. Try again later.",
      },
    ]);
    await dealer.close();
  });

  it("says it cannot check what it covers, and offers nothing, when what its wallet can spend cannot be read", async () => {
    mockSpendable.mockRejectedValue(new Error("node unreachable"));

    await deliver(inbound([{ type: "text", text: "deal me in" }], STAMP));

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sentItems(0)).toEqual([
      {
        type: "text",
        text: "The dealer cannot check what it can cover right now. Try again in a moment.",
      },
    ]);
  });
});
