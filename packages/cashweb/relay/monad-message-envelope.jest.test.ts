import { PrivateKey, crypto as bitcoreCrypto } from "bitcore-lib-xpi";

import { IDENTITY_KEY_NETWORK_NAME } from "../legacy-wallet/lotus-identity";
import {
  LegacyMonadMessageEnvelopeV1,
  MonadMessageEnvelopeV2,
  buildEnvelope,
  decryptEnvelope,
  decryptEnvelopeV2,
  parseEnvelope,
} from "./monad-message-envelope";

const alicePrivateKey = PrivateKey.fromBuffer(
  Buffer.from("11".repeat(32), "hex"),
  IDENTITY_KEY_NETWORK_NAME
);
const bobPrivateKey = PrivateKey.fromBuffer(
  Buffer.from("22".repeat(32), "hex"),
  IDENTITY_KEY_NETWORK_NAME
);
const wrongPrivateKey = PrivateKey.fromBuffer(
  Buffer.from("33".repeat(32), "hex"),
  IDENTITY_KEY_NETWORK_NAME
);
const alicePubKey = alicePrivateKey.toPublicKey().toBuffer();
const bobPubKey = bobPrivateKey.toPublicKey().toBuffer();
const aliceAddress = "0x1111111111111111111111111111111111111111";
const bobAddress = "0x2222222222222222222222222222222222222222";
const fixedSalt = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex"
);
const fixedNonce = Buffer.from("202122232425262728292a2b", "hex");

function useFixedEntropy(): void {
  jest
    .spyOn(bitcoreCrypto.Random, "getRandomBuffer")
    .mockImplementation((size: number) => {
      if (size === fixedSalt.length) return Buffer.from(fixedSalt);
      if (size === fixedNonce.length) return Buffer.from(fixedNonce);
      throw new Error(`unexpected random byte request: ${size}`);
    });
}

function buildFixedV2(): MonadMessageEnvelopeV2 {
  useFixedEntropy();
  const parsed = parseEnvelope(
    buildEnvelope({
      fromAddress: aliceAddress,
      fromPrivateKey: alicePrivateKey,
      toAddress: bobAddress,
      toPubKey: bobPubKey,
      plaintext: "authenticated hello",
      networkTag: "MONT",
    })
  );
  if (parsed?.v !== 2) throw new Error("expected v2 fixture");
  return parsed;
}

function flipFirstByte(hex: string): string {
  return `${hex.startsWith("00") ? "01" : "00"}${hex.slice(2)}`;
}

afterEach(() => jest.restoreAllMocks());

