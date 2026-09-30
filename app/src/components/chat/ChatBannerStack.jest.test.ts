/** @jest-environment jsdom */

import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'

import ChatBannerStack from './ChatBannerStack.vue'
import { useMailboxStatusStore } from '../../stores/mailbox-status'
import enUS from '../../i18n/en-us'

const $t = (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      enUS,
    ) as string

describe('ChatBannerStack: mailbox + stamp-preparation banners (ticket #271)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders both banners as in-flow siblings, in order, neither absolutely positioned', async () => {
    const wrapper = mount(ChatBannerStack, {
      props: { stampStatus: 'Checking private stamp accounts…' },
      global: { mocks: { $t } },
    })
    useMailboxStatusStore().setProblem('unreachable', 7000)
    await wrapper.vm.$nextTick()

    const stack = wrapper.get('[data-testid="chat-banner-stack"]').element
    const mailbox = wrapper.get('[data-testid="mailbox-status"]').element
    const stamp = wrapper.get(
      '[data-testid="stamp-preparation-status"]',
    ).element
    expect(mailbox.parentElement).toBe(stack)
    expect(stamp.parentElement).toBe(stack)
    // Mailbox first, stamp second: a vertical stack, not two boxes on the same spot.
    expect(
      mailbox.compareDocumentPosition(stamp) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    for (const el of [stack, mailbox, stamp]) {
      expect(el.className).not.toMatch(/absolute|fixed|fullscreen/)
    }
    expect(stack.className).toMatch(/\bcolumn\b/)
  })

  it('renders no stamp banner without stamp status, and the stack is empty when healthy', () => {
    const wrapper = mount(ChatBannerStack, { global: { mocks: { $t } } })
    expect(
      wrapper.find('[data-testid="stamp-preparation-status"]').exists(),
    ).toBe(false)
    expect(wrapper.find('[data-testid="mailbox-status"]').exists()).toBe(false)
  })
})
