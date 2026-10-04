/** @jest-environment jsdom */

// Regression for #187: every icon-only control must expose a non-empty, localized, distinct
// accessible name. Real components are mounted with Quasar reduced to plain elements (Quasar's
// real components render nothing under the SSR build Jest is aliased to), so the assertions see
// exactly the attributes and text the app puts on each control.

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { mount, VueWrapper } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, ref } from 'vue'

import enUS from 'src/i18n/en-us'
import frFR from 'src/i18n/fr-fr'
import { MY_DRAWER_OPEN_KEY } from 'src/composables/useMyDrawerOpen'
import ChatInput from './chat/ChatInput.vue'
import ChatList from './chat/ChatList.vue'
import ChatMessageSuffixButtons from './chat/messages/ChatMessageSuffixButtons.vue'
import ContactItem from './contacts/ContactItem.vue'
import ForumMessage from './forum/ForumMessage.vue'
import ForumPost from './forum/ForumPost.vue'
import TopicInput from './topic/TopicInput.vue'
import TopicListLink from './topic/TopicListLink.vue'
import TopicMessage from './topic/TopicMessage.vue'
import ChatLayout from '../layouts/ChatLayout.vue'
import ForumLayout from '../layouts/ForumLayout.vue'
import TopicLayout from '../layouts/TopicLayout.vue'

jest.mock('pinia', () => ({
  ...jest.requireActual('pinia'),
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: 'Owner', avatar: '' },
  }),
}))
jest.mock('vue-router', () => ({
  useRoute: () => ({ path: '/', params: {} }),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    currentRoute: { value: { path: '/', params: { topic: 'alpha' } } },
  }),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () =>
    jest.requireActual('vue').reactive({
      getSortedChatOrder: [],
      totalUnread: 0,
    }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    getContact: jest.fn(() => ({ profile: { name: 'Alice', avatar: '' } })),
    getNotify: jest.fn(() => true),
    haveContact: jest.fn(() => false),
    getContactProfile: jest.fn(),
    setNotify: jest.fn(),
    deleteContact: jest.fn(),
  }),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    topics: {},
    deleteTopic: jest.fn(),
    putMessage: jest.fn(),
    refreshDiscoveredTopics: jest.fn(),
  }),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () =>
    jest.requireActual('vue').reactive({
      messages: {},
      topics: [],
      selectedTopic: '',
      getMessage: jest.fn(),
      setSelectedTopic: jest.fn(),
      refreshMessages: jest.fn(),
    }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({
    identity: { address: { raw: '0xsyntheticowner' } },
  })),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    formatAddress: (address: { raw: string }) => address.raw,
    defaultStampValue: 1n,
    fromDisplayAmount: (value: string) => BigInt(value),
    toDisplayAmount: (amount: bigint) => amount.toString(),
    nativeTransfers: { getBalance: jest.fn(async () => 0n) },
  },
}))
jest.mock('bitcore-lib-xpi', () => ({
  PublicKey: { fromBuffer: jest.fn(() => ({ toString: () => 'pk' })) },
}))
// Children that are not the subject (drawers, dialogs, replies) render nothing.
jest.mock('./forum/ForumMessageReplies.vue', () => ({ template: '<div />' }))
jest.mock('./panels/ForumDrawer.vue', () => ({ template: '<div />' }))
jest.mock('./panels/ChatInfoView.vue', () => ({ template: '<div />' }))
jest.mock('./topic/TopicDrawer.vue', () => ({ template: '<div />' }))
jest.mock('./dialogs/ClearHistoryDialog.vue', () => ({ template: '<div />' }))
jest.mock('./dialogs/DeleteChatDialog.vue', () => ({ template: '<div />' }))
jest.mock('./dialogs/SendFileDialog.vue', () => ({ template: '<div />' }))
jest.mock('./chat/ChatListItem.vue', () => ({ template: '<div />' }))
jest.mock('src/utils/avatar', () => ({ profileAvatar: () => '' }))

const locales = { 'en-us': enUS, 'fr-fr': frFR } as const

function makeTranslate(messages: unknown) {
  return (key: string, params: Record<string, unknown> = {}): string => {
    const value = key
      .split('.')
      .reduce<any>((node, part) => node?.[part], messages as any)
    return typeof value === 'string'
      ? value.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k]))
      : key
  }
}

