import * as crypto from 'node:crypto';
import {
  deriveOpenPgpSeeds,
  OPENPGP_CANONICAL_CREATION_TIMESTAMP,
} from '@frank/domain-roots';
import { SigningKey } from 'ethers';
import type { InboundRecipientResolution } from '../smtp/inbound-server';

/**
 * z-base-32 alphabet specified in draft-koch-openpgp-webkey-service section 3.1
 * (and Phil Zimmermann's human-oriented base-32 encoding).
 */
export const Z_BASE_32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

const Z_BASE_32_32_REGEX = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/;

/**
 * Encodes a 20-byte (160-bit) SHA-1 digest into a 32-character z-base-32 string.
 */
export function encodeZBase32Sha1(sha1Bytes: Uint8Array): string {
  if (sha1Bytes.byteLength !== 20) {
    throw new Error(`Expected 20-byte SHA-1 digest for z-base-32 encoding, got ${sha1Bytes.byteLength}`);
  }
  let out = '';
  for (let offset = 0; offset < 20; offset += 5) {
    const b0 = sha1Bytes[offset];
    const b1 = sha1Bytes[offset + 1];
    const b2 = sha1Bytes[offset + 2];
    const b3 = sha1Bytes[offset + 3];
    const b4 = sha1Bytes[offset + 4];

    out += Z_BASE_32_ALPHABET[(b0 >> 3) & 0x1f];
    out += Z_BASE_32_ALPHABET[((b0 & 0x07) << 2) | (b1 >> 6)];
    out += Z_BASE_32_ALPHABET[(b1 >> 1) & 0x1f];
    out += Z_BASE_32_ALPHABET[((b1 & 0x01) << 4) | (b2 >> 4)];
    out += Z_BASE_32_ALPHABET[((b2 & 0x0f) << 1) | (b3 >> 7)];
    out += Z_BASE_32_ALPHABET[(b3 >> 2) & 0x1f];
    out += Z_BASE_32_ALPHABET[((b3 & 0x03) << 3) | (b4 >> 5)];
    out += Z_BASE_32_ALPHABET[b4 & 0x1f];
  }
  return out;
}

/**
 * Computes the OpenPGP Web Key Directory (WKD) 32-character z-base-32 hash (`<hu>`)
 * of an email address local-part per draft-koch-openpgp-webkey-service section 3.1.
 *
 * Test vector:
 *   `Joe.Doe@Example.ORG` -> local-part `"joe.doe"` -> `iy9q119eutrkn8s1mk4r39qejnbu3n5q`
 */
export function wkdHashLocalPart(localPart: string): string {
  const normalized = localPart.trim().toLowerCase();
  if (!normalized) {
    throw new Error('WKD local-part must not be empty');
  }
  const sha1 = crypto.createHash('sha1').update(Buffer.from(normalized, 'utf8')).digest();
  return encodeZBase32Sha1(sha1);
}

/**
 * Returns true if `hu` is a syntactically valid 32-character z-base-32 WKD hash.
 */
export function isValidWkdHash(hu: string): boolean {
  return typeof hu === 'string' && Z_BASE_32_32_REGEX.test(hu);
}

export interface WkdUrls {
  readonly localPart: string;
  readonly domain: string;
  readonly hu: string;
  readonly advancedUrl: string;
  readonly directUrl: string;
  readonly advancedPolicyUrl: string;
  readonly directPolicyUrl: string;
}

/**
 * Builds both the Advanced and Direct WKD lookup and policy URLs for an email address
 * per draft-koch-openpgp-webkey-service section 3.1.
 */
export function wkdUrlsForAddress(emailAddress: string): WkdUrls {
  const trimmed = emailAddress.trim();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    throw new Error(`Invalid email address for WKD lookup: ${emailAddress}`);
  }
  const localPart = trimmed.slice(0, atIndex).trim().toLowerCase();
  const domain = trimmed.slice(atIndex + 1).trim().toLowerCase();
  if (!localPart || !domain || domain.includes('/')) {
    throw new Error(`Invalid email address for WKD lookup: ${emailAddress}`);
  }
  const hu = wkdHashLocalPart(localPart);
  const encodedLocal = encodeURIComponent(localPart);
  return {
    localPart,
    domain,
    hu,
    advancedUrl: `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hu}?l=${encodedLocal}`,
    directUrl: `https://${domain}/.well-known/openpgpkey/hu/${hu}?l=${encodedLocal}`,
    advancedPolicyUrl: `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/policy`,
    directPolicyUrl: `https://${domain}/.well-known/openpgpkey/policy`,
  };
}

/**
 * Default deterministic key creation timestamp (2023-11-14T22:13:20Z) used when
 * synthesizing OpenPGP public keys so that fingerprints remain stable across requests.
 */
export const DEFAULT_OPENPGP_CREATION_TIME_SECONDS = OPENPGP_CANONICAL_CREATION_TIMESTAMP;

/**
 * ASN.1 OID for secp256k1 (`1.3.132.0.10`) prefixed with length byte `0x05`,
 * as required by RFC 6637 section 9.
 */
const SECP256K1_OID_WITH_LEN = Buffer.from([0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);

/**
 * ASN.1 OID for Ed25519 (`1.3.6.1.4.1.11591.15.1`) prefixed with length byte `0x09`,
 * per draft-koch-eddsa-for-openpgp / RFC 9580.
 */
const ED25519_OID_WITH_LEN = Buffer.from([
  0x09, 0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01,
]);

/**
 * ASN.1 OID for Curve25519 / X25519 (`1.3.6.1.4.1.3029.1.5.1`) prefixed with length byte `0x0a`,
 * per draft-koch-eddsa-for-openpgp / RFC 9580.
 */
const CURVE25519_OID_WITH_LEN = Buffer.from([
  0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x97, 0x55, 0x01, 0x05, 0x01,
]);

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * RFC 6637 KDF parameters for ECDH:
 *   length = 3, reserved = 1, hash algorithm = 8 (SHA-256), symmetric algorithm = 7 (AES-128).
 */
const ECDH_KDF_PARAMS = Buffer.from([0x03, 0x01, 0x08, 0x07]);

function encodeNewFormatPacket(tag: number, body: Uint8Array): Buffer {
  const headerByte = 0xc0 | (tag & 0x3f);
  const len = body.byteLength;
  let lengthBytes: Buffer;
  if (len < 192) {
    lengthBytes = Buffer.from([len]);
  } else if (len < 8384) {
    const adjusted = len - 192;
    lengthBytes = Buffer.from([((adjusted >> 8) & 0xff) + 192, adjusted & 0xff]);
  } else {
    lengthBytes = Buffer.allocUnsafe(5);
    lengthBytes[0] = 0xff;
    lengthBytes.writeUInt32BE(len, 1);
  }
  return Buffer.concat([Buffer.from([headerByte]), lengthBytes, Buffer.from(body)]);
}

function normalizeUncompressedSecp256k1PublicKey(pubKey: Uint8Array | string): Buffer {
  const hexInput =
    typeof pubKey === 'string'
      ? pubKey.trim().startsWith('0x')
        ? pubKey.trim()
        : `0x${pubKey.trim()}`
      : `0x${Buffer.from(pubKey).toString('hex')}`;
  const uncompressedHex = SigningKey.computePublicKey(hexInput, false);
  const bytes = Buffer.from(uncompressedHex.slice(2), 'hex');
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('Failed to derive 65-byte uncompressed secp256k1 public key');
  }
  return bytes;
}

