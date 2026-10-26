/**
 * The account's wallet maintenance, outside any UI store: the user's reconcile pass and the
 * notice of wallet state an earlier build wrote under another name. Both are bound to the wallet
 * handle given (or the account's open wallet when asked), never to a later UI network change.
 */
import {
  earlierEvmWalletState,
  reconcileEvmWallet,
  type EarlierWalletState,
  type WalletReconcileProgress,
  type WalletReconcileSummary,
} from '@frank/wallet/chain/evm-chain'
import type { NativeWalletHandle } from '@frank/wallet/chain'
import { accountSession } from './session'

export type { WalletReconcileProgress, WalletReconcileSummary }

/** Runs the reconcile pass on the account's open wallet. Reads and records only. */
export function reconcileAccountWallet(
  onProgress?: (progress: WalletReconcileProgress) => void,
  wallet: NativeWalletHandle | undefined = accountSession.peekWallet(),
): Promise<WalletReconcileSummary> {
  if (!wallet) return Promise.reject(new Error('No account wallet is open'))
  return reconcileEvmWallet(wallet, onProgress)
}

/** Earlier-named state of this wallet that is still present, or undefined when there is none. */
export function earlierStateOf(
  wallet: NativeWalletHandle | undefined,
): EarlierWalletState | undefined {
  if (!wallet) return undefined
  const found = earlierEvmWalletState(wallet)
  return found && found.earlierLocations.length > 0 ? found : undefined
}
