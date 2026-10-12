/** @jest-environment jsdom */

import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'

import MailboxStatusIndicator from './MailboxStatusIndicator.vue'
import { useMailboxStatusStore } from '../../stores/mailbox-status'
import {
  messagingStateOwner,
  type MessagingReason,
} from '../../utils/messaging-state'
import enUS from '../../i18n/en-us'
import frFR from '../../i18n/fr-fr'

function t(messages: unknown, key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  return typeof value === 'string' ? value : key
}

function mountIndicator(messages: unknown = enUS) {
  return mount(MailboxStatusIndicator, {
    global: {
      mocks: { $t: (key: string) => t(messages, key) },
      stubs: {
        QBtn: { template: '<button v-bind="$attrs"><slot /></button>' },
        QTooltip: { template: '<span v-bind="$attrs"><slot /></span>' },
      },
    },
  })
}

describe('MailboxStatusIndicator', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders nothing while the inbox is healthy', () => {
    const wrapper = mountIndicator()
    expect(
      wrapper.find('[data-testid="mailbox-status-indicator"]').exists(),
    ).toBe(false)
  })

  it('says the relay does not offer messaging when the mailbox is disabled (404)', async () => {
    const wrapper = mountIndicator()
    useMailboxStatusStore().setProblem('unavailable', 14_000)
    await wrapper.vm.$nextTick()
    const indicator = wrapper.get('[data-testid="mailbox-status-indicator"]')
    expect(indicator.attributes('aria-label')).toContain(
      'Messaging service unavailable',
    )
    expect(indicator.attributes('aria-label')).toContain(
      'does not offer messaging',
    )
    expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe(
      'polite',
    )
  })

  it('says it cannot reach the server for a network failure, distinctly from a disabled mailbox', async () => {
    const wrapper = mountIndicator()
    useMailboxStatusStore().setProblem('unreachable', 14_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain("Can't reach the server")
    expect(wrapper.text()).not.toContain('Messaging service unavailable')
  })

  it('disappears when the poll recovers', async () => {
    const wrapper = mountIndicator()
    const status = useMailboxStatusStore()
    status.setProblem('rate-limited', 60_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('slow down')
    status.setOk()
    await wrapper.vm.$nextTick()
    expect(
      wrapper.find('[data-testid="mailbox-status-indicator"]').exists(),
    ).toBe(false)
  })

  it('opens details on tap without allowing the parent balance row to navigate', async () => {
    const wrapper = mountIndicator()
    useMailboxStatusStore().setProblem('unreachable', 14_000)
    await wrapper.vm.$nextTick()
    const parent = document.createElement('div')
    const parentClick = jest.fn()
    parent.addEventListener('click', parentClick)
    parent.appendChild(wrapper.element)
    await wrapper
      .get('[data-testid="mailbox-status-indicator"]')
      .trigger('click')
    expect(parentClick).not.toHaveBeenCalled()
    expect(
      (wrapper.vm as unknown as { detailsOpen: boolean }).detailsOpen,
    ).toBe(true)
  })

  it('is localized in French', async () => {
    const wrapper = mountIndicator(frFR)
    useMailboxStatusStore().setProblem('unreachable', 14_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Impossible de joindre le serveur')
  })
  describe.each([
    ['en-us', enUS],
    ['fr-fr', frFR],
  ] as const)('all problem states in %s', (_locale, messages) => {
    const expected = {
      'unavailable': messages.mailboxStatus.unavailable,
      'unreachable': messages.mailboxStatus.unreachable,
      'rate-limited': messages.mailboxStatus.rateLimited,
      'unauthorized': messages.mailboxStatus.unauthorized,
    } as const

    it.each(Object.keys(expected) as Array<keyof typeof expected>)(
      'renders the resolved text for %s',
      async state => {
        const wrapper = mountIndicator(messages)
        useMailboxStatusStore().setProblem(state, 1000)
        await wrapper.vm.$nextTick()
        const text =
          wrapper
            .get('[data-testid="mailbox-status-indicator"]')
            .attributes('aria-label') ?? ''
        expect(text).toBe(expected[state])
        expect(text).not.toMatch(/^mailboxStatus\./) // an unresolved key would echo back
        expect(text.length).toBeGreaterThan(10)
      },
    )

    it('gives each state distinct text', () => {
      expect(new Set(Object.values(expected)).size).toBe(4)
    })
  })

  it('en-us and fr-fr texts are hard-pinned for the 401 state', async () => {
    const en = mountIndicator(enUS)
    const fr = mountIndicator(frFR)
    useMailboxStatusStore().setProblem('unauthorized', 1000)
    await en.vm.$nextTick()
    expect(
      en
        .get('[data-testid="mailbox-status-indicator"]')
        .attributes('aria-label'),
    ).toBe('The server rejected your messaging login. Retrying.')
    expect(
      fr
        .get('[data-testid="mailbox-status-indicator"]')
        .attributes('aria-label'),
    ).toBe(
      'Le serveur a refusé votre connexion à la messagerie. Nouvelle tentative en cours.',
    )
  })

  describe('messaging that could not start', () => {
    afterEach(() => {
      messagingStateOwner.status = 'pending'
      messagingStateOwner.reason = null
    })
    const reasons: MessagingReason[] = [
      'account-unavailable',
      'relay-unreachable',
      'relay-rejected',
      'relay-misconfigured',
      'entry-refused',
      'device-clock',
      'storage',
    ]
    it.each(reasons)(
      'says in plain words that messaging is off for "%s", in both languages',
      async reason => {
        for (const messages of [enUS, frFR]) {
          const wrapper = mountIndicator(messages)
          messagingStateOwner.status = 'pending'
          messagingStateOwner.reason = reason
          await wrapper.vm.$nextTick()
          const text =
            wrapper
              .get('[data-testid="mailbox-status-indicator"]')
              .attributes('aria-label') ?? ''
          expect(text).not.toMatch(/^mailboxStatus\./)
          expect(text).toMatch(/^(Messaging is off|Messagerie désactivée)/)
        }
      },
    )
    it('shows nothing once messaging is on, and nothing before the first attempt', async () => {
      const wrapper = mountIndicator()
      await wrapper.vm.$nextTick()
      expect(
        wrapper.find('[data-testid="mailbox-status-indicator"]').exists(),
      ).toBe(false)
      messagingStateOwner.status = 'ready'
      messagingStateOwner.reason = null
      await wrapper.vm.$nextTick()
      expect(
        wrapper.find('[data-testid="mailbox-status-indicator"]').exists(),
      ).toBe(false)
    })
    it('no string mentions an operator installation, an approved bundle or a check button', () => {
      for (const messages of [enUS, frFR])
        expect(JSON.stringify(messages)).not.toMatch(
          /operator installation|Check installation|directoryProvisioning|approved (public )?bundle|installation par l/i,
        )
    })
  })
})
