import level, { type LevelDB } from "level";
import type { BotStateStore } from "./types";

export class LevelBotStateStore implements BotStateStore {
  private readonly db: LevelDB;
  private readonly prefix: string;
  private readonly isRoot: boolean;

  constructor(locationOrDb: string | LevelDB, prefix = "", isRoot = true) {
    if (typeof locationOrDb === "string") {
      this.db = level(locationOrDb);
    } else {
      this.db = locationOrDb;
    }
    this.prefix = prefix;
    this.isRoot = isRoot;
  }

  static async open(location: string): Promise<LevelBotStateStore> {
    const db = level(location);
    await db.open();
    return new LevelBotStateStore(db, "", true);
  }

  async open(): Promise<void> {
    if (typeof this.db.open === "function") {
      await this.db.open();
    }
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}!${key}` : key;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const val: unknown = await this.db.get(this.fullKey(key));
      return typeof val === "string"
        ? val
        : Buffer.isBuffer(val)
        ? val.toString("utf8")
        : String(val);
    } catch (err: unknown) {
      if (
        (err as { notFound?: boolean })?.notFound ||
        (err as { code?: string })?.code === "LEVEL_NOT_FOUND"
      ) {
        return undefined;
      }
      throw err;
    }
  }

  async put(key: string, value: string): Promise<void> {
    await this.db.put(this.fullKey(key), value);
  }

  async del(key: string): Promise<void> {
    try {
      await this.db.del(this.fullKey(key));
    } catch (err: unknown) {
      if (
        (err as { notFound?: boolean })?.notFound ||
        (err as { code?: string })?.code === "LEVEL_NOT_FOUND"
      ) {
        return;
      }
      throw err;
    }
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    const raw = await this.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async putJson<T>(key: string, value: T): Promise<void> {
    await this.put(key, JSON.stringify(value));
  }

  async batch(
    ops: Array<
      { type: "put"; key: string; value: string } | { type: "del"; key: string }
    >
  ): Promise<void> {
    const transformed = ops.map((op) =>
      op.type === "put"
        ? { type: "put" as const, key: this.fullKey(op.key), value: op.value }
        : { type: "del" as const, key: this.fullKey(op.key) }
    );
    await this.db.batch(transformed);
  }

  /** Bounded owner scan; returned keys are relative to this store's namespace. */
  async readEntries(
    prefix = "",
    limit = 2048
  ): Promise<Array<[string, string]>> {
    const start = this.fullKey(prefix);
    const entries: Array<[string, string]> = [];
    for await (const [key, value] of this.db.iterator({
      gte: start,
      lt: start + "\uffff",
      limit,
    })) {
      entries.push([
        this.prefix ? key.slice(this.prefix.length + 1) : key,
        value,
      ]);
    }
    return entries;
  }

  /** Invocation ownership must reach durable storage before plugin or payment effects. */
  async durableBatch(
    ops: Parameters<BotStateStore["batch"]>[0]
  ): Promise<void> {
    await this.db.batch(
      ops.map((op) => ({ ...op, key: this.fullKey(op.key) })),
      { sync: true }
    );
  }

  sublevel(name: string): LevelBotStateStore {
    const nextPrefix = this.prefix ? `${this.prefix}!${name}` : name;
    return new LevelBotStateStore(this.db, nextPrefix, false);
  }

  async close(): Promise<void> {
    if (this.isRoot && typeof this.db.close === "function") {
      await this.db.close();
    }
  }
}
