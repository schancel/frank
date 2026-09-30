// Explicit chain descriptors. No global registry and no default chain.
// Bytes below are copied from the cited node sources. Fields that were not
// pinned stay `unpinned` instead of inheriting another chain's value.

export type ChainFamily = 'btc' | 'bch' | 'xec' | 'xpi'
export type NetworkKind = 'mainnet' | 'testnet' | 'regtest'

export type MessageMagic =
  | {
      readonly status: 'pinned'
      readonly text: string
      readonly source: string
    }
  | { readonly status: 'unpinned'; readonly reason: string }

export type PolicyAmount = {
  readonly status: 'unpinned'
  readonly reason: string
}

export type DisplayUnit =
  | {
      readonly status: 'pinned'
      readonly name: string
      readonly satoshisPerUnit: bigint
      readonly source: string
    }
  | { readonly status: 'unpinned'; readonly reason: string }

export type SighashFamily =
  | { readonly kind: 'btc-legacy-and-segwit' }
  | {
      readonly kind: 'forkid'
      readonly forkId: 0
      readonly source: string
    }
  | { readonly kind: 'unpinned'; readonly reason: string }

export type HeaderShape =
  | { readonly kind: 'bitcoin-80' }
  | {
      readonly kind: 'not-bitcoin-80'
      readonly genesisSizeBytes: number
      readonly source: string
    }

export interface ChainDescriptor {
  readonly family: ChainFamily
  readonly network: NetworkKind
  readonly pubkeyHashVersion: number
  readonly scriptHashVersion: number
  readonly wifVersion: number
  /** BIP32 version bytes, big-endian uint32. */
  readonly hdPublicVersion: number
  readonly hdPrivateVersion: number
  /** Bech32 human-readable part. Null when the chain has no bech32. */
  readonly bech32Hrp: string | null
  /**
   * CashAddr prefix this descriptor will encode. Null when the node selects
   * the prefix with a flag and this library will not pick one.
   */
  readonly cashaddrPrefix: string | null
  readonly p2pMagic: number
  readonly p2pPort: number
  /** SLIP-0044 registered coin type. Derivation must still pass a coin type. */
  readonly registeredSlip44: number
  /** Other registered or historical coin types. Not a default. */
  readonly alsoDocumentsSlip44: readonly number[]
  readonly messageMagic: MessageMagic
  readonly displayUnit: DisplayUnit
  readonly sighash: SighashFamily
  readonly dust: PolicyAmount
  readonly relayFeePerKb: PolicyAmount
  readonly header: HeaderShape
  readonly sources: readonly string[]
}

export interface UnknownChainError {
  readonly code: 'unknown-chain'
  readonly family: string
  readonly network: string
}
