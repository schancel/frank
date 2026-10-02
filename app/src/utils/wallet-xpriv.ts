// UI master key (decision #592). BIP39 seed bytes go through hdPrivateFromSeed.
// The HMAC key is "Bitcoin seed". A left half outside (0, n) is an error.
// The stored record matches bitcore HDPrivateKey.toObject() for livenet:
// xpriv version 0x0488ade4. No address string. The seed copy is wiped.
import {
  BTC_MAINNET,
  BTC_TESTNET,
  hdPrivateFromSeed,
  parseHdPrivate,
  serializeHdPrivate,
} from '@frank/nakamoto'

export class WalletXprivError extends Error {
  readonly code = 'wallet-xpriv-invalid' as const

  constructor() {
    super('wallet-xpriv-invalid')
    this.name = 'WalletXprivError'
  }
}

/** Plain record the wallet store saves. Extra toObject fields may be present. */
export interface StoredXpriv {
  network: string
  depth: number
  parentFingerPrint: number
  childIndex: number
  chainCode: string
  privateKey: string
  xprivkey: string
  fingerPrint?: number
  checksum?: number
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Master record for a hex seed. Throws `WalletXprivError` and stores nothing. */
export function walletXprivFromSeedHex(hexSeed: string): StoredXpriv {
  const seed = hexToBytes(hexSeed)
  if (!seed) throw new WalletXprivError()
  const node = hdPrivateFromSeed(seed)
  seed.fill(0)
  if (!node.ok) throw new WalletXprivError()
  const xprivkey = serializeHdPrivate(node.value, BTC_MAINNET)
  if (!xprivkey.ok) throw new WalletXprivError()
  return {
    network: 'livenet',
    depth: 0,
    parentFingerPrint: 0,
    childIndex: 0,
    chainCode: bytesToHex(node.value.chainCode),
    privateKey: bytesToHex(node.value.privateKey.bytes),
    xprivkey: xprivkey.value,
  }
}

function isHex(value: unknown, length: number): value is string {
  return (
    typeof value === 'string' &&
    value.length === length &&
    /^[0-9a-fA-F]+$/.test(value)
  )
}

/** Accept a new record or a bitcore toObject() value. A bad record throws. */
export function assertStoredXpriv(value: unknown): StoredXpriv {
  if (typeof value !== 'object' || value === null) throw new WalletXprivError()
  const record = value as StoredXpriv
  if (typeof record.xprivkey !== 'string') throw new WalletXprivError()
  if (!isHex(record.chainCode, 64) || !isHex(record.privateKey, 64)) {
    throw new WalletXprivError()
  }
  const mainnet = parseHdPrivate(record.xprivkey, BTC_MAINNET)
  const parsed = mainnet.ok
    ? mainnet
    : parseHdPrivate(record.xprivkey, BTC_TESTNET)
  if (!parsed.ok) throw new WalletXprivError()
  const secret = bytesToHex(parsed.value.privateKey.bytes)
  const chainCode = bytesToHex(parsed.value.chainCode)
  if (
    record.privateKey.toLowerCase() !== secret ||
    record.chainCode.toLowerCase() !== chainCode
  ) {
    throw new WalletXprivError()
  }
  return record
}
