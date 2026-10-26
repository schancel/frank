/** @jest-environment jsdom */
/**
 * The hidden Developer section on About: tapping the version line seven times shows it, with the
 * Reconcile wallet entry. Nothing shows before; further taps change nothing.
 */
import { flushPromises, mount } from '@vue/test-utils'
import enUS from 'src/i18n/en-us'

const mockNotifyCreate = jest.fn()
jest.mock('quasar', () => ({
  Notify: { create: (...args: unknown[]) => mockNotifyCreate(...args) },
  Dialog: { create: jest.fn() },
}))
// The Developer section's card talks to the wallet; here it only has to appear.
jest.mock('src/components/settings/WalletReconcileCard.vue', () => ({
  __esModule: true,
  default: {
    name: 'WalletReconcileCard',
    template: '<div data-test="developer-section">Reconcile wallet</div>',
  },
}))

import About from './About.vue'

type Messages = Record<string, unknown>
const t = (key: string): string => {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], enUS)
  return typeof value === 'string' ? value : key
}

const mountAbout = () =>
  mount(About, {
    global: {
      mocks: { $t: t },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<h1><slot /></h1>' },
        QBtn: { template: '<button><slot /></button>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QAvatar: { template: '<div><slot /></div>' },
        QChip: { template: '<span><slot /></span>' },
        QCard: { template: '<article><slot /></article>' },
        QCardSection: { template: '<div><slot /></div>' },
        QIcon: { template: '<i><slot /></i>' },
      },
    },
  })

test('the Developer section stays hidden until the version line is tapped seven times', async () => {
  const about = mountAbout()
  const version = about.find('[data-test="about-commit-hash"]')
  for (let tap = 0; tap < 6; tap++) await version.trigger('click')
  await flushPromises()
  expect(about.find('[data-test="developer-section"]').exists()).toBe(false)
  expect(mockNotifyCreate).not.toHaveBeenCalled()

  await version.trigger('click')
  await flushPromises()
  expect(about.find('[data-test="developer-section"]').text()).toContain(
    'Reconcile wallet',
  )
  expect(mockNotifyCreate).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Developer options are shown.' }),
  )
  await version.trigger('click')
  expect(mockNotifyCreate).toHaveBeenCalledTimes(1)
})
