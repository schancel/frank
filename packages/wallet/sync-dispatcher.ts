/**
 * Wallet sync dispatcher (Issue #1118).
 * Decouples message inbox sync dispatch from WalletHandle.
 *
 * Dispatches a generic WalletSyncItem across wallet sub-systems:
 * - Sub-account pool: marks spent sub-accounts to avoid multi-device desync
 * - HD address inventory: consumes nonces, records spends, updates branch balances
 * - Legacy UTXO storage: deletes spent outpoints, registers created outpoints
 */
export {
  applyWalletSyncItem,
  type WalletSyncDispatchResult,
} from "@frank/cashweb/sync-dispatcher";
