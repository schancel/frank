/**
 * #309: both parties of a Monad envelope must derive the same AES key for every key pair.
 *
 * The ECDH shared point used to be serialized through elliptic's BN, whose `toBuffer({size: 32})`
 * only pads for bitcore's patched bn.js copy. When the shared x coordinate starts with a zero byte
 * (about 1 pair in 256) one side hashed 33 bytes and the other 32, so the AES-GCM tag never
 * verified and the message was silently unreadable. Known-answer values in the fixture file come
 * from an independent pure-integer secp256k1 implementation (python), and x is also cross-checked
 * against Node's OpenSSL-backed ECDH.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import {
  PrivateKey,
  PublicKey,
  crypto as bitcoreCrypto,
} from "bitcore-lib-xpi";

import { IDENTITY_KEY_NETWORK_NAME } from "../legacy-wallet/lotus-identity";
import { PayloadConstructor } from "./crypto";
import {
  buildEnvelope,
  decryptEnvelope,
  decryptEnvelopeV2,
  parseEnvelope,
  tryDecryptEnvelope,
} from "./monad-message-envelope";

interface FixtureEnvelope {
  plaintext: string;
  envelope: Record<string, unknown>;
  preFixDecrypts: boolean;
}
interface FixturePair {
  privA: string;
  privB: string;
  pubA: string;
  pubB: string;
  /** issue = the ticket's pair; TP/PT = exactly one side trimmed x; TT = both sides trimmed. */
  legacyKinds: "issue" | "TP" | "PT" | "TT";
  sharedPoint: string;
  trimmedSharedPoint: string;
  aToB: FixtureEnvelope;
  bToA: FixtureEnvelope;
}
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "monad-envelope-ecdh-309.fixtures.json"),
    "utf8"
  )
) as {
  pairs: FixturePair[];
  randomKats: { priv: string; peerPub: string; sharedPoint: string }[];
  hkdf: {
    salt: string;
    sharedPoint: string;
    key: string;
    trimmedKey: string;
    envelope: Record<string, unknown>;
    plaintext: string;
  };
};

const constructor_ = new PayloadConstructor({
  networkName: IDENTITY_KEY_NETWORK_NAME,
});
const privateKey = (hex: string) =>
  PrivateKey.fromBuffer(Buffer.from(hex, "hex"), IDENTITY_KEY_NETWORK_NAME);
const publicKey = (hex: string) =>
  PublicKey.fromBuffer(Buffer.from(hex, "hex"));
const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";

function shared(privHex: string, peerPubHex: string): string {
  return constructor_
    .constructMergedKey(privateKey(privHex), publicKey(peerPubHex))
    .toBuffer()
    .toString("hex");
}

function bytesOf(envelope: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(envelope));
}

// Scalar multiplication under jest's module sandbox is ~30x slower than plain node, so several
// tests here take tens of seconds; the 10k-pair sweep lives in bitcore-lib-xpi's mocha suite.
jest.setTimeout(300_000);

