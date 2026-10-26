/**
 * Bot payouts and refunds against the payment floor (owner rule, 2026-10-25: a stamp "should be
 * at least 10x the gas required to move it"). The floor is the wallet's own figure
 * (`evmPaymentFloorWei`, as `minimumStamp` reports it at solonet's 102 gwei), and the harness
 * wallet refuses below it before any attempt, as the real wallet does. Unit tests on the bot
 * harness; nothing here is evidence about a real relay or chain.
 */
import type { SatoshiDiceItem } from "@frank/cashweb/types/messages";
import { evmPaymentFloorWei } from "@frank/wallet/chain/payment-floor";
import { dicePayoutWei, diceRoll } from "@frank/wallet/message-item-plugins/dice/fair";
import { harness } from "./bot-harness.testutil";
import { SatoshiDiceBot } from "./satoshi-dice-bot";

const GAS_PRICE = 102_000_000_000n; // eth_gasPrice on solonet and Monad (2026-10-25)
const FLOOR = evmPaymentFloorWei(GAS_PRICE); // 0.02142 MON
/** The stamp that could never be moved: less than one transfer's gas. */
const DUST = 2_100_000_000_000_000n;
const TARGET = 32768;

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

const owedIds = (h: ReturnType<typeof harness>) =>
  [...h.data.keys()].filter((key) => key.includes("outbox:owed:"));

describe("bot payouts and refunds respect the payment floor", () => {
  test("the floor is ten transfers' gas", () => {
    expect(FLOOR).toBe(10n * 21_000n * GAS_PRICE);
    expect(DUST).toBeLessThan(21_000n * GAS_PRICE);
  });

  test("a table offers no stake below twice the floor, and its winning payout is above the floor", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    h.enforceFloor();
    const bot = new SatoshiDiceBot();
    await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
    // A default table minimum below the floor is raised to twice it.
    expect(h.sent.some((m) => m.valueWei > 0n && m.valueWei < FLOOR)).toBe(false);
    const bet = await diceBet(h, bot, 2n * FLOOR, "win");
    await bot.onMessage(h.message([bet], [h.pay(2n * FLOOR)]), h.ctx);
    expect(h.item("dice")).toMatchObject({ action: "result", isWin: true });
    const payout = dicePayoutWei(2n * FLOOR, TARGET);
    expect(h.paidOut()).toBe(payout);
    expect(payout).toBeGreaterThanOrEqual(FLOOR);
    // Every amount the bot sent is either nothing or at least the floor.
    expect(h.sent.every((m) => m.valueWei === 0n || m.valueWei >= FLOOR)).toBe(true);
  });

  test("a refund the floor does not allow is never sent as dust: it stays owed, not sent and not failed", async () => {
    const h = harness();
    h.feeFloor(FLOOR);
    h.enforceFloor();
    const bot = new SatoshiDiceBot();
    const bet = await diceBet(h, bot, DUST, "win");
    await bot.onMessage(h.message([bet], [h.pay(DUST)]), h.ctx);
    // The roll is refused (the stake is below the table minimum) and nothing below the floor
    // reached the wallet's sends: the refund of 0.0021 MON is owed, not paid as unspendable dust.
    expect(h.sent.some((m) => m.items.some((i) => i.type === "dice" && i.action === "result"))).toBe(false);
    expect(h.sent.every((m) => m.valueWei === 0n || m.valueWei >= FLOOR)).toBe(true);
    expect(h.paidOut()).toBe(0n);
    expect(owedIds(h)).toHaveLength(1);
    expect([...h.data.keys()].some((key) => key.includes("outbox:failed:"))).toBe(false);
    expect([...h.data.keys()].some((key) => key.includes("outbox:sent:refund"))).toBe(false);

    // Retried while the floor still forbids it: still owed, still nothing sent.
    await bot.schedules[0].handler(h.ctx);
    expect(h.paidOut()).toBe(0n);
    expect(owedIds(h)).toHaveLength(1);
  });
});
