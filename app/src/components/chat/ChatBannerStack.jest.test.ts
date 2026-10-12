/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'

import ChatBannerStack from './ChatBannerStack.vue'
describe('ChatBannerStack: transient stamp preparation', () => {
  it('keeps the stamp banner in flow without a mailbox banner', () => {
    const wrapper = mount(ChatBannerStack, {
      props: { stampStatus: 'Checking private stamp accounts…' },
    })
    const stack = wrapper.get('[data-testid="chat-banner-stack"]').element
    const stamp = wrapper.get(
      '[data-testid="stamp-preparation-status"]',
    ).element
    expect(stamp.parentElement).toBe(stack)
    for (const el of [stack, stamp]) {
      expect(el.className).not.toMatch(/absolute|fixed|fullscreen/)
    }
    expect(stack.className).toMatch(/\bcolumn\b/)
    expect(wrapper.find('[data-testid="mailbox-status"]').exists()).toBe(false)
  })

  it('renders no banner without stamp status', () => {
    const wrapper = mount(ChatBannerStack)
    expect(
      wrapper.find('[data-testid="stamp-preparation-status"]').exists(),
    ).toBe(false)
    expect(wrapper.find('[data-testid="mailbox-status"]').exists()).toBe(false)
  })
})
