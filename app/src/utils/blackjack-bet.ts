import { BlackjackMoveItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import {
  BET_MESSAGE_FEE_RESERVE_WEI,
  BLACKJACK_DEFAULT_MAX_WAGER_WEI,
  BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  BlackjackWelcome,
  parseBlackjackError,
  parseBlackjackWelcome,
  validateBetWei,
} from '@frank/wallet/message-item-plugins/blackjack/game'

import { useActiveWallet } from '../composables/useActiveWallet'
import { toChainDisplayAddress } from './chain-address'
import { shortAddress } from './short-address'

/** Why a bet input was refused. The UI maps each code to its own translated text; `error` is the
 * English fallback (the shared table-limit wording from `validateBetWei`). */
export type BetErrorCode = 'format' | 'invalid' | 'zero' | 'min' | 'max'

export type BetParse =
  | { ok: true; wei: bigint }
  | { ok: false; code: BetErrorCode; error: string }

/** The table the bet controls play at: the dealer's advertised limits, or the documented fallback. */
export interface BlackjackTable {
  minWei: bigint
  maxWei: bigint
  /** The dealer's hint of what a bet message costs beyond the wager (see `betFundsRequired`). */
  feeHintWei?: bigint
  /** The dealer's house-rules summary (dealer text), when it sent one. */
  rules?: string
  /** `welcome`: from the latest dealer welcome in this chat; `default`: no welcome exists, so the
   * shared documented fallback limits (0.01 to 1 MON) apply and the dealer may still refuse a bet
   * it does not like (it then refunds the verified stake). */
  source: 'welcome' | 'default'
}

export const DEFAULT_BLACKJACK_TABLE: BlackjackTable = {
  minWei: BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  maxWei: BLACKJACK_DEFAULT_MAX_WAGER_WEI,
  source: 'default',
}

function tableFromWelcome(welcome: BlackjackWelcome): BlackjackTable {
  return {
    minWei: welcome.minWagerWei,
    maxWei: welcome.maxWagerWei,
    feeHintWei: welcome.feeHintWei,
    rules: welcome.rules,
    source: 'welcome',
  }
}

/**
 * The table limits of a chat: the LATEST valid `welcome` the dealer sent us (a later one supersedes
 * an earlier one, so limits the dealer changed are re-read), else the documented fallback. Only
 * inbound messages count (nothing we sent can set the limits we bet at), and a malformed welcome
 * is skipped rather than trusted.
 */
export function latestDealerTable(
  messages: Array<{ outbound: boolean; items: Array<Record<string, any>> }>,
): BlackjackTable {
  let table = DEFAULT_BLACKJACK_TABLE
  for (const message of messages) {
    if (message.outbound) continue
    for (const item of message.items) {
      if (item.type !== 'blackjack-move' || item.action !== 'welcome') continue
      const welcome = parseBlackjackWelcome(item)
      if (welcome) table = tableFromWelcome(welcome)
    }
  }
  return table
}

/**
 * Parses and validates the bet-size input BEFORE any value is sent on-chain (a transfer that the
 * dealer then rejects has to be refunded by the bot, so the client filters what it can). Rejects
 * empty, non-numeric, non-finite, zero, negative, below-minimum and above-maximum input, against
 * the table's own limits.
 */
export function parseBetInput(
  fromDisplayAmount: (display: string) => bigint,
  display: string,
  table: Pick<BlackjackTable, 'minWei' | 'maxWei'> = DEFAULT_BLACKJACK_TABLE,
): BetParse {
  const trimmed = display.trim()
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    return {
      ok: false,
      code: 'format',
      error: 'Enter a bet as a plain decimal number',
    }
  }
  let wei: bigint
  try {
    wei = fromDisplayAmount(trimmed)
  } catch {
    return {
      ok: false,
      code: 'invalid',
      error: 'Enter a valid MON amount to bet',
    }
  }
  const error = validateBetWei(wei, table.minWei, table.maxWei)
  if (!error) return { ok: true, wei }
  const code: BetErrorCode =
    wei <= 0n ? 'zero' : wei < table.minWei ? 'min' : 'max'
  return { ok: false, code, error }
}

/** 0.1 MON. The bet box never starts above this (#422): a welcome's minimum is untrusted text. */
export const DEFAULT_BET_WEI = 10n ** 17n

/** Display name of the curated blackjack dealer (`packages/bot/bot-directory.ts`, key `blackjack`).
 * Addresses are per machine, so the client cannot hard-code one. */
export const CURATED_BLACKJACK_DEALER_NAME = 'Blackjack Dealer'

export interface CuratedDefaultEntry {
  address: string
  name: string
}

