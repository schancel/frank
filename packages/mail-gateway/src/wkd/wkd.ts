import * as crypto from 'node:crypto';
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
 * synthesizing OpenPGP public keys from Cashweb secp256k1 identity keys so that
 * fingerprints remain stable across requests.
 */
export const DEFAULT_OPENPGP_CREATION_TIME_SECONDS = 1_700_000_000;

/**
 * ASN.1 OID for secp256k1 (`1.3.132.0.10`) prefixed with length byte `0x05`,
 * as required by RFC 6637 section 9.
 */
const SECP256K1_OID_WITH_LEN = Buffer.from([0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);

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
      const keyBytes = buildSecp256k1OpenPgpPublicKey({
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
