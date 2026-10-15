/** @jest-environment jsdom */
import { shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import type { MessageWithReplies } from 'src/stores/forum'
import ForumMessage from './ForumMessage.vue'
import ForumPost from './ForumPost.vue'
import TopicMessage from '../topic/TopicMessage.vue'
import AccountBadge from '../contacts/AccountBadge.vue'

const ADDRESS = '0x2222222222222222222222222222222222222222'
const mockOwnAddress = ref<string | null>(null)
const mockOwnAddresses = ref<string[]>([])
let mockOwnProfile: unknown = {}
let mockContactProfile: unknown = {}
let mockHasContact = false
const mockForum = {
  messages: ref([]),
  topics: ref([]),
  selectedTopic: ref('help'),
  getMessage: () => undefined,
  isOwnPost: () => false,
}

jest.mock('src/accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))
jest.mock('src/stores/forum', () => ({ useForumStore: () => mockForum }))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({ topics: { help: { offering: '0' } } }),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: mockOwnProfile }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    haveContact: () => mockHasContact,
    getContactProfile: () => mockContactProfile,
    isCurated: () => false,
  }),
}))
jest.mock('src/utils/own-address', () => ({
  ...jest.requireActual('src/utils/own-address'),
  useReactiveOwnCanonicalAddress: () => mockOwnAddress,
  useReactiveOwnAddresses: () => mockOwnAddresses,
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('./ForumMessageReplies.vue', () => ({ template: '<div />' }))

function message(poster = ADDRESS): MessageWithReplies {
  return {
    poster,
    topic: 'help',
    voteWeightWei: '0',
    entries: [],
    payloadDigest: 'ab'.repeat(32),
    timestamp: new Date(0),
    visibleTimestamp: { seconds: '0', nanoseconds: 0 },
    epoch: '00'.repeat(16),
    revision: '1',
    transactionHash: '11'.repeat(32),
    authorBurnTx: '0x01',
    blockNumber: '1',
    transactionIndex: '0',
    replies: [],
  }
}

const mountedCards: ReturnType<typeof shallowMount>[] = []
afterEach(() => {
  for (const wrapper of mountedCards.splice(0)) wrapper.unmount()
})

const components = [ForumMessage, ForumPost, TopicMessage]
describe.each(components)('author display in $name', component => {
  beforeEach(() => {
    mockOwnAddress.value = null
    mockOwnAddresses.value = []
    mockOwnProfile = {}
    mockContactProfile = {}
    mockHasContact = false
  })

  function mountAuthor(poster = ADDRESS) {
    const wrapper = shallowMount(component, {
      props: { message: message(poster), topic: 'help' },
      global: {
        renderStubDefaultSlot: true,
        stubs: {
          AccountBadge: false,
          QBtn: true,
          QCard: true,
          QCardSection: true,
          QCardActions: true,
          QIcon: true,
          QSeparator: true,
          QChip: true,
          QSpace: true,
          QTooltip: true,
          QBadge: true,
          QSpinnerDots: true,
          RouterLink: true,
        },
        mocks: { $q: { dark: { isActive: false } }, $t: (key: string) => key },
      },
    })
    mountedCards.push(wrapper)
    return wrapper
  }

  it('preserves valid contact labels, zero/false badge fields and contact route', () => {
    mockHasContact = true
    mockContactProfile = Object.freeze({
      name: 'Alice',
      accountType: 0,
      botRole: 0,
      isBot: false,
    })
    const wrapper = mountAuthor()
    expect(wrapper.get('.author-btn').text()).toBe('Alice')
    expect(
      wrapper.get('.author-btn .text-weight-bold').classes(),
    ).not.toContain('font-mono')
    expect(wrapper.get('.author-btn').attributes('to')).toBe(`/chat/${ADDRESS}`)
    expect(wrapper.getComponent(AccountBadge).props()).toEqual(
      expect.objectContaining({
        address: ADDRESS,
        accountType: 0,
        botRole: 0,
        isBot: false,
      }),
    )
    wrapper.unmount()
  })

  it('ignores malformed contact fields and shows the existing address fallback', () => {
    mockHasContact = true
    mockContactProfile = Object.freeze({
      name: { hostile: 'object label' },
      accountType: '1',
      botRole: {},
      isBot: 'true',
    })
    const wrapper = mountAuthor()
    expect(wrapper.get('.author-btn').text()).toBe('0x222222...222222')
    expect(wrapper.get('.author-btn .text-weight-bold').classes()).toContain(
      'font-mono',
    )
    expect(wrapper.get('.author-btn').attributes('to')).toBe(`/chat/${ADDRESS}`)
    expect(wrapper.getComponent(AccountBadge).props()).toEqual(
      expect.objectContaining({
        accountType: undefined,
        botRole: undefined,
        isBot: undefined,
      }),
    )
    wrapper.unmount()
  })

  const selfProfiles: [Record<string, unknown>, string][] = [
    [{ name: 'Own name', username: 'handle' }, 'Own name'],
    [{ name: '', username: 'handle' }, 'handle'],
    [{ name: {}, username: 'handle' }, 'handle'],
    [{ name: {}, username: [] }, 'You'],
  ]
  it.each(selfProfiles)(
    'uses admitted self names and existing fallback for %p',
    (profile, expected) => {
      mockOwnAddress.value = ADDRESS
      mockOwnAddresses.value = [ADDRESS]
      mockOwnProfile = Object.freeze({
        ...profile,
        accountType: 0,
        botRole: 0,
        isBot: false,
      })
      const wrapper = mountAuthor()
      expect(wrapper.get('.author-btn').text()).toBe(expected)
      expect(wrapper.get('.author-btn').attributes('to')).toBe('/profile')
      expect(wrapper.getComponent(AccountBadge).props()).toEqual(
        expect.objectContaining({ accountType: 0, botRole: 0, isBot: false }),
      )
      wrapper.unmount()
    },
  )

  it.each([undefined, null, {}, { name: '' }])(
    'uses address fallback for missing or empty contact profile %p',
    profile => {
      mockHasContact = true
      mockContactProfile = profile
      const wrapper = mountAuthor()
      expect(wrapper.get('.author-btn').text()).toBe('0x222222...222222')
      expect(wrapper.get('.author-btn .text-weight-bold').classes()).toContain(
        'font-mono',
      )
      wrapper.unmount()
    },
  )

  it('keeps an absent author anonymous without an identity route or badge', () => {
    const wrapper = mountAuthor('')
    expect(wrapper.get('.author-btn').text()).toBe('Anonymous')
    expect(wrapper.get('.author-btn').attributes('to')).toBeUndefined()
    expect(wrapper.findComponent(AccountBadge).exists()).toBe(false)
    wrapper.unmount()
  })
})
