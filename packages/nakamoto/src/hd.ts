// BIP32 HD nodes. The HMAC key is the ASCII bytes of "Bitcoin seed".
// Coin type is a required argument (issue 241). The descriptor's documented
// coin type is not a default. An invalid child is an error; the index
// is not incremented. Hardened derivation of a public node fails.
// Serialization version bytes come from the chain the caller passes.

import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha512.js'

import { cryptoBackend } from './backend.js'
import { decodeBase58Check, encodeBase58Check } from './base58check.js'
import { copyBytes, encodeUnsignedBE } from './bytes.js'
import type { ChainDescriptor } from './chain/types.js'
import {
  compressedPublicKeyFromBytes,
  type CompressedPublicKey,
  type PrivateKey,
} from './constructors.js'
import { EncodingException, type EncodingResult } from './encoding-error.js'
import { bigintToBytes, bytesToBigint } from './integer.js'
import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
  type KeyFailure,
} from './keys.js'
import {
  SECP256K1_N,
  addScalarToPublicKey,
  compressedPointFromBytes,
  isValidScalar,
} from './secp256k1.js'

const BIP32_KEY = Uint8Array.from([
  0x42, 0x69, 0x74, 0x63, 0x6f, 0x69, 0x6e, 0x20, 0x73, 0x65, 0x65, 0x64,
])

const HARDENED = 0x80000000
const PURPOSE = 44
const SEED_MIN = 16
const SEED_MAX = 64
const HD_PAYLOAD = 78

export interface HdPrivateNode {
  readonly depth: number
  readonly parentFingerprint: Uint8Array
  readonly childIndex: number
  readonly chainCode: Uint8Array
  readonly privateKey: PrivateKey
}

export interface HdPublicNode {
  readonly depth: number
  readonly parentFingerprint: Uint8Array
  readonly childIndex: number
  readonly chainCode: Uint8Array
  readonly publicKey: CompressedPublicKey
}

export interface HdSeedLength {
  readonly code: 'hd-seed-length'
  readonly actual: number
}

export interface HdInvalidChild {
  readonly code: 'hd-invalid-child'
}

export interface HdHardenedPublic {
  readonly code: 'hd-hardened-public'
}

export interface HdPath {
  readonly code: 'hd-path'
}

export interface CoinTypeRequired {
  readonly code: 'coin-type-required'
}

export interface HdIndex {
  readonly code: 'hd-index'
}

export interface HdVersion {
  readonly code: 'hd-version'
  readonly expected: number
  readonly actual: number
}

export interface HdDepth {
  readonly code: 'hd-depth'
}

export interface HdPayloadLength {
  readonly code: 'hd-payload-length'
  readonly actual: number
}

export interface HdKeyPrefix {
  readonly code: 'hd-key-prefix'
  readonly actual: number
}

export type HdError =
  | HdSeedLength
  | HdInvalidChild
  | HdHardenedPublic
  | HdPath
  | CoinTypeRequired
  | HdIndex
  | HdVersion
  | HdDepth
  | HdPayloadLength
  | HdKeyPrefix

export type HdFailure = HdError | KeyFailure

export type HdResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HdFailure }

const HD_CODES: ReadonlySet<string> = new Set([
  'hd-seed-length',
  'hd-invalid-child',
  'hd-hardened-public',
  'hd-path',
  'coin-type-required',
  'hd-index',
  'hd-version',
  'hd-depth',
  'hd-payload-length',
  'hd-key-prefix',
])

export function isHdError(value: unknown): value is HdError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && HD_CODES.has(code)
}

function fail<T>(error: HdFailure): HdResult<T> {
  return { ok: false, error }
}

function wipe(bytes: Uint8Array): void {
  bytes.fill(0)
}

function ser32(value: number): Uint8Array {
  const encoded = encodeUnsignedBE(BigInt(value), 4)
  if (!encoded.ok) throw new EncodingException({ code: 'integer-out-of-range' })
  return encoded.value
}

