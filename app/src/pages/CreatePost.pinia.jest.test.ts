/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import CreatePost from './CreatePost.vue'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import type { ForumMessage } from '@frank/cashweb/types/forum'

const mockTopicPost = jest.fn()
const mockFetchOne = jest.fn()

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultTopicVoteValue: 1_000_000_000_000n,
    toDisplayAmount: (amount: bigint) => String(amount),
    fromDisplayAmount: (amount: string) => BigInt(amount),
    topics: {
      post: (...args: unknown[]) => mockTopicPost(...args),
      fetchOne: (...args: unknown[]) => mockFetchOne(...args),
      fetchByTopic: jest.fn(),
      discoverTopics: jest.fn(async () => []),
      vote: jest.fn(),
    },
  },
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () =>
    jest.requireActual('vue').reactive({ seedPhrase: 'production-forum-test' }),
}))
jest.mock('src/utils/chain-amount', () => ({
  displayToSafeRawAmount: jest.fn(() => 1_000_000),
}))
jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))
jest.mock('../components/forum/ForumMessage.vue', () => ({
  template: '<div />',
}))
jest.mock('../utils/markdown', () => ({ renderMarkdown: () => '' }))

const wallet = {
  identity: {
    address: { raw: '0xabc' },
    displayAddress: '0xabc',
  },
}

const message = (
  payloadDigest: string,
  topic: string,
  parentDigest?: string,
): ForumMessage => ({
  poster: '0xposter',
  topic,
  satoshis: 1,
  entries: [{ kind: 'post', message: payloadDigest }],
  payloadDigest,
  parentDigest,
  timestamp: new Date(),
})

const $t = (key: string) => key

function mountPage(
  pinia: ReturnType<typeof createPinia>,
  parentDigest?: string,
) {
  return shallowMount(CreatePost, {
    global: {
      plugins: [pinia],
      mocks: {
        $t,
        $route: { params: { parentDigest } },
        $router: { go: jest.fn(), push: jest.fn() },
        $q: { dark: { isActive: false } },
      },
      stubs: {
        QSelect: true,
        AMessage: true,
      },
    },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useActiveWallet).mockResolvedValue(wallet as never)
})

it('uses the production forum store for same-wallet distinct destinations and a nested-reply parent', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const forum = useForumStore()
  forum.setEntries([
    message('root', 'news'),
    message('nested-reply', 'news', 'root'),
  ])

  const pending: Array<(value: { payloadDigest: string }) => void> = []
  mockTopicPost.mockImplementation(
    () =>
      new Promise<{ payloadDigest: string }>(resolve => pending.push(resolve)),
  )
  mockFetchOne.mockImplementation(async (payloadDigest: string) =>
    message(payloadDigest, 'news'),
  )
  const topLevel = mountPage(pinia)
  const nestedReply = mountPage(pinia, 'nested-reply')
  await flushPromises()

  expect(nestedReply.vm).toMatchObject({
    parentDigest: 'nested-reply',
    topic: 'news',
  })
  const postingTopLevel = (
    topLevel.vm as unknown as { post(): Promise<void> }
  ).post()
  const postingNestedReply = (
    nestedReply.vm as unknown as { post(): Promise<void> }
  ).post()
  await flushPromises()

  expect(mockTopicPost).toHaveBeenCalledTimes(2)
  expect(mockTopicPost).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ wallet, parentDigest: undefined }),
  )
  expect(mockTopicPost).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      wallet,
      topic: 'news',
      parentDigest: 'nested-reply',
    }),
  )

  pending[0]?.({ payloadDigest: 'posted-top-level' })
  pending[1]?.({ payloadDigest: 'posted-nested-reply' })
  await Promise.all([postingTopLevel, postingNestedReply])
})

it('exposes an in-flight production reservation to a remounted CreatePost instance', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  useForumStore().setEntries([message('nested-reply', 'news', 'root')])
  let finishPost!: (value: { payloadDigest: string }) => void
  mockTopicPost.mockImplementationOnce(
    () =>
      new Promise<{ payloadDigest: string }>(resolve => (finishPost = resolve)),
  )
  mockFetchOne.mockImplementation(async (payloadDigest: string) =>
    message(payloadDigest, 'news'),
  )
  const original = mountPage(pinia, 'nested-reply')
  await flushPromises()

  const posting = (original.vm as unknown as { post(): Promise<void> }).post()
  await flushPromises()
  expect(original.vm).toMatchObject({ posting: true })
  original.unmount()

  const remounted = mountPage(pinia, 'nested-reply')
  await flushPromises()
  expect(remounted.vm).toMatchObject({ posting: true })
  await (remounted.vm as unknown as { post(): Promise<void> }).post()
  expect(mockTopicPost).toHaveBeenCalledTimes(1)

  finishPost({ payloadDigest: 'posted-after-remount' })
  await posting
  await flushPromises()
  expect(remounted.vm).toMatchObject({ posting: false })
})
