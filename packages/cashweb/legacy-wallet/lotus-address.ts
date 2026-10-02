import { Address } from 'bitcore-lib-xpi'
import {
  cryptoBackend,
  decodeAddress,
  encodeAddress,
  lockingScript,
  pubkeyHashFromBytes,
  pubkeyHashFromOutputScript,
  type ScriptHash,
} from '@frank/nakamoto'

import { chainForNetworkName, lotusP2pkhFromHash } from './lotus-identity'

function p2pkhScriptFromHash(hash: Uint8Array): Uint8Array {
  const branded = pubkeyHashFromBytes(Uint8Array.from(hash))
  if (!branded.ok) throw new Error('address-hash')
  return lockingScript({ kind: 'p2pkh', hash: branded.value })
}

/**
 * 25-byte P2PKH script for a Lotus string, or for an older cashaddr / XAddress
 * string. Spend paths use this instead of `Script.buildPublicKeyHashOut`.
 * A script-hash address is `address-kind`.
 */
export function p2pkhLockingScript(address: string | Address): Uint8Array {
  if (typeof address === 'string') {
    const decoded = decodeAddress(address)
    if (decoded.ok) {
      if (decoded.value.destination.kind !== 'p2pkh') {
        throw new Error('address-kind')
      }
      return p2pkhScriptFromHash(decoded.value.destination.hash)
    }
    return p2pkhLockingScript(new Address(address))
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
  address: string | Address,
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
    return lotusFromAddress(new Address(address), networkName)
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
