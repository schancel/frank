/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import ForwardMessageDialog from './ForwardMessageDialog.vue'
import enUS from '../../i18n/en-us'

function translator(messages: unknown) {
  return (key: string, params?: Record<string, unknown>) => {
    let value: unknown = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    if (typeof value === 'string' && params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{${k}}`, String(v))
      }
    }
    return typeof value === 'string' ? value : key
  }
}

const mockContacts = {
  '0xAlice': {
    profile: { name: 'Alice' },
    inbox: {},
    notify: true,
  },
  '0xBob': {
    profile: { name: 'Bob' },
    inbox: {},
    notify: true,
  },
}

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContacts: mockContacts,
  }),
}))

describe('ForwardMessageDialog', () => {
  const mountDialog = (
    messageItems = [{ type: 'text', text: 'Hello Forward' }],
  ) => {
    return mount(ForwardMessageDialog, {
      props: {
        message: {
          outbound: true,
          status: 'confirmed',
          receivedTime: 1,
          serverTime: 1,
          items: messageItems,
          outpoints: [],
          senderAddress: '0xAlice',
        },
      },
      global: {
        mocks: { $t: translator(enUS) },
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
  }

  it('renders the message preview and contacts', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('Hello Forward')
    expect(wrapper.text()).toContain('Alice')
    expect(wrapper.text()).toContain('Bob')
  })

  it('filters contacts based on search query', async () => {
    const wrapper = mountDialog()
    const input = wrapper.find('input')
    await input.setValue('bob')
    expect(wrapper.text()).toContain('Bob')
    expect(wrapper.text()).not.toContain('Alice')
  })

  it('emits forward event with selected contact address', async () => {
    const wrapper = mountDialog()
    const items = wrapper.findAll('.q-item')
    expect(items.length).toBe(2)
    // Click on Bob (the second contact item)
    await items[1].trigger('click')
    expect(wrapper.emitted('forward')).toEqual([['0xBob']])
  })
})
