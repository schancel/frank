import type { BotMessageContext } from "@frank/bot-framework";
import {
  buildBet,
  foldHand,
  payoutWei,
  playerStep,
  type HandEvent,
  type HandItem,
} from "@frank/wallet/message-item-plugins/blackjack/hand";
import { BlackjackDealerBot } from "./blackjack-bot";
import { handValue } from "@frank/wallet/message-item-plugins/blackjack/deck";
import { BOT, harness, PLAYER } from "./bot-harness.testutil";
import { Outbox } from "./money";

const BET = 10_000_000_000_000_000n; // 0.01 MON
const SEED = "aa".repeat(32);

/** The player's side of a hand, folded with the same state machine the app uses: what the bot
 * sent (with what each message really carried) and what the player sent. */
function table(h: ReturnType<typeof harness>, bot: BlackjackDealerBot) {
  const mine: HandEvent[] = [];
  let seen = 0;
  const events = (): HandEvent[] => {
    for (; seen < h.sent.length; seen++) {
      const item = h.item("blackjack-hand", h.sent[seen]) as HandItem | undefined;
      if (item)
        mine.push({
          item,
          from: BOT,
          to: PLAYER,
          stampWei: h.sent[seen].valueWei,
          digest: h.sent[seen].digest,
        });
    }
    return mine;
  };
  const state = () => foldHand(events()).state;
  const send = async (item: HandItem, paidWei = 0n, reported?: bigint) => {
    const message: BotMessageContext = h.message(
      [item as any],
      paidWei > 0n ? [h.pay(paidWei)] : []
    );
    events();
    mine.push({
      item,
      from: PLAYER,
      to: BOT,
      stampWei: paidWei,
      digest: message.payloadDigest,
    });
    await bot.onMessage(
      reported === undefined ? message : { ...message, stampValueWei: reported },
      h.ctx
    );
  };
  return {
    state,
    send,
    open: () => bot.onMessage(h.message([{ type: "text", text: "deal me in" }]), h.ctx),
    bet: (paidWei: bigint, reported?: bigint) =>
      send(buildBet(state(), SEED)!, paidWei, reported),
    stand: () => send(playerStep(state(), "stand", SEED)!),
  };
}

