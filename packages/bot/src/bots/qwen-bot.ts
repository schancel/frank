import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
  PreparedReply,
} from "@frank/bot-framework";
import type { MessageItem } from "@frank/cashweb/types/messages";
import {
  ACCOUNT_TYPE_BOT,
  BOT_ROLE_ASSISTANT,
  MAX_TEXT_STRING_BYTES,
  MAX_DIRECT_MESSAGE_FRAME_BYTES,
} from "@frank/codec";
import { computeAddress, getAddress } from "ethers";
import { canonicalNetworkDescriptor } from "@frank/cashweb/relay/canonical-dm-transport";
import { generateAvatarPng } from "../../bot-directory";
import {
  createQwenReplyGenerator,
  qwenBotConfigFromEnv,
  DEFAULT_MODEL_TRIES,
  safeDisplayName,
  type QwenBotConfig,
  type QwenReplyGenerator,
} from "../../qwen-reply";

/** What the user is told when the model gave no answer after every try. */
export const MODEL_FAILED_TEXT =
  "Sorry, I couldn't answer that just now. Please send it again.";
// Wait before the second model call of a message; doubled before each further one.
const MODEL_RETRY_DELAY_MS = 1_000;
/** The history scope of the default thread with a peer: a message with no conversation ID. */
const DEFAULT_THREAD = "default";

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CONTENT_BYTES = MAX_TEXT_STRING_BYTES;
// A local storage/prompt budget; history itself is not a direct-message frame.
const MAX_HISTORY_RECORD_BYTES = MAX_DIRECT_MESSAGE_FRAME_BYTES;
type HistoryScope = readonly [string, string, string, string];
type HistoryMessage = { role: "user" | "assistant"; content: string };
interface HistoryRecord {
  version: 1;
  scope: HistoryScope;
  messages: HistoryMessage[];
}
function holdHistory(): never {
  throw new Error("Qwen history admission held; preserve original state");
}
function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length > maxBytes)
    return holdHistory();
  // Buffer.byteLength replaces lone surrogates. Reject them rather than changing authored text.
  for (let i = 0; i < value.length; i++) {
    const cp = value.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = value.charCodeAt(++i);
      if (!(lo >= 0xdc00 && lo <= 0xdfff)) return holdHistory();
    } else if (cp >= 0xdc00 && cp <= 0xdfff) return holdHistory();
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) return holdHistory();
  return value;
}
function historyScope(msg: BotMessageContext, ctx: BotContext): HistoryScope {
  const { subject: local, address: localAddress, networkTag } = ctx;
  const { peerSubject: peer, peerAddress, conversationId } = msg;
  const validSubject = (subject: string, address: string): boolean =>
    typeof subject === "string" &&
    /^(02|03)[0-9a-f]{64}$/.test(subject) &&
    computeAddress("0x" + subject).toLowerCase() ===
      getAddress(address).toLowerCase();
  try {
    if (
      !validSubject(local, localAddress) ||
      !validSubject(peer, peerAddress) ||
      local === peer ||
      (conversationId !== undefined &&
        (typeof conversationId !== "string" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
            conversationId
          )))
    )
      return holdHistory();
    // One history per conversation: an explicit conversation by its ID, the default thread
    // (no ID on the message) by the peer alone.
    return Object.freeze([
      canonicalNetworkDescriptor(networkTag).network,
      local,
      peer,
      conversationId ?? DEFAULT_THREAD,
    ] as const);
  } catch {
    return holdHistory();
  }
}
function recordObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !Object.keys(value).every((key) => keys.includes(key))
  )
    return holdHistory();
  return value as Record<string, unknown>;
}
function validateHistory(value: unknown, scope: HistoryScope): HistoryRecord {
  const row = recordObject(value, ["version", "scope", "messages"]);
  if (
    row.version !== 1 ||
    !Array.isArray(row.scope) ||
    row.scope.length !== 4 ||
    !row.scope.every((part, i) => part === scope[i]) ||
    !Array.isArray(row.messages) ||
    row.messages.length > MAX_HISTORY_MESSAGES ||
    row.messages.length % 2 !== 0
  )
    return holdHistory();
  const messages = row.messages.map(
    (entry: unknown, i: number): HistoryMessage => {
      const item = recordObject(entry, ["role", "content"]);
      const role = i % 2 === 0 ? "user" : "assistant";
      if (item.role !== role) return holdHistory();
      return {
        role,
        content: boundedText(item.content, MAX_HISTORY_CONTENT_BYTES),
      };
    }
  );
  return { version: 1, scope, messages };
}
function readHistory(
  raw: string | undefined,
  scope: HistoryScope
): HistoryMessage[] {
  if (raw === undefined) return [];
  boundedText(raw, MAX_HISTORY_RECORD_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return holdHistory();
  }
  return validateHistory(value, scope).messages;
}

