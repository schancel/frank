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
}

export const BOT = "0x" + "b0".repeat(20);
export const PLAYER = "0x" + "a1".repeat(20);
let counter = 0;
const hash = () => "0x" + (++counter).toString(16).padStart(64, "0");

export function harness(data = new Map<string, string>()) {
  const sent: Sent[] = [];
  /** message ID -> digest: the wallet's own record of attempts, which outlives a bot restart. */
  const attempts = new Map<string, string>();
  const chain = new Map<
    string,
    { to: string; value: bigint; status: number; mined: boolean }
  >();
  let sendFails: Error | undefined;

  const sendMessage = async (
    to: string,
    items: MessageItem[],
    conversationId?: string,
    options?: BotSendOptions
  ) => {
    if (sendFails) throw sendFails;
    const id = options?.messageId;
    if (id && attempts.has(id))
      throw Object.assign(new Error("already attempted"), {
        name: "DirectMessageAlreadyAttemptedError",
        payloadDigest: attempts.get(id),
      });
    const payloadDigest = hash().slice(2);
    if (id) attempts.set(id, payloadDigest);
    sent.push({
      to,
      items: structuredClone(items),
      conversationId,
      valueWei: options?.stampValueWei ?? 0n,
      messageId: id,
    });
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
  } as unknown as BotContext;

  return {
    ctx,
    data,
    sent,
    chain,
    /** Makes every send fail with `error` until called with nothing. */
    failSends(error?: Error) {
      sendFails = error;
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
