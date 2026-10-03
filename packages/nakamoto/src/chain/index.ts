import { BCH_MAINNET, BCH_REGTEST, BCH_TESTNET } from './bch.js'
import { BTC_MAINNET, BTC_REGTEST, BTC_TESTNET } from './btc.js'
import { XEC_MAINNET, XEC_REGTEST, XEC_TESTNET } from './xec.js'
import { XPI_MAINNET, XPI_REGTEST, XPI_TESTNET } from './xpi.js'
import type {
  ChainDescriptor,
  ChainFamily,
  NetworkKind,
  UnknownChainError,
} from './types.js'

export {
  BCH_MAINNET,
  BCH_REGTEST,
  BCH_TESTNET,
  BTC_MAINNET,
  BTC_REGTEST,
  BTC_TESTNET,
  XEC_MAINNET,
  XEC_REGTEST,
  XEC_TESTNET,
  XPI_MAINNET,
  XPI_REGTEST,
  XPI_TESTNET,
}
export { addressVersionBytes } from './shared.js'
export type {
  ChainDescriptor,
  ChainFamily,
  DisplayUnit,
  HeaderShape,
  MessageMagic,
  NetworkKind,
  PolicyAmount,
  ProtocolIdentityProbe,
  ScriptRules,
  SighashFamily,
  UnknownChainError,
} from './types.js'

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

export function getChain(
  family: ChainFamily,
  network: NetworkKind,
): ChainDescriptor | UnknownChainError {
  for (const item of CHAINS) {
    if (item.family === family && item.network === network) return item
  }
  return { code: 'unknown-chain', family, network }
}

/** Structural check. Two copies of this package agree on `code`, not on a class. */
export function isUnknownChainError(
  value: unknown,
): value is UnknownChainError {
  if (typeof value !== 'object' || value === null) return false
  return (value as { code?: unknown }).code === 'unknown-chain'
}
