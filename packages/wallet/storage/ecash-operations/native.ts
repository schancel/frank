import level, { type LevelDB } from "level";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { durablePut } from "../level-durability";
import type { EcashOperationLedger } from "../../ecash-operation-store";
import {
  bind,
  LEDGER_KEY,
  namespaceFor,
  parseBound,
  requireKey,
  StoreQueue,
  type EcashStoreBinding,
  type OwnedEcashOperationStore,
} from "./common";

// Loaded-module guard only; Level's OS lock still excludes independent processes.
// Avoid constructing a duplicate handle: its failed-open cleanup can drop a live owner's POSIX lock.
const owners = new Map<string, symbol>();

async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function absent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The approved root must already exist. Factory/absent reads create no database or defaults. */
export async function createNativeEcashOperationStore(
  input: EcashStoreBinding & { readonly rootLocation: string }
): Promise<OwnedEcashOperationStore> {
  const binding = bind(input);
  const rootLocation = input.rootLocation;
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "Durable eCash Level storage requires qualified POSIX directory fsync"
    );
  const root = await fs.realpath(rootLocation);
  if (!(await fs.stat(root)).isDirectory())
    throw new Error("Expected an existing storage root directory");
  const namespace = namespaceFor(binding);
  const location = join(root, namespace);
  const queue = new StoreQueue();
  let database: LevelDB | undefined;
  const owner = Symbol("eCash Level owner");

  async function inspect(): Promise<boolean> {
    let stat;
    try {
      stat = await fs.lstat(location);
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(location)) !== location
    )
      throw new Error("Invalid eCash Level namespace directory");
    if (!(await fs.lstat(join(location, "CURRENT"))).isFile())
      throw new Error("Invalid eCash Level CURRENT file");
    const current = await fs.readFile(join(location, "CURRENT"), "utf8");
    if (
      !/^MANIFEST-[0-9]+\n$/.test(current) ||
      !(await fs.lstat(join(location, current.trim()))).isFile()
    )
      throw new Error("Incomplete eCash Level namespace");
    return true;
  }

  async function read(db: LevelDB): Promise<EcashOperationLedger> {
    let bytes: string;
    try {
      bytes = await db.get(LEDGER_KEY);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "notFound" in error &&
        error.notFound
      )
        throw new Error("Existing eCash namespace has no ledger");
      throw error;
    }
    return parseBound(binding, bytes);
  }

  async function open(create: boolean): Promise<LevelDB | undefined> {
    if (database) return database;
    if (owners.has(location))
      throw new Error("eCash Level namespace already owned");
    let exists = await inspect();
    if (!exists && !create) return undefined;
    // inspect yields; the check-and-claim itself must not yield before first initialization.
    if (owners.has(location))
      throw new Error("eCash Level namespace already owned");
    owners.set(location, owner);
    let created = false;
    if (!exists) {
      try {
        await fs.mkdir(location);
        created = true;
      } catch (error) {
        if (
          !(
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
        exists = await inspect();
        if (!exists) throw new Error("eCash namespace changed during creation");
      }
    }
    await new Promise<void>((resolve, reject) => {
      database = level(location, { createIfMissing: created }, (error) =>
        error ? reject(error) : resolve()
      );
    });
    const db = database!;
    // Recovery may rename a new manifest even for an existing database. Fence EVERY open.
    await syncDirectory(location);
    if (created) await syncDirectory(root);
    if (!created) {
      await read(db);
      for await (const [key] of db.iterator({}))
        if (key !== LEDGER_KEY)
          throw new Error("Unsupported eCash Level record");
    }
    return db;
  }

  return {
    coordinationScope: "single-realm",
    walletKey: binding.walletKey,
    namespace,
    async get(key) {
      requireKey(binding, key);
      return queue.run(async () => {
        const db = await open(false);
        return db ? read(db) : undefined;
      });
    },
    async put(key, ledger) {
      requireKey(binding, key);
      const bytes = JSON.stringify(ledger);
      parseBound(binding, bytes);
      await queue.run(async () => {
        await durablePut((await open(true))!, LEDGER_KEY, bytes);
      });
    },
    close: () =>
      queue.close(async () => {
        if (database) await database.close();
        // Failed cleanup leaves ownership fenced and the close rejection observable.
        if (owners.get(location) === owner) owners.delete(location);
      }),
  };
}
