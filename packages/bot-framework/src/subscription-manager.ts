import type {
  BotStateStore,
  BotSubscriptionManager,
  MessageItem,
  DirectMessageSendResult,
} from "./types";

export class LevelSubscriptionManager implements BotSubscriptionManager {
  private readonly store: BotStateStore;
  private readonly sender: (
    to: string,
    items: MessageItem[]
  ) => Promise<DirectMessageSendResult>;

  constructor(
    store: BotStateStore,
    sender: (to: string, items: MessageItem[]) => Promise<DirectMessageSendResult>
  ) {
    this.store = store;
    this.sender = sender;
  }

  private topicKey(topic: string): string {
    return `subs:${topic.toLowerCase()}`;
  }

  private async getSubscribersSet(topic: string): Promise<Set<string>> {
    const raw = await this.store.get(this.topicKey(topic));
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr.map((a: string) => a.toLowerCase()));
      }
    } catch {
      // Fallback on parse failure
    }
    return new Set();
  }

  private async saveSubscribersSet(
    topic: string,
    subs: Set<string>
  ): Promise<void> {
    const arr = Array.from(subs);
    await this.store.put(this.topicKey(topic), JSON.stringify(arr));
  }

  async subscribe(address: string, topic = "default"): Promise<boolean> {
    const normalized = address.toLowerCase();
    const subs = await this.getSubscribersSet(topic);
    if (subs.has(normalized)) {
      return false;
    }
    subs.add(normalized);
    await this.saveSubscribersSet(topic, subs);
    return true;
  }

  async unsubscribe(address: string, topic = "default"): Promise<boolean> {
    const normalized = address.toLowerCase();
    const subs = await this.getSubscribersSet(topic);
    if (!subs.has(normalized)) {
      return false;
    }
    subs.delete(normalized);
    await this.saveSubscribersSet(topic, subs);
    return true;
  }

  async isSubscribed(address: string, topic = "default"): Promise<boolean> {
    const normalized = address.toLowerCase();
    const subs = await this.getSubscribersSet(topic);
    return subs.has(normalized);
  }

  async listSubscribers(topic = "default"): Promise<string[]> {
    const subs = await this.getSubscribersSet(topic);
    return Array.from(subs);
  }

  async broadcast(
    items: MessageItem[],
    topic = "default"
  ): Promise<{ sent: number; failed: number }> {
    const subs = await this.listSubscribers(topic);
    let sent = 0;
    let failed = 0;

    for (const address of subs) {
      try {
        await this.sender(address, items);
        sent++;
      } catch (err) {
        console.warn(
          `[subscription-manager] Failed to deliver broadcast to ${address}:`,
          err
        );
        failed++;
      }
    }

    return { sent, failed };
  }

  /**
   * Helper to detect and handle /subscribe or /unsubscribe commands.
   * Returns reply items if command was handled, or null if message was not a subscription command.
   */
  async handleSubscriptionCommand(
    items: MessageItem[],
    senderAddress: string,
    topic = "default"
  ): Promise<MessageItem[] | null> {
    const textItem = items.find((item: any) => item.type === "text") as
      | { text: string }
      | undefined;
    if (!textItem) return null;

    const trimmed = textItem.text.trim().toLowerCase();

    if (
      trimmed === "/subscribe" ||
      trimmed === "subscribe" ||
      trimmed.startsWith("/subscribe ")
    ) {
      const added = await this.subscribe(senderAddress, topic);
      return [
        {
          type: "text",
          text: added
            ? `✅ You are now subscribed to ${topic} updates! Send /unsubscribe anytime to opt out.`
            : `You are already subscribed to ${topic} updates.`,
        },
      ];
    }

    if (
      trimmed === "/unsubscribe" ||
      trimmed === "unsubscribe" ||
      trimmed.startsWith("/unsubscribe ")
    ) {
      const removed = await this.unsubscribe(senderAddress, topic);
      return [
        {
          type: "text",
          text: removed
            ? `👋 You have been unsubscribed from ${topic} updates.`
            : `You were not subscribed to ${topic} updates.`,
        },
      ];
    }

    return null;
  }
}
