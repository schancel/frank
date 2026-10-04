/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Forum from './Forum.vue'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import type { WalletHandle } from '@frank/wallet/chain'
import type { ForumMessage } from '@frank/wallet/forum-model'
import enUS from '../i18n/en-us'
import frFR from '../i18n/fr-fr'

const mockFetchByTopic = jest.fn()
const mockDiscoverTopics = jest.fn()

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultTopicVoteValue: 100_000_000n,
    unit: 'MON',
    toDisplayAmount: (amount: bigint) => String(amount),
    fromDisplayAmount: (amount: string) => BigInt(amount),
    topics: {
      post: jest.fn(),
      fetchOne: jest.fn(),
      fetchByTopic: (...args: unknown[]) => mockFetchByTopic(...args),
      discoverTopics: (...args: unknown[]) => mockDiscoverTopics(...args),
      vote: jest.fn(),
    },
  },
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

function t(messages: unknown, key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  return typeof value === 'string' ? value : key
}

function makeMessage(overrides: Partial<ForumMessage> = {}): ForumMessage {
  return {
    poster: '0xposter',
    topic: 'stamp',
    voteWeightWei: '10000000',
    visibleTimestamp: { seconds: '1', nanoseconds: 0 },
    epoch: '00'.repeat(16),
    revision: '1',
    transactionHash: '11'.repeat(32),
    authorBurnTx: '0x01',
    blockNumber: '1',
    transactionIndex: '0',
    entries: [{ kind: 'post', message: 'test post content' }],
    payloadDigest: 'msg-digest-1',
    timestamp: new Date(),
    ...overrides,
  }
}

const testWallet = {
  identity: { address: { raw: '0xabc' }, displayAddress: '0xabc' },
}

function create503Error(): Error {
  const err = new Error('Request failed with status code 503')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(err as any).response = { status: 503, data: 'Service Unavailable' }
  return err
}