/** True only when this chat is the single relay-curated blackjack dealer AND the signed profile
 * still says so. The name and bot marker are necessary and not sufficient: a peer can copy both.
 * Zero curated dealers, or more than one, fails closed. An empty list (no fetch yet, or a failed
 * fetch) fails closed. */
export function peerOffersDealerTable(
  profile: { isBot?: boolean; signedName?: string | null } | null | undefined,
  address?: string | null,
  curated?: readonly CuratedDefaultEntry[] | null,
): boolean {
  if (
    profile?.isBot !== true ||
    (profile.signedName ?? '').trim() !== CURATED_BLACKJACK_DEALER_NAME
  ) {
    return false
  }
  if (!address || !curated) return false
  const dealers = curated.filter(
    entry => (entry.name ?? '').trim() === CURATED_BLACKJACK_DEALER_NAME,
  )
  if (dealers.length !== 1) return false
  try {
    return (
      toChainDisplayAddress(dealers[0].address) ===
      toChainDisplayAddress(address)
    )
  } catch {
    return false
  }
}

/** The bet input's starting value: 0.1 MON. Never higher, so an advertised minimum is only a
 * hint in the limits line, not the amount in the box. A table maximum below 0.1 still clamps
 * the start downward so it begins inside the table. */
export function defaultBetDisplay(
  table: Pick<BlackjackTable, 'minWei' | 'maxWei'> = DEFAULT_BLACKJACK_TABLE,
): string {
  const wei = DEFAULT_BET_WEI > table.maxWei ? table.maxWei : DEFAULT_BET_WEI
  return activeChain.toDisplayAmount(wei)
}

/** The table limits in MON with decimals, for display. */
export function betLimitsDisplay(
  table: Pick<BlackjackTable, 'minWei' | 'maxWei'> = DEFAULT_BLACKJACK_TABLE,
): { min: string; max: string } {
  return {
    min: activeChain.toDisplayAmount(table.minWei),
    max: activeChain.toDisplayAmount(table.maxWei),
  }
}

/** The wager was signed and its hash persisted (so a broadcast may have happened) but `send`
 * failed: the transfer may or may not have reached the chain. Only the node can say; never treat
 * this as "nothing was paid". */
export class WagerBroadcastError extends Error {
  constructor(
    readonly txHash: string,
    readonly gameId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'WagerBroadcastError'
  }
}

/**
 * Sends ONE wager transfer to the dealer and returns the `bet` move that references it. Every
 * call creates a fresh `gameId` and a fresh transfer: the caller must have validated `wei` first
 * and must not call this twice for one click (the transfer is real money and the dealer claims
 * each transaction hash for exactly one stake).
 *
 * `onSigned` runs with the hash after signing and BEFORE any byte is broadcast; if it rejects,
 * nothing is sent and that error propagates unchanged (definitely nothing paid). Any failure
 * AFTER `onSigned` succeeded surfaces as a {@link WagerBroadcastError} (paid: unknown).
 */
