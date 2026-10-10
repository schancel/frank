import type { SatoshiDiceItem } from "@frank/cashweb/types/messages";
import {
  diceCommitment,
  dicePayoutWei,
  diceRoll,
  verifyDiceResult,
} from "@frank/wallet/message-item-plugins/dice/fair";
import { harness, PLAYER } from "./bot-harness.testutil";
import { SatoshiDiceBot } from "./satoshi-dice-bot";

const STAKE = 10_000_000_000_000_000n; // 0.01 MON
const TARGET = 32768;

/** Asks for a table and returns the roll on offer, with a seed that makes the roll win or lose. */
async function table(
  h: ReturnType<typeof harness>,
  bot: SatoshiDiceBot,
  want: "win" | "lose" = "win"
) {
  await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
  const offer = h.item("dice");
  const { secret } = JSON.parse(h.data.get(`roll:${offer.rollId}`)!);
  let n = 0;
  let clientSeed = "";
  do clientSeed = (n++).toString(16).padStart(32, "0");
  while ((diceRoll(secret, clientSeed) < TARGET) !== (want === "win"));
  const bet: SatoshiDiceItem = {
    type: "dice",
    action: "roll",
    rollId: offer.rollId,
    commitment: offer.commitment,
    clientSeed,
    target: TARGET,
    wagerWei: STAKE.toString(),
  };
  h.sent.length = 0;
  return { offer, bet, secret };
}

