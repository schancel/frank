/** @jest-environment jsdom */

/**
 * #317: mounted render of the Contacts list for a first-run user with the four curated demo bots
 * (real contacts store, real ContactList/ContactItem; Quasar layout components are stubbed to
 * plain markup). Not a browser test: it proves what the components render, not the page chrome.
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import enUS from 'src/i18n/en-us'
import { useContactStore } from 'src/stores/contacts'
import ContactList from './ContactList.vue'

jest.mock('../../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(),
    deleteMessage: jest.fn(),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))
jest.mock('../../utils/notifications', () => ({ desktopNotify: jest.fn() }))
const mockFetchProfile = jest.fn()
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    name: 'Monad',
    parseAddress: (address: string) => ({ raw: address }),
    formatAddress: (address: { raw: string }) => address.raw,
    fetchProfile: (...args: unknown[]) => mockFetchProfile(...args),
  },
}))
jest.mock('src/utils/avatar', () => ({
  profileAvatar: (avatar: string | null) => avatar ?? 'default-avatar',
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: () => Promise.reject(new Error('no wallet')),
}))

function t(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS)
  return typeof value === 'string' ? value : key
}

const BOTS = [
  { address: `0x${'01'.repeat(20)}`, name: 'Blackjack Dealer' },
  { address: `0x${'02'.repeat(20)}`, name: 'Raffle' },
  { address: `0x${'03'.repeat(20)}`, name: 'Picture Shop' },
  { address: `0x${'04'.repeat(20)}`, name: 'Qwen' },
]
const PUB_KEY = Uint8Array.from(
  Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex',
  ),
)

const stub = (tag: string) => ({
  template: `<${tag}><slot /></${tag}>`,
  props: ['lines'],
})

function mountList(contacts: Record<string, unknown>) {
  return mount(ContactList, {
    props: { contacts },
    global: {
      mocks: { $t: t },
      directives: { 'ripple': {}, 'close-popup': {} },
      stubs: {
        'q-list': stub('div'),
        'q-item': stub('div'),
        'q-item-section': stub('div'),
        'q-item-label': {
          template: '<div class="label" :data-lines="lines"><slot /></div>',
          props: ['lines', 'caption'],
        },
        'q-avatar': stub('div'),
        'q-icon': stub('i'),
        'q-btn': stub('button'),
        'q-skeleton': stub('span'),
      },
    },
  })
}

describe('first-run Contacts with curated bots', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('lists the four bots by name, in order, and never shows Loading...', async () => {
    const contacts = useContactStore()
    for (const bot of BOTS) await contacts.addDefaultContact(bot)
    const wrapper = mountList(contacts.getContacts)
    const names = wrapper
      .findAll('.label[data-lines="1"]')
      .filter(label => BOTS.some(bot => bot.name === label.text()))
      .map(label => label.text())
    expect(names).toEqual(BOTS.map(bot => bot.name))
    expect(wrapper.text()).not.toContain('Loading...')
  })

  it('after profile refresh a bot without a display name shows a short address, not Loading...', async () => {
    const contacts = useContactStore()
    contacts.setUpdateInterval(0)
    await contacts.addDefaultContact({ ...BOTS[0], name: 'Loading...' })
    mockFetchProfile.mockResolvedValue({
      address: { raw: BOTS[0].address },
      pubKey: PUB_KEY,
    })
    await contacts.refreshContacts()
    const wrapper = mountList(contacts.getContacts)
    expect(wrapper.text()).not.toContain('Loading...')
    expect(wrapper.text()).toContain('0x0101…0101')
  })
})
