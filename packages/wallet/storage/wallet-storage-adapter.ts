/**
 * Observable Wallet Storage Adapter (packages/wallet/storage/wallet-storage-adapter.ts).
 *
 * Provides an isolated, observable storage instance per wallet ID.
 * Decoupled from Vue/Pinia so it operates headlessly in bots, CLI, and test runners,
 * while allowing reactive application layers to attach notification listeners.
 *
 * Tracks allocated database names in a persistent manifest registry
 * (__frank_allocated_wallet_dbs__) for safe multi-wallet discovery and lifecycle resets.
 */

export type StorageChangeType = 'set' | 'delete' | 'clear';

export interface StorageChangeEvent<T = unknown> {
  readonly walletId: string;
  readonly dbName: string;
  readonly key: string;
  readonly type: StorageChangeType;
  readonly value?: T;
  readonly oldValue?: T;
}

export type StorageChangeListener<T = unknown> = (event: StorageChangeEvent<T>) => void;

export interface WalletStorageAdapter<T = unknown> {
  readonly walletId: string;
  readonly dbName: string;
  get<V = T>(key: string): Promise<V | undefined>;
  set<V = T>(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: StorageChangeListener<T>): () => void;
}

export interface WalletStorageOptions {
  /** Force in-memory backend even if IndexedDB is available (useful for headless/unit tests) */
  inMemory?: boolean;
  /** Custom DB name prefix, defaults to 'frank-wallet-' */
  dbPrefix?: string;
}

export const WALLET_DB_REGISTRY_NAME = 'frank-wallet-registry';
export const WALLET_DB_REGISTRY_STORE = 'manifest';
export const WALLET_DB_REGISTRY_KEY = '__frank_allocated_wallet_dbs__';

// In-memory fallback / registry store
const memoryStores = new Map<string, Map<string, unknown>>();
const memoryRegistry = new Set<string>();

/**
 * Returns true if native IndexedDB is available in the current runtime.
 */
function isIndexedDbAvailable(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
}

/**
 * Record an allocated database name in the persistent manifest registry.
 */
