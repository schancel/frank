import { accountSession } from '../accounts/session'
import { walletNotReadyError } from './wallet-not-ready'

/** All native Send/Receive and Forum consumers share the custody-owned wallet promise. */
export function useActiveWallet() {
  try {
    return accountSession.getWallet()
  } catch {
    throw walletNotReadyError('Account wallet is locked or unavailable')
  }
}
