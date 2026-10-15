/**
 * The session's Bitcoin-family wallets (eCash, Bitcoin, Bitcoin Cash), opened through the relay.
 *
 * One wallet per chain for the current account, shared by the balance reader, the Wallet page's
 * receive address and Send, so they agree and a send interrupted earlier is finished once.
 * Session custody constructs the wallet and privately supplies its signing capabilities.
 */
import {
  loadMonadChainConfigFromEnv,
  openRelayUtxoChain,
  type NativeWalletHandle,
  type RelayUtxoChain,
} from '@frank/wallet/chain'
import { createBrowserEcashOperationStore } from '@frank/wallet/storage/ecash-operations/browser'
import { accountSession } from './session'

export interface OpenUtxoWallet {
  readonly chain: RelayUtxoChain['chain']
  readonly wallet: NativeWalletHandle
}

interface Opened {
  readonly assertActive: () => void
  readonly scope: string
  readonly opening: Promise<OpenUtxoWallet>
  readonly close: () => Promise<void>
}

const opened = new Map<string, Opened>()

function sessionScope(): string {
  const { status, account, revision } = accountSession.state
  if (status !== 'ready' || !account) throw new Error('No account is open')
  return `${account.receipt.context.accountId}:${revision}`
}

/** Opens (once per account) the wallet for a canonical Bitcoin-family chain identifier. */
export function openUtxoWallet(
  chainIdentifier: string,
): Promise<OpenUtxoWallet> {
  const scope = sessionScope()
  const existing = opened.get(chainIdentifier)
  if (existing?.scope === scope) {
    try {
      existing.assertActive()
      return existing.opening
    } catch {
      opened.delete(chainIdentifier)
    }
  }
  // A wallet of an earlier account must not outlive it.
  const previousClosing = existing?.close()

  const relayChain = openRelayUtxoChain({
    chainIdentifier,
    relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
    operationStoreFactory: binding =>
      createBrowserEcashOperationStore({
        ...binding,
        namespace: 'local-account-v1',
      }),
  })
  const opening = (async () => {
    try {
      if (previousClosing) await previousClosing
      relayChain.assertActive?.()
      const wallet = await accountSession.createUtxoWallet(relayChain)
      relayChain.assertActive?.()
      if (sessionScope() !== scope) throw new Error('Account changed')
      return { chain: relayChain.chain, wallet }
    } catch (error) {
      try {
        await relayChain.close()
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'UTXO cache opening and cleanup failed',
        )
      }
      throw error
    }
  })()
  const entry: Opened = {
    scope,
    opening,
    assertActive: () => relayChain.assertActive?.(),
    close: () => relayChain.close(),
  }
  opened.set(chainIdentifier, entry)
  // A failed open (relay unreachable) is retried by the next caller instead of being cached.
  opening.catch(() => {
    if (opened.get(chainIdentifier) === entry) opened.delete(chainIdentifier)
  })
  return opening
}
