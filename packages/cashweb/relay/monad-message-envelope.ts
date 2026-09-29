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
const MAX_RELAY_BODY_BYTES = 2 * 1024 * 1024;
const MIN_RELAY_FRAMING_HEADROOM_BYTES = 128 * 1024;
const MAX_ENVELOPE_JSON_OVERHEAD_BYTES = 1024;
/**
 * Exact v2 plaintext/ciphertext bound. Hex encoding doubles ciphertext size; reserving 1 KiB for
 * the JSON fields and 128 KiB for protobuf/hash/payment framing ensures every builder output fits
 * the relay's 2 MiB request cap with useful framing headroom.
 */
export const MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES = Math.floor(
  (MAX_RELAY_BODY_BYTES -
    MIN_RELAY_FRAMING_HEADROOM_BYTES -
    MAX_ENVELOPE_JSON_OVERHEAD_BYTES) /
    2
);
const MAX_V2_CIPHERTEXT_BYTES = MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES;
// V1 has no write path. Preserve its historical 1 MiB read ceiling so already-stored records do
// not become unreadable when the stricter request-framing limit is applied to new v2 envelopes.
const MAX_LEGACY_READ_CIPHERTEXT_BYTES = MAX_RELAY_BODY_BYTES / 2;
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

const KECCAK_MASK_64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const KECCAK_RATE_BYTES = 136;
const KECCAK_ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18,
  2, 61, 56, 14,
];
const KECCAK_ROUND_CONSTANTS = [
  "0000000000000001",
  "0000000000008082",
  "800000000000808a",
  "8000000080008000",
  "000000000000808b",
  "0000000080000001",
  "8000000080008081",
  "8000000000008009",
  "000000000000008a",
  "0000000000000088",
  "0000000080008009",
  "000000008000000a",
  "000000008000808b",
  "800000000000008b",
  "8000000000008089",
  "8000000000008003",
  "8000000000008002",
  "8000000000000080",
  "000000000000800a",
  "800000008000000a",
  "8000000080008081",
  "8000000000008080",
  "0000000080000001",
  "8000000080008008",
].map((value) => BigInt(`0x${value}`));

function rotateLane(value: bigint, bits: number): bigint {
  if (bits === 0) return value;
  const shift = BigInt(bits);
  return ((value << shift) | (value >> (BigInt(64) - shift))) & KECCAK_MASK_64;
}

/** Minimal Keccak-256 used only for EIP-55 address checksum validation. */
function keccak256(bytes: Uint8Array): Uint8Array {
  const paddedLength =
    Math.ceil((bytes.length + 1) / KECCAK_RATE_BYTES) * KECCAK_RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  // Ethereum uses legacy Keccak's 0x01 domain suffix, not FIPS SHA3's 0x06.
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const state = Array<bigint>(25).fill(BigInt(0));
  for (let block = 0; block < padded.length; block += KECCAK_RATE_BYTES) {
    for (let lane = 0; lane < KECCAK_RATE_BYTES / 8; lane++) {
      let word = BigInt(0);
      for (let byte = 0; byte < 8; byte++) {
        word |= BigInt(padded[block + lane * 8 + byte]) << BigInt(byte * 8);
      }
      state[lane] ^= word;
    }

    for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
      const columns = Array<bigint>(5).fill(BigInt(0));
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) columns[x] ^= state[x + 5 * y];
      }
      const deltas = columns.map(
        (_column, x) =>
          columns[(x + 4) % 5] ^ rotateLane(columns[(x + 1) % 5], 1)
      );
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) state[x + 5 * y] ^= deltas[x];
      }

      const rotated = Array<bigint>(25).fill(BigInt(0));
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          rotated[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLane(
            state[x + 5 * y],
            KECCAK_ROTATIONS[x + 5 * y]
          );
        }
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          state[x + 5 * y] =
            rotated[x + 5 * y] ^
            (~rotated[((x + 1) % 5) + 5 * y] &
              KECCAK_MASK_64 &
              rotated[((x + 2) % 5) + 5 * y]);
        }
      }
      state[0] ^= roundConstant;
    }
  }

  const digest = new Uint8Array(32);
  for (let index = 0; index < digest.length; index++) {
    digest[index] = Number(
      (state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & BigInt(0xff)
    );
  }
  return digest;
}

function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return false;
  }
  const body = value.slice(2);
  const lower = body.toLowerCase();
  if (body === lower) return true;
  const checksum = keccak256(textEncoder.encode(lower));
  return [...body].every((character, index) => {
    if (/\d/.test(character)) return true;
    const byte = checksum[Math.floor(index / 2)];
    const nibble = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    return (character === character.toUpperCase()) === nibble >= 8;
  });
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
      maxBytes: MAX_V2_CIPHERTEXT_BYTES,
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
      maxBytes: MAX_LEGACY_READ_CIPHERTEXT_BYTES,
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
  if (plaintext.length === 0 || plaintext.length > MAX_V2_CIPHERTEXT_BYTES) {
    throw new Error(
      `Monad envelope plaintext must be 1..${MAX_V2_CIPHERTEXT_BYTES} UTF-8 bytes`
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
    forge.util.createBuffer(key.toString("binary"))
  );
  cipher.start({
    iv: forge.util.createBuffer(nonce.toString("binary")),
    additionalData: associatedData(core).toString("binary"),
    tagLength: GCM_TAG_BYTES * 8,
  });
  cipher.update(forge.util.createBuffer(plaintext.toString("binary")));
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
    forge.util.createBuffer(key.toString("binary"))
  );
  decipher.start({
    iv: forge.util.createBuffer(nonce.toString("binary")),
    additionalData: associatedData(params.envelope).toString("binary"),
    tagLength: GCM_TAG_BYTES * 8,
    tag: forge.util.createBuffer(
      Buffer.from(params.envelope.tag, "hex").toString("binary")
    ),
  });
  decipher.update(
    forge.util.createBuffer(
      Buffer.from(params.envelope.ciphertext, "hex").toString("binary")
    )
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
