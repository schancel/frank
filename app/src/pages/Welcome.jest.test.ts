/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import Welcome from './Welcome.vue'
import enUS from 'src/i18n/en-us'
import frFR from 'src/i18n/fr-fr'

type Messages = Record<string, unknown>

function translator(messages: Messages) {
  return (key: string, values: Record<string, string> = {}): string => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], messages)
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
  }
}

function mountWelcome(messages: Messages) {
  return mount(Welcome, {
    global: {
      mocks: { $t: translator(messages) },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<h1><slot /></h1>' },
        QBtn: {
          template:
            '<button :data-to="$attrs.to" v-bind="$attrs"><slot />{{ $attrs.label }}</button>',
        },
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
}

const text = (wrapper: ReturnType<typeof mountWelcome>, name: string): string =>
  wrapper.find(`[data-test="${name}"]`).text()

describe('Welcome: landing page for visitors without an account', () => {
  it('renders hero branding, title, and "Free speech is not free" tagline', () => {
    const wrapper = mountWelcome(enUS)
    const hero = text(wrapper, 'welcome-hero')
    expect(hero).toContain('Frank')
    expect(hero).toContain('Free speech is not free.')
    expect(hero).toContain(
      'Private, economically spam-resistant messaging on Monad.',
    )
    expect(hero).toContain('Monad')
    expect(hero).toContain('Permissionless Identity')
  })

  it('provides navigation action buttons to setup, forum, and docs', () => {
    const wrapper = mountWelcome(enUS)
    const createBtn = wrapper.find('[data-test="btn-create-account"]')
    expect(createBtn.exists()).toBe(true)
    expect(createBtn.attributes('data-to') || createBtn.attributes('to')).toBe(
      '/setup',
    )
    expect(createBtn.text()).toContain('Create Account')

    const browseBtn = wrapper.find('[data-test="btn-browse-forum"]')
    expect(browseBtn.exists()).toBe(true)
    expect(browseBtn.attributes('data-to') || browseBtn.attributes('to')).toBe(
      '/forum',
    )
    expect(browseBtn.text()).toContain('Browse Forum')

    const docsBtn = wrapper.find('[data-test="btn-read-docs"]')
    expect(docsBtn.exists()).toBe(true)
    expect(docsBtn.attributes('data-to') || docsBtn.attributes('to')).toBe(
      '/docs',
    )
    expect(docsBtn.text()).toContain('Read Documentation')
  })

  it('renders the core architectural pillars explaining how Frank works', () => {
    const wrapper = mountWelcome(enUS)
    const features = text(wrapper, 'welcome-features')
    expect(features).toContain('How Frank Works')
    expect(features).toContain('Free Speech Is Not Free')
    expect(features).toContain('Ambient Privacy & DKSAP')
    expect(features).toContain('Zero-PII Sovereign Identity')
    expect(features).toContain('Federated Mailbox Relays')
  })

  it('renders localized content in French', () => {
    const wrapper = mountWelcome(frFR)
    const hero = text(wrapper, 'welcome-hero')
    expect(hero).toContain("La liberté d'expression n'est pas gratuite.")
    expect(hero).toContain(
      'Messagerie privée et résistante au spam économique sur Monad.',
    )

    const features = text(wrapper, 'welcome-features')
    expect(features).toContain('Comment fonctionne Frank')
    expect(features).toContain("La liberté d'expression n'est pas gratuite")
    expect(features).toContain('Confidentialité ambiante et DKSAP')
  })

  it('emits toggleMyDrawerOpen when clicking the menu button', async () => {
    const wrapper = mountWelcome(enUS)
    const menuBtn = wrapper.find('[data-test="welcome-menu"]')
    expect(menuBtn.exists()).toBe(true)
    await menuBtn.trigger('click')
    expect(wrapper.emitted('toggleMyDrawerOpen')).toBeTruthy()
  })
})
