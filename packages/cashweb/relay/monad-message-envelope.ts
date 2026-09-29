/**
 * Versioned, deniable authenticated encryption for Monad direct messages.
 *
 * Version 2 derives an AES-256-GCM key from the identities' secp256k1 ECDH point with
 * HKDF-SHA256. The HKDF info string separates this key from every other use of the long-lived
 * identity ECDH secret. A fresh 32-byte salt and 96-bit nonce are generated for every envelope.
 *
 * The exact UTF-8 encoding of `JSON.stringify([2, networkTag, from, to])` is the GCM associated
 * data. This length-delimited JSON tuple unambiguously authenticates the version, network, sender,
 * and recipient without a stable public signature. Both identities know the same AEAD key, so
 * either party can construct an indistinguishable valid transcript; that deniability is
 * intentional.
 *
 * Version 1 is retained only as an explicitly named read path for already-stored AES-CBC
 * envelopes. New builders never emit it, and the relay does not admit it on PUT.
 */
import {
  PrivateKey,
  PublicKey,
  crypto as bitcoreCrypto,
} from "bitcore-lib-xpi";
import * as forge from "node-forge";

import { PayloadConstructor } from "../relay/crypto";
import { IDENTITY_KEY_NETWORK_NAME } from "../legacy-wallet/lotus-identity";

const payloadConstructor = new PayloadConstructor({
  networkName: IDENTITY_KEY_NETWORK_NAME,
});

const CURRENT_ENVELOPE_VERSION = 2 as const;
const LEGACY_ENVELOPE_VERSION = 1 as const;
const HKDF_SALT_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const MAX_NETWORK_TAG_BYTES = 32;
const HKDF_INFO = Buffer.from(
  "frank:monad-dm-envelope:v2:identity-ecdh:aes-256-gcm",
  "ascii"
);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface MonadMessageEnvelopeV2 {
  v: 2;
  networkTag: string;
  from: string;
  to: string;
  /** Hex-encoded, random 32-byte HKDF-SHA256 salt. */
  salt: string;
  /** Hex-encoded, unique random 96-bit AES-GCM nonce. */
  nonce: string;
  /** Hex-encoded AES-256-GCM ciphertext, excluding the authentication tag. */
  ciphertext: string;
  /** Hex-encoded 16-byte AES-GCM authentication tag. */
  tag: string;
}

/** Read-only compatibility shape for records stored before authenticated v2 envelopes. */
export interface LegacyMonadMessageEnvelopeV1 {
  v: 1;
  networkTag: string;
  from: string;
  to: string;
  /** Hex-encoded 16-byte salt used by the legacy HMAC-SHA256 derivation. */
  salt: string;
  /** Hex-encoded legacy AES-CBC ciphertext. */
  ciphertext: string;
}

export type MonadMessageEnvelope =
  | MonadMessageEnvelopeV2
  | LegacyMonadMessageEnvelopeV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  // EVM's canonical lower-case and EIP-55 forms share this exact syntax. The relay additionally
  // verifies mixed-case EIP-55 checksums before admitting a new v2 envelope.
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isNetworkTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    textEncoder.encode(value).length <= MAX_NETWORK_TAG_BYTES
  );
}

function isLowerHexBytes(
  value: unknown,
  options: { exactBytes?: number; minBytes?: number; maxBytes?: number }
): value is string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    return false;
  }
  const bytes = value.length / 2;
  return (
    (options.exactBytes === undefined || bytes === options.exactBytes) &&
    (options.minBytes === undefined || bytes >= options.minBytes) &&
    (options.maxBytes === undefined || bytes <= options.maxBytes)
  );
}

function isMonadMessageEnvelopeV2(
  value: unknown
): value is MonadMessageEnvelopeV2 {
  if (!isRecord(value)) return false;
  return (
    value.v === CURRENT_ENVELOPE_VERSION &&
    isNetworkTag(value.networkTag) &&
    isAddress(value.from) &&
    isAddress(value.to) &&
    isLowerHexBytes(value.salt, { exactBytes: HKDF_SALT_BYTES }) &&
    isLowerHexBytes(value.nonce, { exactBytes: GCM_NONCE_BYTES }) &&
    isLowerHexBytes(value.ciphertext, {
      minBytes: 1,
      maxBytes: MAX_CIPHERTEXT_BYTES,
    }) &&
    isLowerHexBytes(value.tag, { exactBytes: GCM_TAG_BYTES })
  );
}

function isLegacyMonadMessageEnvelopeV1(
  value: unknown
): value is LegacyMonadMessageEnvelopeV1 {
  if (!isRecord(value)) return false;
  return (
    value.v === LEGACY_ENVELOPE_VERSION &&
    isNetworkTag(value.networkTag) &&
    isAddress(value.from) &&
    isAddress(value.to) &&
    isLowerHexBytes(value.salt, { exactBytes: 16 }) &&
    isLowerHexBytes(value.ciphertext, {
      minBytes: 16,
      maxBytes: MAX_CIPHERTEXT_BYTES,
    }) &&
    value.ciphertext.length % 32 === 0
  );
}

function associatedData(envelope: {
  networkTag: string;
  from: string;
  to: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      CURRENT_ENVELOPE_VERSION,
      envelope.networkTag,
      envelope.from,
      envelope.to,
    ]),
    "utf8"
  );
}

function deriveV2Key(params: {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  salt: Buffer;
}): Buffer {
  const ecdhPoint = payloadConstructor
    .constructMergedKey(params.privateKey, params.publicKey)
    .toBuffer();
  // RFC 5869 extract + the first (and only) expand block. SHA-256 emits the requested 32 bytes
  // in one block: PRK = HMAC(salt, IKM), OKM = HMAC(PRK, info || 0x01).
  const pseudorandomKey = bitcoreCrypto.Hash.sha256hmac(ecdhPoint, params.salt);
  return bitcoreCrypto.Hash.sha256hmac(
    Buffer.concat([HKDF_INFO, Buffer.from([1])]),
    pseudorandomKey
  );
}

