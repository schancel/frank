import type { SwapExecutionStore } from "../swap-execution-runtime";

const STORE_NAME = "operations";

function openDatabase(namespace: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`frank-swap-execution-v1-${namespace}`, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("Swap execution IndexedDB open failed"));
    req.onblocked = () =>
      reject(new Error("Swap execution IndexedDB open blocked"));
  });
}

export class BrowserSwapExecutionStore implements SwapExecutionStore {
  private readonly namespace: string;
  private readonly lockName: string;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(namespace = "default") {
    if (!namespace || !/^[a-zA-Z0-9_:-]{1,128}$/.test(namespace)) {
      throw new Error("Invalid browser swap execution namespace");
    }
    this.namespace = namespace;
    this.lockName = `frank-swap-execution-lock-${namespace}`;
  }

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDatabase(this.namespace);
    }
    return this.dbPromise;
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      return navigator.locks.request(this.lockName, work) as Promise<T>;
    }
    return work();
  }

  async getRecord(
    key: string
  ): Promise<{ revision: number; raw: string } | undefined> {
    return await this.withLock(async () => {
      const db = await this.getDb();
      return await new Promise<{ revision: number; raw: string } | undefined>(
        (resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(key);
          req.onsuccess = () => {
            const val = req.result as
              | { revision: number; raw: string }
              | undefined;
            resolve(val ? { revision: val.revision, raw: val.raw } : undefined);
          };
          req.onerror = () =>
            reject(req.error ?? new Error("Failed to read swap operation"));
        }
      );
    });
  }

  async listRecords(): Promise<
    readonly { key: string; revision: number; raw: string }[]
  > {
    return await this.withLock(async () => {
      const db = await this.getDb();
      return await new Promise<
        readonly { key: string; revision: number; raw: string }[]
      >((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const out: { key: string; revision: number; raw: string }[] = [];
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const val = cursor.value as { revision: number; raw: string };
            out.push({
              key: String(cursor.key),
              revision: val.revision,
              raw: val.raw,
            });
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        cursorReq.onerror = () =>
          reject(
            cursorReq.error ?? new Error("Failed to list swap operations")
          );
      });
    });
  }

  async compareAndSwap(
    key: string,
    expectedRevision: number,
    nextRaw: string
  ): Promise<boolean> {
    return await this.withLock(async () => {
      const db = await this.getDb();
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite", {
          durability: "strict",
        });
        const store = tx.objectStore(STORE_NAME);
        let matched = false;
        tx.oncomplete = () => resolve(matched);
        tx.onabort = () =>
          reject(
            tx.error ?? new Error("Swap execution CAS transaction aborted")
          );
        const getReq = store.get(key);
        getReq.onsuccess = () => {
          const current = getReq.result as
            | { revision: number; raw: string }
            | undefined;
          const actualRevision = current?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            matched = false;
            return;
          }
          matched = true;
          store.put({ revision: expectedRevision + 1, raw: nextRaw }, key);
        };
      });
    });
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise.catch(() => undefined);
      db?.close();
      this.dbPromise = undefined;
    }
  }
}
