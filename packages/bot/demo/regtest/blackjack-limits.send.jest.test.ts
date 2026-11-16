/** Actual main dispatch; every host/wallet/chain/funding boundary is inert. */
import { FundsInPendingSendError } from "@frank/wallet/evm-transaction-set-types";

const mockSend = jest.fn();
const mockReceive = jest.fn();
const mockSettle = jest.fn();
const mockReconcile = jest.fn(async () => undefined);
const mockClose = jest.fn(async () => undefined);
const mockStop = jest.fn(async () => undefined);
const mockReturn = jest.fn(async () => undefined);
const mockFund = jest.fn(async () => undefined);
const mockPlayer = {
  address: "player",
  mainAccount: "player-main",
  label: "inert",
  handle: {},
  send: mockSend,
  receive: mockReceive,
  close: mockClose,
  chain: {
    directMessages: {
      reconcileAttempts: mockReconcile,
      fetchSince: async () => [],
    },
  },
};
const mockState = { minBetWei: 10n, maxBetWei: 100n };
jest.mock("fs", () => ({
  mkdirSync: jest.fn(),
  readFileSync: () => {
    throw new Error("inert log absent");
  },
}));
jest.mock("../demo-config", () => ({ DEMO_DEFAULT_BURN_ADDRESS: "inert" }));
jest.mock("ethers", () => ({
  Wallet: { createRandom: () => ({ privateKey: "00".repeat(33) }) },
}));
jest.mock("@frank/bot-framework", () => ({
  FrankBotHost: class {
    instances = new Map([
      [
        "blackjack",
        {
          context: { address: "dealer" },
          wallet: { getReceiveAddress: async () => ({ raw: "dealer" }) },
        },
      ],
    ]);
    async register() {}
    async start() {}
    stop = mockStop;
  },
}));
jest.mock("../../src/bots/blackjack-bot", () => ({
  BlackjackDealerBot: class {},
}));
jest.mock("./regtest-stack", () => ({
  startRegtestStack: async () => ({
    stateDir: "/inert-not-created",
    relayUrl: "http://127.0.0.1:1",
    stop: mockStop,
  }),
}));
jest.mock("./monad-wallets", () => ({
  monadOf: () => ({ fund: mockFund, rpcUrl: "http://127.0.0.1:1" }),
  openMonadWallet: async () => mockPlayer,
  returnToFaucet: () => mockReturn(),
  tickUntilSettled: (...args: unknown[]) => mockSettle(...args),
}));
jest.mock("@frank/wallet/message-item-plugins/blackjack/hand", () => ({
  foldHand: () => ({ state: mockState }),
  buildBet: () => ({ type: "blackjack-hand", action: "bet" }),
  checkWager: (_state: unknown, value: bigint) =>
    value < 10n ? "below-min-bet" : value > 100n ? "above-max-bet" : undefined,
}));

import { main } from "./blackjack-limits.livecheck";

const ambiguous = [
  new FundsInPendingSendError(10n, 1n),
  new Error("tied up in a previous send"),
  new Error("No funds cover a stamp"),
];
const afterBet = new Error("inert stop after single successful bet");
let output: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockSettle.mockReset().mockResolvedValue(1);
  mockSend.mockReset().mockResolvedValue("original-digest");
  mockReceive
    .mockReset()
    .mockResolvedValueOnce({
      payloadDigest: "offer",
      items: [
        {
          type: "blackjack-hand",
          action: "challenge",
          minBetWei: "10",
          maxBetWei: "100",
        },
      ],
    })
    .mockRejectedValue(afterBet);
  output = jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  output.mockRestore();
});

it.each(ambiguous)(
  "does not redispatch a paid bet after ambiguous rejection %s",
  async (failure) => {
    let paidCalls = 0;
    const duplicate = new Error("inert stop at first duplicate dispatch");
    mockSend.mockImplementation(
      async (_to: string, _items: unknown, stamp?: bigint) => {
        if (stamp === undefined) return "free-prompt";
        if (++paidCalls === 1) throw failure;
        throw duplicate;
      }
    );
    const finished = main();
    await jest.runAllTimersAsync();
    expect(await finished).toBe(false);
    expect(paidCalls).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(2); // free prompt + original paid bet
    expect(output.mock.calls.some((args) => args.includes(failure))).toBe(true);
    expect(output.mock.calls.some((args) => args.includes(duplicate))).toBe(
      false
    );
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockReturn).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalledTimes(2);
  }
);

it("does not dispatch a bet if prior settlement rejects, retaining the exact failure", async () => {
  const failure = new Error("original settlement remains ambiguous");
  mockSettle.mockRejectedValue(failure);
  expect(await main()).toBe(false);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(output.mock.calls.some((args) => args.includes(failure))).toBe(true);
  expect(mockReturn).not.toHaveBeenCalled();
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockStop).toHaveBeenCalledTimes(2);
});

it("settles first then dispatches the intended bet exactly once", async () => {
  expect(await main()).toBe(false); // explicit inert stop at next dealer receive
  expect(mockSettle).toHaveBeenCalledWith(mockPlayer);
  expect(mockSend.mock.calls).toEqual([
    ["dealer", [{ type: "text", text: "deal me in" }]],
    ["dealer", [{ type: "blackjack-hand", action: "bet" }], 9n],
  ]);
  expect(mockSettle.mock.invocationCallOrder[0]).toBeLessThan(
    mockSend.mock.invocationCallOrder[1]
  );
});
