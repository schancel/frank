/**
 * Tests for `monad-mailbox-client.ts` against `MockMailboxRelay`
 * (`./monad-mailbox-mock-relay.testutil.ts`), an in-process mock of the Rust relay's private
 * mailbox contract (HMAC challenges/cursors, signature verification over an independently built
 * preimage, nonce cap, byte/limit budgets, stale cursors, disabled-mailbox 404s).
 *
 * The preimage vectors below were produced by running the Rust `mailbox_auth_preimage` itself
 * (`backend/cashweb/cashweb-registry/src/http/monad_message.rs`) in a throwaway `cargo test` over
 * fixed inputs (epoch=0x11.., nonce=0x22.., expires=1_700_000_060_000, token=0x33..,
 * recipient=0xab*20) -- so the TypeScript builder is pinned to the real relay bytes, not merely
 * to this repo's own re-derivation.
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

import { randomBytes, sha256 } from "@frank/crypto-box";
import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
  signEcdsa,
} from "@frank/nakamoto";

import {
  MAILBOX_AUTH_DOMAIN,
  MailboxChallenge,
  MailboxAuthParams,
  MonadMailboxAuthError,
  MonadMailboxError,
  MonadMailboxChallengeCapacityError,
  MonadMailboxProtocolError,
  MonadMailboxRecordTooLargeError,
  MonadMailboxRecoveryActiveError,
  MonadMailboxRecoveryRetiredError,
  MonadMailboxRequestError,
  MonadMailboxRetryableError,
  MonadMailboxStaleCursorError,
  MonadMailboxUnavailableError,
  ackMonadMailboxRecovery,
  bytesToHex,
  buildMailboxAuthPreimage,
  fetchMonadMailboxInbox,
  fetchMonadMailboxInboxPage,
  fetchMonadMailboxRecoveries,
  fetchMonadMailboxRecoveryPage,
  mailboxAuthDigest,
} from "./monad-mailbox-client";
import { fetchMonadMessagesSince } from "./monad-message-feed";
import {
  DEFAULT_MOCK_MAX_USED_CHALLENGES,
  MockMailboxRelay,
  MockStoredMessage,
} from "./monad-mailbox-mock-relay.testutil";
import { MonadStampedMessage, MonadStampPayment } from "./monad-mailbox-compat";

const BASE = "https://relay.example.com";
const RUST = {
  inboxNoCursor:
    "6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f696e626f782f01abababababababababababababababababababab0000018bcfe568000000000000000000640000000000404000000000044d4f4e54",
  inboxCursorNoTag:
    "6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f696e626f782f01abababababababababababababababababababab000000000000000501000000bc30313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130320000000000000032000000000000040000000000",
  recoveryAck:
    "6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333504f5354002f6d6573736167652f6d6f6e61642f7265636f766572792d61636b2f03abababababababababababababababababababab0000000000000000000000000000000001000000000000000044444444444444444444444444444444444444444444444444444444444444445555555555555555555555555555555555555555555555555555555555555555000000044d4f4e54",
  recovery:
    "6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f7265636f766572792f02abababababababababababababababababababab000000000000000000000000000000001400000000000003e8000000044d4f4e54",
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
    signing_domain: "frank:mailbox-http-auth:v2",
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
      RECIPIENT
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
      RECIPIENT
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
      RECIPIENT
    );
    expect(bytesToHex(preimage)).toBe(RUST.recoveryAck);
  });

  it("recovery", () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor("recovery", { limit: 20, max_bytes: 1000 }),
      RECIPIENT
    );
    expect(bytesToHex(preimage)).toBe(RUST.recovery);
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
      RECIPIENT
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
        RECIPIENT
      )
    ).toThrow(MonadMailboxProtocolError);
    expect(() =>
      buildMailboxAuthPreimage(
        challengeFor("bogus" as MailboxChallenge["resource"], {}),
        RECIPIENT
      )
    ).toThrow(MonadMailboxProtocolError);
  });
});

// --- fixtures ---------------------------------------------------------------------------------

interface MailboxKey {
  toBuffer(): Uint8Array;
  toPublicKey(): { toBuffer(): Uint8Array };
}

function mailboxKey(): MailboxKey {
  for (;;) {
    const secret = Buffer.from(randomBytes(32));
    const parsed = privateKeyFromSecretBytes(Uint8Array.from(secret), true);
    if (!parsed.ok) continue;
    const derived = publicFromPrivate(parsed.value);
    parsed.value.bytes.fill(0);
    if (!derived.ok) continue;
    const point = Buffer.from(derived.value.compressed);
    return {
      toBuffer: () => Uint8Array.from(secret),
      toPublicKey: () => ({ toBuffer: () => Uint8Array.from(point) }),
    };
  }
}

interface Fixture {
  relay: MockMailboxRelay;
  auth: MailboxAuthParams;
  sleeps: number[];
  signCalls: () => number;
  address: string;
  privateKey: MailboxKey;
}

function makeFixture(
  options: {
    maxUsedChallenges?: number;
    enabled?: boolean;
    register?: boolean;
    signWith?: MailboxKey;
  } = {}
): Fixture {
  const privateKey = mailboxKey();
  const address =
    "0x" +
    createHash("sha256")
      .update(privateKey.toBuffer())
      .digest("hex")
      .slice(0, 40);
  const relay = new MockMailboxRelay({
    enabled: options.enabled,
    maxUsedChallenges: options.maxUsedChallenges,
  });
  if (options.register !== false) {
    relay.registerProfile(address, privateKey.toPublicKey().toBuffer());
  }
  const signer = options.signWith ?? privateKey;
  const sleeps: number[] = [];
  let signs = 0;
  return {
    relay,
    sleeps,
    signCalls: () => signs,
    address,
    privateKey,
    auth: {
      relayBaseUrl: BASE + "/",
      recipient: address,
      http: relay.http,
      retry: {
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        sleep: async (ms) => void sleeps.push(ms),
      },
      signDigest: (digest) => {
        signs++;
        const parsed = privateKeyFromSecretBytes(
          Uint8Array.from(signer.toBuffer()),
          true
        );
        if (!parsed.ok) throw new Error(parsed.error.code);
        try {
          const signed = signEcdsa(parsed.value, Uint8Array.from(digest));
          if (!signed.ok) throw new Error(signed.error.code);
          return Buffer.from(signed.value);
        } finally {
          parsed.value.bytes.fill(0);
        }
      },
    },
  };
}

function message(
  recipient: string,
  timestamp: number,
  byte: number,
  size = 8
): MockStoredMessage {
  return {
    recipient,
    timestamp,
    payloadHash: Buffer.alloc(32, byte),
    encryptedPayload: Buffer.alloc(size, byte),
    stampPayments: [{ childIndex: 0, rawTx: Buffer.from([1, 2, 3, byte]) }],
    networkTag: Buffer.from("MONT"),
  };
}

describe("fetchMonadMailboxInbox / fetchMonadMessagesSince", () => {
  it("follows cursors across pages in (timestamp, hash) order and decodes the stored shape", async () => {
    const f = makeFixture();
    for (let i = 0; i < 250; i++) {
      // Three rows share a timestamp to exercise the payload-hash tie-breaker at page edges.
      f.relay.addMessage(
        message(f.address, 1000 + Math.floor(i / 3), i % 256, 4)
      );
    }
    f.relay.addMessage(message("0x" + "99".repeat(20), 1000, 0xee)); // someone else's row
    const result = await fetchMonadMailboxInbox({ ...f.auth, sinceMs: 0 });
    expect(result.truncatedBy).toBeUndefined();
    // De-duplication by payload hash: only 250 rows but payload bytes repeat mod 256 -> all unique.
    expect(result.messages).toHaveLength(250);
    const stamps = result.messages.map((m) => m.timestamp);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(result.messages[0].message?.stampPayments[0].rawTx).toEqual(
      new Uint8Array([1, 2, 3, result.messages[0].message!.payloadHash[0]])
    );
    expect(new TextDecoder().decode(result.messages[0].networkTag)).toBe(
      "MONT"
    );
    // 3 pages of <=100 rows: each page = one challenge + one read, cursor bound after the first.
    const reads = f.relay.log.filter((l) => l.route === "inbox");
    expect(reads).toHaveLength(3);
    expect(reads[0].query.cursor).toBeUndefined();
    expect(reads[1].query.cursor).toMatch(/^[0-9a-f]{188}$/);
    expect(reads.every((r) => r.query.limit === "100")).toBe(true);
    expect(f.relay.usedChallenges(f.address)).toBe(3);
    expect(f.signCalls()).toBe(3);
  });

  it("honours the inclusive since bound and returns [] for a genuinely empty inbox", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 1));
    f.relay.addMessage(message(f.address, 200, 2));
    expect(
      (await fetchMonadMessagesSince({ ...f.auth, sinceMs: 200 })).map(
        (m) => m.timestamp
      )
    ).toEqual([200]);
    expect(await fetchMonadMessagesSince({ ...f.auth, sinceMs: 201 })).toEqual(
      []
    );
  });

  it("drops duplicate payload hashes seen across pages", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 7));
    f.relay.addMessage({ ...message(f.address, 101, 7) }); // same hash, later timestamp
    const messages = await fetchMonadMessagesSince({
      ...f.auth,
      sinceMs: 0,
      pageLimit: 1,
    });
    expect(messages).toHaveLength(1);
  });

  it("splits pages by max_bytes and fails clearly when one record exceeds the budget", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 1, 1, 200));
    f.relay.addMessage(message(f.address, 2, 2, 200));
    const paged = await fetchMonadMailboxInboxPage({
      ...f.auth,
      sinceMs: 0,
      maxBytes: 400,
    });
    expect(paged.messages).toHaveLength(1);
    expect(paged.nextCursor).toBeDefined();
    await expect(
      fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0, maxBytes: 50 })
    ).rejects.toBeInstanceOf(MonadMailboxRecordTooLargeError);
  });

  it("rejects an out-of-range limit as a request error (400 invalid_mailbox_limit)", async () => {
    const f = makeFixture();
    await expect(
      fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0, limit: 101 })
    ).rejects.toMatchObject({
      constructor: MonadMailboxRequestError,
      status: 400,
      code: "invalid_mailbox_limit",
    });
    expect(f.signCalls()).toBe(0); // the relay refused to issue a challenge; nothing was signed
  });

  it("surfaces a stale cursor (older than since) distinctly", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 1));
    f.relay.addMessage(message(f.address, 200, 2));
    const first = await fetchMonadMailboxInboxPage({
      ...f.auth,
      sinceMs: 0,
      limit: 1,
    });
    expect(first.nextCursor).toBeDefined();
    await expect(
      fetchMonadMailboxInboxPage({
        ...f.auth,
        sinceMs: 150,
        cursor: first.nextCursor,
        limit: 1,
      })
    ).rejects.toBeInstanceOf(MonadMailboxStaleCursorError);
  });

  it("reports a cursor from before a relay restart as an auth failure in the challenge phase", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 1));
    f.relay.addMessage(message(f.address, 200, 2));
    const first = await fetchMonadMailboxInboxPage({
      ...f.auth,
      sinceMs: 0,
      limit: 1,
    });
    const restarted = new MockMailboxRelay(); // new epoch + HMAC secret
    restarted.registerProfile(f.address, f.privateKey.toPublicKey().toBuffer());
    const error = await fetchMonadMailboxInboxPage({
      ...f.auth,
      http: restarted.http,
      sinceMs: 0,
      cursor: first.nextCursor,
      limit: 1,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(MonadMailboxAuthError);
    expect(error.phase).toBe("challenge");
    expect(restarted.log.filter((l) => l.route === "challenge")).toHaveLength(
      1
    ); // not retried
  });

  it("a later-page failure returns a complete-timestamp prefix (relay caps unexpired challenges; modelled at 8 here), first-page failure throws", async () => {
    const f = makeFixture({ maxUsedChallenges: 8 });
    for (let i = 0; i < 12; i++)
      f.relay.addMessage(message(f.address, 100 + i, i));
    const truncated = await fetchMonadMailboxInbox({
      ...f.auth,
      sinceMs: 0,
      pageLimit: 1,
    });
    expect(truncated.messages).toHaveLength(7); // 8 fetched, the 9th refused; last row's group dropped
    expect(truncated.truncatedBy).toBeInstanceOf(
      MonadMailboxChallengeCapacityError
    );
    // Now the recipient has exhausted its nonce budget: a first-page failure must throw.
    const capacity = await fetchMonadMailboxInbox({
      ...f.auth,
      sinceMs: 0,
    }).catch((e) => e);
    expect(capacity).toBeInstanceOf(MonadMailboxChallengeCapacityError);
    expect(capacity).toMatchObject({ status: 429, retryAfterMs: 60_000 });
    expect(f.sleeps).toEqual([]); // capacity only returns on expiry: not retried in-call
    // The feed wrapper reports truncation to the caller.
    const g = makeFixture({ maxUsedChallenges: 8 });
    for (let i = 0; i < 12; i++)
      g.relay.addMessage(message(g.address, 100 + i, i));
    const reasons: unknown[] = [];
    const messages = await fetchMonadMessagesSince({
      ...g.auth,
      sinceMs: 0,
      pageLimit: 1,
      onTruncated: (reason) => reasons.push(reason),
    });
    expect(messages).toHaveLength(7);
    expect(reasons).toHaveLength(1);
  });

  describe("truncation never strands the rest of a timestamp group (F1)", () => {
    /** Fails every inbox read after the first `okReads`, as a dropped connection / 500 would. */
    function failAfter(f: Fixture, okReads: number, status = 500) {
      const original = f.auth.http!;
      let reads = 0;
      f.auth.http = async (request) => {
        if (request.url.includes("/inbox/") && ++reads > okReads) {
          return { status, headers: {}, data: new Uint8Array() };
        }
        return original(request);
      };
    }

    it("drops the trailing same-timestamp rows, so since=lastTimestamp+1 loses nothing", async () => {
      const f = makeFixture();
      f.relay.addMessage(message(f.address, 99, 1)); // X
      f.relay.addMessage(message(f.address, 100, 2)); // A
      f.relay.addMessage(message(f.address, 100, 3)); // B, same timestamp as A
      const healthy = f.auth.http!;
      failAfter(f, 1); // page 1 = [X, A], page 2 (would be [B]) fails

      const reasons: unknown[] = [];
      const first = await fetchMonadMessagesSince({
        ...f.auth,
        sinceMs: 0,
        pageLimit: 2,
        onTruncated: (r) => reasons.push(r),
      });
      expect(reasons).toHaveLength(1);
      expect(first.map((m) => m.timestamp)).toEqual([99]); // A was fetched but is withheld

      // The consumer advances exactly like the app/bots: since = lastTimestamp + 1.
      const nextSince = first[first.length - 1].timestamp + 1;
      f.auth.http = healthy;
      const second = await fetchMonadMessagesSince({
        ...f.auth,
        sinceMs: nextSince,
      });
      const all = [...first, ...second];
      expect(all.map((m) => m.timestamp).sort((a, b) => a - b)).toEqual([
        99, 100, 100,
      ]);
      expect(
        new Set(all.map((m) => bytesToHex(m.message!.payloadHash))).size
      ).toBe(3);
    });

    it("when every fetched row shares one timestamp there is no safe prefix: the error is thrown, not an empty success", async () => {
      const f = makeFixture();
      for (const byte of [1, 2, 3])
        f.relay.addMessage(message(f.address, 100, byte));
      failAfter(f, 1);
      await expect(
        fetchMonadMessagesSince({ ...f.auth, sinceMs: 0, pageLimit: 2 })
      ).rejects.toBeInstanceOf(MonadMailboxError);
    });

    it("a page-budget stop applies the same rule", async () => {
      const f = makeFixture();
      f.relay.addMessage(message(f.address, 99, 1));
      f.relay.addMessage(message(f.address, 100, 2));
      f.relay.addMessage(message(f.address, 100, 3));
      const result = await fetchMonadMailboxInbox({
        ...f.auth,
        sinceMs: 0,
        pageLimit: 2,
        maxPages: 1,
      });
      expect(result.truncatedBy).toBeInstanceOf(MonadMailboxRetryableError);
      expect(result.messages.map((m) => m.timestamp)).toEqual([99]);
    });
  });

  it("stops instead of looping when the relay repeats a cursor", async () => {
    const g = makeFixture();
    g.relay.addMessage(message(g.address, 100, 1));
    g.relay.addMessage(message(g.address, 101, 2));
    const originalHttp = g.auth.http!;
    let firstCursor: string | undefined;
    g.auth.http = async (request) => {
      const response = await originalHttp(request);
      if (request.url.includes("/inbox/")) {
        firstCursor ??= response.headers["x-frank-mailbox-next-cursor"];
        response.headers["x-frank-mailbox-next-cursor"] = firstCursor; // same valid token forever
      }
      return response;
    };
    await expect(
      fetchMonadMailboxInbox({ ...g.auth, sinceMs: 0, pageLimit: 1 })
    ).rejects.toBeInstanceOf(MonadMailboxProtocolError);
  });
});

