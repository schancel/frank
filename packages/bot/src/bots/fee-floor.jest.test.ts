/**
 * The chain's fee floor at every table with a stake or a price. Unit tests on the bot harness:
 * the floor is what `BotContext.minimumStampWei` reports (the wallet's `minimumStamp` behind the
 * real host), set here by the test. Nothing here is evidence about a real wallet or chain.
 */
import type {
  DigitalGoodsItem,
  RaffleItem,
  RpsItem,
  SatoshiDiceItem,
} from "@frank/cashweb/types/messages";
import {
  dicePayoutWei,
  diceRoll,
} from "@frank/wallet/message-item-plugins/dice/fair";
import {
  evaluateRps,
  type RpsMove,
} from "@frank/wallet/message-item-plugins/rps/fair";
import type { VendorCatalogItem } from "../../vendor-catalog";
import { harness } from "./bot-harness.testutil";
import { RaffleBot } from "./raffle-bot";
import { RpsBot } from "./rps-bot";
import { SatoshiDiceBot } from "./satoshi-dice-bot";
import { VendorBot } from "./vendor-bot";

const FLOOR = 5_000_000_000_000_000n; // 0.005 MON: one transfer's fee, say
const DUST = 1_000_000_000_000_000n; // below it
/** A table's minimum: twice the floor, so a refund survives the fee rising before it is sent. */
const MINIMUM = 2n * FLOOR;
const STAKE = 20_000_000_000_000_000n; // above the minimum
const TARGET = 32768;

const texts = (h: ReturnType<typeof harness>) =>
  h.sent
    .flatMap((message) => message.items)
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");

async function diceBet(
  h: ReturnType<typeof harness>,
  bot: SatoshiDiceBot,
  wagerWei: bigint,
  want: "win" | "lose"
): Promise<SatoshiDiceItem> {
  await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
  const offer = h.item("dice");
  const { secret } = JSON.parse(h.data.get(`roll:${offer.rollId}`)!);
  let n = 0;
  let clientSeed = "";
  do clientSeed = (n++).toString(16).padStart(32, "0");
  while ((diceRoll(secret, clientSeed) < TARGET) !== (want === "win"));
  h.sent.length = 0;
  return {
    type: "dice",
    action: "roll",
    rollId: offer.rollId,
    commitment: offer.commitment,
    clientSeed,
    target: TARGET,
    wagerWei: wagerWei.toString(),
  };
}

