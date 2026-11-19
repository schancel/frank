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
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import { xecHtlcKeysOf, type XecHtlcKeys } from '@frank/wallet/ecash-wallet'
import { requireRelayOperatorCheckpoint } from './relay-wallet-route'
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

  const relayBaseUrl = loadMonadChainConfigFromEnv().relayBaseUrl
  let relayChain: RelayUtxoChain | undefined
  const opening = (async () => {
    // A Lotus v2 (regtest-only) wallet is bound to the block the relay checked its node against.
    const lotus = getChainRegistryEntry(chainIdentifier)?.kind === 'lotus'
    const checkpoint = lotus
      ? await requireRelayOperatorCheckpoint(relayBaseUrl, chainIdentifier)
      : undefined
    if (sessionScope() !== scope) throw new Error('Account changed')
    relayChain = openRelayUtxoChain({
      chainIdentifier,
      relayBaseUrl,
      checkpoint: checkpoint && {
        height: checkpoint.blockNumber,
        hash: checkpoint.blockHash,
      },
    })
    const wallet = await accountSession.createUtxoWallet(relayChain)
    if (sessionScope() !== scope) throw new Error('Account changed')
    return { chain: relayChain.chain, wallet }
  })()
  const close = async () => {
    await relayChain?.close()
  }
  const entry: Opened = { scope, opening, close }
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
    void close().catch(() => undefined)
  })
  return opening
}

/** The per-swap HTLC key capability of the account's wallet on an eCash chain. */
export async function openXecHtlcKeys(
  chainIdentifier: string,
): Promise<XecHtlcKeys> {
  const keys = xecHtlcKeysOf((await openUtxoWallet(chainIdentifier)).wallet)
  if (!keys) throw new Error('eCash HTLC keys are unavailable for this wallet')
  return keys
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