describe("mock relay contract pin", () => {
  it("models the relay cap of 120 consumed challenges per recipient per 60 s", async () => {
    expect(DEFAULT_MOCK_MAX_USED_CHALLENGES).toBe(120);
    const f = makeFixture();
    for (let i = 0; i < 120; i++) {
      await fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 });
    }
    await expect(
      fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 })
    ).rejects.toBeInstanceOf(MonadMailboxChallengeCapacityError);
  });
});

describe("mailbox disabled / unknown relay", () => {
  it("never turns a 404 into an empty inbox (inbox, recovery, ack)", async () => {
    const f = makeFixture({ enabled: false });
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    ).rejects.toBeInstanceOf(MonadMailboxUnavailableError);
    await expect(fetchMonadMailboxRecoveries(f.auth)).rejects.toBeInstanceOf(
      MonadMailboxUnavailableError
    );
    await expect(
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: "11".repeat(32),
        obligationIdHex: "22".repeat(32),
      })
    ).rejects.toBeInstanceOf(MonadMailboxUnavailableError);
    expect(f.signCalls()).toBe(0);
    expect(f.sleeps).toEqual([]); // 404 is definitive, not retried
  });

  it("a 404 on the read after a challenge (old relay with only /auth) is also Unavailable", async () => {
    const f = makeFixture();
    f.relay.inject("inbox", { status: 404 });
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    ).rejects.toBeInstanceOf(MonadMailboxUnavailableError);
  });
});

