/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import GameAnnouncementCard from './GameAnnouncementCard.vue'
import type { ParsedGameAnnouncement } from 'src/utils/game-announcement'

const mockPush = jest.fn()

describe('GameAnnouncementCard.vue', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  const sampleAnnouncement: ParsedGameAnnouncement = {
    gameName: "Texas Hold'em Poker",
    gameType: 'poker',
    tableId: 'poker12345678',
    hostAddress: '0x1111222233334444555566667777888899990000',
    buyInAmount: '1000 chips',
    currentPlayers: 1,
    maxPlayers: 6,
    botAddress: '0xBotAddress000000000000000000000000000000',
    actionLink:
      '/chat/0xBotAddress000000000000000000000000000000?join=poker12345678',
    callToAction: 'Join Table',
  }

  it('renders game details, badges, and action buttons', () => {
    const wrapper = mount(GameAnnouncementCard, {
      props: {
        announcement: sampleAnnouncement,
      },
      global: {
        mocks: {
          $q: { dark: { isActive: true } },
          $router: { push: mockPush },
        },
        stubs: {
          'q-card': { template: '<div class="q-card"><slot /></div>' },
          'q-avatar': { template: '<div class="q-avatar"><slot /></div>' },
          'q-badge': { template: '<span class="q-badge"><slot /></span>' },
          'q-btn': {
            template:
              '<button class="q-btn" :data-to="$attrs.to" @click="$emit(\'click\')">{{ $attrs.label }}<slot /></button>',
          },
        },
      },
    })

    expect(wrapper.text()).toContain("Texas Hold'em Poker")
    expect(wrapper.text()).toContain('#poker123')
    expect(wrapper.text()).toContain('Buy-in: 1000 chips')
    expect(wrapper.text()).toContain('Players: 1/6')
    expect(wrapper.text()).toContain('0x1111...0000')

    // Verify buttons exist
    const joinBtn = wrapper.find('[data-test="join-table-btn"]')
    expect(joinBtn.exists()).toBe(true)
    expect(joinBtn.attributes('data-to')).toBe(
      '/chat/0xBotAddress000000000000000000000000000000?join=poker12345678',
    )

    const hostBtn = wrapper.find('[data-test="message-host-btn"]')
    expect(hostBtn.exists()).toBe(true)
    expect(hostBtn.attributes('data-to')).toBe(
      '/chat/0x1111222233334444555566667777888899990000',
    )
  })

  it('navigates to join route when Join Table is clicked', async () => {
    const wrapper = mount(GameAnnouncementCard, {
      props: {
        announcement: sampleAnnouncement,
      },
      global: {
        mocks: {
          $q: { dark: { isActive: false } },
          $router: { push: mockPush },
        },
        stubs: {
          'q-card': { template: '<div><slot /></div>' },
          'q-avatar': { template: '<div><slot /></div>' },
          'q-badge': { template: '<span><slot /></span>' },
          'q-btn': {
            template: '<button @click="$emit(\'click\')">{{ $attrs.label }}</button>',
          },
        },
      },
    })

    const joinBtn = wrapper.find('[data-test="join-table-btn"]')
    await joinBtn.trigger('click')

    expect(mockPush).toHaveBeenCalledWith(
      '/chat/0xBotAddress000000000000000000000000000000?join=poker12345678',
    )
  })

  it('navigates to host route when Message Host is clicked', async () => {
    const wrapper = mount(GameAnnouncementCard, {
      props: {
        announcement: sampleAnnouncement,
      },
      global: {
        mocks: {
          $q: { dark: { isActive: false } },
          $router: { push: mockPush },
        },
        stubs: {
          'q-card': { template: '<div><slot /></div>' },
          'q-avatar': { template: '<div><slot /></div>' },
          'q-badge': { template: '<span><slot /></span>' },
          'q-btn': {
            template: '<button @click="$emit(\'click\')">{{ $attrs.label }}</button>',
          },
        },
      },
    })

    const hostBtn = wrapper.find('[data-test="message-host-btn"]')
    await hostBtn.trigger('click')

    expect(mockPush).toHaveBeenCalledWith(
      '/chat/0x1111222233334444555566667777888899990000',
    )
  })

  it('omits Message Host button when host address is not available', () => {
    const noHostAnnouncement: ParsedGameAnnouncement = {
      gameName: "Liar's Dice",
      tableId: 'dice123',
      hostAddress: '',
      botAddress: '0xBot',
    }

    const wrapper = mount(GameAnnouncementCard, {
      props: {
        announcement: noHostAnnouncement,
      },
      global: {
        mocks: {
          $q: { dark: { isActive: false } },
          $router: { push: mockPush },
        },
        stubs: {
          'q-card': { template: '<div><slot /></div>' },
          'q-avatar': { template: '<div><slot /></div>' },
          'q-badge': { template: '<span><slot /></span>' },
          'q-btn': {
            template: '<button>{{ $attrs.label }}</button>',
          },
        },
      },
    })

    expect(wrapper.find('[data-test="join-table-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="message-host-btn"]').exists()).toBe(false)
  })
})
