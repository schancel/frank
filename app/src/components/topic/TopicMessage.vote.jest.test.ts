/** @jest-environment jsdom */
import { shallowMount } from '@vue/test-utils'
import TopicMessage from './TopicMessage.vue'
import { errorNotify, infoNotify } from 'src/utils/notifications'

const mockAddOffering = jest.fn()

jest.mock('src/accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ revision: 1, status: 'ready' }),
}))

jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    topics: {
      help: { offering: '1000000' },
    },
    addOffering: (...args: unknown[]) => mockAddOffering(...args),
  }),
}))

jest.mock('src/stores/forum', () => ({
  useForumStore: () => ({
    isOwnPost: () => false,
  }),
}))

jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: 'Alice Local' },
  }),
}))

jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContactProfile: () => ({ name: 'x', avatar: '' }),
    haveContact: () => false,
  }),
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({ identity: {} }),
}))

jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
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

function mountTopicMessage(
  overrides: {
    payloadDigest?: string
    voteWeightWei?: string
    topic?: string
  } = {},
) {
  const digest = overrides.payloadDigest ?? 'ab'.repeat(32)
  const initialWeight = overrides.voteWeightWei ?? '0'
  return shallowMount(TopicMessage, {
    props: {
      topic: overrides.topic ?? 'help',
      message: {
        poster: '0x1',
        voteWeightWei: initialWeight,
        visibleTimestamp: { seconds: '1', nanoseconds: 0 },
        epoch: '00'.repeat(16),
        revision: '1',
        transactionHash: '11'.repeat(32),
        authorBurnTx: '0x01',
        blockNumber: '1',
        transactionIndex: '0',
        replies: [],
        entries: [{ kind: 'post', title: 't', message: 'm' }],
        payloadDigest: digest,
        topic: overrides.topic ?? 'help',
        timestamp: new Date(),
      } as any,
    },
    global: {
      mocks: {
        $t: (key: string) => key,
        $q: { dark: { isActive: false } },
      },
    },
  })
}

jest.setTimeout(10_000)

describe('TopicMessage vote handler and loading state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sets loading and disable attributes on vote up button while in-flight', async () => {
    let resolveOffering!: () => void
    const offeringPromise = new Promise<void>(resolve => {
      resolveOffering = resolve
    })
    mockAddOffering.mockImplementationOnce(() => offeringPromise)

    const wrapper = mountTopicMessage()
    const vm = wrapper.vm as any

    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('disable'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('loading'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('disable'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('loading'),
    ).toBe('false')

    vm.addVotes(1)

    // Wait for the 1s debounce to expire and addOffering to be invoked
    await new Promise<void>(resolve => {
      const interval = setInterval(() => {
        if (mockAddOffering.mock.calls.length > 0) {
          clearInterval(interval)
          resolve()
        }
      }, 25)
    })
    await wrapper.vm.$nextTick()

    expect(vm.isVoting).toBe(true)
    expect(vm.activeVoteDirection).toBe(1)
    expect(mockAddOffering).toHaveBeenCalledTimes(1)
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('disable'),
    ).toBe('true')
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('disable'),
    ).toBe('true')
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('loading'),
    ).toBe('true')
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('loading'),
    ).toBe('false')

    // Resolve in-flight operation
    resolveOffering()
    await new Promise(resolve => setTimeout(resolve, 50))
    await wrapper.vm.$nextTick()

    expect(vm.isVoting).toBe(false)
    expect(vm.activeVoteDirection).toBe(0)
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('loading'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('disable'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('disable'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('loading'),
    ).toBe('false')

    wrapper.unmount()
  })

  it('sets loading attribute on downvote button when downvoting', async () => {
    let resolveOffering!: () => void
    const offeringPromise = new Promise<void>(resolve => {
      resolveOffering = resolve
    })
    mockAddOffering.mockImplementationOnce(() => offeringPromise)

    const wrapper = mountTopicMessage()
    const vm = wrapper.vm as any

    vm.addVotes(-1)

    await new Promise<void>(resolve => {
      const interval = setInterval(() => {
        if (mockAddOffering.mock.calls.length > 0) {
          clearInterval(interval)
          resolve()
        }
      }, 25)
    })
    await wrapper.vm.$nextTick()

    expect(vm.isVoting).toBe(true)
    expect(vm.activeVoteDirection).toBe(-1)
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('loading'),
    ).toBe('true')
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('loading'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('disable'),
    ).toBe('true')
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('disable'),
    ).toBe('true')

    resolveOffering()
    await new Promise(resolve => setTimeout(resolve, 50))
    await wrapper.vm.$nextTick()

    expect(vm.isVoting).toBe(false)
    expect(vm.activeVoteDirection).toBe(0)
    expect(
      wrapper.find('[data-test="forum-vote-down"]').attributes('loading'),
    ).toBe('false')
    expect(
      wrapper.find('[data-test="forum-vote-up"]').attributes('loading'),
    ).toBe('false')

    wrapper.unmount()
  })
})
