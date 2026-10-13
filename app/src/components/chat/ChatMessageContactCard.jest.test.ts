/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import ChatMessageContactCard from './ChatMessageContactCard.vue'
import enUS from '../../i18n/en-us'
import type { ContactCardItem } from '@frank/cashweb/types/messages'

const mockAddContact = jest.fn()
const mockHaveContact = jest.fn(() => false)

jest.mock('../../stores/contacts', () => ({
  useContactStore: () => ({
    addContact: mockAddContact,
    haveContact: mockHaveContact,
  }),
}))

const mockDownloadContactCardVcf = jest.fn(() => 'BEGIN:VCARD\r\nEND:VCARD\r\n')
jest.mock('../../utils/calendar-vcard', () => {
  const actual = jest.requireActual('../../utils/calendar-vcard')
  return {
    ...actual,
    downloadContactCardVcf: (...args: unknown[]) =>
      mockDownloadContactCardVcf(...args),
  }
})

const t = (key: string, params?: Record<string, unknown>) => {
  const raw = key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      enUS,
    ) as string
  if (!raw || !params) {
    return raw ?? key
  }
  return Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
    raw,
  )
}

const sampleContact: ContactCardItem = {
  type: 'contact-card',
  fullName: 'Alice Nakamoto',
  frankAddress: '0x1111111111111111111111111111111111111111',
  organization: 'Frank Labs',
  title: 'Protocol Engineer',
  emails: ['alice@example.org'],
  phones: ['+1-555-0100'],
  url: 'https://example.org',
  note: 'Key verification complete',
}

function mountContactCard() {
  return shallowMount(ChatMessageContactCard, {
    props: {
      item: sampleContact,
    },
    global: {
      stubs: {
        QAvatar: { template: '<div><slot /></div>' },
        QIcon: { template: '<i />' },
        QBtn: {
          props: ['label', 'disable'],
          template:
            '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
        },
      },
      mocks: {
        $t: t,
      },
    },
  })
}

describe('ChatMessageContactCard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders vCard metadata and supports 1-click import into Frank Contacts & .vcf export', async () => {
    const wrapper = mountContactCard()
    expect(wrapper.find('[data-testid="contact-card"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Alice Nakamoto')
    expect(wrapper.text()).toContain('Protocol Engineer · Frank Labs')
    expect(wrapper.text()).toContain('alice@example.org')
    expect(wrapper.text()).toContain('+1-555-0100')

    const addBtn = wrapper.find('[data-testid="contact-card-add"]')
    expect(addBtn.exists()).toBe(true)
    await addBtn.trigger('click')
    expect(mockAddContact).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0x1111111111111111111111111111111111111111',
      }),
    )

    await wrapper
      .find('[data-testid="contact-card-download-vcf"]')
      .trigger('click')
    expect(mockDownloadContactCardVcf).toHaveBeenCalledWith(sampleContact)
  })
})
