import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { generateAvatarPng } from "../../bot-directory";
import {
  createQwenReplyGenerator,
  qwenBotConfigFromEnv,
  stubReply,
  type QwenBotConfig,
  type QwenReplyGenerator,
} from "../../qwen-reply";
import type { QwenChatMessage } from "../../qwen-client";

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

  getProfile(): BotProfile {
    return {
      name: "Qwen",
      bio: "Automated Qwen-powered assistant. Ask it anything.",
      avatarPng: generateAvatarPng("qwen", [110, 90, 220]),
      bot: true,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(`[qwen] Proactively welcoming new user ${user.address}`);
    try {
      await ctx.sendMessage(user.address, [
        {
          type: "text",
          text: "Hello! I am Qwen, an AI assistant on the Frank network. Send me any message to chat!",
        },
      ]);
    } catch (err) {
      console.warn(`[qwen] Failed to welcome new user ${user.address}:`, err);
    }
  }

  async onMessage(
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<void> {
    const textItems = msgCtx.items.filter((item: any) => item.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const userText = textItems.map((it) => it.text).join("\n").trim();

    if (!userText) {
      await msgCtx.reply([
        {
          type: "text",
          text: "Hello! I am Qwen. How can I help you today?",
        },
      ]);
      return;
    }

    console.log(`[qwen] Generating reply for ${msgCtx.peerAddress}: "${userText.slice(0, 50)}..."`);

    // Load conversation history
    const historyKey = `history:${msgCtx.peerAddress.toLowerCase()}`;
    const rawHistory = await ctx.state.get(historyKey);
    let history: QwenChatMessage[] = [];
    if (rawHistory) {
      try {
        history = JSON.parse(rawHistory);
      } catch {
        history = [];
      }
    }

    history.push({ role: "user", content: userText });

    // Generate completion
    const result = await this.replyGenerator.reply(history);
    history.push({ role: "assistant", content: result.content });

    // Keep bounded history window (last 20 messages)
    if (history.length > 20) {
      history = history.slice(-20);
    }
    await ctx.state.put(historyKey, JSON.stringify(history));

    await msgCtx.reply([
      {
        type: "text",
        text: result.content,
      },
    ]);
  }
}
