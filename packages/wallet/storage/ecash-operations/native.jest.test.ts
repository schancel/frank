import * as fs from "node:fs/promises";
import { spawnSync, fork } from "node:child_process";
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
function childOwner(root: string) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(__dirname, "native-owner-child.cjs"), root],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(__dirname, "../../tsconfig.json"),
        TSX_DISABLE_CACHE: "1",
      },
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  const body = JSON.parse(result.stdout);
  expect(result.status).toBe(body.status === "locked" ? 2 : 0);
  return body;
}
async function withChildOwner(root: string, work: () => Promise<void>) {
  const child = fork(
    join(__dirname, "native-owner-child.cjs"),
    [root, "--hold"],
    {
      execArgv: ["--import", "tsx"],
      silent: true,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(__dirname, "../../tsconfig.json"),
        TSX_DISABLE_CACHE: "1",
      },
    }
  );
  let stderr = "";
  child.stderr!.on("data", (value) => {
    stderr += value;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve)
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const ready = await new Promise((resolve) => {
      child.once("message", resolve);
      child.once("exit", () => resolve({ status: "unexpected exit", stderr }));
      child.once("error", (error) =>
        resolve({ status: "spawn error", error: error.message })
      );
    });
    expect(ready).toEqual({ status: "opened", ledger: fixture() });
    await work();
  } finally {
    if (child.connected) child.send("release");
    expect(await exited).toBe(0);
    clearTimeout(timer);
    expect(stderr).toBe("");
  }
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

  it("does not claim an absent read and rejected cleanup cannot release a later owner", async () => {
    const absent = await owner();
    expect(await absent.get(absent.walletKey)).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
    const first = await owner();
    await first.put(first.walletKey, fixture());
    await expect(absent.get(absent.walletKey)).rejects.toThrow("already owned");
    await absent.close();
    expect(childOwner(root)).toEqual({ status: "locked" });
    await first.close();
    const reopened = await owner();
    expect(await reopened.get(reopened.walletKey)).toEqual(fixture());
  });

  it("excludes competing initialization before creating the namespace without releasing the first claim", async () => {
    const first = await owner();
    const gate = deferred(),
      started = deferred(),
      mkdir = io.mkdir;
    jest
      .spyOn(io, "mkdir")
      .mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        started.resolve();
        await gate.promise;
        return mkdir(...args);
      });
    const writing = first.put(first.walletKey, fixture());
    await started.promise;
    const second = await owner();
    await expect(second.put(second.walletKey, fixture())).rejects.toThrow(
      "already owned"
    );
    await second.close();
    expect(await fs.readdir(root)).toEqual([]);
    gate.resolve();
    await writing;
    expect(childOwner(root)).toEqual({ status: "locked" });
    await first.close();
    jest.restoreAllMocks();
    const other = await owner();
    expect(await other.get(other.walletKey)).toEqual(fixture());
  });

  it("releases its own claim after constructor failure cleanup without changing ledger bytes", async () => {
    const first = await owner();
    await first.put(first.walletKey, fixture());
    await first.close();
    jest.doMock("level", () => ({
      __esModule: true,
      default: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("constructor failed");
        })
        .mockImplementation(jest.requireActual("level")),
    }));
    let isolated!: typeof createNativeEcashOperationStore;
    try {
      jest.isolateModules(() => {
        isolated = require("./native").createNativeEcashOperationStore;
      });
      const failed = await isolated({ ...binding, rootLocation: root });
      stores.push(failed);
      await expect(failed.get(failed.walletKey)).rejects.toThrow(
        "constructor failed"
      );
      await failed.close();
      const reopened = await isolated({ ...binding, rootLocation: root });
      stores.push(reopened);
      expect(await reopened.get(reopened.walletKey)).toEqual(fixture());
      await reopened.close();
    } finally {
      jest.dontMock("level");
    }
  });

  it("cleans an actual OS-lock open failure and releases only its own claim", async () => {
    const first = await owner();
    await first.put(first.walletKey, fixture());
    await first.close();
    await withChildOwner(root, async () => {
      const failed = await owner();
      await expect(failed.get(failed.walletKey)).rejects.toThrow(
        /lock .*LOCK:/i
      );
      await failed.close();
      const retry = await owner();
      // A real Level lock error, rather than a stale module claim, proves failed-open cleanup released its token.
      await expect(retry.get(retry.walletKey)).rejects.toThrow(/lock .*LOCK:/i);
      await retry.close();
    });
    const reopened = await owner();
    expect(await reopened.get(reopened.walletKey)).toEqual(fixture());
  });

  it("retains a failed cleanup fence and exposes the error without unlocking the live database", async () => {
    const first = await owner();
    await first.put(first.walletKey, fixture());
    let handle!: LevelDB;
    const prototype = (require("levelup") as { prototype: LevelDB }).prototype;
    const closing = jest
      .spyOn(prototype, "close")
      .mockImplementationOnce(function (this: LevelDB) {
        handle = this;
        return Promise.reject(new Error("cleanup uncertain"));
      });
    try {
      const rejected = first.close();
      expect(first.close()).toBe(rejected);
      await expect(rejected).rejects.toThrow("cleanup uncertain");
      const second = await owner();
      await expect(second.get(second.walletKey)).rejects.toThrow(
        "already owned"
      );
      await second.close();
      expect(childOwner(root)).toEqual({ status: "locked" });
    } finally {
      closing.mockRestore();
      // Only this test's captured real handle: clean the synthetic DB without claiming facade recovery.
      await handle.close();
    }
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
    expect(childOwner(root)).toEqual({ status: "locked" });
    const alias = join(root, "root-alias");
    await fs.symlink(root, alias);
    const second = await owner(alias);
    await expect(second.get(second.walletKey)).rejects.toThrow();
    await expect(second.get(second.walletKey)).rejects.toThrow("poisoned");
    await second.close();
    // The original owner is deliberately still live: failed duplicate cleanup must not unlock it.
    expect(childOwner(root)).toEqual({ status: "locked" });
    expect(await first.get(first.walletKey)).toEqual(fixture());
    await first.close();
    expect(childOwner(root)).toEqual({ status: "opened", ledger: fixture() });
    const bytes = await raw(join(await fs.realpath(root), first.namespace));
    expect(await bytes.get(LEDGER_KEY)).toBe(JSON.stringify(fixture()));
    await bytes.close();
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
    const competing = await owner();
    await expect(competing.get(competing.walletKey)).rejects.toThrow(
      "already owned"
    );
    await competing.close();
    expect(childOwner(root)).toEqual({ status: "locked" });
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
    const restored = await raw(location);
    await restored.put(LEDGER_KEY, JSON.stringify(fixture()), { sync: true });
    await restored.close();
    const qualified = await owner();
    expect(await qualified.get(qualified.walletKey)).toEqual(fixture());
  });
});