function hash160(bytes: Uint8Array) {
  return new Uint8Array(cryptoBackend.hash160(bytes))
}

function fingerprintOf(publicKey: Uint8Array): Uint8Array {
  return new Uint8Array(hash160(publicKey).subarray(0, 4))
}

/**
 * BIP32 child scalar. `tweak` must be in [0, n) before reduction.
 * A zero sum is invalid. This does not try the next index.
 */
export function hdChildScalar(parent: bigint, tweak: bigint): HdResult<bigint> {
  if (tweak < 0n || tweak >= SECP256K1_N) {
    return fail({ code: 'hd-invalid-child' })
  }
  const sum = (parent + tweak) % SECP256K1_N
  if (sum === 0n) return fail({ code: 'hd-invalid-child' })
  return { ok: true, value: sum }
}

function checkIndex(index: number): HdResult<number> {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    return fail({ code: 'hd-index' })
  }
  return { ok: true, value: index }
}

function requireCoinType(coinType: number): HdResult<number> {
  if (
    coinType === undefined ||
    coinType === null ||
    !Number.isSafeInteger(coinType) ||
    coinType < 0 ||
    coinType > 0x7fffffff
  ) {
    return fail({ code: 'coin-type-required' })
  }
  return { ok: true, value: coinType }
}

function requireAccount(account: number): HdResult<number> {
  if (!Number.isSafeInteger(account) || account < 0 || account > 0x7fffffff) {
    return fail({ code: 'hd-index' })
  }
  return { ok: true, value: account }
}

function freezePrivate(hdNode: HdPrivateNode): HdPrivateNode {
  return Object.freeze(hdNode)
}

function freezePublic(hdNode: HdPublicNode): HdPublicNode {
  return Object.freeze(hdNode)
}

/** Master node from a 16-to-64-byte seed. No chain and no coin type. */
export function hdPrivateFromSeed(seed: Uint8Array): HdResult<HdPrivateNode> {
  const copied = copyBytes(seed)
  if (copied.length < SEED_MIN || copied.length > SEED_MAX) {
    wipe(copied)
    return fail({ code: 'hd-seed-length', actual: seed.length })
  }
  const mac = hmac(sha512, BIP32_KEY, copied)
  wipe(copied)
  const left = new Uint8Array(mac.subarray(0, 32))
  const chainCode = new Uint8Array(mac.subarray(32))
  wipe(mac)
  const scalar = bytesToBigint(left)
  if (!isValidScalar(scalar)) {
    wipe(left)
    wipe(chainCode)
    return fail({ code: 'scalar-out-of-range' })
  }
  const key = privateKeyFromSecretBytes(left, true)
  wipe(left)
  if (!key.ok) {
    wipe(chainCode)
    return key
  }
  return {
    ok: true,
    value: freezePrivate({
      depth: 0,
      parentFingerprint: new Uint8Array(4),
      childIndex: 0,
      chainCode,
      privateKey: key.value,
    }),
  }
}

function parentFingerprint(hdNode: HdPrivateNode): HdResult<Uint8Array> {
  const pub = publicFromPrivate(hdNode.privateKey)
  if (!pub.ok) return pub
  return { ok: true, value: fingerprintOf(pub.value.compressed) }
}

