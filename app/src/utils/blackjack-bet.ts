import { validateBetWei } from '@frank/wallet/message-item-plugins/blackjack/game'

export type BetParse = { ok: true; wei: bigint } | { ok: false; error: string }

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
    return { ok: false, error: 'Enter a bet as a plain decimal number' }
  }
  let wei: bigint
  try {
    wei = fromDisplayAmount(trimmed)
  } catch {
    return { ok: false, error: 'Enter a valid MON amount to bet' }
  }
  const error = validateBetWei(wei)
  return error ? { ok: false, error } : { ok: true, wei }
}
