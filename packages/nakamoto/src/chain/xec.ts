import type { ChainDescriptor, MessageMagic } from './types.js'
import {
  BITCOIN_80,
  FORKID_ZERO,
  UNPINNED_POLICY,
  btcLikeVersions,
  chain,
} from './shared.js'

const XEC_MESSAGE: MessageMagic = Object.freeze({
  status: 'pinned',
  text: 'eCash Signed Message:\n',
  source:
    'Bitcoin-ABC/bitcoin-abc src/common/signmessage.cpp MESSAGE_MAGIC (master, read 2026-09-30)',
})

const UNPINNED_XEC_UNIT = Object.freeze({
  status: 'unpinned' as const,
  reason:
    'Bitcoin ABC src/currencyunit.h (read 2026-09-29) sets DEFAULT_ECASH and does not state a display scale. The 2021 rebase (1 XEC = 100 satoshis) is not copied here until a node file states it.',
})

const XEC_SOURCES = [
  'Bitcoin-ABC/bitcoin-abc src/kernel/chainparams.cpp (master, read 2026-09-29)',
  'Bitcoin-ABC/bitcoin-abc src/common/signmessage.cpp MESSAGE_MAGIC',
  'Bitcoin-ABC/bitcoin-abc src/currencyunit.h DEFAULT_ECASH = true',
  'Bitcoin-ABC/bitcoin-abc doc/standards/cashaddr.md prefixes ecash, ectest, ecregtest',
  'SLIP-0044 coin type 899, eCash token 1899; historical wallet path 145',
] as const

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
  messageMagic: XEC_MESSAGE,
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
  messageMagic: XEC_MESSAGE,
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
  messageMagic: XEC_MESSAGE,
  displayUnit: UNPINNED_XEC_UNIT,
  sighash: XEC_MAINNET.sighash,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  sources: XEC_SOURCES,
})