function encodeOpenPgpMpiFromUncompressedPoint(uncompressedPoint: Buffer): Buffer {
  // 0x04 || X (32B) || Y (32B) = 65 bytes.
  // Leading byte 0x04 has highest set bit at bit position 3, so bit length = 64 * 8 + 3 = 515 (0x0203).
  return Buffer.concat([Buffer.from([0x02, 0x03]), uncompressedPoint]);
}

function buildEcdsaPublicKeyPacketBody(
  uncompressedPoint: Buffer,
  creationTimeSeconds: number,
): Buffer {
  const header = Buffer.allocUnsafe(6);
  header[0] = 0x04; // Version 4
  header.writeUInt32BE(creationTimeSeconds >>> 0, 1);
  header[5] = 19; // Algorithm 19: ECDSA (RFC 6637)
  const mpi = encodeOpenPgpMpiFromUncompressedPoint(uncompressedPoint);
  return Buffer.concat([header, SECP256K1_OID_WITH_LEN, mpi]);
}

function buildEcdhPublicSubkeyPacketBody(
  uncompressedPoint: Buffer,
  creationTimeSeconds: number,
): Buffer {
  const header = Buffer.allocUnsafe(6);
  header[0] = 0x04; // Version 4
  header.writeUInt32BE(creationTimeSeconds >>> 0, 1);
  header[5] = 18; // Algorithm 18: ECDH (RFC 6637)
  const mpi = encodeOpenPgpMpiFromUncompressedPoint(uncompressedPoint);
  return Buffer.concat([header, SECP256K1_OID_WITH_LEN, mpi, ECDH_KDF_PARAMS]);
}

/**
 * Synthesizes a deterministic RFC 4880 / RFC 6637 v4 OpenPGP Transferable Public Key
 * (`application/octet-stream`) from a user's `secp256k1` public key:
 * - Tag 6 (`0xC6`): Public-Key Packet (v4, ECDSA alg 19, secp256k1 OID, uncompressed point MPI)
 * - Tag 13 (`0xCD`): User ID Packet (UTF-8 `userId`)
 * - Tag 14 (`0xCE`): Public-Subkey Packet (v4, ECDH alg 18, secp256k1 OID, uncompressed point MPI, SHA-256/AES-128 KDF)
 */
export function buildSecp256k1OpenPgpPublicKey(params: {
  compressedOrUncompressedPubKey: Uint8Array | string;
  userId: string;
  creationTimeSeconds?: number;
}): Buffer {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error('OpenPGP User ID must not be empty');
  }
  const creationTimeSeconds =
    params.creationTimeSeconds ?? DEFAULT_OPENPGP_CREATION_TIME_SECONDS;
  const uncompressed = normalizeUncompressedSecp256k1PublicKey(
    params.compressedOrUncompressedPubKey,
  );

  const pubKeyBody = buildEcdsaPublicKeyPacketBody(uncompressed, creationTimeSeconds);
  const userIdBody = Buffer.from(userId, 'utf8');
  const subKeyBody = buildEcdhPublicSubkeyPacketBody(uncompressed, creationTimeSeconds);

  return Buffer.concat([
    encodeNewFormatPacket(6, pubKeyBody),
    encodeNewFormatPacket(13, userIdBody),
    encodeNewFormatPacket(14, subKeyBody),
  ]);
}

function encodeOpenPgpMpiFromNative25519Point(raw32ByteKey: Uint8Array): Buffer {
  if (raw32ByteKey.byteLength !== 32) {
    throw new Error(`Expected 32-byte Ed25519/X25519 public key, got ${raw32ByteKey.byteLength}`);
  }
  // 0x40 prefix + 32-byte little-endian/native point = 33 bytes (263 bits = 0x0107).
  return Buffer.concat([Buffer.from([0x01, 0x07, 0x40]), Buffer.from(raw32ByteKey)]);
}

function encodeOpenPgpMpiFromBigEndianScalar(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.byteLength - 1 && bytes[start] === 0) {
    start++;
  }
  const trimmed = Buffer.from(bytes.subarray(start));
  const firstByte = trimmed[0] ?? 0;
  let highestBit = 0;
  for (let bit = 7; bit >= 0; bit--) {
    if ((firstByte & (1 << bit)) !== 0) {
      highestBit = bit + 1;
      break;
    }
  }
  const bitLen = highestBit === 0 ? 0 : (trimmed.length - 1) * 8 + highestBit;
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(bitLen, 0);
  return Buffer.concat([header, trimmed]);
}

function deriveEd25519PublicKeyFromSeed(seed32: Uint8Array): {
  privateKey: crypto.KeyObject;
  publicKeyBytes: Buffer;
} {
  if (seed32.byteLength !== 32) {
    throw new Error('Ed25519 seed must be 32 bytes');
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed32)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  return {
    privateKey,
    publicKeyBytes: Buffer.from(spki.subarray(spki.length - 32)),
  };
}

