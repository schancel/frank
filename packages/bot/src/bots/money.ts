/**
 * The two money rules every game and shop bot follows.
 *
 * 1. `confirmReceived`: what a message paid is what is on chain. The wallet reports the transfers
 *    that came with a message and that pay this bot's own stamp key; this looks each one up and
 *    counts it only once it is mined, succeeded, and is the transfer the wallet described. A
 *    transfer is credited to one message only.
 *
 * 2. `Outbox`: a message a bot must send (a result, a payout, a refund) is written down before it
 *    is sent and is sent until it has gone. Value goes as that message's own payment, through the
 *    wallet's message path, which records the signed transfers before handing them over. Each
 *    entry has one message ID for good, and the wallet never makes a second attempt for an ID, so
 *    a retry or a restart cannot pay twice. Entries are sent one at a time.
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

export type Payment = { txHash: string; destinationAddress: string; valueWei: string };

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

/** What `message` paid this bot, checked on chain; waits up to `waitMs` for transfers that are
 * not mined yet. Nothing the message's content says is read. */
export async function confirmReceived(
  message: Pick<BotMessageContext, "payloadDigest" | "stampPayments">,
  ctx: BotContext,
  waitMs = 60_000
): Promise<Received> {
  const untilMs = Date.now() + waitMs;
  let confirmedWei = 0n;
  const confirmed: Payment[] = [];
  const unconfirmed: Payment[] = [];
  const seen = new Set<string>();
  for (const reported of message.stampPayments ?? []) {
    const payment = payable(reported);
    const key = `received:${payment.txHash.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // One transfer pays for one message: the first that came with it.
    const creditedTo = await ctx.state.get(key);
    if (creditedTo !== undefined && creditedTo !== message.payloadDigest)
      continue;
    await ctx.state.put(key, message.payloadDigest);
    const state = await landed(ctx, payment, untilMs);
    if (state === "yes") {
      confirmedWei += BigInt(payment.valueWei);
      confirmed.push(payment);
    } else if (state === "unknown") unconfirmed.push(payment);
  }
  return { confirmedWei, confirmed, unconfirmed };
}

function payable(payment: StampPaymentInfo): Payment {
  return {
    txHash: payment.txHash,
    destinationAddress: payment.destinationAddress,
    valueWei: payment.valueWei.toString(),
  };
}

interface Owed {
  to: string;
  conversationId?: string;
  items: MessageItem[];
  /** Wei the message pays the recipient; "0" for a message that only has to arrive. */
  valueWei: string;
  /** Transfers not mined when this was written: each is added to the value once it lands, and
   * the message waits for all of them (or for `AWAIT_MS`). */
  awaits?: Payment[];
  sinceMs: number;
}

/** How long an entry waits for transfers that are not mined before it goes without them. */
const AWAIT_MS = 60 * 60 * 1000;

function messageIdFor(botId: string, id: string): string {
  const hex = createHash("sha256")
    .update(`frank-bot-outbox:${botId}:${id}`)
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

  constructor(private readonly botId: string) {}

  /** Sends what is still owed: at start (a restart mid-payout) and every few seconds after. */
  readonly schedule: BotScheduleDefinition = {
    id: "outbox",
    intervalMs: 10_000,
    runOnStartup: true,
    handler: async (ctx) => {
      this.base = ctx;
      await this.settle(ctx);
    },
  };

  private store(ctx: BotContext): BotStateStore {
    return ctx.state.sublevel("outbox");
  }

  private async ids(store: BotStateStore): Promise<string[]> {
    const raw = await store.get("index");
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Writes down that the message `id` is owed. The same `id` again changes nothing, whether it
   * is still owed or already sent. */
  owe(
    ctx: BotContext,
    id: string,
    entry: {
      to: string;
      conversationId?: string;
      items: MessageItem[];
      valueWei?: bigint;
      awaits?: Payment[];
    }
  ): Promise<void> {
    return this.serial(async () => {
      const store = this.store(ctx);
      if (
        (await store.get(`owed:${id}`)) !== undefined ||
        (await store.get(`sent:${id}`)) !== undefined
      )
        return;
      const owed: Owed = {
        to: entry.to,
        conversationId: entry.conversationId,
        items: entry.items,
        valueWei: (entry.valueWei ?? 0n).toString(),
        ...(entry.awaits?.length ? { awaits: entry.awaits } : {}),
        sinceMs: Date.now(),
      };
      await store.batch([
        { type: "put", key: `owed:${id}`, value: JSON.stringify(owed) },
        {
          type: "put",
          key: "index",
          value: JSON.stringify([...(await this.ids(store)), id]),
        },
      ]);
    });
  }

  /** Whether the message `id` was ever written down, sent or not. */
  async has(ctx: BotContext, id: string): Promise<boolean> {
    const store = this.store(ctx);
    return (
      (await store.get(`owed:${id}`)) !== undefined ||
      (await store.get(`sent:${id}`)) !== undefined
    );
  }

  /** Whether the message `id` has gone out. */
  async sent(ctx: BotContext, id: string): Promise<boolean> {
    return (await this.store(ctx).get(`sent:${id}`)) !== undefined;
  }

  /** Sends every owed message that can go, oldest first, one at a time. One that cannot go yet
   * stays owed and does not hold up the others. Never rejects. */
  settle(ctx: BotContext): Promise<void> {
    const sender = this.base ?? ctx;
    return this.serial(async () => {
      const store = this.store(ctx);
      for (const id of await this.ids(store)) {
        try {
          await this.send(sender, store, id);
        } catch (error) {
          console.warn(
            `[${this.botId}] owed message ${id} not sent yet; it stays owed:`,
            error instanceof Error ? error.message : error
          );
        }
      }
    });
  }

  private async send(
    ctx: BotContext,
    store: BotStateStore,
    id: string
  ): Promise<void> {
    const raw = await store.get(`owed:${id}`);
    const done = async (digest: string) =>
      store.batch([
        { type: "del", key: `owed:${id}` },
        { type: "put", key: `sent:${id}`, value: digest },
        {
          type: "put",
          key: "index",
          value: JSON.stringify(
            (await this.ids(store)).filter((other) => other !== id)
          ),
        },
      ]);
    if (raw === undefined) return done("");
    const owed = JSON.parse(raw) as Owed;
    let value = BigInt(owed.valueWei);
    if (owed.awaits?.length) {
      const expired = Date.now() - owed.sinceMs >= AWAIT_MS;
      for (const payment of owed.awaits) {
        const state = await landed(ctx, payment, 0);
        if (state === "unknown" && !expired) return;
        if (state === "yes") value += BigInt(payment.valueWei);
      }
    }
    try {
      const result = await ctx.sendMessage(
        owed.to,
        owed.items,
        owed.conversationId,
        {
          ...(value > 0n ? { stampValueWei: value } : {}),
          messageId: messageIdFor(this.botId, id),
        }
      );
      await done(result?.payloadDigest ?? "");
    } catch (error) {
      // The wallet already holds an attempt for this message ID: it is the wallet's to deliver,
      // and nothing may be sent for it again.
      if ((error as { name?: string })?.name !== "DirectMessageAlreadyAttemptedError")
        throw error;
      await done((error as { payloadDigest?: string }).payloadDigest ?? "");
    }
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
  await outbox.owe(ctx, `refund:${message.payloadDigest}`, {
    to: message.peerAddress,
    conversationId: message.conversationId,
    items: [...items, { type: "text", text: text + back }],
    valueWei: received.confirmedWei,
    awaits: received.unconfirmed,
  });
  await outbox.settle(ctx);
}