describe("ECDH shared point encoding (#309)", () => {
  it("the ticket's key pair derives the same 33-byte point on both sides", () => {
    const issue = fixture.pairs[0];
    expect(issue.legacyKinds).toBe("issue");
    // 0x00bc906d... is the shared x from the ticket; 03 is its y parity.
    expect(issue.sharedPoint).toBe(
      "0300bc906d18c156917ce52c48a2970927a2f11de554704d53d7e226ad632ab4c8"
    );
    expect(shared(issue.privA, issue.pubB)).toBe(issue.sharedPoint);
    expect(shared(issue.privB, issue.pubA)).toBe(issue.sharedPoint);
  });

  it("encrypts in either direction and decrypts in the other for the ticket's pair", () => {
    const issue = fixture.pairs[0];
    for (const [fromPriv, toPub, from, to] of [
      [issue.privA, issue.pubB, addressA, addressB],
      [issue.privB, issue.pubA, addressB, addressA],
    ] as const) {
      const bytes = buildEnvelope({
        fromAddress: from,
        fromPrivateKey: privateKey(fromPriv),
        toAddress: to,
        toPubKey: Buffer.from(toPub, "hex"),
        plaintext: "hi",
        networkTag: "MONT",
      });
      const envelope = parseEnvelope(bytes);
      if (!envelope) throw new Error("builder output must parse");
      const senderPub = privateKey(fromPriv).toPublicKey().toBuffer();
      const recipientPriv =
        fromPriv === issue.privA ? issue.privB : issue.privA;
      expect(
        decryptEnvelope({
          envelope,
          myPrivateKey: privateKey(recipientPriv),
          senderPubKey: senderPub,
        })
      ).toBe("hi");
    }
  });

  it("matches the independent implementation's known-answer points", () => {
    for (const kat of fixture.randomKats.slice(0, 6)) {
      expect(shared(kat.priv, kat.peerPub)).toBe(kat.sharedPoint);
    }
    for (const pair of fixture.pairs) {
      expect(pair.sharedPoint.slice(2, 4)).toBe("00");
      expect(shared(pair.privA, pair.pubB)).toBe(pair.sharedPoint);
      expect(shared(pair.privB, pair.pubA)).toBe(pair.sharedPoint);
    }
  });

  it("derives the independently computed HKDF key and opens an independently built envelope", () => {
    const envelope = parseEnvelope(bytesOf(fixture.hkdf.envelope));
    if (envelope?.v !== 2) throw new Error("fixture must be a v2 envelope");
    const issue = fixture.pairs[0];
    // Recipient is B (the bot); the envelope was sealed by node:crypto with python's HKDF key.
    expect(
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: privateKey(issue.privB),
        senderPubKey: Buffer.from(issue.pubA, "hex"),
      })
    ).toBe(fixture.hkdf.plaintext);
    expect(
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: privateKey(issue.privA),
        senderPubKey: Buffer.from(issue.pubB, "hex"),
      })
    ).toBe(fixture.hkdf.plaintext);
  });

  it("seals new envelopes with the canonical padded point (verified with node:crypto HKDF + AES-GCM)", () => {
    const info = "frank:monad-dm-envelope:v2:identity-ecdh:aes-256-gcm";
    for (const pair of fixture.pairs.filter(
      (candidate) =>
        candidate.legacyKinds === "issue" || candidate.legacyKinds === "TT"
    )) {
      const envelope = parseEnvelope(
        buildEnvelope({
          fromAddress: addressA,
          fromPrivateKey: privateKey(pair.privA),
          toAddress: addressB,
          toPubKey: Buffer.from(pair.pubB, "hex"),
          plaintext: "canonical writer",
          networkTag: "MONT",
        })
      );
      if (envelope?.v !== 2) throw new Error("builder must emit v2");
      // sharedPoint comes from the python implementation and has a 00 x lead byte for every pair.
      const key = Buffer.from(
        crypto.hkdfSync(
          "sha256",
          Buffer.from(pair.sharedPoint, "hex"),
          Buffer.from(envelope.salt, "hex"),
          info,
          32
        )
      );
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.nonce, "hex")
      );
      decipher.setAAD(
        Buffer.from(JSON.stringify([2, "MONT", addressA, addressB]), "utf8")
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "hex")),
        decipher.final(),
      ]).toString("utf8");
      expect(plaintext).toBe("canonical writer");
    }
  });

  it("round-trips one fixture pair of each pre-fix failure class in both directions", () => {
    const kinds = new Set<string>();
    const representatives = fixture.pairs.filter((pair) => {
      if (kinds.has(pair.legacyKinds)) return false;
      kinds.add(pair.legacyKinds);
      return true;
    });
    expect(representatives.map((pair) => pair.legacyKinds).sort()).toEqual([
      "PT",
      "TP",
      "TT",
      "issue",
    ]);
    for (const pair of representatives) {
      for (const [fromPriv, toPub, toPriv, fromPub, from, to] of [
        [pair.privA, pair.pubB, pair.privB, pair.pubA, addressA, addressB],
        [pair.privB, pair.pubA, pair.privA, pair.pubB, addressB, addressA],
      ] as const) {
        const envelope = parseEnvelope(
          buildEnvelope({
            fromAddress: from,
            fromPrivateKey: privateKey(fromPriv),
            toAddress: to,
            toPubKey: Buffer.from(toPub, "hex"),
            plaintext: "round trip",
            networkTag: "MONT",
          })
        );
        if (!envelope) throw new Error("builder output must parse");
        expect(
          tryDecryptEnvelope({
            envelope,
            myPrivateKey: privateKey(toPriv),
            senderPubKey: Buffer.from(fromPub, "hex"),
          })
        ).toBe("round trip");
      }
    }
  });

  // Every unordered pair of KEYS seeded keys (12 keys = 66 pairs by default, to keep the suite
  // usable under jest). The 10,011-pair sweep is packages/bitcore-lib-xpi/test/crypto/ecdh.js;
  // FRANK_ECDH_KEYS=142 runs the same sweep here too, but takes far longer under jest.
  const KEYS = Number(process.env.FRANK_ECDH_KEYS ?? 12);
  it(`agrees on the shared point for every pair of ${KEYS} seeded keys and matches OpenSSL's x`, () => {
    const secrets: Buffer[] = [];
    const privates: PrivateKey[] = [];
    const rawPublics: Buffer[] = [];
    const publics: PublicKey[] = [];
    for (let i = 0; i < KEYS; i++) {
      // Deterministic seed: SHA-256 of a counter, re-hashed until it is a valid scalar.
      let secret = bitcoreCrypto.Hash.sha256(Buffer.from(`frank-309-key-${i}`));
      while (!PrivateKey.isValid(secret.toString("hex"))) {
        secret = bitcoreCrypto.Hash.sha256(secret);
      }
      const key = privateKey(secret.toString("hex"));
      secrets.push(secret);
      privates.push(key);
      rawPublics.push(key.toPublicKey().toBuffer());
      publics.push(publicKey(rawPublics[i].toString("hex")));
    }
    let pairs = 0;
    const leadingZeroPairs: [number, number][] = [];
    for (let i = 0; i < KEYS; i++) {
      for (let j = i + 1; j < KEYS; j++) {
        const iSide = constructor_
          .constructMergedKey(privates[i], publics[j])
          .toBuffer();
        const jSide = constructor_
          .constructMergedKey(privates[j], publics[i])
          .toBuffer();
        if (iSide.length !== 33 || !iSide.equals(jSide)) {
          throw new Error(
            `pair ${i},${j}: ${iSide.toString("hex")} != ${jSide.toString(
              "hex"
            )}`
          );
        }
        const ecdh = crypto.createECDH("secp256k1");
        ecdh.setPrivateKey(secrets[i]);
        if (!ecdh.computeSecret(rawPublics[j]).equals(iSide.slice(1))) {
          throw new Error(`pair ${i},${j}: x differs from OpenSSL`);
        }
        pairs++;
        if (iSide[1] === 0) leadingZeroPairs.push([i, j]);
      }
    }
    expect(pairs).toBe((KEYS * (KEYS - 1)) / 2);
    // Full envelope round trip for every leading-zero pair found (about 1 in 256 pairs).
    for (const [i, j] of leadingZeroPairs.slice(0, 20)) {
      const envelope = parseEnvelope(
        buildEnvelope({
          fromAddress: addressA,
          fromPrivateKey: privates[i],
          toAddress: addressB,
          toPubKey: rawPublics[j],
          plaintext: `pair ${i} ${j}`,
          networkTag: "MONT",
        })
      );
      if (!envelope) throw new Error("builder output must parse");
      expect(
        decryptEnvelope({
          envelope,
          myPrivateKey: privates[j],
          senderPubKey: rawPublics[i],
        })
      ).toBe(`pair ${i} ${j}`);
    }
  }, 900_000);
});

