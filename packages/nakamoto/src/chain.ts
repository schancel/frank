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

const UNPINNED_POLICY: PolicyAmount = Object.freeze({
  status: 'unpinned',
  reason:
    'Policy, not consensus. The old library constants of 546 satoshis and 100000 satoshis per kilobyte are not copied onto every chain.',
})

const BTC_MESSAGE: MessageMagic = Object.freeze({
  status: 'pinned',
  text: 'Bitcoin Signed Message:\n',
  source:
    'bitcoin/bitcoin src/common/signmessage.cpp MESSAGE_MAGIC (master, read 2026-09-29)',
})

const BCH_MESSAGE: MessageMagic = Object.freeze({
  status: 'pinned',
  text: 'Bitcoin Signed Message:\n',
  source:
    'bitcoin-cash-node/bitcoin-cash-node src/validation.cpp strMessageMagic (master, read 2026-09-30)',
})

const UNPINNED_XEC_MESSAGE: MessageMagic = Object.freeze({
  status: 'unpinned',
  reason:
    'A wallet string "eCash Signed Message:\\n" was seen in Trezor coininfo. Bitcoin ABC was not quoted, so the descriptor does not offer a magic.',
})

const UNPINNED_XPI_MESSAGE: MessageMagic = Object.freeze({
  status: 'unpinned',
  reason: 'lotusd message magic was not quoted.',
})

const COIN_100_000_000: DisplayUnit = Object.freeze({
  status: 'pinned',
  name: 'coin',
  satoshisPerUnit: 100_000_000n,
  source:
    'Bitcoin Core and Bitcoin Cash Node genesis construction uses 50 * COIN, and the chainparams comment prints that output as 50.00000000. Display scale is 1e8 satoshis.',
})

const UNPINNED_XEC_UNIT: DisplayUnit = Object.freeze({
  status: 'unpinned',
  reason:
    'Bitcoin ABC src/currencyunit.h (read 2026-09-29) sets DEFAULT_ECASH and does not state a display scale. The 2021 rebase (1 XEC = 100 satoshis) is not copied here until a node file states it.',
})

const UNPINNED_XPI_UNIT: DisplayUnit = Object.freeze({
  status: 'unpinned',
  reason:
    'lotus-sdk documents 6 decimal places. lotusd was not quoted for the display scale, so this descriptor does not pick 1e6 or 1e8.',
})

const BTC_SIGHASH: SighashFamily = Object.freeze({
  kind: 'btc-legacy-and-segwit',
})

const FORKID_ZERO = (source: string): SighashFamily =>
  Object.freeze({
    kind: 'forkid',
    forkId: 0 as const,
    source,
  })

const UNPINNED_XPI_SIGHASH: SighashFamily = Object.freeze({
  kind: 'unpinned',
  reason:
    'SIGHASH_LOTUS was not found in the lotusd chainparams read. Forkid-0 is not assumed.',
})

const BITCOIN_80: HeaderShape = Object.freeze({ kind: 'bitcoin-80' })

const XPI_HEADER: HeaderShape = Object.freeze({
  kind: 'not-bitcoin-80',
  genesisSizeBytes: 379,
  source:
    'LotusiaStewardship/lotusd src/chainparams.cpp asserts genesis.GetSize() == 379 and checks hashExtendedMetadata (master, read 2026-09-29).',
})

const HD_MAIN_PUB = 0x0488b21e
const HD_MAIN_PRIV = 0x0488ade4
const HD_TEST_PUB = 0x043587cf
const HD_TEST_PRIV = 0x04358394

const BTC_SOURCES = [
  'bitcoin/bitcoin src/kernel/chainparams.cpp (master, read 2026-09-29)',
  'bitcoin/bitcoin src/common/signmessage.cpp',
  'SLIP-0044 coin type 0',
] as const

const BCH_SOURCES = [
  'bitcoin-cash-node/bitcoin-cash-node src/chainparams.cpp (master, read 2026-09-29)',
  'SLIP-0044 coin type 145',
] as const

const XEC_SOURCES = [
  'Bitcoin-ABC/bitcoin-abc src/kernel/chainparams.cpp (master, read 2026-09-29)',
  'Bitcoin-ABC/bitcoin-abc src/currencyunit.h DEFAULT_ECASH = true',
  'Bitcoin-ABC/bitcoin-abc doc/standards/cashaddr.md prefixes ecash, ectest, ecregtest',
  'SLIP-0044 coin type 899, eCash token 1899; historical wallet path 145',
] as const

