import { confirmReceived, Outbox, refuse } from "./money";
import { harness, PLAYER } from "./bot-harness.testutil";

describe("confirmReceived", () => {
  test("counts a transfer that is mined, succeeded and as described", async () => {
    const h = harness();
    const message = h.message([], [h.pay(5n), h.pay(7n)]);
    expect(await confirmReceived(message, h.ctx, 0)).toMatchObject({
      confirmedWei: 12n,
      unconfirmed: [],
    });
  });

  test("a stated value with no transfer behind it is nothing received", async () => {
    const h = harness();
    const message = { ...h.message([]), stampValueWei: 10n ** 18n };
    expect((await confirmReceived(message, h.ctx, 0)).confirmedWei).toBe(0n);
  });

  test("failed evidence counts for nothing; a verified partial receipt counts its actual value", async () => {
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
    expect(got).toMatchObject({ confirmedWei: 1n, unconfirmed: [] });
    expect(got.confirmed.map((payment) => payment.valueWei)).toEqual(["1"]);
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

describe("wallet-owned stamp evidence", () => {
  test("uses actual stamp receipts despite failed aggregate; ignores stealth and RPC hash checks", async () => {
    const h = harness();
    const payment = h.pay(100n);
    const message = h.message([], [payment]);
    const receipt = {
      address: payment.destinationAddress,
      payloadDigest: message.payloadDigest,
      status: "received" as const,
      origin: "stamp" as const,
      receivedAmountWei: 7n,
      amountWei: 0n,
      claimedAmountWei: 100n,
      spendable: false,
    };
    h.ctx.checkMessagePayment = jest.fn(async () => ({
      status: "failed",
      receivedWei: 999n,
      statedWei: 100n,
      payments: [
        receipt,
        { ...receipt, origin: "stealth", receivedAmountWei: 992n },
      ],
    }));
    const rpc = jest
      .spyOn(h.ctx.provider, "getTransactionReceipt")
      .mockRejectedValue(new Error("superseded"));
    const received = await confirmReceived(message, h.ctx, 0);
    expect(received.confirmedWei).toBe(7n);
    expect(received.confirmed[0].valueWei).toBe("7");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("another digest's evidence is unresolved, and no stated amount becomes received", async () => {
    const h = harness();
    const payment = h.pay(100n);
    const message = h.message([], [payment]);
    h.ctx.checkMessagePayment = jest.fn(async () => ({
      status: "received",
      receivedWei: 100n,
      statedWei: 100n,
      payments: [
        {
          address: payment.destinationAddress,
          payloadDigest: "other",
          status: "received",
          origin: "stamp",
          receivedAmountWei: 100n,
          amountWei: 100n,
          claimedAmountWei: 100n,
          spendable: true,
        },
      ],
    }));
    expect(await confirmReceived(message, h.ctx, 0)).toMatchObject({
      confirmedWei: 0n,
      unconfirmed: [expect.objectContaining({ txHash: payment.txHash })],
    });
  });

  test("an existing durable transfer claim survives restart and blocks another message", async () => {
    const h = harness();
    const payment = h.pay(5n);
    const first = h.message([], [payment]);
    await h.ctx.state.put(
      `received:${payment.txHash.toLowerCase()}`,
      first.payloadDigest
    );
    expect((await confirmReceived(first, h.ctx, 0)).confirmedWei).toBe(5n);
    const restarted = harness(h.data);
    restarted.chain.set(payment.txHash, h.chain.get(payment.txHash)!);
    expect(
      (
        await confirmReceived(
          restarted.message([], [payment]),
          restarted.ctx,
          0
        )
      ).confirmedWei
    ).toBe(0n);
    expect(
      await restarted.ctx.state.get(`received:${payment.txHash.toLowerCase()}`)
    ).toBe(first.payloadDigest);
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

  test("a payment not mined in time: the refusal goes out at once, and the payment is returned when it lands", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const payment = h.pay(5n, { mined: false });
    const message = h.message([], [payment]);
    const received = await confirmReceived(message, h.ctx, 0);
    await refuse(outbox, message, h.ctx, received, "Too little.");
    // Said at once, carrying nothing.
    expect(h.sent.map((m) => m.valueWei)).toEqual([0n]);
    h.chain.get(payment.txHash)!.mined = true;
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    expect(h.sent.map((m) => m.valueWei)).toEqual([0n, 5n]);
  });

  test("a payment that never lands is never returned and nothing more is said", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const message = h.message([], [h.pay(5n, { mined: false })]);
    await refuse(outbox, message, h.ctx, await confirmReceived(message, h.ctx, 0), "No.");
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    await outbox.settle(h.ctx);
    now.mockRestore();
    expect(h.sent).toHaveLength(1);
    expect((await outbox.list(h.ctx)).owed).toEqual([]);
  });

  test("one unmined transfer named by two messages is returned once", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const payment = h.pay(10n, { mined: false });
    for (const message of [h.message([], [payment]), h.message([], [payment])])
      await refuse(outbox, message, h.ctx, await confirmReceived(message, h.ctx, 0), "No.");
    h.chain.get(payment.txHash)!.mined = true;
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    expect(h.paidOut()).toBe(10n);
  });

  test("a transfer played by one message is not also refunded to another that named it", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const payment = h.pay(10n, { mined: false });
    const early = h.message([], [payment]);
    await refuse(outbox, early, h.ctx, await confirmReceived(early, h.ctx, 0), "No.");
    h.chain.get(payment.txHash)!.mined = true;
    // Another message names it once it is mined, and is credited with it (it plays).
    expect((await confirmReceived(h.message([], [payment]), h.ctx, 0)).confirmedWei).toBe(10n);
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    expect(h.paidOut()).toBe(0n);
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

describe("a transfer is credited only once it is confirmed", () => {
  test("naming somebody else's transfer with another address takes nothing from its payer", async () => {
    const h = harness();
    const real = h.pay(5n);
    const thief = h.message(
      [],
      [{ ...real, destinationAddress: "0x" + "77".repeat(20) }]
    );
    expect((await confirmReceived(thief, h.ctx, 0)).confirmedWei).toBe(0n);
    expect((await confirmReceived(h.message([], [real]), h.ctx, 0)).confirmedWei).toBe(5n);
  });

  test("naming a transfer that is not mined yet does not take it either", async () => {
    const h = harness();
    const real = h.pay(5n, { mined: false });
    await confirmReceived(h.message([], [real]), h.ctx, 0);
    h.chain.get(real.txHash)!.mined = true;
    expect((await confirmReceived(h.message([], [real]), h.ctx, 0)).confirmedWei).toBe(5n);
  });
});

describe("Outbox: an attempt the wallet holds is not a delivery", () => {
  const owed = { to: PLAYER, items: [{ type: "text" as const, text: "paid" }] };

  test("an attempt still on its way stays owed until the wallet says delivered", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    await outbox.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    h.wallet("live");
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    expect(await outbox.sent(h.ctx, "a")).toBe(false);
    expect((await outbox.list(h.ctx)).owed.map((e) => e.id)).toEqual(["a"]);
    h.deliverLive();
    await outbox.settle(h.ctx);
    expect(await outbox.sent(h.ctx, "a")).toBe(true);
    expect(h.paidOut()).toBe(9n);
  });

  test("an attempt the relay ended is FAILED: never sent, reported, listed, and resent only on an operator's retry", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await outbox.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    h.wallet("dead");
    await outbox.settle(h.ctx);
    h.wallet("deliver");
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    expect(await outbox.sent(h.ctx, "a")).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(errors.mock.calls.flat().join(" ")).toMatch(/FAILED.*a.*9 wei/);
    const listed = await outbox.list(h.ctx);
    expect(listed.failed.map((e) => e.id)).toEqual(["a"]);
    expect(listed.owed).toEqual([]);
    // Owing the same thing again does not bring it back.
    await outbox.owe(h.ctx, "a", { ...owed, valueWei: 9n });
    await outbox.settle(h.ctx);
    expect(h.sent).toHaveLength(0);

    expect(await outbox.retry(h.ctx, "a")).toBe(true);
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
    expect(h.paidOut()).toBe(9n);
    expect(await outbox.sent(h.ctx, "a")).toBe(true);
    errors.mockRestore();
  });
});

describe("Outbox.handle: a paid message is written down before anything else", () => {
  const settleTwice = async (outbox: Outbox, h: ReturnType<typeof harness>) => {
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
  };

  test("a handler that throws: the confirmed payment is refunded exactly once", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const message = h.message([], [h.pay(7n)]);
    await expect(
      outbox.handle(message, h.ctx, async () => {
        throw new Error("boom");
      }, 0)
    ).rejects.toThrow("boom");
    await settleTwice(outbox, h);
    await settleTwice(new Outbox("test"), h);
    expect(h.sent.map((m) => [m.to, m.valueWei])).toEqual([[PLAYER, 7n]]);
  });

  test("a crash while the payment is being confirmed: refunded once after restart", async () => {
    const h = harness();
    const message = h.message([], [h.pay(7n)]);
    // The process dies inside the handler: it never returns and nothing more is written.
    void new Outbox("test").handle(message, h.ctx, () => new Promise(() => undefined), 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await new Outbox("test").list(h.ctx)).pending).toHaveLength(1);
    await settleTwice(new Outbox("test"), h);
    expect(h.sent.map((m) => m.valueWei)).toEqual([7n]);
  });

  test("a message still being handled is not refunded by the timer", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const message = h.message([], [h.pay(7n)]);
    let finish!: () => void;
    const handling = outbox.handle(
      message,
      h.ctx,
      () => new Promise<void>((resolve) => (finish = resolve)),
      0
    );
    await new Promise((resolve) => setImmediate(resolve));
    await settleTwice(outbox, h);
    expect(h.sent).toHaveLength(0);
    finish();
    await handling;
  });

  test("a crash after the result is owed: the result is sent and nothing is refunded", async () => {
    const h = harness();
    const message = h.message([], [h.pay(7n)]);
    const outbox = new Outbox("test");
    await outbox.handle(message, h.ctx, async () => {
      await outbox.owe(
        h.ctx,
        "result",
        { to: PLAYER, items: [{ type: "text", text: "you win" }], valueWei: 14n },
        { digest: message.payloadDigest }
      );
    }, 0);
    await settleTwice(new Outbox("test"), h);
    expect(h.sent.map((m) => m.valueWei)).toEqual([14n]);
  });

  test("money the game keeps is neither refunded nor left unsettled", async () => {
    const h = harness();
    const message = h.message([], [h.pay(7n)]);
    const outbox = new Outbox("test");
    await outbox.handle(message, h.ctx, () =>
      outbox.keep(h.ctx, message.payloadDigest, [
        { type: "put", key: "game", value: "has it" },
      ]), 0);
    await settleTwice(new Outbox("test"), h);
    expect(h.sent).toHaveLength(0);
    expect(h.data.get("game")).toBe("has it");
    expect((await outbox.list(h.ctx)).pending).toEqual([]);
  });

  test("a left-over message whose payment never landed owes nothing", async () => {
    const h = harness();
    const message = h.message([], [h.pay(7n, { status: 0 })]);
    await expect(
      new Outbox("test").handle(message, h.ctx, async () => {
        throw new Error("boom");
      }, 0)
    ).rejects.toThrow();
    await settleTwice(new Outbox("test"), h);
    expect(h.sent).toHaveLength(0);
  });
});

describe("a bot's own messages carry no stamp", () => {
  test("an owed message with no value, a refusal and a refund all name their own value; none is left to the host's paid stamp", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    await outbox.owe(h.ctx, "a", { to: PLAYER, items: [{ type: "text", text: "you lost" }] });
    const paid = h.message([], [h.pay(4n)]);
    await refuse(outbox, paid, h.ctx, await confirmReceived(paid, h.ctx, 0), "No.");
    const unpaid = h.message([]);
    await refuse(outbox, unpaid, h.ctx, await confirmReceived(unpaid, h.ctx, 0), "No.");
    await outbox.settle(h.ctx);
    expect(h.sent.map((m) => m.valueWei)).toEqual([0n, 4n, 0n]);
    expect(h.sent.some((m) => m.hostStamp)).toBe(false);
  });

  test("what is owed and not delivered is known, for a bank that must not promise it twice", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    h.failSends(new Error("down"));
    await outbox.owe(h.ctx, "a", { to: PLAYER, items: [], valueWei: 7n });
    await outbox.owe(h.ctx, "b", { to: PLAYER, items: [], valueWei: 5n });
    await outbox.settle(h.ctx);
    expect(await outbox.owedWei(h.ctx)).toBe(12n);
    h.failSends();
    await outbox.settle(h.ctx);
    expect(await outbox.owedWei(h.ctx)).toBe(0n);
  });
});

describe("a message the host hands back after a crash", () => {
  const settleTwice = async (outbox: Outbox, h: ReturnType<typeof harness>) => {
    await outbox.settle(h.ctx);
    await outbox.settle(h.ctx);
  };

  test("never written down (the crash came before the bot's first write): what it paid is refunded once", async () => {
    const h = harness();
    const message = h.message([], [h.pay(7n)]);
    const outbox = new Outbox("test");
    await outbox.interrupted(h.ctx, message);
    await outbox.interrupted(h.ctx, message);
    await settleTwice(outbox, h);
    await new Outbox("test").interrupted(h.ctx, message);
    await settleTwice(new Outbox("test"), h);
    expect(h.sent.map((m) => [m.to, m.valueWei])).toEqual([[PLAYER, 7n]]);
  });

  test("already settled (its result was owed before the crash): nothing is refunded", async () => {
    const h = harness();
    const message = h.message([], [h.pay(7n)]);
    const outbox = new Outbox("test");
    await outbox.handle(message, h.ctx, async () => {
      await outbox.owe(
        h.ctx,
        "result",
        { to: PLAYER, items: [{ type: "text", text: "you win" }], valueWei: 14n },
        { digest: message.payloadDigest }
      );
    }, 0);
    await new Outbox("test").interrupted(h.ctx, message);
    await settleTwice(new Outbox("test"), h);
    expect(h.sent.map((m) => m.valueWei)).toEqual([14n]);
  });

  test("kept by the game: nothing is refunded", async () => {
    const h = harness();
    const message = h.message([], [h.pay(7n)]);
    const outbox = new Outbox("test");
    await outbox.handle(message, h.ctx, () => outbox.keep(h.ctx, message.payloadDigest), 0);
    await new Outbox("test").interrupted(h.ctx, message);
    await settleTwice(new Outbox("test"), h);
    expect(h.sent).toHaveLength(0);
  });

  test("a refusal and its late refund are one write", async () => {
    const h = harness();
    const outbox = new Outbox("test");
    const message = h.message([], [h.pay(5n, { mined: false })]);
    const batches: number[] = [];
    const batch = h.ctx.state.batch;
    (h.ctx.state as any).batch = async (ops: any[]) => {
      batches.push(ops.filter((op) => String(op.key).startsWith("outbox:owed:")).length);
      return batch(ops);
    };
    h.failSends(new Error("down"));
    await refuse(outbox, message, h.ctx, await confirmReceived(message, h.ctx, 0), "No.");
    expect(batches.filter((n) => n > 0)).toEqual([2]);
  });
});

