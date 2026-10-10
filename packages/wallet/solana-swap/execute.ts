/**
 * Send a prepared swap and follow it to a definite end.
 *
 * A signed Solana transaction can land until its blockhash expires, whatever the sender saw.
 * So the signed transaction and its last valid block height are stored BEFORE it is sent, and
 * the only ways a swap ends are:
 * - confirmed: the amounts are read from the transaction's own balance changes;
 * - failed: the chain FINALIZED the transaction with an error (nothing swapped, fee paid).
 *   An error seen at a weaker commitment is not final: that fork can be dropped and the same
 *   transaction can still succeed, so it stays pending;
 * - expired: finalized block height passed the last valid height and the chain still has no
 *   record of the signature, on several separate checks (the relay rotates between RPC nodes,
 *   so one node's height and another's status are not proof together).
 * Until one of those, the same signed bytes may be re-sent (that cannot swap twice), but a
 * NEW swap must not be built in its place.
 *
 * The outcome is written to the wallet's journal at the moment it is decided, and announced by
 * the wallet's sync event; no screen has to be open for either.
 */
import type { VersionedTransaction } from '@solana/web3.js'

import type { SwapRecordItem } from '@frank/cashweb/types/messages'

import { swapRecordId } from '../chain/evm-legacy-consolidator'
import { SolanaSwapError } from './swap'
import { NATIVE_SOL_MINT } from './venues'

/** One side of a swap. `address` is the token's mint; null is SOL, the chain's native coin. */
export interface SwapAsset {
  readonly symbol: string
  readonly address: string | null
  readonly decimals: number
}

/**
 * The record of one swap, made when its transaction is signed. The fields are the ones every
 * chain family records (the EVM `SwapTransactionRecord` has the same names): where, on which
 * exchange, which transaction, what goes in, what was quoted and the least that may come out,
 * and the fees. What the swap then did is read from the chain by the transaction id; it is not
 * part of the record. Amounts are base units as decimal strings, because the record is stored
 * and sent as data.
 */
export interface SolanaSwapRecord {
  readonly chainIdentifier: string
  readonly venueId: string
  /** The exchange and route as shown to the user. */
  readonly venueName: string
  readonly route: string
  /** The transaction signature. */
  readonly transactionId: string
  readonly account: string
  readonly assetIn: SwapAsset
  readonly amountIn: string
  readonly assetOut: SwapAsset
  readonly quotedAmountOut: string
  readonly minimumAmountOut: string
  /** Frank's fee, in the asset it is taken in; zero when the exchange has none. */
  readonly interfaceFeeAmount: string
  /** The network fee the transaction is charged, in lamports. */
  readonly networkFeeLamports: string
  readonly signedAtMs: number
  /** What the wallet needs to finish this exact swap: its signed bytes and their lifetime. */
  readonly recovery: {
    /** Base64 signed transaction. */
    readonly signedTransaction: string
    readonly lastValidBlockHeight: string
  }
}

/** What the caller knows about a swap before it is signed. */
export type SolanaSwapIntent = Omit<
  SolanaSwapRecord,
  'transactionId' | 'signedAtMs' | 'recovery'
>

/** A transaction ready to sign, with the check to run immediately before signing. */
export interface PreparedLegacyTransaction {
  readonly transaction: VersionedTransaction
  readonly lastValidBlockHeight: bigint
  /** Simulates again and re-applies the safety check; throws when it must not be signed. */
  readonly recheck: () => Promise<void>
}

/** What a confirmed swap actually did to the wallet, from the transaction itself. */
export interface ObservedSwap {
  readonly receivedAmount: bigint
  readonly spentAmount: bigint
  readonly networkFeeLamports: bigint
  /** Rent now held by token accounts this swap opened for the wallet. */
  readonly accountRentLamports: bigint
}

export type SolanaSwapOutcome =
  | ({
      readonly status: 'confirmed'
      readonly signature: string
      readonly finalized: boolean
    } & ObservedSwap)
  | {
      readonly status: 'failed'
      readonly signature: string
      readonly reason: string
      readonly networkFeeLamports: bigint
    }
  | { readonly status: 'expired'; readonly signature: string }

