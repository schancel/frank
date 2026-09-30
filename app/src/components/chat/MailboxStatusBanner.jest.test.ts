/** @jest-environment jsdom */

import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'

import MailboxStatusBanner from './MailboxStatusBanner.vue'
import { useMailboxStatusStore } from '../../stores/mailbox-status'
import enUS from '../../i18n/en-us'
import frFR from '../../i18n/fr-fr'

function t(messages: unknown, key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  return typeof value === 'string' ? value : key
}

function mountBanner(messages: unknown = enUS) {
  return mount(MailboxStatusBanner, {
    global: { mocks: { $t: (key: string) => t(messages, key) } },
  })
}

describe('MailboxStatusBanner (ticket #271)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders nothing while the inbox is healthy', () => {
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="mailbox-status"]').exists()).toBe(false)
  })

  it('says the relay does not offer messaging when the mailbox is disabled (404)', async () => {
    const wrapper = mountBanner()
    useMailboxStatusStore().setProblem('unavailable', 14_000)
    await wrapper.vm.$nextTick()
    const banner = wrapper.get('[data-testid="mailbox-status"]')
    expect(banner.attributes('role')).toBe('status')
    expect(banner.text()).toContain('Messaging service unavailable')
    expect(banner.text()).toContain('does not offer messaging')
  })

  it('says it cannot reach the server for a network failure, distinctly from a disabled mailbox', async () => {
    const wrapper = mountBanner()
    useMailboxStatusStore().setProblem('unreachable', 14_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain("Can't reach the server")
    expect(wrapper.text()).not.toContain('Messaging service unavailable')
  })

  it('disappears when the poll recovers', async () => {
    const wrapper = mountBanner()
    const status = useMailboxStatusStore()
    status.setProblem('rate-limited', 60_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('slow down')
    status.setOk()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="mailbox-status"]').exists()).toBe(false)
  })

  it('is localized in French', async () => {
    const wrapper = mountBanner(frFR)
    useMailboxStatusStore().setProblem('unreachable', 14_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Impossible de joindre le serveur')
  })
})