describe("Monad message envelope v2", () => {
  it("matches a fixed vector and round-trips sender to recipient", () => {
    const envelope = buildFixedV2();

    expect(envelope).toEqual({
      v: 2,
      networkTag: "MONT",
      from: aliceAddress,
      to: bobAddress,
      salt: fixedSalt.toString("hex"),
      nonce: fixedNonce.toString("hex"),
      ciphertext: "b73042ba4d507d575cc6d36b58372b5a46bff5",
      tag: "67f6610584a46d17c8764e88222dd578",
    });
    expect(
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: bobPrivateKey,
        senderPubKey: alicePubKey,
      })
    ).toBe("authenticated hello");
  });

  it("round-trips recipient to sender with the same identity ECDH construction", () => {
    useFixedEntropy();
    const envelope = parseEnvelope(
      buildEnvelope({
        fromAddress: bobAddress,
        fromPrivateKey: bobPrivateKey,
        toAddress: aliceAddress,
        toPubKey: alicePubKey,
        plaintext: "the other direction",
        networkTag: "MONT",
      })
    );
    if (envelope?.v !== 2) throw new Error("expected v2 envelope");

    expect(
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: alicePrivateKey,
        senderPubKey: bobPubKey,
      })
    ).toBe("the other direction");
  });

  it("lets either party construct a transcript and carries no sender signature", () => {
    useFixedEntropy();
    // Bob constructs a transcript whose authenticated metadata says Alice sent it to Bob. This
    // succeeds because Bob knows the same ECDH-derived AEAD key; there is no publicly verifiable
    // sender signature to distinguish who constructed it.
    const envelope = parseEnvelope(
      buildEnvelope({
        fromAddress: aliceAddress,
        fromPrivateKey: bobPrivateKey,
        toAddress: bobAddress,
        toPubKey: alicePubKey,
        plaintext: "deniable transcript",
        networkTag: "MONT",
      })
    );
    if (envelope?.v !== 2) throw new Error("expected v2 envelope");

    expect(Object.keys(envelope).sort()).toEqual(
      [
        "ciphertext",
        "from",
        "networkTag",
        "nonce",
        "salt",
        "tag",
        "to",
        "v",
      ].sort()
    );
    expect(
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: bobPrivateKey,
        senderPubKey: alicePubKey,
      })
    ).toBe("deniable transcript");
  });

  it.each([
    [
      "networkTag",
      (envelope: MonadMessageEnvelopeV2) => ({
        ...envelope,
        networkTag: "MON1",
      }),
    ],
    [
      "from",
      (envelope: MonadMessageEnvelopeV2) => ({
        ...envelope,
        from: `0x${"33".repeat(20)}`,
      }),
    ],
    [
      "to",
      (envelope: MonadMessageEnvelopeV2) => ({
        ...envelope,
        to: `0x${"44".repeat(20)}`,
      }),
    ],
    [
      "salt",
      (envelope: MonadMessageEnvelopeV2) => ({
        ...envelope,
        salt: flipFirstByte(envelope.salt),
      }),
    ],
    [
      "nonce",
      (envelope: MonadMessageEnvelopeV2) => ({
        ...envelope,
        nonce: flipFirstByte(envelope.nonce),
      }),
    ],
    [
      "ciphertext",
      (envelope: MonadMessageEnvelopeV2) => ({
        ...envelope,
        ciphertext: flipFirstByte(envelope.ciphertext),
      }),
    ],
    [
      "tag",
      (envelope: MonadMessageEnvelopeV2) => ({
        ...envelope,
        tag: flipFirstByte(envelope.tag),
      }),
    ],
  ])("rejects %s tampering", (_field, tamper) => {
    const envelope = tamper(buildFixedV2());
    expect(() =>
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: bobPrivateKey,
        senderPubKey: alicePubKey,
      })
    ).toThrow();
  });

  it("rejects a wrong recipient identity", () => {
    const envelope = buildFixedV2();
    expect(() =>
      decryptEnvelopeV2({
        envelope,
        myPrivateKey: wrongPrivateKey,
        senderPubKey: alicePubKey,
      })
    ).toThrow();
  });

  it.each([
    ["missing field", ({ tag: _tag, ...rest }: MonadMessageEnvelopeV2) => rest],
    [
      "unknown version",
      (value: MonadMessageEnvelopeV2) => ({ ...value, v: 3 }),
    ],
    [
      "short salt",
      (value: MonadMessageEnvelopeV2) => ({ ...value, salt: "00" }),
    ],
    [
      "long nonce",
      (value: MonadMessageEnvelopeV2) => ({
        ...value,
        nonce: `${value.nonce}00`,
      }),
    ],
    [
      "short tag",
      (value: MonadMessageEnvelopeV2) => ({
        ...value,
        tag: value.tag.slice(2),
      }),
    ],
    [
      "odd ciphertext",
      (value: MonadMessageEnvelopeV2) => ({ ...value, ciphertext: "0" }),
    ],
    [
      "uppercase ciphertext",
      (value: MonadMessageEnvelopeV2) => ({ ...value, ciphertext: "AA" }),
    ],
    [
      "empty ciphertext",
      (value: MonadMessageEnvelopeV2) => ({ ...value, ciphertext: "" }),
    ],
    [
      "invalid from",
      (value: MonadMessageEnvelopeV2) => ({ ...value, from: "0x11" }),
    ],
    [
      "invalid to hex",
      (value: MonadMessageEnvelopeV2) => ({
        ...value,
        to: `0x${"gg".repeat(20)}`,
      }),
    ],
    [
      "empty network tag",
      (value: MonadMessageEnvelopeV2) => ({ ...value, networkTag: "" }),
    ],
  ])("rejects malformed v2: %s", (_case, mutate) => {
    const malformed = mutate(buildFixedV2());
    expect(
      parseEnvelope(Buffer.from(JSON.stringify(malformed)))
    ).toBeUndefined();
  });

  it("tolerates additive fields without changing the authenticated core", () => {
    const envelope = buildFixedV2();
    const parsed = parseEnvelope(
      Buffer.from(JSON.stringify({ ...envelope, futureField: "ignored" }))
    );
    expect(parsed).toEqual({ ...envelope, futureField: "ignored" });
    if (parsed?.v !== 2) throw new Error("expected v2 envelope");
    expect(
      decryptEnvelopeV2({
        envelope: parsed,
        myPrivateKey: bobPrivateKey,
        senderPubKey: alicePubKey,
      })
    ).toBe("authenticated hello");
  });
});

describe("legacy v1 read compatibility", () => {
  it("decrypts an explicit already-stored fixture and has no write path", () => {
    const fixture: LegacyMonadMessageEnvelopeV1 = {
      v: 1,
      networkTag: "MONT",
      from: aliceAddress,
      to: bobAddress,
      salt: "000102030405060708090a0b0c0d0e0f",
      ciphertext: "0883c052cf7a91ff20dab2c3a06bb75f",
    };
    const parsed = parseEnvelope(Buffer.from(JSON.stringify(fixture)));
    expect(parsed).toEqual(fixture);
    if (parsed === undefined) throw new Error("expected legacy fixture");
    expect(
      decryptEnvelope({
        envelope: parsed,
        myPrivateKey: bobPrivateKey,
        senderPubKey: alicePubKey,
      })
    ).toBe("legacy hello");
  });
});