export class QwenBot implements FrankBotDefinition {
  readonly id = "qwen";
  readonly label = "Qwen";
  readonly defaultIdentityPath =
    process.env.QWEN_BOT_IDENTITY_JSON ?? "/tmp/qwen-bot-identity.json";

  private readonly replyGenerator: QwenReplyGenerator;
  private readonly modelTries: number;
  private readonly retryDelayMs: number;
  /** Display names already looked up, by peer address. */
  private readonly names = new Map<string, string>();

  /** Without a `generator`, the model is configured from the environment, and a missing
   * variable is an error here, at startup, naming it. The offline stub answers only when
   * `QWEN_BOT_MODE=stub` (or `config.mode`) asks for it; it is never a fallback. */
  constructor(options?: {
    generator?: QwenReplyGenerator;
    config?: Partial<QwenBotConfig>;
    /** Model calls for one message before the failure reply. */
    modelTries?: number;
    retryDelayMs?: number;
  }) {
    this.retryDelayMs = options?.retryDelayMs ?? MODEL_RETRY_DELAY_MS;
    if (options?.generator) {
      this.replyGenerator = options.generator;
      this.modelTries = options.modelTries ?? DEFAULT_MODEL_TRIES;
    } else {
      const cfg = {
        ...qwenBotConfigFromEnv({
          ...process.env,
          ...(options?.config?.mode
            ? { QWEN_BOT_MODE: options.config.mode }
            : {}),
        }),
        ...options?.config,
      };
      this.replyGenerator = createQwenReplyGenerator(cfg);
      this.modelTries = options?.modelTries ?? cfg.modelTries;
      console.log(`[qwen] ${this.replyGenerator.describe()}`);
    }
  }