function passthrough(tag: string, extra: Record<string, string> = {}) {
  return defineComponent({
    inheritAttrs: true,
    props: { modelValue: null, label: null },
    setup(props, { slots }) {
      return () =>
        h(tag, extra, [props.label as string | undefined, slots.default?.()])
    },
  })
}
const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(name => /^Q[A-Z]/.test(name))
    .map(name => [name, passthrough('div')]),
)
quasarStubs.QBtn = passthrough('button')
// Menu/tooltip/dialog content is not always-visible UI; keep it out of the accessibility tree.
quasarStubs.QMenu = passthrough('div', { 'data-testid': 'menu' })

type Mountable = Parameters<typeof mount>[0]

function render(
  locale: keyof typeof locales,
  component: Mountable,
  options: {
    props?: Record<string, unknown>
    provide?: Record<string, unknown>
    attrs?: Record<string, unknown>
  } = {},
) {
  const $q = {
    screen: { width: 1200 },
    platform: { is: { mobile: false } },
    dark: { isActive: false },
  }
  return mount(component as any, {
    props: options.props,
    global: {
      directives: { ripple: {}, closePopup: {} },
      components: quasarStubs,
      provide: { _q_: $q, ...options.provide },
      stubs: { RouterView: true, RouterLink: true },
      mocks: {
        $q,
        $t: makeTranslate(locales[locale]),
        $status: { setup: true },
        $relay: { connected: true },
        $router: { push: jest.fn(), replace: jest.fn() },
        $route: { params: { address: 'addr1' } },
      },
    },
  }) as VueWrapper
}

/** The accessible name of a control: aria-label when present, else its visible text. */
function accessibleName(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
}

/** Names of every focusable button-like element in the mounted tree. */
function buttonNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('button').map(b => accessibleName(b.element))
}

function expectNamedAndDistinct(names: string[], expected: string[]) {
  names.forEach(name => expect(name).not.toBe(''))
  expect(new Set(names).size).toBe(names.length)
  expected.forEach(name => expect(names).toContain(name))
}

