import { BlackjackMoveItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import {
  BLACKJACK_DEFAULT_MAX_WAGER_WEI,
  BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  validateBetWei,
} from '@frank/wallet/message-item-plugins/blackjack/game'

import { useActiveWallet } from '../composables/useActiveWallet'

/** Why a bet input was refused. The UI maps each code to its own translated text; `error` is the
 * English fallback (the shared table-limit wording from `validateBetWei`). */
export type BetErrorCode = 'format' | 'invalid' | 'zero' | 'min' | 'max'

export type BetParse =
  | { ok: true; wei: bigint }
  | { ok: false; code: BetErrorCode; error: string }

/**
 * Parses and validates the bet-size input BEFORE any value is sent on-chain (a transfer that the
 * dealer then rejects has to be refunded by the bot, so the client filters what it can). Rejects
 * empty, non-numeric, non-finite, zero, negative, below-minimum and above-maximum input.
 */
export function parseBetInput(
  fromDisplayAmount: (display: string) => bigint,
  display: string,
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
  const error = validateBetWei(wei)
  if (!error) return { ok: true, wei }
  const code: BetErrorCode =
    wei <= 0n ? 'zero' : wei < BLACKJACK_DEFAULT_MIN_WAGER_WEI ? 'min' : 'max'
  return { ok: false, code, error }
}

/** The table limits the client can know (the dealer advertises none), in MON with decimals. */
export function betLimitsDisplay(): { min: string; max: string } {
  return {
    min: activeChain.toDisplayAmount(BLACKJACK_DEFAULT_MIN_WAGER_WEI),
    max: activeChain.toDisplayAmount(BLACKJACK_DEFAULT_MAX_WAGER_WEI),
  }
}

/**
 * Sends ONE wager transfer to the dealer and returns the `bet` move that references it. Every
 * call creates a fresh `gameId` and a fresh transfer: the caller must have validated `wei` first
 * and must not call this twice for one click (the transfer is real money and the dealer claims
 * each transaction hash for exactly one stake).
 */
export async function sendBlackjackWager(
  dealerAddress: string,
  wei: bigint,
): Promise<BlackjackMoveItem> {
  const wallet = await useActiveWallet()
  const result = await activeChain.nativeTransfers.send({
    wallet,
    recipient: { raw: dealerAddress },
    value: wei,
  })
  const gameId = `bj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    type: 'blackjack-move',
    gameId,
    action: 'bet',
    wagerTxHash: result.txHash,
  }
}

/**
 * Conservative allowance for what sending the bet MESSAGE costs beyond the wager itself: the
 * stamp's own funding transfers and gas (a message spends its stamp value plus the fee reserves of
 * the sub-accounts that pay it; ~0.013 MON of funding was observed on the local chain on top of a
 * 0.01 MON stamp). The wallet does not expose a synchronous estimate, so this is a fixed margin.
 * A wager paid with no funds left for the message is stranded (the dealer only acts on messages it
 * receives), so the picker requires `bet + stamp + this` up front.
 */
export const BET_MESSAGE_FEE_RESERVE_WEI = 5n * 10n ** 16n // 0.05 MON

/** Total balance a bet needs: the wager, the message stamp, and the fee reserve. */
export function betFundsRequired(betWei: bigint, stampWei: bigint): bigint {
  return betWei + stampWei + BET_MESSAGE_FEE_RESERVE_WEI
}

/** `0x12ab...9f`-style abbreviation for showing a recipient next to its name. */
export function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address
}

export const BET_DELIVERY_TIMEOUT_MS = 30_000

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
  if (!(await opts.send())) {
    throw new Error('The bet message could not be sent.')
  }
}
