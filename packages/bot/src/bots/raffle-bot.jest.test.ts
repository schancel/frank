import type { RaffleItem } from "@frank/cashweb/types/messages";
import { verifyRaffleDrawAgainstThread } from "@frank/wallet/message-item-plugins/raffle/draw";
import { harness } from "./bot-harness.testutil";
import { RaffleBot } from "./raffle-bot";

const PRICE = 20_000_000_000_000_000n; // 0.02 MON
const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const ENTER: RaffleItem = { type: "raffle", raffleId: "", action: "enter" };

async function open(h: ReturnType<typeof harness>, bot: RaffleBot) {
  await bot.onMessage(h.message([{ type: "text", text: "hello" }], [], ALICE), h.ctx);
  const announce = h.item("raffle");
  h.sent.length = 0;
  return announce;
}

const enter = (
  h: ReturnType<typeof harness>,
  bot: RaffleBot,
  raffleId: string,
  from: string,
  paid: bigint | null = PRICE
) =>
  bot.onMessage(
    h.message([{ ...ENTER, raffleId }], paid === null ? [] : [h.pay(paid)], from),
    h.ctx
  );

describe("RaffleBot", () => {
  test("announces the round with its seed commitment before any entry", async () => {
    const h = harness();
    const announce = await open(h, new RaffleBot({ maxEntries: 2 }));
    expect(announce).toMatchObject({
      action: "announce",
      entryCount: 0,
      maxEntries: 2,
      entryPriceWei: PRICE.toString(),
    });
    expect(announce.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(announce.serverSeed).toBeUndefined();
  });

  test("no payment, no entry: 'enter' messages that paid nothing never fill a round or move money", async () => {
    const h = harness();
    const bot = new RaffleBot({ maxEntries: 2 });
    const { raffleId } = await open(h, bot);
    await enter(h, bot, raffleId, ALICE, null);
    await enter(h, bot, raffleId, BOB, null);
    await bot.onMessage(h.message([{ type: "text", text: "enter" }], [], BOB), h.ctx);
    expect(h.paidOut()).toBe(0n);
    expect(h.sent.flatMap((m) => m.items).some((i) => i.type === "raffle" && i.action === "draw")).toBe(false);
    expect(JSON.parse(h.data.get("current_round")!).entrants).toEqual([]);
  });

  test("an under-paid entry is refused and what was paid is returned", async () => {
    const h = harness();
    const bot = new RaffleBot({ maxEntries: 2 });
    const { raffleId } = await open(h, bot);
    await enter(h, bot, raffleId, ALICE, PRICE - 1n);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(PRICE - 1n);
    expect(h.item("raffle").action).toBe("error");
  });

  test("a second entry by the same player, and an entry for a past round, are refused and refunded", async () => {
    const h = harness();
    const bot = new RaffleBot({ maxEntries: 3 });
    const { raffleId } = await open(h, bot);
    await enter(h, bot, raffleId, ALICE);
    h.sent.length = 0;
    await enter(h, bot, raffleId, ALICE);
    await enter(h, bot, "00".repeat(16), BOB);
    expect(h.sent.map((m) => m.valueWei)).toEqual([PRICE, PRICE]);
    expect(JSON.parse(h.data.get("current_round")!).entrants).toEqual([ALICE]);
  });

  test("a full round pays the pot to the winner with the draw, records real payment hashes, and the draw verifies", async () => {
    const h = harness();
    const bot = new RaffleBot({ maxEntries: 2 });
    const announce = await open(h, bot);
    await enter(h, bot, announce.raffleId, ALICE);
    await enter(h, bot, announce.raffleId, BOB);

    const paying = h.sent.filter((m) => m.valueWei > 0n);
    expect(paying).toHaveLength(1);
    expect(paying[0].valueWei).toBe(PRICE * 2n);
    const draw = h.item("raffle", paying[0]);
    expect(draw.action).toBe("draw");
    expect(paying[0].to).toBe(draw.winnerAddress);
    // Entry "transactions" are the entrants' own confirmed payments, not digests or random bytes.
    expect(draw.entryTxHashes).toHaveLength(2);
    for (const txHash of draw.entryTxHashes!) expect(h.chain.has(txHash)).toBe(true);
    expect(verifyRaffleDrawAgainstThread(draw, [announce])).toMatchObject({
      valid: true,
      countVerified: true,
    });
    // The other entrant is told, and paid nothing.
    const loser = draw.winnerAddress === ALICE ? BOB : ALICE;
    const told = h.sent.filter((m) => m.to === loser && h.item("raffle", m)?.action === "draw");
    expect(told).toHaveLength(1);
    expect(told[0].valueWei).toBe(0n);
    // A new round is open under a new commitment.
    const next = JSON.parse(h.data.get("current_round")!);
    expect(next.raffleId).not.toBe(announce.raffleId);
    expect(next.serverSeedHash).not.toBe(announce.serverSeedHash);
    expect(next.entrants).toEqual([]);
  });

  test("a payout that fails is retried and nobody is told a winner until it has gone out", async () => {
    const h = harness();
    const bot = new RaffleBot({ maxEntries: 2 });
    const { raffleId } = await open(h, bot);
    await enter(h, bot, raffleId, ALICE);
    h.sent.length = 0;
    h.failSends(new Error("Insufficient main account balance"));
    await enter(h, bot, raffleId, BOB);
    // Nothing went out: no winner announced to anyone, no new round opened.
    expect(h.sent).toHaveLength(0);
    expect(JSON.parse(h.data.get("current_round")!)).toMatchObject({
      raffleId,
      status: "drawing",
    });
    // Still failing: still nothing announced.
    for (const schedule of bot.schedules) await schedule.handler(h.ctx);
    expect(h.sent).toHaveLength(0);

    // An entry while the winner is unpaid is not counted.
    const CAROL = "0x" + "c3".repeat(20);
    await enter(h, bot, raffleId, CAROL);
    expect(h.sent).toHaveLength(0);
    expect(JSON.parse(h.data.get("current_round")!).entrants).toEqual([ALICE, BOB]);

    h.failSends();
    for (const schedule of bot.schedules) await schedule.handler(h.ctx);
    for (const schedule of bot.schedules) await schedule.handler(h.ctx);
    const pot = h.sent.findIndex((m) => m.valueWei === PRICE * 2n);
    const winner = h.sent[pot].to;
    expect(h.item("raffle", h.sent[pot]).winnerAddress).toBe(winner);
    expect(h.sent.filter((m) => m.valueWei === PRICE * 2n)).toHaveLength(1);
    // The loser hears of the draw only after the winner's payment went out.
    const told = h.sent.findIndex(
      (m) => m.to !== winner && h.item("raffle", m)?.action === "draw"
    );
    expect(told).toBeGreaterThan(pot);
    // The late entry's money came back.
    expect(h.sent.find((m) => m.to === CAROL)!.valueWei).toBe(PRICE);
    expect(JSON.parse(h.data.get("current_round")!).status).toBe("open");
  });

  test("a restart in the middle of the payout pays the pot once", async () => {
    const h = harness();
    const bot = new RaffleBot({ maxEntries: 2 });
    const { raffleId } = await open(h, bot);
    await enter(h, bot, raffleId, ALICE);
    // The state as it is the moment the round fills, before anything is recorded as sent.
    const full = JSON.parse(h.data.get("current_round")!);
    await enter(h, bot, raffleId, BOB);
    expect(h.paidOut()).toBe(PRICE * 2n);
    const roundAtCrash = { ...full, status: "drawing" };
    const paidTx = [...h.chain.keys()];
    roundAtCrash.entrants = [ALICE, BOB];
    roundAtCrash.entryTxHashes = [paidTx[0], paidTx[1]];
    roundAtCrash.conversations = [full.conversations[0], full.conversations[0]];
    // The process dies after the wallet took the payment and before the bot recorded it.
    for (const key of [...h.data.keys()]) if (key.startsWith("outbox/")) h.data.delete(key);
    h.data.set("current_round", JSON.stringify(roundAtCrash));

    const restarted = new RaffleBot({ maxEntries: 2 });
    for (const schedule of restarted.schedules) await schedule.handler(h.ctx);
    for (const schedule of restarted.schedules) await schedule.handler(h.ctx);
    expect(h.paidOut()).toBe(PRICE * 2n);
    expect(JSON.parse(h.data.get("current_round")!).status).toBe("open");
  });

  test("a round record that cannot be read is an error, never silently a new round", async () => {
    const h = harness();
    h.data.set("current_round", "{not json");
    await expect(
      new RaffleBot().onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx)
    ).rejects.toThrow();
    expect(h.data.get("current_round")).toBe("{not json");
  });
});
