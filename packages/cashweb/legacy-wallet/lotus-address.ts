import {
  convertBits,
  cryptoBackend,
  decodeAddress,
  decodeBase32,
  decodeBase58,
  decodeBase58Check,
  encodeAddress,
  lockingScript,
  pubkeyHashFromBytes,
  pubkeyHashFromOutputScript,
  type ScriptHash,
} from '@frank/nakamoto'

import { chainForNetworkName, lotusP2pkhFromHash } from './lotus-identity'

/** Fields a bitcore Address still passes in. This module does not import bitcore. */
type AddressRecord = {
  hashBuffer: Uint8Array
  type: string
}

type ParsedHash = {
  hash: Uint8Array
  kind: 'p2pkh' | 'p2sh'
}

const OP_PUSHDATA1 = 0x4c
const OP_PUSHDATA2 = 0x4d
const OP_PUSHDATA4 = 0x4e
const OP_DUP = 0x76
const OP_EQUAL = 0x87
const OP_EQUALVERIFY = 0x88
const OP_HASH160 = 0xa9
const OP_CHECKSIG = 0xac

const CASH_PREFIXES = ['bitcoincash', 'bchtest', 'bchreg'] as const
const CASH_HASH_BITS = [160, 192, 224, 256, 320, 384, 448, 512] as const

type ScriptChunk = {
  opcodenum: number
  buf?: Uint8Array
  len?: number
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    out[index] = text.charCodeAt(index)
  }
  return out
}

function sha256Prefix(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(cryptoBackend.sha256(bytes)).subarray(0, 4)
}

function p2pkhScriptFromHash(hash: Uint8Array): Uint8Array {
  const branded = pubkeyHashFromBytes(Uint8Array.from(hash))
  if (!branded.ok) throw new Error('address-hash')
  return lockingScript({ kind: 'p2pkh', hash: branded.value })
}

function readScriptChunks(script: Uint8Array): ScriptChunk[] | undefined {
  const chunks: ScriptChunk[] = []
  let pos = 0
  const readByte = (): number | undefined => {
    if (pos >= script.length) return undefined
    const value = script[pos] ?? 0
    pos += 1
    return value
  }
  while (pos < script.length) {
    const opcodenum = readByte()
    if (opcodenum === undefined) return undefined
    if (opcodenum > 0 && opcodenum < OP_PUSHDATA1) {
      const buf = Uint8Array.from(script.subarray(pos, pos + opcodenum))
      pos += opcodenum
      chunks.push({ opcodenum, buf, len: opcodenum })
      continue
    }
    if (opcodenum === OP_PUSHDATA1) {
      const len = readByte()
      if (len === undefined) return undefined
      const buf = Uint8Array.from(script.subarray(pos, pos + len))
      pos += len
      chunks.push({ opcodenum, buf, len })
      continue
    }
    if (opcodenum === OP_PUSHDATA2) {
      if (pos + 2 > script.length) return undefined
      const len = (script[pos] ?? 0) | ((script[pos + 1] ?? 0) << 8)
      pos += 2
      const buf = Uint8Array.from(script.subarray(pos, pos + len))
      pos += len
      chunks.push({ opcodenum, buf, len })
      continue
    }
    if (opcodenum === OP_PUSHDATA4) {
      if (pos + 4 > script.length) return undefined
      const len =
        ((script[pos] ?? 0) |
          ((script[pos + 1] ?? 0) << 8) |
          ((script[pos + 2] ?? 0) << 16) |
          ((script[pos + 3] ?? 0) << 24)) >>>
        0
      pos += 4
      const buf = Uint8Array.from(script.subarray(pos, pos + len))
      pos += len
      chunks.push({ opcodenum, buf, len })
      continue
    }
    chunks.push({ opcodenum })
  }
  return chunks
}

