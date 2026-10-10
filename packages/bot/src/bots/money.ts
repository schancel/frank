/**
 * The money rules every game and shop bot follows.
 *
 * 1. What a message paid is what is on chain (`confirmReceived`). The wallet reports the
 *    transfers that came with a message and that pay this bot's own stamp key; each is counted
 *    only once it is mined, succeeded, and is the transfer the wallet described, and it is
 *    credited to one message only (the first for which it is confirmed).
 *
 * 2. A message that came with money is written down before anything else is done with it
 *    (`Outbox.handle`), and that record is removed only together with the write that settles it:
 *    the result owed, the refund owed, or the game's own record that keeps the money. A message
 *    left written down (a crash or an error while it was handled) is refunded.
 *
 * 3. A message a bot must send (a result, a payout, a refund) is written down before it is sent
 *    (`Outbox.owe`) and is sent until the wallet says it was DELIVERED. Value goes as that
 *    message's own payment. Each entry has one message ID, and the wallet never makes a second
 *    attempt for an ID, so a retry or a restart cannot pay twice. An attempt the relay ended is
 *    kept as FAILED, reported, and never counted as sent.
 */
import { createHash } from "crypto";
import type {
  BotContext,
  BotMessageContext,
  BotScheduleDefinition,
  BotStateStore,
  MessageItem,
  StampPaymentInfo,
} from "@frank/bot-framework";

export type Payment = {
  txHash: string;
  destinationAddress: string;
  valueWei: string;
};

type BatchOp =
  | { type: "put"; key: string; value: string }
  | { type: "del"; key: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether one reported transfer is on chain as described. `unknown`: not mined yet. */
async function landed(
  ctx: BotContext,
  payment: Payment,
  untilMs: number
): Promise<"yes" | "no" | "unknown"> {
  for (;;) {
    let receipt: { status?: number | null } | null = null;
    try {
      receipt = await ctx.provider.getTransactionReceipt(payment.txHash);
    } catch {
      // The node could not answer: not a statement about the transfer.
    }
    if (receipt) {
      if (receipt.status !== 1) return "no";
      const tx = await ctx.provider
        .getTransaction(payment.txHash)
        .catch(() => null);
      if (!tx) return "unknown";
      return tx.to?.toLowerCase() === payment.destinationAddress.toLowerCase() &&
        tx.value === BigInt(payment.valueWei)
        ? "yes"
        : "no";
    }
    if (Date.now() >= untilMs) return "unknown";
    await sleep(Math.min(1000, Math.max(0, untilMs - Date.now())));
  }
}

export interface Received {
  /** Wei confirmed on chain as paid to this bot with the message. */
  confirmedWei: bigint;
  /** The transfers `confirmedWei` is the sum of. */
  confirmed: Payment[];
  /** Transfers the message came with that are not mined yet. */
  unconfirmed: Payment[];
}

/** Claims are made one at a time, so one transfer is never credited to two messages. */
let claimTurn: Promise<unknown> = Promise.resolve();

/** Credits a confirmed transfer to `digest` unless another message already has it. */
function claim(ctx: BotContext, txHash: string, digest: string): Promise<boolean> {
  const run = async () => {
    const key = `received:${txHash.toLowerCase()}`;
    const creditedTo = await ctx.state.get(key);
    if (creditedTo === undefined) await ctx.state.put(key, digest);
    return creditedTo === undefined || creditedTo === digest;
  };
  const next = claimTurn.then(run, run);
  claimTurn = next.catch(() => undefined);
  return next;
}

async function confirm(
  digest: string,
  payments: readonly Payment[],
  ctx: BotContext,
  waitMs: number
): Promise<Received> {
  const untilMs = Date.now() + waitMs;
  let confirmedWei = 0n;
  const confirmed: Payment[] = [];
  const unconfirmed: Payment[] = [];
  const seen = new Set<string>();
  for (const payment of payments) {
    const hash = payment.txHash.toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);
    const state = await landed(ctx, payment, untilMs);
    if (state === "unknown") unconfirmed.push(payment);
    // Credited only once it is confirmed: naming somebody else's transfer, which does not pay
    // the address named with it, claims nothing and takes nothing from its real payer.
    if (state !== "yes" || !(await claim(ctx, hash, digest))) continue;
    confirmedWei += BigInt(payment.valueWei);
    confirmed.push(payment);
  }
  return { confirmedWei, confirmed, unconfirmed };
}

