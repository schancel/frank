import type { ChainDescriptor, MessageMagic } from './types.js'
import {
  BITCOIN_80,
  BTC_SCRIPT,
  COIN_100_000_000,
  UNPINNED_POLICY,
  btcLikeVersions,
  chain,
} from './shared.js'

const BTC_MESSAGE: MessageMagic = Object.freeze({
  status: 'pinned',
  text: 'Bitcoin Signed Message:\n',
  source:
    'bitcoin/bitcoin src/common/signmessage.cpp MESSAGE_MAGIC (master, read 2026-09-29)',
})

const BTC_SIGHASH = Object.freeze({
  kind: 'btc-legacy-and-segwit' as const,
})

const BTC_SOURCES = [
  'bitcoin/bitcoin src/kernel/chainparams.cpp (master, read 2026-09-29)',
  'bitcoin/bitcoin src/common/signmessage.cpp',
  'SLIP-0044 coin type 0',
] as const

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
  script: BTC_SCRIPT,
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
  script: BTC_SCRIPT,
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
  script: BTC_SCRIPT,
  sources: BTC_SOURCES,
})
