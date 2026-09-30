import { paymentBelowPriceMessage } from './vendor-messages'

describe('paymentBelowPriceMessage', () => {
  it('quotes both amounts in MON, never raw wei', () => {
    const text = paymentBelowPriceMessage(10n ** 16n, {
      itemId: 'sunrise',
      priceWei: 5n * 10n ** 16n,
    })
    expect(text).toBe(
      "Payment 0.01 MON is below sunrise's price of 0.05 MON",
    )
    expect(text).not.toMatch(/wei|\d{9,}/)
  })
})