export async function sendBlackjackWager(
  dealerAddress: string,
  wei: bigint,
  hooks: {
    onSigned?: (info: {
      gameId: string
      txHash: string
      walletAddress: string
    }) => Promise<void>
  } = {},
): Promise<BlackjackMoveItem> {
  const wallet = await useActiveWallet()
  const gameId = `bj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let signedHash: string | undefined
  try {
    const result = await activeChain.nativeTransfers.send({
      wallet,
      recipient: { raw: dealerAddress },
      value: wei,
      onSigned: async ({ txHash }) => {
        await hooks.onSigned?.({
          gameId,
          txHash,
          walletAddress: activeChain.formatAddress(wallet.identity.address),
        })
        signedHash = txHash
      },
    })
    return {
      type: 'blackjack-move',
      gameId,
      action: 'bet',
      wagerTxHash: result.txHash,
    }
  } catch (err) {
    if (signedHash !== undefined) {
      throw new WagerBroadcastError(signedHash, gameId, err)
    }
    throw err
  }
}

export type PaymentStatus = 'confirmed' | 'failed' | 'pending' | 'unknown'

/** What the node says about a wager transaction hash right now. */
export async function checkWagerStatus(txHash: string): Promise<PaymentStatus> {
  const wallet = await useActiveWallet()
  return activeChain.nativeTransfers.getTransactionStatus({ wallet, txHash })
}

export const PAYMENT_CONFIRM_TIMEOUT_MS = 60_000
export const PAYMENT_POLL_MS = 2_000

/**
 * Polls `getStatus` until the payment is `confirmed` or `failed`, or the bounded time runs out
 * (then the last status is returned: `pending` or `unknown`). A lookup error counts as `pending`
 * (an RPC hiccup is not evidence that nothing was paid).
 */
export async function awaitPayment(
  getStatus: () => Promise<PaymentStatus>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<PaymentStatus> {
  const deadline = Date.now() + (opts.timeoutMs ?? PAYMENT_CONFIRM_TIMEOUT_MS)
  let last: PaymentStatus = 'pending'
  for (;;) {
    try {
      last = await getStatus()
    } catch {
      last = 'pending'
    }
    if (last === 'confirmed' || last === 'failed') return last
    if (Date.now() >= deadline) return last
    await new Promise(resolve =>
      setTimeout(resolve, opts.pollMs ?? PAYMENT_POLL_MS),
    )
  }
}

export type DealerReply = 'none' | 'accepted' | 'unconfirmed' | 'rejected'

/**
 * What the dealer answered for `gameId`, from the chat history: a `blackjack-move` for the game =
 * `accepted` (the hand is dealt); a game-tagged error "already authorized" = `accepted` (this very
 * wager already has its game); one saying the payment could not be verified/is unconfirmed =
 * `unconfirmed` (the bet was DROPPED, retry is safe); any other tagged error = `rejected` (the bot
 * refunds a rejected stake). The latest reply wins.
 */
export function dealerReplyFor(
  messages: Array<{ outbound: boolean; items: Array<Record<string, any>> }>,
  gameId: string,
): DealerReply {
  let reply: DealerReply = 'none'
  for (const message of messages) {
    if (message.outbound) continue
    for (const item of message.items) {
      if (item.type === 'blackjack-move' && item.gameId === gameId) {
        reply = 'accepted'
      } else if (item.type === 'text') {
        const parsed = parseBlackjackError(String(item.text))
        if (parsed?.gameId !== gameId) continue
        reply = /already authorized/i.test(parsed.text)
          ? 'accepted'
          : /unconfirmed|could not verify/i.test(parsed.text)
          ? 'unconfirmed'
          : 'rejected'
      }
    }
  }
  return reply
}

/** Re-exported from the wallet package (the demo launcher checks its faucet amount against it). */
export { BET_MESSAGE_FEE_RESERVE_WEI }

/** What sending the bet message costs beyond the wager: the stamp plus the fee reserve, or the
 * dealer's own hint if that is larger (a hint can only make the requirement stricter). */
export function betMessageCostWei(
  stampWei: bigint,
  feeHintWei?: bigint,
): bigint {
  const own = stampWei + BET_MESSAGE_FEE_RESERVE_WEI
  return feeHintWei !== undefined && feeHintWei > own ? feeHintWei : own
}

/** Total balance a bet needs: the wager plus the message stamp and fees (`betMessageCostWei`). */
export function betFundsRequired(
  betWei: bigint,
  stampWei: bigint,
  feeHintWei?: bigint,
): bigint {
  return betWei + betMessageCostWei(stampWei, feeHintWei)
}

export { shortAddress }

export const BET_DELIVERY_TIMEOUT_MS = 30_000
export const BET_SEND_TIMEOUT_MS = 120_000

/**
 * Delivers a `bet` move whose wager transfer is already paid, via the chat's send pipeline, and
 * reports the REAL outcome: resolves only if `send` resolved true; throws otherwise. That pipeline
 * silently drops a call made while another send is in flight, which would strand the wager, so
 * wait for it to go idle first (bounded by `timeoutMs`, so a stuck send cannot freeze the caller);
 * and never deliver the move to a different chat than the one the wager went to (the player may
 * navigate away while the transfer confirms). Every throw means "not delivered": the caller keeps
 * the unsent-wager record.
 */
export async function deliverBetWhenReady(opts: {
  betAddress: string
  currentAddress: () => string
  isBusy: () => boolean
  send: () => Promise<boolean>
  pollMs?: number
  timeoutMs?: number
  /** Bound on the send itself (a pipeline that never settles must not hide the wager). */
  sendTimeoutMs?: number
}): Promise<void> {
  const check = () => {
    if (opts.currentAddress() !== opts.betAddress) {
      throw new Error(
        'The chat changed before the bet could be sent. Open the dealer chat again.',
      )
    }
  }
  check()
  const deadline = Date.now() + (opts.timeoutMs ?? BET_DELIVERY_TIMEOUT_MS)
  while (opts.isBusy()) {
    if (Date.now() >= deadline) {
      throw new Error('The chat is still busy sending another message.')
    }
    await new Promise(resolve => setTimeout(resolve, opts.pollMs ?? 100))
    check()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(
      () => resolve('timeout'),
      opts.sendTimeoutMs ?? BET_SEND_TIMEOUT_MS,
    )
  })
  try {
    const outcome = await Promise.race([opts.send(), timedOut])
    if (outcome === 'timeout') {
      throw new Error('Sending the bet message is taking too long.')
    }
    if (!outcome) throw new Error('The bet message could not be sent.')
  } finally {
    clearTimeout(timer)
  }
}
