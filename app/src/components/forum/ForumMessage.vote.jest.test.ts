/** @jest-environment jsdom */
// The vote handler of the forum message card (ticket #273 review): a failed burn must be shown, a
// burn that landed but could not be read back must not invite a retry.

import { shallowMount } from '@vue/test-utils'

import ForumMessage from './ForumMessage.vue'
import { BurnRefreshError } from 'src/utils/burn-refresh-error'
import { errorNotify, infoNotify } from 'src/utils/notifications'

const mockAddOffering = jest.fn()
const mockSetStampPreparationStatus = jest.fn()
const mockApplyOptimisticVote = jest.fn()
const mockRollbackOptimisticVote = jest.fn()
const mockIndexedMessages: Record<
  string,
  { payloadDigest: string; voteWeightWei: string }
> = jest.requireActual('vue').reactive({})

jest.mock('src/accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ revision: 1, status: 'ready' }),
}))
jest.mock('pinia', () => ({
  ...jest.requireActual('pinia'),
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
const mockProfile = jest.requireActual('vue').reactive({
  profile: { name: 'Alice Local' } as { name?: string; username?: string },
})
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => mockProfile,
}))
const mockOwnAddress = jest.requireActual('vue').ref<string | null>(null)
const mockOwnAddresses = jest.requireActual('vue').ref<string[]>([])
const mockOwnPostDigests: string[] = []
jest.mock('src/utils/own-address', () => {
  const actual = jest.requireActual('src/utils/own-address')
  return {
    ...actual,
    useReactiveOwnCanonicalAddress: () => mockOwnAddress,
    useReactiveOwnAddresses: () => mockOwnAddresses,
    sameCanonicalAddress: (first: string | null, second: string | null) =>
      Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
  }
})
jest.mock('src/stores/forum', () => ({
  useForumStore: () =>
    jest.requireActual('vue').reactive({
      messages: [],
      topics: [],
      selectedTopic: '',
      ownPostDigests: mockOwnPostDigests,
      isOwnPost: (digest?: string) => {
        if (!digest) return false
        const norm = digest.toLowerCase().replace(/^0x/, '')
        return mockOwnPostDigests.some(
          d => d.toLowerCase().replace(/^0x/, '') === norm,
        )
      },
      getMessage: (digest: string) => mockIndexedMessages[digest],
      addOffering: (...args: unknown[]) => mockAddOffering(...args),
      applyOptimisticVote: (args: {
        payloadDigest: string
        deltaWei: bigint
      }) => {
        mockApplyOptimisticVote(args)
        const msg = mockIndexedMessages[args.payloadDigest]
        if (msg) {
          msg.voteWeightWei = (
            BigInt(msg.voteWeightWei || '0') + args.deltaWei
          ).toString()
        }
      },
      rollbackOptimisticVote: (args: {
        payloadDigest: string
        deltaWei: bigint
      }) => {
        mockRollbackOptimisticVote(args)
        const msg = mockIndexedMessages[args.payloadDigest]
        if (msg) {
          msg.voteWeightWei = (
            BigInt(msg.voteWeightWei || '0') - args.deltaWei
          ).toString()
        }
      },
      setStampPreparationStatus: (...args: unknown[]) =>
        mockSetStampPreparationStatus(...args),
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
jest.mock('./ForumMessageReplies.vue', () => ({ template: '<div />' }))
jest.mock('../../utils/markdown', () => ({ renderMarkdown: () => '' }))

const messages: Record<string, string> = {
  'stampPreparation.votedRefreshFailed': 'VOTED_REFRESH_FAILED',
  'stampPreparation.voting': 'VOTING…',
  'chat.stampPreparationChecking': 'CHECKING_ACCOUNTS',
  'chat.stampPreparationReady': 'READY_SENDING',
}

function mountCard(
  overrides: {
    payloadDigest?: string
    voteWeightWei?: string
    notInStore?: boolean
    poster?: string
    isOwn?: boolean
  } = {},
) {
  const digest = overrides.payloadDigest ?? 'ab'.repeat(32)
  const initialWeight = overrides.voteWeightWei ?? '0'
  if (!overrides.notInStore) {
    mockIndexedMessages[digest] = {
      payloadDigest: digest,
      voteWeightWei: initialWeight,
    }
  }
  return shallowMount(ForumMessage, {
    props: {
      message: {
        poster: 'poster' in overrides ? overrides.poster : '0x1',
        isOwn: overrides.isOwn,
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
        topic: 'help',
        timestamp: new Date(),
      } as never,
    },
    global: {
      mocks: {
        $t: (key: string) => messages[key] ?? key,
        $q: { dark: { isActive: false } },
      },
    },
  })
}

async function vote(wrapper: ReturnType<typeof mountCard>) {
  ;(wrapper.vm as unknown as { addVotes(n: number): void }).addVotes(1)
  // The card debounces votes for one second before burning.
  await new Promise(resolve => setTimeout(resolve, 1_150))
}

jest.setTimeout(10_000)
beforeEach(() => {
  jest.clearAllMocks()
  for (const key of Object.keys(mockIndexedMessages)) {
    delete mockIndexedMessages[key]
  }
})

describe('ForumMessage vote handler', () => {
  it('automatically updates the counter immediately on click before relaying the transaction', async () => {
    const wrapper = mountCard()
    const vm = wrapper.vm as unknown as {
      addVotes(n: number): void
      displayedVoteWeight: string
      voteStatus: string | null
    }

    expect(wrapper.text()).toContain('0 MON')
    expect(vm.displayedVoteWeight).toBe('0')
    expect(vm.voteStatus).toBeNull()

    vm.addVotes(1)
    await wrapper.vm.$nextTick()

    // Immediately updated before debounce or network
    expect(vm.displayedVoteWeight).toBe('1000000')
    expect(wrapper.text()).toContain('1000000 MON')
    expect(vm.voteStatus).toBe('VOTING…')
    expect(mockSetStampPreparationStatus).toHaveBeenCalledWith('VOTING…')
    expect(wrapper.find('[data-test="vote-status"]').text()).toContain(
      'VOTING…',
    )

    vm.addVotes(1)
    await wrapper.vm.$nextTick()
    expect(vm.displayedVoteWeight).toBe('2000000')
    expect(wrapper.text()).toContain('2000000 MON')

    wrapper.unmount()
  })

  it('automatically updates the counter immediately when the post is not in the store', async () => {
    const wrapper = mountCard({ notInStore: true })
    const vm = wrapper.vm as unknown as {
      addVotes(n: number): void
      displayedVoteWeight: string
      voteStatus: string | null
    }

    expect(wrapper.text()).toContain('0 MON')
    expect(vm.displayedVoteWeight).toBe('0')
    expect(vm.voteStatus).toBeNull()

    vm.addVotes(1)
    await wrapper.vm.$nextTick()

    expect(vm.displayedVoteWeight).toBe('1000000')
    expect(wrapper.text()).toContain('1000000 MON')
    expect(vm.voteStatus).toBe('VOTING…')
    expect(mockSetStampPreparationStatus).toHaveBeenCalledWith('VOTING…')

    wrapper.unmount()
  })

  it('indicates that it is preparing or sending transactions and disables buttons while in-flight', async () => {
    let capturedProgress: ((progress: { stage: string }) => void) | undefined
    let resolveOffering!: () => void
    const offeringPromise = new Promise<void>(resolve => {
      resolveOffering = resolve
    })
    mockAddOffering.mockImplementationOnce(
      async ({ onPreparationProgress }) => {
        capturedProgress = onPreparationProgress
        return offeringPromise
      },
    )

    const wrapper = mountCard()
    const vm = wrapper.vm as unknown as {
      addVotes(n: number): void
      isVoting: boolean
      voteStatus: string | null
    }

    vm.addVotes(1)
    expect(mockSetStampPreparationStatus).toHaveBeenCalledWith('VOTING…')

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
    expect(mockAddOffering).toHaveBeenCalledTimes(1)
    expect(vm.voteStatus).toBe('CHECKING_ACCOUNTS')
    expect(mockSetStampPreparationStatus).toHaveBeenCalledWith(
      'CHECKING_ACCOUNTS',
    )

    // Simulate progress updates
    capturedProgress?.({ stage: 'ready' })
    await wrapper.vm.$nextTick()
    expect(vm.voteStatus).toBe('READY_SENDING')
    expect(mockSetStampPreparationStatus).toHaveBeenCalledWith('READY_SENDING')

    // Resolve in-flight operation
    resolveOffering()
    await new Promise(resolve => setTimeout(resolve, 50))
    await wrapper.vm.$nextTick()

    expect(vm.isVoting).toBe(false)
    expect(vm.voteStatus).toBeNull()
    expect(mockSetStampPreparationStatus).toHaveBeenLastCalledWith(null)

    wrapper.unmount()
  })

  it('rolls back the optimistic counter when the vote transaction fails before landing', async () => {
    const failure = new Error('RPC error')
    mockAddOffering.mockRejectedValueOnce(failure)

    const wrapper = mountCard()
    const vm = wrapper.vm as unknown as {
      addVotes(n: number): void
      displayedVoteWeight: string
    }

    vm.addVotes(1)
    expect(vm.displayedVoteWeight).toBe('1000000')

    await new Promise(resolve => setTimeout(resolve, 1_150))
    await wrapper.vm.$nextTick()

    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(vm.displayedVoteWeight).toBe('0')
    expect(wrapper.text()).toContain('0 MON')
  })

  it('shows an error when the vote fails (it must not be swallowed)', async () => {
    const failure = new Error('Nothing was sent')
    mockAddOffering.mockRejectedValueOnce(failure)

    await vote(mountCard())

    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(infoNotify).not.toHaveBeenCalled()
  })

  it('says the vote was sent but refreshing failed, keeping the optimistic counter without an error toast', async () => {
    mockAddOffering.mockRejectedValueOnce(
      new BurnRefreshError('vote', new Error('read failed')),
    )

    const wrapper = mountCard()
    const vm = wrapper.vm as unknown as {
      addVotes(n: number): void
      displayedVoteWeight: string
    }

    vm.addVotes(1)
    expect(vm.displayedVoteWeight).toBe('1000000')

    await new Promise(resolve => setTimeout(resolve, 1_150))
    await wrapper.vm.$nextTick()

    expect(infoNotify).toHaveBeenCalledWith('VOTED_REFRESH_FAILED')
    expect(errorNotify).not.toHaveBeenCalled()
    // Retained because the burn actually landed
    expect(vm.displayedVoteWeight).toBe('1000000')
  })

  it('consumes the pending votes either way, so a failure is not re-sent with the next click', async () => {
    mockAddOffering.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mountCard()

    await vote(wrapper)

    expect((wrapper.vm as unknown as { voteAmount: bigint }).voteAmount).toBe(
      0n,
    )
  })

  it('sends the vote once on success and shows nothing', async () => {
    mockAddOffering.mockResolvedValueOnce(undefined)

    await vote(mountCard())

    expect(mockAddOffering).toHaveBeenCalledTimes(1)
    expect(errorNotify).not.toHaveBeenCalled()
    expect(infoNotify).not.toHaveBeenCalled()
  })
})

it('preserves a wide default vote exactly in the transient queue', async () => {
  const chain = jest.requireMock('@frank/wallet/chain').activeChain
  const previous = chain.defaultTopicVoteValue
  chain.defaultTopicVoteValue = 9007199254740993n
  try {
    mockAddOffering.mockResolvedValueOnce(undefined)
    const wrapper = mountCard()
    await vote(wrapper)
    expect(mockAddOffering).toHaveBeenCalledWith(
      expect.objectContaining({ satoshis: 9007199254740993n }),
    )
    wrapper.unmount()
  } finally {
    chain.defaultTopicVoteValue = previous
  }
})
it('does not burn queued intent after the card unmounts', async () => {
  const wrapper = mountCard()
  ;(wrapper.vm as unknown as { addVotes(n: number): void }).addVotes(1)
  wrapper.unmount()
  await new Promise(resolve => setTimeout(resolve, 1150))
  expect(mockAddOffering).not.toHaveBeenCalled()
})

describe('ForumMessage author resolution and display (#1046)', () => {
  it('displays the local user profile name on own posts and routes to /profile', () => {
    mockOwnAddress.value = '0xmyaddress'
    mockProfile.profile.name = 'Alice Local'

    // Case A: poster matches own address
    const wrapperAddr = mountCard({ poster: '0xmyaddress' })
    expect(wrapperAddr.find('.author-btn').text()).toBe('Alice Local')
    expect(wrapperAddr.find('.author-btn').attributes('to')).toBe('/profile')

    // Case B: post tracked as own post via isOwn flag
    const wrapperOwn = mountCard({ poster: '0xburnaddress', isOwn: true })
    expect(wrapperOwn.find('.author-btn').text()).toBe('Alice Local')
    expect(wrapperOwn.find('.author-btn').attributes('to')).toBe('/profile')
  })

  it('falls back to username or "You" if own profile name is not set', () => {
    mockOwnAddress.value = '0xmyaddress'
    mockProfile.profile.name = undefined
    mockProfile.profile.username = 'alice_user'

    const wrapperUser = mountCard({ poster: '0xmyaddress' })
    expect(wrapperUser.find('.author-btn').text()).toBe('alice_user')
    expect(wrapperUser.find('.author-btn').attributes('to')).toBe('/profile')

    mockProfile.profile.username = undefined
    const wrapperYou = mountCard({ poster: '0xmyaddress' })
    expect(wrapperYou.find('.author-btn').text()).toBe('You')
    expect(wrapperYou.find('.author-btn').attributes('to')).toBe('/profile')

    // restore
    mockProfile.profile.name = 'Alice Local'
    mockOwnAddress.value = null
  })

  it('displays fallback "Anonymous" rather than blank when poster is undefined or empty', () => {
    mockOwnAddress.value = null

    const wrapperUndef = mountCard({ poster: undefined })
    expect(wrapperUndef.find('.author-btn').text()).toBe('Anonymous')
    expect(wrapperUndef.find('.author-btn').attributes('to')).toBeUndefined()
    expect(wrapperUndef.find('.author-btn').attributes('disable')).toBe('true')

    const wrapperEmpty = mountCard({ poster: '' })
    expect(wrapperEmpty.find('.author-btn').text()).toBe('Anonymous')
    expect(wrapperEmpty.find('.author-btn').attributes('to')).toBeUndefined()
  })

  it('displays formatted address with font-mono when author is an unknown address', () => {
    mockOwnAddress.value = null
    const longAddress = '0x1234567890abcdef1234567890abcdef12345678'
    const wrapper = mountCard({ poster: longAddress })
    expect(wrapper.find('.author-btn').text()).toBe('0x123456...345678')
    expect(wrapper.find('.author-btn .font-mono').exists()).toBe(true)
    expect(wrapper.find('.author-btn').attributes('to')).toBe(
      `/chat/${longAddress}`,
    )
  })

  it('resolves author to profile name when poster is a sub-account address in ownAddresses (#1071)', () => {
    mockOwnAddress.value = '0xidentityaddress'
    mockOwnAddresses.value = [
      '0xidentityaddress',
      '0x1e6fb5000000000000000000000000003df7bd',
    ]
    mockProfile.profile.name = 'Shammah'

    const wrapper = mountCard({
      poster: '0x1e6fb5000000000000000000000000003df7bd',
    })
    expect(wrapper.find('.author-btn').text()).toBe('Shammah')
    expect(wrapper.find('.author-btn').attributes('to')).toBe('/profile')
    expect(wrapper.find('.author-btn .font-mono').exists()).toBe(false)

    // restore
    mockProfile.profile.name = 'Alice Local'
    mockOwnAddress.value = null
    mockOwnAddresses.value = []
  })

  it('resolves author to profile name when payloadDigest matches isOwnPost (#1071)', () => {
    mockOwnAddress.value = null
    mockOwnAddresses.value = []
    mockProfile.profile.name = 'Shammah'
    mockOwnPostDigests.push('a1b2c3d4e5f60718')

    const wrapper = mountCard({
      poster: '0xunknownburnsubaccount',
      payloadDigest: 'a1b2c3d4e5f60718',
    })
    expect(wrapper.find('.author-btn').text()).toBe('Shammah')
    expect(wrapper.find('.author-btn').attributes('to')).toBe('/profile')

    // restore
    mockProfile.profile.name = 'Alice Local'
    mockOwnPostDigests.length = 0
  })
})