/** One transaction the wallet signed and has not finished with. */
export interface SolanaLegacyJournalEntry {
  readonly record: SolanaSwapRecord
  /**
   * Set once the chain gave its final answer. The entry is then kept only until the account's
   * note to itself about it has been sent.
   */
  readonly settled?: 'confirmed' | 'failed'
}

/**
 * The wallet's durable record of the legacy transactions it signed, keyed by signature: the
 * signed bytes and what the transaction is for, written BEFORE it is broadcast, so the same
 * bytes can be followed and re-sent after a restart. An entry leaves when its transaction
 * expired unseen, or when it is final and its note to self has been sent.
 *
 * `list` must throw when the stored data cannot be read: an unreadable journal is not "nothing
 * pending". `put` must not return until the entry is durable.
 */
export interface SolanaLegacyJournal {
  list(): SolanaLegacyJournalEntry[]
  put(record: SolanaSwapRecord): void
  settle(transactionId: string, status: 'confirmed' | 'failed'): void
  remove(transactionId: string): void
}

/**
 * The wallet's sync event for a legacy transaction the chain has finalised: the record of what
 * it was, for the account's other frontends. Composition sends it as the account's free note
 * to itself. Resolves when the note is accepted; a rejection leaves it owed and it is offered
 * again when the wallet next opens.
 */
export type SolanaLegacySync = (item: SwapRecordItem) => Promise<void>

/** The `swap-record` item for a signed swap. Its id is derived, the same on every frontend. */
export function swapRecordItemOf(record: SolanaSwapRecord): SwapRecordItem {
  const asset = (value: SwapAsset) => ({
    symbol: value.symbol,
    decimals: value.decimals,
    ...(value.address === null ? {} : { address: value.address }),
  })
  return {
    type: 'swap-record',
    swapId: swapRecordId(record.chainIdentifier, record.transactionId),
    chainIdentifier: record.chainIdentifier,
    venueId: record.venueId,
    txHash: record.transactionId,
    account: record.account,
    assetIn: asset(record.assetIn),
    amountIn: record.amountIn,
    assetOut: asset(record.assetOut),
    quotedAmountOut: record.quotedAmountOut,
    minimumAmountOut: record.minimumAmountOut,
    interfaceFee: record.interfaceFeeAmount,
    networkFee: record.networkFeeLamports,
    route: JSON.stringify({ label: record.route }),
    timestamp: record.signedAtMs,
  }
}

interface TokenBalanceEntry {
  readonly accountIndex: number
  readonly mint: string
  readonly owner?: string
  readonly uiTokenAmount: { readonly amount: string }
}

export interface SwapTransactionMeta {
  readonly err: unknown
  readonly fee: bigint | number
  readonly preBalances: readonly (bigint | number)[]
  readonly postBalances: readonly (bigint | number)[]
  readonly preTokenBalances?: readonly TokenBalanceEntry[] | null
  readonly postTokenBalances?: readonly TokenBalanceEntry[] | null
}

/** The RPC calls needed to send and follow a swap. A web3.js `Connection` satisfies it. */
export interface SolanaSwapSender {
  sendRawTransaction(
    rawTransaction: Uint8Array,
    options?: { skipPreflight?: boolean; maxRetries?: number },
  ): Promise<string>
  getSignatureStatuses(
    signatures: string[],
    config: { searchTransactionHistory: boolean },
  ): Promise<{
    value: ({
      err: unknown
      confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null
    } | null)[]
  }>
  getBlockHeight(commitment: 'finalized'): Promise<bigint | number>
  getTransaction(
    signature: string,
    config: { commitment: 'confirmed'; maxSupportedTransactionVersion: 0 },
  ): Promise<{ meta: SwapTransactionMeta | null } | null>
}

