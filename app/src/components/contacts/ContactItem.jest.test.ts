/** @jest-environment jsdom */

/**
 * Ticket #368: the Contacts list showed "Inbox Price:" with nothing after it for a contact that
 * advertises no price (every Monad contact). The row is now shown only for a real number.
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import enUS from 'src/i18n/en-us'
import ContactItem from './ContactItem.vue'

jest.mock('../../adapters/level-message-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('src/utils/avatar', () => ({ profileAvatar: () => 'avatar' }))
jest.mock('@frank/wallet/chain', () => ({ activeChain: {} }))

function t(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS)
  return typeof value === 'string' ? value : key
}

const stub = (tag: string) => ({ template: `<${tag}><slot /></${tag}>` })

function render(inbox: unknown) {
  setActivePinia(createPinia())
  return mount(ContactItem, {
    props: {
      address: '0xabc',
      contact: { profile: { name: 'Dealer', avatar: null }, inbox },
    },
    global: {
      mocks: { $t: t },
      directives: { 'ripple': {}, 'close-popup': {} },
      stubs: {
        'q-item': stub('div'),
        'q-item-section': stub('div'),
        'q-item-label': {
          template: '<div class="label"><slot /></div>',
          props: ['lines', 'caption'],
        },
        'q-avatar': stub('div'),
        'q-btn': stub('button'),
        'q-icon': stub('i'),
        'q-skeleton': stub('span'),
      },
    },
  })
}

describe('ContactItem inbox price', () => {
  it.each([
    ['no inbox at all', undefined],
    ['no price', {}],
    ['a NaN price', { acceptancePrice: NaN }],
    ['a null price', { acceptancePrice: null }],
    ['a non-numeric price', { acceptancePrice: 'abc' }],
  ])('has no blank "Inbox Price:" label for %s', (_name, inbox) => {
    const w = render(inbox)
    expect(w.text()).toContain('Dealer')
    expect(w.text()).not.toContain('Inbox Price')
  })

  it('shows the price when the contact advertises one, including zero', () => {
    expect(render({ acceptancePrice: 500 }).text()).toContain(
      'Inbox Price: 500',
    )
    expect(render({ acceptancePrice: 0 }).text()).toContain('Inbox Price: 0')
  })
})
