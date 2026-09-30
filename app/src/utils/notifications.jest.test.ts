const createNotification = jest.fn()
const openURL = jest.fn()

jest.mock('quasar', () => ({
  Notify: { create: createNotification },
  openURL,
}))

import { desktopNotify, sentTransactionNotify } from './notifications'

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

describe('desktopNotify', () => {
  const constructed: Array<{ title: string; options: NotificationOptions }> = []
  const original = (global as { Notification?: unknown }).Notification

  beforeEach(() => {
    constructed.length = 0
    ;(global as { Notification?: unknown }).Notification = class {
      onclick: (() => void) | null = null
      constructor(title: string, options: NotificationOptions) {
        constructed.push({ title, options })
      }
    }
  })
  afterEach(() => {
    ;(global as { Notification?: unknown }).Notification = original
  })

  it('passes the tag so the browser replaces a repeat of the same message (#412)', () => {
    desktopNotify('Qwen', 'hi', 'icon.png', () => undefined, 'digest-1')

    expect(constructed).toEqual([
      {
        title: 'Qwen',
        options: { body: 'hi', icon: 'icon.png', tag: 'digest-1' },
      },
    ])
  })

  it('omits the tag when none is given', () => {
    desktopNotify('Qwen', 'hi', 'icon.png', () => undefined)

    expect(constructed[0]?.options).not.toHaveProperty('tag')
  })
})
