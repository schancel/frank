import { LevelSubscriptionManager } from "../src/subscription-manager";
import type { BotStateStore, MessageItem } from "../src/types";

class MemoryStateStore implements BotStateStore {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(prefix?: string): Promise<Array<{ key: string; value: string }>> {
    const res: Array<{ key: string; value: string }> = [];
    for (const [k, v] of this.data.entries()) {
      if (!prefix || k.startsWith(prefix)) {
        res.push({ key: k, value: v });
      }
    }
    return res;
  }

  sublevel(name: string): BotStateStore {
    return new MemoryStateStore();
  }

  async close(): Promise<void> {}
}

describe("LevelSubscriptionManager", () => {
  let store: MemoryStateStore;
  let sentMessages: Array<{ to: string; items: MessageItem[] }>;
  let manager: LevelSubscriptionManager;

  beforeEach(() => {
    store = new MemoryStateStore();
    sentMessages = [];
    manager = new LevelSubscriptionManager(store, async (to, items) => {
      sentMessages.push({ to, items });
      return { txHash: "0xmock" } as any;
    });
  });

  describe("Subscribing and Unsubscribing", () => {
    it("subscribes and unsubscribes addresses with case normalization", async () => {
      const addr = "0xAbCd1234Ef5678";
      expect(await manager.isSubscribed(addr)).toBe(false);

      const added = await manager.subscribe(addr);
      expect(added).toBe(true);
      expect(await manager.isSubscribed(addr.toLowerCase())).toBe(true);
      expect(await manager.isSubscribed(addr.toUpperCase())).toBe(true);

      // Duplicate subscribe returns false
      const addedAgain = await manager.subscribe(addr);
      expect(addedAgain).toBe(false);

      const list = await manager.listSubscribers();
      expect(list).toEqual([addr.toLowerCase()]);

      // Unsubscribe
      const removed = await manager.unsubscribe(addr);
      expect(removed).toBe(true);
      expect(await manager.isSubscribed(addr)).toBe(false);

      // Duplicate unsubscribe returns false
      const removedAgain = await manager.unsubscribe(addr);
      expect(removedAgain).toBe(false);
    });

    it("isolates different topics", async () => {
      const addr = "0x111";
      await manager.subscribe(addr, "newsletter");
      expect(await manager.isSubscribed(addr, "newsletter")).toBe(true);
      expect(await manager.isSubscribed(addr, "raffle-alerts")).toBe(false);

      await manager.subscribe(addr, "raffle-alerts");
      expect(await manager.isSubscribed(addr, "raffle-alerts")).toBe(true);

      expect(await manager.listSubscribers("newsletter")).toEqual([addr]);
      expect(await manager.listSubscribers("raffle-alerts")).toEqual([addr]);

      await manager.unsubscribe(addr, "newsletter");
      expect(await manager.isSubscribed(addr, "newsletter")).toBe(false);
      expect(await manager.isSubscribed(addr, "raffle-alerts")).toBe(true);
    });
  });

  describe("Broadcast", () => {
    it("broadcasts messages to all subscribers on the topic", async () => {
      await manager.subscribe("0xuser1", "news");
      await manager.subscribe("0xuser2", "news");

      const items: MessageItem[] = [{ type: "text", text: "Daily Edition #1" }];
      const result = await manager.broadcast(items, "news");

      expect(result).toEqual({ sent: 2, failed: 0 });
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].to).toBe("0xuser1");
      expect(sentMessages[1].to).toBe("0xuser2");
    });
  });

  describe("handleSubscriptionCommand", () => {
    it("handles /subscribe command", async () => {
      const items: MessageItem[] = [{ type: "text", text: "/subscribe" }];
      const reply = await manager.handleSubscriptionCommand(items, "0xalice", "updates");
      expect(reply).not.toBeNull();
      expect(reply![0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("now subscribed to updates"),
      });

      // Second time informs already subscribed
      const reply2 = await manager.handleSubscriptionCommand(items, "0xalice", "updates");
      expect(reply2![0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("already subscribed"),
      });
    });

    it("handles /unsubscribe command", async () => {
      await manager.subscribe("0xbob", "updates");

      const items: MessageItem[] = [{ type: "text", text: "/unsubscribe" }];
      const reply = await manager.handleSubscriptionCommand(items, "0xbob", "updates");
      expect(reply).not.toBeNull();
      expect(reply![0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("unsubscribed"),
      });

      // Not subscribed anymore
      const reply2 = await manager.handleSubscriptionCommand(items, "0xbob", "updates");
      expect(reply2![0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("were not subscribed"),
      });
    });

    it("ignores non-subscription commands", async () => {
      const items: MessageItem[] = [{ type: "text", text: "Hello bot!" }];
      const reply = await manager.handleSubscriptionCommand(items, "0xcharlie");
      expect(reply).toBeNull();
    });
  });
});
