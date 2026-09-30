// @frank/nakamoto public surface. Browser-safe: no Node built-ins.
// Chain types, keys, and sighash land in later tickets. This entry stays free of
// the old library; tests may import it as a dev-only oracle.

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
} from './chain'
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
} from './chain'
