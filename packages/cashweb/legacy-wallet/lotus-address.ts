import { Address } from 'bitcore-lib-xpi'
import { decodeAddress, encodeAddress, type ScriptHash } from '@frank/nakamoto'

import { chainForNetworkName, lotusP2pkhFromHash } from './lotus-identity'

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
