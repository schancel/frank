/**
 * Tests for `mailbox-client.ts`: the auth preimage and the canonical private mailbox readers.
 *
 * The preimage vectors below come from the Rust `mailbox_auth_preimage`
 * (`backend/cashweb/cashweb-registry/src/monad_mailbox.rs`) over fixed inputs (epoch=0x11..,
 * nonce=0x22.., expires=1_700_000_060_000, token=0x33.., recipient=0xab*20, origin
 * https://relay.example.com). `inboxNoCursor` is also asserted byte for byte by the Rust test
 * `the_preimage_names_the_relay_origin_and_matches_the_client_vector`, so the TypeScript builder
 * is pinned to the real relay bytes, not merely to this repo's own re-derivation.
 */
import { createHash } from "crypto";

export const mockWsInstances: Array<{ url: string; close: jest.Mock }> = [];
jest.mock("isomorphic-ws", () => {
  return jest.fn().mockImplementation((url: string) => {
    const instance = {
      url,
      close: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
    };
    mockWsInstances.push(instance);
    return instance;
  });
});

import { sha256 } from "@frank/crypto-box";

import {
  MAILBOX_AUTH_DOMAIN,
  MailboxChallenge,
  MonadMailboxProtocolError,
  bytesToHex,
  buildMailboxAuthPreimage,
  mailboxAuthDigest,
} from "./mailbox-client";

const BASE = "https://relay.example.com";
const RUST = {
  inboxNoCursor:
    "6672616e6b3a6d61696c626f782d687474702d617574683a7633000000001968747470733a2f2f72656c61792e6578616d706c652e636f6d111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f696e626f782f01abababababababababababababababababababab0000018bcfe568000000000000000000640000000000404000000000044d4f4e54",
  inboxCursorNoTag:
    "6672616e6b3a6d61696c626f782d687474702d617574683a7633000000001968747470733a2f2f72656c61792e6578616d706c652e636f6d111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f696e626f782f01abababababababababababababababababababab000000000000000501000000bc30313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130320000000000000032000000000000040000000000",
  recoveryAck:
    "6672616e6b3a6d61696c626f782d687474702d617574683a7633000000001968747470733a2f2f72656c61792e6578616d706c652e636f6d111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333504f5354002f6d6573736167652f6d6f6e61642f7265636f766572792d61636b2f03abababababababababababababababababababab0000000000000000000000000000000001000000000000000044444444444444444444444444444444444444444444444444444444444444445555555555555555555555555555555555555555555555555555555555555555000000044d4f4e54",
  recovery:
    "6672616e6b3a6d61696c626f782d687474702d617574683a7633000000001968747470733a2f2f72656c61792e6578616d706c652e636f6d111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f7265636f766572792f02abababababababababababababababababababab000000000000000000000000000000001400000000000003e8000000044d4f4e54",
};
const RUST_CURSOR = "0102".repeat(47);

const RECIPIENT = "0x" + "ab".repeat(20);
function challengeFor(
  resource: MailboxChallenge["resource"],
  overrides: Partial<MailboxChallenge>
): MailboxChallenge {
  return {
    epoch: "11".repeat(32),
    nonce: "22".repeat(32),
    expires_at_ms: 1_700_000_060_000,
    token: "33".repeat(32),
    signing_domain: MAILBOX_AUTH_DOMAIN,
    resource,
    since: 0,
    cursor: null,
    limit: 20,
    max_bytes: 1000,
    network_tag: "4d4f4e54",
    recovery_payload_hash: null,
    recovery_obligation_id: null,
    ...overrides,
  };
}

