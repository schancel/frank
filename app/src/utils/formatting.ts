import { Address, crypto } from 'bitcore-lib-xpi'
import { colorSalt } from './constants'

export function formatBalance(balance: number) {
  const isNegative = balance < 0 ? '-' : ''
  const sats = Math.abs(balance)
  if (sats < 1_000) {
    return isNegative + String(sats) + ' sats'
  }

  return isNegative + (sats / 1_000_000).toFixed(2) + ' Lotus'
}

export function addressColor(address: Address) {
  const rawAddress = address.toBuffer()

  // Add salt
  const saltedAddress = Buffer.concat([rawAddress, colorSalt])

  const hashbuf = crypto.Hash.sha256(saltedAddress)
  const hue = hashbuf[0]
  const saturation = hashbuf[1] / 255

  return { hue, saturation }
}

export function addressColorFromStr(addrStr: string) {
  const addrObj = new Address(addrStr)
  const { hue, saturation } = addressColor(addrObj)
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
  const saltedPubKey = Buffer.concat([Buffer.from(pubKey), colorSalt])
  const hashbuf = crypto.Hash.sha256(saltedPubKey)
  const hue = hashbuf[0]
  const saturation = hashbuf[1] / 255
  return `hsl(${hue}, ${saturation * 100}%, 60%)`
}
