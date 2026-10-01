import type { ChainDescriptor, MessageMagic } from './types.js'
import {
  UNPINNED_POLICY,
  XPI_SCRIPT,
  btcLikeVersions,
  chain,
} from './shared.js'

const XPI_MESSAGE: MessageMagic = Object.freeze({
  status: 'pinned',
  text: 'Bitcoin Signed Message:\n',
  source:
    'LotusiaStewardship/lotusd src/util/message.cpp MESSAGE_MAGIC (master, read 2026-09-30)',
})

const UNPINNED_XPI_UNIT = Object.freeze({
  status: 'unpinned' as const,
  reason:
    'lotus-sdk documents 6 decimal places. lotusd was not quoted for the display scale, so this descriptor does not pick 1e6 or 1e8.',
})

const XPI_SIGHASH = Object.freeze({
  kind: 'lotus' as const,
  source:
    'LotusiaStewardship/lotusd src/script/interpreter.cpp SignatureHashLotus (master, read 2026-09-30). SignatureHashLotus runs when hasLotus(), (sigHash & 0x60) == 0x60. Numbers sets SCRIPT_DISABLE_TAPROOT_SIGHASH_LOTUS, so that path is rejected on current mainnet. Post-Numbers spends use hasForkId BIP143. Ruth sets SCRIPT_ENABLE_REPLAY_PROTECTION.',
})

const XPI_HEADER = Object.freeze({
  kind: 'not-bitcoin-80' as const,
  genesisSizeBytes: 379,
  source:
    'LotusiaStewardship/lotusd src/chainparams.cpp asserts genesis.GetSize() == 379 and checks hashExtendedMetadata (master, read 2026-09-29).',
})

const XPI_SOURCES = [
  'LotusiaStewardship/lotusd src/chainparams.cpp (master, read 2026-09-29)',
  'LotusiaStewardship/lotusd src/util/message.cpp MESSAGE_MAGIC',
  'SLIP-0044 coin type 10605',
] as const

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
  messageMagic: XPI_MESSAGE,
  displayUnit: UNPINNED_XPI_UNIT,
  sighash: XPI_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: XPI_HEADER,
  script: XPI_SCRIPT,
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
  messageMagic: XPI_MESSAGE,
  displayUnit: UNPINNED_XPI_UNIT,
  sighash: XPI_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: XPI_HEADER,
  script: XPI_SCRIPT,
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
  messageMagic: XPI_MESSAGE,
  displayUnit: UNPINNED_XPI_UNIT,
  sighash: XPI_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: XPI_HEADER,
  script: XPI_SCRIPT,
  sources: XPI_SOURCES,
})
