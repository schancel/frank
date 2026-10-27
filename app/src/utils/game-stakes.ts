/**
 * The stakes the app's game cards offer, from the payment floor of the chain the conversation is
 * on. The rule itself is headless and shared with the bots (`stakeMinimumWei`); this is only
 * how the app reads the floor and which amounts it puts on buttons.
 */
import {
  stakeAllowed,
  stakeMinimumWei,
} from '@frank/wallet/message-item-plugins/shared/stake-minimum'
import { activeChain } from '@frank/wallet/chain'
import type { StampReceipt } from '../composables/useStampReceipt'
import { formatDisplayAmount } from './chain-amount'

/** What a game card provides to read the payment floor: the wallet's `minimumStamp` for the
 * chain the conversation is on, as Chat.vue last read it (zero while it is not known). */
export const PAYMENT_FLOOR_INJECTION = 'paymentFloorWei'

/** The paid stakes a game card offers at `paymentFloorWei`: the smallest stake the game takes
 * (`stakeMinimumWei`, the rule the bots enforce) and two and five times it. None while the
 * floor is not known: a card never offers a stake the wallet or the table would refuse. */
export function stakeChipsWei(paymentFloorWei: bigint): bigint[] {
  const minimum = stakeMinimumWei(paymentFloorWei)
  return minimum > 0n ? [minimum, 2n * minimum, 5n * minimum] : []
}

/** Why a stake typed on a game card cannot be sent, in the words the player is shown ('' when
 * it can): not a number, or below the smallest stake, naming it. The card shows it, disables its
 * send button while it is set, and a refused send says exactly this, never a generic error. */
export function stakeProblem(
  wagerWei: bigint | undefined,
  minimumWei: bigint,
  t: (key: string, params?: Record<string, unknown>) => string,
  format: (wei: bigint) => string,
): string {
  if (wagerWei === undefined) return t('gameFairness.rpsInvalidStake')
  if (!stakeAllowed(wagerWei, minimumWei))
    return t('gameFairness.stakeBelowMinimum', { amount: format(minimumWei) })
  return ''
}

/** How a game card states a payout it is owed: the amount, what its message carried (or, once
 * on chain, what landed), whether that is short, and whether the chain showed it arrive. */
// A type alias, not an interface: it is passed whole as a message's named parameters.
export type PayoutView = {
  amount: string
  carried: string
  short: boolean
  verified: boolean
}

/** The payout `owedWei` of a result whose message said it carried `carriedWei`, checked against
 * the wallet's receipt for that message's stamp (`useStampReceipt`). Verified only when the chain
 * showed at least the amount owed arrive; short when the message carried less, or less landed. */
export function payoutView(
  owedWei: bigint,
  carriedWei: bigint,
  receipt: StampReceipt | undefined,
): PayoutView {
  const landed =
    receipt?.status === 'received' ? receipt.receivedWei : undefined
  const shown = landed ?? carriedWei
  return {
    amount: formatDisplayAmount(activeChain, owedWei),
    carried: formatDisplayAmount(activeChain, shown),
    short: shown < owedWei,
    verified: landed !== undefined && landed >= owedWei,
  }
}
