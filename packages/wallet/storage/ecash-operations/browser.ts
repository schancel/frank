import {
  bind,
  LEDGER_KEY,
  OBJECT_STORE,
  namespaceFor,
  parseBound,
  requireKey,
  StoreQueue,
  type EcashStoreBinding,
  type OwnedEcashOperationStore,
} from "./common";
import type { EcashOperationLedger } from "../../ecash-operation-store";

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("eCash IndexedDB transaction aborted")
      );
    transaction.onerror = () => {
      /* Abort determines the transaction outcome. */
    };
  });
}

function schema(db: IDBDatabase): void {
  if (
    db.version !== 1 ||
    db.objectStoreNames.length !== 1 ||
    !db.objectStoreNames.contains(OBJECT_STORE)
  )
    throw new Error("Unsupported eCash IndexedDB namespace");
}

/** Direct IndexedDB only; no Level/global transaction monkeypatch or fallback storage. */
export function createBrowserEcashOperationStore(
  input: EcashStoreBinding & { readonly namespace: string }
): OwnedEcashOperationStore {
  const binding = bind(input);
  if (typeof input.namespace !== "string")
    throw new Error("Browser storage namespace is required");
  const namespace = namespaceFor(binding, input.namespace);
  // Old development ledgers can contain exposed obligations. Preserve every byte; no rollover.
  let old: string | null;
  try {
    old = globalThis.localStorage.getItem(
      `frank:ecash-operations:v1:${binding.walletKey}`
    );
  } catch (cause) {
    throw new Error("Cannot inspect old eCash operation ledger", { cause });
  }
  if (old !== null)
    throw new Error(
      "Unsupported old eCash operation ledger; preserve it for explicit recovery"
    );
  if (
    typeof indexedDB === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.locks
  )
    throw new Error(
      "Durable eCash browser storage requires IndexedDB and Web Locks"
    );
  const queue = new StoreQueue();
  let database: IDBDatabase | undefined;

  async function read(db: IDBDatabase): Promise<EcashOperationLedger> {
    schema(db);
    const tx = db.transaction(OBJECT_STORE, "readonly");
    const done = completed(tx);
    const store = tx.objectStore(OBJECT_STORE);
    if (store.keyPath !== null || store.autoIncrement) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error("Unsupported eCash object store");
    }
    let value: unknown,
      count = 0;
    try {
      const request = store.get(LEDGER_KEY);
      request.onsuccess = () => {
        value = request.result;
      };
      const total = store.count();
      total.onsuccess = () => {
        count = total.result;
      };
    } catch (error) {
      tx.abort();
      await done.catch(() => undefined);
      throw error;
    }
    await done;
    if (count !== 1)
      throw new Error("Unsupported or incomplete eCash IndexedDB records");
    if (typeof value !== "string")
      throw new Error("Existing eCash namespace has no serialized ledger");
    return parseBound(binding, value);
  }

  async function open(create: boolean): Promise<IDBDatabase | undefined> {
    if (database) return database;
    let created = false,
      refusedCreation = false,
      abandoned = false;
    const db = await new Promise<IDBDatabase | undefined>((resolve, reject) => {
      // No enumeration race: an existing-only open aborts ANY unexpected creation/upgrade.
      const request = indexedDB.open(namespace, 1);
      request.onupgradeneeded = (event) => {
        if (abandoned || !create || event.oldVersion !== 0) {
          refusedCreation = event.oldVersion === 0 && !create;
          request.transaction!.abort();
          return;
        }
        created = true;
        request.result.createObjectStore(OBJECT_STORE);
      };
      request.onerror = () =>
        refusedCreation
          ? resolve(undefined)
          : reject(
              request.error ??
                new Error("Cannot open eCash IndexedDB namespace")
            );
      request.onblocked = () => {
        abandoned = true;
        reject(new Error("eCash IndexedDB namespace open is blocked"));
      };
      request.onsuccess = () => {
        if (abandoned) request.result.close();
        else resolve(request.result);
      };
    });
    if (!db) return undefined;
    database = db;
    db.onversionchange = () => db.close();
    schema(db);
    if (!created) await read(db);
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
        const db = (await open(true))!;
        const tx = db.transaction(OBJECT_STORE, "readwrite", {
          durability: "strict",
        });
        const done = completed(tx);
        if (tx.durability !== "strict") {
          tx.abort();
          await done.catch(() => undefined);
          throw new Error("Strict IndexedDB durability is unavailable");
        }
        try {
          tx.objectStore(OBJECT_STORE).put(bytes, LEDGER_KEY);
        } catch (error) {
          tx.abort();
          await done.catch(() => undefined);
          throw error;
        }
        await done;
      });
    },
    close: () =>
      queue.close(async () => {
        database?.close();
      }),
  };
}
