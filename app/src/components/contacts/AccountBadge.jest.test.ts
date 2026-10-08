/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AccountBadge from './AccountBadge.vue'
import { useContactStore } from 'src/stores/contacts'

describe('AccountBadge.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const defaultStubs = {
    'q-badge': {
      template:
        '<span class="q-badge" :data-testid="$attrs[\'data-testid\']"><slot /></span>',
    },
    'q-icon': {
      template: '<i class="q-icon" />',
    },
  }

  const mountBadge = (props: Record<string, unknown>) => {
    return mount(AccountBadge, {
      props,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: defaultStubs,
      },
    })
  }

  it('renders nothing for an ordinary uncurated person', () => {
    const wrapper = mountBadge({
      address: '0x1111111111111111111111111111111111111111',
      accountType: 0,
      isBot: false,
    })
    expect(wrapper.find('.account-badge').exists()).toBe(false)
  })

  it('renders official badge for a curated person', () => {
    const wrapper = mountBadge({
      address: '0x1111111111111111111111111111111111111111',
      accountType: 0,
      curated: true,
    })
    expect(wrapper.find('[data-testid="badge-official"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('profile.badgeOfficial')
  })

  it('renders official faucet badge for a curated service with faucet role', () => {
    const wrapper = mountBadge({
      address: '0x2222222222222222222222222222222222222222',
      accountType: 2, // Service
      botRole: 2, // Faucet
      curated: true,
    })
    expect(wrapper.find('[data-testid="badge-official-faucet"]').exists()).toBe(
      true,
    )
    expect(wrapper.text()).toContain('profile.badgeFaucet')
  })

  it('renders official AI badge for a curated bot with assistant role', () => {
    const wrapper = mountBadge({
      address: '0x3333333333333333333333333333333333333333',
      accountType: 1, // Bot
      botRole: 1, // Assistant
      curated: true,
    })
    expect(wrapper.find('[data-testid="badge-official-ai"]').exists()).toBe(
      true,
    )
    expect(wrapper.text()).toContain('profile.badgeAi')
  })

  it('renders official game badge for a curated bot with game role', () => {
    const wrapper = mountBadge({
      address: '0x4444444444444444444444444444444444444444',
      accountType: 1, // Bot
      botRole: 3, // Game
      curated: true,
    })
    expect(wrapper.find('[data-testid="badge-official-game"]').exists()).toBe(
      true,
    )
    expect(wrapper.text()).toContain('profile.badgeOfficialGame')
  })

  it('renders uncurated bot badge for self-declared bot', () => {
    const wrapper = mountBadge({
      address: '0x5555555555555555555555555555555555555555',
      accountType: 1,
      curated: false,
    })
    expect(wrapper.find('[data-testid="badge-bot"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('profile.badgeBot')
  })

  it('renders uncurated game badge for self-declared game bot', () => {
    const wrapper = mountBadge({
      address: '0x6666666666666666666666666666666666666666',
      accountType: 1,
      botRole: 3,
      curated: false,
    })
    expect(wrapper.find('[data-testid="badge-game"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('profile.badgeGame')
  })

  it('renders official bot badge for a curated generic bot without role', () => {
    const wrapper = mountBadge({
      address: '0x8888888888888888888888888888888888888888',
      accountType: 1,
      curated: true,
    })
    expect(wrapper.find('[data-testid="badge-official-bot"]').exists()).toBe(
      true,
    )
    expect(wrapper.text()).toContain('profile.badgeOfficialBot')
  })

  it('renders official service badge for a curated generic service without role', () => {
    const wrapper = mountBadge({
      address: '0x9999999999999999999999999999999999999999',
      accountType: 2,
      curated: true,
    })
    expect(wrapper.find('[data-testid="badge-official-service"]').exists()).toBe(
      true,
    )
    expect(wrapper.text()).toContain('profile.badgeOfficialService')
  })

  it('infers game role for curated Blackjack Dealer when accountType/botRole are omitted', () => {
    const contactsStore = useContactStore()
    contactsStore.replaceCuratedDefaults([
      {
        address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        name: 'Blackjack Dealer',
      },
    ])
    contactsStore.addContact({
      address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      contact: {
        profile: {
          name: 'Blackjack Dealer',
        },
      },
    })

    const wrapper = mountBadge({
      address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(wrapper.find('[data-testid="badge-official-game"]').exists()).toBe(
      true,
    )
    expect(wrapper.text()).toContain('profile.badgeOfficialGame')
  })
})
