/**
 * The stakes the app's game cards offer, from the payment floor of the chain the conversation is
 * on. The rule itself is headless and shared with the bots (`stakeMinimumWei`); this is only
 * how the app reads the floor and which amounts it puts on buttons.
 */
import { stakeMinimumWei } from '@frank/wallet/message-item-plugins/shared/stake-minimum'

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
