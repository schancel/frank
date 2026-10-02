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
  | { readonly kind: 'lotus'; readonly source: string }
  | { readonly kind: 'unpinned'; readonly reason: string }

export type HeaderShape =
  | { readonly kind: 'bitcoin-80' }
  | {
      readonly kind: 'not-bitcoin-80'
      readonly genesisSizeBytes: number
      readonly source: string
    }

/**
 * Opcode set and limits for one named upgrade. Flags are explicit: nothing
 * defaults to off. `tapscript` and `schnorr` stay rejected until a later
 * ticket implements them against vectors. Unknown witness programs are not
 * a legacy success.
 */
export interface ScriptRules {
  readonly era: string
  readonly source: string
  readonly tapscript: 'rejected'
  readonly schnorr: 'rejected'
  readonly p2sh: boolean
  readonly sigPushOnly: boolean
  readonly minimalData: boolean
  readonly minimalIf: boolean
  readonly cleanStack: boolean
  readonly nullDummy: boolean
  readonly nullFail: boolean
  readonly lowS: boolean
  readonly derSig: boolean
  readonly strictEnc: boolean
  readonly checkLockTime: boolean
  readonly checkSequence: boolean
  readonly discourageNops: boolean
  readonly cat: boolean
  readonly bitwise: boolean
  readonly divMod: boolean
  readonly num2bin: boolean
  readonly checkDataSig: boolean
  readonly reverseBytes: boolean
  readonly introspection: boolean
  readonly maxElementBytes: number
  readonly maxOps: number
  readonly maxScriptBytes: number
  readonly maxStackItems: number
  readonly maxScriptNumBytes: number
}

export interface ChainDescriptor {
  /** Stable Frank protocol identifier used in relay paths and signed scopes. */
  readonly protocolId: string
  /** Relay dispatch family. Nakamoto-style chains share the Bitcoin proxy family. */
  readonly proxyFamily: 'bitcoin'
  /** Capabilities the protocol permits; a relay may advertise only a configured subset. */
  readonly allowedProxyCapabilities: readonly ('json-rpc' | 'chronik')[]
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
  readonly script: ScriptRules
  readonly sources: readonly string[]
}

export interface UnknownChainError {
  readonly code: 'unknown-chain'
  readonly family: string
  readonly network: string
}
