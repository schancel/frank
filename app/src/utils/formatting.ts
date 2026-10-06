import {
  BCH_MAINNET,
  BCH_REGTEST,
  BCH_TESTNET,
  addressVersionBytes,
  cryptoBackend,
  decodeAddress,
  type ChainDescriptor,
  type DecodedAddress,
} from '@frank/nakamoto'
import { colorSalt } from './constants'

/** One SHA-256 of `bytes || colorSalt` (ASCII `salt`). Hue is byte 0 and
 * saturation is byte 1 / 255, including a zero byte. Matches bitcore
 * `crypto.Hash.sha256` and Node `createHash('sha256')`. Not double-SHA256.
 * cryptoBackend rejects Buffer. */
function saltedColorDigest(bytes: Uint8Array): Uint8Array {
  const payload = Uint8Array.from(bytes)
  const salt = Uint8Array.from(colorSalt)
  const salted = new Uint8Array(payload.length + salt.length)
  salted.set(payload, 0)
  salted.set(salt, payload.length)
  return cryptoBackend.sha256(salted)
}

export function formatBalance(balance: number) {
  const isNegative = balance < 0 ? '-' : ''
  const sats = Math.abs(balance)
  if (sats < 1_000) {
    return isNegative + String(sats) + ' sats'
  }

  return isNegative + (sats / 1_000_000).toFixed(2) + ' Lotus'
}

/** `Address.toBuffer()` is one version byte plus hash160. Livenet pubkeyhash
 * is 0 and scripthash is 5. Testnet and regtest are 0x6f and 0xc4. XPI
 * `decodeAddress` rejects legacy base58, so cashaddr and base58 use the BCH
 * descriptors, which carry those same version bytes. Lotus keeps the XPI
 * chain `decodeAddress` returns; those version bytes match too. */
const COLOR_CHAINS: readonly ChainDescriptor[] = [
  BCH_MAINNET,
  BCH_TESTNET,
  BCH_REGTEST,
]

function colorable(decoded: DecodedAddress): boolean {
  const kind = decoded.destination.kind
  if (kind !== 'p2pkh' && kind !== 'p2sh') return false
  if (decoded.encoding === 'lotus') return decoded.chain.family === 'xpi'
  if (decoded.encoding === 'cashaddr') {
    const prefix = decoded.chain.cashaddrPrefix
    return (
      prefix === 'bitcoincash' || prefix === 'bchtest' || prefix === 'bchreg'
    )
  }
  if (decoded.encoding === 'base58check') return decoded.chain.family === 'bch'
  return false
}

function invalidAddress(): never {
  throw new TypeError('Invalid Address string provided')
}

function decodeForColor(addrStr: string): DecodedAddress {
  if (addrStr.length < 34) invalidAddress()
  if (addrStr.length > 100) {
    throw new TypeError('address string is too long')
  }
  const text = addrStr.trim()
  if (text.length > 35) {
    const direct = decodeAddress(text)
    if (
      direct.ok &&
      colorable(direct.value) &&
      direct.value.encoding !== 'base58check'
    ) {
      return direct.value
    }
    for (const chain of COLOR_CHAINS) {
      const decoded = decodeAddress(text, chain)
      if (!decoded.ok || !colorable(decoded.value)) continue
      if (
        decoded.value.encoding === 'cashaddr' ||
        decoded.value.encoding === 'lotus'
      ) {
        return decoded.value
      }
    }
    return invalidAddress()
  }
  for (const chain of COLOR_CHAINS) {
    const decoded = decodeAddress(text, chain)
    if (
      decoded.ok &&
      colorable(decoded.value) &&
      decoded.value.encoding === 'base58check'
    ) {
      return decoded.value
    }
  }
  return invalidAddress()
}

/** Version byte || hash160. Same bytes bitcore `Address.toBuffer()` hashes. */
function addressColorBytes(decoded: DecodedAddress): Uint8Array {
  const destination = decoded.destination
  if (destination.kind !== 'p2pkh' && destination.kind !== 'p2sh') {
    return invalidAddress()
  }
  const version = addressVersionBytes(
    decoded.chain,
    destination.kind === 'p2pkh' ? 'pubkeyhash' : 'scripthash',
  )
  const image = new Uint8Array(destination.hash.length + 1)
  image[0] = version
  image.set(destination.hash, 1)
  return image
}

export function addressColor(addressBytes: Uint8Array) {
  const hashbuf = saltedColorDigest(addressBytes)
  const hue = hashbuf[0]
  const saturation = hashbuf[1] / 255

  return { hue, saturation }
}

export function addressColorFromStr(addrStr: string) {
  const { hue, saturation } = addressColor(
    addressColorBytes(decodeForColor(addrStr)),
  )
  const color = `hsl(${hue}, ${saturation * 100}%, 60%)`
  return color
}

/** Ticket #50: a spoofing/impersonation cue -- derives a color directly from a contact's raw
 * public key bytes (chain-agnostic on purpose: no Lotus/Monad-specific address encoding, so it
 * works the same regardless of `activeChain`), same hash-to-hue approach as `addressColor` above
 * for consistency. If a contact's pubkey ever changes -- a real key rotation (#46), or someone
 * spoofing a name/avatar with a different key -- this color visibly changes too, even when the
 * display name/avatar look identical. A genuine key rotation changing this color is expected,
 * not a bug, once #46 ships. */
export function pubKeyToColor(pubKey: Uint8Array): string {
  const hashbuf = saltedColorDigest(pubKey)
  const hue = hashbuf[0]
  const saturation = hashbuf[1] / 255
  return `hsl(${hue}, ${saturation * 100}%, 60%)`
}

/** Formats a conversation timestamp for chat list display. */
export function formatConversationTimestamp(
  timestamp?: number | null,
): string {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  }
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