describe("SatoshiDiceBot", () => {
  test("publishes a commitment, and nothing else about the secret, before any bet", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { offer, secret } = await table(h, bot);
    expect(offer.action).toBe("table");
    expect(offer.commitment).toBe(diceCommitment(secret));
    expect(JSON.stringify(offer)).not.toContain(secret);
  });

  test("an amount typed in chat is not a bet: nothing is rolled or paid", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    await bot.onMessage(
      h.message([{ type: "text", text: "/roll 5 60000" }]),
      h.ctx
    );
    expect(h.item("dice").action).toBe("table");
    expect(h.paidOut()).toBe(0n);
  });

  test("no payment, no payout: a bet that states a stake but paid nothing is refused", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot);
    await bot.onMessage(h.message([bet]), h.ctx);
    expect(h.paidOut()).toBe(0n);
    expect(h.sent.flatMap((m) => m.items).some((i) => i.type === "dice" && i.action === "result")).toBe(false);
    expect(h.sent[0].items.find((i) => i.type === "text")).toMatchObject({
      text: expect.stringContaining("No roll was made"),
    });
  });

  test("a stake the wallet reported but the chain does not show is not a stake", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot);
    const reverted = h.pay(STAKE, { status: 0 });
    await bot.onMessage(h.message([bet], [reverted]), h.ctx);
    expect(h.paidOut()).toBe(0n);
  });

  test("an under-payment is refused and what was paid is returned", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot);
    await bot.onMessage(h.message([bet], [h.pay(STAKE / 2n)]), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(STAKE / 2n);
    expect(h.sent[0].to).toBe(PLAYER);
  });

  test("a paid winning bet pays the payout once, and the result verifies", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "win");
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.sent).toHaveLength(1);
    const result = h.item("dice");
    expect(result.isWin).toBe(true);
    expect(h.sent[0].valueWei).toBe(dicePayoutWei(STAKE, TARGET));
    expect(verifyDiceResult(result, bet)).toEqual({ ok: true });
    // The next roll is on offer under a new commitment.
    expect(result.nextCommitment).not.toBe(result.commitment);
  });

  test("a paid losing bet pays nothing, and the result verifies", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "lose");
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.item("dice").isWin).toBe(false);
    expect(h.paidOut()).toBe(0n);
    expect(verifyDiceResult(h.item("dice"), bet)).toEqual({ ok: true });
  });

  test("one commitment, one roll: a second bet on it is refused and refunded", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "win");
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    h.sent.length = 0;
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(STAKE); // the stake back, no second payout
    expect(h.sent[0].items.some((i) => i.type === "dice" && i.action === "result")).toBe(false);
  });

  test("the same payment cannot fund two bets", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const payment = h.pay(STAKE);
    const first = await table(h, bot, "lose");
    await bot.onMessage(h.message([first.bet], [payment]), h.ctx);
    const second = await table(h, bot, "win");
    await bot.onMessage(h.message([second.bet], [payment]), h.ctx);
    expect(h.paidOut()).toBe(0n);
  });

  test("a bet with no random value of the player's, or on another player's roll, is refused", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot);
    await bot.onMessage(
      h.message([{ ...bet, clientSeed: undefined }], [h.pay(STAKE)]),
      h.ctx
    );
    expect(h.sent[0].valueWei).toBe(STAKE);
    h.sent.length = 0;
    const other = "0x" + "c3".repeat(20);
    await bot.onMessage(h.message([bet], [h.pay(STAKE)], other), h.ctx);
    expect(h.sent[0].to).toBe(other);
    expect(h.sent[0].valueWei).toBe(STAKE);
  });

  test("a stake that could win more than the table limit is refused and refunded", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot({ maxPayoutWei: STAKE });
    const { bet } = await table(h, bot);
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].valueWei).toBe(STAKE);
    expect(h.sent[0].items.some((i) => i.type === "dice" && i.action === "result")).toBe(false);
  });

  test("a payout that cannot be sent is kept and paid later, once", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "win");
    h.failSends(new Error("Insufficient main account balance"));
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.paidOut()).toBe(0n);
    h.failSends();
    // A new process: the schedule every bot registers sends what is owed.
    const restarted = new SatoshiDiceBot();
    await restarted.schedules[0].handler(h.ctx);
    await restarted.schedules[0].handler(h.ctx);
    expect(h.paidOut()).toBe(dicePayoutWei(STAKE, TARGET));
    expect(h.sent).toHaveLength(1);
  });

  test("the profile and help make no fairness claim beyond what the app checks", () => {
    expect(new SatoshiDiceBot().getProfile().bio).not.toMatch(/provably/i);
  });

  test("a result the relay ended is not counted as sent, and a pending one is sent when it arrives", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "win");
    h.wallet("live");
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    await bot.schedules[0].handler(h.ctx);
    expect(h.sent).toHaveLength(0);
    h.deliverLive();
    await bot.schedules[0].handler(h.ctx);
    expect(h.paidOut()).toBe(dicePayoutWei(STAKE, TARGET));

    h.wallet("deliver");
    const second = await table(h, bot, "win");
    h.wallet("dead");
    await bot.onMessage(h.message([second.bet], [h.pay(STAKE)]), h.ctx);
    h.wallet("deliver");
    await bot.schedules[0].handler(h.ctx);
    await bot.schedules[0].handler(h.ctx);
    expect(h.sent).toHaveLength(0);
    expect(errors.mock.calls.flat().join(" ")).toContain("FAILED");
    errors.mockRestore();
  });

  test("a bet that paid more than its stake gets the excess back with the result", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "lose");
    await bot.onMessage(h.message([bet], [h.pay(STAKE + 5n)]), h.ctx);
    expect(h.item("dice").isWin).toBe(false);
    expect(h.sent[0].valueWei).toBe(5n);
  });

  test("a bet the bank cannot cover is refused and refunded before any roll", async () => {
    const h = harness();
    (h.ctx as any).getBalance = async () => dicePayoutWei(STAKE, TARGET);
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "win");
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].valueWei).toBe(STAKE);
    expect(h.sent[0].items.some((i) => i.type === "dice" && i.action === "result")).toBe(false);
  });

  test("an error or a crash after the stake arrived and before a result is written refunds the stake once", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const { bet } = await table(h, bot, "win");
    const get = h.ctx.state.get;
    (h.ctx.state as any).get = async (key: string) => {
      if (key.startsWith("roll:")) throw new Error("disk");
      return get(key);
    };
    await expect(
      bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx)
    ).rejects.toThrow("disk");
    (h.ctx.state as any).get = get;
    const restarted = new SatoshiDiceBot();
    await restarted.schedules[0].handler(h.ctx);
    await restarted.schedules[0].handler(h.ctx);
    expect(h.sent.map((m) => m.valueWei)).toEqual([STAKE]);
    expect(h.sent[0].items.some((i) => i.type === "dice")).toBe(false);
  });

  test("the bank does not promise what it already owes: a bet it could cover alone is refused while a payout is outstanding", async () => {
    const h = harness();
    const payout = dicePayoutWei(STAKE, TARGET);
    (h.ctx as any).getBalance = async () => payout + 20_000_000_000_000_000n + 1n;
    const bot = new SatoshiDiceBot();
    const first = await table(h, bot, "win");
    // The first win cannot go out yet: it stays owed.
    h.failSends(new Error("down"));
    await bot.onMessage(h.message([first.bet], [h.pay(STAKE)]), h.ctx);
    h.failSends();
    (bot as any).outbox.settle = async () => undefined;
    const second = await table(h, bot, "win");
    await bot.onMessage(h.message([second.bet], [h.pay(STAKE)]), h.ctx);
    const rolls = JSON.parse(h.data.get("outbox:index")!).owed as string[];
    expect(rolls.filter((id) => id.startsWith("roll:"))).toHaveLength(1);
    expect(rolls.filter((id) => id.startsWith("refund:"))).toHaveLength(1);
  });

  // The owner's rule: a table's limit is what its bank has available, not a fixed figure.
  test("the table states what the bank can pay right now, less what it owes and its fee reserve, and a bet is judged against the bank as it is when the bet arrives", async () => {
    const h = harness();
    const RESERVE = 20_000_000_000_000_000n;
    let balance = 3n * 10n ** 18n + RESERVE;
    (h.ctx as any).getBalance = async () => balance;
    const bot = new SatoshiDiceBot();
    const said = async () => {
      h.sent.length = 0;
      await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
      return (h.sent[0].items.find((i) => i.type === "text") as { text: string }).text;
    };
    expect(await said()).toContain("The most one roll pays is 3.0 MON.");
    // The bank shrinks: the next statement of the table says so.
    balance = 10n ** 18n / 2n + RESERVE;
    expect(await said()).toContain("The most one roll pays is 0.5 MON.");
    // A bet whose win the bank covered when the table was stated, and no longer does when
    // the bet arrives, is refused and refunded.
    const { bet } = await table(h, bot, "win");
    balance = dicePayoutWei(STAKE, TARGET) + RESERVE - 1n;
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].valueWei).toBe(STAKE);
    expect(h.sent[0].items.some((i) => i.type === "dice" && i.action === "result")).toBe(false);
    // One wei more in the bank and the same bet is taken.
    const again = await table(h, bot, "win");
    balance = dicePayoutWei(STAKE, TARGET) + RESERVE;
    await bot.onMessage(h.message([again.bet], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].items.some((i) => i.type === "dice" && i.action === "result")).toBe(true);
  });
});