function deriveX25519PublicKeyFromSeed(seed32: Uint8Array): {
  privateKey: crypto.KeyObject;
  publicKeyBytes: Buffer;
} {
  if (seed32.byteLength !== 32) {
    throw new Error('X25519 seed must be 32 bytes');
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(seed32)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  return {
    privateKey,
    publicKeyBytes: Buffer.from(spki.subarray(spki.length - 32)),
  };
}

function buildEd25519PublicKeyPacketBody(
  ed25519PubKey32: Uint8Array,
  creationTimeSeconds: number,
): Buffer {
  const header = Buffer.allocUnsafe(6);
  header[0] = 0x04; // Version 4
  header.writeUInt32BE(creationTimeSeconds >>> 0, 1);
  header[5] = 22; // Algorithm 22: EdDSA (draft-koch-eddsa-for-openpgp)
  const mpi = encodeOpenPgpMpiFromNative25519Point(ed25519PubKey32);
  return Buffer.concat([header, ED25519_OID_WITH_LEN, mpi]);
}

function buildX25519PublicSubkeyPacketBody(
  x25519PubKey32: Uint8Array,
  creationTimeSeconds: number,
): Buffer {
  const header = Buffer.allocUnsafe(6);
  header[0] = 0x04; // Version 4
  header.writeUInt32BE(creationTimeSeconds >>> 0, 1);
  header[5] = 18; // Algorithm 18: ECDH
  const mpi = encodeOpenPgpMpiFromNative25519Point(x25519PubKey32);
  return Buffer.concat([header, CURVE25519_OID_WITH_LEN, mpi, ECDH_KDF_PARAMS]);
}

function computeV4KeyPacketFingerprintBytes(packetBody: Uint8Array): Buffer {
  const prefix = Buffer.allocUnsafe(3);
  prefix[0] = 0x99;
  prefix.writeUInt16BE(packetBody.byteLength, 1);
  return crypto.createHash('sha1').update(prefix).update(packetBody).digest();
}

function buildDeterministicEd25519SignaturePacketBody(params: {
  sigType: number;
  creationTimeSeconds: number;
  keyFlagsMask: number;
  primaryKeyBody: Buffer;
  targetPayload: Buffer;
  ed25519PrivateKey: crypto.KeyObject;
}): Buffer {
  const primaryFp = computeV4KeyPacketFingerprintBytes(params.primaryKeyBody);
  const issuerKeyId = primaryFp.subarray(12, 20);

  // Subpacket 2: Signature Creation Time (4 bytes)
  const spCreation = Buffer.allocUnsafe(6);
  spCreation[0] = 5;
  spCreation[1] = 2;
  spCreation.writeUInt32BE(params.creationTimeSeconds >>> 0, 2);

  // Subpacket 27: Key Flags (1 byte)
  const spKeyFlags = Buffer.from([2, 27, params.keyFlagsMask & 0xff]);

  // Subpacket 33: Issuer Fingerprint (v4: 0x04 + 20-byte SHA-1)
  const spIssuerFp = Buffer.concat([Buffer.from([22, 33, 0x04]), primaryFp]);

  const hashedSubpackets = Buffer.concat([spCreation, spKeyFlags, spIssuerFp]);

  // Unhashed Subpacket 16: Issuer Key ID (8 bytes)
  const unhashedSubpackets = Buffer.concat([Buffer.from([9, 16]), issuerKeyId]);

  const sigHeader = Buffer.allocUnsafe(6);
  sigHeader[0] = 0x04; // Version 4 signature
  sigHeader[1] = params.sigType & 0xff;
  sigHeader[2] = 22; // Public-key algorithm 22 (EdDSA)
  sigHeader[3] = 8; // Hash algorithm 8 (SHA-256)
  sigHeader.writeUInt16BE(hashedSubpackets.length, 4);

  const signedHeaderAndHashed = Buffer.concat([sigHeader, hashedSubpackets]);
  const trailer = Buffer.allocUnsafe(6);
  trailer[0] = 0x04;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(signedHeaderAndHashed.length, 2);

  const primaryPrefix = Buffer.allocUnsafe(3);
  primaryPrefix[0] = 0x99;
  primaryPrefix.writeUInt16BE(params.primaryKeyBody.length, 1);

  const hashInput = Buffer.concat([
    primaryPrefix,
    params.primaryKeyBody,
    params.targetPayload,
    signedHeaderAndHashed,
    trailer,
  ]);
  const digest = crypto.createHash('sha256').update(hashInput).digest();
  const rawSig = crypto.sign(null, digest, params.ed25519PrivateKey);
  const rMpi = encodeOpenPgpMpiFromBigEndianScalar(rawSig.subarray(0, 32));
  const sMpi = encodeOpenPgpMpiFromBigEndianScalar(rawSig.subarray(32, 64));

  const unhashedLen = Buffer.allocUnsafe(2);
  unhashedLen.writeUInt16BE(unhashedSubpackets.length, 0);
  const left16 = digest.subarray(0, 2);

  return Buffer.concat([
    signedHeaderAndHashed,
    unhashedLen,
    unhashedSubpackets,
    left16,
    rMpi,
    sMpi,
  ]);
}

/**
 * Synthesizes a deterministic RFC 4880 / RFC 6637 / draft-koch-eddsa-for-openpgp v4
 * OpenPGP Transferable Public Key with an Ed25519 primary signing key (Tag 6, alg 22)
 * and X25519 encryption subkey (Tag 14, alg 18), plus deterministic self-certification
 * (0x13) and subkey-binding (0x18) signature packets when `ed25519SigningSeed` is provided.
 */
export function buildEd25519X25519OpenPgpPublicKey(params: {
  ed25519PublicKey: Uint8Array;
  x25519PublicKey: Uint8Array;
  userId: string;
  creationTimeSeconds?: number;
  ed25519SigningSeed?: Uint8Array;
}): Buffer {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error('OpenPGP User ID must not be empty');
  }
  const creationTimeSeconds =
    params.creationTimeSeconds ?? DEFAULT_OPENPGP_CREATION_TIME_SECONDS;
  const primaryKeyBody = buildEd25519PublicKeyPacketBody(
    params.ed25519PublicKey,
    creationTimeSeconds,
  );
  const userIdBody = Buffer.from(userId, 'utf8');
  const subKeyBody = buildX25519PublicSubkeyPacketBody(
    params.x25519PublicKey,
    creationTimeSeconds,
  );

  if (!params.ed25519SigningSeed) {
    return Buffer.concat([
      encodeNewFormatPacket(6, primaryKeyBody),
      encodeNewFormatPacket(13, userIdBody),
      encodeNewFormatPacket(14, subKeyBody),
    ]);
  }

  const { privateKey } = deriveEd25519PublicKeyFromSeed(params.ed25519SigningSeed);
  const uidPrefix = Buffer.allocUnsafe(5);
  uidPrefix[0] = 0xb4;
  uidPrefix.writeUInt32BE(userIdBody.length, 1);
  const uidSigBody = buildDeterministicEd25519SignaturePacketBody({
    sigType: 0x13, // Positive certification of a User ID and Public-Key packet
    creationTimeSeconds,
    keyFlagsMask: 0x03, // Certify (0x01) | Sign (0x02)
    primaryKeyBody,
    targetPayload: Buffer.concat([uidPrefix, userIdBody]),
    ed25519PrivateKey: privateKey,
  });

  const subkeyPrefix = Buffer.allocUnsafe(3);
  subkeyPrefix[0] = 0x99;
  subkeyPrefix.writeUInt16BE(subKeyBody.length, 1);
  const subkeySigBody = buildDeterministicEd25519SignaturePacketBody({
    sigType: 0x18, // Subkey Binding Signature
    creationTimeSeconds,
    keyFlagsMask: 0x0c, // Encrypt communications (0x04) | Encrypt storage (0x08)
    primaryKeyBody,
    targetPayload: Buffer.concat([subkeyPrefix, subKeyBody]),
    ed25519PrivateKey: privateKey,
  });

  return Buffer.concat([
    encodeNewFormatPacket(6, primaryKeyBody),
    encodeNewFormatPacket(13, userIdBody),
    encodeNewFormatPacket(2, uidSigBody),
    encodeNewFormatPacket(14, subKeyBody),
    encodeNewFormatPacket(2, subkeySigBody),
  ]);
}