describe.each(Object.keys(locales) as (keyof typeof locales)[])(
  'icon-only control accessible names (%s)',
  locale => {
    const t = (key: string, params?: Record<string, unknown>) =>
      makeTranslate(locales[locale])(key, params)

    it('names navigation, refresh, new-post and settings in the Forum toolbar', () => {
      const wrapper = render(locale, ForumLayout)
      expectNamedAndDistinct(buttonNames(wrapper), [
        t('a11y.openNavigation'),
        t('a11y.forumRefresh'),
        t('a11y.newPost'),
        t('a11y.forumSettings'),
      ])
    })

    it('names navigation and settings in the Topic toolbar and its send control', () => {
      const wrapper = render(locale, TopicLayout)
      expectNamedAndDistinct(buttonNames(wrapper), [
        t('a11y.openNavigation'),
        t('a11y.topicSettings'),
      ])
      const input = render(locale, TopicInput, { props: { message: '' } })
      expectNamedAndDistinct(buttonNames(input), [t('a11y.sendMessage')])
    })

    it('names navigation and the chat overflow menu in the chat toolbar', () => {
      const wrapper = render(locale, ChatLayout)
      expectNamedAndDistinct(buttonNames(wrapper), [
        t('a11y.openNavigation'),
        t('a11y.chatMenu'),
      ])
    })

    it('names the Direct Messages add-contact control', () => {
      const wrapper = render(locale, ChatList, { props: { compact: false } })
      expectNamedAndDistinct(buttonNames(wrapper), [t('a11y.addContact')])
    })

    it('names the message composer send and attachment controls distinctly', () => {
      const wrapper = render(locale, ChatInput, {
        props: { message: '', stampAmount: '1' },
      })
      expectNamedAndDistinct(buttonNames(wrapper), [
        t('a11y.attachmentOptions'),
        t('a11y.stampPayment'),
        t('a11y.sendMessage'),
      ])
    })

    it('names the per-message actions and delete/resend controls', () => {
      const confirmed = render(locale, ChatMessageSuffixButtons, {
        props: { status: 'confirmed' },
      })
      expectNamedAndDistinct(buttonNames(confirmed), [
        t('a11y.messageActions'),
        t('a11y.replyToMessage'),
        t('a11y.forwardMessage'),
        t('a11y.messageInfo'),
      ])
      const selecting = render(locale, ChatMessageSuffixButtons, {
        props: { status: 'confirmed' },
        provide: { chatSelectMode: ref(true) },
      })
      expectNamedAndDistinct(buttonNames(selecting), [t('a11y.deleteMessage')])
      const failed = render(locale, ChatMessageSuffixButtons, {
        props: { status: 'error' },
      })
      expectNamedAndDistinct(buttonNames(failed), [t('a11y.resendMessage')])
    })

    it.each([
      ['ForumMessage', ForumMessage],
      ['ForumPost', ForumPost],
      ['TopicMessage', TopicMessage],
    ])('names the %s vote up and vote down arrows distinctly', (_n, comp) => {
      const wrapper = render(locale, comp as Mountable, {
        props: {
          topic: 't',
          message: {
            poster: 'p',
            voteWeightWei: '0',
            visibleTimestamp: { seconds: '0', nanoseconds: 0 },
            epoch: '00'.repeat(16),
            revision: '0',
            transactionHash: '11'.repeat(32),
            authorBurnTx: '0x01',
            blockNumber: '0',
            transactionIndex: '0',
            replies: [],
            entries: [],
            payloadDigest: 'd',
            topic: 't',
            timestamp: new Date(0),
          },
        },
      })
      const names = buttonNames(wrapper).filter(n => n !== '')
      expect(names).toContain(t('a11y.voteUp'))
      expect(names).toContain(t('a11y.voteDown'))
      expect(t('a11y.voteUp')).not.toBe(t('a11y.voteDown'))
    })

    it('names destructive topic and contact delete controls with their target', () => {
      const topic = render(locale, TopicListLink, { props: { topic: 'alpha' } })
      expectNamedAndDistinct(buttonNames(topic), [
        t('a11y.deleteTopic', { topic: 'alpha' }),
      ])
      const contact = render(locale, ContactItem, {
        props: {
          address: 'addr1',
          contact: {
            profile: { name: 'Alice', avatar: '' },
            inbox: { acceptancePrice: 1 },
          },
        },
      })
      expect(buttonNames(contact)).toContain(
        t('a11y.deleteContact', { name: 'Alice' }),
      )
    })

    it('reports drawer state on the navigation toggle via aria-expanded', () => {
      const open = ref(true)
      const wrapper = render(locale, ForumLayout, {
        provide: { [MY_DRAWER_OPEN_KEY]: open },
      })
      const menu = () =>
        wrapper
          .findAll('button')
          .find(b => b.attributes('aria-label') === t('a11y.openNavigation'))
      expect(menu()?.attributes('aria-expanded')).toBe('true')
      open.value = false
      return wrapper.vm.$nextTick().then(() => {
        expect(menu()?.attributes('aria-expanded')).toBe('false')
      })
    })
  },
)

describe('a11y translation keys', () => {
  function leafKeys(node: unknown, prefix = ''): string[] {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      typeof v === 'object' && v !== null
        ? leafKeys(v, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    )
  }
  const lookup = (messages: unknown, key: string) =>
    key.split('.').reduce<any>((node, part) => node?.[part], messages as any)

  function vueFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name)
      return statSync(path).isDirectory()
        ? vueFiles(path)
        : path.endsWith('.vue')
        ? [path]
        : []
    })
  }

  it('has the same a11y keys in en-us and fr-fr, all non-empty', () => {
    const en = leafKeys(enUS.a11y).sort()
    const fr = leafKeys(frFR.a11y).sort()
    expect(fr).toEqual(en)
    en.forEach(key => {
      expect(lookup(enUS.a11y, key)).not.toBe('')
      expect(lookup(frFR.a11y, key)).not.toBe('')
    })
  })

  it('defines in BOTH locales every a11y key the components reference', () => {
    const referenced = new Set<string>()
    vueFiles(join(__dirname, '..')).forEach(file => {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/['"`](a11y\.[A-Za-z]+)['"`]/g)) {
        referenced.add(m[1])
      }
    })
    expect(referenced.size).toBeGreaterThan(10)
    referenced.forEach(key => {
      expect([key, typeof lookup(enUS, key)]).toEqual([key, 'string'])
      expect([key, typeof lookup(frFR, key)]).toEqual([key, 'string'])
    })
    // Every key defined is used, so the two lists cannot silently drift.
    leafKeys(enUS.a11y).forEach(key => {
      expect(referenced).toContain(`a11y.${key}`)
    })
  })
})