/** Signs with the wallet's own key; implemented by `SolanaWallet.signSwapTransaction`. */
export interface SolanaSwapSigner {
  readonly address: string
  readonly chainIdentifier: string
  signSwapTransaction(
    transaction: VersionedTransaction,
    lastValidBlockHeight: bigint,
  ): Promise<{ signature: string; rawTransaction: Uint8Array }>
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

/**
 * What a confirmed swap transaction did to the wallet: received, spent, fee and rent, all from
 * its balance changes. The wallet is the fee payer, so it is account 0.
 */
export function observeSwapTransaction(
  meta: SwapTransactionMeta,
  owner: string,
  inputMint: string,
  outputMint: string,
): ObservedSwap {
  const mine = (entries?: readonly TokenBalanceEntry[] | null) =>
    (entries ?? []).filter(entry => entry.owner === owner)
  const before = mine(meta.preTokenBalances)
  const after = mine(meta.postTokenBalances)
  const tokens = (entries: readonly TokenBalanceEntry[], mint: string) =>
    entries
      .filter(entry => entry.mint === mint)
      .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n)
  const fee = BigInt(meta.fee)
  // Token accounts the wallet has now and did not have before: their rent came from it.
  const rent = after
    .filter(entry => BigInt(meta.preBalances[entry.accountIndex]) === 0n)
    .reduce(
      (sum, entry) => sum + BigInt(meta.postBalances[entry.accountIndex]),
      0n,
    )
  // Lamports a wrapped-SOL account of the wallet's own already held (an aggregator may close
  // it into the wallet); they are not proceeds of the swap.
  const alreadyWrapped = before
    .filter(entry => entry.mint === NATIVE_SOL_MINT)
    .reduce(
      (sum, entry) => sum + BigInt(meta.preBalances[entry.accountIndex]),
      0n,
    )
  // The wallet's SOL change from the swap alone, with fee and rent taken back out.
  const solGained =
    BigInt(meta.postBalances[0]) -
    BigInt(meta.preBalances[0]) +
    fee +
    rent -
    alreadyWrapped
  return {
    receivedAmount:
      outputMint === NATIVE_SOL_MINT
        ? solGained
        : tokens(after, outputMint) - tokens(before, outputMint),
    spentAmount:
      inputMint === NATIVE_SOL_MINT
        ? -solGained
        : tokens(before, inputMint) - tokens(after, inputMint),
    networkFeeLamports: fee,
    accountRentLamports: rent,
  }
}

/** The chain says the recorded transaction is not this account's swap on this exchange. */
export class SolanaSwapRecordMismatchError extends Error {
  constructor(why: string) {
    super(`Not this account's swap: ${why}`)
    this.name = 'SolanaSwapRecordMismatchError'
  }
}

/** The read a record's display needs. A web3.js `Connection` satisfies it. */
export interface SolanaSwapObserver {
  getTransaction(
    signature: string,
    config: { commitment: 'finalized'; maxSupportedTransactionVersion: 0 },
  ): Promise<{
    meta: SwapTransactionMeta | null
    transaction: {
      message: {
        staticAccountKeys: readonly { toBase58(): string }[]
        compiledInstructions: readonly { programIdIndex: number }[]
      }
    }
  } | null>
}

/**
 * What a recorded swap did, for display: read from the finalized transaction, never taken from
 * the record. A record is somebody's claim (it arrives in a note), so it is shown as this
 * account's only if the chain agrees: the transaction was paid for and signed by the record's
 * account and called the exchange's program. Otherwise `SolanaSwapRecordMismatchError`, which
 * is definitive. `unknown` (not finalized yet, or never landed) and a failing read are not:
 * ask again later.
 */
export async function observeSolanaSwapRecord(
  connection: SolanaSwapObserver,
  record: {
    txHash: string
    account: string
    assetIn: { address?: string | null }
    assetOut: { address?: string | null }
  },
  programId: string,
): Promise<
  | ({ status: 'confirmed' } & ObservedSwap)
  | { status: 'failed'; networkFeeLamports: bigint }
  | { status: 'unknown' }
> {
  const found = await connection.getTransaction(record.txHash, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  })
  if (!found?.meta) return { status: 'unknown' }
  const { staticAccountKeys, compiledInstructions } = found.transaction.message
  if (staticAccountKeys[0]?.toBase58() !== record.account) {
    throw new SolanaSwapRecordMismatchError('another account paid for it')
  }
  if (
    !compiledInstructions.some(
      instruction =>
        staticAccountKeys[instruction.programIdIndex]?.toBase58() === programId,
    )
  ) {
    throw new SolanaSwapRecordMismatchError('it did not call the exchange')
  }
  if (found.meta.err) {
    return { status: 'failed', networkFeeLamports: BigInt(found.meta.fee) }
  }
  return {
    status: 'confirmed',
    ...observeSwapTransaction(
      found.meta,
      record.account,
      record.assetIn.address ?? NATIVE_SOL_MINT,
      record.assetOut.address ?? NATIVE_SOL_MINT,
    ),
  }
}

