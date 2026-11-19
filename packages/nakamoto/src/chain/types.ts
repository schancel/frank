// Explicit chain descriptors. No global registry and no default chain.
// Bytes below are copied from the cited node sources. Fields that were not
// pinned stay `unpinned` instead of inheriting another chain's value.

export type ChainFamily = 'btc' | 'bch' | 'xec' | 'xpi' | 'doge' | 'ltc'
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
  | { readonly kind: 'legacy-only'; readonly source: string }
  | {
      readonly kind: 'forkid'
      readonly forkId: 0
      readonly commitUtxos: boolean
      readonly source: string
    }
  | { readonly kind: 'lotus'; readonly source: string }
  | { readonly kind: 'unpinned'; readonly reason: string }

export type HeaderShape =
  | { readonly kind: 'bitcoin-80' }
  | { readonly kind: 'auxpow-variable'; readonly source: string }
  | {
      readonly kind: 'not-bitcoin-80'
      readonly genesisSizeBytes: number
      readonly source: string
    }

export type LotusNetChar = '_' | 'T' | 'R'
export type MerkleOddRule = 'duplicate-last' | 'pad-zero'

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

export type ProtocolIdentityProbe = Readonly<
  | {
      kind: 'operator-block-checkpoint'
      capability: 'json-rpc' | 'chronik' | 'electrum'
    }
  | {
      kind: 'evm-chain-id'
      capability: 'json-rpc'
      expected: string
    }
  | {
      kind: 'block-hash'
      capability: 'json-rpc' | 'chronik' | 'electrum'
      height: number
      expected: string
    }
>

/**
 * What every nakamoto chain shares, whatever its transaction format: the
 * protocol identity in `docs/protocol/chains/v1.json` and the network kind.
 */
export interface ChainIdentity {
  /** Stable Frank protocol identifier used in relay paths and signed scopes. */
  readonly protocolId: string
  /** Relay dispatch family. Nakamoto-style chains share the Bitcoin proxy family. */
  readonly proxyFamily: 'bitcoin'
  /** Capabilities the protocol permits; a relay may advertise only a configured subset. */
  readonly allowedProxyCapabilities: readonly (
    | 'json-rpc'
    | 'chronik'
    | 'electrum'
  )[]
  /** Required checks binding an upstream to this exact chain. */
  readonly identityProbes: readonly ProtocolIdentityProbe[]
  readonly network: NetworkKind
  readonly sources: readonly string[]
}

/**
 * Transaction format. It selects the whole object model: grammar, identity
 * hash, signature message, address layout and Merkle rule change together,
 * so they are not independent fields of one descriptor.
 */
export type ChainFormat = 'bitcoin' | 'lotus-v2'

/** A Bitcoin-format chain (BTC, BCH, XEC, XPI v1, DOGE, LTC). */
export interface ChainDescriptor extends ChainIdentity {
  readonly format: 'bitcoin'
  readonly family: ChainFamily
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
  /** Lotus network character following the `lotus` token (`_`, `T`, `R`), or null. */
  readonly lotusNetChar: LotusNetChar | null
  /** Odd-level merkle partner rule (`duplicate-last` on Bitcoin-like chains, `pad-zero` on Lotus). */
  readonly merkleOddRule: MerkleOddRule
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
}

/**
 * A Lotus v2 network (native version-7 transactions). Each field is a
 * capability read by `src/lotus-v2/`; the values are spec facts with their
 * source in `sources`.
 */
export interface LotusV2ChainDescriptor extends ChainIdentity {
  readonly format: 'lotus-v2'
  /** 32-byte ChainID, hex in digest order. Committed in every TxID, TxHash and signature message. */
  readonly chainId: string
  /** The only transaction version (P01). */
  readonly transactionVersion: 7
  /** `H_name(x) = BLAKE3(tagPrefix + name || 00 || x)` (P02 hash registry). */
  readonly hash: {
    readonly kind: 'blake3-tagged'
    readonly tagPrefix: 'Lotus/v2/'
  }
  /** P02 `IndexedTreeRoot`: layer-numbered nodes, odd levels padded with 32 zero bytes. */
  readonly merkle: {
    readonly kind: 'indexed-tagged'
    readonly oddRule: 'pad-zero'
  }
  /** addresses.md typed addresses: hrp, 40-bit checksum constant, accepted type selectors. */
  readonly address: {
    readonly kind: 'lotus-v2-typed'
    readonly hrp: string
    readonly checksumConstant: bigint
    readonly types: readonly (0 | 1)[]
  }
  /** P01 CHECKSIG: unmodified BIP340 over x-only keys, with the defined signing modes. */
  readonly signature: {
    readonly kind: 'bip340-x-only'
    readonly modes: readonly (0 | 1 | 2)[]
  }
}

/** Every descriptor nakamoto defines, discriminated by `format`. */
export type AnyChainDescriptor = ChainDescriptor | LotusV2ChainDescriptor

export interface UnknownChainError {
  readonly code: 'unknown-chain'
  readonly family: string
  readonly network: string
}
