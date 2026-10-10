/**
 * App composition for the Solana swap: picks the network and exchange, talks to Solana through
 * the relay's RPC proxy, and hands the swap to the Solana wallet. No swap logic lives here; see
 * `@frank/wallet/solana-swap`.
 *
 * A session is bound to the network, exchange and account it was opened for. Changing the
 * selected network afterwards does not redirect a quote or a swap already in flight.
 *
 * Nothing about a swap is kept here. The wallet journals the signed transaction with its record
 * before broadcasting and, once the chain has finalised it, raises its sync event, which
 * `src/accounts/solana-legacy` sends as the account's free note to itself. The swap history
 * (`src/stores/swaps`) is the fold of those notes; this device's journal supplies its own
 * records to it at once.
 *
 * A swap interrupted by a reload is finished by `resumeSolanaSwaps`, which runs when the
 * account opens (`src/utils/monad-identity-session`), not when a swap screen does.
 */
import {
  activeChain,
  getChainRegistryEntry,
  loadMonadChainConfigFromEnv,
  PROTOCOL_CHAINS,
} from '@frank/wallet/chain'
import { getSolanaRpcUrls } from '@frank/wallet/chain/solana-balance'
import {
  createSolanaDex,
  fetchSwapTokenBalances,
  getSolanaSwapVenue,
  getSolanaSwapVenues,
  listSolanaDexEntries,
  observeSolanaSwapRecord,
  SolanaLegacyJournalUnreadableError,
  SolanaSwapError,
  SolanaSwapRecordMismatchError,
  SolanaSwapStillPendingError,
  resumeSolanaLegacyTransactions,
  swapRecordItemOf,
  trackSolanaSwap,
  type SolanaDexWallet,
  type SolanaLegacySender,
  type SolanaQuoteCycle,
  type SolanaSwapObserver,
  type SolanaSwapOutcome,
  type SolanaSwapQuote,
  type SolanaSwapRecord,
  type SolanaSwapSender,
  type SolanaSwapTokenBalance,
  type SwapAsset,
} from '@frank/wallet/solana-swap'
import { createNativeTransferContext } from '../accounts/native-transfer'
import {
  currentSolanaAccount as solanaAccount,
  sendSolanaLegacySyncNote,
  solanaLegacyJournal,
} from '../accounts/solana-legacy'
import { useSwapStore, type SwapRecord } from '../stores/swaps'

export type {
  SolanaQuoteCycle,
  SolanaSwapOutcome,
  SolanaSwapQuote,
  SolanaSwapRecord,
  SolanaSwapTokenBalance,
  SwapAsset,
}
export {
  SolanaLegacyJournalUnreadableError as PendingSwapsUnreadableError,
  SolanaSwapError,
  SolanaSwapStillPendingError,
}

async function connect(chainIdentifier: 'solana-devnet' | 'solana-mainnet') {
  const { Connection, PublicKey } = await import('@solana/web3.js')
  const [rpcUrl] = getSolanaRpcUrls({
    networkId: chainIdentifier,
    relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
  })
  return { connection: new Connection(rpcUrl, 'confirmed'), PublicKey }
}

/** The Solana networks the wallet's adapter is built for; the registry decides the rest. */
const isSolanaNetwork = (
  chainIdentifier: string,
): chainIdentifier is 'solana-devnet' | 'solana-mainnet' =>
  getChainRegistryEntry(chainIdentifier)?.family === 'solana' &&
  (chainIdentifier === 'solana-devnet' || chainIdentifier === 'solana-mainnet')

/**
 * When the account opens: the Solana wallet's unfinished legacy transactions are followed to
 * their outcome with their same signed bytes, and notes still owed are offered again, on every
 * Solana network that lists an exchange. This device's own records go to the swap history at
 * once. With nothing journaled this reads local storage and asks the network nothing.
 * Throws when a journal cannot be read (that is not "nothing pending").
 */