export interface DeterministicOpenPgpKeypair {
  readonly primarySigningSeed: Uint8Array;
  readonly encryptionSubkeySeed: Uint8Array;
  readonly ed25519PublicKey: Buffer;
  readonly x25519PublicKey: Buffer;
  readonly creationTimestamp: number;
  readonly publicKeyPacket: Buffer;
  readonly armoredPublicKey: string;
  readonly fingerprint: string;
  readonly subkeyFingerprint: string;
}

/**
 * Derives a deterministic OpenPGP v4 Ed25519 + X25519 Transferable Public Key and keypair
 * directly from a 32-byte Frank `accountRootSeed` via `deriveOpenPgpSeeds`.
 * Two wallets restored from the same seed produce byte-for-byte identical OpenPGP keys.
 */
export function deriveDeterministicOpenPgpKeypair(
  accountRootSeed: Uint8Array,
  userId: string,
  creationTimeSeconds?: number,
): DeterministicOpenPgpKeypair {
  const seeds = deriveOpenPgpSeeds(accountRootSeed);
  const creationTimestamp = creationTimeSeconds ?? seeds.creationTimestamp;
  const ed25519 = deriveEd25519PublicKeyFromSeed(seeds.primarySigningSeed);
  const x25519 = deriveX25519PublicKeyFromSeed(seeds.encryptionSubkeySeed);
  const publicKeyPacket = buildEd25519X25519OpenPgpPublicKey({
    ed25519PublicKey: ed25519.publicKeyBytes,
    x25519PublicKey: x25519.publicKeyBytes,
    userId,
    creationTimeSeconds: creationTimestamp,
    ed25519SigningSeed: seeds.primarySigningSeed,
  });
  const subKeyBody = buildX25519PublicSubkeyPacketBody(
    x25519.publicKeyBytes,
    creationTimestamp,
  );
  const fingerprint = computeOpenPgpV4Fingerprint(publicKeyPacket);
  const subkeyFingerprint = computeV4KeyPacketFingerprintBytes(subKeyBody).toString('hex');

  return {
    primarySigningSeed: seeds.primarySigningSeed,
    encryptionSubkeySeed: seeds.encryptionSubkeySeed,
    ed25519PublicKey: ed25519.publicKeyBytes,
    x25519PublicKey: x25519.publicKeyBytes,
    creationTimestamp,
    publicKeyPacket,
    armoredPublicKey: armorOpenPgpPublicKey(publicKeyPacket),
    fingerprint,
    subkeyFingerprint,
  };
}

function extractPublicKeyPacketBody(publicKeyOrPacketBody: Uint8Array): Uint8Array {
  if (publicKeyOrPacketBody.byteLength === 0) {
    throw new Error('Empty OpenPGP public key input');
  }
  // Raw v4 packet body starts with version byte 0x04
  if (publicKeyOrPacketBody[0] === 0x04) {
    return publicKeyOrPacketBody;
  }
  const first = publicKeyOrPacketBody[0];
  if ((first & 0x80) === 0) {
    throw new Error('Invalid OpenPGP packet header byte');
  }
  // New-format packet header (bit 6 set)
  if ((first & 0x40) !== 0) {
    const tag = first & 0x3f;
    if (tag !== 6) {
      throw new Error(`Expected OpenPGP Public-Key packet (tag 6), got tag ${tag}`);
    }
    const lenByte0 = publicKeyOrPacketBody[1];
    let offset = 2;
    let bodyLen = 0;
    if (lenByte0 < 192) {
      bodyLen = lenByte0;
    } else if (lenByte0 < 224) {
      bodyLen = ((lenByte0 - 192) << 8) + publicKeyOrPacketBody[2] + 192;
      offset = 3;
    } else if (lenByte0 === 255) {
      bodyLen = Buffer.from(
        publicKeyOrPacketBody.buffer,
        publicKeyOrPacketBody.byteOffset + 2,
        4,
      ).readUInt32BE(0);
      offset = 6;
    } else {
      throw new Error('Unsupported partial body length in OpenPGP Public-Key packet');
    }
    return publicKeyOrPacketBody.subarray(offset, offset + bodyLen);
  }
  // Old-format packet header
  const tag = (first >> 2) & 0x0f;
  if (tag !== 6) {
    throw new Error(`Expected OpenPGP Public-Key packet (tag 6), got tag ${tag}`);
  }
  const lengthType = first & 0x03;
  if (lengthType === 0) {
    const bodyLen = publicKeyOrPacketBody[1];
    return publicKeyOrPacketBody.subarray(2, 2 + bodyLen);
  }
  if (lengthType === 1) {
    const bodyLen = (publicKeyOrPacketBody[1] << 8) | publicKeyOrPacketBody[2];
    return publicKeyOrPacketBody.subarray(3, 3 + bodyLen);
  }
  throw new Error('Unsupported old-format length type in OpenPGP Public-Key packet');
}

/**
 * Computes the 40-hex-character RFC 4880 section 12.2 v4 fingerprint of an OpenPGP
 * Public-Key packet body (or a full Transferable Public Key starting with a Tag 6 packet).
 */
export function computeOpenPgpV4Fingerprint(publicKeyOrPacketBody: Uint8Array): string {
  const body = extractPublicKeyPacketBody(publicKeyOrPacketBody);
  if (body.byteLength < 6 || body[0] !== 0x04) {
    throw new Error('OpenPGP Public-Key packet body is not version 4');
  }
  const prefix = Buffer.allocUnsafe(3);
  prefix[0] = 0x99;
  prefix.writeUInt16BE(body.byteLength, 1);
  return crypto.createHash('sha1').update(prefix).update(body).digest('hex');
}

/**
 * Computes the 24-bit OpenPGP CRC-24 checksum per RFC 4880 section 6.1.
 */
export function crc24OpenPgp(data: Uint8Array): number {
  let crc = 0xb704ce;
  for (let i = 0; i < data.byteLength; i++) {
    crc ^= data[i] << 16;
    for (let j = 0; j < 8; j++) {
      crc <<= 1;
      if ((crc & 0x1000000) !== 0) {
        crc ^= 0x1864cfb;
      }
    }
  }
  return crc & 0xffffff;
}

/**
 * Wraps binary OpenPGP public key bytes in RFC 4880 ASCII armor with a CRC-24 trailer.
 */
