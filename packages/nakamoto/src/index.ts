// @frank/nakamoto public surface. Browser-safe: no Node built-ins.
// Per-chain entries: ./btc ./bch ./xec ./xpi. Feature entries: ./integer ./script-num.

export const PACKAGE_NAME = '@frank/nakamoto'

export {
  BCH_MAINNET,
  BCH_REGTEST,
  BCH_TESTNET,
  BTC_MAINNET,
  BTC_REGTEST,
  BTC_TESTNET,
  CHAINS,
  XEC_MAINNET,
  XEC_REGTEST,
  XEC_TESTNET,
  XPI_MAINNET,
  XPI_REGTEST,
  XPI_TESTNET,
  addressVersionBytes,
  getChain,
  isUnknownChainError,
} from './chain/index.js'
export type {
  ChainDescriptor,
  ChainFamily,
  DisplayUnit,
  HeaderShape,
  MessageMagic,
  NetworkKind,
  PolicyAmount,
  SighashFamily,
  UnknownChainError,
} from './chain/types.js'

export { bigintToBytes, bytesToBigint, isIntegerError, mod } from './integer.js'
export type { IntegerError, IntegerResult } from './integer.js'

export {
  decodeScriptNum,
  encodeScriptNum,
  isMinimalScriptNum,
  isScriptNumError,
} from './script-num.js'
export type {
  ScriptNumDecodeOptions,
  ScriptNumError,
  ScriptNumResult,
} from './script-num.js'