describe("local validation before anything is sent", () => {
  it("refuses to sign a challenge with a foreign signing_domain (no cross-protocol signature)", async () => {
    const f = makeFixture();
    const originalHttp = f.auth.http!;
    f.auth.http = async (request) => {
      const response = await originalHttp(request);
      if (request.url.includes("/auth/")) {
        const body = JSON.parse(
          new TextDecoder().decode(response.data as Uint8Array)
        );
        body.signing_domain = "frank:something-else:v1";
        response.data = new TextEncoder().encode(JSON.stringify(body));
      }
      return response;
    };
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    ).rejects.toThrow(/signing_domain/);
    expect(f.signCalls()).toBe(0);
  });

  it.each([
    ["payload hash not hex", "nothex", "22".repeat(32)],
    ["payload hash upper-case", "AB".repeat(32), "22".repeat(32)],
    ["payload hash short", "11".repeat(31), "22".repeat(32)],
    ["obligation id not hex", "11".repeat(32), "zz".repeat(32)],
    ["obligation id long", "11".repeat(32), "22".repeat(33)],
  ])(
    "ack rejects %s locally: no request is made and nothing is signed",
    async (_name, payloadHashHex, obligationIdHex) => {
      const f = makeFixture();
      await expect(
        ackMonadMailboxRecovery({ ...f.auth, payloadHashHex, obligationIdHex })
      ).rejects.toBeInstanceOf(MonadMailboxRequestError);
      expect(f.relay.log).toHaveLength(0);
      expect(f.signCalls()).toBe(0);
    }
  );

  it("rejects a malformed recipient locally", async () => {
    const f = makeFixture();
    await expect(
      fetchMonadMessagesSince({ ...f.auth, recipient: "0x1234", sinceMs: 0 })
    ).rejects.toBeInstanceOf(MonadMailboxRequestError);
    expect(f.signCalls()).toBe(0);
  });
});

