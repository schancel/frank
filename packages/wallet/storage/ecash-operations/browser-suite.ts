import { createBrowserEcashOperationStore } from "./browser";
import { binding, fixture } from "./fixture";
import {
  LEDGER_KEY,
  OBJECT_STORE,
  type OwnedEcashOperationStore,
} from "./common";
import { runNativeTransactionExclusive } from "../../chain/chain-wallet";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(value: unknown, expected: unknown) {
  assert(
    JSON.stringify(value) === JSON.stringify(expected),
    "Exact ledger mismatch"
  );
}
async function rejects(work: Promise<unknown>, pattern?: RegExp) {
  try {
    await work;
  } catch (error) {
    if (pattern)
      assert(
        pattern.test(String(error)),
        `Unexpected rejection: ${String(error)}`
      );
    return;
  }
  throw new Error("Expected rejection");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const owner = (namespace = "qualification") =>
  createBrowserEcashOperationStore({ ...binding, namespace });
let retained: OwnedEcashOperationStore | undefined;

async function raw(
  name: string,
  version: number,
  value?: string
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(OBJECT_STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    if (value !== undefined)
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(OBJECT_STORE, "readwrite", {
          durability: "strict",
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.objectStore(OBJECT_STORE).put(value, LEDGER_KEY);
      });
  } finally {
    db.close();
  }
}

export async function run(phase: string) {
  if (phase === "stage") {
    retained = owner();
    equal(await retained.get(retained.walletKey), undefined);
    assert(
      !(await indexedDB.databases()).some(
        (db) => db.name === retained!.namespace
      ),
      "Absent read created namespace"
    );
    const ledger = fixture();
    const writing = retained.put(retained.walletKey, ledger);
    (ledger.operations[0].intent as { value: string }).value = "1";
    await writing;
    equal(await retained.get(retained.walletKey), fixture());
    return {
      checks: [
        "absent hydration",
        "snapshot-before-await",
        "acknowledged original signed bytes/claims/tombstones",
      ],
      namespace: retained.namespace,
    };
  }
  if (phase === "reopen") {
    retained = owner();
    equal(await retained.get(retained.walletKey), fixture());
    const copy = (await retained.get(retained.walletKey))!;
    (copy.operations as unknown[]).length = 0;
    equal(await retained.get(retained.walletKey), fixture());
    await retained.close();
    return { checks: ["Chrome process restart", "fresh copy-isolated reads"] };
  }
  if (phase === "increment") {
    const store = owner();
    try {
      await runNativeTransactionExclusive(
        store.walletKey,
        "single-realm",
        async () => {
          const ledger = (await store.get(store.walletKey))!;
          await new Promise((resolve) => setTimeout(resolve, 20));
          await store.put(store.walletKey, {
            ...ledger,
            nextChangeIndex: ledger.nextChangeIndex + 1,
          });
        }
      );
    } finally {
      await store.close();
    }
    return { checks: ["independent-context canonical wallet lock"] };
  }
  if (phase === "check-increments") {
    const store = owner();
    try {
      assert(
        (await store.get(store.walletKey))!.nextChangeIndex === 3,
        "Independent contexts lost an update"
      );
    } finally {
      await store.close();
    }
    return {
      checks: [
        "fresh committed state across contexts",
        "two serialized updates",
      ],
    };
  }
  if (phase !== "regressions") throw new Error("Unknown qualification phase");
  const checks: string[] = [];
  const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  try {
    let refused = false;
    try {
      owner("missing-locks");
    } catch (error) {
      refused = /Web Locks/.test(String(error));
    }
    assert(refused, "Missing Web Locks accepted");
  } finally {
    if (locksDescriptor)
      Object.defineProperty(navigator, "locks", locksDescriptor);
    else delete (navigator as unknown as { locks?: LockManager }).locks;
  }
  checks.push("missing Web Locks refuses factory");

  // Reject bad input before storage, without poisoning a valid handle.
  const valid = owner();
  await rejects(valid.get("foreign"), /affinity/);
  await rejects(
    valid.put(valid.walletKey, {
      ...fixture(),
      chainIdentifier: "xec-mainnet",
    }),
    /affinity/
  );
  equal(await valid.get(valid.walletKey), fixture());
  await valid.close();
  checks.push("key/ledger affinity and non-poisoning input rejection");

  // Keep an actual readwrite transaction alive after its put request succeeds.
  const delayed = owner("delayed-write");
  const originalPut = IDBObjectStore.prototype.put;
  const began = deferred();
  let hold = true,
    writeDone = false,
    readDone = false;
  IDBObjectStore.prototype.put = function (
    ...args: Parameters<IDBObjectStore["put"]>
  ) {
    const request = originalPut.apply(this, args);
    if (this.transaction.db.name === delayed.namespace) {
      const store = this;
      request.addEventListener("success", () => {
        began.resolve();
        const keepAlive = () => {
          const read = store.get("qualification-keepalive");
          read.onsuccess = () => {
            if (hold) keepAlive();
          };
        };
        keepAlive();
      });
    }
    return request;
  };
  try {
    const writing = delayed.put(delayed.walletKey, fixture()).then(() => {
      writeDone = true;
    });
    await began.promise;
    const reading = delayed.get(delayed.walletKey).then((value) => {
      readDone = true;
      return value;
    });
    const closing = delayed.close();
    assert(
      delayed.close() === closing,
      "Close did not retain ownership of its drain"
    );
    await rejects(delayed.get(delayed.walletKey), /closed/);
    await turn();
    assert(
      !writeDone && !readDone,
      "Request success escaped transaction completion"
    );
    hold = false;
    await writing;
    equal(await reading, fixture());
    await closing;
  } finally {
    hold = false;
    IDBObjectStore.prototype.put = originalPut;
    await delayed.close();
  }
  checks.push(
    "actual pending transaction blocks reads",
    "close drains admitted writes"
  );

  // A real transaction commits, but its completion notification is reported as failed.
  const uncertain = owner("uncertain-write");
  await uncertain.put(uncertain.walletKey, fixture());
  const originalTransaction = IDBDatabase.prototype.transaction;
  let inject = true;
  IDBDatabase.prototype.transaction = function (
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = originalTransaction.apply(this, args);
    if (
      inject &&
      this.name === uncertain.namespace &&
      tx.mode === "readwrite"
    ) {
      inject = false;
      tx.addEventListener("complete", (event) => {
        event.stopImmediatePropagation();
        tx.onabort?.call(tx, new Event("abort"));
      });
    }
    return tx;
  };
  try {
    const writing = uncertain.put(uncertain.walletKey, {
      ...fixture(),
      nextChangeIndex: 99,
    });
    const reading = uncertain.get(uncertain.walletKey);
    await rejects(writing);
    await rejects(reading, /poisoned/);
    await rejects(uncertain.get(uncertain.walletKey), /poisoned/);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    await uncertain.close();
  }
  const qualified = owner("uncertain-write");
  assert(
    (await qualified.get(qualified.walletKey))!.nextChangeIndex === 99,
    "Qualified reopen lost a committed write"
  );
  await qualified.close();
  checks.push(
    "failed visible write poisons queued readers",
    "qualified reopen after uncertain acknowledgment"
  );

  const strict = owner();
  IDBDatabase.prototype.transaction = function (
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = originalTransaction.apply(this, args);
    if (this.name === strict.namespace && tx.mode === "readwrite")
      Object.defineProperty(tx, "durability", { value: "relaxed" });
    return tx;
  };
  try {
    // Existing-only opening/reading performs no readwrite capability probe.
    equal(await strict.get(strict.walletKey), fixture());
    await rejects(
      strict.put(strict.walletKey, { ...fixture(), nextChangeIndex: 9 }),
      /Strict/
    );
    await rejects(strict.get(strict.walletKey), /poisoned/);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    await strict.close();
  }
  const unchanged = owner();
  equal(await unchanged.get(unchanged.walletKey), fixture());
  await unchanged.close();
  checks.push(
    "strict durability required only at mutation",
    "no write on strict refusal"
  );

  // Delay the actual open success handler; closing must wait and must not leak its connection.
  const initializing = owner("delayed-open");
  const originalOpen = IDBFactory.prototype.open;
  const opened = deferred();
  let finishOpen!: () => void;
  IDBFactory.prototype.open = function (
    ...args: Parameters<IDBFactory["open"]>
  ) {
    const request = originalOpen.apply(this, args);
    if (args[0] === initializing.namespace)
      request.addEventListener("success", (event) => {
        event.stopImmediatePropagation();
        const notify = request.onsuccess;
        finishOpen = () => notify?.call(request, event);
        opened.resolve();
      });
    return request;
  };
  try {
    const writing = initializing.put(initializing.walletKey, fixture());
    await opened.promise;
    const closing = initializing.close();
    await rejects(initializing.get(initializing.walletKey), /closed/);
    finishOpen();
    await writing;
    await closing;
  } finally {
    IDBFactory.prototype.open = originalOpen;
    await initializing.close();
  }
  const afterClose = owner("delayed-open");
  equal(await afterClose.get(afterClose.walletKey), fixture());
  await afterClose.close();
  checks.push("close during actual first open");

  for (const [name, version, value] of [
    ["incomplete", 1, undefined],
    ["malformed", 1, "broken"],
    [
      "foreign",
      1,
      JSON.stringify({ ...fixture(), chainIdentifier: "xec-mainnet" }),
    ],
    ["unsupported", 2, undefined],
  ] as const) {
    const store = owner(name);
    await raw(store.namespace, version, value);
    await rejects(store.get(store.walletKey));
    await rejects(store.put(store.walletKey, fixture()), /poisoned/);
    await store.close();
  }
  checks.push(
    "interrupted empty creation refuses reset",
    "malformed/foreign/unsupported namespaces reject"
  );
  return { checks };
}