function chunksToBuffer(chunks: readonly ScriptChunk[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const chunk of chunks) {
    if (chunk.buf === undefined) {
      parts.push(Uint8Array.of(chunk.opcodenum))
      continue
    }
    if (chunk.opcodenum < OP_PUSHDATA1) {
      const out = new Uint8Array(1 + chunk.buf.length)
      out[0] = chunk.opcodenum
      out.set(chunk.buf, 1)
      parts.push(out)
      continue
    }
    if (chunk.opcodenum === OP_PUSHDATA1) {
      const out = new Uint8Array(2 + chunk.buf.length)
      out[0] = chunk.opcodenum
      out[1] = chunk.len ?? 0
      out.set(chunk.buf, 2)
      parts.push(out)
      continue
    }
    if (chunk.opcodenum === OP_PUSHDATA2) {
      const len = chunk.len ?? 0
      const out = new Uint8Array(3 + chunk.buf.length)
      out[0] = chunk.opcodenum
      out[1] = len & 0xff
      out[2] = (len >> 8) & 0xff
      out.set(chunk.buf, 3)
      parts.push(out)
      continue
    }
    const len = chunk.len ?? 0
    const out = new Uint8Array(5 + chunk.buf.length)
    out[0] = chunk.opcodenum
    out[1] = len & 0xff
    out[2] = (len >> 8) & 0xff
    out[3] = (len >> 16) & 0xff
    out[4] = (len >> 24) & 0xff
    out.set(chunk.buf, 5)
    parts.push(out)
  }
  return concat(parts)
}

/** Type comes from the locking script. The XAddress type byte is not consulted. */
function hashFromScript(
  script: Uint8Array,
): ParsedHash | 'bad-script' | 'mismatched' {
  const chunks = readScriptChunks(script)
  if (chunks === undefined) return 'bad-script'
  const push = chunks[2]?.buf
  if (
    chunks.length === 5 &&
    chunks[0]?.opcodenum === OP_DUP &&
    chunks[1]?.opcodenum === OP_HASH160 &&
    push !== undefined &&
    push.length === 20 &&
    chunks[3]?.opcodenum === OP_EQUALVERIFY &&
    chunks[4]?.opcodenum === OP_CHECKSIG
  ) {
    return { hash: push, kind: 'p2pkh' }
  }
  const raw = chunksToBuffer(chunks)
  if (
    raw.length === 23 &&
    raw[0] === OP_HASH160 &&
    raw[1] === 0x14 &&
    raw[22] === OP_EQUAL
  ) {
    return { hash: Uint8Array.from(raw.subarray(2, 22)), kind: 'p2sh' }
  }
  return 'mismatched'
}

function xChecksum(
  prefix: string,
  networkChar: string,
  typeByte: number,
  payload: Uint8Array,
): Uint8Array {
  return sha256Prefix(
    concat([
      asciiBytes(prefix),
      Uint8Array.of(networkChar.charCodeAt(0)),
      Uint8Array.of(typeByte),
      payload,
    ]),
  )
}

/** Legacy checksum. Network and type are stored as 0, matching the decoder. */
function legacyChecksum(prefix: string, payload: Uint8Array): Uint8Array {
  const prefixBytes = asciiBytes(prefix)
  return sha256Prefix(
    concat([
      Uint8Array.of(prefixBytes.length),
      prefixBytes,
      Uint8Array.of(0, 0),
      Uint8Array.of(payload.length),
      payload,
    ]),
  )
}

function decodeXAddressString(
  address: string,
): ParsedHash | 'fail' | 'mismatched' {
  const match = /[A-Z]|_/.exec(address)
  const split = match ? match.index : 0
  const prefix = address.slice(0, split)
  const networkChar = address.slice(split, split + 1)
  if (networkChar !== '_' && networkChar !== 'T' && networkChar !== 'R') {
    return 'fail'
  }
  const decoded = decodeBase58(address.slice(split + 1))
  if (!decoded.ok || decoded.value.length < 5) return 'fail'
  const bytes = decoded.value
  const typeByte = bytes[0] ?? 0
  const payload = bytes.subarray(1, bytes.length - 4)
  const checksum = bytes.subarray(bytes.length - 4)
  const modern = xChecksum(prefix, networkChar, typeByte, payload)
  const legacy = legacyChecksum(prefix, payload)
  if (!sameHash(modern, checksum) && !sameHash(legacy, checksum)) return 'fail'
  const script = Uint8Array.from(payload)
  const classified = hashFromScript(script)
  if (classified === 'bad-script') return 'fail'
  return classified
}