export async function resumeSolanaSwaps(): Promise<void> {
  const account = await solanaAccount()
  for (const chainIdentifier of Object.keys(PROTOCOL_CHAINS)) {
    if (
      !isSolanaNetwork(chainIdentifier) ||
      listSolanaDexEntries(chainIdentifier).length === 0
    )
      continue
    const journal = solanaLegacyJournal(account, chainIdentifier)
    const entries = journal.list()
    if (entries.length === 0) continue
    for (const entry of entries) {
      useSwapStore().handleSwapItem(swapRecordItemOf(entry.record))
    }
    const { connection } = await connect(chainIdentifier)
    // Following needs no key: the journal has the signed bytes.
    resumeSolanaLegacyTransactions(
      connection as unknown as SolanaSwapSender,
      journal,
      { onSync: sendSolanaLegacySyncNote },
    )
  }
}

/**
 * For the wallet page's activity list: whose swaps a Solana network's are, what an exchange is
 * called, and what a recorded swap did according to the chain. Undefined for a network that is
 * not Solana or lists no exchange.
 */
export function solanaSwapActivity(chainIdentifier: string):
  | {
      account(): Promise<string>
      venueName(venueId: string): string | undefined
      /**
       * `undefined`: nothing final can be said yet (the chain does not show it, or this build
       * does not list the record's exchange). Throws
       * `SolanaSwapRecordMismatchError` when the record is not this account's swap.
       */
      observe(
        record: SwapRecord,
      ): Promise<
        | { status: 'confirmed'; amountOut: bigint; fee: bigint }
        | { status: 'failed'; fee: bigint }
        | undefined
      >
    }
  | undefined {
  const entries = listSolanaDexEntries(chainIdentifier)
  if (!isSolanaNetwork(chainIdentifier) || entries.length === 0)
    return undefined
  return {
    account: solanaAccount,
    venueName: venueId =>
      entries.find(entry => entry.id === venueId)?.displayName,
    async observe(record) {
      const entry = entries.find(candidate => candidate.id === record.venueId)
      // An exchange this build does not list (one added later, say) decides nothing about
      // the record: it is unknown, not somebody else's, and nothing is remembered against it.
      if (!entry) return undefined
      const { connection } = await connect(chainIdentifier)
      const seen = await observeSolanaSwapRecord(
        connection as unknown as SolanaSwapObserver,
        record,
        entry.programId,
      )
      if (seen.status === 'confirmed') {
        return {
          status: 'confirmed',
          amountOut: seen.receivedAmount,
          fee: seen.networkFeeLamports,
        }
      }
      return seen.status === 'failed'
        ? { status: 'failed', fee: seen.networkFeeLamports }
        : undefined
    },
  }
}
export { SolanaSwapRecordMismatchError }

export interface SolanaSwapSession {
  readonly chainIdentifier: string
  /** The network's display name, e.g. "Solana Devnet". */
  readonly networkName: string
  readonly isTestnet: boolean
  readonly venueId: string
  readonly venueName: string
  /** One sentence about how this venue trades. */
  readonly venueDescription: string
  readonly owner: string
  /** Balances of the venue's tokens for this wallet, read from the chain. */
  loadTokens(): Promise<SolanaSwapTokenBalance[]>
  /** `cycle`: one object for all the quotes of the same input, a new one when it changes. */
  quote(
    params: {
      inputMint: string
      outputMint: string
      amount: bigint
      slippageBps: number
    },
    cycle?: SolanaQuoteCycle,
  ): Promise<SolanaSwapQuote>
  /** Signs, records, sends and follows the swap to a definite outcome. */
  execute(
    quote: SolanaSwapQuote,
    assets: { assetIn: SwapAsset; assetOut: SwapAsset },
    onSubmitted: (record: SolanaSwapRecord) => void,
  ): Promise<SolanaSwapOutcome>
  /** A swap of this wallet that was sent earlier and is not yet final, from its journal. */
  pending(): SolanaSwapRecord | undefined
  resume(record: SolanaSwapRecord): Promise<SolanaSwapOutcome>
}

