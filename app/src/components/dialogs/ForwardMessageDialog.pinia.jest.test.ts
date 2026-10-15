/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ForwardMessageDialog from './ForwardMessageDialog.vue'
import { useContactStore, type ContactState } from 'src/stores/contacts'
import type { Message } from '@frank/cashweb/types/messages'

jest.mock('src/adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      // The picker does not read persisted messages.
    },
  }),
}))
jest.mock('src/utils/notifications', () => ({ desktopNotify: jest.fn() }))

const contact = (name: string): ContactState => ({
  lastUpdateTime: 0,
  notify: true,
  relayURL: null,
  profile: { name, bio: null, avatar: null, pubKey: null },
  inbox: {},
})
const message: Message = {
  outbound: false,
  status: 'confirmed',
  receivedTime: 1,
  serverTime: 1,
  items: [{ type: 'text', text: 'Forward preview' }],
  outpoints: [],
  senderAddress: 'sender',
}

function mountDialog() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contacts = useContactStore()
  contacts.$patch({
    contacts: {
      '0xAlice': contact('Alice'),
      '0xBob': contact('Bob'),
      'absent': undefined,
    },
  })
  const page = mount(ForwardMessageDialog, {
    props: { message },
    global: {
      plugins: [pinia],
      mocks: { $t: (key: string) => key },
      directives: { 'close-popup': {} },
      stubs: {
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QSpace: { template: '<span />' },
        QList: { template: '<div><slot /></div>' },
        QItem: {
          template: '<div class="q-item"><slot /></div>',
        },
        QItemSection: { template: '<div><slot /></div>' },
        QItemLabel: { template: '<div><slot /></div>' },
        QAvatar: { template: '<div><slot /></div>' },
        QInput: {
          props: ['modelValue'],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        QBtn: { template: '<button><slot /></button>' },
      },
    },
  })
  return { page, contacts }
}

describe('ForwardMessageDialog production sparse contact view', () => {
  it('skips absent entries and reacts to insertion and deletion', async () => {
    const { page, contacts } = mountDialog()
    try {
      expect(page.findAll('.q-item')).toHaveLength(2)
      expect(page.text()).not.toContain('absent')
      contacts.$patch({
        contacts: { '0xCarol': contact('Carol'), '0xAlice': undefined },
      })
      await nextTick()
      expect(page.findAll('.q-item')).toHaveLength(2)
      expect(page.text()).toContain('Carol')
      expect(page.text()).not.toContain('Alice')
      contacts.$patch(state => {
        delete state.contacts['0xBob']
      })
      await nextTick()
      expect(page.findAll('.q-item')).toHaveLength(1)
      expect(page.text()).not.toContain('Bob')
    } finally {
      page.unmount()
    }
  })

  it('preserves name and address search and the empty view', async () => {
    const { page } = mountDialog()
    try {
      await page.get('input').setValue('ALICE')
      expect(page.findAll('.q-item')).toHaveLength(1)
      expect(page.text()).toContain('Alice')
      await page.get('input').setValue('0xbob')
      expect(page.findAll('.q-item')).toHaveLength(1)
      expect(page.text()).toContain('Bob')
      await page.get('input').setValue('absent')
      expect(page.findAll('.q-item')).toHaveLength(0)
      expect(page.text()).toContain('contactItem.notFound')
    } finally {
      page.unmount()
    }
  })

  it('emits only the exact selected address without mutating the owner', async () => {
    const { page, contacts } = mountDialog()
    try {
      const before = JSON.stringify(contacts.$state)
      await page.get('input').setValue('bob')
      await page.get('.q-item').trigger('click')
      expect(page.emitted('forward')).toEqual([['0xBob']])
      expect(JSON.stringify(contacts.$state)).toBe(before)
    } finally {
      page.unmount()
    }
  })
})