export function deriveHdPrivate(
  hdNode: HdPrivateNode,
  index: number,
): HdResult<HdPrivateNode> {
  const checked = checkIndex(index)
  if (!checked.ok) return checked
  if (hdNode.depth >= 255) return fail({ code: 'hd-depth' })
  const childIndex = checked.value
  const indexBytes = ser32(childIndex)
  const data = new Uint8Array(37)
  if (childIndex >= HARDENED) {
    data[0] = 0
    data.set(hdNode.privateKey.bytes, 1)
    data.set(indexBytes, 33)
  } else {
    const pub = publicFromPrivate(hdNode.privateKey)
    if (!pub.ok) return pub
    data.set(pub.value.compressed, 0)
    data.set(indexBytes, 33)
  }
  const mac = hmac(sha512, hdNode.chainCode, data)
  wipe(data)
  const left = new Uint8Array(mac.subarray(0, 32))
  const chainCode = new Uint8Array(mac.subarray(32))
  wipe(mac)
  const scalar = hdChildScalar(
    bytesToBigint(hdNode.privateKey.bytes),
    bytesToBigint(left),
  )
  wipe(left)
  if (!scalar.ok) {
    wipe(chainCode)
    return scalar
  }
  const secret = bigintToBytes(scalar.value, 32)
  if (!secret.ok) {
    wipe(chainCode)
    return fail({ code: 'scalar-out-of-range' })
  }
  const key = privateKeyFromSecretBytes(secret.value, true)
  wipe(secret.value)
  if (!key.ok) {
    wipe(chainCode)
    return key
  }
  const fingerprint = parentFingerprint(hdNode)
  if (!fingerprint.ok) {
    wipe(key.value.bytes)
    wipe(chainCode)
    return fingerprint
  }
  return {
    ok: true,
    value: freezePrivate({
      depth: hdNode.depth + 1,
      parentFingerprint: fingerprint.value,
      childIndex,
      chainCode,
      privateKey: key.value,
    }),
  }
}

export function hdPublicFromPrivate(
  hdNode: HdPrivateNode,
): HdResult<HdPublicNode> {
  const pub = publicFromPrivate(hdNode.privateKey)
  if (!pub.ok) return pub
  return {
    ok: true,
    value: freezePublic({
      depth: hdNode.depth,
      parentFingerprint: copyBytes(hdNode.parentFingerprint),
      childIndex: hdNode.childIndex,
      chainCode: copyBytes(hdNode.chainCode),
      publicKey: pub.value.compressed,
    }),
  }
}

export function deriveHdPublic(
  hdNode: HdPublicNode,
  index: number,
): HdResult<HdPublicNode> {
  const checked = checkIndex(index)
  if (!checked.ok) return checked
  if (checked.value >= HARDENED) return fail({ code: 'hd-hardened-public' })
  if (hdNode.depth >= 255) return fail({ code: 'hd-depth' })
  const data = new Uint8Array(37)
  data.set(hdNode.publicKey, 0)
  data.set(ser32(checked.value), 33)
  const mac = hmac(sha512, hdNode.chainCode, data)
  wipe(data)
  const left = new Uint8Array(mac.subarray(0, 32))
  const chainCode = new Uint8Array(mac.subarray(32))
  wipe(mac)
  const tweak = bytesToBigint(left)
  wipe(left)
  // BIP32 permits a zero IL: retain the valid parent point, but use the new
  // chain code and child metadata below. Generic curve tweaks remain nonzero.
  const child =
    tweak === 0n && compressedPointFromBytes(hdNode.publicKey) !== null
      ? copyBytes(hdNode.publicKey)
      : addScalarToPublicKey(hdNode.publicKey, tweak)
  if (child === null) {
    wipe(chainCode)
    return fail({ code: 'hd-invalid-child' })
  }
  const branded = compressedPublicKeyFromBytes(child)
  if (!branded.ok) {
    wipe(chainCode)
    return branded
  }
  return {
    ok: true,
    value: freezePublic({
      depth: hdNode.depth + 1,
      parentFingerprint: fingerprintOf(hdNode.publicKey),
      childIndex: checked.value,
      chainCode,
      publicKey: branded.value,
    }),
  }
}

