import type { ChainDescriptor, MessageMagic } from './types.js'
import {
  BITCOIN_80,
  COIN_100_000_000,
  FORKID_ZERO,
  UNPINNED_POLICY,
  btcLikeVersions,
  chain,
} from './shared.js'

const UNPINNED_BCH_MESSAGE: MessageMagic = Object.freeze({
  status: 'unpinned',
  reason:
    'Bitcoin Cash Node src/util/message.cpp had no "Signed Message" string when read on 2026-09-29. Do not assume the Bitcoin string.',
})

const BCH_SOURCES = [
  'bitcoin-cash-node/bitcoin-cash-node src/chainparams.cpp (master, read 2026-09-29)',
  'SLIP-0044 coin type 145',
] as const

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
  messageMagic: UNPINNED_BCH_MESSAGE,
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
  messageMagic: UNPINNED_BCH_MESSAGE,
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
  messageMagic: UNPINNED_BCH_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: BCH_MAINNET.sighash,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: BCH_SOURCES,
})