/** Builds a v2 encrypted envelope for `MonadStampedMessage.encrypted_payload`. */
export function buildEnvelope(params: {
  fromAddress: string;
  fromPrivateKey: PrivateKey;
  toAddress: string;
  toPubKey: Buffer;
  plaintext: string;
  /** Frank network tag (for example `MONT`), not an EVM chain ID. */
  networkTag: string;
}): Uint8Array {
  if (!isAddress(params.fromAddress) || !isAddress(params.toAddress)) {
    throw new Error("Monad envelope addresses must be 0x-prefixed 20-byte hex");
  }
  if (!isNetworkTag(params.networkTag)) {
    throw new Error("Monad envelope networkTag must be 1..32 UTF-8 bytes");
  }
  const plaintext = Buffer.from(params.plaintext, "utf8");
  if (plaintext.length === 0 || plaintext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error(
      `Monad envelope plaintext must be 1..${MAX_CIPHERTEXT_BYTES} UTF-8 bytes`
    );
  }

  const salt = bitcoreCrypto.Random.getRandomBuffer(HKDF_SALT_BYTES);
  const nonce = bitcoreCrypto.Random.getRandomBuffer(GCM_NONCE_BYTES);
  const core = {
    networkTag: params.networkTag,
    from: params.fromAddress,
    to: params.toAddress,
  };
  const key = deriveV2Key({
    privateKey: params.fromPrivateKey,
    publicKey: PublicKey.fromBuffer(params.toPubKey),
    salt,
  });
  const cipher = forge.cipher.createCipher(
    "AES-GCM",
    forge.util.createBuffer(key)
  );
  cipher.start({
    iv: forge.util.createBuffer(nonce),
    additionalData: associatedData(core).toString("binary"),
    tagLength: GCM_TAG_BYTES * 8,
  });
  cipher.update(forge.util.createBuffer(plaintext));
  if (!cipher.finish()) throw new Error("AES-GCM encryption failed");
  const envelope: MonadMessageEnvelopeV2 = {
    v: CURRENT_ENVELOPE_VERSION,
    ...core,
    salt: salt.toString("hex"),
    nonce: nonce.toString("hex"),
    ciphertext: cipher.output.toHex(),
    tag: cipher.mode.tag.toHex(),
  };
  return textEncoder.encode(JSON.stringify(envelope));
}

/**
 * Parses stored envelope bytes. V2 is the current authenticated format; v1 is returned only for
 * explicit read compatibility. Unsupported versions and malformed fields are rejected.
 */
export function parseEnvelope(
  bytes: Uint8Array
): MonadMessageEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch {
    return undefined;
  }
  if (isMonadMessageEnvelopeV2(parsed)) return parsed;
  if (isLegacyMonadMessageEnvelopeV1(parsed)) return parsed;
  return undefined;
}

/** Decrypts the current authenticated v2 format. Authentication failure throws. */
export function decryptEnvelopeV2(params: {
  envelope: MonadMessageEnvelopeV2;
  myPrivateKey: PrivateKey;
  senderPubKey: Buffer;
}): string {
  const salt = Buffer.from(params.envelope.salt, "hex");
  const nonce = Buffer.from(params.envelope.nonce, "hex");
  const key = deriveV2Key({
    privateKey: params.myPrivateKey,
    publicKey: PublicKey.fromBuffer(params.senderPubKey),
    salt,
  });
  const decipher = forge.cipher.createDecipher(
    "AES-GCM",
    forge.util.createBuffer(key)
  );
  decipher.start({
    iv: forge.util.createBuffer(nonce),
    additionalData: associatedData(params.envelope).toString("binary"),
    tagLength: GCM_TAG_BYTES * 8,
    tag: forge.util.createBuffer(Buffer.from(params.envelope.tag, "hex")),
  });
  decipher.update(
    forge.util.createBuffer(Buffer.from(params.envelope.ciphertext, "hex"))
  );
  if (!decipher.finish())
    throw new Error("Monad envelope authentication failed");
  const plaintext = Buffer.from(decipher.output.toHex(), "hex");
  return textDecoder.decode(plaintext);
}

/** Decrypts an already-stored legacy v1 record. There is deliberately no v1 builder. */
export function decryptLegacyEnvelopeV1(params: {
  envelope: LegacyMonadMessageEnvelopeV1;
  myPrivateKey: PrivateKey;
  senderPubKey: Buffer;
}): string {
  const sharedKey = payloadConstructor.constructSharedKey(
    params.myPrivateKey,
    PublicKey.fromBuffer(params.senderPubKey),
    Buffer.from(params.envelope.salt, "hex")
  );
  const plaintext = payloadConstructor.decrypt(
    sharedKey,
    Buffer.from(params.envelope.ciphertext, "hex")
  );
  return textDecoder.decode(plaintext);
}

/** Decrypts a parsed stored envelope, dispatching v1 only to its named read-only path. */
export function decryptEnvelope(params: {
  envelope: MonadMessageEnvelope;
  myPrivateKey: PrivateKey;
  senderPubKey: Buffer;
}): string {
  if (params.envelope.v === CURRENT_ENVELOPE_VERSION) {
    return decryptEnvelopeV2({
      envelope: params.envelope,
      myPrivateKey: params.myPrivateKey,
      senderPubKey: params.senderPubKey,
    });
  }
  return decryptLegacyEnvelopeV1({
    envelope: params.envelope,
    myPrivateKey: params.myPrivateKey,
    senderPubKey: params.senderPubKey,
  });
}