  /** The model's answer to `history`, or undefined when every try failed. A failed call sent
   * nothing and paid nothing, so it is simply made again, a bounded number of times. */
  private async answer(
    history: HistoryMessage[],
    stopping: AbortSignal | undefined,
    userName: string | undefined
  ): Promise<string | undefined> {
    for (let attempt = 1; attempt <= this.modelTries; attempt++) {
      if (stopping?.aborted) break;
      try {
        // The generator never owns the prompt snapshot from which stored turns are built.
        const result = await this.replyGenerator.reply(
          history.map((item) => ({ ...item })),
          { signal: stopping, userName }
        );
        const content = boundedText(result?.content, MAX_HISTORY_CONTENT_BYTES);
        if (content.trim()) return content;
        throw new Error("the model returned an empty answer");
      } catch (error) {
        // The message only: a provider's response body is never logged.
        console.warn(
          `[qwen] Model call ${attempt} of ${this.modelTries} failed:`,
          error instanceof Error ? error.message : "unknown error"
        );
        if (attempt < this.modelTries && !stopping?.aborted)
          await new Promise((resolve) =>
            setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1))
          );
      }
    }
    return undefined;
  }

  readonly schedules = [
    {
      id: "daily-newsletter",
      cron: process.env.QWEN_NEWSLETTER_CRON ?? "0 9 * * *",
      intervalMs: process.env.QWEN_NEWSLETTER_INTERVAL_MS
        ? parseInt(process.env.QWEN_NEWSLETTER_INTERVAL_MS, 10)
        : undefined,
      runOnStartup: process.env.QWEN_NEWSLETTER_STARTUP === "1",
      handler: async (ctx: BotContext) => {
        await this.sendDailyNewsletter(ctx);
      },
    },
  ];

  getProfile(): BotProfile {
    return {
      name: "Qwen",
      bio: "Automated Qwen-powered assistant. Ask it anything or send /subscribe for daily updates.",
      avatarPng: generateAvatarPng("qwen", [110, 90, 220]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_ASSISTANT,
    };
  }

  async sendDailyNewsletter(
    ctx: BotContext
  ): Promise<{ sent: number; failed: number }> {
    const subscribers = await ctx.subscriptions.listSubscribers("newsletter");
    if (subscribers.length === 0) {
      console.log(
        "[qwen] No subscribers for daily newsletter, skipping broadcast"
      );
      return { sent: 0, failed: 0 };
    }

    console.log(
      `[qwen] Broadcasting daily newsletter to ${subscribers.length} subscriber(s)`
    );

    // The digest is whatever the model writes today. If the model cannot be reached nothing
    // is sent: there is no canned text standing in for it.
    let content: string;
    try {
      const res = await this.replyGenerator.reply(
        [
          {
            role: "user",
            content:
              "Generate a brief, engaging 2-3 sentence daily tech and crypto digest for Monad users.",
          },
        ],
        { signal: ctx.stopping }
      );
      content = boundedText(res?.content, MAX_HISTORY_CONTENT_BYTES).trim();
      if (!content) throw new Error("the model returned an empty digest");
    } catch (error) {
      console.error(
        "[qwen] Daily digest not sent: the model could not generate it:",
        error instanceof Error ? error.message : "unknown error"
      );
      return { sent: 0, failed: 0 };
    }

    const items: MessageItem[] = [
      {
        type: "text",
        text: `📰 **Qwen Daily Digest**\n\n${content}\n\n_Send /unsubscribe to stop receiving daily updates._`,
      },
    ];

    return ctx.subscriptions.broadcast(items, "newsletter");
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(`[qwen] Proactively welcoming new user ${user.address}`);
    try {
      await ctx.sendMessage(user.address, [
        {
          type: "text",
          text: "Hello! I am Qwen, an AI assistant on the Frank network. Send me any message to chat, or send /subscribe to receive my daily news updates!",
        },
      ]);
    } catch (err) {
      console.warn(`[qwen] Failed to welcome new user ${user.address}:`, err);
    }
  }

  /** The name the person publishes in their profile, made safe to quote. The model is given it
   * as a note in the person's own message, never in the system prompt. Looked up once per peer;
   * a profile that cannot be read just means the model is not told a name. */
  private async displayName(
    peerAddress: string,
    ctx: BotContext
  ): Promise<string | undefined> {
    const known = this.names.get(peerAddress);
    if (known) return known;
    try {
      const name = safeDisplayName(
        (await ctx.lookupPeer(peerAddress))?.displayName
      );
      if (name) this.names.set(peerAddress, name);
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  /** Every message ends in one stored reply the host delivers: a subscription answer, a
   * greeting, the model's answer, or a plain failure text when the model gave none. */
  async onMessage(
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<PreparedReply> {
    const text = (value: string): PreparedReply => ({
      kind: "prepared-reply",
      text: value,
    });
    const scope = historyScope(msgCtx, ctx);
    const state = ctx.state;
    const items = structuredClone(msgCtx.items);
    const historyKey = "qwen-history:v1:" + JSON.stringify(scope);
    const userText = boundedText(
      items
        .filter(
          (item): item is Extract<MessageItem, { type: "text" }> =>
            item.type === "text"
        )
        .map((item) => item.text)
        .join("\n"),
      MAX_HISTORY_CONTENT_BYTES
    ).trim();

    const subReply = await ctx.subscriptions.handleSubscriptionCommand(
      items,
      msgCtx.peerAddress,
      "newsletter"
    );
    if (subReply)
      return text(
        subReply
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .join("\n")
      );
    if (!userText) return text("Hello! I am Qwen. How can I help you today?");

    const history = readHistory(await state.get(historyKey), scope);
    const promptHistory: HistoryMessage[] = [
      ...history,
      { role: "user", content: userText },
    ];
    const content = await this.answer(
      promptHistory,
      ctx.stopping,
      await this.displayName(msgCtx.peerAddress, ctx)
    );
    // Nothing is remembered of a turn the model did not answer: the user sends it again.
    if (content === undefined) return text(MODEL_FAILED_TEXT);
    const completed = validateHistory(
      {
        version: 1,
        scope,
        messages: [...promptHistory, { role: "assistant", content }].slice(
          -MAX_HISTORY_MESSAGES
        ),
      },
      scope
    );
    // The turn is remembered before its reply is handed to the host. The host stores that reply
    // and delivers it, however many polls or restarts that takes, and does not start this
    // conversation's next message until it has, so the next prompt reads this turn.
    await state.put(
      historyKey,
      boundedText(JSON.stringify(completed), MAX_HISTORY_RECORD_BYTES)
    );
    return text(content);
  }
}