const mintOf = (asset: SwapAsset) => asset.address ?? NATIVE_SOL_MINT

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms))

/** Separate checks, each finding the height passed and the signature unknown, before expiry. */
const EXPIRY_CONFIRMATIONS = 3
/** The signed bytes are re-sent on every this-many-th poll while the chain has not seen them. */
const RESEND_EVERY_POLLS = 5

export interface TrackOptions {
  /** The wallet's sync event; without one nothing is announced and entries leave when final. */
  readonly onSync?: SolanaLegacySync
  readonly pollIntervalMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  /** Consecutive RPC failures tolerated before giving up for now (the swap stays pending). */
  readonly maxRpcFailures?: number
}

/** Thrown when the network could not be asked; the swap is still pending, not failed. */
export class SolanaSwapStillPendingError extends Error {
  constructor(readonly record: SolanaSwapRecord, readonly reason: unknown) {
    super('Swap status could not be checked; it is still pending')
    this.name = 'SolanaSwapStillPendingError'
  }
}

/**
 * Follows a stored swap to confirmed, failed or expired, re-sending the same signed bytes while
 * it can still land. The journal keeps the transaction until its outcome is definite and, when
 * it reached the chain, until the wallet's sync event for it has been delivered.
 */
export async function trackSolanaSwap(
  connection: SolanaSwapSender,
  journal: SolanaLegacyJournal,
  swap: SolanaSwapRecord,
  options: TrackOptions = {},
): Promise<SolanaSwapOutcome> {
  const signature = swap.transactionId
  const sleep = options.sleep ?? defaultSleep
  const interval = options.pollIntervalMs ?? 2000
  const maxFailures = options.maxRpcFailures ?? 10
  const raw = decodeBase64(swap.recovery.signedTransaction)
  const lastValid = BigInt(swap.recovery.lastValidBlockHeight)
  const finish = async (outcome: SolanaSwapOutcome) => {
    if (outcome.status === 'expired') {
      // It never reached the chain: there is nothing to tell anyone.
      journal.remove(signature)
    } else {
      journal.settle(signature, outcome.status)
      await announceSolanaLegacyTransaction(journal, swap, options.onSync)
    }
    return outcome
  }
  const transactionMeta = async () =>
    (
      await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
    )?.meta

  let failures = 0
  let expiredChecks = 0
  for (let poll = 0; ; poll++) {
    try {
      const current = (
        await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
      ).value[0]
      if (current === null) {
        const height = BigInt(await connection.getBlockHeight('finalized'))
        if (height > lastValid) {
          if (++expiredChecks >= EXPIRY_CONFIRMATIONS) {
            return finish({ status: 'expired', signature: signature })
          }
        } else {
          expiredChecks = 0
          if (poll % RESEND_EVERY_POLLS === 0) {
            // Not seen yet and still valid: sending the same signed bytes again is harmless.
            await connection
              .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
              .catch(() => undefined)
          }
        }
      } else {
        expiredChecks = 0
        const finalized = current.confirmationStatus === 'finalized'
        if (current.err) {
          // Only a finalized failure is a failure; before that the fork may be dropped.
          if (finalized) {
            const meta = await transactionMeta()
            return finish({
              status: 'failed',
              signature: signature,
              reason: JSON.stringify(current.err),
              networkFeeLamports: BigInt(meta?.fee ?? swap.networkFeeLamports),
            })
          }
        } else if (finalized || current.confirmationStatus === 'confirmed') {
          const meta = await transactionMeta()
          if (meta) {
            return finish({
              status: 'confirmed',
              signature: signature,
              finalized,
              ...observeSwapTransaction(
                meta,
                swap.account,
                mintOf(swap.assetIn),
                mintOf(swap.assetOut),
              ),
            })
          }
        }
      }
      failures = 0
    } catch (error) {
      if (++failures >= maxFailures) {
        throw new SolanaSwapStillPendingError(swap, error)
      }
    }
    await sleep(interval)
  }
}

/**
 * Delivers the sync event of a settled transaction and, once delivered, drops its journal
 * entry. Never throws: an undelivered event stays owed in the journal.
 */
