/**
 * Unified Account UTXO Pool (Issue #1184).
 *
 * Backwards compatibility re-export module.
 * The core engine has been elevated and generalized into ChainUtxoPool (chain-utxo-pool.ts)
 * supporting EVM, Solana, and UTXO-native (eCash / XEC, Bitcoin) chain families.
 */

export * from './chain-utxo-pool'
export { ChainUtxoPool as AccountUtxoPool } from './chain-utxo-pool'
export type { ChainUtxoCoin as AccountUtxo } from './chain-utxo-pool'
