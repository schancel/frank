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
import { createHash } from "crypto";
import { computeAddress, getAddress } from "ethers";
import { canonicalNetworkDescriptor } from "@frank/cashweb/relay/canonical-dm-transport";
import { generateAvatarPng } from "../../bot-directory";
import {
  createQwenReplyGenerator,
  qwenBotConfigFromEnv,
  type QwenBotConfig,
  type QwenReplyGenerator,
} from "../../qwen-reply";

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
      typeof conversationId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(conversationId)
    )
      return holdHistory();
    return Object.freeze([
      canonicalNetworkDescriptor(networkTag).network,
      local,
      peer,
      conversationId,
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

  constructor(options?: {
    generator?: QwenReplyGenerator;
    config?: Partial<QwenBotConfig>;
  }) {
    if (options?.generator) {
      this.replyGenerator = options.generator;
    } else {
      let cfg: QwenBotConfig;
      try {
        cfg = qwenBotConfigFromEnv(process.env);
      } catch {
        // Fallback to stub mode if environment variables are not set
        cfg = {
          mode: "stub",
          model: "qwen-stub",
          maxReplies: Infinity,
          idleTimeoutMs: 0,
        };
      }
      if (options?.config) {
        cfg = { ...cfg, ...options.config };
      }
      this.replyGenerator = createQwenReplyGenerator(cfg);
    }
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

    let content: string;
    try {
      const res = await this.replyGenerator.reply([
        {
          role: "user",
          content:
            "Generate a brief, engaging 2-3 sentence daily tech and crypto digest for Monad users.",
        },
      ]);
      content = res.content;
    } catch {
      content =
        "Monad Daily Digest: Gas is nominal, network finality is sub-second, and the ecosystem is humming. Have a productive day!";
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

  async onMessage(
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<PreparedReply | void> {
    const scope = historyScope(msgCtx, ctx);
    const state = ctx.state;
    const reply = msgCtx.reply;
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
    if (subReply) {
      await reply(subReply);
      return;
    }
    if (!userText) {
      await reply([
        { type: "text", text: "Hello! I am Qwen. How can I help you today?" },
      ]);
      return;
    }

    const stored = await state.get(historyKey);
    const history = readHistory(stored, scope);
    const promptHistory: HistoryMessage[] = [
      ...history,
      { role: "user", content: userText },
    ];
    // The generator never owns the prompt snapshot from which stored turns are built.
    const result = await this.replyGenerator.reply(
      promptHistory.map((item) => ({ ...item }))
    );
    const content = boundedText(result?.content, MAX_HISTORY_CONTENT_BYTES);
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
    // The host stages the answer and these exact bounded bytes before the reply is first sent,
    // and writes them at the history key only when that reply is delivered, provided the key
    // still holds what was read above. Qwen does not write the key itself.
    return {
      kind: "prepared-reply",
      text: content,
      commit: {
        key: historyKey,
        expectedSha256:
          stored === undefined
            ? null
            : createHash("sha256").update(stored, "utf8").digest("hex"),
        value: boundedText(JSON.stringify(completed), MAX_HISTORY_RECORD_BYTES),
      },
    };
  }
}
