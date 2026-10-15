import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import level, { type LevelDB } from "level";
import * as durability from "../level-durability";
import { createNativeEcashOperationStore } from "./native";
import { binding, fixture } from "./fixture";
import { LEDGER_KEY, type OwnedEcashOperationStore } from "./common";

const io = require("node:fs/promises") as typeof fs;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function raw(location: string): Promise<LevelDB> {
  return new Promise((resolve, reject) => {
    const db = level(location, { createIfMissing: false }, (error) =>
      error ? reject(error) : resolve(db)
    );
  });
}

describe("actual native Level eCash operation authority", () => {
  let root: string;
  let stores: OwnedEcashOperationStore[];
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "frank-ecash-store-"));
    stores = [];
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.allSettled(stores.map((store) => store.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function owner(rootLocation = root) {
    const store = await createNativeEcashOperationStore({
      ...binding,
      rootLocation,
    });
    stores.push(store);
    return store;
  }

  it("leaves absent inspection absent, snapshots writes, and preserves exact records across reopen", async () => {
    const store = await owner();
    expect(await store.get(store.walletKey)).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
    await expect(store.put("wrong", fixture())).rejects.toThrow("affinity");
    await expect(
      store.put(store.walletKey, {
        ...fixture(),
        chainIdentifier: "xec-mainnet",
      })
    ).rejects.toThrow("affinity");
    expect(await fs.readdir(root)).toEqual([]);
    const ledger = fixture();
    const expected = fixture();
    const writing = store.put(store.walletKey, ledger);
    (ledger.operations[0].intent as { value: string }).value = "1";
    await writing;
    const copy = (await store.get(store.walletKey))!;
    (copy.operations as unknown[]).length = 0;
    expect(await store.get(store.walletKey)).toEqual(expected);
    await store.close();
    const reopened = await owner();
    expect(await reopened.get(reopened.walletKey)).toEqual(expected);
    await reopened.put(reopened.walletKey, { ...expected, nextChangeIndex: 2 });
    expect((await reopened.get(reopened.walletKey))!.nextChangeIndex).toBe(2);
  });

  it("fsyncs the namespace after every actual open/recovery, and its parent on creation", async () => {
    const calls: string[] = [];
    const open = io.open;
    jest
      .spyOn(io, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          calls.push(String(args[0]));
          await sync();
        };
        return handle;
      });
    const first = await owner();
    await first.put(first.walletKey, fixture());
    const location = join(await fs.realpath(root), first.namespace);
    expect(calls).toEqual([location, await fs.realpath(root)]);
    await first.close();
    const reopened = await owner();
    await reopened.get(reopened.walletKey);
    expect(calls).toEqual([location, await fs.realpath(root), location]);
  });

  it("rejects competing native owners even through a physical-root alias", async () => {
    const first = await owner();
    await first.put(first.walletKey, fixture());
    const alias = join(root, "root-alias");
    await fs.symlink(root, alias);
    const second = await owner(alias);
    await expect(second.get(second.walletKey)).rejects.toThrow();
    await expect(second.get(second.walletKey)).rejects.toThrow("poisoned");
    await second.close();
    await first.close();
    const qualified = await owner();
    expect(await qualified.get(qualified.walletKey)).toEqual(fixture());
  });

  it("blocks queued reads behind writes and poisons them after a visible committed write loses acknowledgment", async () => {
    const store = await owner();
    await store.put(store.walletKey, fixture());
    const actual = durability.durablePut;
    const gate = deferred(),
      started = deferred();
    jest.spyOn(durability, "durablePut").mockImplementation(async (...args) => {
      await actual(...args);
      started.resolve();
      await gate.promise;
      throw new Error("acknowledgment lost");
    });
    const writing = store.put(store.walletKey, {
      ...fixture(),
      nextChangeIndex: 9,
    });
    const failedWrite = expect(writing).rejects.toThrow("acknowledgment lost");
    await started.promise;
    let escaped = false;
    const reading = store.get(store.walletKey).then((value) => {
      escaped = true;
      return value;
    });
    const failedRead = expect(reading).rejects.toThrow("poisoned");
    await turn();
    expect(escaped).toBe(false);
    gate.resolve();
    await failedWrite;
    await failedRead;
    await expect(store.get(store.walletKey)).rejects.toThrow("poisoned");
    await store.close();
    jest.restoreAllMocks();
    const qualified = await owner();
    expect((await qualified.get(qualified.walletKey))!.nextChangeIndex).toBe(9);
  });

  it("poisons a failed post-recovery directory barrier and permits only qualified reopen", async () => {
    const first = await owner();
    await first.put(first.walletKey, fixture());
    await first.close();
    const open = io.open;
    jest
      .spyOn(io, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        handle.sync = async () => {
          throw new Error("directory fsync failed");
        };
        return handle;
      });
    const failed = await owner();
    await expect(failed.get(failed.walletKey)).rejects.toThrow("fsync failed");
    await expect(failed.get(failed.walletKey)).rejects.toThrow("poisoned");
    await failed.close();
    jest.restoreAllMocks();
    const reopened = await owner();
    expect(await reopened.get(reopened.walletKey)).toEqual(fixture());
  });

  it("drains delayed first initialization and admitted writes when close revokes new admissions", async () => {
    const gate = deferred(),
      started = deferred(),
      open = io.open;
    let once = true;
    jest
      .spyOn(io, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (once) {
          once = false;
          started.resolve();
          await gate.promise;
        }
        return open(...args);
      });
    const store = await owner();
    const writing = store.put(store.walletKey, fixture());
    await started.promise;
    const reading = store.get(store.walletKey);
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await expect(store.get(store.walletKey)).rejects.toThrow("closed");
    gate.resolve();
    await writing;
    expect(await reading).toEqual(fixture());
    await closing;
    const reopened = await owner();
    expect(await reopened.get(reopened.walletKey)).toEqual(fixture());
  });

  it("refuses interrupted first creation and never resets malformed or foreign application records", async () => {
    const interrupted = await owner();
    const location = join(root, interrupted.namespace);
    await fs.mkdir(location);
    await expect(interrupted.get(interrupted.walletKey)).rejects.toThrow();
    await interrupted.close();
    const retry = await owner();
    await expect(retry.put(retry.walletKey, fixture())).rejects.toThrow();
    await retry.close();
    await fs.rmdir(location); // Only this test's deliberately empty synthetic interruption.
    const first = await owner();
    await first.put(first.walletKey, fixture());
    await first.close();
    for (const bytes of [
      "broken",
      JSON.stringify({ ...fixture(), chainIdentifier: "xec-mainnet" }),
    ]) {
      const db = await raw(location);
      await db.put(LEDGER_KEY, bytes, { sync: true });
      await db.close();
      const malformed = await owner();
      await expect(malformed.get(malformed.walletKey)).rejects.toThrow();
      await expect(
        malformed.put(malformed.walletKey, fixture())
      ).rejects.toThrow("poisoned");
      await malformed.close();
    }
  });
});