export async function announceSolanaLegacyTransaction(
  journal: SolanaLegacyJournal,
  record: SolanaSwapRecord,
  onSync: SolanaLegacySync | undefined,
): Promise<void> {
  try {
    await onSync?.(swapRecordItemOf(record))
    journal.remove(record.transactionId)
  } catch {
    // Owed: offered again by `resumeSolanaLegacyTransactions`.
  }
}

/**
 * At wallet open: follows every journaled transaction that is not final yet (with its same
 * signed bytes) and offers again the sync events still owed. Needs no key. Returns at once;
 * the work continues in the background and reports through the journal and `onSync`.
 */
export function resumeSolanaLegacyTransactions(
  connection: SolanaSwapSender,
  journal: SolanaLegacyJournal,
  options: TrackOptions = {},
  following: Set<string> = resuming,
): void {
  for (const entry of journal.list()) {
    const id = entry.record.transactionId
    if (following.has(id)) continue
    following.add(id)
    const work = entry.settled
      ? announceSolanaLegacyTransaction(journal, entry.record, options.onSync)
      : trackSolanaSwap(connection, journal, entry.record, options)
    void work.then(
      () => following.delete(id),
      () => following.delete(id),
    )
  }
}
/** Transactions already being followed in this realm, so a second open does not double up. */
const resuming = new Set<string>()

/**
 * The wallet's legacy send, for a transaction that calls a program rather than paying another
 * Frank user: check, sign, record, send, and follow to its outcome. The record is an argument
 * of the send; whoever asked for the transaction never records it or talks to a relay.
 */
export interface SolanaLegacySender {
  /** `onSubmitted` fires once the signed transaction is recorded and handed to the network. */
  sendLegacyTransaction(
    prepared: PreparedLegacyTransaction,
    intent: SolanaSwapIntent,
    onSubmitted?: (record: SolanaSwapRecord) => void,
  ): Promise<SolanaSwapOutcome>
  /** Follows one sent earlier (for example before a reload) to its outcome. */
  legacyTransactionOutcome(record: SolanaSwapRecord): Promise<SolanaSwapOutcome>
}

export function createSolanaLegacySender(parts: {
  connection: SolanaSwapSender
  /** Opens the signing key only when a transaction is actually sent. */
  signer: () => Promise<SolanaSwapSigner>
  journal: SolanaLegacyJournal
  track?: TrackOptions
  now?: () => number
}): SolanaLegacySender {
  const { connection, journal } = parts
  return {
    async sendLegacyTransaction(prepared, intent, onSubmitted) {
      const wallet = await parts.signer()
      if (
        wallet.address !== intent.account ||
        wallet.chainIdentifier !== intent.chainIdentifier
      ) {
        throw new SolanaSwapError(
          'invalid-request',
          'transaction belongs to a different wallet or network',
        )
      }
      if (
        journal
          .list()
          .some(
            entry => !entry.settled && entry.record.account === intent.account,
          )
      ) {
        // An earlier one may still land; resolve it before spending again.
        throw new SolanaSwapError('invalid-request', 'a swap is still pending')
      }
      // Simulate once more, and re-apply the safety check on what the transaction would do,
      // immediately before signing. Nothing has left the device, so a failure here is final.
      await prepared.recheck()
      const { signature, rawTransaction } = await wallet.signSwapTransaction(
        prepared.transaction,
        prepared.lastValidBlockHeight,
      )
      const record: SolanaSwapRecord = {
        ...intent,
        transactionId: signature,
        signedAtMs: (parts.now ?? Date.now)(),
        recovery: {
          signedTransaction: encodeBase64(rawTransaction),
          lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
        },
      }
      // Recorded before it is broadcast. If this throws, nothing is sent.
      journal.put(record)
      // From here on the transaction may land. A send error proves nothing either way, so
      // the tracker decides the outcome from the chain.
      await connection
        .sendRawTransaction(rawTransaction, {
          skipPreflight: true,
          maxRetries: 0,
        })
        .catch(() => undefined)
      onSubmitted?.(record)
      return trackSolanaSwap(connection, journal, record, parts.track)
    },
    legacyTransactionOutcome: record =>
      trackSolanaSwap(connection, journal, record, parts.track),
  }
}
