import { PrivateKey, crypto as bitcoreCrypto } from "bitcore-lib-xpi";

import { IDENTITY_KEY_NETWORK_NAME } from "../legacy-wallet/lotus-identity";
import { PayloadConstructor } from "./crypto";
import {
  LegacyMonadMessageEnvelopeV1,
  MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES,
  MonadMessageEnvelopeV2,
  buildEnvelope,
  decryptEnvelope,
  decryptEnvelopeV2,
  parseEnvelope,
} from "./monad-message-envelope";
import { MonadStampedMessage, MonadStampPayment } from "./monad_message_pb";

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

  it("draws fresh salt and nonce entropy for every sequential envelope", () => {
    const entropy = [
      Buffer.alloc(32, 0x01),
      Buffer.alloc(12, 0x02),
      Buffer.alloc(32, 0x03),
      Buffer.alloc(12, 0x04),
    ];
    const random = jest
      .spyOn(bitcoreCrypto.Random, "getRandomBuffer")
      .mockImplementation((size: number) => {
        const next = entropy.shift();
        if (next === undefined || next.length !== size) {
          throw new Error(`unexpected random byte request: ${size}`);
        }
        return next;
      });
    const build = (): MonadMessageEnvelopeV2 => {
      const envelope = parseEnvelope(
        buildEnvelope({
          fromAddress: aliceAddress,
          fromPrivateKey: alicePrivateKey,
          toAddress: bobAddress,
          toPubKey: bobPubKey,
          plaintext: "fresh entropy",
          networkTag: "MONT",
        })
      );
      if (envelope?.v !== 2) throw new Error("expected v2 envelope");
      return envelope;
    };

    const first = build();
    const second = build();
    expect(random.mock.calls.map(([size]) => size)).toEqual([32, 12, 32, 12]);
    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it.each([
    "0xde709f2102306220921060314715629080e2fb77",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE",
  ])(
    "accepts the same canonical EVM address vector as the relay: %s",
    (address) => {
      const envelope = { ...buildFixedV2(), from: address };
      expect(parseEnvelope(Buffer.from(JSON.stringify(envelope)))).toEqual(
        envelope
      );
      expect(
        parseEnvelope(
          buildEnvelope({
            fromAddress: address,
            fromPrivateKey: alicePrivateKey,
            toAddress: bobAddress,
            toPubKey: bobPubKey,
            plaintext: "canonical address",
            networkTag: "MONT",
          })
        )?.from
      ).toBe(address);
    }
  );

  it("rejects an invalid EIP-55 checksum in parsing and building", () => {
    const invalid = "0x5AEDA56215b167893e80B4fE645BA6d5Bab767De";
    const envelope = { ...buildFixedV2(), from: invalid };
    expect(
      parseEnvelope(Buffer.from(JSON.stringify(envelope)))
    ).toBeUndefined();
    expect(() =>
      buildEnvelope({
        fromAddress: invalid,
        fromPrivateKey: alicePrivateKey,
        toAddress: bobAddress,
        toPubKey: bobPubKey,
        plaintext: "bad checksum",
        networkTag: "MONT",
      })
    ).toThrow("addresses");
  });

  it("keeps maximum builder output below the relay body cap with framing headroom", () => {
    useFixedEntropy();
    const bytes = buildEnvelope({
      fromAddress: aliceAddress,
      fromPrivateKey: alicePrivateKey,
      toAddress: bobAddress,
      toPubKey: bobPubKey,
      plaintext: "a".repeat(MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES),
      networkTag: "MONT",
    });
    expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024 - 128 * 1024);
    expect(parseEnvelope(bytes)?.v).toBe(2);
    expect(() =>
      buildEnvelope({
        fromAddress: aliceAddress,
        fromPrivateKey: alicePrivateKey,
        toAddress: bobAddress,
        toPubKey: bobPubKey,
        plaintext: "a".repeat(MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES + 1),
        networkTag: "MONT",
      })
    ).toThrow(`${MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES}`);
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

  it("reads a historically valid near-cap ciphertext whose signed request fits 2 MiB", () => {
    const ciphertextBytes = 982_544;
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const legacyCrypto = new PayloadConstructor({
      networkName: IDENTITY_KEY_NETWORK_NAME,
    });
    const sharedKey = legacyCrypto.constructSharedKey(
      alicePrivateKey,
      bobPrivateKey.toPublicKey(),
      salt
    );
    // PKCS#7 adds one byte to this 15-mod-16 plaintext, producing the historical ciphertext size.
    const plaintext = Buffer.alloc(ciphertextBytes - 1, 0x61);
    const ciphertext = Buffer.from(legacyCrypto.encrypt(sharedKey, plaintext));
    expect(ciphertext).toHaveLength(ciphertextBytes);

    const fixture: LegacyMonadMessageEnvelopeV1 = {
      v: 1,
      networkTag: "MONT",
      from: aliceAddress,
      to: bobAddress,
      salt: salt.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    };
    const envelopeBytes = Buffer.from(JSON.stringify(fixture));

    // Real offline-signed EIP-1559 transfer fixture (chain 10143), representative of the payment
    // bytes carried alongside the envelope in MonadStampedMessage.
    const rawSignedPayment = Buffer.from(
      "02f87482279f2a843b9aca00847735940082520894000000000000000000000000000000000000dead" +
        "880de0b6b3a764000080c001a0f6e40fcbe38269601e35c9304273101e0e69128ccb13c66734990a" +
        "825d2b0b23a04eb4a16dc6287ab5e47d9e24d4cdcf4da765d9cd15a9c1e5aeb97d557db0a612",
      "hex"
    );
    const payment = new MonadStampPayment();
    payment.setChildIndex(0);
    payment.setRawTx(rawSignedPayment);
    const request = new MonadStampedMessage();
    request.setEncryptedPayload(envelopeBytes);
    request.setPayloadHash(bitcoreCrypto.Hash.sha256(envelopeBytes));
    request.addStampPayments(payment);
    expect(request.serializeBinary().length).toBeLessThan(2 * 1024 * 1024);

    const parsed = parseEnvelope(envelopeBytes);
    expect(parsed?.v).toBe(1);
    if (parsed?.v !== 1) throw new Error("expected legacy v1 envelope");
    const decrypted = decryptEnvelope({
      envelope: parsed,
      myPrivateKey: bobPrivateKey,
      senderPubKey: alicePubKey,
    });
    expect(decrypted).toHaveLength(plaintext.length);
    expect(decrypted.startsWith("a")).toBe(true);
    expect(decrypted.endsWith("a")).toBe(true);
  });
});
