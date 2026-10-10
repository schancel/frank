import type { RpsItem } from "@frank/cashweb/types/messages";
import {
  evaluateRps,
  verifyRpsResult,
  type RpsMove,
} from "@frank/wallet/message-item-plugins/rps/fair";
import { harness, PLAYER } from "./bot-harness.testutil";
import { RpsBot } from "./rps-bot";

const STAKE = 10_000_000_000_000_000n; // 0.01 MON

/** Starts a match and returns the player's move that gives `want`. */
async function match(
  h: ReturnType<typeof harness>,
  bot: RpsBot,
  want: "win" | "lose" | "tie",
  wagerWei = STAKE
) {
  await bot.onMessage(h.message([{ type: "text", text: "/rps 5" }]), h.ctx);
  const start = h.item("rps");
  const { move } = JSON.parse(h.data.get(`match:${start.matchId}`)!);
  const playerMove = (["rock", "paper", "scissors"] as RpsMove[]).find(
    (candidate) => evaluateRps(candidate, move) === want
  )!;
  const mine: RpsItem = {
    type: "rps",
    action: "move",
    matchId: start.matchId,
    commitHash: start.commitHash,
    playerMove,
    wagerWei: wagerWei.toString(),
  };
  h.sent.length = 0;
  return { start, mine, botMove: move as RpsMove };
}

