import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type { Message, MessageWrapper } from "../../types/messages";
import {
  deserializeMessageWrapper,
  LevelMessageStore,
  serializeMessageWrapper,
} from "./level-storage";

const LARGE_WEI = 123_456_789_012_345_678_901n;

function wrapper(index = "payload-digest"): MessageWrapper {
  return {
    index,
    outbound: true,
    senderAddress: "sender",
    copartyAddress: "recipient",
    message: {
      outbound: true,
      status: "confirmed",
      receivedTime: 123,
      serverTime: 456,
      items: [{ type: "text", text: "hello" }],
      outpoints: [],
      senderAddress: "sender",
      stampValueWei: LARGE_WEI,
      stampPayments: [
        {
          txHash: "0xabc",
          destinationAddress: "0xdef",
          valueWei: LARGE_WEI - 1n,
        },
      ],
    },
  };
}

/** An inbound relay receipt for `recipient`, the only row kind that anchors the frontier.
 * `destinationAddress` is carried at runtime for relay receipts (see `stores/chats.ts`'s
 * `messageDestinationAddress`) but predates the Monad field on `messages.ts`'s `Message`. */
function inbound(
  index: string,
  receivedTime: number,
  recipient = "0xAa"
): MessageWrapper {
  const message: Message & { destinationAddress?: string } = {
    outbound: false,
    status: "confirmed",
    receivedTime,
    serverTime: receivedTime,
    items: [{ type: "text", text: "hello" }],
    outpoints: [],
    senderAddress: "sender",
    destinationAddress: recipient,
  };
  return {
    index,
    outbound: false,
    senderAddress: "sender",
    copartyAddress: recipient,
    message,
  };
}

/** A pre-#420 v2 reader iterates every message-database row, skips only `lastServerTime`, and
 * feeds each remaining value to `deserializeMessageWrapper` -- exactly this. */
async function v2ReaderRows(
  db: RawDb
): Promise<Array<{ key: string; value: string }>> {
  const rows: Array<{ key: string; value: string }> = [];
  await new Promise<void>((resolve, reject) => {
    const iterator = (db as any).iterator({});
    const step = () =>
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
        rows.push({ key, value });
        step();
      });
    step();
  });
  return rows;
}

type RawDb = {
  put(key: string, value: string, options?: unknown): Promise<void>;
  get(key: string): Promise<string>;
  batch(
    operations: Array<{ type: string; key: string; value?: string }>,
    options?: unknown
  ): Promise<void>;
};

const rawDb = (store: LevelMessageStore, name: "db" | "metadataDb") =>
  Reflect.get(store, name) as unknown as RawDb;