function parsePath(path: string): HdResult<readonly number[]> {
  if (typeof path !== 'string' || path.length === 0)
    return fail({ code: 'hd-path' })
  const steps = path.split('/')
  const root = steps[0]
  if (root !== 'm' && root !== 'M') return fail({ code: 'hd-path' })
  const indexes: number[] = []
  for (const step of steps.slice(1)) {
    const hardened = step.endsWith("'")
    const text = hardened ? step.slice(0, -1) : step
    if (!/^(0|[1-9][0-9]*)$/.test(text)) return fail({ code: 'hd-path' })
    const value = Number(text)
    if (!Number.isSafeInteger(value) || value > 0x7fffffff) {
      return fail({ code: 'hd-path' })
    }
    indexes.push(hardened ? value + HARDENED : value)
  }
  return { ok: true, value: indexes }
}

export function deriveHdPath(
  hdNode: HdPrivateNode,
  path: string,
): HdResult<HdPrivateNode> {
  const indexes = parsePath(path)
  if (!indexes.ok) return indexes
  let current = hdNode
  for (const index of indexes.value) {
    const next = deriveHdPrivate(current, index)
    if (!next.ok) return next
    current = next.value
  }
  return { ok: true, value: current }
}

export function deriveHdPublicPath(
  hdNode: HdPublicNode,
  path: string,
): HdResult<HdPublicNode> {
  const indexes = parsePath(path)
  if (!indexes.ok) return indexes
  let current = hdNode
  for (const index of indexes.value) {
    const next = deriveHdPublic(current, index)
    if (!next.ok) return next
    current = next.value
  }
  return { ok: true, value: current }
}

/**
 * m/44'/coinType'/account'. `coinType` is required. The chain descriptor's
 * registered coin type is not read.
 */
export function deriveBip44Account(
  hdNode: HdPrivateNode,
  coinType: number,
  account: number,
): HdResult<HdPrivateNode> {
  const coin = requireCoinType(coinType)
  if (!coin.ok) return coin
  const acc = requireAccount(account)
  if (!acc.ok) return acc
  const purpose = deriveHdPrivate(hdNode, PURPOSE + HARDENED)
  if (!purpose.ok) return purpose
  const coinNode = deriveHdPrivate(purpose.value, coin.value + HARDENED)
  if (!coinNode.ok) return coinNode
  return deriveHdPrivate(coinNode.value, acc.value + HARDENED)
}

function versionBytes(version: number): EncodingResult<Uint8Array> {
  if (!Number.isSafeInteger(version) || version < 0 || version > 0xffffffff) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  return encodeUnsignedBE(BigInt(version), 4)
}

function chainVersion(
  chain: ChainDescriptor,
  field: 'hdPrivateVersion' | 'hdPublicVersion',
): HdResult<number> {
  if (typeof chain !== 'object' || chain === null) {
    return fail({ code: 'chain-required' })
  }
  const version = chain[field]
  if (!Number.isSafeInteger(version) || version < 0 || version > 0xffffffff) {
    return fail({ code: 'chain-required' })
  }
  return { ok: true, value: version }
}

function serialize(
  version: number,
  hdNode: {
    readonly depth: number
    readonly parentFingerprint: Uint8Array
    readonly childIndex: number
    readonly chainCode: Uint8Array
  },
  key33: Uint8Array,
): HdResult<string> {
  const versioned = versionBytes(version)
  if (
    !versioned.ok ||
    hdNode.parentFingerprint.length !== 4 ||
    hdNode.chainCode.length !== 32 ||
    key33.length !== 33
  ) {
    wipe(key33)
    return fail({
      code: 'hd-payload-length',
      actual: key33.length,
    })
  }
  const body = new Uint8Array(HD_PAYLOAD)
  body.set(versioned.value, 0)
  body[4] = hdNode.depth
  body.set(hdNode.parentFingerprint, 5)
  body.set(ser32(hdNode.childIndex), 9)
  body.set(hdNode.chainCode, 13)
  body.set(key33, 45)
  const text = encodeBase58Check(body)
  wipe(body)
  wipe(key33)
  return { ok: true, value: text }
}