function polymod(values: readonly number[]): bigint {
  const generator = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ] as const
  let checksum = 1n
  for (const value of values) {
    const top = checksum >> 35n
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(value)
    for (let index = 0; index < generator.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) === 1n) {
        checksum ^= generator[index] ?? 0n
      }
    }
  }
  return checksum ^ 1n
}

function cashPayload(prefix: string, dataText: string): Uint8Array | undefined {
  if (dataText.length < 8) return undefined
  const decoded = decodeBase32(dataText)
  if (!decoded.ok) return undefined
  const expanded: number[] = []
  for (let index = 0; index < prefix.length; index += 1) {
    expanded.push(prefix.charCodeAt(index) & 31)
  }
  expanded.push(0)
  if (polymod([...expanded, ...decoded.value]) !== 0n) return undefined
  const converted = convertBits(decoded.value.slice(0, -8), 5, 8, true)
  if (!converted.ok) return undefined
  return Uint8Array.from(converted.value)
}

function hashFromCashPayload(payload: Uint8Array): ParsedHash {
  if (payload.length < 1) throw new Error('Invalid hash size')
  const version = payload[0] ?? 0
  const hash = Uint8Array.from(payload.subarray(1))
  if (CASH_HASH_BITS[version & 7] !== hash.length * 8) {
    throw new Error(`Invalid hash size:${version}`)
  }
  const typeBits = version & 120
  if (typeBits === 0) return { hash, kind: 'p2pkh' }
  if (typeBits === 8) return { hash, kind: 'p2sh' }
  throw new Error(`Invalid address type in version byte:${version}`)
}

function parseCashAddress(address: string): ParsedHash {
  const lower = address.toLowerCase()
  if (address !== lower && address !== address.toUpperCase()) {
    throw new Error('Mixed case')
  }
  const pieces = lower.split(':')
  if (pieces.length > 2) throw new Error(`Invalid format:${address}`)
  if (pieces.length === 2) {
    const prefix = pieces[0] ?? ''
    const payload = cashPayload(prefix, pieces[1] ?? '')
    if (payload === undefined) throw new Error(`Invalid checksum:${address}`)
    if (!CASH_PREFIXES.includes(prefix as (typeof CASH_PREFIXES)[number])) {
      throw new TypeError('Address has mismatched network type.')
    }
    return hashFromCashPayload(payload)
  }
  const dataText = pieces[0] ?? ''
  for (const prefix of CASH_PREFIXES) {
    const payload = cashPayload(prefix, dataText)
    if (payload !== undefined) return hashFromCashPayload(payload)
  }
  throw new Error(`Invalid checksum:${address}`)
}

function parseLongAddress(address: string): ParsedHash {
  const decoded = decodeXAddressString(address)
  if (decoded === 'mismatched') {
    throw new TypeError('Address has mismatched type.')
  }
  if (decoded !== 'fail') return decoded
  return parseCashAddress(address)
}

function parseLegacyBase58(address: string): ParsedHash {
  const decoded = decodeBase58Check(address)
  if (!decoded.ok || decoded.value.length !== 21) {
    throw new Error('Invalid Address string provided')
  }
  const version = decoded.value[0] ?? 0
  const hash = Uint8Array.from(decoded.value.subarray(1))
  if (version === 0x00 || version === 0x6f) return { hash, kind: 'p2pkh' }
  if (version === 0x05 || version === 0xc4) return { hash, kind: 'p2sh' }
  throw new TypeError('Address has mismatched network type.')
}

