/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'

import ForumMessage from './ForumMessage.vue'
import ForumPost from './ForumPost.vue'
import ForumMessageReplies from './ForumMessageReplies.vue'
import enUS from '../../i18n/en-us'

const parentDigest = 'aa'.repeat(32)
const mockIndexedMessages: Record<string, unknown> = {}

jest.mock('src/accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ revision: 1, status: 'ready' }),
}))
jest.mock('pinia', () => ({
  ...jest.requireActual('pinia'),
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: {} }),
}))
jest.mock('src/utils/own-address', () => ({
  ...jest.requireActual('src/utils/own-address'),
  useReactiveOwnCanonicalAddress: () => jest.requireActual('vue').ref(null),
  useReactiveOwnAddresses: () => jest.requireActual('vue').ref([]),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () =>
    jest.requireActual('vue').reactive({
      messages: [],
      topics: [],
      selectedTopic: '',
      ownPostDigests: [],
      isOwnPost: () => false,
      getMessage: (digest: string) => mockIndexedMessages[digest] ?? null,
    }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContactProfile: () => ({}),
    haveContact: () => false,
  }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({ identity: {} }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultTopicVoteValue: 1_000_000n,
    toDisplayAmount: (n: bigint) => n.toString(),
  },
}))
jest.mock('src/utils/chain-amount', () => ({
  formatRawAmount: (_chain: unknown, value: string) => `${value} MON`,
  formatCompactAmount: (_chain: unknown, value: string) => `${value} MON`,
}))
jest.mock('../../utils/markdown', () => ({ renderMarkdown: () => '' }))

function t(key: string, params?: Record<string, unknown>): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS)
  const text = typeof value === 'string' ? value : key
  return text.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )
}

function forumMessage(digest: string, overrides: object = {}) {
  return {
    poster: '0xabcdef0123456789abcdef0123456789abcdef01',
    voteWeightWei: '0',
    visibleTimestamp: { seconds: '1', nanoseconds: 0 },
    epoch: '00'.repeat(16),
    revision: '1',
    transactionHash: '11'.repeat(32),
    authorBurnTx: '0x01',
    blockNumber: '1',
    transactionIndex: '0',
    replies: [],
    entries: [{ kind: 'post', message: 'm' }],
    payloadDigest: digest,
    topic: 'help',
    timestamp: new Date(),
    ...overrides,
  }
}

// vue-router's ESM build does not load under this jest config, so RouterLink is a thin stub
// that navigates through the mocked router exactly as the real link does on click.
const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to" @click.prevent="$router.push(to)"><slot /></a>',
}

function mountCard(
  component: typeof ForumPost | typeof ForumMessage,
  message: object,
  props: object = {},
) {
  const router = { push: jest.fn() }
  const card = shallowMount(component, {
    props: { message: message as never, ...props },
    global: {
      mocks: { $t: t, $q: { dark: { isActive: false } }, $router: router },
      stubs: { ForumParentLink: false, RouterLink: RouterLinkStub },
    },
  })
  return { card, router }
}

afterEach(() => {
  for (const key of Object.keys(mockIndexedMessages))
    delete mockIndexedMessages[key]
})

describe.each([
  ['feed card (ForumPost)', ForumPost],
  ['thread card (ForumMessage)', ForumMessage],
])('%s parent link', (_name, component) => {
  it('links a reply to its parent thread, labelled with the parent title', async () => {
    mockIndexedMessages[parentDigest] = forumMessage(parentDigest, {
      entries: [{ kind: 'post', title: 'Launch notes', message: 'body' }],
    })
    const { card, router } = mountCard(
      component,
      forumMessage('bb'.repeat(32), { parentDigest }),
    )

    const link = card.get('[data-test="forum-parent-link"]')
    expect(link.text()).toBe('↳ Reply to Launch notes')
    await link.trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith(`/forum/${parentDigest}`)
  })

  it('falls back to the parent author when the parent has no title', async () => {
    mockIndexedMessages[parentDigest] = forumMessage(parentDigest)
    const { card } = mountCard(
      component,
      forumMessage('bb'.repeat(32), { parentDigest }),
    )
    const text = card.get('[data-test="forum-parent-link"]').text()
    expect(text.startsWith('↳ Reply to 0x')).toBe(true)
  })

  it('links by digest when the parent has not been fetched', async () => {
    const { card, router } = mountCard(
      component,
      forumMessage('bb'.repeat(32), { parentDigest }),
    )

    const link = card.get('[data-test="forum-parent-link"]')
    expect(link.text()).toBe(`↳ Reply to ${parentDigest.slice(0, 8)}`)
    await link.trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith(`/forum/${parentDigest}`)
  })

  it('shows no parent link on a top-level post', async () => {
    const { card } = mountCard(component, forumMessage('cc'.repeat(32)))
    expect(card.find('[data-test="forum-parent-link"]').exists()).toBe(false)
  })
})

describe('nested thread replies', () => {
  it('skip the parent link because they sit inside the parent card', () => {
    const { card } = mountCard(
      ForumMessage,
      forumMessage('dd'.repeat(32), { parentDigest }),
      { showParentLink: false },
    )
    expect(card.find('[data-test="forum-parent-link"]').exists()).toBe(false)
  })

  it('are rendered by ForumMessageReplies with the link turned off', () => {
    const replies = shallowMount(ForumMessageReplies, {
      props: { messages: [forumMessage('dd'.repeat(32), { parentDigest })] },
      global: {
        stubs: {
          AMessage: {
            props: ['message', 'showParentLink'],
            template:
              '<div class="reply" :data-link="String(showParentLink)" />',
          },
        },
      },
    })
    expect(replies.get('.reply').attributes('data-link')).toBe('false')
  })
})
