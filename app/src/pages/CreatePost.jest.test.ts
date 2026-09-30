/** @jest-environment jsdom */
// CreatePost: the preparation stages are shown in a live region while posting, and a post whose
// burn landed but could not be read back says so instead of inviting a retry (#273 review).

import { flushPromises, shallowMount } from '@vue/test-utils'

import CreatePost from './CreatePost.vue'
import { BurnRefreshError } from 'src/utils/burn-refresh-error'
import { errorNotify, infoNotify } from 'src/utils/notifications'

const mockPutMessage = jest.fn()
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () =>
    jest.requireActual('vue').reactive({
      topics: ['help'],
      index: {},
      getMessage: () => undefined,
      pushNewTopic: jest.fn(),
      putMessage: (...args: unknown[]) => mockPutMessage(...args),
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
    defaultTopicVoteValue: 1_000_000_000_000n,
    toDisplayAmount: (n: bigint) => `${n}wei`,
    fromDisplayAmount: (s: string) => BigInt(s),
  },
}))
jest.mock('src/utils/chain-amount', () => ({
  displayToSafeRawAmount: () => 1_000_000,
}))
jest.mock('../components/forum/ForumMessage.vue', () => ({
  template: '<div />',
}))
jest.mock('../utils/markdown', () => ({ renderMarkdown: () => '' }))

const messages: Record<string, string> = {
  'stampPreparation.posting': 'POSTING',
  'stampPreparation.checking': 'CHECKING',
  'stampPreparation.funding': 'FUNDING {completed}/{total} {feeReserve}',
  'stampPreparation.ready': 'READY',
  'stampPreparation.postedRefreshFailed': 'POSTED_REFRESH_FAILED',
}
const $t = (key: string, params: Record<string, unknown> = {}) =>
  (messages[key] ?? key).replace(/\{(\w+)\}/g, (_m, n) => String(params[n]))

function mountPage() {
  const router = { go: jest.fn(), push: jest.fn() }
  const wrapper = shallowMount(CreatePost, {
    global: {
      mocks: {
        $t,
        $route: { params: {} },
        $router: router,
        $q: { dark: { isActive: false } },
      },
    },
  })
  return { wrapper, router }
}

const status = (w: ReturnType<typeof mountPage>['wrapper']) =>
  w.find('[data-test="post-status"]')

beforeEach(() => jest.clearAllMocks())

describe('CreatePost preparation status', () => {
  it('shows each stage in a live region and clears it when the post is done', async () => {
    const { wrapper } = mountPage()
    let finish!: () => void
    let report!: (p: unknown) => void
    mockPutMessage.mockImplementationOnce(
      (args: { onPreparationProgress: (p: unknown) => void }) => {
        report = args.onPreparationProgress
        return new Promise<void>(resolve => (finish = resolve))
      },
    )

    const posting = (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    expect(status(wrapper).text()).toBe('POSTING')
    expect(status(wrapper).attributes('role')).toBe('status')

    report({ stage: 'checking' })
    await flushPromises()
    expect(status(wrapper).text()).toBe('CHECKING')

    report({ stage: 'funding', completed: 0, total: 1, feeReserveWei: 7n })
    await flushPromises()
    expect(status(wrapper).text()).toBe('FUNDING 0/1 7wei')

    report({ stage: 'ready', fundingTxHashes: [] })
    await flushPromises()
    expect(status(wrapper).text()).toBe('READY')

    finish()
    await posting
    await flushPromises()
    expect(status(wrapper).exists()).toBe(false)
  })

  it('ignores a second submit while the first is still in flight', async () => {
    const { wrapper } = mountPage()
    let finish!: () => void
    mockPutMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finish = resolve)),
    )
    const vm = wrapper.vm as unknown as { post(): Promise<void> }

    const first = vm.post()
    await flushPromises()
    await vm.post()
    finish()
    await first

    expect(mockPutMessage).toHaveBeenCalledTimes(1)
  })
})

describe('CreatePost outcomes', () => {
  it('a burn that landed but could not be read back says so, does not show an error, and leaves the form', async () => {
    const { wrapper, router } = mountPage()
    mockPutMessage.mockRejectedValueOnce(
      new BurnRefreshError('post', new Error('read failed')),
    )

    await (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    expect(infoNotify).toHaveBeenCalledWith('POSTED_REFRESH_FAILED')
    expect(errorNotify).not.toHaveBeenCalled()
    // Not kept for a retry: the page goes back like any successful post.
    expect(router.push.mock.calls.length + router.go.mock.calls.length).toBe(1)
  })

  it('a failed burn shows the error and keeps the draft page for a retry', async () => {
    const { wrapper, router } = mountPage()
    const failure = new Error('Nothing was sent')
    mockPutMessage.mockRejectedValueOnce(failure)

    await (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(router.push).not.toHaveBeenCalled()
    expect(router.go).not.toHaveBeenCalled()
  })
})