describe("buildMailboxAuthPreimage (pinned to bytes from the Rust mailbox_auth_preimage)", () => {
  it("inbox without cursor, network tag MONT", () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor("inbox", {
        since: 1_700_000_000_000,
        limit: 100,
        max_bytes: 4_210_688,
      }),
      RECIPIENT,
      BASE
    );
    expect(bytesToHex(preimage)).toBe(RUST.inboxNoCursor);
  });

  it("inbox with an opaque cursor token and an empty network tag", () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor("inbox", {
        since: 5,
        cursor: RUST_CURSOR,
        limit: 50,
        max_bytes: 1024,
        network_tag: "",
      }),
      RECIPIENT,
      BASE
    );
    expect(bytesToHex(preimage)).toBe(RUST.inboxCursorNoTag);
  });

  it("recovery_ack binds payload hash and obligation id, POST recovery-ack path", () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor("recovery_ack", {
        limit: 1,
        max_bytes: 0,
        recovery_payload_hash: "44".repeat(32),
        recovery_obligation_id: "55".repeat(32),
      }),
      RECIPIENT,
      BASE
    );
    expect(bytesToHex(preimage)).toBe(RUST.recoveryAck);
  });

  it("recovery", () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor("recovery", { limit: 20, max_bytes: 1000 }),
      RECIPIENT,
      BASE
    );
    expect(bytesToHex(preimage)).toBe(RUST.recovery);
  });

  it("names the relay origin and never takes the domain from the challenge", () => {
    const challenge = challengeFor("inbox", {});
    const here = buildMailboxAuthPreimage(challenge, RECIPIENT, BASE);
    expect(Buffer.from(here).includes(Buffer.from(BASE))).toBe(true);
    expect(
      buildMailboxAuthPreimage(
        challenge,
        RECIPIENT,
        "https://relay.example.org"
      )
    ).not.toEqual(here);
    expect(
      buildMailboxAuthPreimage(
        { ...challenge, signing_domain: "frank:something-else:v1" },
        RECIPIENT,
        BASE
      )
    ).toEqual(here);
  });

  it("hashes with plain SHA-256", () => {
    // SHA-256 of the empty string. Node, crypto-box, and sha2::Sha256 agree.
    const empty = mailboxAuthDigest(new Uint8Array());
    expect(bytesToHex(empty)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(bytesToHex(empty)).toBe(
      Buffer.from(sha256(new Uint8Array())).toString("hex")
    );

    const preimage = buildMailboxAuthPreimage(
      challengeFor("recovery", {}),
      RECIPIENT,
      BASE
    );
    expect(bytesToHex(preimage)).toBe(RUST.recovery);
    const digest = bytesToHex(mailboxAuthDigest(preimage));
    expect(digest).toBe(createHash("sha256").update(preimage).digest("hex"));
    expect(digest).toBe(
      Buffer.from(sha256(Uint8Array.from(preimage))).toString("hex")
    );
  });

  it("rejects a malformed challenge instead of signing it", () => {
    expect(() =>
      buildMailboxAuthPreimage(
        challengeFor("inbox", { epoch: "zz" }),
        RECIPIENT,
        BASE
      )
    ).toThrow(MonadMailboxProtocolError);
    expect(() =>
      buildMailboxAuthPreimage(
        challengeFor("bogus" as MailboxChallenge["resource"], {}),
        RECIPIENT,
        BASE
      )
    ).toThrow(MonadMailboxProtocolError);
  });
});

// Canonical namespace: real public directory admission, bounded byte streams and exact wire parts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressFromCompressedPubkey,
  cborMap,
  defaultContext,
  encodeCanonical,
  encodeFrame,
  fromHex,
  toHex,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  validateFrame,
  verifyPreviewDirectoryEvidence,
} from "@frank/codec";
import { openNodeDirectoryStore } from "@frank/directory-admission/node";
import type { Context, DirectoryStore } from "@frank/directory-admission";
import {
  freezeCanonicalRequest,
  inspectCanonicalPair,
  type CanonicalFetch,
  type CanonicalStreamResponse,
} from "./canonical-dm-transport";
import {
  connectCanonicalMailboxStream,
  fetchCanonicalInboxPage,
  fetchCanonicalMailboxPage,
  type CanonicalMailboxAuthParams,
} from "./mailbox-client";

