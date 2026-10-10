/**
 * The Solana exchange interface, and one class per exchange.
 *
 * This is the SOLANA family's interface; EVM has its own (different transactions, approvals
 * and gas). Shared across families are only the shape of a `dex` list entry (venues.ts), the
 * fields of a swap's record (execute.ts `SolanaSwapRecord`) and the swap view's props (chain
 * identifier, wallet id, venue id).
 *
 * A class receives the wallet, typed as the narrow `SolanaDexWallet`: chain reads, and "sign
 * and send this legacy transaction" taking the transaction and the record of what it is for.
 * The wallet's send signs, records (durably and as the account's note to itself), broadcasts
 * and reports the outcome. An exchange class never records anything, never sends a note and
 * never sees a relay.
 *
 * What a swap goes through, the same for every exchange:
 * 1. `quote`: the exchange's own part (`prepare`: quote the exact input and build the
 *    transaction; on Solana these are one step, because an on-chain pool's expected output is
 *    what its swap delivers in simulation), then the safety check every transaction must pass
 *    whoever built it: simulate, and compare what it would do to the wallet with the quote
 *    (input debited no more than agreed, output credited at least the minimum, no other SOL or
 *    token leaves, no token account changes owner, delegate or close authority).
 * 2. `execute`: hands the transaction and its record to the wallet's legacy send, which runs
 *    the safety check again immediately before signing.
 * 3. `readOutcome`: the outcome of a swap sent earlier (after a reload); the amounts are read
 *    from the confirmed transaction's balance changes.
 */
import type {
  SolanaLegacySender,
  SolanaSwapOutcome,
  SolanaSwapRecord,
  SwapAsset,
} from './execute'
import {
  prepareJupiterSwap,
  prepareOrcaSwap,
  quoteSolanaSwap,
  type PrepareSolanaSwap,
  type SolanaSwapConnection,
  type SolanaSwapQuote,
  type SolanaSwapRequest,
} from './swap'
import type {
  JupiterVenue,
  OrcaWhirlpoolsVenue,
  SolanaSwapVenue,
} from './venues'

/** The wallet as an exchange class sees it. */
export interface SolanaDexWallet extends SolanaLegacySender {
  /** Reads of the wallet's chain. Cannot sign or submit. */
  readonly chain: SolanaSwapConnection
}

/** Things only some exchanges or tests need; none of them is a wallet or a relay. */
export interface SolanaDexOptions {
  /** For exchanges with an HTTP API. */
  readonly fetch?: typeof fetch
  readonly apiKey?: string
  readonly now?: () => number
}

export interface SolanaDex {
  readonly chainIdentifier: string
  /** Its `dex` list entry: id, display name, who maintains it, any interface fee. */
  readonly entry: SolanaSwapVenue
  /** One sentence for the user about how this exchange trades. */
  readonly description: string
  quote(
    request: Omit<SolanaSwapRequest, 'chainIdentifier'>,
  ): Promise<SolanaSwapQuote>
  execute(
    quote: SolanaSwapQuote,
    assets: { assetIn: SwapAsset; assetOut: SwapAsset },
    onSubmitted?: (record: SolanaSwapRecord) => void,
  ): Promise<SolanaSwapOutcome>
  readOutcome(record: SolanaSwapRecord): Promise<SolanaSwapOutcome>
}

abstract class SolanaDexBase<V extends SolanaSwapVenue> implements SolanaDex {
  abstract readonly description: string
  /** The exchange's own part: quote the exact input and build the transaction for it. */
  protected abstract readonly prepare: PrepareSolanaSwap<V>

  constructor(
    readonly chainIdentifier: string,
    readonly entry: V,
    protected readonly wallet: SolanaDexWallet,
    protected readonly options: SolanaDexOptions = {},
  ) {}

  quote(
    request: Omit<SolanaSwapRequest, 'chainIdentifier'>,
  ): Promise<SolanaSwapQuote> {
    return quoteSolanaSwap(
      {
        connection: this.wallet.chain,
        venue: this.entry,
        fetchImpl: this.options.fetch,
        jupiterApiKey: this.options.apiKey,
        now: this.options.now,
      },
      { ...request, chainIdentifier: this.chainIdentifier },
      this.prepare,
    )
  }

  async execute(
    quote: SolanaSwapQuote,
    assets: { assetIn: SwapAsset; assetOut: SwapAsset },
    onSubmitted?: (record: SolanaSwapRecord) => void,
  ): Promise<SolanaSwapOutcome> {
    // A quote this wallet cannot carry out (for example: not enough SOL) is not sent.
    if (quote.blocker) throw quote.blocker
    return this.wallet.sendLegacyTransaction(
      quote,
      {
        chainIdentifier: quote.chainIdentifier,
        venueId: quote.venueId,
        venueName: quote.venueName,
        route: quote.route.map(hop => hop.label).join(' → '),
        account: quote.owner,
        ...assets,
        amountIn: quote.inputAmount.toString(),
        quotedAmountOut: quote.expectedOutputAmount.toString(),
        minimumAmountOut: quote.minOutputAmount.toString(),
        interfaceFeeAmount: (quote.platformFee?.amount ?? 0n).toString(),
        networkFeeLamports: quote.networkFeeLamports.toString(),
        priorityFeeLamports: quote.priorityFeeLamports.toString(),
      },
      onSubmitted,
    )
  }

  readOutcome(record: SolanaSwapRecord): Promise<SolanaSwapOutcome> {
    return this.wallet.legacyTransactionOutcome(record)
  }
}

/** Orca Whirlpools: one on-chain pool per pair; the wallet builds the transaction. */
export class OrcaWhirlpoolsDex extends SolanaDexBase<OrcaWhirlpoolsVenue> {
  readonly description =
    'Orca Whirlpools: swaps directly against one on-chain pool. The wallet builds the transaction.'
  protected readonly prepare = prepareOrcaSwap
}

/** Jupiter: an aggregator; its API quotes and builds the transaction. */
export class JupiterDex extends SolanaDexBase<JupiterVenue> {
  readonly description =
    'Jupiter: an aggregator that routes across many pools. Its service builds the transaction, which the wallet checks before signing.'
  protected readonly prepare = prepareJupiterSwap
}

/** The exchange class for a `dex` entry, by its `adapter` key. */
export function createSolanaDex(
  chainIdentifier: string,
  entry: SolanaSwapVenue,
  wallet: SolanaDexWallet,
  options?: SolanaDexOptions,
): SolanaDex {
  switch (entry.adapter) {
    case 'orca-whirlpools':
      return new OrcaWhirlpoolsDex(chainIdentifier, entry, wallet, options)
    case 'jupiter':
      return new JupiterDex(chainIdentifier, entry, wallet, options)
  }
}
