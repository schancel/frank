const createNotification = jest.fn()
const openURL = jest.fn()

jest.mock('quasar', () => ({
  Notify: { create: createNotification },
  openURL,
}))

import { sentTransactionNotify } from './notifications'

describe('sentTransactionNotify', () => {
  beforeEach(() => {
    createNotification.mockClear()
    openURL.mockClear()
  })

  it('opens the default Monad explorer from a browser notification', () => {
    sentTransactionNotify('0xabc')

    const notification = createNotification.mock.calls[0]?.[0]
    expect(notification.actions).toHaveLength(1)

    notification.actions[0].handler()

    expect(openURL).toHaveBeenCalledWith(
      'https://testnet.monadscan.com/tx/0xabc',
    )
  })

  it('does not offer an explorer action without a transaction hash', () => {
    sentTransactionNotify()

    expect(createNotification.mock.calls[0]?.[0].actions).toEqual([])
    expect(openURL).not.toHaveBeenCalled()
  })
})
