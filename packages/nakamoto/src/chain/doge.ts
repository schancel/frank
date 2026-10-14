import type { ChainDescriptor } from './types.js'
import {
  BTC_SCRIPT,
  COIN_100_000_000,
  UNPINNED_POLICY,
  chain,
} from './shared.js'

const DOGE_MESSAGE = Object.freeze({
  status: 'unpinned' as const,
  reason: 'Message signing is not used by this transaction-only descriptor.',
})

const DOGE_SIGHASH = Object.freeze({
  kind: 'legacy-only' as const,
  source: 'dogecoin/dogecoin src/script/interpreter.cpp SignatureHash',
})

const DOGE_HEADER = Object.freeze({
  kind: 'auxpow-variable' as const,
  source:
    'dogecoin/dogecoin src/primitives/block.h: AuxPoW follows the 80-byte hash preimage',
})

const DOGE_SCRIPT = Object.freeze({
  ...BTC_SCRIPT,
  era: 'doge-core-p2pkh',
  source:
    'dogecoin/dogecoin src/script/interpreter.cpp: legacy P2PKH signatures',
})

export const DOGE_MAINNET: ChainDescriptor = chain({
  family: 'doge',
  network: 'mainnet',
  pubkeyHashVersion: 30,
  scriptHashVersion: 22,
  wifVersion: 158,
  hdPublicVersion: 0x02facafd,
  hdPrivateVersion: 0x02fac398,
  bech32Hrp: null,
  cashaddrPrefix: null,
  p2pMagic: 0xc0c0c0c0,
  p2pPort: 22556,
  registeredSlip44: 3,
  alsoDocumentsSlip44: [],
  messageMagic: DOGE_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: DOGE_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: DOGE_HEADER,
  script: DOGE_SCRIPT,
  sources: [
    'dogecoin/dogecoin src/chainparams.cpp CMainParams (master, read 2026-10-12): address versions, P2P magic and port, genesis 1a91e3da…',
    'dogecoin/dogecoin src/wallet/wallet.cpp: BIP44_COIN_TYPE = 3',
  ],
})

/** Dogecoin Core's original testnet (`-testnet`), not the proposed testnet4. */
export const DOGE_TESTNET: ChainDescriptor = chain({
  family: 'doge',
  network: 'testnet',
  pubkeyHashVersion: 113,
  scriptHashVersion: 196,
  wifVersion: 241,
  hdPublicVersion: 0x043587cf,
  hdPrivateVersion: 0x04358394,
  bech32Hrp: null,
  cashaddrPrefix: null,
  p2pMagic: 0xfcc1b7dc,
  p2pPort: 44556,
  registeredSlip44: 3,
  alsoDocumentsSlip44: [],
  messageMagic: DOGE_MESSAGE,
  displayUnit: COIN_100_000_000,
  sighash: DOGE_SIGHASH,
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: DOGE_HEADER,
  script: DOGE_SCRIPT,
  sources: [
    'dogecoin/dogecoin src/chainparams.cpp CTestNetParams (master, read 2026-10-12): address versions, P2P magic and port, genesis bb0a7826…',
    'dogecoin/dogecoin src/wallet/wallet.cpp: BIP44_COIN_TYPE = 3',
  ],
})
