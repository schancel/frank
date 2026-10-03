import { accountSession } from '../accounts/session'
import { walletNotReadyError } from './wallet-not-ready'

/** All native Send/Receive and Forum consumers share the custody-owned wallet promise. */
export async function useActiveWallet() {
  try {
    return await accountSession.getWallet()
  } catch {
    throw walletNotReadyError('Account wallet is locked or unavailable')
  }
}
