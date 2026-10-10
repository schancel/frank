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
 */
import {
  activeChain,
  getChainRegistryEntry,
  loadMonadChainConfigFromEnv,
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
  announceSolanaLegacyTransaction,
  swapRecordItemOf,
  trackSolanaSwap,
  type SolanaDexWallet,
  type SolanaLegacySender,
  type SolanaSwapObserver,
  type SolanaSwapOutcome,
  type SolanaSwapQuote,
  type SolanaSwapRecord,
  type SolanaSwapSender,
  type SolanaSwapTokenBalance,
  type SwapAsset,
} from '@frank/wallet/solana-swap'
import { createNativeTransferContext } from '../accounts/native-transfer'
import { accountSession } from '../accounts/session'
import {
  sendSolanaLegacySyncNote,
  solanaLegacyJournal,
} from '../accounts/solana-legacy'
import { useSwapStore, type SwapRecord } from '../stores/swaps'

export type {
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

/** One tracker per swap, however many times a screen asks to follow it. */
const tracking = new Map<string, Promise<SolanaSwapOutcome>>()

function follow(
  signature: string,
  start: () => Promise<SolanaSwapOutcome>,
): Promise<SolanaSwapOutcome> {
  const running = tracking.get(signature)
  if (running) return running
  const tracked = start().finally(() => tracking.delete(signature))
  tracking.set(signature, tracked)
  return tracked
}

async function solanaAccount(): Promise<string> {
  return (
    accountSession.getCachedChainAddress?.('solana') ??
    (await accountSession.getChainAddress('solana'))
  )
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
 * For the wallet page's activity list: whose swaps a Solana network's are, what an exchange is
 * called, and what a recorded swap did according to the chain. Undefined for a network that is
 * not Solana or lists no exchange.
 */
export function solanaSwapActivity(chainIdentifier: string):
  | {
      account(): Promise<string>
      venueName(venueId: string): string | undefined
      /**
       * `undefined`: the chain has nothing final to say yet. Throws
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
      if (!entry) {
        throw new SolanaSwapRecordMismatchError('no such exchange here')
      }
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
  quote(params: {
    inputMint: string
    outputMint: string
    amount: bigint
    slippageBps: number
  }): Promise<SolanaSwapQuote>
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
  const journal = solanaLegacyJournal()
  const unfinished = () =>
    journal
      .list()
      .filter(
        item =>
          item.record.account === owner &&
          item.record.chainIdentifier === chainIdentifier,
      )
  // Wallet open, for its legacy transactions: this device's own records go to the history at
  // once, unfinished ones are followed with their same bytes, owed notes are offered again.
  const legacyTransactionOutcome = (record: SolanaSwapRecord) =>
    follow(record.transactionId, () =>
      // Following needs no key: the journal has the signed bytes.
      trackSolanaSwap(chain, journal, record, {
        onSync: sendSolanaLegacySyncNote,
      }),
    )
  for (const item of unfinished()) {
    useSwapStore().handleSwapItem(swapRecordItemOf(item.record))
    if (item.settled) {
      void announceSolanaLegacyTransaction(
        journal,
        item.record,
        sendSolanaLegacySyncNote,
      )
    } else {
      // Fails only when the network cannot be asked; the entry stays and is followed again.
      void legacyTransactionOutcome(item.record).catch(() => undefined)
    }
  }

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
    quote: params => dex.quote({ owner: ownerKey, ...params }),
    execute(quote, assets, onSubmitted) {
      const outcome: Promise<SolanaSwapOutcome> = dex.execute(
        quote,
        assets,
        record => {
          // The wallet has journaled it: the history lists it from now on.
          useSwapStore().handleSwapItem(swapRecordItemOf(record))
          // This is the swap's one tracker; a screen that opens later joins it.
          tracking.set(
            record.transactionId,
            outcome.finally(() => tracking.delete(record.transactionId)),
          )
          onSubmitted(record)
        },
      )
      return outcome
    },
    pending: () => unfinished().find(item => !item.settled)?.record,
    resume: record => dex.readOutcome(record),
  }
}
