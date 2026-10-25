/** Why a network's wallet could not be opened, as an app-owned i18n key (never provider text). */
import { isChainUnreachableError } from '@frank/wallet/chain'
import { EvmRpcIdentityError } from './evm-wallet-verification'
import {
  RelayOperatorCheckpointUnavailableError,
  RelayWalletRouteUnavailableError,
} from './relay-wallet-route'

export type WalletOpenFailureKey =
  | 'sendAddressDialog.walletCheckpointUnavailable'
  | 'sendAddressDialog.walletIdentityUnverified'
  | 'sendAddressDialog.walletRouteUnavailable'
  | 'sendAddressDialog.walletUnreachable'
  | 'sendAddressDialog.walletOpenFailed'

export function walletOpenFailureKey(error: unknown): WalletOpenFailureKey {
  if (error instanceof RelayOperatorCheckpointUnavailableError)
    return 'sendAddressDialog.walletCheckpointUnavailable'
  if (error instanceof EvmRpcIdentityError)
    return 'sendAddressDialog.walletIdentityUnverified'
  if (error instanceof RelayWalletRouteUnavailableError)
    return 'sendAddressDialog.walletRouteUnavailable'
  if (isChainUnreachableError(error))
    return 'sendAddressDialog.walletUnreachable'
  return 'sendAddressDialog.walletOpenFailed'
}