const payable = (payment: StampPaymentInfo): Payment => ({
  txHash: payment.txHash,
  destinationAddress: payment.destinationAddress,
  valueWei: payment.valueWei.toString(),
});

/** What `message` paid this bot, checked on chain; waits up to `waitMs` for transfers that are
 * not mined yet. Nothing the message's content says is read. */
export function confirmReceived(
  message: Pick<BotMessageContext, "payloadDigest" | "stampPayments">,
  ctx: BotContext,
  waitMs = 60_000
): Promise<Received> {
  return confirm(
    message.payloadDigest,
    (message.stampPayments ?? []).map(payable),
    ctx,
    waitMs
  );
}

export interface Owed {
  to: string;
  conversationId?: string;
  items: MessageItem[];
  /** Wei the message pays the recipient; "0" for a message that only has to arrive. */
  valueWei: string;
  /** Transfers not mined when this was written: each is added to the value once it lands, and
   * the message waits for all of them (or for `AWAIT_MS`). */
  awaits?: Payment[];
  sinceMs: number;
  /** The payload digest of the wallet's attempt for this message, once one is known to exist. */
  attempt?: string;
  /** How many times an operator has sent this again after an attempt failed: each is a new
   * message to the wallet. */
  tries?: number;
}

/** A message that came with money and has not been settled yet. */
interface Pending {
  peer: string;
  conversationId?: string;
  payments: Payment[];
  sinceMs: number;
}

interface Index {
  owed: string[];
  pending: string[];
  failed: string[];
}

/** How long an entry waits for transfers that are not mined before it goes without them. */
const AWAIT_MS = 60 * 60 * 1000;
const K = "outbox:";

