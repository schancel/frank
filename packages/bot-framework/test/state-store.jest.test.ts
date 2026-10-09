import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LevelBotStateStore } from "../src/state-store";

describe("LevelBotStateStore", () => {
  let tmpPath: string;
  let store: LevelBotStateStore;

  beforeEach(async () => {
    tmpPath = mkdtempSync(join(tmpdir(), "bot-store-test-"));
    store = await LevelBotStateStore.open(tmpPath);
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("sets and gets JSON values via getJson/putJson", async () => {
    await store.putJson("test-key", { foo: "bar", count: 42 });
    const val = await store.getJson<{ foo: string; count: number }>("test-key");
    expect(val).toEqual({ foo: "bar", count: 42 });
  });

  it("returns undefined for non-existent keys", async () => {
    const val = await store.get("missing-key");
    expect(val).toBeUndefined();
  });

  it("deletes keys correctly", async () => {
    await store.put("key-to-del", "exists");
    expect(await store.get("key-to-del")).toBe("exists");
    await store.del("key-to-del");
    expect(await store.get("key-to-del")).toBeUndefined();
  });

  it("supports sublevels with isolated namespaces", async () => {
    const sub1 = store.sublevel("sub1");
    const sub2 = store.sublevel("sub2");

    await sub1.put("item", "from-sub1");
    await sub2.put("item", "from-sub2");

    expect(await sub1.get("item")).toBe("from-sub1");
    expect(await sub2.get("item")).toBe("from-sub2");
  });

  it("executes batch operations atomically", async () => {
    await store.batch([
      { type: "put", key: "k1", value: "v1" },
      { type: "put", key: "k2", value: "v2" },
    ]);

    expect(await store.get("k1")).toBe("v1");
    expect(await store.get("k2")).toBe("v2");

    await store.batch([
      { type: "del", key: "k1" },
      { type: "put", key: "k3", value: "v3" },
    ]);

    expect(await store.get("k1")).toBeUndefined();
    expect(await store.get("k3")).toBe("v3");
  });
  it("keeps bounded prefix scans relative and sync batches durable across reopen", async () => {
    const sub = store.sublevel("owner");
    await store.put("foreign", "untouched");
    await sub.durableBatch([
      { type: "put", key: "row:1", value: "one" },
      { type: "put", key: "row:2", value: "two" },
    ]);
    await store.close();
    store = await LevelBotStateStore.open(tmpPath);
    expect(await store.sublevel("owner").readEntries("row:", 1)).toEqual([
      ["row:1", "one"],
    ]);
    expect(await store.sublevel("owner").readEntries()).toEqual([
      ["row:1", "one"],
      ["row:2", "two"],
    ]);
    expect(await store.get("foreign")).toBe("untouched");
  });
});
