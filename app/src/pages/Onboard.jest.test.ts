/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, toRaw } from 'vue'
import {
  accountSession as mockSession,
  accountStatus,
} from '../accounts/session'
import { useChatStore, setConversationIdSalt } from '../stores/chats'
import { pendingRelayData, useContactStore } from '../stores/contacts'
import { createRoutes } from '../router/routes'
import createAppRouter from '../router/index'
import { setStartupRestoration } from '../boot/startup-state'
import Onboard from './Onboard.vue'

const mockCreateDirect = jest.fn()
const mockBeginPasskey = jest.fn()
const mockCancel = jest.fn()

jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({
    cancel: mockCancel,
    createDirect: mockCreateDirect,
    beginPasskey: mockBeginPasskey,
  }),
  recoveryErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Account operation failed',
}))

jest.mock('../accounts/mera-passkey', () => ({
  MeraAccountError: class MeraAccountError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
  supportsMeraPasskeys: () => true,
}))

const mockNameOwnProfile = jest.fn(async () => undefined)
const mockEnsureConversationIdSalt = jest.fn(async () => {
  setConversationIdSalt(new Uint8Array(16).fill(7))
})

jest.mock('../utils/identity-session', () => ({
  nameOwnProfile: (...args: unknown[]) => mockNameOwnProfile(...args),
  ensureConversationIdSalt: () => mockEnsureConversationIdSalt(),
  messagingWallet: () => undefined,
}))

jest.mock('../utils/own-address', () => ({
  getOwnCanonicalAddress: jest.fn(
    async () => '0x9999999999999999999999999999999999999999',
  ),
  sameCanonicalAddress: (a?: string | null, b?: string | null) =>
    Boolean(a && b && a.toLowerCase() === b.toLowerCase()),
  isOwnAddress: () => false,
}))

const mockPush = jest.fn(async () => undefined)
const mockRoute = reactive<{
  path: string
  fullPath: string
  params: Record<string, string>
  query: Record<string, string>
}>({
  path: '/onboard',
  fullPath: '/onboard',
  params: {},
  query: {},
})

let capturedBeforeEachGuards: Array<
  (
    to: Record<string, unknown>,
    from: Record<string, unknown>,
  ) => Promise<unknown>
> = []

jest.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useRoute: () => mockRoute,
  createRouter: () => ({
    beforeEach: (
      guard: (
        to: Record<string, unknown>,
        from: Record<string, unknown>,
      ) => Promise<unknown>,
    ) => {
      capturedBeforeEachGuards.push(guard)
    },
    afterEach: jest.fn(),
    onError: jest.fn(),
  }),
  createMemoryHistory: jest.fn(),
  createWebHistory: jest.fn(),
  createWebHashHistory: jest.fn(),
}))

const mockAccount = reactive(toRaw(accountStatus))

