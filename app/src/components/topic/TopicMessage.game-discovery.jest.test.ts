/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import TopicMessage from './TopicMessage.vue'
import GameAnnouncementCard from './GameAnnouncementCard.vue'
import type { ForumMessage } from '@frank/wallet/forum-model'

const mockPush = jest.fn()

const mockOwnAddress = jest.requireActual('vue').ref<string | null>(null)
const mockOwnAddresses = jest.requireActual('vue').ref<string[]>([])
jest.mock('src/utils/own-address', () => {
  const actual = jest.requireActual('src/utils/own-address')
  return {
    ...actual,
    useReactiveOwnCanonicalAddress: () => mockOwnAddress,
    useReactiveOwnAddresses: () => mockOwnAddresses,
    sameCanonicalAddress: (first: string | null, second: string | null) =>
      Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
    isKnownOwnAddress: () => false,
  }
})

jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    topics: {
      games: { offering: '1000000' },
    },
    addOffering: jest.fn(),
  }),
}))

jest.mock('src/stores/forum', () => ({
  useForumStore: () => ({
    isOwnPost: () => false,
  }),
}))

jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: 'Player One' },
  }),
}))

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContactProfile: () => ({ name: 'Dealer', avatar: '' }),
    haveContact: () => false,
  }),
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({ identity: {} }),
}))

