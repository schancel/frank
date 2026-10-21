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
import { accountSession } from './session'

export interface OpenUtxoWallet {
  readonly chain: RelayUtxoChain['chain']
  readonly wallet: NativeWalletHandle
}

interface Opened {
  readonly scope: string
  readonly opening: Promise<OpenUtxoWallet>
  readonly close: () => Promise<void>
  /** Set once the wallet is open. */
  value?: OpenUtxoWallet
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
  if (existing?.scope === scope) return existing.opening
  // A wallet of an earlier account must not outlive it.
  if (existing) void existing.close().catch(() => undefined)

  const relayChain = openRelayUtxoChain({
    chainIdentifier,
    relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
  })
  const opening = (async () => {
    const wallet = await accountSession.createUtxoWallet(relayChain)
    if (sessionScope() !== scope) throw new Error('Account changed')
    return { chain: relayChain.chain, wallet }
  })()
  const entry: Opened = { scope, opening, close: () => relayChain.close() }
  opened.set(chainIdentifier, entry)
  opening.then(
    value => {
      entry.value = value
    },
    () => undefined,
  )
  // A failed open (relay unreachable) is retried by the next caller instead of being cached.
  opening.catch(() => {
    if (opened.get(chainIdentifier) === entry) opened.delete(chainIdentifier)
    void relayChain.close().catch(() => undefined)
  })
  return opening
}

/** The wallets of the current account that are already open. Opens nothing. */
export function peekOpenedUtxoWallets(): readonly OpenUtxoWallet[] {
  let scope: string
  try {
    scope = sessionScope()
  } catch {
    return []
  }
  return [...opened.values()].flatMap(entry =>
    entry.scope === scope && entry.value ? [entry.value] : [],
  )
}