const XPI_SOURCES = [
  'LotusiaStewardship/lotusd src/chainparams.cpp (master, read 2026-09-29)',
  'SLIP-0044 coin type 10605',
] as const

function chain(fields: ChainDescriptor): ChainDescriptor {
  return Object.freeze({
    ...fields,
    alsoDocumentsSlip44: Object.freeze([...fields.alsoDocumentsSlip44]),
    sources: Object.freeze([...fields.sources]),
  })
}

function btcLikeVersions(network: NetworkKind): {
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

export const BTC_MAINNET: ChainDescriptor = chain({
  family: 'btc',
  network: 'mainnet',
  ...btcLikeVersions('mainnet'),
  bech32Hrp: 'bc',
  cashaddrPrefix: null,
  p2pMagic: 0xf9beb4d9,
  p2pPort: 8333,
  registeredSlip44: 0,
  alsoDocumentsSlip44: [],
  messageMagic: BTC_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: BTC_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: BTC_SOURCES,
})

export const BTC_TESTNET: ChainDescriptor = chain({
  family: 'btc',
  network: 'testnet',
  ...btcLikeVersions('testnet'),
  bech32Hrp: 'tb',
  cashaddrPrefix: null,
  p2pMagic: 0x0b110907,
  p2pPort: 18333,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [],
  messageMagic: BTC_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: BTC_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: [
    ...BTC_SOURCES,
    'This testnet is Bitcoin Core testnet3 (port 18333). testnet4 is a different network and is not this descriptor.',
  ],
})

export const BTC_REGTEST: ChainDescriptor = chain({
  family: 'btc',
  network: 'regtest',
  ...btcLikeVersions('regtest'),
  bech32Hrp: 'bcrt',
  cashaddrPrefix: null,
  p2pMagic: 0xfabfb5da,
  p2pPort: 18444,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [],
  messageMagic: BTC_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: BTC_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: BTC_SOURCES,
})

export const BCH_MAINNET: ChainDescriptor = chain({
  family: 'bch',
  network: 'mainnet',
  ...btcLikeVersions('mainnet'),
  bech32Hrp: null,
  cashaddrPrefix: 'bitcoincash',
  p2pMagic: 0xe3e1f3e8,
  p2pPort: 8333,
  registeredSlip44: 145,
  alsoDocumentsSlip44: [],
  messageMagic: BCH_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: FORKID_ZERO(
    'Bitcoin Cash sighash uses FORKID. Fork id 0 is what the sighash ticket must cite from Bitcoin Cash Node; this descriptor records 0 and does not implement the hash.',
  ),
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: BCH_SOURCES,
})

export const BCH_TESTNET: ChainDescriptor = chain({
  family: 'bch',
  network: 'testnet',
  ...btcLikeVersions('testnet'),
  bech32Hrp: null,
  cashaddrPrefix: 'bchtest',
  p2pMagic: 0xf4e5f3f4,
  p2pPort: 18333,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [],
  messageMagic: BCH_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: BCH_MAINNET.sighash,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: [
    ...BCH_SOURCES,
    'This testnet is Bitcoin Cash Node testnet3 (port 18333, cashaddr bchtest). testnet4, chipnet, and scalenet are not this descriptor.',
  ],
})

export const BCH_REGTEST: ChainDescriptor = chain({
  family: 'bch',
  network: 'regtest',
  ...btcLikeVersions('regtest'),
  bech32Hrp: null,
  cashaddrPrefix: 'bchreg',
  p2pMagic: 0xdab5bffa,
  p2pPort: 18444,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [],
  messageMagic: BCH_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: BCH_MAINNET.sighash,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: BCH_SOURCES,
})

export const XEC_MAINNET: ChainDescriptor = chain({
  family: 'xec',
  network: 'mainnet',
  ...btcLikeVersions('mainnet'),
  bech32Hrp: null,
  cashaddrPrefix: 'ecash',
  p2pMagic: 0xe3e1f3e8,
  p2pPort: 8333,
  registeredSlip44: 899,
  alsoDocumentsSlip44: [145, 1899],
  messageMagic: UNPINNED_XEC_MESSAGE,
  displayUnit: UNPINNED_XEC_UNIT,
  sighash: FORKID_ZERO(
    'Bitcoin ABC src/kernel/chainparams.cpp keeps the Bitcoin Cash network magic. No new fork id is in that file. The sighash ticket must quote SignatureHash before treating fork id 0 as eCash consensus.',
  ),
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: XEC_SOURCES,
})

export const XEC_TESTNET: ChainDescriptor = chain({
  family: 'xec',
  network: 'testnet',
  ...btcLikeVersions('testnet'),
  bech32Hrp: null,
  cashaddrPrefix: 'ectest',
  p2pMagic: 0xf4e5f3f4,
  p2pPort: 18333,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [145, 1899],
  messageMagic: UNPINNED_XEC_MESSAGE,
  displayUnit: UNPINNED_XEC_UNIT,
  sighash: XEC_MAINNET.sighash,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: XEC_SOURCES,
})

export const XEC_REGTEST: ChainDescriptor = chain({
  family: 'xec',
  network: 'regtest',
  ...btcLikeVersions('regtest'),
  bech32Hrp: null,
  cashaddrPrefix: 'ecregtest',
  p2pMagic: 0xdab5bffa,
  p2pPort: 18444,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [145, 1899],
  messageMagic: UNPINNED_XEC_MESSAGE,
  displayUnit: UNPINNED_XEC_UNIT,
  sighash: XEC_MAINNET.sighash,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: XEC_SOURCES,
})

const XPI_CASHADDR_REASON =
  'lotusd src/chainparams.cpp sets cashaddrPrefix from UseECashPrefix() (ecash or bitcoincash, and the test/regtest pairs). The default of that flag is not applied here, so no XPI string prefix is selected.'

export const XPI_MAINNET: ChainDescriptor = chain({
  family: 'xpi',
  network: 'mainnet',
  ...btcLikeVersions('mainnet'),
  bech32Hrp: null,
  cashaddrPrefix: null,
  p2pMagic: 0xece7eff3,
  p2pPort: 10605,
  registeredSlip44: 10605,
  alsoDocumentsSlip44: [],
  messageMagic: UNPINNED_XPI_MESSAGE,
  displayUnit: UNPINNED_XPI_UNIT,
  sighash: UNPINNED_XPI_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: XPI_HEADER,
  sources: [...XPI_SOURCES, XPI_CASHADDR_REASON],
})

export const XPI_TESTNET: ChainDescriptor = chain({
  family: 'xpi',
  network: 'testnet',
  ...btcLikeVersions('testnet'),
  bech32Hrp: null,
  cashaddrPrefix: null,
  p2pMagic: 0xecf4f3f4,
  p2pPort: 11605,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [],
  messageMagic: UNPINNED_XPI_MESSAGE,
  displayUnit: UNPINNED_XPI_UNIT,
  sighash: UNPINNED_XPI_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: XPI_HEADER,
  sources: XPI_SOURCES,
})

export const XPI_REGTEST: ChainDescriptor = chain({
  family: 'xpi',
  network: 'regtest',
  ...btcLikeVersions('regtest'),
  bech32Hrp: null,
  cashaddrPrefix: null,
  p2pMagic: 0xecf2e5e7,
  p2pPort: 12605,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [],
  messageMagic: UNPINNED_XPI_MESSAGE,
  displayUnit: UNPINNED_XPI_UNIT,
  sighash: UNPINNED_XPI_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: XPI_HEADER,
  sources: XPI_SOURCES,
})

export const CHAINS: readonly ChainDescriptor[] = Object.freeze([
  BTC_MAINNET,
  BTC_TESTNET,
  BTC_REGTEST,
  BCH_MAINNET,
  BCH_TESTNET,
  BCH_REGTEST,
  XEC_MAINNET,
  XEC_TESTNET,
  XEC_REGTEST,
  XPI_MAINNET,
  XPI_TESTNET,
  XPI_REGTEST,
])

const BY_KEY = new Map<string, ChainDescriptor>(
  CHAINS.map(item => [`${item.family}:${item.network}`, item]),
)

export function getChain(
  family: ChainFamily,
  network: NetworkKind,
): ChainDescriptor | UnknownChainError {
  const found = BY_KEY.get(`${family}:${network}`)
  if (!found) {
    return { code: 'unknown-chain', family, network }
  }
  return found
}

/** Legacy base58 version byte. The chain argument is required. */
export function addressVersionBytes(
  chain: ChainDescriptor,
  kind: 'pubkeyhash' | 'scripthash' | 'wif',
): number {
  switch (kind) {
    case 'pubkeyhash':
      return chain.pubkeyHashVersion
    case 'scripthash':
      return chain.scriptHashVersion
    case 'wif':
      return chain.wifVersion
  }
}
