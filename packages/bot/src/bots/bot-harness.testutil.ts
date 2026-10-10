/**
 * What the bot unit tests stand a bot on: an in-memory state store, a wallet that sends messages
 * the way the real one does where it matters to a bot (one attempt per message ID, for good), and
 * a chain that only knows the transfers a test put on it. Narrow seams for unit tests; nothing
 * here is evidence about a real relay or chain.
 */
import type {
  BotContext,
  BotMessageContext,
  BotSendOptions,
  BotStateStore,
  MessageItem,
  StampPaymentInfo,
} from "@frank/bot-framework";

export function memoryState(
  data = new Map<string, string>(),
  prefix = ""
): BotStateStore {
  return {
    get: async (key) => data.get(prefix + key),
    put: async (key, value) => void data.set(prefix + key, value),
    del: async (key) => void data.delete(prefix + key),
    batch: async (ops) => {
      for (const op of ops)
        if (op.type === "put") data.set(prefix + op.key, op.value);
        else data.delete(prefix + op.key);
    },
    sublevel: (name) => memoryState(data, `${prefix}${name}/`),
  };
}

export interface Sent {
  to: string;
  items: MessageItem[];
  conversationId?: string;
  valueWei: bigint;
  messageId?: string;
  /** The payload digest the wallet gave the message. */
  digest: string;
  /** True when the bot named no stamp, so the host would put its own (paid) stamp on it. A
   * bot's own messages must never be: they carry a payout, a refund, or nothing. */
  hostStamp: boolean;
}

export const BOT = "0x" + "b0".repeat(20);
export const PLAYER = "0x" + "a1".repeat(20);
let counter = 0;
const hash = () => "0x" + (++counter).toString(16).padStart(64, "0");

export function harness(data = new Map<string, string>()) {
  /** Messages the wallet delivered, in order. */
  const sent: Sent[] = [];
  /** message ID -> the wallet's own record of its attempt, which outlives a bot restart. */
  const attempts = new Map<
    string,
    { digest: string; status: "live" | "delivered" | "dead"; message: Sent }
  >();
  const chain = new Map<
    string,
    { to: string; value: bigint; status: number; mined: boolean }
  >();
  /** What the wallet does with the next sends. `refuse`: rejects before any attempt exists.
   * `live`: makes its attempt, then rejects with the message still on its way. `dead`: makes
   * its attempt, and the relay ends it. */
  /** What the chain charges to move a stamp, as the wallet reports it. Zero: nothing is dust. */
  let floorWei = 0n;
  let mode: "deliver" | "refuse" | "live" | "dead" = "deliver";
  let refusal = new Error("refused");

  const sendMessage = async (
    to: string,
    items: MessageItem[],
    conversationId?: string,
    options?: BotSendOptions
  ) => {
    const id = options?.messageId;
    const earlier = id ? attempts.get(id) : undefined;
    if (id && earlier)
      throw Object.assign(new Error("already attempted"), {
        name: "DirectMessageAlreadyAttemptedError",
        payloadDigest: earlier.digest,
      });
    if (mode === "refuse") throw refusal;
    const payloadDigest = hash().slice(2);
    const message: Sent = {
      to,
      items: structuredClone(items),
      conversationId,
      valueWei: options?.stampValueWei ?? 0n,
      messageId: id,
      digest: payloadDigest,
      hostStamp: options?.stampValueWei === undefined,
    };
    if (mode !== "deliver") {
      if (id) attempts.set(id, { digest: payloadDigest, status: mode, message });
      throw new Error(
        mode === "live" ? "payment pending" : "the relay ended this payment set"
      );
    }
    if (id)
      attempts.set(id, { digest: payloadDigest, status: "delivered", message });
    sent.push(message);
    return { payloadDigest, stampValueWei: options?.stampValueWei ?? 0n } as any;
  };

  const ctx = {
    botId: "test",
    address: BOT,
    subject: "02" + "b0".repeat(32),
    relayBaseUrl: "http://relay.invalid",
    networkTag: "MONT",
    provider: {
      getTransactionReceipt: async (txHash: string) => {
        const tx = chain.get(txHash);
        return tx?.mined ? { status: tx.status } : null;
      },
      getTransaction: async (txHash: string) => {
        const tx = chain.get(txHash);
        return tx ? { to: tx.to, value: tx.value } : null;
      },
    },
    state: memoryState(data),
    lookupPeer: async () => undefined,
    sendMessage,
    sendDirectMessage: sendMessage,
    onNewUserRegistered: () => undefined,
    sendTransfer: async () => {
      throw new Error("bots pay through messages, not bare transfers");
    },
    sendTransaction: async () => {
      throw new Error("bots pay through messages, not bare transactions");
    },
    buildAndSignTransfer: async () => {
      throw new Error("bots pay through messages, not bare transfers");
    },
    waitForReceipt: async () => null,
    getBalance: async () => 10n ** 18n,
    minimumStampWei: async () => floorWei,
    attemptStatus: async (digest: string) =>
      [...attempts.values()].find((attempt) => attempt.digest === digest)
        ?.status ?? "unknown",
  } as unknown as BotContext;

  return {
    ctx,
    data,
    sent,
    chain,
    /** Makes every send be refused before any attempt exists, with `error`, until called with
     * nothing. */
    failSends(error?: Error) {
      mode = error ? "refuse" : "deliver";
      if (error) refusal = error;
    },
    /** Sets the chain's fee floor for a stamp, as `BotContext.minimumStampWei` reports it. */
    feeFloor(wei: bigint) {
      floorWei = wei;
    },
    /** How the wallet treats sends from now on; see `mode` above. */
    wallet(next: "deliver" | "refuse" | "live" | "dead") {
      mode = next;
    },
    /** The wallet's attempts still on their way arrive. */
    deliverLive() {
      for (const attempt of attempts.values())
        if (attempt.status === "live") {
          attempt.status = "delivered";
          sent.push(attempt.message);
        }
    },
    /** A transfer to this bot. `mined: false`: broadcast but not in a block. */
    pay(
      valueWei: bigint,
      options: { status?: number; mined?: boolean } = {}
    ): StampPaymentInfo {
      const txHash = hash();
      const destinationAddress = "0x" + "5e".repeat(20);
      chain.set(txHash, {
        to: destinationAddress,
        value: valueWei,
        status: options.status ?? 1,
        mined: options.mined ?? true,
      });
      return { txHash, destinationAddress, valueWei };
    },
    /** A message from `PLAYER` carrying `payments`. Replies are recorded like any other send. */
    message(
      items: MessageItem[],
      payments: StampPaymentInfo[] = [],
      peerAddress = PLAYER
    ): BotMessageContext {
      return {
        conversationId: "00000000-0000-4000-8000-000000000001",
        peerAddress,
        peerSubject: "02" + "a1".repeat(32),
        timestampMs: Date.now(),
        payloadDigest: hash().slice(2),
        items,
        stampValueWei: payments.reduce((sum, p) => sum + p.valueWei, 0n),
        stampPayments: payments,
        reply: (replyItems, options) =>
          sendMessage(
            peerAddress,
            replyItems,
            "00000000-0000-4000-8000-000000000001",
            options
          ),
      };
    },
    /** Wei the bot has paid out, over every message it sent. */
    paidOut: () => sent.reduce((sum, message) => sum + message.valueWei, 0n),
    item<T extends MessageItem["type"]>(
      type: T,
      from: Sent | undefined = sent[sent.length - 1]
    ): Extract<MessageItem, { type: T }> {
      return from?.items.find((item) => item.type === type) as Extract<
        MessageItem,
        { type: T }
      >;
    },
  };
}