export function armorOpenPgpPublicKey(binaryKey: Uint8Array): string {
  if (binaryKey.byteLength === 0) {
    throw new Error('Cannot armor empty OpenPGP key');
  }
  const base64 = Buffer.from(binaryKey).toString('base64');
  const wrapped = base64.match(/.{1,64}/g)?.join('\n') ?? '';
  const crc = crc24OpenPgp(binaryKey);
  const crcBytes = Buffer.from([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]);
  const crcBase64 = crcBytes.toString('base64');
  return [
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    '',
    wrapped,
    `=${crcBase64}`,
    '-----END PGP PUBLIC KEY BLOCK-----',
  ].join('\n');
}

/**
 * Parses either an ASCII-armored OpenPGP public key block or raw binary OpenPGP packet bytes
 * into a validated binary `Buffer`. Verifies the CRC-24 checksum when present in ASCII armor.
 */
export function dearmorOpenPgpPublicKey(armoredOrBinary: Uint8Array | string): Buffer {
  if (typeof armoredOrBinary !== 'string') {
    const asText = Buffer.from(armoredOrBinary.subarray(0, Math.min(64, armoredOrBinary.byteLength))).toString('utf8');
    if (!asText.trimStart().startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
      if (armoredOrBinary.byteLength < 3 || (armoredOrBinary[0] & 0x80) === 0) {
        throw new Error('Invalid binary OpenPGP public key packet');
      }
      return Buffer.from(armoredOrBinary);
    }
    armoredOrBinary = Buffer.from(armoredOrBinary).toString('utf8');
  }

  const trimmed = armoredOrBinary.trim();
  const beginMarker = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
  const endMarker = '-----END PGP PUBLIC KEY BLOCK-----';
  const beginIdx = trimmed.indexOf(beginMarker);
  const endIdx = trimmed.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error('Missing OpenPGP ASCII armor headers');
  }

  const inner = trimmed.slice(beginIdx + beginMarker.length, endIdx).replace(/\r\n/g, '\n');
  const blankLineIdx = inner.indexOf('\n\n');
  const bodySection = blankLineIdx !== -1 ? inner.slice(blankLineIdx + 2) : inner.trim();
  const lines = bodySection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let expectedCrc: number | undefined;
  const base64Lines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('=')) {
      const crcBuf = Buffer.from(line.slice(1), 'base64');
      if (crcBuf.length !== 3) {
        throw new Error('Invalid OpenPGP CRC-24 armor trailer');
      }
      expectedCrc = (crcBuf[0] << 16) | (crcBuf[1] << 8) | crcBuf[2];
    } else if (!line.includes(':')) {
      base64Lines.push(line);
    }
  }

  const decoded = Buffer.from(base64Lines.join(''), 'base64');
  if (decoded.length < 3 || (decoded[0] & 0x80) === 0) {
    throw new Error('Decoded OpenPGP public key does not start with a valid packet tag');
  }
  if (expectedCrc !== undefined) {
    const actualCrc = crc24OpenPgp(decoded);
    if (actualCrc !== expectedCrc) {
      throw new Error('OpenPGP ASCII armor CRC-24 checksum mismatch');
    }
  }
  return decoded;
}

/**
 * Returns true if `text` is an OpenPGP ASCII-armored encrypted message
 * (`-----BEGIN PGP MESSAGE-----` ... `-----END PGP MESSAGE-----`).
 */
export function isOpenPgpArmoredMessage(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return (
    trimmed.startsWith('-----BEGIN PGP MESSAGE-----') &&
    trimmed.endsWith('-----END PGP MESSAGE-----')
  );
}

/**
 * Extracts an OpenPGP ASCII-armored message block (`-----BEGIN PGP MESSAGE-----` ...
 * `-----END PGP MESSAGE-----`) from a text body or raw RFC 5322 / PGP-MIME (`multipart/encrypted`
 * or `application/octet-stream`) email payload if present.
 */
export function extractOpenPgpArmoredMessage(
  textBody?: string,
  rawRfc822?: Uint8Array,
): string | undefined {
  const blockRegex = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
  if (typeof textBody === 'string' && textBody.length > 0) {
    if (isOpenPgpArmoredMessage(textBody)) {
      return textBody.trim();
    }
    const textMatch = textBody.match(blockRegex);
    if (textMatch) {
      return textMatch[0].replace(/\r\n/g, '\n');
    }
  }
  if (rawRfc822 && rawRfc822.byteLength > 0) {
    const rawText = Buffer.from(rawRfc822).toString('utf8');
    const directMatch = rawText.match(blockRegex);
    if (directMatch) {
      return directMatch[0].replace(/\r\n/g, '\n');
    }
    // Check base64-encoded MIME sections (e.g. application/octet-stream encrypted.asc)
    const sections = rawText.replace(/\r\n/g, '\n').split('\n\n');
    for (const section of sections) {
      const cleaned = section.replace(/[^A-Za-z0-9+/=]/g, '');
      if (cleaned.length >= 40 && cleaned.length % 4 === 0) {
        try {
          const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
          const b64Match = decoded.match(blockRegex);
          if (b64Match) {
            return b64Match[0].replace(/\r\n/g, '\n');
          }
        } catch {
          continue;
        }
      }
    }
  }
  return undefined;
}

/**
 * Wraps binary OpenPGP message packet bytes in RFC 4880 ASCII armor (`-----BEGIN PGP MESSAGE-----`).
 */
export function armorOpenPgpMessage(binaryMessage: Uint8Array): string {
  if (binaryMessage.byteLength === 0) {
    throw new Error('Cannot armor empty OpenPGP message');
  }
  const base64 = Buffer.from(binaryMessage).toString('base64');
  const wrapped = base64.match(/.{1,64}/g)?.join('\n') ?? '';
  const crc = crc24OpenPgp(binaryMessage);
  const crcBytes = Buffer.from([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]);
  const crcBase64 = crcBytes.toString('base64');
  return [
    '-----BEGIN PGP MESSAGE-----',
    '',
    wrapped,
    `=${crcBase64}`,
    '-----END PGP MESSAGE-----',
  ].join('\n');
}

/**
 * Parses an ASCII-armored OpenPGP message (`-----BEGIN PGP MESSAGE-----`) or binary packet
 * stream into a validated `Buffer`, verifying the CRC-24 trailer when present.
 */