describe("RpsBot", () => {
  test("commits to its move before the player chooses, without showing it", async () => {
    const h = harness();
    const { start } = await match(h, new RpsBot(), "win");
    expect(start.action).toBe("start");
    expect(start.commitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(start.botMove).toBeUndefined();
    expect(start.secretSalt).toBeUndefined();
    // A wager typed with the command is not part of the match.
    expect(start.wagerWei).toBeUndefined();
  });

  test("no payment, no payout: a winning move that states a stake but paid nothing is refused", async () => {
    const h = harness();
    const bot = new RpsBot();
    const { mine } = await match(h, bot, "win");
    await bot.onMessage(h.message([mine]), h.ctx);
    expect(h.paidOut()).toBe(0n);
    expect(h.sent.flatMap((m) => m.items).some((i) => i.type === "rps" && i.action === "resolve")).toBe(false);
  });

  test("an under-payment is refused and what was paid is returned", async () => {
    const h = harness();
    const bot = new RpsBot();
    const { mine } = await match(h, bot, "win");
    await bot.onMessage(h.message([mine], [h.pay(STAKE / 4n)]), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(STAKE / 4n);
  });

  test.each([
    ["win", STAKE * 2n],
    ["tie", STAKE],
    ["lose", 0n],
  ] as const)("a paid %s pays %s, and the reveal verifies", async (want, pays) => {
    const h = harness();
    const bot = new RpsBot();
    const { mine } = await match(h, bot, want);
    await bot.onMessage(h.message([mine], [h.pay(STAKE)]), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(PLAYER);
    expect(h.sent[0].valueWei).toBe(pays);
    const result = h.item("rps");
    expect(result.outcome).toBe(want);
    expect(verifyRpsResult(result, mine)).toEqual({ ok: true });
  });

  test("one commitment, one match: a second move on it is refused and refunded", async () => {
    const h = harness();
    const bot = new RpsBot();
    const { mine } = await match(h, bot, "win");
    await bot.onMessage(h.message([mine], [h.pay(STAKE)]), h.ctx);
    h.sent.length = 0;
    await bot.onMessage(h.message([mine], [h.pay(STAKE)]), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(STAKE);
  });

  test("a typed move plays the open match for nothing, whatever the message paid", async () => {
    const h = harness();
    const bot = new RpsBot();
    const { botMove } = await match(h, bot, "win");
    const winning = (["rock", "paper", "scissors"] as RpsMove[]).find(
      (candidate) => evaluateRps(candidate, botMove) === "win"
    )!;
    await bot.onMessage(
      h.message([{ type: "text", text: `/${winning}` }], [h.pay(STAKE)]),
      h.ctx
    );
    expect(h.item("rps").outcome).toBe("win");
    expect(h.paidOut()).toBe(0n);
  });

  test("a stake over the table limit is refused and refunded", async () => {
    const h = harness();
    const bot = new RpsBot({ maxWagerWei: STAKE - 1n });
    const { mine } = await match(h, bot, "win");
    await bot.onMessage(h.message([mine], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].valueWei).toBe(STAKE);
    expect(h.sent[0].items.some((i) => i.type === "rps" && i.action === "resolve")).toBe(false);
  });

  test("the bot's move is not predictable from one match to the next", async () => {
    const h = harness();
    const bot = new RpsBot();
    const moves = new Set<string>();
    for (let i = 0; i < 60; i++) moves.add((await match(h, bot, "win")).botMove);
    expect(moves.size).toBe(3);
  });

  test("the profile makes no fairness claim beyond what the app checks", () => {
    expect(new RpsBot().getProfile().bio).not.toMatch(/provably/i);
  });

  test("a result the relay ended is not counted as sent; a pending one is sent when it arrives", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness();
    const bot = new RpsBot();
    const first = await match(h, bot, "win");
    h.wallet("live");
    await bot.onMessage(h.message([first.mine], [h.pay(STAKE)]), h.ctx);
    await bot.schedules[0].handler(h.ctx);
    expect(h.sent).toHaveLength(0);
    h.deliverLive();
    await bot.schedules[0].handler(h.ctx);
    expect(h.paidOut()).toBe(STAKE * 2n);

    h.wallet("deliver");
    const second = await match(h, bot, "win");
    h.wallet("dead");
    await bot.onMessage(h.message([second.mine], [h.pay(STAKE)]), h.ctx);
    h.wallet("deliver");
    await bot.schedules[0].handler(h.ctx);
    expect(h.sent).toHaveLength(0);
    expect(errors.mock.calls.flat().join(" ")).toContain("FAILED");
    errors.mockRestore();
  });

  test("excess over the stake comes back with the result, and a stake the bank cannot cover is refunded", async () => {
    const h = harness();
    const bot = new RpsBot();
    const lost = await match(h, bot, "lose");
    await bot.onMessage(h.message([lost.mine], [h.pay(STAKE + 3n)]), h.ctx);
    expect(h.sent[0].valueWei).toBe(3n);

    (h.ctx as any).getBalance = async () => STAKE;
    const refused = await match(h, bot, "win");
    await bot.onMessage(h.message([refused.mine], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].valueWei).toBe(STAKE);
    expect(h.sent[0].items.some((i) => i.type === "rps" && i.action === "resolve")).toBe(false);
  });

  test("the table states the largest stake the bank can pay twice over right now, and a stake is judged against the bank as it is when the move arrives", async () => {
    const h = harness();
    const RESERVE = 20_000_000_000_000_000n;
    let balance = 10n ** 18n + RESERVE;
    (h.ctx as any).getBalance = async () => balance;
    const bot = new RpsBot();
    h.sent.length = 0;
    await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
    expect(
      (h.sent[0].items.find((i) => i.type === "text") as { text: string }).text
    ).toContain("up to 0.5 MONT:");
    const refused = await match(h, bot, "win");
    balance = STAKE * 2n + RESERVE - 1n;
    await bot.onMessage(h.message([refused.mine], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].valueWei).toBe(STAKE);
    expect(h.sent[0].items.some((i) => i.type === "rps" && i.action === "resolve")).toBe(false);
    const taken = await match(h, bot, "win");
    balance = STAKE * 2n + RESERVE;
    await bot.onMessage(h.message([taken.mine], [h.pay(STAKE)]), h.ctx);
    expect(h.sent[0].items.some((i) => i.type === "rps" && i.action === "resolve")).toBe(true);
  });
});
