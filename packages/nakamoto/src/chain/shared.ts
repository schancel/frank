import type {
  ChainDescriptor,
  DisplayUnit,
  HeaderShape,
  PolicyAmount,
  SighashFamily,
} from './types.js'

export const UNPINNED_POLICY: PolicyAmount = Object.freeze({
  status: 'unpinned',
  reason:
    'Policy, not consensus. The old library constants of 546 satoshis and 100000 satoshis per kilobyte are not copied onto every chain.',
})

export const COIN_100_000_000: DisplayUnit = Object.freeze({
  status: 'pinned',
  name: 'coin',
  satoshisPerUnit: 100_000_000n,
  source:
    'Bitcoin Core and Bitcoin Cash Node genesis construction uses 50 * COIN, and the chainparams comment prints that output as 50.00000000. Display scale is 1e8 satoshis.',
})

export const FORKID_ZERO = (source: string): SighashFamily =>
  Object.freeze({
    kind: 'forkid',
    forkId: 0 as const,
    source,
  })

export const BITCOIN_80: HeaderShape = Object.freeze({ kind: 'bitcoin-80' })

const HD_MAIN_PUB = 0x0488b21e
const HD_MAIN_PRIV = 0x0488ade4
const HD_TEST_PUB = 0x043587cf
const HD_TEST_PRIV = 0x04358394

export function chain(fields: ChainDescriptor): ChainDescriptor {
  return Object.freeze({
    ...fields,
    alsoDocumentsSlip44: Object.freeze([...fields.alsoDocumentsSlip44]),
    sources: Object.freeze([...fields.sources]),
  })
}

export function btcLikeVersions(network: 'mainnet' | 'testnet' | 'regtest'): {
  pubkeyHashVersion: number
  scriptHashVersion: number
  wifVersion: number
  hdPublicVersion: number
  hdPrivateVersion: number
} {
  if (network === 'mainnet') {
    return {
      pubkeyHashVersion: 0,
      scriptHashVersion: 5,
      wifVersion: 128,
      hdPublicVersion: HD_MAIN_PUB,
      hdPrivateVersion: HD_MAIN_PRIV,
    }
  }
  return {
    pubkeyHashVersion: 111,
    scriptHashVersion: 196,
    wifVersion: 239,
    hdPublicVersion: HD_TEST_PUB,
    hdPrivateVersion: HD_TEST_PRIV,
  }
}

/** Legacy base58 version byte. The chain argument is required. */
export function addressVersionBytes(
  descriptor: ChainDescriptor,
  kind: 'pubkeyhash' | 'scripthash' | 'wif',
): number {
  switch (kind) {
    case 'pubkeyhash':
      return descriptor.pubkeyHashVersion
    case 'scripthash':
      return descriptor.scriptHashVersion
    case 'wif':
      return descriptor.wifVersion
  }
}
