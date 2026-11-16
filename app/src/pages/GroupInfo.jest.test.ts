/** @jest-environment jsdom */
// Presentation-only group Info: no wallet, relay, persistence or account startup is installed.
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'
import * as quasar from 'quasar'

const mockSession = reactive({ status: 'ready', revision: 1 })
const mockChain = reactive({ chainIdentifier: 'monad-testnet' })
const mockRouter = { go: jest.fn(), replace: jest.fn() }
const mockOwn = '0x1111111111111111111111111111111111111111'
const MEMBER = '0x2222222222222222222222222222222222222222'
const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const mockStore = {
  conversations: reactive<Record<string, ReturnType<typeof group>>>({}),
  activeConversation: undefined as unknown,
  refreshGroupWritePrice: jest.fn(async (): Promise<void> => undefined),
  setGroupWritePrice: jest.fn(async (): Promise<void> => undefined),
  syncGroupConversation: jest.fn(async (): Promise<void> => undefined),
  inviteMemberToGroup: jest.fn(async (): Promise<void> => undefined),
  removeMemberFromGroup: jest.fn(async (): Promise<void> => undefined),
  leaveGroupConversation: jest.fn(async (): Promise<void> => undefined),
}
jest.mock('vue-router', () => ({ useRouter: () => mockRouter }))
jest.mock('@frank/wallet/chain', () => ({ activeChain: mockChain }))
jest.mock('../accounts/session', () => ({ accountStatus: mockSession }))
jest.mock('../stores/chats', () => ({ useChatStore: () => mockStore }))
jest.mock('../stores/contacts', () => ({
  isBlankName: (name: string) => !name.trim(),
  pendingRelayData: { profile: { name: 'Loading...' } },
  useContactStore: () => ({ getContact: () => undefined }),
}))
jest.mock('../stores/my-profile', () => ({
  useProfileStore: () => ({ profile: {} }),
}))
jest.mock('../utils/chain-address', () => ({
  isChainAddress: (address: string) => /^0x[0-9a-f]{40}$/i.test(address),
  safeToChainDisplayAddress: (address: string) => address,
}))
jest.mock('../utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => jest.requireActual('vue').ref(mockOwn),
  sameCanonicalAddress: (first: string, second: string) => first === second,
}))
jest.mock('../utils/notifications', () => ({ errorNotify: jest.fn() }))

import GroupInfo from './GroupInfo.vue'
import { errorNotify } from '../utils/notifications'

function group(id: string, name: string) {
  return {
    id,
    kind: 'group',
    name,
    address: `group:${id.replace(/-/g, '')}`,
    participants: [mockOwn, MEMBER],
    membershipStatus: 'joined',
    groupState: {
      epoch: 1,
      groupSecretKeyHex: 'aa',
      roster: [{ address: mockOwn, role: 'admin' }],
      writePrice: { network: 'monad-testnet', priceWei: '1000000000000000' },
    },
  }
}

const controls = Object.fromEntries(
  Object.keys(quasar)
    .filter(name => /^Q[A-Z]/.test(name))
    .map(name => [
      name,
      defineComponent({
        setup:
          (_, { slots, attrs }) =>
          () =>
            h('div', attrs, slots.default?.()),
      }),
    ]),
)
controls.QBtn = defineComponent({
  props: ['label', 'disable'],
  setup:
    (props, { attrs }) =>
    () =>
      h('button', { ...attrs, disabled: props.disable }, props.label),
})
controls.QInput = defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup:
    (props, { emit, attrs }) =>
    () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).value),
      }),
})
const open = (id = FIRST) =>
  mount(GroupInfo, {
    props: { conversationId: id },
    global: { components: controls, mocks: { $t: (key: string) => key } },
  })
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSession.status = 'ready'
  mockSession.revision = 1
  mockChain.chainIdentifier = 'monad-testnet'
  for (const id of Object.keys(mockStore.conversations))
    delete mockStore.conversations[id]
  mockStore.conversations[FIRST] = group(FIRST, 'First group')
  mockStore.conversations[SECOND] = group(SECOND, 'Second group')
  mockStore.activeConversation = mockStore.conversations[SECOND]
  mockStore.leaveGroupConversation.mockImplementation(async () => undefined)
  mockStore.setGroupWritePrice.mockImplementation(async () => undefined)
  window.history.replaceState(null, '')
})

