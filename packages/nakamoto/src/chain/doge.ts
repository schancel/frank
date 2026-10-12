import type { ChainDescriptor } from './types.js'
import {
  BTC_SCRIPT,
  COIN_100_000_000,
  UNPINNED_POLICY,
  chain,
} from './shared.js'

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
  messageMagic: {
    status: 'unpinned',
    reason: 'Message signing is not used by this transaction-only descriptor.',
  },
  displayUnit: COIN_100_000_000,
  sighash: {
    kind: 'legacy-only',
    source: 'dogecoin/dogecoin src/script/interpreter.cpp SignatureHash',
  },
  dust: UNPINNED_POLICY,
  relayFeePerKb: UNPINNED_POLICY,
  header: {
    kind: 'auxpow-variable',
    source:
      'dogecoin/dogecoin src/primitives/block.h: AuxPoW follows the 80-byte hash preimage',
  },
  script: {
    ...BTC_SCRIPT,
    era: 'doge-core-p2pkh',
    source:
      'dogecoin/dogecoin src/script/interpreter.cpp: legacy P2PKH signatures',
  },
  sources: [
    'dogecoin/dogecoin src/chainparams.cpp CTestNetParams (master, read 2026-10-12): address versions, P2P magic and port, genesis bb0a7826…',
    'dogecoin/dogecoin src/wallet/wallet.cpp: BIP44_COIN_TYPE = 3',
  ],
})
