import type { ChainDescriptor } from './types.js'
import {
  BITCOIN_80,
  BTC_SCRIPT,
  COIN_100_000_000,
  UNPINNED_POLICY,
  chain,
} from './shared.js'

const LTC_MESSAGE = Object.freeze({
  status: 'unpinned' as const,
  reason: 'Message signing is not used by this transaction-only descriptor.',
})

const LTC_SIGHASH = Object.freeze({
  kind: 'btc-legacy-and-segwit' as const,
})

export const LTC_MAINNET: ChainDescriptor = chain({
  protocolId: 'litecoin-mainnet',
  family: 'ltc',
  network: 'mainnet',
  pubkeyHashVersion: 48,
  scriptHashVersion: 50,
  wifVersion: 176,
  hdPublicVersion: 0x0488b21e,
  hdPrivateVersion: 0x0488ade4,
  bech32Hrp: 'ltc',
  cashaddrPrefix: null,
  p2pMagic: 0xfbc0b6db,
  p2pPort: 9333,
  registeredSlip44: 2,
  alsoDocumentsSlip44: [],
  messageMagic: LTC_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: LTC_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  script: BTC_SCRIPT,
  sources: [
    'litecoin-project/litecoin src/chainparams.cpp CMainParams: address versions, bech32_hrp "ltc", P2P magic and port, genesis 12a765e3…',
    'SLIP-0044 coin type 2',
  ],
})

export const LTC_TESTNET: ChainDescriptor = chain({
  protocolId: 'litecoin-testnet',
  family: 'ltc',
  network: 'testnet',
  pubkeyHashVersion: 111,
  scriptHashVersion: 58,
  wifVersion: 239,
  hdPublicVersion: 0x043587cf,
  hdPrivateVersion: 0x04358394,
  bech32Hrp: 'tltc',
  cashaddrPrefix: null,
  p2pMagic: 0xfdd2c8f1,
  p2pPort: 19335,
  registeredSlip44: 1,
  alsoDocumentsSlip44: [],
  messageMagic: LTC_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: LTC_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: BITCOIN_80,
  script: BTC_SCRIPT,
  sources: [
    'litecoin-project/litecoin src/chainparams.cpp CTestNetParams: address versions, bech32_hrp "tltc", P2P magic and port',
    'SLIP-0044 testnet coin type 1',
  ],
})
