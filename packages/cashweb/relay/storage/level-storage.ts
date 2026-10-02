/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  isSafeRelayTimestamp,
  MessageStore,
  MessageResult,
  MessageReturnResult,
  RelayDeliverySuppression,
  RelayReceiptIdentity,
} from "./storage";
import { MessageWrapper } from "../../types/messages";
import level, { LevelDB } from "level";
import { join } from "path";

const metadataKeys = {
  schemaVersion: "schemaVersion",
  lastServerTime: "lastServerTime",
};

// Relay delivery bookkeeping lives in the METADATA database, never in the message database: a
// pre-#420 (schema v2) reader iterates every message-database row and feeds it to
// `deserializeMessageWrapper`, so any non-message row here would wedge chat restoration after a
// client rollback. See the class header for the full durability contract.
const suppressionIndexPrefix = "relaySuppressionIndex:";
const quarantineIndexPrefix = "relayQuarantineIndex:";
// Layouts of this branch's earlier (never shipped) commits kept these in the MESSAGE database;
// `Open()` sweeps them out so a rolled-back v2 reader always iterates plain messages only.
const legacyMessageDbPrefixes = ["relayCursor:", suppressionIndexPrefix];

function suppressionIndexKey(recipientAddress: string): string {
  return `${suppressionIndexPrefix}${recipientAddress.toLowerCase()}`;
}

function quarantineIndexKey(recipientAddress: string): string {
  return `${quarantineIndexPrefix}${recipientAddress.toLowerCase()}`;
}

type StoredSuppression = {
  payloadDigest: string;
  receivedTime: number | null;
};

type JsonMessageWrapper = Omit<MessageWrapper, "message"> & {
  message: Omit<
    MessageWrapper["message"],
    "stampValueWei" | "stampPayments"
  > & {
    stampValueWei?: string | number;
    stampPayments?: Array<{
      txHash: string;
      destinationAddress: string;
      valueWei: string | number;
    }>;
  };
};