const canonicalWire = JSON.parse(
  readFileSync(
    join(__dirname, "../../../docs/protocol/cbor/vectors/dm-runtime.json"),
    "utf8"
  )
).canonical_facade_final_http_case.wire;
const canonicalRaw = fromHex(
  "02f88982279f80010282c350942adf2cb0d2a8f42fd83e2c32912654a8ac76a45501a5504f4e44019d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f057c001a02d18d2d071778208389595d3110fe779a78cef3d25b7ebdd163df663167466f0a01e371c5d156bb5e4009df9006e84035e8e83c1200196da0cd3441a85e6d0a468"
);
const canonicalTxHash = fromHex(
  "813129d69040c1f275a87a80d85d214d02f3b94649a584999ef662c3d39199f4"
);
const canonicalText = (s: string) => new TextEncoder().encode(s);
const canonicalConcat = (...parts: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(parts));
function canonicalDelivery(): Uint8Array {
  const parsed = validateFrame(
    fromHex(canonicalWire.delivery),
    defaultContext()
  );
  if (parsed.kind !== "parsed" || !(parsed.payload instanceof Map))
    throw new Error("fixture");
  const payload = new Map(parsed.payload),
    value = new Uint8Array(32);
  value[31] = 1;
  payload.set(4n, [
    cborMap([
      [0, 0],
      [1, canonicalTxHash],
      [2, value],
      [3, fromHex(canonicalWire.destination)],
      [4, fromHex(canonicalWire.t4)],
    ]),
  ]);
  return encodeFrame(
    { typeId: TYPE_DIRECT_MESSAGE_DELIVERY, schemaVersion: 1, minReaderVersion: 1 },
    payload
  );
}
/** The fixture delivery as an unpaid message: schema 2 with an empty payment list. */
function canonicalUnpaidDelivery(): Uint8Array {
  const parsed = validateFrame(canonicalDelivery(), defaultContext());
  if (parsed.kind !== "parsed" || !(parsed.payload instanceof Map))
    throw new Error("fixture");
  const payload = new Map(parsed.payload);
  payload.set(4n, []);
  return encodeFrame(
    { typeId: TYPE_DIRECT_MESSAGE_DELIVERY, schemaVersion: 2, minReaderVersion: 1 },
    payload
  );
}
function canonicalPayloadBytes(frame: Uint8Array): Uint8Array {
  const parsed = validateFrame(frame, defaultContext());
  if (parsed.kind !== "parsed") throw new Error("fixture");
  return parsed.payloadBytes;
}
/** A page of pair records, framed as the relay frames them. */
function canonicalRecordsPage(
  records: readonly {
    delivery: Uint8Array;
    context: Uint8Array;
    identity: string;
    timestampMs: number;
    direction?: string;
  }[]
): Uint8Array {
  return canonicalConcat(
    ...records.flatMap((record) => [
      canonicalText(
        `--page\r\nContent-Disposition: inline; name="record"\r\nContent-Type: multipart/mixed; boundary=record\r\nX-Frank-Submission-Identity: ${
          record.identity
        }\r\nX-Frank-Mailbox-Timestamp-Ms: ${record.timestampMs}\r\n${
          record.direction === undefined
            ? ""
            : `X-Frank-Mailbox-Direction: ${record.direction}\r\n`
        }\r\n`
      ),
      canonicalNested(
        [
          {
            name: "delivery",
            media: "application/vnd.frank.cbor",
            bytes: record.delivery,
          },
          {
            name: "context",
            media: "application/cbor",
            bytes: record.context,
          },
        ],
        "record"
      ),
      canonicalText("\r\n"),
    ]),
    canonicalText("--page--\r\n")
  );
}
function canonicalStream(
  url: string,
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string> = {}
): CanonicalStreamResponse {
  let at = 0;
  return {
    url,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          at >= bytes.length
            ? { done: true }
            : { done: false, value: bytes.slice(at, (at += 19)) },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  };
}
function canonicalNested(
  parts: readonly { name: string; media: string; bytes: Uint8Array }[],
  boundary: string
): Uint8Array {
  return canonicalConcat(
    ...parts.flatMap((part) => [
      canonicalText(
        `--${boundary}\r\nContent-Disposition: inline; name="${part.name}"\r\nContent-Type: ${part.media}\r\n\r\n`
      ),
      part.bytes,
      canonicalText("\r\n"),
    ]),
    canonicalText(`--${boundary}--\r\n`)
  );
}
function canonicalPage(
  recovery = false,
  metadataOverrides: Record<string, unknown> = {},
  directionHeaders = ""
): Uint8Array {
  const request = freezeCanonicalRequest(
    {
      delivery: canonicalDelivery(),
      context: fromHex(canonicalWire.context),
      transactions: [canonicalRaw],
    },
    "test-fixed"
  );
  const parts = [
    {
      name: "delivery",
      media: "application/vnd.frank.cbor",
      bytes: request.parts.delivery,
    },
    {
      name: "context",
      media: "application/cbor",
      bytes: request.parts.context,
    },
  ];
  if (recovery)
    parts.push(
      {
        name: "transactions",
        media: "application/cbor",
        bytes: encodeCanonical([canonicalRaw]),
      },
      {
        name: "recovery",
        media: "application/json",
        bytes: canonicalText(
          JSON.stringify({
            version: 1,
            submission_identity: request.identity.submission_identity,
            payload_hash: request.identity.payload_hash,
            obligation_id: "aa".repeat(32),
            confirmed_children: [0],
            lifecycle: "fully_confirmed",
            ...metadataOverrides,
          })
        ),
      }
    );
  return canonicalConcat(
    canonicalText(
      `--page\r\nContent-Disposition: inline; name="record"\r\nContent-Type: multipart/mixed; boundary=record\r\nX-Frank-Submission-Identity: ${request.identity.submission_identity}\r\nX-Frank-Mailbox-Timestamp-Ms: 1700000100000\r\n${directionHeaders}\r\n`
    ),
    canonicalNested(parts, "record"),
    canonicalText("\r\n--page--\r\n")
  );
}