describe("BlackjackDealerBot", () => {
  test("offers a hand with its commitment, and nothing of its seed, to any message", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    const challenge = h.item("blackjack-hand") as HandItem;
    expect(challenge).toMatchObject({ action: "challenge", role: "dealer" });
    expect(t.state()?.phase).toBe("open");
    const seed = h.data.get(`seed:${challenge.gameId}`)!;
    expect(JSON.stringify(h.sent.map((m) => m.items))).not.toContain(seed);
  });

  test("a full hand: the bet is what was paid, every card follows from the opened links, and the payout is paid once", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    await t.bet(BET);
    expect(t.state()?.phase).toBe("player_turn");
    expect(t.state()?.wagerWei).toBe(BET);
    await t.stand();
    // The player's own fold of the messages (what the app does) resolves the hand: the dealer's
    // links opened the chain it committed to and the outcome follows from the cards.
    const end = t.state()!;
    expect(end.phase).toBe("resolved");
    const owed = payoutWei(end.outcome!, BET, false);
    expect(h.paidOut()).toBe(owed);
    expect(h.sent.filter((m) => m.valueWei > 0n)).toHaveLength(owed > 0n ? 1 : 0);
    // Both sides hold the same record.
    const game = (h.item("blackjack-hand") as HandItem).gameId;
    expect(JSON.parse(h.data.get(`events:${game}`)!)).toHaveLength(5);
  });

  test("no payment, no hand: a bet message that paid nothing is not dealt", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    await t.bet(0n);
    expect(h.sent.some((m) => (h.item("blackjack-hand", m) as HandItem)?.action === "deal")).toBe(false);
    expect(h.paidOut()).toBe(0n);
  });

  test("a value the wallet reported but the chain does not show is not a bet", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    await t.bet(0n, BET);
    expect(h.sent.some((m) => (h.item("blackjack-hand", m) as HandItem)?.action === "deal")).toBe(false);
    expect(h.paidOut()).toBe(0n);
  });

  test("a bet over the table's maximum is returned in full, not dealt", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot({ maxWagerWei: BET });
    const t = table(h, bot);
    await t.open();
    await t.bet(BET * 2n);
    const refund = h.sent[h.sent.length - 1];
    expect((h.item("blackjack-hand", refund) as HandItem).action).toBe("refund");
    expect(refund.valueWei).toBe(BET * 2n);
    expect(h.paidOut()).toBe(BET * 2n);
  });

  test("money sent with a message of no hand at this table is returned", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    await bot.onMessage(
      h.message(
        [
          {
            type: "blackjack-hand",
            gameId: "00".repeat(16),
            action: "bet",
            seq: 1,
            prev: "11".repeat(32),
            commitment: "22".repeat(32),
          } as any,
        ],
        [h.pay(BET)]
      ),
      h.ctx
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(BET);
  });

  test("the same message delivered twice counts once", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    const bet = buildBet(t.state(), SEED)!;
    const message = h.message([bet as any], [h.pay(BET)]);
    await bot.onMessage(message, h.ctx);
    const after = h.sent.length;
    await bot.onMessage(message, h.ctx);
    expect(h.sent).toHaveLength(after);
  });

  test("a payout that cannot be sent is kept, the hand waits, and it is paid once later", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    await t.bet(BET);
    const before = h.sent.length;
    h.failSends(new Error("Insufficient main account balance"));
    await t.stand();
    expect(h.sent).toHaveLength(before);
    for (const schedule of bot.schedules) await schedule.handler(h.ctx);
    expect(h.sent).toHaveLength(before);

    h.failSends();
    // A new process: what is owed is sent by the schedules every bot registers.
    const restarted = new BlackjackDealerBot();
    for (let i = 0; i < 3; i++)
      for (const schedule of restarted.schedules) await schedule.handler(h.ctx);
    const end = t.state()!;
    expect(end.phase).toBe("resolved");
    expect(h.paidOut()).toBe(payoutWei(end.outcome!, BET, false));
    expect(h.sent).toHaveLength(before + 1);
  });

  test("a restart after the wallet took the payout and before the bot recorded it pays once", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    await t.bet(BET);
    const beforeStand = new Map(h.data);
    const stand = playerStep(t.state(), "stand", SEED)!;
    const message = h.message([stand as any]);
    await bot.onMessage(message, h.ctx);
    const paid = h.paidOut();
    const count = h.sent.length;
    // Back to the bot's state before the stand; the wallet still holds the attempt it made.
    for (const key of [...h.data.keys()]) h.data.delete(key);
    for (const [key, value] of beforeStand) h.data.set(key, value);
    const restarted = new BlackjackDealerBot();
    await restarted.onMessage(message, h.ctx);
    for (const schedule of restarted.schedules) await schedule.handler(h.ctx);
    expect(h.paidOut()).toBe(paid);
    expect(h.sent).toHaveLength(count);
  });

  test("the profile makes no fairness claim beyond what the app checks", () => {
    expect(new BlackjackDealerBot().getProfile().bio).not.toMatch(/provably/i);
  });

  test("a bet not mined in time is not played, and is refunded when it lands later", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    const bet = buildBet(t.state(), SEED)!;
    const late = h.pay(BET, { mined: false });
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    const handling = bot.onMessage(h.message([bet as any], [late]), h.ctx);
    await jest.advanceTimersByTimeAsync(61_000);
    await handling;
    jest.useRealTimers();
    const before = h.sent.length;
    expect(h.sent.some((m) => (h.item("blackjack-hand", m) as HandItem)?.action === "deal")).toBe(false);
    h.chain.get(late.txHash)!.mined = true;
    for (const schedule of bot.schedules) await schedule.handler(h.ctx);
    expect(h.sent).toHaveLength(before + 1);
    expect(h.sent[before].valueWei).toBe(BET);
  });

  test("a reveal the relay ended is not folded into the hand or counted as paid", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    await t.bet(BET);
    const game = (h.item("blackjack-hand") as HandItem).gameId;
    const recorded = JSON.parse(h.data.get(`events:${game}`)!).length;
    h.wallet("dead");
    await t.stand();
    h.wallet("deliver");
    for (let i = 0; i < 2; i++)
      for (const schedule of bot.schedules) await schedule.handler(h.ctx);
    // The stand is recorded; the dealer's reveal, which never arrived, is not.
    expect(JSON.parse(h.data.get(`events:${game}`)!)).toHaveLength(recorded + 1);
    expect(h.paidOut()).toBe(0n);
    expect(errors.mock.calls.flat().join(" ")).toContain("FAILED");
    errors.mockRestore();
  });

  /** Plays hands until `enough` says the wanted cases were seen; every hand must end resolved
   * with exactly what its outcome owes, with no message from the player after its last move. */
  async function hands(
    play: (t: ReturnType<typeof table>) => Promise<{ staked: bigint; doubled: boolean }>,
    enough: (seen: Set<string>) => boolean
  ) {
    const seen = new Set<string>();
    for (let i = 0; i < 60 && !enough(seen); i++) {
      const h = harness();
      const bot = new BlackjackDealerBot();
      const t = table(h, bot);
      await t.open();
      const { doubled } = await play(t);
      const end = t.state()!;
      expect(end.phase).toBe("resolved");
      expect(h.paidOut()).toBe(payoutWei(end.outcome!, BET, doubled));
      expect(h.sent.some((m) => m.hostStamp)).toBe(false);
      seen.add(`${end.outcome}${handValue(end.playerCards).bust ? ":bust" : ""}`);
    }
    return seen;
  }

  test("a hit that busts is followed by the reveal without another message from the player", async () => {
    const seen = await hands(
      async (t) => {
        await t.bet(BET);
        while (t.state()?.phase === "player_turn")
          await t.send(playerStep(t.state(), "hit", SEED)!);
        return { staked: BET, doubled: false };
      },
      (s) => [...s].some((o) => o.endsWith(":bust"))
    );
    expect([...seen].some((o) => o.endsWith(":bust"))).toBe(true);
  });

  test("a double, won or lost, is followed by the reveal and pays what the doubled stake owes", async () => {
    const doubles = { won: false, lost: false };
    let last: ReturnType<typeof table> | undefined;
    const note = () => {
      const end = last?.state();
      if (end?.doubled && end.outcome === "player_win") doubles.won = true;
      if (end?.doubled && end.outcome === "dealer_win") doubles.lost = true;
    };
    const seen = await hands(
      async (t) => {
        note();
        last = t;
        await t.bet(BET);
        if (t.state()?.phase !== "player_turn") return { staked: BET, doubled: false };
        const double = playerStep(t.state(), "double", SEED);
        if (!double) {
          await t.stand();
          return { staked: BET, doubled: false };
        }
        await t.send(double, BET);
        return { staked: BET * 2n, doubled: true };
      },
      (s) => doubles.won && doubles.lost
    );
    void seen;
    expect(doubles).toEqual({ won: true, lost: true });
  });

  test("only the hand's player is dealt to or paid: another account's messages for the hand are refused, and the payout is owed once", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    await t.bet(BET);
    const MALLORY = "0x" + "e7".repeat(20);
    const stand = playerStep(t.state(), "stand", SEED)!;
    // Before, during and after the reveal: free messages from a second account.
    await bot.onMessage(h.message([stand as any], [], MALLORY), h.ctx);
    await t.stand();
    for (let i = 0; i < 3; i++)
      await bot.onMessage(h.message([stand as any], [], MALLORY), h.ctx);
    for (const schedule of bot.schedules) await schedule.handler(h.ctx);
    const end = t.state()!;
    expect(end.phase).toBe("resolved");
    expect(h.paidOut()).toBe(payoutWei(end.outcome!, BET, false));
    expect(h.sent.filter((m) => m.to === MALLORY).every((m) => m.valueWei === 0n)).toBe(true);
    expect(
      h.sent.filter((m) => m.to === MALLORY).some((m) => h.item("blackjack-hand", m))
    ).toBe(false);
    // Money a stranger sends with such a message comes back to the stranger, once.
    h.sent.length = 0;
    await bot.onMessage(h.message([stand as any], [h.pay(BET)], MALLORY), h.ctx);
    expect(h.sent.map((m) => [m.to, m.valueWei])).toEqual([[MALLORY, BET]]);
  });

  test("the dealer pays nothing to talk: a free message, a challenge and a lost hand cost it no stamp", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    await bot.onNewUser({ address: PLAYER, registeredAtMs: 1 }, h.ctx);
    const t = table(h, bot);
    await t.open();
    await t.bet(BET);
    await t.stand();
    const end = t.state()!;
    expect(h.sent.some((m) => m.hostStamp)).toBe(false);
    // Everything but the payout carries nothing.
    expect(h.sent.filter((m) => m.valueWei > 0n).length).toBe(
      payoutWei(end.outcome!, BET, false) > 0n ? 1 : 0
    );
  });

  test("a crash after a bet is recorded and before the deal is written: the hand goes on after restart", async () => {
    const h = harness();
    const bot = new BlackjackDealerBot();
    const t = table(h, bot);
    await t.open();
    (bot as any).advance = async () => {
      throw new Error("killed");
    };
    await expect(t.bet(BET)).rejects.toThrow("killed");
    expect(h.sent.some((m) => (h.item("blackjack-hand", m) as HandItem)?.action === "deal")).toBe(false);
    const restarted = new BlackjackDealerBot();
    for (const schedule of restarted.schedules) await schedule.handler(h.ctx);
    expect(t.state()?.phase).toBe("player_turn");
    // Not also refunded as an unhandled message.
    expect(h.paidOut()).toBe(0n);
  });

  test("the bank offered is net of what the dealer already owes", async () => {
    const h = harness();
    (h.ctx as any).getBalance = async () => 100_000_000_000_000_000n; // 0.1 MON
    const bot = new BlackjackDealerBot({ minWagerWei: 1n, maxWagerWei: 10n ** 18n });
    const offered = async () => {
      await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
      return BigInt((h.item("blackjack-hand") as any).maxBetWei);
    };
    const free = await offered();
    // A debt that cannot go out yet (it waits for a transfer that is not mined).
    await new Outbox("blackjack").owe(h.ctx, "debt", {
      to: PLAYER,
      items: [],
      valueWei: 60_000_000_000_000_000n,
      awaits: [
        {
          txHash: "0x" + "ee".repeat(32),
          destinationAddress: "0x" + "5e".repeat(20),
          valueWei: "1",
        },
      ],
      awaitsFor: "x",
    });
    const owing = await offered();
    expect(free).toBe(20_000_000_000_000_000n); // (0.1 - 0.02 reserve) / 4
    expect(owing).toBe(5_000_000_000_000_000n); // (0.1 - 0.06 owed - 0.02) / 4
  });
});