function parseStoredWei(
  value: string | number | undefined
): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Stored wei value is not a safe non-negative integer: ${value}`
      );
    }
    return BigInt(value);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `Stored wei value is not an unsigned decimal integer: ${value}`
    );
  }
  return BigInt(value);
}

/** Local schema v2: financial integers are decimal strings in JSON and bigint in memory. */
export function serializeMessageWrapper(
  messageWrapper: MessageWrapper
): string {
  const { stampValueWei, stampPayments, ...message } = messageWrapper.message;
  const stored: JsonMessageWrapper = {
    ...messageWrapper,
    message: {
      ...message,
      ...(stampValueWei === undefined
        ? {}
        : { stampValueWei: stampValueWei.toString() }),
      ...(stampPayments === undefined
        ? {}
        : {
            stampPayments: stampPayments.map((payment) => ({
              ...payment,
              valueWei: payment.valueWei.toString(),
            })),
          }),
    },
  };
  return JSON.stringify(stored);
}

export function deserializeMessageWrapper(value: string): MessageWrapper {
  const stored = JSON.parse(value) as JsonMessageWrapper;
  const { stampValueWei, stampPayments, ...message } = stored.message;
  return {
    ...stored,
    message: {
      ...message,
      ...(stampValueWei === undefined
        ? {}
        : { stampValueWei: parseStoredWei(stampValueWei) }),
      ...(stampPayments === undefined
        ? {}
        : {
            stampPayments: stampPayments.map((payment) => ({
              ...payment,
              valueWei: parseStoredWei(payment.valueWei) as bigint,
            })),
          }),
    },
  };
}

class MessageIterator implements AsyncIterableIterator<MessageWrapper> {
  iterator: any;
  db: LevelDB;

  constructor(db: LevelDB) {
    this.db = db;
  }

  async next(): Promise<IteratorResult<MessageWrapper>> {
    while (true) {
      const entry = await new Promise<
        { key: string; value: string } | undefined
      >((resolve, reject) => {
        this.iterator.next((error: Error, key: string, value: string) => {
          if (error) {
            reject(error);
            return;
          }
          if (!key) {
            this.iterator.end((error: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve(undefined);
            });
            return;
          }
          resolve({ key, value });
        });
      });
      if (!entry) {
        return new MessageReturnResult();
      }
      if (
        entry.key !== metadataKeys.lastServerTime &&
        !legacyMessageDbPrefixes.some((prefix) => entry.key.startsWith(prefix))
      ) {
        return new MessageResult(deserializeMessageWrapper(entry.value));
      }
    }
  }

  async return(): Promise<IteratorResult<MessageWrapper>> {
    return new Promise((resolve, reject) => {
      this.iterator.end((error: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ done: true, value: undefined });
      });
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<MessageWrapper> {
    this.iterator = this.db.iterator({});
    return this;
  }
}

const currentSchemaVersion = 2;

/**
 * Message persistence with a crash-safe relay mailbox frontier.
 *
 * ## Why the frontier is derived, never persisted (browser receipt durability)
 *
 * The frontier for a recipient is recomputed from the durable records that justify it: inbound
 * message receipts plus suppression/quarantine anchors. It is deliberately NOT written as its own
 * row. On Node `level` (RocksDB) a `{ sync: true }` write is durable and completed writes survive
 * as an ordered prefix, so the previous receipt-put-then-cursor-batch sequencing was safe. The
 * browser build resolves `level` to `level-js`, which runs every write as its own default-
 * durability IndexedDB transaction, ignores the sync option, and does not promise that separately
 * completed transactions survive as an ordered prefix: a power loss could retain a later cursor
 * batch while losing the earlier receipt put, permanently skipping a delivered row. With no
 * persisted cursor, that unsafe state is unrepresentable -- the frontier can never name a time
 * whose receipt evidence is missing, because it is computed FROM that evidence. The cost is one
 * extra re-fetched (and digest-deduped) timestamp group after a restart.
 *
 * ## Suppression and quarantine anchors
 *
 * A deleted message's receipt must never redeliver, and a terminally undeliverable row (registry
 * says the sender has no account) must not pin the bounded inbox scan. Both are durable anchors
 * in the metadata database; like receipts they only ever RAISE the derived frontier. Tombstone
 * collection (dropping an anchor once the frontier has passed it) is intentionally absent: an
 * anchor dropped while the receipt evidence behind it was lost to relaxed writeback would let a
 * deleted message redeliver. Anchors are bounded by user deletions instead.
 */
export class LevelMessageStore implements MessageStore {
  private messageDbLocation: string;
  private metadataDbLocation: string;
  private schemaVersion?: number;
  private openedDb?: LevelDB;
  private openedMetadataDb?: LevelDB;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(location: string) {
    this.messageDbLocation = join(location, "messages");
    this.metadataDbLocation = join(location, "metadata");
  }

  async Open() {
    this.openedDb = level(this.messageDbLocation);
    this.openedMetadataDb = level(this.metadataDbLocation);

    const dbSchemaVersion = await this.getSchemaVersion();
    if (!dbSchemaVersion) {
      await this.setSchemaVersion(currentSchemaVersion);
    } else if (dbSchemaVersion < currentSchemaVersion) {
      // v2 remains able to read v1 records, whose Monad wei fields were absent (JSON.stringify
      // could not encode bigint). New and rewritten records use exact decimal strings.
      await this.setSchemaVersion(currentSchemaVersion);
    } else if (dbSchemaVersion === 4) {
      // Only the never-shipped pre-repair layout of this branch wrote schemaVersion 4, with
      // cursor/suppression rows inside the message database. An old v2 reader would wedge chat
      // restoration on those rows after a rollback. Sweep them into the metadata database (or
      // away) and record the store as v2 again; receipts themselves need no migration.
      await this.migrateLegacyMessageDbMetadata();
    } else if (dbSchemaVersion > currentSchemaVersion) {
      console.warn("Newer DB found. Client downgraded?");
    }
  }

  async Close() {
    await this.mutationQueue;
    await Promise.all([this.db.close(), this.metadataDb.close()]);
  }

  get db() {
    if (!this.openedDb) {
      throw new Error("No db opened");
    }
    return this.openedDb;
  }

  get metadataDb() {
    if (!this.openedMetadataDb) {
      throw new Error("No db opened");
    }
    return this.openedMetadataDb;
  }

  private getMetadataDatabase() {
    return level(this.messageDbLocation);
  }

  /** Moves legacy (never-shipped v4 layout) metadata rows out of the message database. */
  private async migrateLegacyMessageDbMetadata(): Promise<void> {
    const migration = this.mutationQueue.then(async () => {
      const staleKeys: string[] = [];
      // Legacy `relaySuppressionIndex:<address>` rows carry real tombstones worth keeping, keyed
      // per recipient in the row key itself; `relayCursor:<address>` rows are subsumed by the
      // derived frontier and are simply dropped.
      const mergedSuppressions = new Map<
        string,
        Map<string, StoredSuppression>
      >();
      await new Promise<void>((resolve, reject) => {
        const iterator = this.db.iterator({});
        const step = () => {
          iterator.next((error: Error, key: string, value: string) => {
            if (error) {
              iterator.end(() => reject(error));
              return;
            }
            if (!key) {
              iterator.end((endError: Error | undefined) => {
                if (endError) {
                  reject(endError);
                  return;
                }
                resolve();
              });
              return;
            }
            const prefix = legacyMessageDbPrefixes.find((prefix) =>
              key.startsWith(prefix)
            );
            if (prefix !== undefined) {
              staleKeys.push(key);
              if (prefix === suppressionIndexPrefix) {
                const recipient = key.slice(suppressionIndexPrefix.length);
                const byDigest =
                  mergedSuppressions.get(recipient) ??
                  new Map<string, StoredSuppression>();
                try {
                  const parsed = JSON.parse(value);
                  if (Array.isArray(parsed)) {
                    for (const entry of parsed) {
                      if (
                        entry !== null &&
                        typeof entry === "object" &&
                        typeof entry.payloadDigest === "string"
                      ) {
                        byDigest.set(entry.payloadDigest, {
                          payloadDigest: entry.payloadDigest,
                          receivedTime: isSafeRelayTimestamp(entry.receivedTime)
                            ? entry.receivedTime
                            : null,
                        });
                      }
                    }
                  }
                } catch {
                  // Unparsable rows are dropped with the rest; their receipts replay instead.
                }
                mergedSuppressions.set(recipient, byDigest);
              }
            }
            step();
          });
        };
        step();
      });
      if (mergedSuppressions.size > 0) {
        // Merge into whatever the metadata database already holds, preserving tombstones whose
        // receipt time was never observed.
        await (this.metadataDb as any).batch(
          [...mergedSuppressions].map(([recipient, byDigest]) => ({
            type: "put" as const,
            key: suppressionIndexKey(recipient),
            value: JSON.stringify([...byDigest.values()]),
          })),
          { sync: true }
        );
      }
      if (staleKeys.length > 0) {
        await (this.db as any).batch(
          staleKeys.map((key) => ({ type: "del" as const, key })),
          { sync: true }
        );
      }
      await this.setSchemaVersion(currentSchemaVersion);
    });
    this.mutationQueue = migration.then(
      () => undefined,
      () => undefined
    );
    await migration;
  }

  async getMessage(payloadDigest: string): Promise<MessageWrapper | undefined> {
    try {
      const value = await this.db.get(payloadDigest);
      return deserializeMessageWrapper(value);
    } catch (err: any) {
      if (err.type === "NotFoundError") {
        return;
      }
      throw err;
    }
  }

  async deleteMessage(payloadDigest: string): Promise<void> {
    const deletion = this.mutationQueue.then(() =>
      this.db.del(payloadDigest, { sync: true })
    );
    this.mutationQueue = deletion.then(
      () => undefined,
      () => undefined
    );
    await deletion;
  }

  private async suppressionIndex(
    recipientAddress: string
  ): Promise<StoredSuppression[]> {
    return this.readStoredSuppression(suppressionIndexKey(recipientAddress));
  }

  private async readStoredSuppression(
    key: string
  ): Promise<StoredSuppression[]> {
    try {
      const parsed = JSON.parse(await this.metadataDb.get(key));
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry): StoredSuppression[] => {
        if (
          entry === null ||
          typeof entry !== "object" ||
          typeof entry.payloadDigest !== "string"
        ) {
          return [];
        }
        // Corrupt timing metadata must not discard the deletion intent. Retain the tombstone as
        // unresolved so it can suppress a later authoritative relay receipt, but never use the
        // untrusted value for collection.
        return [
          {
            payloadDigest: entry.payloadDigest,
            receivedTime: isSafeRelayTimestamp(entry.receivedTime)
              ? entry.receivedTime
              : null,
          },
        ];
      });
    } catch (err: any) {
      if (err.type === "NotFoundError") return [];
      throw err;
    }
  }

  async suppressAndDelete(
    recipientAddress: string,
    payloadDigests: string[],
    suppressions: RelayDeliverySuppression[]
  ): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const byDigest = new Map(
        (await this.suppressionIndex(recipientAddress)).map((entry) => [
          entry.payloadDigest,
          entry.receivedTime,
        ])
      );
      for (const suppression of suppressions) {
        const receivedTime = suppression.receivedTime;
        if (receivedTime !== undefined && !isSafeRelayTimestamp(receivedTime)) {
          throw new Error("Unsafe relay receipt timestamp in suppression");
        }
        const existing = byDigest.get(suppression.payloadDigest);
        byDigest.set(
          suppression.payloadDigest,
          receivedTime ?? existing ?? null
        );
      }
      const entries = [...byDigest].map(([payloadDigest, receivedTime]) => ({
        payloadDigest,
        receivedTime,
      }));
      // Tombstones commit BEFORE the message rows disappear. A crash in between leaves the
      // message visible and its relay receipt anchored, so a retry completes the deletion; the
      // reverse order could resurrect a deleted message after a crash.
      await (this.metadataDb as any).batch(
        [
          entries.length === 0
            ? { type: "del", key: suppressionIndexKey(recipientAddress) }
            : {
                type: "put",
                key: suppressionIndexKey(recipientAddress),
                value: JSON.stringify(entries),
              },
        ],
        { sync: true }
      );
      await (this.db as any).batch(
        [...new Set(payloadDigests)].map((payloadDigest) => ({
          type: "del",
          key: payloadDigest,
        })),
        { sync: true }
      );
    });
    this.mutationQueue = mutation.then(
      () => undefined,
      () => undefined
    );
    await mutation;
  }

  async suppressedRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[]
  ): Promise<Set<string>> {
    const mutation = this.mutationQueue.then(async () => {
      const entries = await this.suppressionIndex(recipientAddress);
      const byDigest = new Map(
        entries.map((entry) => [entry.payloadDigest, entry.receivedTime])
      );
      const suppressed = new Set<string>();
      let changed = false;
      for (const receipt of receipts) {
        if (!isSafeRelayTimestamp(receipt.receivedTime)) {
          throw new Error("Unsafe relay receipt timestamp");
        }
        if (!byDigest.has(receipt.payloadDigest)) continue;
        suppressed.add(receipt.payloadDigest);
        if (byDigest.get(receipt.payloadDigest) === null) {
          byDigest.set(receipt.payloadDigest, receipt.receivedTime);
          changed = true;
        }
      }
      if (changed) {
        // Recording the observed receipt time turns the tombstone into a frontier anchor (see
        // `relayCursor`), so the suppressed relay row cannot pin a bounded inbox scan.
        await this.metadataDb.put(
          suppressionIndexKey(recipientAddress),
          JSON.stringify(
            [...byDigest].map(([payloadDigest, receivedTime]) => ({
              payloadDigest,
              receivedTime,
            }))
          ),
          { sync: true }
        );
      }
      return suppressed;
    });
    this.mutationQueue = mutation.then(
      () => undefined,
      () => undefined
    );
    return mutation;
  }

  async quarantineRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[]
  ): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const existing = await this.readStoredSuppression(
        quarantineIndexKey(recipientAddress)
      );
      const byDigest = new Map(
        existing.map((entry) => [entry.payloadDigest, entry.receivedTime])
      );
      for (const receipt of receipts) {
        if (!isSafeRelayTimestamp(receipt.receivedTime)) {
          throw new Error("Unsafe relay receipt timestamp");
        }
        byDigest.set(receipt.payloadDigest, receipt.receivedTime);
      }
      await this.metadataDb.put(
        quarantineIndexKey(recipientAddress),
        JSON.stringify(
          [...byDigest].map(([payloadDigest, receivedTime]) => ({
            payloadDigest,
            receivedTime,
          }))
        ),
        { sync: true }
      );
    });
    this.mutationQueue = mutation.then(
      () => undefined,
      () => undefined
    );
    await mutation;
  }

  async saveMessage(
    messageWrapper: MessageWrapper,
    { advanceCursor = true }: { advanceCursor?: boolean } = {}
  ): Promise<void> {
    const save = this.mutationQueue.then(async () => {
      if (!advanceCursor) {
        await this.db.put(
          messageWrapper.index,
          serializeMessageWrapper(messageWrapper),
          { sync: true }
        );
        return;
      }
      const lastServerTime = await this.mostRecentMessageTime();
      const nextServerTime = Math.max(
        lastServerTime,
        messageWrapper.message.serverTime
      );
      // level@7 exposes atomic batch writes at runtime, but this repository's legacy `LevelDB`
      // type alias omits the method.
      await (this.db as any).batch(
        [
          {
            type: "put",
            key: messageWrapper.index,
            value: serializeMessageWrapper(messageWrapper),
          },
          {
            type: "put",
            key: metadataKeys.lastServerTime,
            value: JSON.stringify(nextServerTime),
          },
        ],
        { sync: true }
      );
    });
    this.mutationQueue = save.then(
      () => undefined,
      () => undefined
    );
    await save;
  }

  async mostRecentMessageTime(newLastServerTime?: number): Promise<number> {
    const jsonNewLastServerTime = JSON.stringify(newLastServerTime || 0);
    try {
      const lastServerTimeString: string = await this.db.get(
        metadataKeys.lastServerTime
      );
      const lastServerTime = JSON.parse(lastServerTimeString);
      if (!lastServerTime) {
        await this.db.put(metadataKeys.lastServerTime, jsonNewLastServerTime);
      }
      if (!newLastServerTime) {
        return JSON.parse(lastServerTime);
      }
      if (lastServerTime < newLastServerTime) {
        await this.db.put(metadataKeys.lastServerTime, jsonNewLastServerTime);
      }
      return Math.max(newLastServerTime, lastServerTime);
    } catch (err: any) {
      if (err.type === "NotFoundError") {
        if (newLastServerTime) {
          await this.db.put(metadataKeys.lastServerTime, jsonNewLastServerTime);
          return newLastServerTime;
        }
        return 0;
      }
      throw err;
    }
  }

  /** Recipient-scoped mailbox frontier, as an INCLUSIVE relay timestamp. Derived from the
   * durable receipt evidence only -- see the class header. Legacy metadata-database cursors from
   * earlier layouts are deliberately not trusted: those cursors predate same-evidence ordering
   * and replaying from the receipts is the conservative answer (duplicate relay rows are already
   * idempotent by payload digest). */
  async relayCursor(recipientAddress: string): Promise<number> {
    const recipient = recipientAddress.toLowerCase();
    let frontier = 0;
    await new Promise<void>((resolve, reject) => {
      const iterator = this.db.iterator({});
      const step = () => {
        iterator.next((error: Error, key: string, value: string) => {
          if (error) {
            iterator.end(() => reject(error));
            return;
          }
          if (!key) {
            iterator.end((endError: Error | undefined) => {
              if (endError) {
                reject(endError);
                return;
              }
              resolve();
            });
            return;
          }
          if (key === metadataKeys.lastServerTime) {
            step();
            return;
          }
          try {
            const parsed = JSON.parse(value);
            const message = parsed?.message;
            if (
              message?.outbound === false &&
              typeof message.destinationAddress === "string" &&
              message.destinationAddress.toLowerCase() === recipient &&
              isSafeRelayTimestamp(message.receivedTime)
            ) {
              frontier = Math.max(frontier, message.receivedTime);
            }
          } catch {
            // A corrupt row has no usable receipt evidence; restore surfaces it separately.
          }
          step();
        });
      };
      step();
    });
    for (const entry of await this.suppressionIndex(recipient)) {
      if (entry.receivedTime !== null) {
        frontier = Math.max(frontier, entry.receivedTime);
      }
    }
    for (const entry of await this.readStoredSuppression(
      quarantineIndexKey(recipient)
    )) {
      if (entry.receivedTime !== null) {
        frontier = Math.max(frontier, entry.receivedTime);
      }
    }
    return frontier;
  }

  private async getSchemaVersion(): Promise<number> {
    if (this.schemaVersion) {
      return this.schemaVersion;
    }

    try {
      const value: string = await this.metadataDb.get(
        metadataKeys.schemaVersion
      );
      return JSON.parse(value);
    } catch (err: any) {
      if (err.type === "NotFoundError") {
        return 0;
      }
      throw err;
    }
  }

  private async setSchemaVersion(schemaVersion: number): Promise<void> {
    await this.metadataDb.put(
      metadataKeys.schemaVersion,
      JSON.stringify(schemaVersion)
    );
    // Update cache
    this.schemaVersion = schemaVersion;
  }

  async getIterator(): Promise<AsyncIterableIterator<MessageWrapper>> {
    return new MessageIterator(this.db);
  }

  /**
   * This will delete everything in the store! Don't call it by accident!
   */
  async clear() {
    const clearing = this.mutationQueue.then(async () => {
      await this.db.clear();
      await this.metadataDb.clear();
    });
    this.mutationQueue = clearing.then(
      () => undefined,
      () => undefined
    );
    await clearing;
  }
}
