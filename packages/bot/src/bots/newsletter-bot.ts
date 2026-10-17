import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  BotStateStore,
  InterruptedMessage,
  NewUserEvent,
} from "@frank/bot-framework";
import type { ApplicationMessageItem, MessageItem } from "@frank/cashweb/types/messages";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_ASSISTANT } from "@frank/codec";
import {
  NEWSLETTER_ARTICLE_ITEM_TYPE,
  readNewsletterArticle,
  type NewsletterArticleValue,
} from "@frank/wallet/message-item-plugins/newsletter";
import { generateAvatarPng } from "../../bot-directory";
import { Outbox, replyFree, sendFree } from "./money";

export const DEFAULT_NEWSLETTER_ARTICLES: readonly NewsletterArticleValue[] = [
  {
    articleId: "dispatch-003",
    title: "Zero-Leakage Reader Views for Encrypted Messaging",
    source: "Stamped Dispatch",
    author: "Elena Vance",
    summary:
      "Why self-contained CBOR article payloads eliminate web-beacon tracking and third-party metadata leaks in private chat.",
    body: [
      "Every time a messaging client fetches a remote link preview or loads an external stylesheet, it announces the reader's IP address and reading time to an origin server. For high-assurance communication, link-based publishing is a metadata trap.",
      "By carrying complete articles inside canonical CBOR application frames, Stamped Dispatch delivers the entire text inside the encrypted direct-message envelope. Opening an edition in the reader view performs zero network requests.",
      "Combined with on-chain stamp commitments, publishers can ration attention economically while readers retain complete local custody of their archive.",
    ].join("\n\n"),
    url: "https://frank.cash/dispatch/zero-leakage-reader-views",
    publishedAt: 1760659200000,
    tags: ["privacy", "cbor", "messaging"],
  },
  {
    articleId: "dispatch-002",
    title: "Stamp Economics: Pricing Attention Without Central Gatekeepers",
    source: "Stamped Dispatch",
    author: "Marcus Chen",
    summary:
      "How verifiable micro-stamps replace spam filters with direct sender-to-recipient economic finality.",
    body: [
      "Traditional email and messaging platforms rely on opaque reputation scores and centralized blocklists to combat unsolicited bulk traffic. The result is false positives for independent writers and rent extraction by platform intermediaries.",
      "In a stamped messaging network, every cold message carries a cryptographic proof of payment or burn settled on-chain. Recipients set their own minimum stamp thresholds, turning spam attempts into direct revenue for the inbox owner.",
      "Trusted contacts and subscribed dispatches can communicate at zero stamp cost while unknown senders pay the market price of attention.",
    ].join("\n\n"),
    url: "https://frank.cash/dispatch/stamp-economics",
    publishedAt: 1760572800000,
    tags: ["crypto-economics", "stamps", "attention"],
  },
  {
    articleId: "dispatch-001",
    title: "Deterministic Framing and Cross-Chain Stealth Settlement",
    source: "Stamped Dispatch",
    author: "Satoshi & Friends",
    summary:
      "Inside the FRNK v1 binary envelope and how typed application plugins keep core wallet custody isolated.",
    body: [
      "Protocol extensibility often collides with wallet security. When every new message card requires changes to core signing or storage code, the audit surface grows without bound.",
      "The typed ApplicationItemPlugin boundary solves this by separating transport framing from custody. Feature modules define their own deterministic CBOR schema and Vue reader component without touching wallet keys or database migrations.",
      "Whether negotiating an atomic swap or delivering a long-form dispatch, the wire format remains strictly bounded under the enclosing message's validation budget.",
    ].join("\n\n"),
    url: "https://frank.cash/dispatch/deterministic-framing",
    publishedAt: 1760486400000,
    tags: ["architecture", "protocol", "security"],
  },
];

const SUBSCRIBERS_KEY = "subscribers";
const SEEN_USERS_KEY = "seen_users";

function resolveStore(ctx: BotContext): BotStateStore {
  return (
    ctx.state ??
    (ctx as unknown as { store?: BotStateStore }).store ??
    (() => {
      throw new Error("BotContext is missing state store");
    })()
  );
}