export function dearmorOpenPgpMessage(armoredOrBinary: Uint8Array | string): Buffer {
  if (typeof armoredOrBinary !== 'string') {
    const asText = Buffer.from(
      armoredOrBinary.subarray(0, Math.min(64, armoredOrBinary.byteLength)),
    ).toString('utf8');
    if (!asText.trimStart().startsWith('-----BEGIN PGP MESSAGE-----')) {
      if (armoredOrBinary.byteLength < 3 || (armoredOrBinary[0] & 0x80) === 0) {
        throw new Error('Invalid binary OpenPGP message packet');
      }
      return Buffer.from(armoredOrBinary);
    }
    armoredOrBinary = Buffer.from(armoredOrBinary).toString('utf8');
  }

  const trimmed = armoredOrBinary.trim();
  const beginMarker = '-----BEGIN PGP MESSAGE-----';
  const endMarker = '-----END PGP MESSAGE-----';
  const beginIdx = trimmed.indexOf(beginMarker);
  const endIdx = trimmed.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error('Missing OpenPGP message ASCII armor headers');
  }

  const inner = trimmed.slice(beginIdx + beginMarker.length, endIdx).replace(/\r\n/g, '\n');
  const blankLineIdx = inner.indexOf('\n\n');
  const bodySection = blankLineIdx !== -1 ? inner.slice(blankLineIdx + 2) : inner.trim();
  const lines = bodySection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let expectedCrc: number | undefined;
  const base64Lines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('=')) {
      const crcBuf = Buffer.from(line.slice(1), 'base64');
      if (crcBuf.length !== 3) {
        throw new Error('Invalid OpenPGP CRC-24 armor trailer');
      }
      expectedCrc = (crcBuf[0] << 16) | (crcBuf[1] << 8) | crcBuf[2];
    } else if (!line.includes(':')) {
      base64Lines.push(line);
    }
  }

  const decoded = Buffer.from(base64Lines.join(''), 'base64');
  if (decoded.length < 3 || (decoded[0] & 0x80) === 0) {
    throw new Error('Decoded OpenPGP message does not start with a valid packet tag');
  }
  if (expectedCrc !== undefined) {
    const actualCrc = crc24OpenPgp(decoded);
    if (actualCrc !== expectedCrc) {
      throw new Error('OpenPGP message ASCII armor CRC-24 checksum mismatch');
    }
  }
  return decoded;
}

function parseNewFormatPackets(stream: Uint8Array): Array<{ tag: number; body: Buffer }> {
  const packets: Array<{ tag: number; body: Buffer }> = [];
  let offset = 0;
  while (offset < stream.byteLength) {
    const header = stream[offset];
    if ((header & 0xc0) !== 0xc0) {
      throw new Error('Expected new-format OpenPGP packet header');
    }
    const tag = header & 0x3f;
    const len0 = stream[offset + 1];
    let bodyLen = 0;
    let bodyOffset = offset + 2;
    if (len0 < 192) {
      bodyLen = len0;
    } else if (len0 < 224) {
      bodyLen = ((len0 - 192) << 8) + stream[offset + 2] + 192;
      bodyOffset = offset + 3;
    } else if (len0 === 255) {
      bodyLen = Buffer.from(
        stream.buffer,
        stream.byteOffset + offset + 2,
        4,
      ).readUInt32BE(0);
      bodyOffset = offset + 6;
    } else {
      throw new Error('Unsupported partial length in OpenPGP packet');
    }
    packets.push({
      tag,
      body: Buffer.from(stream.subarray(bodyOffset, bodyOffset + bodyLen)),
    });
    offset = bodyOffset + bodyLen;
  }
  return packets;
}

function extractX25519EncryptionSubkeyFromTransferableKey(
  publicKeyOrArmored: Uint8Array | string,
): { x25519PublicKey: Buffer; keyId: Buffer; subkeyFingerprint: Buffer } {
  const keyBytes = dearmorOpenPgpPublicKey(publicKeyOrArmored);
  const packets = parseNewFormatPackets(keyBytes);
  for (const pkt of packets) {
    if (pkt.tag === 14 && pkt.body.length >= 6 + CURVE25519_OID_WITH_LEN.length + 35) {
      const version = pkt.body[0];
      const alg = pkt.body[5];
      const oidSlice = pkt.body.subarray(6, 6 + CURVE25519_OID_WITH_LEN.length);
      if (version === 0x04 && alg === 18 && oidSlice.equals(CURVE25519_OID_WITH_LEN)) {
        const mpiOffset = 6 + CURVE25519_OID_WITH_LEN.length;
        if (pkt.body[mpiOffset + 2] !== 0x40) {
          throw new Error('Expected 0x40 Curve25519 point prefix in OpenPGP subkey MPI');
        }
        const x25519PublicKey = Buffer.from(pkt.body.subarray(mpiOffset + 3, mpiOffset + 35));
        const subkeyFingerprint = computeV4KeyPacketFingerprintBytes(pkt.body);
        const keyId = Buffer.from(subkeyFingerprint.subarray(12, 20));
        return { x25519PublicKey, keyId, subkeyFingerprint };
      }
    }
  }
  throw new Error('No Curve25519/X25519 ECDH encryption subkey (tag 14) found in OpenPGP public key');
}

function deriveOpenPgpSessionKey(params: {
  sharedSecret: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  recipientPublicKey: Uint8Array;
  keyId: Uint8Array;
}): Buffer {
  return crypto
    .createHash('sha256')
    .update('frank.openpgp.seipd.v1\0')
    .update(params.sharedSecret)
    .update(params.ephemeralPublicKey)
    .update(params.recipientPublicKey)
    .update(params.keyId)
    .digest();
}

/**
 * Encrypts `plaintext` to a recipient's OpenPGP Transferable Public Key (containing an X25519
 * ECDH subkey) into an RFC 4880 ASCII-armored OpenPGP message (`-----BEGIN PGP MESSAGE-----`).
 * If `plaintext` is already an OpenPGP ASCII-armored message, returns it unchanged without double-encryption.
 */
export function encryptOpenPgpMessage(
  plaintext: string,
  recipientPublicKey: Uint8Array | string,
): string {
  if (isOpenPgpArmoredMessage(plaintext)) {
    return plaintext;
  }
  const { x25519PublicKey, keyId } =
    extractX25519EncryptionSubkeyFromTransferableKey(recipientPublicKey);
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephSpki = ephemeral.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const ephemeralPublicKey = Buffer.from(ephSpki.subarray(ephSpki.length - 32));

  const recipientKeyObj = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, x25519PublicKey]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientKeyObj,
  });

  const sessionKey = deriveOpenPgpSessionKey({
    sharedSecret,
    ephemeralPublicKey,
    recipientPublicKey: x25519PublicKey,
    keyId,
  });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  cipher.setAAD(keyId);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Packet 1: Tag 1 (PKESK v3: 0x03 || 8-byte keyId || alg 18 || MPI(0x40 || ephemeralPubKey))
  const pkeskBody = Buffer.concat([
    Buffer.from([0x03]),
    keyId,
    Buffer.from([18]),
    encodeOpenPgpMpiFromNative25519Point(ephemeralPublicKey),
  ]);

  // Packet 2: Tag 18 (SEIPD v1: 0x01 || 12-byte IV || 16-byte GCM tag || ciphertext)
  const seipdBody = Buffer.concat([
    Buffer.from([0x01]),
    iv,
    authTag,
    ciphertext,
  ]);

  return armorOpenPgpMessage(
    Buffer.concat([
      encodeNewFormatPacket(1, pkeskBody),
      encodeNewFormatPacket(18, seipdBody),
    ]),
  );
}