describe("a table's minimum stake is never below twice the chain's fee floor", () => {
  test("dice refuses a stake below the floor, rolls nothing, and the refund goes out as text only", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    const bot = new SatoshiDiceBot();
    const bet = await diceBet(h, bot, DUST, "win");
    await bot.onMessage(h.message([bet], [h.pay(DUST)]), h.ctx);
    expect(
      h.sent
        .flatMap((m) => m.items)
        .some((i) => i.type === "dice" && i.action === "result")
    ).toBe(false);
    expect(texts(h)).toContain("The smallest stake at this table is");
    expect(texts(h)).toContain("No roll was made");
    // Returning it would cost more than it is: no money moves, and the message says so.
    expect(h.paidOut()).toBe(0n);
    expect(h.sent.every((m) => m.valueWei === 0n && !m.hostStamp)).toBe(true);
    expect(texts(h)).toContain("too small to send back");
    expect(texts(h)).not.toContain("is returned with this message");
  });

  test("dice at or above the floor: a winning roll's payout is paid", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    const bot = new SatoshiDiceBot();
    const bet = await diceBet(h, bot, STAKE, "win");
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(h.item("dice").action).toBe("result");
    expect(h.paidOut()).toBe(dicePayoutWei(STAKE, TARGET));
    expect(h.paidOut()).toBeGreaterThanOrEqual(FLOOR);
  });

  test("a stake exactly at twice the floor is taken; one between the floor and that is refused and returned as money", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    const bot = new SatoshiDiceBot();
    const bet = await diceBet(h, bot, MINIMUM, "lose");
    await bot.onMessage(h.message([bet], [h.pay(MINIMUM)]), h.ctx);
    expect(h.item("dice")).toMatchObject({ action: "result", isWin: false });

    const between = FLOOR + FLOOR / 2n;
    const small = await diceBet(h, bot, between, "win");
    await bot.onMessage(h.message([small], [h.pay(between)]), h.ctx);
    expect(texts(h)).toContain("The smallest stake at this table is");
    // Above the floor, so it can be moved: it goes back.
    expect(h.paidOut()).toBe(between);
  });

  test("an operator's own minimum above the floor is the minimum", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    const bot = new SatoshiDiceBot({ minWagerWei: STAKE * 2n });
    const bet = await diceBet(h, bot, STAKE, "win");
    await bot.onMessage(h.message([bet], [h.pay(STAKE)]), h.ctx);
    expect(texts(h)).toContain("The smallest stake at this table is");
    // What was paid is above the floor: it goes back as money.
    expect(h.paidOut()).toBe(STAKE);
    expect(texts(h)).toContain("is returned with this message");
  });

  test("rock-paper-scissors refuses a stake below the floor and plays nothing", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    const bot = new RpsBot();
    await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
    const start = h.item("rps");
    const { move } = JSON.parse(h.data.get(`match:${start.matchId}`)!);
    const playerMove = (["rock", "paper", "scissors"] as RpsMove[]).find(
      (candidate) => evaluateRps(candidate, move) === "win"
    )!;
    const mine: RpsItem = {
      type: "rps",
      action: "move",
      matchId: start.matchId,
      commitHash: start.commitHash,
      playerMove,
      wagerWei: DUST.toString(),
    };
    h.sent.length = 0;
    await bot.onMessage(h.message([mine], [h.pay(DUST)]), h.ctx);
    expect(
      h.sent
        .flatMap((m) => m.items)
        .some((i) => i.type === "rps" && i.action === "resolve")
    ).toBe(false);
    expect(texts(h)).toContain("The smallest stake at this table is");
    expect(h.paidOut()).toBe(0n);

    // At the minimum the same table plays, and a win pays twice the stake.
    await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
    const next = h.item("rps");
    const second = JSON.parse(h.data.get(`match:${next.matchId}`)!);
    h.sent.length = 0;
    await bot.onMessage(
      h.message(
        [
          {
            ...mine,
            matchId: next.matchId,
            commitHash: next.commitHash,
            playerMove: (["rock", "paper", "scissors"] as RpsMove[]).find(
              (candidate) => evaluateRps(candidate, second.move) === "win"
            )!,
            wagerWei: MINIMUM.toString(),
          },
        ],
        [h.pay(MINIMUM)]
      ),
      h.ctx
    );
    expect(h.item("rps")).toMatchObject({ action: "resolve", outcome: "win" });
    expect(h.paidOut()).toBe(MINIMUM * 2n);
  });

  test("a raffle round opens at twice the floor when its configured ticket price is below that", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    const bot = new RaffleBot({ entryPriceWei: DUST, maxEntries: 2 });
    const alice = "0x" + "a1".repeat(20);
    await bot.onMessage(h.message([{ type: "text", text: "hello" }], [], alice), h.ctx);
    const announce = h.item("raffle");
    expect(announce.entryPriceWei).toBe(MINIMUM.toString());
    h.sent.length = 0;
    const enter: RaffleItem = {
      type: "raffle",
      raffleId: announce.raffleId,
      action: "enter",
    };
    // The configured price no longer buys a ticket; it is too small to send back.
    await bot.onMessage(h.message([enter], [h.pay(DUST)], alice), h.ctx);
    expect(JSON.parse(h.data.get("current_round")!).entrants).toEqual([]);
    expect(texts(h)).toContain("You are not entered");
    expect(h.paidOut()).toBe(0n);
    await bot.onMessage(h.message([enter], [h.pay(MINIMUM)], alice), h.ctx);
    expect(JSON.parse(h.data.get("current_round")!).entrants).toEqual([alice]);
  });

  test("the shop never sells below twice the floor: the catalog shows the price in force and a smaller payment buys nothing", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    const catalog: VendorCatalogItem[] = [
      {
        itemId: "pic",
        description: "A picture",
        priceWei: DUST,
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      },
    ];
    const bot = new VendorBot({ catalogItems: catalog });
    const buy: DigitalGoodsItem = {
      type: "digital-goods",
      action: "request",
      itemId: "pic",
    };
    await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
    expect(JSON.stringify(h.item("digital-goods"))).toContain(
      MINIMUM.toString()
    );
    h.sent.length = 0;
    await bot.onMessage(h.message([buy], [h.pay(DUST)]), h.ctx);
    expect(h.sent.some((m) => m.items.some((i) => i.type === "image"))).toBe(
      false
    );
    expect(texts(h)).toContain("Nothing was sold");
    expect(h.paidOut()).toBe(0n);
    await bot.onMessage(h.message([buy], [h.pay(MINIMUM)]), h.ctx);
    expect(h.sent.some((m) => m.items.some((i) => i.type === "image"))).toBe(
      true
    );
  });

  test("with no floor reported nothing changes: a small stake plays as before", async () => {
    const h = harness();
    const bot = new SatoshiDiceBot();
    const bet = await diceBet(h, bot, DUST, "win");
    await bot.onMessage(h.message([bet], [h.pay(DUST)]), h.ctx);
    expect(h.item("dice").action).toBe("result");
    expect(h.paidOut()).toBe(dicePayoutWei(DUST, TARGET));
  });
});
