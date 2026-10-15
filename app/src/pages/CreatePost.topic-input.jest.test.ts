/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import CreatePost from './CreatePost.vue'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'

const mockTopicPost = jest.fn()
const mockFetchOne = jest.fn()

jest.mock('src/accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ revision: 1, status: 'ready' }),
}))
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
  displayToRawAmount: jest.fn(() => 1_000_000n),
}))
jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))
jest.mock('../components/forum/ForumMessage.vue', () => ({
  template: '<div />',
}))
jest.mock('../utils/markdown', () => ({ renderMarkdown: () => '' }))

function loadQuasar() {
  const globals = globalThis as typeof globalThis & {
    Vue?: typeof import('vue')
    Quasar?: import('vue').Plugin
  }
  globals.Vue = jest.requireActual('vue')
  globals.ResizeObserver ??= class {
    observe = jest.fn()
    unobserve = jest.fn()
    disconnect = jest.fn()
  }
  jest.requireActual('quasar/dist/quasar.umd.prod.js')
  if (!globals.Quasar) throw new Error('Quasar did not initialize')
  return globals.Quasar
}

const $t = (key: string) => key

function mountRealPage(
  pinia: ReturnType<typeof createPinia>,
  parentDigest?: string,
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return mount(CreatePost, {
    attachTo: host,
    global: {
      plugins: [pinia, loadQuasar()],
      mocks: {
        $t,
        $route: { params: { parentDigest } },
        $router: { go: jest.fn(), push: jest.fn(), back: jest.fn() },
      },
    },
  })
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = jest.fn()
  jest.clearAllMocks()
  jest
    .mocked(useActiveWallet)
    .mockRejectedValue(new Error('Wallet unavailable for topic-only test'))
})

async function enterTopic(
  page: ReturnType<typeof mountRealPage>,
  value: string,
) {
  const select = page.findComponent({ name: 'QSelect' })
  const input = select.get('input')
  await input.setValue(value)
  await flushPromises()
  await input.trigger('keydown', { key: 'Enter', keyCode: 13 })
  await flushPromises()
  return { select, input }
}

describe('CreatePost topic input admission', () => {
  it('keeps the topic control disabled when composing a reply', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const page = mountRealPage(pinia, 'missing-parent')
    try {
      await flushPromises()
      const select = page.findComponent({ name: 'QSelect' })
      expect(select.props('disable')).toBe(true)
      expect(select.get('input').attributes('disabled')).toBeDefined()
      expect(useForumStore().topics).toEqual([])
      expect(mockTopicPost).not.toHaveBeenCalled()
    } finally {
      page.unmount()
    }
  })

  it.each([
    ['UPPER', 'Only numbers, lowercase, periods and dashes allowed'],
    ['alpha,beta', 'Only numbers, lowercase, periods and dashes allowed'],
    ['a..b', 'Topic segments not allowed to be empty'],
    ['.empty', 'Topic segments not allowed to be empty'],
    ['empty.', 'Topic segments not allowed to be empty'],
  ])(
    'keeps invalid %s out of forum suggestions on Enter',
    async (value, error) => {
      const pinia = createPinia()
      setActivePinia(pinia)
      const forum = useForumStore()
      const page = mountRealPage(pinia)
      try {
        await flushPromises()
        const { select, input } = await enterTopic(page, value)
        expect(forum.topics).toEqual([])
        expect(select.props('modelValue')).toBe('')
        expect(input.element.value).toBe(value)
        // Selecting a raw suggestion remains allowed locally; the form still rejects it.
        select.vm.$emit('update:modelValue', value)
        await flushPromises()
        await page.findComponent({ name: 'QForm' }).vm.submit()
        await flushPromises()
        expect(select.text()).toContain(error)
        expect(
          page.findComponent({ name: 'QForm' }).emitted('submit'),
        ).toBeUndefined()
        expect(mockTopicPost).not.toHaveBeenCalled()
      } finally {
        page.unmount()
      }
    },
  )

  it('adds a valid topic once and clears input using the real callback', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const forum = useForumStore()
    const page = mountRealPage(pinia)
    try {
      await flushPromises()
      const { select, input } = await enterTopic(page, 'news.eu-1')
      expect(forum.topics).toEqual(['news.eu-1'])
      expect(select.props('modelValue')).toBe('news.eu-1')
      expect(input.element.value).toBe('')
      await enterTopic(page, 'news.eu-1')
      expect(forum.topics).toEqual(['news.eu-1'])
      expect(mockTopicPost).not.toHaveBeenCalled()
    } finally {
      page.unmount()
    }
  })

  it('validates empty and nonstring rule input without throwing', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const page = mountRealPage(pinia)
    try {
      await flushPromises()
      const select = page.findComponent({ name: 'QSelect' })
      const rules = select.props('rules')
      for (const value of [null, undefined, '', 42, {}, []]) {
        expect(rules[0](value)).toBe(
          'Only numbers, lowercase, periods and dashes allowed',
        )
      }
      expect(rules[0]('a..b')).toBe('Topic segments not allowed to be empty')
      expect(rules[0]('news.eu-1')).toBe(true)
    } finally {
      page.unmount()
    }
  })
})

it('valid topic permits form submission with all other fields identical', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const page = mountRealPage(pinia)
  try {
    await flushPromises()
    const select = page.findComponent({ name: 'QSelect' })
    select.vm.$emit('update:modelValue', 'news.eu-1')
    await flushPromises()
    const form = page.findComponent({ name: 'QForm' })
    await form.vm.submit()
    await flushPromises()
    expect(form.emitted('submit')).toHaveLength(1)
    expect(mockTopicPost).not.toHaveBeenCalled()
  } finally {
    page.unmount()
  }
})
