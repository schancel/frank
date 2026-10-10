import { confirmReceived, Outbox, refuse } from "./money";
import { harness, PLAYER } from "./bot-harness.testutil";

describe("confirmReceived", () => {
  test("counts a transfer that is mined, succeeded and as described", async () => {
    const h = harness();
    const message = h.message([], [h.pay(5n), h.pay(7n)]);
    expect(await confirmReceived(message, h.ctx, 0)).toEqual({
      confirmedWei: 12n,
      unconfirmed: [],
    });
  });

  test("a stated value with no transfer behind it is nothing received", async () => {
    const h = harness();
    const message = { ...h.message([]), stampValueWei: 10n ** 18n };
    expect((await confirmReceived(message, h.ctx, 0)).confirmedWei).toBe(0n);
  });

  test("a reverted transfer, and one that is not the transfer described, count for nothing", async () => {
    const h = harness();
    const reverted = h.pay(5n, { status: 0 });
    const other = h.pay(5n);
    h.chain.get(other.txHash)!.value = 1n;
    const elsewhere = h.pay(5n);
    h.chain.get(elsewhere.txHash)!.to = "0x" + "00".repeat(20);
    const unknown = { ...h.pay(5n), txHash: "0x" + "ff".repeat(32) };
    const got = await confirmReceived(
      h.message([], [reverted, other, elsewhere]),
      h.ctx,
      0
    );
    expect(got).toEqual({ confirmedWei: 0n, unconfirmed: [] });
    // Never seen by the chain: not received, and reported as not confirmed.
    const pending = await confirmReceived(h.message([], [unknown]), h.ctx, 0);
    expect(pending.confirmedWei).toBe(0n);
    expect(pending.unconfirmed).toHaveLength(1);
  });

  test("a transfer that is not mined yet is not received", async () => {
    const h = harness();
    const payment = h.pay(5n, { mined: false });
    const got = await confirmReceived(h.message([], [payment]), h.ctx, 0);
    expect(got.confirmedWei).toBe(0n);
    expect(got.unconfirmed.map((p) => p.txHash)).toEqual([payment.txHash]);
  });

  test("one transfer pays for one message only", async () => {
    const h = harness();
    const payment = h.pay(5n);
    const first = h.message([], [payment]);
    expect((await confirmReceived(first, h.ctx, 0)).confirmedWei).toBe(5n);
    // The same message again (a repeat of the same check) still counts it...
    expect((await confirmReceived(first, h.ctx, 0)).confirmedWei).toBe(5n);
    // ...another message naming the same transfer does not.
    const replay = h.message([], [payment]);
    expect((await confirmReceived(replay, h.ctx, 0)).confirmedWei).toBe(0n);
    // Nor does listing it twice in one message.
    const twice = h.pay(3n);
    expect(
      (await confirmReceived(h.message([], [twice, twice]), h.ctx, 0))
        .confirmedWei
    ).toBe(3n);
  });
});

describe("Outbox", () => {
  const owed = { to: PLAYER, items: [{ type: "text" as const, text: "paid" }] };

  test("an owed message is sent once, with its value", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    await outbox.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    await outbox.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(9n);
    expect(await outbox.sent(h.ctx, "a")).toBe(true);
    // Owing the same thing again after it went changes nothing.
    await outbox.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    await outbox.settle(h.ctx);
    expect(h.paidOut()).toBe(9n);
  });

  test("a payout that fails is kept and retried, and does not hold up others", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    await outbox.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    h.failSends(new Error("Insufficient main account balance"));
    await outbox.settle(h.ctx);
    expect(h.sent).toHaveLength(0);
    expect(await outbox.sent(h.ctx, "a")).toBe(false);
    h.failSends();
    await outbox.owe(h.ctx, "b", { ...owed, valueWei: 1n });
    await outbox.settle(h.ctx);
    expect(h.sent.map((m) => m.valueWei)).toEqual([9n, 1n]);
  });

  test("a restart in the middle of a payout pays once", async () => {
    const h = harness();
    const before = new Outbox("test");
    await before.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    // The wallet takes the payment, then the process dies before the bot records that it went:
    // the bot's own record still says "owed".
    const stale = new Map(h.data);
    await before.settle(h.ctx);
    expect(h.paidOut()).toBe(9n);
    for (const key of [...h.data.keys()]) h.data.delete(key);
    for (const [key, value] of stale) h.data.set(key, value);

    const after = new Outbox("test");
    expect(await after.sent(h.ctx, "a")).toBe(false);
    await after.settle(h.ctx);
    await after.settle(h.ctx);
    // The wallet refused a second attempt for the same message ID; nothing was paid again.
    expect(h.paidOut()).toBe(9n);
    expect(h.sent).toHaveLength(1);
    expect(await after.sent(h.ctx, "a")).toBe(true);
  });

  test("a restart before anything was sent sends it", async () => {
    const h = harness();
    await new Outbox("test").owe(h.ctx, "a", { ...owed, valueWei: 9n });
    await new Outbox("test").schedule.handler(h.ctx);
    expect(h.paidOut()).toBe(9n);
  });

  test("a refund waits for a payment that is not mined, then returns it", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const payment = h.pay(5n, { mined: false });
    const message = h.message([], [payment]);
    const received = await confirmReceived(message, h.ctx, 0);
    await refuse(outbox, message, h.ctx, received, "Too little.");
    expect(h.sent).toHaveLength(0);
    h.chain.get(payment.txHash)!.mined = true;
    await outbox.settle(h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(5n);
  });

  test("a refund returns exactly what was confirmed, and nothing when nothing was paid", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const paid = h.message([], [h.pay(4n)]);
    await refuse(outbox, paid, h.ctx, await confirmReceived(paid, h.ctx, 0), "No.");
    const unpaid = h.message([]);
    await refuse(outbox, unpaid, h.ctx, await confirmReceived(unpaid, h.ctx, 0), "No.");
    expect(h.sent.map((m) => m.valueWei)).toEqual([4n, 0n]);
  });
});