describe("canonical private mailbox", () => {
  let root: string,
    store: DirectoryStore,
    auth: CanonicalMailboxAuthParams,
    context: Context;
  let requests: Parameters<CanonicalFetch>[], challenge: MailboxChallenge;
  let challengeOverrides: Partial<MailboxChallenge>,
    page: Uint8Array,
    pageHeaders: Record<string, string>,
    requestStatus: number;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "canonical-mailbox-"));
    const signed = verifyPreviewDirectoryEvidence(
      fromHex(canonicalWire.http_attestations[1]),
      "monad-testnet"
    );
    context = {
      now: { seconds: 1700000100n, nanoseconds: 0 },
      relay: signed.statement.relays[0],
    };
    store = await openNodeDirectoryStore({
      location: join(root, "db"),
      anchor: {
        network: "monad-testnet",
        subject: signed.statement.subject,
        revisionZero: signed.statementHash,
      },
      mode: { kind: "new" },
    });
    await store.enroll(
      [
        {
          statement: signed.statementFrame.frame,
          attestation: fromHex(canonicalWire.http_attestations[1]),
        },
      ],
      context
    );
    requests = [];
    challengeOverrides = {};
    page = canonicalPage();
    pageHeaders = { "content-type": "multipart/mixed; boundary=page" };
    requestStatus = 200;
    const fetch: CanonicalFetch = async (url, input) => {
      requests.push([url, input]);
      if (url.includes("/auth/")) {
        const query = new URL(url).searchParams;
        challenge = {
          epoch: "11".repeat(32),
          nonce: String(requests.length).padStart(64, "0"),
          expires_at_ms: Date.now() + 59000,
          token: "33".repeat(32),
          signing_domain: MAILBOX_AUTH_DOMAIN,
          resource: query.get("resource") as MailboxChallenge["resource"],
          since: Number(query.get("since")),
          cursor: query.get("cursor"),
          limit: Number(query.get("limit")),
          max_bytes: Number(query.get("max_bytes")),
          network_tag: "4d4f4e54",
          ...challengeOverrides,
        };
        return canonicalStream(
          url,
          200,
          canonicalText(JSON.stringify(challenge)),
          { "content-type": "application/json" }
        );
      }
      return canonicalStream(url, requestStatus, page, pageHeaders);
    };
    auth = {
      relayBaseUrl: signed.statement.relays[0].endpoint,
      recipient:
        "0x" +
        toHex(addressFromCompressedPubkey(signed.statement.subject.keyBytes)),
      subject: toHex(signed.statement.subject.keyBytes),
      expectedNetworkTag: "MONT",
      getCurrent: () => store.current(context),
      signDigest: jest.fn(async () => new Uint8Array(70)),
      fetch,
      retry: { maxAttempts: 1, sleep: async () => undefined },
    };
  });
  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  test("genuine admitted Current signs unchanged logical transcript and preserves private pair", async () => {
    const result = await fetchCanonicalInboxPage(auth);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].delivery).toEqual(canonicalDelivery());
    expect(result.records[0].context).toEqual(fromHex(canonicalWire.context));
    expect(auth.signDigest).toHaveBeenCalledWith(
      mailboxAuthDigest(
        buildMailboxAuthPreimage(challenge, auth.recipient, auth.relayBaseUrl)
      )
    );
    expect(
      new TextDecoder().decode(
        buildMailboxAuthPreimage(challenge, auth.recipient, auth.relayBaseUrl)
      )
    ).toContain("/message/monad/inbox/");
    expect(
      requests.every(([url]) => url.startsWith(auth.relayBaseUrl + "/message/"))
    ).toBe(true);
    expect(
      requests.every(
        ([, input]) => input.headers["x-frank-mailbox-subject"] === auth.subject
      )
    ).toBe(true);
    expect(challenge.limit).toBe(50);
    expect(challenge.max_bytes).toBe(8 * 1024 * 1024);
  });
  // The outer and inner framing matches record_multipart in
  // backend/cashweb/cashweb-registry/src/http/monad_message_cbor.rs, including the
  // direction header emitted by the combined endpoint and omitted by the inbox.
  test.each(["in", "out"] as const)(
    "authenticates and parses the relay's explicit %s combined-mailbox record",
    async (direction) => {
      page = canonicalPage(
        false,
        {},
        `X-Frank-Mailbox-Direction: ${direction}\r\n`
      );
      const result = await fetchCanonicalMailboxPage(auth);
      expect(result.records).toEqual([
        {
          direction,
          delivery: canonicalDelivery(),
          context: fromHex(canonicalWire.context),
          submissionIdentity: freezeCanonicalRequest(
            {
              delivery: canonicalDelivery(),
              context: fromHex(canonicalWire.context),
              transactions: [canonicalRaw],
            },
            "test-fixed"
          ).identity.submission_identity,
          timestampMs: 1700000100000,
        },
      ]);
      expect(challenge.resource).toBe("mailbox");
      expect(auth.signDigest).toHaveBeenCalledWith(
        mailboxAuthDigest(
          buildMailboxAuthPreimage(challenge, auth.recipient, auth.relayBaseUrl)
        )
      );
      expect(new URL(requests[1][0]).pathname).toBe(
        `/message/mailbox/${auth.recipient}`
      );
    }
  );
  test("requires direction on the combined mailbox while accepting the directionless inbox wire", async () => {
    await expect(fetchCanonicalMailboxPage(auth)).rejects.toThrow(/direction/);
    expect((await fetchCanonicalInboxPage(auth)).records).toHaveLength(1);
  });
  test("an unpaid delivery (schema 2, no payment) is an ordinary record on both readers", async () => {
    const unpaid = {
      delivery: canonicalUnpaidDelivery(),
      context: fromHex(canonicalWire.context),
      identity: "dd".repeat(32),
      timestampMs: 1700000100005,
    };
    expect(
      inspectCanonicalPair({
        delivery: unpaid.delivery,
        context: unpaid.context,
      }).transaction_hashes
    ).toEqual([]);
    page = canonicalRecordsPage([{ ...unpaid, direction: "in" }]);
    const mailbox = await fetchCanonicalMailboxPage(auth);
    expect(mailbox.records.map((r) => r.delivery)).toEqual([unpaid.delivery]);
    expect(mailbox.unreadable).toEqual([]);
    page = canonicalRecordsPage([unpaid]);
    const inbox = await fetchCanonicalInboxPage(auth);
    expect(inbox.records.map((r) => r.delivery)).toEqual([unpaid.delivery]);
    expect(inbox.unreadable).toEqual([]);
    // Schema 1 still requires a payment: that record is not readable.
    page = canonicalRecordsPage([
      {
        ...unpaid,
        delivery: encodeFrame(
          { typeId: TYPE_DIRECT_MESSAGE_DELIVERY, schemaVersion: 1, minReaderVersion: 1 },
          { bytes: canonicalPayloadBytes(unpaid.delivery) }
        ),
      },
    ]);
    const old = await fetchCanonicalInboxPage(auth);
    expect(old.records).toEqual([]);
    expect(old.unreadable).toHaveLength(1);
  });
  describe("a record this client cannot decode", () => {
    const good = (direction?: string) => ({
      delivery: canonicalDelivery(),
      context: fromHex(canonicalWire.context),
      identity: "aa".repeat(32),
      timestampMs: 1700000100002,
      direction,
    });
    const unreadable = [
      [
        "a corrupt context",
        () => ({
          delivery: canonicalDelivery(),
          context: fromHex(canonicalWire.context).slice(0, -1),
        }),
      ],
      [
        "bytes that are not a frame",
        () => ({
          delivery: canonicalText("not a frame"),
          context: fromHex(canonicalWire.context),
        }),
      ],
    ] as const;
    test.each(unreadable)(
      "with %s is listed as unreadable and the rest of the page is returned",
      async (_name, bad) => {
        const skipped = {
          ...bad(),
          identity: "bb".repeat(32),
          timestampMs: 1700000100001,
        };
        pageHeaders["x-frank-mailbox-next-cursor"] = "opaque-cursor";
        const listed = [
          { submissionIdentity: skipped.identity, timestampMs: 1700000100001 },
        ];
        // The unreadable record comes first: nothing after it is lost.
        page = canonicalRecordsPage([
          { ...skipped, direction: "in" },
          good("in"),
        ]);
        const mailbox = await fetchCanonicalMailboxPage(auth);
        expect(mailbox.records.map((r) => r.timestampMs)).toEqual([
          1700000100002,
        ]);
        expect(mailbox.records[0].delivery).toEqual(canonicalDelivery());
        expect(mailbox.unreadable).toEqual(listed);
        expect(mailbox.nextCursor).toBe("opaque-cursor");

        page = canonicalRecordsPage([skipped, good()]);
        const inbox = await fetchCanonicalInboxPage(auth);
        expect(inbox.records.map((r) => r.timestampMs)).toEqual([
          1700000100002,
        ]);
        expect(inbox.unreadable).toEqual(listed);
        expect(inbox.nextCursor).toBe("opaque-cursor");
      }
    );
    test("does not excuse a page whose framing or record headers are wrong", async () => {
      const skipped = {
        delivery: canonicalText("not a frame"),
        context: fromHex(canonicalWire.context),
        identity: "bb".repeat(32),
        timestampMs: 1700000100001,
      };
      // No direction on the combined mailbox.
      page = canonicalRecordsPage([skipped, good("in")]);
      await expect(fetchCanonicalMailboxPage(auth)).rejects.toThrow(
        /direction/
      );
      // A record identity or timestamp the relay never emits.
      page = canonicalRecordsPage([{ ...skipped, identity: "zz" }, good()]);
      await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow(
        /record headers/
      );
      page = canonicalRecordsPage([{ ...skipped, timestampMs: -1 }, good()]);
      await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow(
        /record headers/
      );
      // A page cut short.
      page = canonicalRecordsPage([skipped, good()]).slice(0, -3);
      await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow();
      // A readable record for someone else, or served twice, is still the relay's error.
      page = canonicalRecordsPage([
        skipped,
        good(),
        { ...good(), identity: "cc".repeat(32) },
      ]);
      await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow(/duplicate/);
      // A relay that is down or refuses the read.
      page = canonicalRecordsPage([skipped, good()]);
      requestStatus = 503;
      await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow();
    });
  });
  test.each([
    "X-Frank-Mailbox-Direction: unknown\r\n",
    "X-Frank-Mailbox-Direction: OUT\r\n",
    "X-Frank-Mailbox-Direction: in,out\r\n",
    "X-Frank-Mailbox-Direction: in \r\n",
    "X-Frank-Mailbox-Direction: \r\n",
    "X-Frank-Mailbox-Direction: out\r\nX-Frank-Mailbox-Direction: in\r\n",
    "X-Frank-Mailbox-Direction: out\r\nX-Unrecognized: value\r\n",
  ])(
    "rejects malformed or ambiguous combined direction headers %j",
    async (headers) => {
      page = canonicalPage(false, {}, headers);
      const publish = jest.fn();
      await expect(
        fetchCanonicalMailboxPage(auth).then(publish)
      ).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    }
  );
  test("direction does not bypass combined page byte, cardinality or nested-header limits", async () => {
    page = canonicalPage(false, {}, "X-Frank-Mailbox-Direction: out\r\n");
    const original = page;
    expect(
      (await fetchCanonicalMailboxPage({ ...auth, maxBytes: page.length }))
        .records
    ).toHaveLength(1);
    await expect(
      fetchCanonicalMailboxPage({ ...auth, maxBytes: page.length - 1 })
    ).rejects.toThrow(/byte limit/);
    page = canonicalConcat(original.slice(0, -10), original);
    await expect(
      fetchCanonicalMailboxPage({ ...auth, limit: 1 })
    ).rejects.toThrow();
    page = original.slice(0, -3);
    await expect(fetchCanonicalMailboxPage(auth)).rejects.toThrow();
    const marker = canonicalText(
      "Content-Type: application/vnd.frank.cbor\r\n"
    );
    const at = Buffer.from(original).indexOf(marker) + marker.length;
    expect(at).toBeGreaterThan(marker.length);
    page = canonicalConcat(
      original.slice(0, at),
      canonicalText("X-Frank-Mailbox-Direction: out\r\n"),
      original.slice(at)
    );
    await expect(fetchCanonicalMailboxPage(auth)).rejects.toThrow(
      /record parts/
    );
  });
  test("authenticates successfully when relayBaseUrl has a trailing slash", async () => {
    const trailingAuth = {
      ...auth,
      relayBaseUrl: auth.relayBaseUrl + "/",
    };
    const result = await fetchCanonicalInboxPage(trailingAuth);
    expect(result.records).toHaveLength(1);
  });
  test("authenticates successfully when directory statement has loopback relay endpoint and relayBaseUrl is tunnel/remote origin", async () => {
    const tunnelAuth = {
      ...auth,
      relayBaseUrl: "https://demo-app.ngrok-free.dev",
    };
    const result = await fetchCanonicalInboxPage(tunnelAuth);
    expect(result.records).toHaveLength(1);
    expect(auth.signDigest).toHaveBeenCalledWith(
      mailboxAuthDigest(
        buildMailboxAuthPreimage(challenge, auth.recipient, auth.relayBaseUrl)
      )
    );
  });
  // The dev app reaches the relay through its own origin (the Quasar dev proxy) while the
  // relay's configured endpoint is its loopback listen address. The signature must name the
  // endpoint the owner's Directory Current lists, which is what the relay verifies against.
  test("through a loopback dev proxy, page and stream logins sign the directory endpoint, not the proxy origin", async () => {
    const endpoint = auth.relayBaseUrl;
    expect(new URL(endpoint).hostname).toBe("127.0.0.1");
    const proxied = { ...auth, relayBaseUrl: "http://localhost:8080" };
    expect((await fetchCanonicalInboxPage(proxied)).records).toHaveLength(1);
    expect(
      requests[0][0].startsWith("http://localhost:8080/message/auth/")
    ).toBe(true);
    const signed = mailboxAuthDigest(
      buildMailboxAuthPreimage(challenge, auth.recipient, endpoint)
    );
    expect(auth.signDigest).toHaveBeenLastCalledWith(signed);
    expect(auth.signDigest).not.toHaveBeenCalledWith(
      mailboxAuthDigest(
        buildMailboxAuthPreimage(
          challenge,
          auth.recipient,
          "http://localhost:8080"
        )
      )
    );

    mockWsInstances.length = 0;
    const handle = await connectCanonicalMailboxStream({
      ...proxied,
      onRecord: () => undefined,
    });
    expect(mockWsInstances[0].url.startsWith("ws://localhost:8080/")).toBe(
      true
    );
    expect(auth.signDigest).toHaveBeenLastCalledWith(
      mailboxAuthDigest(
        buildMailboxAuthPreimage(challenge, auth.recipient, endpoint)
      )
    );
    handle.close();
  });
  test("locator/address and installed network mismatch fail before signing", async () => {
    await expect(
      fetchCanonicalInboxPage({ ...auth, subject: "02" + "ff".repeat(32) })
    ).rejects.toThrow();
    await expect(
      fetchCanonicalInboxPage({ ...auth, expectedNetworkTag: "MON1" })
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(auth.signDigest).not.toHaveBeenCalled();
  });
  test.each([
    { network_tag: "4d4f4e31" },
    { limit: 51 },
    { max_bytes: 1 },
    { signing_domain: "other" },
    { recovery_payload_hash: "aa".repeat(32) },
    { epoch: "00" },
  ])("foreign/malformed challenge is never signed %j", async (overrides) => {
    challengeOverrides = overrides;
    await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow();
    expect(auth.signDigest).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
  test.each([
    {
      name: "11 ms of positive relay clock skew",
      offsetMs: 60_011,
      valid: true,
    },
    { name: "an exaggerated future expiry", offsetMs: 65_001, valid: false },
    { name: "an expired challenge", offsetMs: -1, valid: false },
  ])(
    "handles $name without weakening the challenge bound",
    async ({ offsetMs, valid }) => {
      const now = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
      challengeOverrides = { expires_at_ms: now + offsetMs };
      try {
        if (valid) {
          await expect(fetchCanonicalInboxPage(auth)).resolves.toBeDefined();
          expect(auth.signDigest).toHaveBeenCalledTimes(1);
        } else {
          await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow(
            /Malformed or foreign canonical challenge/
          );
          expect(auth.signDigest).not.toHaveBeenCalled();
        }
      } finally {
        nowSpy.mockRestore();
      }
    }
  );
  test("fresh challenge on request401, no profile-registration request", async () => {
    const original = auth.fetch!;
    let reads = 0;
    auth.fetch = async (url, input) => {
      const response = await original(url, input);
      if (input.method === "GET" && ++reads === 1)
        return canonicalStream(
          url,
          401,
          canonicalText('{"error":"mailbox_auth_failed"}'),
          { "content-type": "application/json" }
        );
      return response;
    };
    expect((await fetchCanonicalInboxPage(auth)).records).toHaveLength(1);
    expect(requests).toHaveLength(4);
    expect(auth.signDigest).toHaveBeenCalledTimes(2);
  });
  test("bounded empty page returns no synthetic facts and exact opaque cursor", async () => {
    page = canonicalText("--page--\r\n");
    pageHeaders["x-frank-mailbox-next-cursor"] = "opaque-cursor";
    const result = await fetchCanonicalInboxPage({
      ...auth,
      cursor: "prior-cursor",
      maxBytes: 100,
    });
    expect(result.records).toEqual([]);
    expect(result.nextCursor).toBe("opaque-cursor");
    expect(challenge.cursor).toBe("prior-cursor");
  });
  test("complete wire including cursor is capped without Content-Length", async () => {
    page = canonicalText("--page--\r\n");
    pageHeaders["x-frank-mailbox-next-cursor"] = "opaque";
    await expect(
      fetchCanonicalInboxPage({ ...auth, maxBytes: page.length + 5 })
    ).rejects.toThrow(/byte limit|byte budget/);
  });
  test.each([false])(
    "complete %s page charges full cursor header: exact fit or one byte over",
    async (recovery) => {
      page = canonicalPage(recovery);
      const cursor = "opaque",
        budget = page.length + 31 + cursor.length;
      pageHeaders["x-frank-mailbox-next-cursor"] = cursor;
      const fetchPage = fetchCanonicalInboxPage;
      const exact = await fetchPage({ ...auth, maxBytes: budget });
      expect(exact.records).toHaveLength(1);
      expect(exact.nextCursor).toBe(cursor);
      const publish = jest.fn();
      await expect(
        fetchPage({ ...auth, maxBytes: budget - 1 }).then(publish)
      ).rejects.toThrow(/byte limit/);
      expect(publish).not.toHaveBeenCalled();
      delete pageHeaders["x-frank-mailbox-next-cursor"];
      const absent = await fetchPage({ ...auth, maxBytes: page.length });
      expect(absent.records).toHaveLength(1);
      expect(absent.nextCursor).toBeUndefined();
    }
  );
  test("truncated or over-cardinality page yields no partial record/cursor", async () => {
    page = page.slice(0, -3);
    pageHeaders["x-frank-mailbox-next-cursor"] = "next";
    await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow();
    page = canonicalPage();
    page = canonicalConcat(page.slice(0, -10), page);
    await expect(
      fetchCanonicalInboxPage({ ...auth, limit: 1 })
    ).rejects.toThrow();
  });
  test("stream header budget rejects before requesting the remaining page body", async () => {
    const original = auth.fetch!,
      reads = jest.fn(async () => ({
        done: false,
        value: canonicalText("--page\r\n" + "a".repeat(5000)),
      })),
      cancel = jest.fn(async () => undefined);
    auth.fetch = async (url, input) =>
      input.method === "GET"
        ? {
            url,
            status: 200,
            headers: {
              get: (name) =>
                name === "content-type"
                  ? "multipart/mixed; boundary=page"
                  : null,
            },
            body: {
              getReader: () => ({
                read: reads,
                cancel,
                releaseLock: () => undefined,
              }),
            },
          }
        : original(url, input);
    await expect(fetchCanonicalInboxPage(auth)).rejects.toThrow(/header limit/);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  test("pre-abort and cancellation during signing prevent publication", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchCanonicalInboxPage({ ...auth, signal: controller.signal })
    ).rejects.toThrow(/aborted/);
    expect(requests).toHaveLength(0);
    const active = new AbortController();
    auth.signDigest = async () => {
      active.abort();
      return new Uint8Array(70);
    };
    await expect(
      fetchCanonicalInboxPage({ ...auth, signal: active.signal })
    ).rejects.toThrow(/aborted/);
    expect(requests).toHaveLength(1);
  });
  test("connectCanonicalMailboxStream appends ngrok-skip-browser-warning on ngrok origins", async () => {
    mockWsInstances.length = 0;
    const ngrokAuth: CanonicalMailboxAuthParams = {
      ...auth,
      relayBaseUrl: "https://preachy-bauble-onscreen.ngrok-free.dev",
    };
    const handle = await connectCanonicalMailboxStream({
      ...ngrokAuth,
      onRecord: () => undefined,
    });
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).toContain("ngrok-skip-browser-warning=1");
    expect(mockWsInstances[0].url).toContain(
      "wss://preachy-bauble-onscreen.ngrok-free.dev/message/mailbox/"
    );
    handle.close();
  });
  test.each([
    { network_tag: "4d4f4e31" },
    { resource: "inbox" as const },
    { limit: 2 },
    { max_bytes: 1 },
    { since: 5 },
    { signing_domain: "other" },
    { epoch: "00" },
    { expires_at_ms: 1 },
  ])(
    "connectCanonicalMailboxStream never signs a foreign/malformed challenge %j",
    async (overrides) => {
      mockWsInstances.length = 0;
      challengeOverrides = overrides;
      await expect(
        connectCanonicalMailboxStream({ ...auth, onRecord: () => undefined })
      ).rejects.toThrow();
      expect(auth.signDigest).not.toHaveBeenCalled();
      expect(mockWsInstances).toHaveLength(0);
    }
  );
  test("connectCanonicalMailboxStream signs a preimage bound to the directory relay endpoint", async () => {
    mockWsInstances.length = 0;
    const handle = await connectCanonicalMailboxStream({
      ...auth,
      onRecord: () => undefined,
    });
    const origin = new URL(auth.relayBaseUrl).origin;
    expect(challenge.resource).toBe("mailbox_stream");
    expect(auth.signDigest).toHaveBeenCalledWith(
      mailboxAuthDigest(
        buildMailboxAuthPreimage(challenge, auth.recipient, origin)
      )
    );
    expect(
      mockWsInstances[0].url.startsWith(origin.replace(/^http/, "ws"))
    ).toBe(true);
    handle.close();
  });
  test("connectCanonicalMailboxStream omits ngrok-skip-browser-warning on standard origins", async () => {
    mockWsInstances.length = 0;
    const handle = await connectCanonicalMailboxStream({
      ...auth,
      onRecord: () => undefined,
    });
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).not.toContain("ngrok-skip-browser-warning");
    expect(mockWsInstances[0].url).toContain("/message/mailbox/");
    handle.close();
  });
});