/**
 * Decrypts an ASCII-armored or binary OpenPGP message encrypted via `encryptOpenPgpMessage`
 * using either the recipient's 32-byte `accountRootSeed`, `deriveOpenPgpSeeds` output, or
 * raw 32-byte `encryptionSubkeySeed`.
 */
export function decryptOpenPgpMessage(
  armoredOrBinaryMessage: string | Uint8Array,
  recipientKeyMaterial:
    | Uint8Array
    | { readonly encryptionSubkeySeed: Uint8Array }
    | { readonly accountRootSeed: Uint8Array },
): string {
  const packetStream = dearmorOpenPgpMessage(armoredOrBinaryMessage);
  const packets = parseNewFormatPackets(packetStream);
  const pkesk = packets.find((p) => p.tag === 1);
  const seipd = packets.find((p) => p.tag === 18);
  if (!pkesk || !seipd) {
    throw new Error('OpenPGP message is missing PKESK (tag 1) or SEIPD (tag 18) packet');
  }
  if (pkesk.body.length < 1 + 8 + 1 + 35 || pkesk.body[0] !== 0x03 || pkesk.body[9] !== 18) {
    throw new Error('Unsupported OpenPGP PKESK packet format');
  }
  const keyId = pkesk.body.subarray(1, 9);
  if (pkesk.body[12] !== 0x40) {
    throw new Error('Expected 0x40 Curve25519 point prefix in PKESK ephemeral MPI');
  }
  const ephemeralPublicKey = pkesk.body.subarray(13, 45);

  if (seipd.body.length < 1 + 12 + 16 || seipd.body[0] !== 0x01) {
    throw new Error('Unsupported OpenPGP SEIPD packet format');
  }
  const iv = seipd.body.subarray(1, 13);
  const authTag = seipd.body.subarray(13, 29);
  const ciphertext = seipd.body.subarray(29);

  const candidateSubkeySeeds: Uint8Array[] = [];
  if (recipientKeyMaterial instanceof Uint8Array) {
    try {
      candidateSubkeySeeds.push(deriveOpenPgpSeeds(recipientKeyMaterial).encryptionSubkeySeed);
    } catch {
      // Fall through if not a 32-byte account root
    }
    candidateSubkeySeeds.push(recipientKeyMaterial);
  } else if ('encryptionSubkeySeed' in recipientKeyMaterial) {
    candidateSubkeySeeds.push(recipientKeyMaterial.encryptionSubkeySeed);
  } else if ('accountRootSeed' in recipientKeyMaterial) {
    candidateSubkeySeeds.push(
      deriveOpenPgpSeeds(recipientKeyMaterial.accountRootSeed).encryptionSubkeySeed,
    );
  }

  const ephemeralKeyObj = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, ephemeralPublicKey]),
    format: 'der',
    type: 'spki',
  });

  for (const subkeySeed of candidateSubkeySeeds) {
    try {
      const { privateKey, publicKeyBytes } = deriveX25519PublicKeyFromSeed(subkeySeed);
      const sharedSecret = crypto.diffieHellman({
        privateKey,
        publicKey: ephemeralKeyObj,
      });
      const sessionKey = deriveOpenPgpSessionKey({
        sharedSecret,
        ephemeralPublicKey,
        recipientPublicKey: publicKeyBytes,
        keyId,
      });
      const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);
      decipher.setAAD(keyId);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch {
      continue;
    }
  }

  throw new Error('Failed to decrypt OpenPGP message with the provided key material');
}

export interface DiscoveredWkdKey {
  readonly emailAddress: string;
  readonly localPart: string;
  readonly domain: string;
  readonly hu: string;
  readonly method: 'advanced' | 'direct';
  readonly url: string;
  readonly keyBytes: Buffer;
  readonly armoredKey: string;
}

/**
 * Discovers an external recipient's OpenPGP public key via Web Key Directory (WKD)
 * per draft-koch-openpgp-webkey-service section 3.1:
 * 1. Queries the Advanced WKD URL (`https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<hu>?l=<localPart>`).
 * 2. Falls back to the Direct WKD URL (`https://<domain>/.well-known/openpgpkey/hu/<hu>?l=<localPart>`)
 *    if the Advanced lookup fails or returns a non-OK response.
 */
export async function discoverWkdPublicKey(
  emailAddress: string,
  options?: {
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  },
): Promise<DiscoveredWkdKey | undefined> {
  let urls: WkdUrls;
  try {
    urls = wkdUrlsForAddress(emailAddress);
  } catch {
    return undefined;
  }

  const fetcher = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 5000;

  const candidates: ReadonlyArray<{ method: 'advanced' | 'direct'; url: string }> = [
    { method: 'advanced', url: urls.advancedUrl },
    { method: 'direct', url: urls.directUrl },
  ];

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(candidate.url, {
        method: 'GET',
        headers: {
          Accept: 'application/octet-stream, application/pgp-keys;q=0.9, */*;q=0.1',
        },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const rawBytes = new Uint8Array(await response.arrayBuffer());
      if (rawBytes.byteLength === 0) continue;
      const keyBytes = dearmorOpenPgpPublicKey(rawBytes);
      return {
        emailAddress: `${urls.localPart}@${urls.domain}`,
        localPart: urls.localPart,
        domain: urls.domain,
        hu: urls.hu,
        method: candidate.method,
        url: candidate.url,
        keyBytes,
        armoredKey: armorOpenPgpPublicKey(keyBytes),
      };
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  return undefined;
}

export interface WkdHttpRequest {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly method: string;
}

export interface WkdHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array | string;
}

export type WkdHttpHandler = (req: WkdHttpRequest) => Promise<WkdHttpResponse | undefined>;

export interface WkdIssuedMailboxStore {
  issuedMailbox(localPart: string): { scopeAccount: string; conversationId?: string } | undefined;
  issuedMailboxByWkdHash(
    hu: string,
  ): { localPart: string; scopeAccount: string; conversationId?: string } | undefined;
}

export interface WkdHttpHandlerOptions {
  readonly gatewayDomain: string;
  readonly journal?: WkdIssuedMailboxStore;
  readonly issuedMailboxLookup?: (localPart: string) => Promise<InboundRecipientResolution | undefined>;
  readonly relayUrl?: string;
  readonly gatewayPublicKey?: Uint8Array | string;
  readonly resolveAccountPublicKey?: (
    accountAddress: string,
    localPart?: string,
  ) => Promise<Uint8Array | string | undefined>;
  readonly fetcher?: typeof fetch;
}

function extractPublicKeyFromRelayPayload(payload: unknown, accountAddress?: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.users)) {
    const normalizedTarget = accountAddress?.toLowerCase();
    const matched =
      record.users.find(
        (u): u is Record<string, unknown> =>
          Boolean(u && typeof u === 'object') &&
          typeof (u as Record<string, unknown>).address === 'string' &&
          ((u as Record<string, unknown>).address as string).toLowerCase() === normalizedTarget,
      ) ?? (record.users[0] as Record<string, unknown> | undefined);
    if (matched) {
      return extractPublicKeyFromRelayPayload(matched);
    }
  }
  if (
    typeof record.openPgpPublicKey === 'string' &&
    record.openPgpPublicKey.trim().startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')
  ) {
    return record.openPgpPublicKey.trim();
  }
  const candidates = [
    record.publicKey,
    record.pubKey,
    record.signingPublicKey,
    record.encryptionPublicKey,
    record.public_key,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^(?:0x)?(?:02|03|04)[0-9a-fA-F]{64,128}$/.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  return undefined;
}