/** Cashaddr, legacy base58, and XAddress strings `Address` accepts after trim. */
function parseBitcoreString(data: string): ParsedHash {
  if (data.length < 34) throw new Error('Invalid Address string provided')
  if (data.length > 100) throw new TypeError('address string is too long')
  const trimmed = data.trim()
  if (trimmed.length > 35) return parseLongAddress(trimmed)
  return parseLegacyBase58(trimmed)
}

function lotusFromParsed(parsed: ParsedHash, networkName: string): string {
  if (parsed.kind === 'p2sh') {
    const encoded = encodeAddress(
      { kind: 'p2sh', hash: parsed.hash as ScriptHash },
      chainForNetworkName(networkName),
      'lotus',
    )
    if (!encoded.ok) throw new Error(encoded.error.code)
    return encoded.value
  }
  return lotusP2pkhFromHash(parsed.hash, networkName)
}

/**
 * 25-byte P2PKH script for a Lotus string, or for an older cashaddr / XAddress
 * string. Spend paths use this instead of `Script.buildPublicKeyHashOut`.
 * A script-hash address is `address-kind`.
 */
export function p2pkhLockingScript(
  address: string | AddressRecord,
): Uint8Array {
  if (typeof address === 'string') {
    const decoded = decodeAddress(address)
    if (decoded.ok) {
      if (decoded.value.destination.kind !== 'p2pkh') {
        throw new Error('address-kind')
      }
      return p2pkhScriptFromHash(decoded.value.destination.hash)
    }
    const parsed = parseBitcoreString(address)
    if (parsed.kind !== 'p2pkh') throw new Error('address-kind')
    return p2pkhScriptFromHash(parsed.hash)
  }
  if (address.type === 'scripthash') throw new Error('address-kind')
  return p2pkhScriptFromHash(address.hashBuffer)
}

export function p2pkhHashFromScript(script: Uint8Array): Uint8Array {
  const parsed = pubkeyHashFromOutputScript(Uint8Array.from(script))
  if (!parsed.ok) throw new Error('address-kind')
  return parsed.value
}

export function p2pkhHashFromPublicKey(publicKey: Uint8Array): Uint8Array {
  const hash = pubkeyHashFromBytes(
    cryptoBackend.hash160(Uint8Array.from(publicKey)),
  )
  if (!hash.ok) throw new Error('address-hash')
  return hash.value
}

export function lotusFromPublicKey(
  publicKey: { toBuffer(): Uint8Array },
  networkName: string,
): string {
  return lotusP2pkhFromHash(
    p2pkhHashFromPublicKey(publicKey.toBuffer()),
    networkName,
  )
}

export function lotusFromPrivateKey(
  key: { toPublicKey(): { toBuffer(): Uint8Array } },
  networkName: string,
): string {
  return lotusFromPublicKey(key.toPublicKey(), networkName)
}

export function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function lotusFromAddress(
  address: string | AddressRecord,
  networkName: string,
): string {
  if (typeof address === 'string') {
    const decoded = decodeAddress(address)
    if (
      decoded.ok &&
      (decoded.value.destination.kind === 'p2pkh' ||
        decoded.value.destination.kind === 'p2sh')
    ) {
      const encoded = encodeAddress(
        decoded.value.destination,
        chainForNetworkName(networkName),
        'lotus',
      )
      if (!encoded.ok) throw new Error(encoded.error.code)
      return encoded.value
    }
    return lotusFromParsed(parseBitcoreString(address), networkName)
  }
  const hash = Uint8Array.from(address.hashBuffer)
  if (address.type === 'scripthash') {
    const encoded = encodeAddress(
      { kind: 'p2sh', hash: hash as ScriptHash },
      chainForNetworkName(networkName),
      'lotus',
    )
    if (!encoded.ok) throw new Error(encoded.error.code)
    return encoded.value
  }
  return lotusP2pkhFromHash(hash, networkName)
}
