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
import { BOT, harness, PLAYER } from "./bot-harness.testutil";

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
});