it.each(['missing', 'direct'])(
  'unavailable %s ID never falls back to the active group or reads a price',
  id => {
    if (id === 'direct')
      mockStore.conversations[id] = { ...group(id, 'Direct'), kind: 'direct' }
    const wrapper = open(id)
    expect(wrapper.find('[data-test="group-info-unavailable"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-test="group-info-name"]').exists()).toBe(false)
    expect(mockStore.refreshGroupWritePrice).not.toHaveBeenCalled()
    wrapper.unmount()
  },
)

it('reads only the exact group while ready, and resets inline confirmation when its route ID changes', async () => {
  const wrapper = open()
  expect(mockStore.refreshGroupWritePrice).toHaveBeenCalledWith(FIRST)
  expect(wrapper.get('[data-test="group-info-name"]').text()).toBe(
    'First group',
  )
  await wrapper.get('[data-test="remove-group-member-btn"]').trigger('click')
  expect(wrapper.find('[data-test="remove-member-confirm"]').exists()).toBe(
    true,
  )
  await wrapper.setProps({ conversationId: SECOND })
  expect(wrapper.get('[data-test="group-info-name"]').text()).toBe(
    'Second group',
  )
  expect(wrapper.find('[data-test="remove-member-confirm"]').exists()).toBe(
    false,
  )
  expect(mockStore.removeMemberFromGroup).not.toHaveBeenCalled()
  expect(wrapper.findComponent({ name: 'QDialog' }).exists()).toBe(false)
  wrapper.unmount()
})

it.each(['locked', 'unavailable', 'loading'])(
  'does not dispatch a price read during %s account state',
  status => {
    mockSession.status = status
    const wrapper = open()
    expect(mockStore.refreshGroupWritePrice).not.toHaveBeenCalled()
    wrapper.unmount()
  },
)

it('Cancel uses history and direct-entry fallback to the exact group conversation', async () => {
  const wrapper = open()
  await wrapper.get('[data-test="close-group-info-btn"]').trigger('click')
  expect(mockRouter.replace).toHaveBeenCalledWith(`/chat/${FIRST}`)
  mockRouter.replace.mockClear()
  window.history.replaceState({ back: '/contacts' }, '')
  await wrapper.get('[data-test="close-group-info-btn"]').trigger('click')
  expect(mockRouter.go).toHaveBeenCalledWith(-1)
  expect(mockRouter.replace).not.toHaveBeenCalled()
  wrapper.unmount()
})

it.each(['route', 'session', 'chain', 'remount'])(
  'a late leave cannot navigate replacement %s UI',
  async replacement => {
    const pending = deferred()
    mockStore.leaveGroupConversation.mockReturnValueOnce(pending.promise)
    let wrapper = open()
    await wrapper.get('[data-test="leave-group-btn"]').trigger('click')
    expect(mockStore.leaveGroupConversation).toHaveBeenCalledWith(FIRST)
    if (replacement === 'route')
      await wrapper.setProps({ conversationId: SECOND })
    if (replacement === 'session') mockSession.revision++
    if (replacement === 'chain') mockChain.chainIdentifier = 'ethereum-sepolia'
    if (replacement === 'remount') {
      wrapper.unmount()
      wrapper = open(SECOND)
    }
    await flushPromises()
    pending.resolve()
    await flushPromises()
    expect(mockRouter.go).not.toHaveBeenCalled()
    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(errorNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  },
)

it.each([true, false])(
  'a stale price completion (%s) cannot clear a replacement input or show its error',
  async succeeds => {
    const pending = deferred()
    mockStore.setGroupWritePrice.mockReturnValueOnce(pending.promise)
    const wrapper = open()
    await wrapper.get('[data-test="group-write-price-input"]').setValue('0.002')
    await wrapper.get('[data-test="group-write-price-btn"]').trigger('click')
    expect(mockStore.setGroupWritePrice).toHaveBeenCalledWith(
      FIRST,
      2_000_000_000_000_000n,
    )
    await wrapper.setProps({ conversationId: SECOND })
    await wrapper.get('[data-test="group-write-price-input"]').setValue('0.003')
    if (succeeds) pending.resolve()
    else pending.reject(new Error('old group refused'))
    await flushPromises()
    expect(
      (
        wrapper.get('[data-test="group-write-price-input"]')
          .element as HTMLInputElement
      ).value,
    ).toBe('0.003')
    expect(errorNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  },
)