export function toNewsletterApplicationItem(
  article: NewsletterArticleValue
): ApplicationMessageItem {
  return {
    type: "application",
    itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
    value: readNewsletterArticle(article),
  };
}

export class NewsletterBot implements FrankBotDefinition {
  readonly id = "newsletter";
  readonly label = "Stamped Dispatch";
  readonly defaultIdentityPath =
    process.env.NEWSLETTER_BOT_IDENTITY_JSON ?? "/tmp/newsletter-bot-identity.json";

  private readonly articles: NewsletterArticleValue[];
  private readonly outbox = new Outbox("newsletter");
  readonly schedules = [this.outbox.schedule];

  constructor(options?: { articles?: NewsletterArticleValue[] }) {
    const source =
      options?.articles && options.articles.length > 0
        ? options.articles
        : DEFAULT_NEWSLETTER_ARTICLES;
    this.articles = source.map((article) => readNewsletterArticle(article));
  }

  getProfile(): BotProfile {
    return {
      name: "Stamped Dispatch",
      bio: "Curated encrypted-messaging & crypto-economics newsletter. Send 'subscribe', 'latest', 'list', or 'read <id>'.",
      avatarPng: generateAvatarPng("newsletter", [50, 120, 210]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_ASSISTANT,
    };
  }

  onInterrupted(message: InterruptedMessage, ctx: BotContext): Promise<void> {
    return this.outbox.interrupted(ctx, message);
  }

  private getLatestArticle(): NewsletterArticleValue {
    return this.articles.reduce((best, current) =>
      current.publishedAt > best.publishedAt ? current : best
    , this.articles[0]);
  }

  async getSubscribers(ctx: BotContext): Promise<string[]> {
    const store = resolveStore(ctx);
    const raw = await store.get(SUBSCRIBERS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }

  private async setSubscribers(
    ctx: BotContext,
    subscribers: string[]
  ): Promise<void> {
    const store = resolveStore(ctx);
    await store.put(SUBSCRIBERS_KEY, JSON.stringify(subscribers));
  }

  private async getSeenUsers(ctx: BotContext): Promise<string[]> {
    const store = resolveStore(ctx);
    const raw = await store.get(SEEN_USERS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }

  private async markUserSeen(
    ctx: BotContext,
    address: string
  ): Promise<boolean> {
    const normalized = address.toLowerCase();
    const seen = await this.getSeenUsers(ctx);
    if (seen.some((entry) => entry.toLowerCase() === normalized)) {
      return false;
    }
    const store = resolveStore(ctx);
    await store.put(SEEN_USERS_KEY, JSON.stringify([...seen, normalized]));
    return true;
  }

  private async addSubscriber(
    ctx: BotContext,
    address: string
  ): Promise<boolean> {
    const normalized = address.toLowerCase();
    const subs = await this.getSubscribers(ctx);
    const already = subs.some((entry) => entry.toLowerCase() === normalized);
    if (!already) {
      await this.setSubscribers(ctx, [...subs, normalized]);
    }
    await this.markUserSeen(ctx, address);
    return !already;
  }

  private async removeSubscriber(
    ctx: BotContext,
    address: string
  ): Promise<boolean> {
    const normalized = address.toLowerCase();
    const subs = await this.getSubscribers(ctx);
    const next = subs.filter((entry) => entry.toLowerCase() !== normalized);
    await this.markUserSeen(ctx, address);
    if (next.length === subs.length) {
      return false;
    }
    await this.setSubscribers(ctx, next);
    return true;
  }

  async isSubscribed(ctx: BotContext, address: string): Promise<boolean> {
    const normalized = address.toLowerCase();
    const subs = await this.getSubscribers(ctx);
    return subs.some((entry) => entry.toLowerCase() === normalized);
  }

  private buildWelcomeItems(article: NewsletterArticleValue): MessageItem[] {
    return [
      toNewsletterApplicationItem(article),
      {
        type: "text",
        text: `📰 Welcome to **${this.label}**! You are now subscribed. Here is our latest edition: "${article.title}". Send \`list\` to browse all editions, \`read <index|articleId>\` to open a specific issue, or \`unsubscribe\` at any time.`,
      },
    ];
  }

  private buildCatalogText(subscribed: boolean): string {
    const statusLine = subscribed
      ? "Subscription status: **Subscribed** ✅"
      : "Subscription status: **Not subscribed** (send `subscribe` to join)";
    const editionLines = this.articles.map((article, idx) => {
      const dateStr = new Date(article.publishedAt).toISOString().slice(0, 10);
      return `${idx + 1}. **${article.title}** (\`${article.articleId}\`) — ${article.source} · ${dateStr}`;
    });
    return [
      `📰 **${this.label} — Editions Catalog**`,
      statusLine,
      "",
      ...editionLines,
      "",
      "Commands: `latest`, `read <index|articleId>`, `subscribe`, `unsubscribe`, `help`",
    ].join("\n");
  }

  private findArticle(query: string): NewsletterArticleValue | undefined {
    const cleaned = query.trim().replace(/^#/, "");
    if (!cleaned) return undefined;

    const lower = cleaned.toLowerCase();
    const byId = this.articles.find(
      (article) => article.articleId.toLowerCase() === lower
    );
    if (byId) return byId;

    if (/^\d+$/.test(cleaned)) {
      const num = Number.parseInt(cleaned, 10);
      if (num >= 1 && num <= this.articles.length) {
        return this.articles[num - 1];
      }
      if (num === 0 && this.articles.length > 0) {
        return this.articles[0];
      }
    }
    return undefined;
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      await this.addSubscriber(ctx, user.address);
      const latest = this.getLatestArticle();
      await sendFree(ctx, user.address, this.buildWelcomeItems(latest));
    } catch (err) {
      console.warn(
        `[newsletter] Failed to welcome new user ${user.address}:`,
        err
      );
    }
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const rawText = msgCtx.items
      .filter(
        (item): item is Extract<MessageItem, { type: "text" }> =>
          item.type === "text"
      )
      .map((item) => item.text)
      .join("\n")
      .trim();

    const normalizedCmd = rawText.replace(/^\//, "").trim();
    const lowerCmd = normalizedCmd.toLowerCase();

    const isFirstInteraction = await this.markUserSeen(ctx, msgCtx.peerAddress);

    if (lowerCmd === "subscribe") {
      await this.addSubscriber(ctx, msgCtx.peerAddress);
      const latest = this.getLatestArticle();
      await replyFree(msgCtx, this.buildWelcomeItems(latest));
      return;
    }

    if (lowerCmd === "unsubscribe") {
      await this.removeSubscriber(ctx, msgCtx.peerAddress);
      await replyFree(msgCtx, [
        {
          type: "text",
          text: "You have been unsubscribed from Stamped Dispatch. Send `subscribe` anytime to rejoin.",
        },
      ]);
      return;
    }

    if (
      lowerCmd === "help" ||
      lowerCmd === "list" ||
      lowerCmd === "editions"
    ) {
      const subscribed = await this.isSubscribed(ctx, msgCtx.peerAddress);
      await replyFree(msgCtx, [
        {
          type: "text",
          text: this.buildCatalogText(subscribed),
        },
      ]);
      return;
    }

    if (lowerCmd === "latest") {
      const latest = this.getLatestArticle();
      await replyFree(msgCtx, [toNewsletterApplicationItem(latest)]);
      return;
    }

    if (lowerCmd.startsWith("read ") || lowerCmd === "read") {
      const targetArg = normalizedCmd.slice(4).trim();
      const article = targetArg
        ? this.findArticle(targetArg)
        : this.getLatestArticle();
      if (!article) {
        await replyFree(msgCtx, [
          {
            type: "text",
            text: `Edition "${targetArg}" was not found. Send \`list\` to see available editions.`,
          },
        ]);
        return;
      }
      await replyFree(msgCtx, [toNewsletterApplicationItem(article)]);
      return;
    }

    // First message from a new user automatically subscribes them and sends the latest edition.
    if (isFirstInteraction) {
      await this.addSubscriber(ctx, msgCtx.peerAddress);
      const latest = this.getLatestArticle();
      await replyFree(msgCtx, this.buildWelcomeItems(latest));
      return;
    }

    const subscribed = await this.isSubscribed(ctx, msgCtx.peerAddress);
    await replyFree(msgCtx, [
      {
        type: "text",
        text: this.buildCatalogText(subscribed),
      },
    ]);
  }
}
