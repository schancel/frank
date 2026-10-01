/** @jest-environment jsdom */
// The vote handler of the forum message card (ticket #273 review): a failed burn must be shown, a
// burn that landed but could not be read back must not invite a retry.

import { shallowMount } from '@vue/test-utils'

import ForumMessage from './ForumMessage.vue'
import { BurnRefreshError } from 'src/utils/burn-refresh-error'
import { errorNotify, infoNotify } from 'src/utils/notifications'

const mockAddOffering = jest.fn()
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () =>
    jest.requireActual('vue').reactive({
      messages: [],
      topics: [],
      selectedTopic: '',
      getMessage: () => undefined,
      addOffering: (...args: unknown[]) => mockAddOffering(...args),
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
  formatSafeRawAmount: () => '0',
  rawToSafeNumber: () => 1_000_000,
}))
jest.mock('./ForumMessageReplies.vue', () => ({ template: '<div />' }))
jest.mock('../../utils/markdown', () => ({ renderMarkdown: () => '' }))

const messages: Record<string, string> = {
  'stampPreparation.votedRefreshFailed': 'VOTED_REFRESH_FAILED',
}

function mountCard() {
  return shallowMount(ForumMessage, {
    props: {
      message: {
        poster: '0x1',
        satoshis: 0,
        replies: [],
        entries: [{ kind: 'post', title: 't', message: 'm' }],
        payloadDigest: 'ab'.repeat(32),
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
beforeEach(() => jest.clearAllMocks())

describe('ForumMessage vote handler', () => {
  it('shows an error when the vote fails (it must not be swallowed)', async () => {
    const failure = new Error('Nothing was sent')
    mockAddOffering.mockRejectedValueOnce(failure)

    await vote(mountCard())

    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(infoNotify).not.toHaveBeenCalled()
  })

  it('says the vote was sent but refreshing failed, without an error toast that invites a retry', async () => {
    mockAddOffering.mockRejectedValueOnce(
      new BurnRefreshError('vote', new Error('read failed')),
    )

    await vote(mountCard())

    expect(infoNotify).toHaveBeenCalledWith('VOTED_REFRESH_FAILED')
    expect(errorNotify).not.toHaveBeenCalled()
  })

  it('consumes the pending votes either way, so a failure is not re-sent with the next click', async () => {
    mockAddOffering.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mountCard()

    await vote(wrapper)

    expect((wrapper.vm as unknown as { voteAmount: number }).voteAmount).toBe(0)
  })

  it('sends the vote once on success and shows nothing', async () => {
    mockAddOffering.mockResolvedValueOnce(undefined)

    await vote(mountCard())

    expect(mockAddOffering).toHaveBeenCalledTimes(1)
    expect(errorNotify).not.toHaveBeenCalled()
    expect(infoNotify).not.toHaveBeenCalled()
  })
})