/** The Solana network the app is on: devnet with the testnet setting, mainnet otherwise. */
export function activeSolanaChainIdentifier(): string {
  return activeChain.isTestnet ? 'solana-devnet' : 'solana-mainnet'
}

/**
 * The enabled Solana exchanges of a network for the shared swap view, in the shape its venue list takes
 * (`id`, `label`, `panelProps`); the view adds the panel component. Empty: no swap there.
 */
export function solanaSwapVenuePresentations(
  chainIdentifier: string,
  walletId: string,
): {
  id: string
  label: string
  panelProps: { chainIdentifier: string; walletId: string; venueId: string }
}[] {
  return getSolanaSwapVenues(chainIdentifier).map(venue => ({
    id: venue.id,
    label: venue.displayName,
    panelProps: { chainIdentifier, walletId, venueId: venue.id },
  }))
}

/**
 * Opens a swap session on one exchange of a Solana network (the network's default when none is
 * named), or returns undefined when that network offers no such exchange.
 */
export async function openSolanaSwapSession(
  chainIdentifier: string = activeSolanaChainIdentifier(),
  venueId?: string,
): Promise<SolanaSwapSession | undefined> {
  const venue = getSolanaSwapVenue(chainIdentifier, venueId)
  const entry = getChainRegistryEntry(chainIdentifier)
  if (!venue || !entry || !isSolanaNetwork(chainIdentifier)) return undefined
  const [{ connection, PublicKey }, owner] = await Promise.all([
    connect(chainIdentifier),
    solanaAccount(),
  ])
  const ownerKey = new PublicKey(owner)
  const chain = connection as unknown as SolanaDexWallet['chain'] &
    SolanaSwapSender
  const journal = solanaLegacyJournal(owner, chainIdentifier)
  // The account-open resume has normally done this already; a swap screen opened first (or
  // after a failed read) does it too. It follows nothing twice.
  await resumeSolanaSwaps()
  const legacyTransactionOutcome = (record: SolanaSwapRecord) =>
    // Joins the transaction's one follower, or starts it. Needs no key.
    trackSolanaSwap(chain, journal, record, {
      onSync: sendSolanaLegacySyncNote,
    })

  // The wallet as an exchange sees it: chain reads, and its legacy send. Custody is opened
  // only when a swap is confirmed, for the reviewed network, and re-checked before signing.
  const wallet: SolanaDexWallet = {
    chain,
    async sendLegacyTransaction(prepared, intent, onSubmitted) {
      const context = await createNativeTransferContext(chainIdentifier)
      const binding = await context.captureWallet()
      await binding.assertCurrent()
      const solana = binding.wallet as unknown as Partial<SolanaLegacySender>
      if (typeof solana.sendLegacyTransaction !== 'function') {
        throw new Error('This wallet cannot send Solana program calls')
      }
      return solana.sendLegacyTransaction(prepared, intent, onSubmitted)
    },
    legacyTransactionOutcome,
  }
  // Composition: the exchange class named by the entry's `adapter`.
  const dex = createSolanaDex(chainIdentifier, venue, wallet)

  return {
    chainIdentifier,
    networkName: entry.name,
    isTestnet: entry.isTestnet,
    venueId: venue.id,
    venueName: venue.displayName,
    venueDescription: dex.description,
    owner,
    loadTokens: () =>
      fetchSwapTokenBalances(connection, ownerKey, venue.tokens),
    quote: (params, cycle) => dex.quote({ owner: ownerKey, ...params }, cycle),
    execute(quote, assets, onSubmitted) {
      const outcome: Promise<SolanaSwapOutcome> = dex.execute(
        quote,
        assets,
        record => {
          // The wallet has journaled it: the history lists it from now on.
          useSwapStore().handleSwapItem(swapRecordItemOf(record))
          onSubmitted(record)
        },
      )
      return outcome
    },
    pending: () => journal.list().find(item => !item.settled)?.record,
    resume: record => dex.readOutcome(record),
  }
}