async function fetchAccountPublicKeyFromRelay(
  relayUrl: string,
  accountAddress: string,
  localPart: string | undefined,
  fetcher: typeof fetch,
): Promise<string | undefined> {
  const base = relayUrl.replace(/\/+$/, '');
  const urls = [
    `${base}/directory/users?addresses=${encodeURIComponent(accountAddress)}`,
    ...(localPart
      ? [
          `${base}/usernames/${encodeURIComponent(localPart)}`,
          `${base}/directory/user/${encodeURIComponent(localPart)}`,
        ]
      : []),
  ];
  for (const url of urls) {
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { 'ngrok-skip-browser-warning': '1' },
      });
      if (!response.ok) continue;
      const body = await response.json().catch(() => undefined);
      const pubKey = extractPublicKeyFromRelayPayload(body, accountAddress);
      if (pubKey) return pubKey;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isAlreadyOpenPgpPublicKey(pubKey: Uint8Array | string): boolean {
  if (typeof pubKey === 'string') {
    return pubKey.trimStart().startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----');
  }
  return pubKey.byteLength > 3 && (pubKey[0] & 0xc0) === 0xc0 && (pubKey[0] & 0x3f) === 6;
}

/**
 * Creates a standards-compliant OpenPGP Web Key Directory (WKD) HTTP route handler
 * supporting both Direct (`/.well-known/openpgpkey/hu/<hu>`) and Advanced
 * (`/.well-known/openpgpkey/<domain>/hu/<hu>`) lookup and policy paths.
 */
export function createWkdHttpHandler(options: WkdHttpHandlerOptions): WkdHttpHandler {
  const domain = options.gatewayDomain.trim().toLowerCase();
  const fetcher = options.fetcher ?? fetch;
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };

  return async (req: WkdHttpRequest): Promise<WkdHttpResponse | undefined> => {
    const pathname = req.pathname;
    if (!pathname.startsWith('/.well-known/openpgpkey/')) {
      return undefined;
    }

    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders };
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405, headers: corsHeaders };
    }

    const suffix = pathname.slice('/.well-known/openpgpkey/'.length);
    const segments = suffix.split('/').filter((s) => s.length > 0);

    // Match policy endpoints:
    //   /.well-known/openpgpkey/policy
    //   /.well-known/openpgpkey/<domain>/policy
    if (
      (segments.length === 1 && segments[0] === 'policy') ||
      (segments.length === 2 && segments[0].toLowerCase() === domain && segments[1] === 'policy')
    ) {
      return {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: '',
      };
    }

    // Match key lookup endpoints:
    //   /.well-known/openpgpkey/hu/<hu>
    //   /.well-known/openpgpkey/<domain>/hu/<hu>
    let huSegment: string | undefined;
    if (segments.length === 2 && segments[0] === 'hu') {
      huSegment = segments[1].toLowerCase();
    } else if (
      segments.length === 3 &&
      segments[0].toLowerCase() === domain &&
      segments[1] === 'hu'
    ) {
      huSegment = segments[2].toLowerCase();
    } else {
      return { status: 404, headers: corsHeaders };
    }

    if (!isValidWkdHash(huSegment)) {
      return { status: 404, headers: corsHeaders };
    }

    const queryLocalPart = req.searchParams.get('l');
    let resolvedLocalPart: string | undefined;
    let resolvedAccount: string | undefined;

    if (queryLocalPart !== null && queryLocalPart.trim().length > 0) {
      const normalizedLocal = queryLocalPart.trim().toLowerCase();
      if (wkdHashLocalPart(normalizedLocal) !== huSegment) {
        return { status: 404, headers: corsHeaders };
      }
      resolvedLocalPart = normalizedLocal;
      if (options.issuedMailboxLookup) {
        const lookupResult = await options.issuedMailboxLookup(normalizedLocal);
        resolvedAccount = lookupResult?.accountAddress;
      }
      if (!resolvedAccount && options.journal) {
        try {
          resolvedAccount = options.journal.issuedMailbox(normalizedLocal)?.scopeAccount;
        } catch {
          // Non-standard local part (e.g. u.0x... or operational) handled by issuedMailboxLookup or hash scan
        }
      }
    }

    if (!resolvedAccount && options.journal) {
      const matched = options.journal.issuedMailboxByWkdHash(huSegment);
      if (matched) {
        resolvedLocalPart = resolvedLocalPart ?? matched.localPart;
        resolvedAccount = matched.scopeAccount;
      }
    }

    if (!resolvedAccount) {
      return { status: 404, headers: corsHeaders };
    }

    let pubKey: Uint8Array | string | undefined;
    if (options.resolveAccountPublicKey) {
      pubKey = await options.resolveAccountPublicKey(resolvedAccount, resolvedLocalPart);
    }
    if (!pubKey && options.relayUrl) {
      pubKey = await fetchAccountPublicKeyFromRelay(
        options.relayUrl,
        resolvedAccount,
        resolvedLocalPart,
        fetcher,
      );
    }
    if (!pubKey && options.gatewayPublicKey) {
      pubKey = options.gatewayPublicKey;
    }

    if (!pubKey) {
      return { status: 404, headers: corsHeaders };
    }

    try {
      const userId = `${resolvedLocalPart ?? resolvedAccount}@${domain}`;
      const keyBytes = isAlreadyOpenPgpPublicKey(pubKey)
        ? dearmorOpenPgpPublicKey(pubKey)
        : buildSecp256k1OpenPgpPublicKey({
            compressedOrUncompressedPubKey: pubKey,
            userId,
          });
      return {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=300',
        },
        body: method === 'HEAD' ? undefined : keyBytes,
      };
    } catch {
      return { status: 404, headers: corsHeaders };
    }
  };
}