export function serializeHdPrivate(
  hdNode: HdPrivateNode,
  chain: ChainDescriptor,
): HdResult<string> {
  const version = chainVersion(chain, 'hdPrivateVersion')
  if (!version.ok) return version
  const key33 = new Uint8Array(33)
  key33.set(hdNode.privateKey.bytes, 1)
  return serialize(version.value, hdNode, key33)
}

export function serializeHdPublic(
  hdNode: HdPublicNode,
  chain: ChainDescriptor,
): HdResult<string> {
  const version = chainVersion(chain, 'hdPublicVersion')
  if (!version.ok) return version
  const key33 = copyBytes(hdNode.publicKey)
  return serialize(version.value, hdNode, key33)
}

function readVersion(payload: Uint8Array): number {
  return Number(bytesToBigint(payload.subarray(0, 4)))
}

export function parseHdPrivate(
  text: string,
  chain: ChainDescriptor,
): HdResult<HdPrivateNode> {
  const version = chainVersion(chain, 'hdPrivateVersion')
  if (!version.ok) return version
  const decoded = decodeBase58Check(text)
  if (!decoded.ok) return decoded
  const payload = decoded.value
  if (payload.length !== HD_PAYLOAD) {
    const actual = payload.length
    wipe(payload)
    return fail({ code: 'hd-payload-length', actual })
  }
  const actual = readVersion(payload)
  if (actual !== version.value) {
    wipe(payload)
    return fail({ code: 'hd-version', expected: version.value, actual })
  }
  const prefix = payload[45] ?? 0
  if (prefix !== 0x00) {
    wipe(payload)
    return fail({ code: 'hd-key-prefix', actual: prefix })
  }
  const secret = new Uint8Array(payload.subarray(46, 78))
  const chainCode = new Uint8Array(payload.subarray(13, 45))
  const parentFingerprint = new Uint8Array(payload.subarray(5, 9))
  const depth = payload[4] ?? 0
  const childIndex = Number(bytesToBigint(payload.subarray(9, 13)))
  wipe(payload)
  const key = privateKeyFromSecretBytes(secret, true)
  wipe(secret)
  if (!key.ok) {
    wipe(chainCode)
    return key
  }
  return {
    ok: true,
    value: freezePrivate({
      depth,
      parentFingerprint,
      childIndex,
      chainCode,
      privateKey: key.value,
    }),
  }
}

export function parseHdPublic(
  text: string,
  chain: ChainDescriptor,
): HdResult<HdPublicNode> {
  const version = chainVersion(chain, 'hdPublicVersion')
  if (!version.ok) return version
  const decoded = decodeBase58Check(text)
  if (!decoded.ok) return decoded
  const payload = decoded.value
  if (payload.length !== HD_PAYLOAD) {
    const actual = payload.length
    wipe(payload)
    return fail({ code: 'hd-payload-length', actual })
  }
  const actual = readVersion(payload)
  if (actual !== version.value) {
    wipe(payload)
    return fail({ code: 'hd-version', expected: version.value, actual })
  }
  const key33 = new Uint8Array(payload.subarray(45, 78))
  const chainCode = new Uint8Array(payload.subarray(13, 45))
  const parentFingerprint = new Uint8Array(payload.subarray(5, 9))
  const depth = payload[4] ?? 0
  const childIndex = Number(bytesToBigint(payload.subarray(9, 13)))
  wipe(payload)
  if (compressedPointFromBytes(key33) === null) {
    wipe(chainCode)
    wipe(key33)
    return fail({ code: 'public-key-invalid' })
  }
  const branded = compressedPublicKeyFromBytes(key33)
  if (!branded.ok) {
    wipe(chainCode)
    wipe(key33)
    return branded
  }
  return {
    ok: true,
    value: freezePublic({
      depth,
      parentFingerprint,
      childIndex,
      chainCode,
      publicKey: branded.value,
    }),
  }
}