describe('TopicMessage.vue Game Table Discovery', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  function createGameTopicMessage(options: {
    gameName: string
    tableId: string
    host: string
    bot: string
    buyIn: string
    players: number
    maxPlayers: number
  }): ForumMessage {
    const payload = {
      version: 1,
      kind: 'game-table-announcement',
      gameName: options.gameName,
      tableId: options.tableId,
      hostAddress: options.host,
      buyInAmount: options.buyIn,
      currentPlayers: options.players,
      maxPlayers: options.maxPlayers,
      botAddress: options.bot,
      actionLink: `/chat/${options.bot}?join=${options.tableId}`,
      callToAction: 'Join Table',
    }

    return {
      poster: options.bot,
      topic: 'games',
      voteWeightWei: '1000000',
      payloadDigest: '0xabc123',
      timestamp: new Date(),
      visibleTimestamp: { seconds: '1', nanoseconds: 0 },
      epoch: '0',
      revision: '1',
      transactionHash: '0xtx',
      authorBurnTx: '0xburn',
      blockNumber: '1',
      transactionIndex: '0',
      entries: [
        {
          kind: 'post',
          title: `🎮 [${options.gameName}] Table #${options.tableId} (${options.players}/${options.maxPlayers} players)`,
          url: `/chat/${options.bot}?join=${options.tableId}`,
          message: `🎮 **${options.gameName} Table Created!**\n• Table ID: \`${
            options.tableId
          }\`\n• Host: \`${options.host}\`\n\n<!-- GAME_ANNOUNCEMENT:${JSON.stringify(
            payload,
          )} -->`,
        },
      ],
    }
  }

  function mountComponent(message: ForumMessage) {
    return mount(TopicMessage, {
      props: {
        message,
        topic: 'games',
      },
      global: {
        mocks: {
          $q: { dark: { isActive: true } },
          $router: { push: mockPush },
          $t: (k: string) => k,
        },
        stubs: {
          'q-separator': { template: '<hr />' },
          'q-space': { template: '<span />' },
          'q-card-section': { template: '<div><slot /></div>' },
          'q-tooltip': { template: '<span />' },
          'q-card': { template: '<div class="q-card"><slot /></div>' },
          'q-avatar': { template: '<div class="q-avatar"><slot /></div>' },
          'q-badge': { template: '<span class="q-badge"><slot /></span>' },
          'q-btn': {
            template:
              '<button class="q-btn" :data-to="$attrs.to" :data-test="$attrs[\'data-test\']" @click="$emit(\'click\')">{{ $attrs.label }}<slot /></button>',
          },
        },
      },
    })
  }

  it('renders GameAnnouncementCard with Join Table and Message Host buttons for poker table announcement', async () => {
    const message = createGameTopicMessage({
      gameName: "Texas Hold'em Poker",
      tableId: 'poker4455',
      host: '0x1111222233334444555566667777888899990000',
      bot: '0xPokerBot000000000000000000000000000000',
      buyIn: '1000 chips',
      players: 1,
      maxPlayers: 6,
    })

    const wrapper = mountComponent(message)

    const card = wrapper.findComponent(GameAnnouncementCard)
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain("Texas Hold'em Poker")
    expect(card.text()).toContain('#poker445')
    expect(card.text()).toContain('Buy-in: 1000 chips')

    // Direct Join Table button
    const joinBtn = wrapper.find('[data-test="join-table-btn"]')
    expect(joinBtn.exists()).toBe(true)
    expect(joinBtn.attributes('data-to')).toBe(
      '/chat/0xPokerBot000000000000000000000000000000?join=poker4455',
    )

    // Direct Message Host button
    const hostBtn = wrapper.find('[data-test="message-host-btn"]')
    expect(hostBtn.exists()).toBe(true)
    expect(hostBtn.attributes('data-to')).toBe(
      '/chat/0x1111222233334444555566667777888899990000',
    )

    // Click Join Table navigates to bot table chat
    await joinBtn.trigger('click')
    expect(mockPush).toHaveBeenCalledWith(
      '/chat/0xPokerBot000000000000000000000000000000?join=poker4455',
    )

    // Click Message Host navigates to host chat
    await hostBtn.trigger('click')
    expect(mockPush).toHaveBeenCalledWith(
      '/chat/0x1111222233334444555566667777888899990000',
    )
  })

  it('renders GameAnnouncementCard for Liar Dice table announcement', () => {
    const message = createGameTopicMessage({
      gameName: "Liar's Dice",
      tableId: 'dice7788',
      host: '0xBobHost11111111111111111111111111111111',
      bot: '0xDiceBot000000000000000000000000000000',
      buyIn: '0.2 MON',
      players: 2,
      maxPlayers: 6,
    })

    const wrapper = mountComponent(message)

    const card = wrapper.findComponent(GameAnnouncementCard)
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain("Liar's Dice")
    expect(card.text()).toContain('#dice778')
    expect(card.text()).toContain('Buy-in: 0.2 MON')
    expect(card.text()).toContain('Players: 2/6')
  })

  it('renders GameAnnouncementCard when topic message contains native CBOR kind "game" entry', () => {
    const message: ForumMessage = {
      poster: '0xBotAddress',
      topic: 'games',
      voteWeightWei: '1000000',
      payloadDigest: '0xcbor123',
      timestamp: new Date(),
      visibleTimestamp: { seconds: '1', nanoseconds: 0 },
      epoch: '0',
      revision: '1',
      transactionHash: '0xtx',
      authorBurnTx: '0xburn',
      blockNumber: '1',
      transactionIndex: '0',
      entries: [
        {
          kind: 'game',
          gameType: 'poker',
          tableId: 'poker99cbor',
          hostAddress: '0xAlice111111111111111111111111111111111111',
          buyInAmount: '200 chips',
          currentPlayers: 4,
          maxPlayers: 8,
          botAddress: '0xBotAddress',
          title: "🎮 Texas Hold'em Poker High Stakes",
          message: 'Join the high stakes poker table now!',
        },
      ],
    }

    const wrapper = mountComponent(message)

    const card = wrapper.findComponent(GameAnnouncementCard)
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain("Texas Hold'em Poker")
    expect(card.text()).toContain('#poker99c')
    expect(card.text()).toContain('Buy-in: 200 chips')
    expect(card.text()).toContain('Players: 4/8')
  })

  it('does not render GameAnnouncementCard for regular topic messages', () => {
    const message: ForumMessage = {
      poster: '0xUser',
      topic: 'general',
      voteWeightWei: '1000',
      payloadDigest: '0xnorm123',
      timestamp: new Date(),
      visibleTimestamp: { seconds: '1', nanoseconds: 0 },
      epoch: '0',
      revision: '1',
      transactionHash: '0xtx',
      authorBurnTx: '0xburn',
      blockNumber: '1',
      transactionIndex: '0',
      entries: [
        {
          kind: 'post',
          title: 'Hello Frank',
          message: 'This is just a regular message in the topic channel.',
        },
      ],
    }

    const wrapper = mountComponent(message)
    expect(wrapper.findComponent(GameAnnouncementCard).exists()).toBe(false)
  })
})