describe("authentication failures", () => {
  it("an unregistered recipient is a 401 auth error (one fresh-challenge retry, then throw)", async () => {
    const f = makeFixture({ register: false });
    const error = await fetchMonadMessagesSince({
      ...f.auth,
      sinceMs: 0,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(MonadMailboxAuthError);
    expect(error.phase).toBe("request");
    expect(f.relay.log.filter((l) => l.route === "challenge")).toHaveLength(2);
  });

  it("a signature from the wrong key is rejected", async () => {
    const f = makeFixture({ signWith: mailboxKey() });
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    ).rejects.toBeInstanceOf(MonadMailboxAuthError);
  });

  it("recovers from one expired/replayed challenge by fetching a fresh one", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 1));
    f.relay.inject("inbox", {
      status: 401,
      body: { error: "mailbox_auth_failed" },
    });
    const messages = await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 });
    expect(messages).toHaveLength(1);
    expect(f.relay.log.filter((l) => l.route === "challenge")).toHaveLength(2);
  });

  it("refuses to sign a challenge that does not echo the request", async () => {
    const f = makeFixture();
    const originalHttp = f.auth.http!;
    f.auth.http = async (request) => {
      const response = await originalHttp(request);
      if (request.url.includes("/auth/")) {
        const body = JSON.parse(
          new TextDecoder().decode(response.data as Uint8Array)
        );
        body.limit = 1; // relay "downgrades" the page size behind the client's back
        response.data = new TextEncoder().encode(JSON.stringify(body));
      }
      return response;
    };
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    ).rejects.toBeInstanceOf(MonadMailboxProtocolError);
    expect(f.signCalls()).toBe(0);
  });
});