describe('Forum.vue outage and degraded states (#533)', () => {
  let unhandledRejections: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandledRejections.push(reason)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    unhandledRejections = []
    process.on('unhandledRejection', onUnhandled)
    mockDiscoverTopics.mockResolvedValue([])
    ;(useActiveWallet as jest.Mock).mockResolvedValue(testWallet)
  })

  afterEach(() => {
    process.removeListener('unhandledRejection', onUnhandled)
  })

  function mountForum(messages: unknown = enUS) {
    return mount(Forum, {
      global: {
        mocks: {
          $t: (key: string) => t(messages, key),
        },
        stubs: {
          ForumPost: {
            name: 'ForumPost',
            props: ['message', 'showParent', 'showReplies'],
            template:
              '<div class="forum-post-stub" :data-digest="message.payloadDigest">{{ message.entries[0]?.message }}</div>',
          },
          QSpinnerPuff: {
            name: 'QSpinnerPuff',
            template: '<div class="q-spinner-puff-stub" />',
          },
          QBanner: {
            name: 'QBanner',
            template:
              '<div class="q-banner" role="alert"><slot name="avatar" /><slot /><slot name="action" /></div>',
          },
          QBtn: {
            name: 'QBtn',
            props: ['label', 'loading'],
            template:
              '<button :disabled="loading">{{ label }}<slot /></button>',
          },
          QIcon: {
            name: 'QIcon',
            props: ['name'],
            template: '<i :data-icon="name">{{ name }}</i>',
          },
        },
      },
    })
  }

  it('renders a loading spinner puff before the initial fetch completes', () => {
    const store = useForumStore()
    expect(store.hasFetchedOnce).toBe(false)
    const wrapper = mountForum()

    expect(wrapper.find('.q-spinner-puff-stub').exists()).toBe(true)
    expect(wrapper.find('[data-test="forum-outage-state"]').exists()).toBe(
      false,
    )
  })

  it('all-failed forum refresh (HTTP 503) exits loading and renders clear outage alert with retry', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFetchByTopic.mockRejectedValue(create503Error())

    const store = useForumStore()
    try {
      await store.refreshMessages({
        wallet: testWallet as unknown as WalletHandle,
        topic: '',
      })
    } catch {
      // Rejection handled by caller
    }

    expect(store.hasFetchedOnce).toBe(true)
    expect(store.outageStatus).toBe('outage')

    const wrapper = mountForum()
    await flushPromises()

    // Loading spinner must be gone
    expect(wrapper.find('.q-spinner-puff-stub').exists()).toBe(false)

    // Outage state must be rendered
    const outageState = wrapper.get('[data-test="forum-outage-state"]')
    expect(outageState.attributes('role')).toBe('alert')
    expect(outageState.text()).toContain('Forum unavailable')
    expect(outageState.text()).toContain('Could not connect to the forum relay')

    // Retry button must be present
    const retryBtn = wrapper.get('[data-test="forum-retry-button"]')
    expect(retryBtn.text()).toContain('Retry')

    // Click retry: should invoke refreshMessages and handle repeated 503 without unhandled rejection
    await retryBtn.trigger('click')
    await flushPromises()

    expect(store.outageStatus).toBe('outage')
    expect(unhandledRejections).toHaveLength(0)

    consoleError.mockRestore()
  })

  it('renders outage state correctly in French (fr-FR parity)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFetchByTopic.mockRejectedValue(create503Error())

    const store = useForumStore()
    try {
      await store.refreshMessages({
        wallet: testWallet as unknown as WalletHandle,
        topic: '',
      })
    } catch {
      // handled
    }

    const wrapper = mountForum(frFR)
    await flushPromises()

    const outageState = wrapper.get('[data-test="forum-outage-state"]')
    expect(outageState.text()).toContain('Forum indisponible')
    expect(outageState.text()).toContain(
      'Impossible de se connecter au relais du forum',
    )
    expect(wrapper.get('[data-test="forum-retry-button"]').text()).toContain(
      'Réessayer',
    )

    consoleError.mockRestore()
  })

  it('recovers from outage when retry succeeds', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFetchByTopic.mockRejectedValue(create503Error())

    const store = useForumStore()
    try {
      await store.refreshMessages({
        wallet: testWallet as unknown as WalletHandle,
        topic: '',
      })
    } catch {
      // handled
    }

    const wrapper = mountForum()
    await flushPromises()
    expect(wrapper.find('[data-test="forum-outage-state"]').exists()).toBe(true)

    // Next attempt succeeds with a post
    const post = makeMessage({ payloadDigest: 'recovered-post' })
    mockFetchByTopic.mockResolvedValue([post])

    const retryBtn = wrapper.get('[data-test="forum-retry-button"]')
    await retryBtn.trigger('click')
    await flushPromises()

    // Outage state is replaced by the post
    expect(store.outageStatus).toBe('ok')
    expect(wrapper.find('[data-test="forum-outage-state"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('.forum-post-stub').exists()).toBe(true)
    expect(wrapper.find('[data-digest="recovered-post"]').exists()).toBe(true)

    consoleError.mockRestore()
  })

  it('previously loaded posts remain visible during a later outage with an alert banner', async () => {
    const store = useForumStore()
    const initialPost = makeMessage({
      payloadDigest: 'existing-post-1',
      entries: [{ kind: 'post', message: 'Previously saved post' }],
    })
    mockFetchByTopic.mockResolvedValue([initialPost])

    await store.refreshMessages({
      wallet: testWallet as unknown as WalletHandle,
      topic: '',
    })
    expect(store.messages).toHaveLength(1)
    expect(store.outageStatus).toBe('ok')

    const wrapper = mountForum()
    await flushPromises()

    expect(wrapper.find('.forum-post-stub').exists()).toBe(true)
    expect(wrapper.find('[data-digest="existing-post-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="forum-outage-banner"]').exists()).toBe(
      false,
    )

    // Now a later refresh hits an HTTP 503 outage
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFetchByTopic.mockRejectedValue(create503Error())

    try {
      await store.refreshMessages({
        wallet: testWallet as unknown as WalletHandle,
        topic: '',
      })
    } catch {
      // handled
    }

    await wrapper.vm.$nextTick()
    await flushPromises()

    // Previously loaded posts MUST remain visible
    expect(wrapper.find('.forum-post-stub').exists()).toBe(true)
    expect(wrapper.find('[data-digest="existing-post-1"]').exists()).toBe(true)

    // Outage banner MUST be rendered above posts with retry affordance
    const banner = wrapper.get('[data-test="forum-outage-banner"]')
    expect(banner.find('[role="alert"]').exists()).toBe(true)
    expect(banner.text()).toContain('Forum unavailable')
    expect(banner.text()).toContain(
      'Forum relay is currently unreachable. Showing saved posts.',
    )
    expect(banner.find('[data-test="forum-retry-button"]').exists()).toBe(true)

    // Zero unhandled rejections
    expect(unhandledRejections).toHaveLength(0)

    consoleError.mockRestore()
  })

  it('renders available results and reports degraded state on partial topic success', async () => {
    const store = useForumStore()
    const consoleError = jest.spyOn(console, 'error').mockImplementation()

    // Topic 'stamp' succeeds, topic 'news' fails with HTTP 503
    mockFetchByTopic.mockImplementation(async ({ topic }) => {
      if (topic === 'stamp') {
        return [makeMessage({ topic: 'stamp', payloadDigest: 'stamp-post-1' })]
      }
      throw create503Error()
    })

    await store.refreshMessages({
      wallet: testWallet as unknown as WalletHandle,
      topic: '',
    })
    expect(store.outageStatus).toBe('degraded')

    const wrapper = mountForum()
    await flushPromises()

    // Available post from successful topic is rendered
    expect(wrapper.find('[data-digest="stamp-post-1"]').exists()).toBe(true)

    // Degraded banner is rendered
    const banner = wrapper.get('[data-test="forum-degraded-banner"]')
    expect(banner.find('[role="alert"]').exists()).toBe(true)
    expect(banner.text()).toContain('Connection degraded')
    expect(banner.text()).toContain('Some forum topics could not be updated.')
    expect(banner.find('[data-test="forum-retry-button"]').exists()).toBe(true)

    // Zero unhandled rejections
    expect(unhandledRejections).toHaveLength(0)

    consoleError.mockRestore()
  })
})
