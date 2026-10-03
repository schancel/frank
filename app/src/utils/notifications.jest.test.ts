/** @jest-environment jsdom */

const createNotification = jest.fn()
const openURL = jest.fn()

jest.mock('quasar', () => ({
  Notify: { create: createNotification },
  openURL,
}))

import { createPinia, setActivePinia } from 'pinia'
import { useAppearanceStore } from 'src/stores/appearance'
import {
  addressCopiedNotify,
  desktopNotify,
  errorNotify,
  infoNotify,
  insufficientStampNotify,
  seedCopiedNotify,
  sentTransactionNotify,
} from './notifications'

describe('errorNotify', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    setActivePinia(createPinia())
    createNotification.mockReset()
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
  })

  afterEach(() => consoleError.mockRestore())

  it('keeps plain and ethers error details diagnostic-only and renders text', () => {
    const externalMarkup = '<img src=x onerror="globalThis.errorXss=true">'

    errorNotify(new Error(externalMarkup))
    errorNotify({
      message: 'provider transaction dump',
      shortMessage: externalMarkup,
    })

    expect(createNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: 'Something went wrong. Please try again.',
        html: false,
      }),
    )
    expect(createNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: 'Something went wrong. Please try again.',
        html: false,
      }),
    )
    expect(createNotification.mock.calls.flat().join(' ')).not.toContain(
      externalMarkup,
    )
  })

  it('resolves a caller-selected fallback key in the current locale', () => {
    errorNotify(new Error('rpc down'), {
      fallbackKey: 'walletPanel.failedLoadAddress',
    })
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Failed to load the Monad wallet address',
      }),
    )

    useAppearanceStore().locale = 'fr-fr'
    errorNotify(new Error('rpc down'), {
      fallbackKey: 'walletPanel.failedLoadAddress',
    })
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Échec du chargement de l’adresse du portefeuille Monad',
      }),
    )
  })

  it('uses the generic localized message when a fallback key is missing', () => {
    useAppearanceStore().locale = 'fr-fr'

    errorNotify(new Error('rpc down'), {
      fallbackKey: 'notifications.doesNotExist',
    })

    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Une erreur s’est produite. Veuillez réessayer.',
        html: false,
      }),
    )
  })

  it('renders an explicitly app-authored localized fallback as text', () => {
    const safeMessage =
      'The transaction may have been broadcast. Check its status before retrying.'

    errorNotify(new Error('provider transaction dump'), { safeMessage })

    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: safeMessage, html: false }),
    )
  })
})

describe('infoNotify', () => {
  beforeEach(() => {
    createNotification.mockReset()
    document.body.innerHTML = ''
    ;(globalThis as { topicXss?: boolean }).topicXss = false
  })

  it('renders relay-authored notification content as text, never HTML', () => {
    const payload = '<img src=x onerror="globalThis.topicXss=true">'
    const message = `Post created in ${payload}.`
    createNotification.mockImplementationOnce(
      ({ message: rendered, html }: { message: string; html?: boolean }) => {
        const notification = document.createElement('div')
        if (html) {
          notification.innerHTML = rendered
        } else {
          notification.textContent = rendered
        }
        document.body.appendChild(notification)
      },
    )

    infoNotify(message)

    expect(document.body.textContent).toBe(message)
    expect(document.querySelector('img')).toBeNull()
    expect((globalThis as { topicXss?: boolean }).topicXss).toBe(false)
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message, html: false }),
    )
  })
})

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

describe('localized notifications (#589)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    createNotification.mockClear()
  })

  it('translates addressCopiedNotify in en-us and fr-fr', () => {
    addressCopiedNotify()
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Address copied to clipboard.' }),
    )

    useAppearanceStore().locale = 'fr-fr'
    addressCopiedNotify()
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Adresse copiée dans le presse-papier.',
      }),
    )
  })

  it('translates insufficientStampNotify in en-us and fr-fr', () => {
    insufficientStampNotify()
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Stamp is too small, receiver will not be notified.',
      }),
    )

    useAppearanceStore().locale = 'fr-fr'
    insufficientStampNotify()
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          'Le timbre est trop petit, le destinataire ne sera pas notifié.',
      }),
    )
  })

  it('translates seedCopiedNotify in en-us and fr-fr', () => {
    seedCopiedNotify()
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Your recovery phrase has been copied to your clipboard.',
      }),
    )

    useAppearanceStore().locale = 'fr-fr'
    seedCopiedNotify()
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          'Votre phrase de récupération a été copiée dans votre presse-papier.',
      }),
    )
  })

  it('translates sentTransactionNotify message and view action in en-us and fr-fr', () => {
    sentTransactionNotify('0x123')
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: '<div class="text-center"> Sent transaction </div>',
        actions: [expect.objectContaining({ label: 'View' })],
      }),
    )

    useAppearanceStore().locale = 'fr-fr'
    sentTransactionNotify('0x123')
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: '<div class="text-center"> Transaction envoyée </div>',
        actions: [expect.objectContaining({ label: 'Voir' })],
      }),
    )
  })

  it('allows custom overrides for notifications', () => {
    addressCopiedNotify('Custom copy message')
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Custom copy message' }),
    )

    sentTransactionNotify('0x123', 'Custom sent')
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: '<div class="text-center"> Custom sent </div>',
      }),
    )
  })
})
