import {
  NEWSLETTER_ARTICLE_ITEM_TYPE,
  type NewsletterArticleValue,
} from "@frank/wallet/message-item-plugins/newsletter";
import { harness, PLAYER } from "./bot-harness.testutil";
import { DEFAULT_NEWSLETTER_ARTICLES, NewsletterBot } from "./newsletter-bot";

const customArticles: NewsletterArticleValue[] = [
  {
    articleId: "edition-alpha",
    title: "Alpha Dispatch: Encrypted Channels",
    source: "Stamped Dispatch",
    author: "Alice",
    summary: "First edition summary.",
    body: "Full body of the Alpha edition.",
    publishedAt: 1760000000000,
    tags: ["crypto", "privacy"],
  },
  {
    articleId: "edition-beta",
    title: "Beta Dispatch: Stamp Finality",
    source: "Stamped Dispatch",
    author: "Bob",
    summary: "Second edition summary.",
    body: "Full body of the Beta edition.",
    publishedAt: 1760100000000,
    tags: ["economics"],
  },
];

describe("NewsletterBot", () => {
  test("provides at least 3 built-in curated default editions and valid bot metadata", () => {
    const bot = new NewsletterBot();
    expect(bot.id).toBe("newsletter");
    expect(bot.label).toBe("Stamped Dispatch");
    expect(DEFAULT_NEWSLETTER_ARTICLES.length).toBeGreaterThanOrEqual(3);
    const profile = bot.getProfile();
    expect(profile.name).toBe("Stamped Dispatch");
    expect(profile.bot).toBe(true);
  });

  test("onNewUser subscribes the user in store and sends the latest article with a welcome text item", async () => {
    const h = harness();
    const bot = new NewsletterBot({ articles: customArticles });

    await bot.onNewUser({ address: PLAYER, registeredAtMs: 1 }, h.ctx);

    expect(await bot.getSubscribers(h.ctx)).toContain(PLAYER.toLowerCase());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].hostStamp).toBe(false);
    expect(h.sent[0].valueWei).toBe(0n);

    const appItem = h.item("application", h.sent[0]);
    expect(appItem).toEqual({
      type: "application",
      itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
      value: customArticles[1],
    });
    const textItem = h.item("text", h.sent[0]);
    expect(textItem.text).toContain("Welcome to **Stamped Dispatch**");
  });

  test("first message from a new user subscribes them and sends the latest article", async () => {
    const h = harness();
    const bot = new NewsletterBot({ articles: customArticles });

    await bot.onMessage(h.message([{ type: "text", text: "hello there" }]), h.ctx);

    expect(await bot.isSubscribed(h.ctx, PLAYER)).toBe(true);
    expect(h.sent).toHaveLength(1);
    const appItem = h.item("application", h.sent[0]);
    expect(appItem).toEqual({
      type: "application",
      itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
      value: customArticles[1],
    });
  });

  test("supports help / list / editions commands with catalog and subscription status", async () => {
    const h = harness();
    const bot = new NewsletterBot({ articles: customArticles });

    await bot.onMessage(h.message([{ type: "text", text: "EDITIONS" }]), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.item("text", h.sent[0]).text).toContain("Not subscribed");
    expect(h.item("text", h.sent[0]).text).toContain("Alpha Dispatch: Encrypted Channels");
    expect(h.item("text", h.sent[0]).text).toContain("Beta Dispatch: Stamp Finality");

    await bot.onMessage(h.message([{ type: "text", text: "subscribe" }]), h.ctx);
    await bot.onMessage(h.message([{ type: "text", text: "list" }]), h.ctx);
    expect(h.item("text", h.sent[2]).text).toContain("Subscribed");
  });

  test("supports subscribe and unsubscribe commands and persists subscribers in ctx.state", async () => {
    const h = harness();
    const bot = new NewsletterBot({ articles: customArticles });

    await bot.onMessage(h.message([{ type: "text", text: "SUBSCRIBE" }]), h.ctx);
    expect(JSON.parse((await h.ctx.state.get("subscribers")) ?? "[]")).toEqual([
      PLAYER.toLowerCase(),
    ]);

    await bot.onMessage(h.message([{ type: "text", text: "UNSUBSCRIBE" }]), h.ctx);
    expect(JSON.parse((await h.ctx.state.get("subscribers")) ?? "[]")).toEqual([]);
    expect(h.item("text", h.sent[1]).text).toContain("unsubscribed");
  });

  test("supports latest and read <index|articleId> commands", async () => {
    const h = harness();
    const bot = new NewsletterBot({ articles: customArticles });

    await bot.onMessage(h.message([{ type: "text", text: "latest" }]), h.ctx);
    expect(h.item("application", h.sent[0])).toEqual({
      type: "application",
      itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
      value: customArticles[1],
    });

    await bot.onMessage(h.message([{ type: "text", text: "read 1" }]), h.ctx);
    expect(h.item("application", h.sent[1])).toEqual({
      type: "application",
      itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
      value: customArticles[0],
    });

    await bot.onMessage(
      h.message([{ type: "text", text: "READ edition-beta" }]),
      h.ctx
    );
    expect(h.item("application", h.sent[2])).toEqual({
      type: "application",
      itemType: NEWSLETTER_ARTICLE_ITEM_TYPE,
      value: customArticles[1],
    });

    await bot.onMessage(
      h.message([{ type: "text", text: "read unknown-id" }]),
      h.ctx
    );
    expect(h.item("text", h.sent[3]).text).toContain("not found");
  });
});
