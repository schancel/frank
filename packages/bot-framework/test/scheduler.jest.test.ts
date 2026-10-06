import { BotScheduler, isCronDue, matchCronField } from "../src/scheduler";
import type { BotContext, BotScheduleDefinition, BotStateStore } from "../src/types";

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

function createMockContext(store: BotStateStore): BotContext {
  return {
    botId: "test-bot",
    address: "0x123",
    subject: "subj",
    relayBaseUrl: "http://relay",
    networkTag: "MONT",
    provider: {} as any,
    state: store,
    subscriptions: {} as any,
    lookupPeer: jest.fn(),
    sendMessage: jest.fn(),
    sendDirectMessage: jest.fn(),
    onNewUserRegistered: jest.fn(),
    sendTransfer: jest.fn(),
    buildAndSignTransfer: jest.fn(),
    waitForReceipt: jest.fn(),
    getBalance: jest.fn(),
  };
}

describe("BotScheduler", () => {
  describe("Cron matching helpers", () => {
    it("matches exact numbers, wildcards, lists, ranges, and steps", () => {
      expect(matchCronField("*", 5)).toBe(true);
      expect(matchCronField("5", 5)).toBe(true);
      expect(matchCronField("5", 6)).toBe(false);
      expect(matchCronField("1,3,5", 3)).toBe(true);
      expect(matchCronField("1,3,5", 4)).toBe(false);
      expect(matchCronField("10-15", 12)).toBe(true);
      expect(matchCronField("10-15", 16)).toBe(false);
      expect(matchCronField("*/15", 30)).toBe(true);
      expect(matchCronField("*/15", 35)).toBe(false);
      expect(matchCronField("10-20/5", 15)).toBe(true);
      expect(matchCronField("10-20/5", 16)).toBe(false);
    });

    it("evaluates 5-field UTC cron expression", () => {
      // 2026-10-06 12:00:00 UTC (Tuesday = dow 2)
      const date = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));
      expect(isCronDue("0 12 * * *", date)).toBe(true);
      expect(isCronDue("0 13 * * *", date)).toBe(false);
      expect(isCronDue("0 * * * 2", date)).toBe(true);
      expect(isCronDue("0 * * * 1", date)).toBe(false);
    });
  });

  describe("Interval schedules", () => {
    it("registers and triggers interval on startup when runOnStartup is true", async () => {
      const scheduler = new BotScheduler();
      const store = new MemoryStateStore();
      const ctx = createMockContext(store);

      let runCount = 0;
      const sched: BotScheduleDefinition = {
        id: "daily-digest",
        intervalMs: 60_000,
        runOnStartup: true,
        handler: async () => {
          runCount++;
        },
      };

      scheduler.register("test-bot", sched, ctx);
      expect(scheduler.getRegisteredCount()).toBe(1);

      // First run at t=1000
      const ran = await scheduler.checkAndRunDue(1000);
      expect(ran).toBe(1);
      expect(runCount).toBe(1);

      // Verify last run timestamp was stored in state
      const lastRun = await store.get("schedule:last_run:daily-digest");
      expect(lastRun).toBe("1000");

      // Running at t=30000 (not due yet)
      const ran2 = await scheduler.checkAndRunDue(30000);
      expect(ran2).toBe(0);
      expect(runCount).toBe(1);

      // Running at t=62000 (due)
      const ran3 = await scheduler.checkAndRunDue(62000);
      expect(ran3).toBe(1);
      expect(runCount).toBe(2);
    });

    it("does not trigger immediately on startup when runOnStartup is false", async () => {
      const scheduler = new BotScheduler();
      const store = new MemoryStateStore();
      const ctx = createMockContext(store);

      let runCount = 0;
      const sched: BotScheduleDefinition = {
        id: "hourly-cleanup",
        intervalMs: 3600_000,
        runOnStartup: false,
        handler: async () => {
          runCount++;
        },
      };

      scheduler.register("test-bot", sched, ctx);

      // First check initializes last_run to now without executing
      const ran1 = await scheduler.checkAndRunDue(1000);
      expect(ran1).toBe(0);
      expect(runCount).toBe(0);

      const lastRun = await store.get("schedule:last_run:hourly-cleanup");
      expect(lastRun).toBe("1000");

      // 1 hour later (t=3601000) -> triggers
      const ran2 = await scheduler.checkAndRunDue(3601000);
      expect(ran2).toBe(1);
      expect(runCount).toBe(1);
    });
  });

  describe("Cron schedules", () => {
    it("runs when cron matches and prevents duplicate runs in the same minute", async () => {
      const scheduler = new BotScheduler();
      const store = new MemoryStateStore();
      const ctx = createMockContext(store);

      let runCount = 0;
      const sched: BotScheduleDefinition = {
        id: "hourly-cron",
        cron: "0 * * * *", // at minute 0 of every hour
        handler: async () => {
          runCount++;
        },
      };

      scheduler.register("test-bot", sched, ctx);

      // 12:00:10 UTC
      const t1 = Date.UTC(2026, 9, 6, 12, 0, 10);
      const ran1 = await scheduler.checkAndRunDue(t1);
      expect(ran1).toBe(1);
      expect(runCount).toBe(1);

      // 12:00:40 UTC (same minute, should not run again)
      const t2 = Date.UTC(2026, 9, 6, 12, 0, 40);
      const ran2 = await scheduler.checkAndRunDue(t2);
      expect(ran2).toBe(0);
      expect(runCount).toBe(1);

      // 13:00:05 UTC (next hour, minute 0 -> runs again)
      const t3 = Date.UTC(2026, 9, 6, 13, 0, 5);
      const ran3 = await scheduler.checkAndRunDue(t3);
      expect(ran3).toBe(1);
      expect(runCount).toBe(2);
    });
  });
});