describe("retry / rate limit handling", () => {
  it("retries 503 on the challenge and on the read with exponential backoff, then succeeds", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 1));
    f.relay.inject("challenge", {
      status: 503,
      body: { error: "mailbox_auth_retryable" },
    });
    f.relay.inject("inbox", {
      status: 503,
      body: { error: "mailbox_auth_retryable" },
    });
    const messages = await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 });
    expect(messages).toHaveLength(1);
    expect(f.sleeps).toEqual([100, 200]);
  });

  it("honours Retry-After on 429 (seconds), capped by maxRetryAfterMs", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 1));
    f.relay.inject("challenge", {
      status: 429,
      headers: { "retry-after": "3" },
      body: { error: "rate_limited" },
    });
    await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 });
    expect(f.sleeps).toEqual([3000]);
    f.sleeps.length = 0;
    f.relay.inject("challenge", {
      status: 429,
      headers: { "retry-after": "120" },
    });
    await fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 });
    expect(f.sleeps).toEqual([60_000]); // Retry-After honoured, capped at maxRetryAfterMs (F4)
    f.sleeps.length = 0;
    f.relay.inject("challenge", {
      status: 429,
      headers: { "retry-after": "3600" },
    });
    await fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 });
    expect(f.sleeps).toEqual([60_000]);
  });

  it("gives up after maxAttempts with a retryable error that says so", async () => {
    const f = makeFixture();
    f.relay.atCapacity = true;
    const error = await fetchMonadMessagesSince({
      ...f.auth,
      sinceMs: 0,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(MonadMailboxRetryableError);
    expect(error.status).toBe(503);
    expect(f.sleeps).toEqual([100, 200, 400]); // 4 attempts
  });

  it("retries network failures (no response) but not local signer errors", async () => {
    const f = makeFixture();
    f.relay.addMessage(message(f.address, 100, 1));
    f.relay.inject("challenge", "network-error", "network-error");
    expect(
      await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    ).toHaveLength(1);
    expect(f.sleeps).toEqual([100, 200]);

    const g = makeFixture();
    g.relay.inject(
      "challenge",
      "network-error",
      "network-error",
      "network-error",
      "network-error"
    );
    const error = await fetchMonadMessagesSince({
      ...g.auth,
      sinceMs: 0,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(MonadMailboxRetryableError);
    expect(error.message).toMatch(/no response from relay/);

    const h = makeFixture();
    h.auth.signDigest = () => {
      throw new Error("hardware signer unavailable");
    };
    await expect(
      fetchMonadMessagesSince({ ...h.auth, sinceMs: 0 })
    ).rejects.toThrow("hardware signer unavailable");
    expect(h.sleeps).toEqual([]);
  });

  it("does not retry definitive client errors (400) or server 500", async () => {
    const f = makeFixture();
    f.relay.inject("inbox", { status: 500 });
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    ).rejects.toMatchObject({ status: 500 });
    expect(f.sleeps).toEqual([]);
  });
});

describe("recovery listing and ack", () => {
  function recoveryFixture(f: Fixture, lifecycle: string, hashByte: number) {
    const nested = new MonadStampedMessage();
    nested.setEncryptedPayload(new Uint8Array([9, hashByte]));
    nested.setPayloadHash(new Uint8Array(32).fill(hashByte));
    for (const child of [0, 1]) {
      const payment = new MonadStampPayment();
      payment.setChildIndex(child);
      payment.setRawTx(new Uint8Array([child, hashByte]));
      nested.addStampPayments(payment);
    }
    f.relay.addRecovery({
      recipient: f.address,
      payloadHash: Buffer.alloc(32, hashByte),
      obligationId: Buffer.alloc(32, hashByte + 0x10),
      canonicalMessage: Buffer.from(nested.serializeBinary()),
      confirmedChildren: [0],
      lifecycle,
    });
  }

  it("pages recovery obligations with cursors and decodes the canonical message", async () => {
    const f = makeFixture();
    recoveryFixture(f, "terminal:expired", 1);
    recoveryFixture(f, "pending", 2);
    recoveryFixture(f, "fully_confirmed", 3);
    const first = await fetchMonadMailboxRecoveryPage({ ...f.auth, limit: 2 });
    expect(first.records.map((r) => r.lifecycle)).toEqual([
      "terminal:expired",
      "pending",
    ]);
    expect(first.nextCursor).toMatch(/^[0-9a-f]{172}$/);
    const all = await fetchMonadMailboxRecoveries({ ...f.auth, pageLimit: 2 });
    expect(all.truncatedBy).toBeUndefined();
    expect(all.records).toHaveLength(3);
    expect(all.records[0]).toMatchObject({
      payloadHashHex: "01".repeat(32),
      obligationIdHex: "11".repeat(32),
      confirmedChildren: [0],
    });
    expect(
      all.records[0].canonicalMessage.stampPayments.map((p) => p.childIndex)
    ).toEqual([0, 1]);
    expect(all.records[0].canonicalMessage.payloadHash).toEqual(
      new Uint8Array(32).fill(1)
    );
  });

  it("acks a terminal obligation (204), is idempotent when it is already gone, refuses an active one", async () => {
    const f = makeFixture();
    recoveryFixture(f, "terminal:stale_nonce", 1);
    recoveryFixture(f, "pending", 2);
    const ack = (byte: number) =>
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: bytesToHex(new Uint8Array(32).fill(byte)),
        obligationIdHex: bytesToHex(new Uint8Array(32).fill(byte + 0x10)),
      });
    await ack(1);
    expect(f.relay.hasRecovery(Buffer.alloc(32, 1))).toBe(false);
    await ack(1); // absent -> still 204
    await expect(ack(2)).rejects.toBeInstanceOf(
      MonadMailboxRecoveryActiveError
    );
    expect(f.relay.hasRecovery(Buffer.alloc(32, 2))).toBe(true);
  });

  it("validates ack identifiers locally; an ack for another recipient is a silent 204 that retires nothing", async () => {
    const f = makeFixture();
    await expect(
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: "nothex",
        obligationIdHex: "22".repeat(32),
      })
    ).rejects.toBeInstanceOf(MonadMailboxRequestError);
    const other = makeFixture();
    f.relay.registerProfile(
      other.address,
      other.privateKey.toPublicKey().toBuffer()
    );
    recoveryFixture(f, "terminal:expired", 5); // owned by f, not `other`
    // 204 is NOT proof the obligation existed or was retired (no existence oracle).
    await expect(
      ackMonadMailboxRecovery({
        ...other.auth,
        http: f.relay.http,
        payloadHashHex: "05".repeat(32),
        obligationIdHex: "15".repeat(32),
      })
    ).resolves.toBeUndefined();
    expect(f.relay.hasRecovery(Buffer.alloc(32, 5))).toBe(true);
    // A stale obligation id for the owner is also a plain 204 and leaves the row alone.
    await expect(
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: "05".repeat(32),
        obligationIdHex: "ee".repeat(32),
      })
    ).resolves.toBeUndefined();
    expect(f.relay.hasRecovery(Buffer.alloc(32, 5))).toBe(true);
  });

  it("returns empty records and ignores ack when relay indicates recovery is retired (HTTP 410)", async () => {
    const f = makeFixture();
    f.relay.inject("recovery", {
      status: 410,
      data: { version: 1, error: "recovery_endpoint_retired" },
    });
    const all = await fetchMonadMailboxRecoveries(f.auth);
    expect(all.records).toEqual([]);

    f.relay.inject("recovery", {
      status: 410,
      data: { version: 1, error: "recovery_endpoint_retired" },
    });
    await expect(
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: "05".repeat(32),
        obligationIdHex: "ee".repeat(32),
      })
    ).resolves.toBeUndefined();
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
  validateFrame,
  verifyPreviewDirectoryEvidence,
} from "@frank/codec";
import { openNodeDirectoryStore } from "@frank/directory-admission/node";
import type { Context, DirectoryStore } from "@frank/directory-admission";
import {
  freezeCanonicalRequest,
  type CanonicalFetch,
  type CanonicalStreamResponse,
} from "./canonical-dm-transport";
import {
  ackCanonicalRecovery,
  connectCanonicalMailboxStream,
  fetchCanonicalInboxPage,
  fetchCanonicalMailboxPage,
  fetchCanonicalRecoveryPage,
  type CanonicalMailboxAuthParams,
} from "./monad-mailbox-client";

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
    { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
    payload
  );
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
          recovery_payload_hash: query.get("recovery_payload_hash"),
          recovery_obligation_id: query.get("recovery_obligation_id"),
          ...challengeOverrides,
        };
        return canonicalStream(
          url,
          200,
          canonicalText(JSON.stringify(challenge)),
          { "content-type": "application/json" }
        );
      }
      if (url.endsWith("/ack"))
        return canonicalStream(
          url,
          200,
          canonicalText(
            JSON.stringify({
              version: 1,
              acknowledged: true,
              payload_hash: challenge.recovery_payload_hash,
              obligation_id: challenge.recovery_obligation_id,
            })
          ),
          { "content-type": "application/json" }
        );
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
      mailboxAuthDigest(buildMailboxAuthPreimage(challenge, auth.recipient))
    );
    expect(
      new TextDecoder().decode(
        buildMailboxAuthPreimage(challenge, auth.recipient)
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
        mailboxAuthDigest(buildMailboxAuthPreimage(challenge, auth.recipient))
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
  test.each([false, true])(
    "complete %s page charges full cursor header: exact fit or one byte over",
    async (recovery) => {
      page = canonicalPage(recovery);
      const cursor = "opaque",
        budget = page.length + 31 + cursor.length;
      pageHeaders["x-frank-mailbox-next-cursor"] = cursor;
      const fetchPage = recovery
        ? fetchCanonicalRecoveryPage
        : fetchCanonicalInboxPage;
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
  test("actual recovery contains raw order and exact index with confirmed-prefix metadata", async () => {
    page = canonicalPage(true);
    const result = await fetchCanonicalRecoveryPage(auth);
    expect(result.records[0].parts.transactions).toEqual([canonicalRaw]);
    expect(result.records[0].confirmedChildren).toEqual([0]);
    expect(challenge.limit).toBe(20);
    expect(result.records[0].identity.submission_identity).toBe(
      result.records[0].submissionIdentity
    );
  });
  test.each([
    { confirmed_children: [0, 0] },
    { confirmed_children: [1] },
    { submission_identity: "00".repeat(32) },
    { payload_hash: "00".repeat(32) },
    { lifecycle: "terminal:new_authority" },
    { lifecycle: ["pending"] },
    { lifecycle: [["pending"]] },
    { lifecycle: ["fully_confirmed"] },
    { lifecycle: [["delivered"]] },
    { lifecycle: [] },
  ])("recovery rejects invalid import metadata %j", async (overrides) => {
    page = canonicalPage(true, overrides);
    await expect(fetchCanonicalRecoveryPage(auth)).rejects.toThrow();
  });
  test("oversized recovery context rejects before delivery/context ownership copies", async () => {
    const original = canonicalPage(true),
      contextBytes = fromHex(canonicalWire.context),
      delivery = canonicalDelivery();
    const at = Buffer.from(original).indexOf(contextBytes);
    if (at < 0) throw new Error("Fixture exact context location");
    page = canonicalConcat(
      original.subarray(0, at),
      new Uint8Array(7 * 1024 * 1024),
      original.subarray(at + contextBytes.length)
    );
    const originalFetch = auth.fetch!;
    auth.fetch = async (url, input) => {
      if (input.method !== "GET") return originalFetch(url, input);
      let sent = false;
      return {
        url,
        status: 200,
        headers: { get: (name) => pageHeaders[name] ?? null },
        body: {
          getReader: () => ({
            read: async () =>
              sent
                ? { done: true }
                : ((sent = true), { done: false, value: page }),
            cancel: async () => undefined,
            releaseLock: () => undefined,
          }),
        },
      };
    };
    let largeCopies = 0,
      deliveryCopies = 0;
    const originalFrom = Uint8Array.from;
    const spy = jest.spyOn(Uint8Array, "from").mockImplementation(((
      source: ArrayLike<number>
    ) => {
      if (source.length > 4096) largeCopies++;
      if (
        source.length === delivery.length &&
        delivery.every((byte, i) => source[i] === byte)
      )
        deliveryCopies++;
      return originalFrom.call(Uint8Array, source as Uint8Array);
    }) as typeof Uint8Array.from);
    try {
      await expect(fetchCanonicalRecoveryPage(auth)).rejects.toThrow(
        /Canonical part limits/
      );
      expect(largeCopies).toBe(0);
      expect(deliveryCopies).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  test("ack is distinct exact T3/generation identity with original zero-byte signing binding", async () => {
    const payloadHashHex = canonicalWire.t3,
      obligationIdHex = "aa".repeat(32);
    await ackCanonicalRecovery({ ...auth, payloadHashHex, obligationIdHex });
    expect(challenge.max_bytes).toBe(0);
    expect(challenge.limit).toBe(1);
    expect(challenge.since).toBe(0);
    expect(requests[1][0]).toBe(
      `${auth.relayBaseUrl}/message/recovery/${auth.recipient}/${payloadHashHex}/${obligationIdHex}/ack`
    );
    expect(requests[1][1].body).toBeUndefined();
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
  test("canonical recovery page returns empty records and ack resolves when relay indicates retired (HTTP 410)", async () => {
    const originalFetch = auth.fetch!;
    auth.fetch = async (url, input) => {
      if (url.includes("/recovery/")) {
        return {
          url,
          status: 410,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          body: {
            getReader: () => ({
              read: async () => ({ done: true }),
              cancel: async () => undefined,
              releaseLock: () => undefined,
            }),
          },
        };
      }
      return originalFetch(url, input);
    };
    const result = await fetchCanonicalRecoveryPage(auth);
    expect(result.records).toEqual([]);
    await expect(
      ackCanonicalRecovery({
        ...auth,
        payloadHashHex: "aa".repeat(32),
        obligationIdHex: "bb".repeat(32),
      })
    ).resolves.toBeUndefined();
  });
  test("connectCanonicalMailboxStream appends ngrok-skip-browser-warning on ngrok origins", async () => {
    mockWsInstances.length = 0;
    const ngrokAuth: CanonicalMailboxAuthParams = {
      ...auth,
      relayBaseUrl: "https://preachy-bauble-onscreen.ngrok-free.dev",
    };
    const handle = await connectCanonicalMailboxStream(ngrokAuth);
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).toContain("ngrok-skip-browser-warning=1");
    expect(mockWsInstances[0].url).toContain(
      "wss://preachy-bauble-onscreen.ngrok-free.dev/message/mailbox/"
    );
    handle.close();
  });
  test("connectCanonicalMailboxStream omits ngrok-skip-browser-warning on standard origins", async () => {
    mockWsInstances.length = 0;
    const handle = await connectCanonicalMailboxStream(auth);
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).not.toContain("ngrok-skip-browser-warning");
    expect(mockWsInstances[0].url).toContain("/message/mailbox/");
    handle.close();
  });
});