function messageIdFor(botId: string, id: string, tries = 0): string {
  const hex = createHash("sha256")
    .update(`frank-bot-outbox:${botId}:${id}${tries ? `:${tries}` : ""}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

export class Outbox {
  private tail: Promise<unknown> = Promise.resolve();
  /** The host's long-lived context: an entry is sent with it, never with the context of the one
   * invocation that wrote it, so it can still be sent when that invocation is over. */
  private base?: BotContext;
  /** Messages being handled right now: not left over, so not refunded by the timer. */
  private readonly active = new Set<string>();

  constructor(private readonly botId: string) {}

  /** Sends what is still owed and refunds what was left unhandled: at start (a restart in the
   * middle of anything) and every few seconds after. */
  readonly schedule: BotScheduleDefinition = {
    id: "outbox",
    intervalMs: 10_000,
    runOnStartup: true,
    handler: async (ctx) => {
      this.base = ctx;
      await this.settle(ctx);
    },
  };

  private async index(state: BotStateStore): Promise<Index> {
    const raw = await state.get(`${K}index`);
    return raw
      ? (JSON.parse(raw) as Index)
      : { owed: [], pending: [], failed: [] };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /**
   * Handles one message that may have come with money. The message and its transfers are
   * written down first; then what it paid is confirmed on chain and `run` decides. `run` must
   * settle the message through `owe` or `keep` (naming the message); if it does not (it threw,
   * or the process died anywhere after the first write), the next `settle` returns what the
   * message is confirmed to have paid.
   */
  async handle<T>(
    message: BotMessageContext,
    ctx: BotContext,
    run: (received: Received) => Promise<T>,
    waitMs?: number
  ): Promise<T> {
    const digest = message.payloadDigest;
    const payments = (message.stampPayments ?? []).map(payable);
    this.active.add(digest);
    try {
      if (payments.length)
        await this.serial(async () => {
          const index = await this.index(ctx.state);
          if (index.pending.includes(digest)) return;
          const pending: Pending = {
            peer: message.peerAddress,
            conversationId: message.conversationId,
            payments,
            sinceMs: Date.now(),
          };
          await ctx.state.batch([
            {
              type: "put",
              key: `${K}pending:${digest}`,
              value: JSON.stringify(pending),
            },
            {
              type: "put",
              key: `${K}index`,
              value: JSON.stringify({
                ...index,
                pending: [...index.pending, digest],
              }),
            },
          ]);
        });
      return await run(await confirm(digest, payments, ctx, waitMs ?? 60_000));
    } finally {
      this.active.delete(digest);
    }
  }

  /** The writes that take `digest` off the list of unsettled messages. */
  private settled(index: Index, digest: string | undefined): BatchOp[] {
    if (digest === undefined || !index.pending.includes(digest)) return [];
    index.pending = index.pending.filter((other) => other !== digest);
    return [{ type: "del", key: `${K}pending:${digest}` }];
  }

  /** The game keeps the money of message `digest`: `writes` (the game's own record of it) and
   * the removal of the message from the unsettled list happen together or not at all. */
  keep(ctx: BotContext, digest: string, writes: BatchOp[] = []): Promise<void> {
    return this.serial(async () => {
      const index = await this.index(ctx.state);
      await ctx.state.batch([
        ...writes,
        ...this.settled(index, digest),
        { type: "put", key: `${K}index`, value: JSON.stringify(index) },
      ]);
    });
  }

  /** Writes down that the message `id` is owed. The same `id` again changes nothing, whether it
   * is owed, sent or failed. `settles`: the received message this answers, taken off the
   * unsettled list in the same write, together with any `writes` of the game's own. */
  owe(
    ctx: BotContext,
    id: string,
    entry: {
      to: string;
      conversationId?: string;
      items: MessageItem[];
      valueWei?: bigint;
      awaits?: Payment[];
    },
    settles?: { digest: string; writes?: BatchOp[] }
  ): Promise<void> {
    return this.serial(async () => {
      const index = await this.index(ctx.state);
      const ops: BatchOp[] = [
        ...(settles?.writes ?? []),
        ...this.settled(index, settles?.digest),
      ];
      if (!(await this.known(ctx, id))) {
        const owed: Owed = {
          to: entry.to,
          conversationId: entry.conversationId,
          items: entry.items,
          valueWei: (entry.valueWei ?? 0n).toString(),
          ...(entry.awaits?.length ? { awaits: entry.awaits } : {}),
          sinceMs: Date.now(),
        };
        index.owed.push(id);
        ops.push({
          type: "put",
          key: `${K}owed:${id}`,
          value: JSON.stringify(owed),
        });
      }
      await ctx.state.batch([
        ...ops,
        { type: "put", key: `${K}index`, value: JSON.stringify(index) },
      ]);
    });
  }

  private async known(ctx: BotContext, id: string): Promise<boolean> {
    for (const kind of ["owed", "sent", "failed"])
      if ((await ctx.state.get(`${K}${kind}:${id}`)) !== undefined) return true;
    return false;
  }

  /** Whether the message `id` was ever written down: owed, delivered or failed. */
  has(ctx: BotContext, id: string): Promise<boolean> {
    return this.known(ctx, id);
  }

  /** Whether the message `id` is known to have been delivered. */
  async sent(ctx: BotContext, id: string): Promise<boolean> {
    return (await ctx.state.get(`${K}sent:${id}`)) !== undefined;
  }

  /** The payload digest and paid value of the message `id`, once it is delivered. */
  async delivered(
    ctx: BotContext,
    id: string
  ): Promise<{ digest: string; stampWei: bigint } | undefined> {
    const raw = await ctx.state.get(`${K}sent:${id}`);
    if (raw === undefined) return undefined;
    const { digest, stampWei } = JSON.parse(raw) as {
      digest: string;
      stampWei: string;
    };
    return { digest, stampWei: BigInt(stampWei) };
  }

  /** Everything not finished, for an operator: messages owed, messages received with money and
   * not settled, and messages whose attempt the relay ended. */
  async list(ctx: BotContext): Promise<{
    owed: (Owed & { id: string })[];
    pending: (Pending & { digest: string })[];
    failed: (Owed & { id: string })[];
  }> {
    const index = await this.index(ctx.state);
    const read = async <T>(kind: string, name: string) =>
      JSON.parse((await ctx.state.get(`${K}${kind}:${name}`)) ?? "{}") as T;
    return {
      owed: await Promise.all(
        index.owed.map(async (id) => ({ ...(await read<Owed>("owed", id)), id }))
      ),
      pending: await Promise.all(
        index.pending.map(async (digest) => ({
          ...(await read<Pending>("pending", digest)),
          digest,
        }))
      ),
      failed: await Promise.all(
        index.failed.map(async (id) => ({
          ...(await read<Owed>("failed", id)),
          id,
        }))
      ),
    };
  }

  /** An operator's decision that the failed message `id` is to be sent again, as a new message
   * to the wallet. The attempt that failed did not deliver, but the wallet says only that the
   * relay ended it, not that its signed transfers can never land: check the chain first. */
  retry(ctx: BotContext, id: string): Promise<boolean> {
    return this.serial(async () => {
      const raw = await ctx.state.get(`${K}failed:${id}`);
      if (raw === undefined) return false;
      const { attempt: _attempt, ...owed } = JSON.parse(raw) as Owed;
      const index = await this.index(ctx.state);
      index.failed = index.failed.filter((other) => other !== id);
      index.owed.push(id);
      await ctx.state.batch([
        { type: "del", key: `${K}failed:${id}` },
        {
          type: "put",
          key: `${K}owed:${id}`,
          value: JSON.stringify({ ...owed, tries: (owed.tries ?? 0) + 1 }),
        },
        { type: "put", key: `${K}index`, value: JSON.stringify(index) },
      ]);
      return true;
    });
  }

  /** Refunds every message left unsettled, then sends every owed message that can go, oldest
   * first, one at a time. One that cannot go yet stays owed and does not hold up the others.
   * Never rejects. */
  settle(ctx: BotContext): Promise<void> {
    const sender = this.base ?? ctx;
    return this.recover(ctx)
      .catch((error) =>
        console.warn(
          `[${this.botId}] unsettled messages not refunded yet:`,
          error instanceof Error ? error.message : error
        )
      )
      .then(() =>
        this.serial(async () => {
          for (const id of (await this.index(ctx.state)).owed) {
            try {
              await this.send(sender, id);
            } catch (error) {
              console.warn(
                `[${this.botId}] owed message ${id} not sent yet; it stays owed:`,
                error instanceof Error ? error.message : error
              );
            }
          }
        })
      );
  }

  /** A message written down by `handle` and never settled: what it is confirmed to have paid
   * goes back, once. */
  private async recover(ctx: BotContext): Promise<void> {
    for (const digest of (await this.index(ctx.state)).pending) {
      if (this.active.has(digest)) continue;
      const raw = await ctx.state.get(`${K}pending:${digest}`);
      if (raw === undefined) {
        await this.keep(ctx, digest);
        continue;
      }
      const pending = JSON.parse(raw) as Pending;
      const received = await confirm(digest, pending.payments, ctx, 0);
      if (received.confirmedWei === 0n && received.unconfirmed.length === 0) {
        await this.keep(ctx, digest);
        continue;
      }
      console.warn(
        `[${this.botId}] message ${digest} from ${pending.peer} was not handled; what it paid is returned`
      );
      await this.owe(
        ctx,
        `refund:${digest}`,
        {
          to: pending.peer,
          conversationId: pending.conversationId,
          items: [
            {
              type: "text",
              text: "Your message could not be handled, and nothing was played or sold. What it paid is returned with this message.",
            },
          ],
          valueWei: received.confirmedWei,
          awaits: received.unconfirmed,
        },
        { digest }
      );
    }
  }

  private async finish(
    state: BotStateStore,
    id: string,
    to: "sent" | "failed",
    value: string
  ): Promise<void> {
    const index = await this.index(state);
    index.owed = index.owed.filter((other) => other !== id);
    if (to === "failed") index.failed.push(id);
    await state.batch([
      { type: "del", key: `${K}owed:${id}` },
      { type: "put", key: `${K}${to}:${id}`, value },
      { type: "put", key: `${K}index`, value: JSON.stringify(index) },
    ]);
  }

  private async send(ctx: BotContext, id: string): Promise<void> {
    const state = ctx.state;
    const raw = await state.get(`${K}owed:${id}`);
    if (raw === undefined) return;
    const owed = JSON.parse(raw) as Owed;
    let value = BigInt(owed.valueWei);
    const sent = (digest: string, stampWei: bigint) =>
      this.finish(
        state,
        id,
        "sent",
        JSON.stringify({ digest, stampWei: stampWei.toString() })
      );

    if (!owed.attempt) {
      if (owed.awaits?.length) {
        const expired = Date.now() - owed.sinceMs >= AWAIT_MS;
        const still: Payment[] = [];
        for (const payment of owed.awaits) {
          const state = await landed(ctx, payment, 0);
          if (state === "unknown" && !expired) return;
          if (state === "yes") still.push(payment);
        }
        // Fixed before the first send: the value of a message never changes between attempts.
        for (const payment of still) value += BigInt(payment.valueWei);
        owed.valueWei = value.toString();
        delete owed.awaits;
        await state.put(`${K}owed:${id}`, JSON.stringify(owed));
      }
      try {
        const result = await ctx.sendMessage(
          owed.to,
          owed.items,
          owed.conversationId,
          {
            ...(value > 0n ? { stampValueWei: value } : {}),
            messageId: messageIdFor(this.botId, id, owed.tries),
          }
        );
        return sent(
          result?.payloadDigest ?? "",
          value > 0n ? value : result?.stampValueWei ?? 0n
        );
      } catch (error) {
        // The wallet already holds an attempt for this message ID. That is not delivery: the
        // attempt may still be on its way, or the relay may have ended it.
        if (
          (error as { name?: string })?.name !==
            "DirectMessageAlreadyAttemptedError" ||
          !(error as { payloadDigest?: string }).payloadDigest
        )
          throw error;
        owed.attempt = (error as { payloadDigest: string }).payloadDigest;
        await state.put(`${K}owed:${id}`, JSON.stringify(owed));
      }
    }

    const status = await ctx.attemptStatus(owed.attempt);
    if (status === "delivered") return sent(owed.attempt, value);
    if (status !== "dead") return; // Still the wallet's to deliver; asked again next time.
    console.error(
      `[${this.botId}] FAILED: message ${id} to ${owed.to} carrying ${value} wei was ended by the relay and was NOT delivered (attempt ${owed.attempt}). It is not counted as sent. See the outbox admin tool.`
    );
    await this.finish(state, id, "failed", JSON.stringify(owed));
  }
}

/** A message that did not pay for what it asked: says so, and returns what it did pay. The reply
 * is owed like any payout, so the refund is neither forgotten nor sent twice. */
export async function refuse(
  outbox: Outbox,
  message: BotMessageContext,
  ctx: BotContext,
  received: Received,
  text: string,
  items: MessageItem[] = []
): Promise<void> {
  const pending = received.unconfirmed.length > 0;
  const back =
    received.confirmedWei > 0n || pending
      ? pending
        ? " Your payment is not confirmed on chain yet; it is returned once it is."
        : " What you paid is returned with this message."
      : "";
  await outbox.owe(
    ctx,
    `refund:${message.payloadDigest}`,
    {
      to: message.peerAddress,
      conversationId: message.conversationId,
      items: [...items, { type: "text", text: text + back }],
      valueWei: received.confirmedWei,
      awaits: received.unconfirmed,
    },
    { digest: message.payloadDigest }
  );
  await outbox.settle(ctx);
}