function renderOnboard() {
  return mount(Onboard, {
    global: {
      mocks: {
        $t: (key: string) => key,
        $router: { push: mockPush },
      },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<div><slot /></div>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<div><slot /></div>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBadge: { template: '<span><slot /></span>' },
        QBanner: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable', 'loading'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        QInput: {
          props: ['modelValue', 'disable', 'label'],
          template:
            '<input :value="modelValue" :disabled="disable" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  })
}

const PEER_ADDRESS = '0x1111111111111111111111111111111111111111'

function pendingContactNamed(name: string) {
  return {
    ...pendingRelayData,
    profile: {
      ...pendingRelayData.profile,
      name,
      pubKey: null,
    },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  setConversationIdSalt(new Uint8Array(16).fill(7))
  capturedBeforeEachGuards = []
  Object.assign(mockAccount, {
    status: 'fresh',
    revision: 0,
    account: null,
    pending: null,
    pendingReady: false,
    pendingIdentityAddress: null,
    pendingError: null,
  })
  mockRoute.query = {}
  mockPush.mockClear()
  mockCreateDirect.mockReset()
  mockBeginPasskey.mockReset()
  mockCancel.mockClear()
  mockNameOwnProfile.mockClear()
  mockEnsureConversationIdSalt.mockClear()

  const contactStore = useContactStore()
  jest.spyOn(contactStore, 'refresh').mockResolvedValue(undefined)

  jest.spyOn(mockSession, 'initialize').mockResolvedValue(undefined)
  jest.spyOn(mockSession, 'activatePending').mockImplementation(async () => {
    mockAccount.account = mockAccount.pending?.account ?? {
      accountId: 'acc-1',
      displayName: 'Alice',
      descriptor: 'DESC-1',
      receipt: { operationId: 'op-1' },
    }
    mockAccount.status = 'ready'
    mockAccount.revision = 1
    mockAccount.pending = null
  })
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Onboard.vue & /onboard route', () => {
  test('registers /onboard in routes and allows unauthenticated access in router guard without redirecting to /setup', async () => {
    const routes = createRoutes()
    const rootChildren = routes[0]?.children ?? []
    expect(rootChildren.some(r => r.path === 'onboard')).toBe(true)

    setStartupRestoration({ phase: 'restored' })
    createAppRouter()
    const redirectIfNoProfile =
      capturedBeforeEachGuards[capturedBeforeEachGuards.length - 1]
    expect(redirectIfNoProfile).toBeDefined()

    mockAccount.status = 'fresh'
    await expect(
      redirectIfNoProfile(
        {
          path: '/onboard',
          fullPath: `/onboard?peer=${PEER_ADDRESS}&email=alice%40gmail.com`,
          params: {},
        },
        { path: '/', fullPath: '/', params: {} },
      ),
    ).resolves.toBeUndefined()

    await expect(
      redirectIfNoProfile(
        {
          path: '/wallet',
          fullPath: '/wallet',
          params: {},
        },
        { path: '/', fullPath: '/', params: {} },
      ),
    ).resolves.toBe('/setup')
  })

  test('pre-fills displayName from query.name or local-part of query.email', () => {
    mockRoute.query = {
      peer: PEER_ADDRESS,
      email: 'alice.smith@gmail.com',
    }
    const wrapperFromEmail = renderOnboard()
    try {
      const input = wrapperFromEmail.get('[data-test="onboard-display-name"]')
      expect((input.element as HTMLInputElement).value).toBe('alice.smith')
    } finally {
      wrapperFromEmail.unmount()
    }

    mockRoute.query = {
      peer: PEER_ADDRESS,
      email: 'alice.smith@gmail.com',
      name: 'Alice Wonderland',
    }
    const wrapperFromName = renderOnboard()
    try {
      const input = wrapperFromName.get('[data-test="onboard-display-name"]')
      expect((input.element as HTMLInputElement).value).toBe('Alice Wonderland')
    } finally {
      wrapperFromName.unmount()
    }
  })

  test('clicking Create Self-Custodial Account & Open Chat creates and activates account, redeems claim token, imports message, and navigates to /chat/<peer>', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        peer: PEER_ADDRESS,
        peerName: 'Bob (@bob)',
        conversationId: 'm0123456789abcdef0123456789abcd',
        subject: 'Hello from Frank!',
        textBody: 'Hey Alice, here is our encrypted project update.',
        messageId: 'claim-msg-digest-001',
        timestamp: 1710000000000,
        direction: 'outbound',
      }),
    }))
    ;(globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy

    mockCreateDirect.mockImplementation(async (name: string) => {
      mockAccount.pending = {
        status: 'staging',
        account: {
          accountId: 'acc-new',
          displayName: name,
          descriptor: 'DESC-NEW',
          receipt: { operationId: 'attempt-direct-1' },
        },
        expectedActive: { revision: 0, accountId: null },
      } as never
      mockAccount.pendingReady = true
      mockAccount.pendingIdentityAddress =
        '0x9999999999999999999999999999999999999999'
      return { attemptId: 'attempt-direct-1' }
    })

    const contactStore = useContactStore()
    const fetchContactSpy = jest
      .spyOn(contactStore, 'fetchAndAddContact')
      .mockResolvedValue(undefined as never)

    mockRoute.query = {
      peer: PEER_ADDRESS,
      peerName: 'Bob (@bob)',
      email: 'alice@gmail.com',
      claim: 'signed-claim-token-xyz',
      gateway: 'https://signet.mx',
    }

    const view = renderOnboard()
    try {
      await view.get('[data-test="onboard-create-direct"]').trigger('click')
      await flushPromises()

      expect(mockCreateDirect).toHaveBeenCalledWith('alice')
      expect(mockSession.activatePending).toHaveBeenCalledWith(
        'attempt-direct-1',
        { revision: 0, accountId: null },
      )
      expect(mockNameOwnProfile).toHaveBeenCalledWith(
        'alice',
        '0x9999999999999999999999999999999999999999',
      )
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://signet.mx/onboard/claim/signed-claim-token-xyz',
        expect.objectContaining({ method: 'GET' }),
      )
      expect(fetchContactSpy).toHaveBeenCalledWith({
        address: PEER_ADDRESS,
        contact: pendingContactNamed('Bob (@bob)'),
      })

      const chatStore = useChatStore()
      const conv = chatStore.chats[PEER_ADDRESS] ?? chatStore.activeConversation
      expect(conv).toBeTruthy()
      expect(conv?.name).toBe('Hello from Frank!')
      expect(conv?.messages).toHaveLength(1)
      expect(conv?.messages[0]?.payloadDigest).toBe('claim-msg-digest-001')
      expect(conv?.messages[0]?.items).toEqual([
        {
          type: 'text',
          text: 'Hey Alice, here is our encrypted project update.',
        },
      ])

      expect(mockPush).toHaveBeenCalledWith(`/chat/${PEER_ADDRESS}`)
    } finally {
      view.unmount()
    }
  })

  test('activation uses the vault account id when the staged attempt names none', async () => {
    mockAccount.account = {
      displayName: 'Alice',
      descriptor: 'DESC-1',
      fingerprint: 'fp',
      receipt: {
        operationId: 'op-1',
        context: { accountId: 'vault-account' },
      },
    }
    mockCreateDirect.mockImplementation(async () => {
      mockAccount.pendingIdentityAddress =
        '0x9999999999999999999999999999999999999999'
      return { attemptId: 'attempt-vault' }
    })
    mockRoute.query = {
      peer: PEER_ADDRESS,
      email: 'alice@gmail.com',
    }

    const view = renderOnboard()
    try {
      await view.get('[data-test="onboard-create-direct"]').trigger('click')
      await flushPromises()
      expect(mockSession.activatePending).toHaveBeenCalledWith(
        'attempt-vault',
        { revision: 0, accountId: 'vault-account' },
      )
    } finally {
      view.unmount()
    }
  })

  test('when an account is already active (status === ready), clicking Import Thread & Open Chat with Peer imports message and navigates to /chat/<peer>', async () => {
    Object.assign(mockAccount, {
      status: 'ready',
      revision: 1,
      account: {
        accountId: 'existing-acc',
        displayName: 'Existing Alice',
        descriptor: 'DESC-EXISTING',
        receipt: { operationId: 'op-existing' },
      },
    })

    const fetchSpy = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        peer: PEER_ADDRESS,
        peerName: 'Charlie',
        subject: 'Invoice #42',
        textBody: 'Attached is Invoice #42.',
        payloadDigest: 'claim-msg-digest-002',
      }),
    }))
    ;(globalThis as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy

    const contactStore = useContactStore()
    const fetchContactSpy = jest
      .spyOn(contactStore, 'fetchAndAddContact')
      .mockResolvedValue(undefined as never)

    mockRoute.query = {
      peer: PEER_ADDRESS,
      claim: 'token-ready-user',
      gateway: 'https://signet.mx',
    }

    const view = renderOnboard()
    try {
      expect(view.find('[data-test="onboard-import-existing"]').exists()).toBe(
        true,
      )
      expect(view.find('[data-test="onboard-create-direct"]').exists()).toBe(
        false,
      )

      await view.get('[data-test="onboard-import-existing"]').trigger('click')
      await flushPromises()

      expect(mockCreateDirect).not.toHaveBeenCalled()
      expect(fetchContactSpy).toHaveBeenCalledWith({
        address: PEER_ADDRESS,
        contact: pendingContactNamed('Charlie'),
      })

      const chatStore = useChatStore()
      const conv = chatStore.chats[PEER_ADDRESS] ?? chatStore.activeConversation
      expect(conv).toBeTruthy()
      expect(conv?.name).toBe('Invoice #42')
      expect(conv?.messages).toHaveLength(1)
      expect(conv?.messages[0]?.payloadDigest).toBe('claim-msg-digest-002')
      expect(conv?.messages[0]?.items).toEqual([
        {
          type: 'text',
          text: 'Attached is Invoice #42.',
        },
      ])

      expect(mockPush).toHaveBeenCalledWith(`/chat/${PEER_ADDRESS}`)
    } finally {
      view.unmount()
    }
  })
})