describe("LevelMessageStore", () => {
  it("round-trips financial integers beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const encoded = serializeMessageWrapper(wrapper());

    expect(encoded).toContain(`\"stampValueWei\":\"${LARGE_WEI}\"`);
    expect(deserializeMessageWrapper(encoded)).toEqual(wrapper());
  });

  it("rejects unsafe legacy JSON numbers instead of silently changing their value", () => {
    const sample = wrapper();
    const encoded = JSON.stringify({
      ...sample,
      message: {
        ...sample.message,
        stampValueWei: Number.MAX_SAFE_INTEGER + 1,
        stampPayments: undefined,
      },
    });

    expect(() => deserializeMessageWrapper(encoded)).toThrow(
      "Stored wei value is not a safe non-negative integer"
    );
  });

  it("commits a message and its resume cursor together and keeps deletion durable", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-message-store-"));
    const store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.saveMessage(wrapper(), { advanceCursor: false });

      expect(await store.getMessage("payload-digest")).toEqual(wrapper());
      expect(await store.mostRecentMessageTime()).toBe(0);

      const inboundRow = wrapper("inbound-digest");
      inboundRow.outbound = false;
      inboundRow.message.outbound = false;
      await store.saveMessage(inboundRow);
      expect(await store.mostRecentMessageTime()).toBe(456);

      const persisted: MessageWrapper[] = [];
      for await (const message of await store.getIterator()) {
        persisted.push(message);
      }
      expect(persisted).toEqual([inboundRow, wrapper()]);

      await store.deleteMessage("payload-digest");
      expect(await store.getMessage("payload-digest")).toBeUndefined();
      expect(await store.mostRecentMessageTime()).toBe(456);
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("derives the frontier from inbound receipts only and never persists a cursor row", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-message-cursor-"));
    const store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.saveMessage(inbound("in-500", 500));
      // Outbound rows to another recipient, self-route loopbacks, and pending sends are not
      // receipt evidence for this mailbox; the legacy global metadata cursor is ignored too.
      const loopback = wrapper("self-loopback") as MessageWrapper & {
        message: Message & { destinationAddress?: string };
      };
      loopback.message.destinationAddress = "0xAa";
      loopback.message.receivedTime = 9000;
      await store.saveMessage(loopback, { advanceCursor: false });
      const pending = wrapper("pending-self") as MessageWrapper & {
        message: Message & { destinationAddress?: string };
      };
      pending.message.destinationAddress = "0xAa";
      pending.message.status = "pending";
      await store.saveMessage(pending, { advanceCursor: false });
      const metadataDb = rawDb(store, "metadataDb");
      await metadataDb.put("relayCursor:0xaa", JSON.stringify(8000));

      expect(await store.relayCursor("0xAa")).toBe(500);
      expect(await store.relayCursor("0xbb")).toBe(0);

      // Case-insensitive recipient scoping.
      expect(await store.relayCursor("0xaA")).toBe(500);

      // No cursor row may exist in the message database (and the store never writes one to the
      // metadata database either): the unsafe state where saved progress outruns a lost receipt
      // is unrepresentable by construction.
      await expect(
        rawDb(store, "db").get("relayCursor:0xaa")
      ).rejects.toMatchObject({ type: "NotFoundError" });
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("derives the frontier only from rows with safe receipt evidence", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-message-cursor-"));
    const store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.saveMessage(inbound("in-100", 100));
      const unsafe = inbound("in-unsafe", 100);
      unsafe.message = {
        ...unsafe.message,
        receivedTime: "9007199254740992" as unknown as number,
      };
      await store.saveMessage(unsafe, { advanceCursor: false });
      const future = inbound("in-future", Date.now() + 6 * 60 * 1000);
      await store.saveMessage(future, { advanceCursor: false });

      expect(await store.relayCursor("0xAa")).toBe(100);
      await expect(
        store.quarantineRelayReceipts("0xAa", [
          { payloadDigest: "poison", receivedTime: -1 },
        ])
      ).rejects.toThrow("Unsafe relay receipt timestamp");
      expect(await store.relayCursor("0xAa")).toBe(100);
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("keeps delayed-receipt suppression durable and anchors the frontier once observed", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-suppression-"));
    let store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.suppressAndDelete(
        "0xAa",
        [],
        [{ payloadDigest: "delayed-receipt" }]
      );
      // An unobserved tombstone has no receipt evidence and cannot anchor the frontier.
      expect(await store.relayCursor("0xaA")).toBe(0);
      await store.Close();

      store = new LevelMessageStore(location);
      await store.Open();
      const receipt = {
        payloadDigest: "delayed-receipt",
        receivedTime: 456,
      };
      expect(await store.suppressedRelayReceipts("0xaa", [receipt])).toEqual(
        new Set(["delayed-receipt"])
      );
      // Observing the receipt time turns the tombstone into a frontier anchor, so the
      // suppressed relay row cannot pin the inclusive replay window.
      expect(await store.relayCursor("0xAA")).toBe(456);
      // Tombstones are never collected: an anchor dropped while its receipt evidence could be
      // re-fetched would let a deleted message redeliver. Suppression keeps holding.
      expect(await store.suppressedRelayReceipts("0xAA", [receipt])).toEqual(
        new Set(["delayed-receipt"])
      );
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("hides suppression metadata from message iteration", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-suppression-"));
    const store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.suppressAndDelete(
        "0xAa",
        [],
        [{ payloadDigest: "not-a-message" }]
      );
      const persisted: MessageWrapper[] = [];
      for await (const message of await store.getIterator()) {
        persisted.push(message);
      }
      expect(persisted).toEqual([]);
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("keeps the message when the tombstone commit fails, and completes deletion on retry", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-suppression-fault-"));
    const store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.saveMessage(inbound("deleted-receipt", 456));
      const metadataDb = rawDb(store, "metadataDb");
      const batch = jest
        .spyOn(metadataDb, "batch")
        .mockRejectedValueOnce(new Error("tombstone commit failed"));
      await expect(
        store.suppressAndDelete(
          "0xAa",
          ["deleted-receipt"],
          [{ payloadDigest: "deleted-receipt", receivedTime: 456 }]
        )
      ).rejects.toThrow("tombstone commit failed");
      // The tombstone commits BEFORE the message rows disappear, so an interrupted deletion
      // never loses a message whose relay row could still be re-fetched.
      expect(await store.getMessage("deleted-receipt")).toEqual(
        inbound("deleted-receipt", 456)
      );
      batch.mockRestore();

      await store.suppressAndDelete(
        "0xAa",
        ["deleted-receipt"],
        [{ payloadDigest: "deleted-receipt", receivedTime: 456 }]
      );
      expect(await store.getMessage("deleted-receipt")).toBeUndefined();
      expect(await store.relayCursor("0xaA")).toBe(456);
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("never pins the frontier past a receipt the browser lost (fault-injected relaxed durability)", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-cursor-fault-"));
    let store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.saveMessage(inbound("kept", 500));

      // level-js resolves every write as its own default-durability IndexedDB transaction and
      // ignores { sync: true }. A power loss may lose this completed receipt put while keeping
      // earlier ones. Simulate exactly that: the write "succeeds" but never persists.
      const db = rawDb(store, "db");
      const realPut = db.put.bind(db);
      db.put = (key, value, options) =>
        key === "lost" ? Promise.resolve() : realPut(key, value, options);
      // Poll deliveries persist receipts with `advanceCursor: false` (a single put per
      // receipt) -- exactly the write this fault targets.
      await store.saveMessage(inbound("lost", 700), { advanceCursor: false });
      db.put = realPut;
      await store.Close();

      // "Power restored": a fresh process opens the same store.
      store = new LevelMessageStore(location);
      await store.Open();
      expect(await store.getMessage("lost")).toBeUndefined();
      expect(await store.getMessage("kept")).toEqual(inbound("kept", 500));
      // The derived frontier is computed FROM durable receipts, so it cannot name a time whose
      // receipt evidence is missing: the poll resumes inclusively at 500 and re-fetches the
      // lost row, instead of the old bug (cursor batch survived, receipt lost, row skipped).
      expect(await store.relayCursor("0xAa")).toBe(500);

      // The next poll redelivers the row and dedupes by digest; the frontier then covers it.
      await store.saveMessage(inbound("lost", 700), { advanceCursor: false });
      expect(await store.relayCursor("0xAa")).toBe(700);

      // No cursor row exists anywhere: the crash-unsafe state is unrepresentable.
      await expect(
        rawDb(store, "metadataDb").get("relayCursor:0xaa")
      ).rejects.toMatchObject({
        type: "NotFoundError",
      });
      await expect(
        rawDb(store, "db").get("relayCursor:0xaa")
      ).rejects.toMatchObject({
        type: "NotFoundError",
      });
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("anchors the frontier on quarantined terminal receipts and bounds a poisoned backlog", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-quarantine-"));
    let store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.quarantineRelayReceipts("0xAa", [
        { payloadDigest: "poison-a", receivedTime: 100 },
      ]);
      await store.Close();

      store = new LevelMessageStore(location);
      await store.Open();
      // The quarantine survives the restart and anchors the frontier inclusively, so the
      // terminal row is re-fetched at most once per restart, re-classified (idempotent), and
      // never pins the scan.
      expect(await store.relayCursor("0xAa")).toBe(100);

      // Bounded backlog: newer valid mail raises the frontier past the poisoned prefix.
      await store.saveMessage(inbound("valid-900", 900));
      expect(await store.relayCursor("0xAa")).toBe(900);
      expect(await store.relayCursor("0xBb")).toBe(0);
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("sweeps a never-shipped v4 layout so a rolled-back v2 reader never wedges", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-v4-rollback-"));
    let store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.saveMessage(inbound("kept", 400));
      // Simulate the earlier pre-repair layout: metadata rows inside the message database and
      // schemaVersion 4 recorded in the metadata database.
      const db = rawDb(store, "db");
      const metadataDb = rawDb(store, "metadataDb");
      await db.put("relayCursor:0xaa", JSON.stringify(5000));
      await db.put(
        "relaySuppressionIndex:0xaa",
        JSON.stringify([{ payloadDigest: "gone", receivedTime: 456 }])
      );
      await metadataDb.put("schemaVersion", JSON.stringify(4));
      await store.Close();

      store = new LevelMessageStore(location);
      const warnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      await store.Open();
      expect(warnSpy).not.toHaveBeenCalled();
      // The message database holds only real messages again; the tombstone survived (it is
      // receipt evidence) and anchors the frontier past the migrated rows.
      expect(await store.relayCursor("0xaA")).toBe(456);
      const persisted: MessageWrapper[] = [];
      for await (const message of await store.getIterator()) {
        persisted.push(message);
      }
      expect(persisted).toEqual([inbound("kept", 400)]);
      warnSpy.mockRestore();
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });

  it("a schema-v2 reader opening this store finds only real messages (rollback coverage)", async () => {
    const location = await mkdtemp(join(tmpdir(), "frank-v2-reader-"));
    let store = new LevelMessageStore(location);
    try {
      await store.Open();
      await store.saveMessage(inbound("in-500", 500));
      await store.saveMessage(wrapper("outbound-row"), {
        advanceCursor: false,
      });
      await store.suppressAndDelete(
        "0xAa",
        [],
        [{ payloadDigest: "tombstoned" }]
      );
      await store.quarantineRelayReceipts("0xAa", [
        { payloadDigest: "poison", receivedTime: 100 },
      ]);
      await store.Close();

      // A pre-#420 build (schema v2) reopens the same location. Its Open() sees an equal
      // schema version, so it warns about nothing and continues.
      store = new LevelMessageStore(location);
      const warnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      await store.Open();
      expect(warnSpy).not.toHaveBeenCalled();

      // Its iterator filters only `lastServerTime` and feeds every other row to
      // deserializeMessageWrapper. Chat restoration must not wedge: the message database
      // contains only real message rows. Run the v2 reader's exact iteration semantics.
      const db = rawDb(store, "db");
      const rawRows = await v2ReaderRows(db);
      // level orders keys lexicographically.
      expect(rawRows.map((row) => row.key)).toEqual([
        "in-500",
        "lastServerTime",
        "outbound-row",
      ]);
      const restored = rawRows
        .filter((row) => row.key !== "lastServerTime")
        .map((row) => deserializeMessageWrapper(row.value));
      expect(restored).toEqual([
        inbound("in-500", 500),
        wrapper("outbound-row"),
      ]);
      warnSpy.mockRestore();
    } finally {
      await store.Close();
      await rm(location, { recursive: true, force: true });
    }
  });
});