async function registerAllocatedDatabase(dbName: string): Promise<void> {
  memoryRegistry.add(dbName);

  if (!isIndexedDbAvailable()) return;

  try {
    const db = await openRegistryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WALLET_DB_REGISTRY_STORE, 'readwrite');
      const store = tx.objectStore(WALLET_DB_REGISTRY_STORE);
      const getReq = store.get(WALLET_DB_REGISTRY_KEY);
      getReq.onsuccess = () => {
        const currentList: string[] = Array.isArray(getReq.result) ? getReq.result : [];
        if (!currentList.includes(dbName)) {
          currentList.push(dbName);
          store.put(currentList, WALLET_DB_REGISTRY_KEY);
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Non-fatal if registry write fails
  }
}

/**
 * Unregister a deleted database from the manifest registry.
 */
async function unregisterAllocatedDatabase(dbName: string): Promise<void> {
  memoryRegistry.delete(dbName);

  if (!isIndexedDbAvailable()) return;

  try {
    const db = await openRegistryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WALLET_DB_REGISTRY_STORE, 'readwrite');
      const store = tx.objectStore(WALLET_DB_REGISTRY_STORE);
      const getReq = store.get(WALLET_DB_REGISTRY_KEY);
      getReq.onsuccess = () => {
        const currentList: string[] = Array.isArray(getReq.result) ? getReq.result : [];
        const nextList = currentList.filter((name) => name !== dbName);
        store.put(nextList, WALLET_DB_REGISTRY_KEY);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Non-fatal
  }
}

function openRegistryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(WALLET_DB_REGISTRY_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(WALLET_DB_REGISTRY_STORE)) {
        req.result.createObjectStore(WALLET_DB_REGISTRY_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List all allocated wallet database names tracked in the registry manifest.
 */
export async function listAllocatedWalletDatabases(): Promise<string[]> {
  const result = new Set<string>(memoryRegistry);

  if (isIndexedDbAvailable()) {
    try {
      const db = await openRegistryDb();
      const list = await new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(WALLET_DB_REGISTRY_STORE, 'readonly');
        const store = tx.objectStore(WALLET_DB_REGISTRY_STORE);
        const getReq = store.get(WALLET_DB_REGISTRY_KEY);
        getReq.onsuccess = () => {
          resolve(Array.isArray(getReq.result) ? getReq.result : []);
        };
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => db.close();
      });
      for (const name of list) {
        result.add(name);
      }
    } catch {
      // Fallback to memory registry
    }
  }

  return Array.from(result);
}

/**
 * Delete an allocated wallet database by walletId or dbName.
 */
export async function deleteWalletDatabase(
  walletIdOrDbName: string,
  prefix = 'frank-wallet-'
): Promise<void> {
  const dbName = walletIdOrDbName.startsWith(prefix)
    ? walletIdOrDbName
    : `${prefix}${walletIdOrDbName}`;

  memoryStores.delete(dbName);
  await unregisterAllocatedDatabase(dbName);

  if (isIndexedDbAvailable()) {
    await new Promise<void>((resolve, reject) => {
      const req = globalThis.indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // Non-blocking
    });
  }
}

/**
 * Clear all allocated wallet databases tracked in the registry.
 */
export async function clearAllWalletDatabases(prefix = 'frank-wallet-'): Promise<void> {
  const dbs = await listAllocatedWalletDatabases();
  for (const dbName of dbs) {
    if (dbName.startsWith(prefix)) {
      await deleteWalletDatabase(dbName, prefix);
    }
  }
  memoryStores.clear();
  memoryRegistry.clear();
}

/**
 * In-memory implementation of WalletStorageAdapter.
 */
class MemoryWalletStorageAdapter<T = unknown> implements WalletStorageAdapter<T> {
  readonly walletId: string;
  readonly dbName: string;
  private readonly store: Map<string, unknown>;
  private readonly listeners = new Set<StorageChangeListener<T>>();

  constructor(walletId: string, dbName: string) {
    this.walletId = walletId;
    this.dbName = dbName;
    if (!memoryStores.has(dbName)) {
      memoryStores.set(dbName, new Map<string, unknown>());
    }
    this.store = memoryStores.get(dbName)!;
  }

  async get<V = T>(key: string): Promise<V | undefined> {
    return this.store.get(key) as V | undefined;
  }

  async set<V = T>(key: string, value: V): Promise<void> {
    const oldValue = this.store.get(key) as T | undefined;
    this.store.set(key, value);
    this.notify({
      walletId: this.walletId,
      dbName: this.dbName,
      key,
      type: 'set',
      value: value as unknown as T,
      oldValue,
    });
  }

  async delete(key: string): Promise<void> {
    const oldValue = this.store.get(key) as T | undefined;
    if (this.store.delete(key)) {
      this.notify({
        walletId: this.walletId,
        dbName: this.dbName,
        key,
        type: 'delete',
        oldValue,
      });
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.store.keys());
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.notify({
      walletId: this.walletId,
      dbName: this.dbName,
      key: '*',
      type: 'clear',
    });
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  subscribe(listener: StorageChangeListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(event: StorageChangeEvent<T>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[WalletStorageAdapter:${this.walletId}] listener error`, err);
      }
    }
  }
}

/**
 * IndexedDB implementation of WalletStorageAdapter.
 */
class IndexedDbWalletStorageAdapter<T = unknown> implements WalletStorageAdapter<T> {
  readonly walletId: string;
  readonly dbName: string;
  private readonly storeName = 'records';
  private readonly listeners = new Set<StorageChangeListener<T>>();
  private dbPromise: Promise<IDBDatabase> | null = null;
  private isClosed = false;

  constructor(walletId: string, dbName: string) {
    this.walletId = walletId;
    this.dbName = dbName;
  }

  private getDb(): Promise<IDBDatabase> {
    if (this.isClosed) {
      return Promise.reject(new Error(`WalletStorageAdapter for ${this.walletId} is closed`));
    }
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = globalThis.indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(this.storeName)) {
            req.result.createObjectStore(this.storeName);
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async get<V = T>(key: string): Promise<V | undefined> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as V | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async set<V = T>(key: string, value: V): Promise<void> {
    const db = await this.getDb();
    let oldValue: T | undefined;
    try {
      oldValue = await this.get<T>(key);
    } catch {
      // ignore
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this.notify({
      walletId: this.walletId,
      dbName: this.dbName,
      key,
      type: 'set',
      value: value as unknown as T,
      oldValue,
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDb();
    let oldValue: T | undefined;
    try {
      oldValue = await this.get<T>(key);
    } catch {
      // ignore
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this.notify({
      walletId: this.walletId,
      dbName: this.dbName,
      key,
      type: 'delete',
      oldValue,
    });
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const keys = (req.result as string[]).map(String);
        resolve(prefix ? keys.filter((k) => k.startsWith(prefix)) : keys);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this.notify({
      walletId: this.walletId,
      dbName: this.dbName,
      key: '*',
      type: 'clear',
    });
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.listeners.clear();
    if (this.dbPromise) {
      const db = await this.dbPromise.catch(() => null);
      if (db) db.close();
      this.dbPromise = null;
    }
  }

  subscribe(listener: StorageChangeListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(event: StorageChangeEvent<T>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[WalletStorageAdapter:${this.walletId}] listener error`, err);
      }
    }
  }
}

/**
 * Creates an observable WalletStorageAdapter for a specific wallet ID.
 * Automatically allocates an isolated database and registers it in the manifest.
 */
export function createWalletStorage<T = unknown>(
  walletId: string,
  options?: WalletStorageOptions
): WalletStorageAdapter<T> {
  const prefix = options?.dbPrefix ?? 'frank-wallet-';
  const dbName = `${prefix}${walletId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  void registerAllocatedDatabase(dbName);

  if (options?.inMemory || !isIndexedDbAvailable()) {
    return new MemoryWalletStorageAdapter<T>(walletId, dbName);
  }

  return new IndexedDbWalletStorageAdapter<T>(walletId, dbName);
}