describe("pre-#309 envelopes stay readable", () => {
  it("decrypts real envelopes written by the pre-fix code for every fixture pair", () => {
    for (const pair of fixture.pairs) {
      for (const [side, recipientPriv, senderPub] of [
        [pair.aToB, pair.privB, pair.pubA],
        [pair.bToA, pair.privA, pair.pubB],
      ] as const) {
        const envelope = parseEnvelope(bytesOf(side.envelope));
        if (!envelope) throw new Error("fixture envelope must parse");
        expect(
          decryptEnvelope({
            envelope,
            myPrivateKey: privateKey(recipientPriv),
            senderPubKey: Buffer.from(senderPub, "hex"),
          })
        ).toBe(side.plaintext);
      }
    }
  });

  it("covers every failure class the pre-fix code produced", () => {
    // Guard: the fixture really contains pairs the old code could not read (TP/PT/issue) and
    // pairs it read only because both sides trimmed identically (TT).
    const decryptable = (kind: string) =>
      fixture.pairs
        .filter((pair) => pair.legacyKinds === kind)
        .flatMap((pair) => [pair.aToB, pair.bToA])
        .map((side) => side.preFixDecrypts);
    for (const kind of ["issue", "TP", "PT"]) {
      expect(decryptable(kind).length).toBeGreaterThan(0);
      expect(decryptable(kind).every((ok) => !ok)).toBe(true);
    }
    expect(decryptable("TT").length).toBeGreaterThan(0);
    expect(decryptable("TT").every((ok) => ok)).toBe(true);
  });

  it("only falls back on authentication failure: tampering and wrong keys still fail", () => {
    const pair = fixture.pairs.find((p) => p.legacyKinds === "TT");
    if (!pair) throw new Error("fixture needs a TT pair");
    const envelope = parseEnvelope(bytesOf(pair.aToB.envelope));
    if (envelope?.v !== 2) throw new Error("expected v2");
    const flipped = {
      ...envelope,
      ciphertext:
        (envelope.ciphertext.startsWith("0") ? "1" : "0") +
        envelope.ciphertext.slice(1),
    };
    const args = {
      myPrivateKey: privateKey(pair.privB),
      senderPubKey: Buffer.from(pair.pubA, "hex"),
    };
    expect(decryptEnvelopeV2({ envelope, ...args })).toBe(pair.aToB.plaintext);
    expect(() => decryptEnvelopeV2({ envelope: flipped, ...args })).toThrow(
      "Monad envelope authentication failed"
    );
    expect(() =>
      decryptEnvelopeV2({
        envelope: { ...envelope, to: addressA },
        ...args,
      })
    ).toThrow("Monad envelope authentication failed");
    expect(() =>
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: privateKey("33".repeat(32)),
        senderPubKey: args.senderPubKey,
      })
    ).toThrow("Monad envelope authentication failed");
  });

  it("decrypts legacy v1 records keyed from either the canonical or the trimmed point", () => {
    const pair = fixture.pairs.find((p) => p.legacyKinds === "TT");
    if (!pair) throw new Error("fixture needs a TT pair");
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    for (const point of [pair.sharedPoint, pair.trimmedSharedPoint]) {
      const key = bitcoreCrypto.Hash.sha256hmac(
        Buffer.from(point, "hex"),
        salt
      );
      // constructSharedKey is HMAC(salt, point) via bitcore's argument order (data, key); build
      // the key exactly as PayloadConstructor does and encrypt with the shared AES-CBC helper.
      const sharedKey = bitcoreCrypto.Hash.sha256hmac(
        salt,
        Buffer.from(point, "hex")
      );
      expect(key).not.toEqual(sharedKey);
      const ciphertext = Buffer.from(
        constructor_.encrypt(
          sharedKey,
          Buffer.from("v1 hello, long enough text", "utf8")
        )
      );
      const envelope = parseEnvelope(
        Buffer.from(
          JSON.stringify({
            v: 1,
            networkTag: "MONT",
            from: addressA,
            to: addressB,
            salt: salt.toString("hex"),
            ciphertext: ciphertext.toString("hex"),
          })
        )
      );
      if (envelope?.v !== 1) throw new Error("expected v1");
      expect(
        decryptEnvelope({
          envelope,
          myPrivateKey: privateKey(pair.privB),
          senderPubKey: Buffer.from(pair.pubA, "hex"),
        })
      ).toBe("v1 hello, long enough text");
    }
  });
});

describe("constructSharedPointEncodings", () => {
  class FixedPoint extends PayloadConstructor {
    constructor(private readonly point: string) {
      super({ networkName: IDENTITY_KEY_NETWORK_NAME });
    }
    constructMergedKey() {
      return { toBuffer: () => Buffer.from(this.point, "hex") } as PublicKey;
    }
  }
  const encodings = (point: string) =>
    new FixedPoint(point)
      .constructSharedPointEncodings(
        privateKey("11".repeat(32)),
        publicKey(fixture.pairs[0].pubA)
      )
      .map((buffer) => buffer.toString("hex"));
  const x = "ab".repeat(32);

  it("offers only the canonical point when x has no leading zero", () => {
    expect(encodings(`02${x}`)).toEqual([`02${x}`]);
  });

  it("offers the canonical then the trimmed point for one leading zero byte", () => {
    expect(encodings(`03${"00"}${x.slice(2)}`)).toEqual([
      `0300${x.slice(2)}`,
      `03${x.slice(2)}`,
    ]);
  });

  it("trims every leading zero byte and keeps the parity prefix", () => {
    expect(encodings(`020000${x.slice(4)}`)).toEqual([
      `020000${x.slice(4)}`,
      `02${x.slice(4)}`,
    ]);
  });
});
