/**
 * Registers the `raffle` message item type with the shared plugin registry (`./index.ts`). Mirrors
 * `digital-goods.ts`'s plugin almost exactly: an `enter`'s payment is that same message's own
 * stamp, already relay-verified before the message could ever be stored -- there's nothing left to
 * verify externally (contrast blackjack's wager, a *separate* transfer the relay knows nothing
 * about). See `@frank/wallet/raffle/draw.ts` for the provably-fair winner-selection this feeds
 * into.
 */
import { RaffleItem } from '@frank/cashweb/types/messages'

import { registerMessageItemPlugin } from './index'

export interface HydratedRaffleItem extends RaffleItem {
  /** Only set for `enter` -- copied straight from the message's own relay-verified stamp value,
   * never a number read from the wire payload itself (there isn't one to read; see `RaffleItem`'s
   * own header on `@frank/cashweb/types/messages`). */
  paidWei?: bigint
}

registerMessageItemPlugin<RaffleItem, HydratedRaffleItem>({
  type: 'raffle',
  hydrate(raw, context) {
    return {
      ...raw,
      paidWei: raw.action === 'enter' ? context.message.stampValueWei : undefined,
    }
  },
  previewText(raw) {
    switch (raw.action) {
      case 'announce':
        return `Raffle open (${raw.entryCount ?? 0}/${raw.maxEntries ?? '?'} entered)`
      case 'enter':
        return 'Entered the raffle'
      case 'joined':
        return `Joined the raffle (${raw.entryCount ?? 0}/${raw.maxEntries ?? '?'})`
      case 'draw':
        return 'Raffle drawn'
      case 'error':
        return raw.message ?? 'Raffle error'
    }
  },
})
