import { accountSession, accountStatus } from '../accounts/session'

/** Compatibility call-site name; custody now owns the one typed runtime wallet.
 * Messaging stays unavailable until the independently specified #696 cutover. */
export async function initializeMonadIdentity(): Promise<
  'started' | 'skipped'
> {
  await accountSession.initialize()
  return accountStatus.status === 'ready' ? 'started' : 'skipped'
}
