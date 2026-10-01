import { formatMon } from '@frank/wallet/monad-amount'

/** The error text for a purchase paid below the item's price: amounts in MON, never raw wei. */
export function paymentBelowPriceMessage(
  paidWei: bigint,
  item: { itemId: string; priceWei: bigint },
): string {
  return `Payment ${formatMon(paidWei)} is below ${item.itemId}'s price of ${formatMon(item.priceWei)}`
}
