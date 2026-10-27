/** @jest-environment jsdom */
/**
 * Finding 12: restoring an account is a screen of its own in history (`/setup?mode=restore`),
 * on a real router. Back returns to the choice and cancels the restore; Forward or a reload
 * starts a fresh restore; Cancel is Back. Real hash-mode router on jsdom's session history.
 */
import { defineComponent, h } from 'vue'
import { RouterView, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Setup from './Setup.vue'
import { inspectLegacyWallet } from '../accounts/legacy'
import { resetNavigationForTests } from '../utils/navigation'
import en from '../i18n/en-us'
import {
  afterNavigation,
  flushHistory,
  historyPosition,
  openApp,
  reloadApp,
  userBack,
  userForward,
} from '../../test/jest/navigation-harness'

jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: () => undefined }),
)
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))
jest.mock('../accounts/pending-profile-preview', () => ({
  ...jest.requireActual('../accounts/pending-profile-preview'),
  readPendingProfilePreview: jest.fn(async () => undefined),
}))
jest.mock('../accounts/session', () => ({
  accountStatus: jest.requireActual('vue').reactive({
    status: 'fresh',
    revision: 0,
    account: null,
    pending: null,
    pendingReady: false,
    pendingIdentityAddress: null,
    pendingError: null,
  }),
  accountSession: {
    retry: jest.fn(async () => undefined),
    activatePending: jest.fn(async () => undefined),
    stage: jest.fn(async () => undefined),
    snapshot: jest.fn(async () => ({
      revision: 0,
      active: null,
      pending: null,
    })),
    setBip39Params: jest.fn(),
    getWallet: jest.fn(),
  },
  importBip39Wallet: jest.fn(),
}))

const mockCancelCeremony = jest.fn()
const mockBeginRestore = jest.fn(async (text?: string) => text ?? 'DESC')
jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({
    cancel: mockCancelCeremony,
    beginNew: jest.fn(),
    share: jest.fn(),
    beginRestore: mockBeginRestore,
    confirm: jest.fn(),
    choose: jest.fn(),
    createDirect: jest.fn(),
  }),
  recoveryErrorMessage: (err: unknown) =>
    (err as Error)?.message ?? 'Account operation failed',
}))

const t = (key: string) => {
  const value = key
    .split('.')
    .reduce<unknown>((o, part) => (o as Record<string, unknown>)?.[part], en)
  return typeof value === 'string' ? value : key
}

const stubs = {
  QHeader: { template: '<header><slot /></header>' },
  QToolbar: { template: '<div><slot /></div>' },
  QToolbarTitle: { template: '<div><slot /></div>' },
  QPageContainer: { template: '<main><slot /></main>' },
  QPage: { template: '<div><slot /></div>' },
  QBtn: {
    props: ['label', 'disable'],
    template:
      '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
  },
  QCheckbox: true,
  QOptionGroup: true,
  QExpansionItem: { template: '<div><slot /></div>' },
  QCard: { template: '<div><slot /></div>' },
  QCardSection: { template: '<div><slot /></div>' },
  QCardActions: { template: '<div><slot /></div>' },
  QAvatar: { template: '<span><slot /></span>' },
  QForm: {
    template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>',
  },
  QInput: {
    props: ['modelValue'],
    template:
      '<div :data-test="$attrs[\'data-test\']"><input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /></div>',
  },
}

const ROUTES = ['/welcome', { path: '/setup', component: Setup }, '/wallet']

let router: Router
let destroy: () => void = () => undefined
let view: VueWrapper | undefined

function mountApp() {
  view = mount(defineComponent({ render: () => h(RouterView) }), {
    global: { plugins: [router], mocks: { $t: t }, stubs },
  })
  return view
}

const restoring = () => view!.find('[data-test="confirm-shares"]').exists()

beforeEach(async () => {
  setActivePinia(createPinia())
  jest.clearAllMocks()
  await inspectLegacyWallet({
    get: async () => {
      throw { notFound: true }
    },
  })
})
afterEach(() => {
  view?.unmount()
  view = undefined
  destroy()
  resetNavigationForTests()
})

async function openRestore() {
  ;({ router, destroy } = await openApp(ROUTES, '/welcome'))
  await router.push('/setup')
  mountApp()
  await flushPromises()
  const choice = historyPosition()
  await view!.get('[data-test="restore-account"]').trigger('click')
  await flushPromises()
  await flushHistory()
  return choice
}

describe('restore mode is a screen of its own', () => {
  it('Back returns to the choice and cancels the restore; Forward starts a fresh one', async () => {
    const choice = await openRestore()
    expect(restoring()).toBe(true)
    expect(router.currentRoute.value.fullPath).toBe('/setup?mode=restore')
    expect(historyPosition()).toBe(choice + 1)

    await userBack(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/setup')
    expect(restoring()).toBe(false)
    expect(view!.find('[data-test="restore-account"]').exists()).toBe(true)
    expect(mockCancelCeremony).toHaveBeenCalled()

    await userForward(router)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/setup?mode=restore')
    expect(restoring()).toBe(true)
    expect(mockBeginRestore).toHaveBeenCalledTimes(2)
  })

  it('Cancel is Back to the choice', async () => {
    const choice = await openRestore()
    const done = afterNavigation(router)
    await view!.get('[data-test="cancel-ceremony"]').trigger('click')
    await done
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/setup')
    expect(historyPosition()).toBe(choice)
    expect(restoring()).toBe(false)
  })

  it('a reload on the restore screen starts a fresh restore there', async () => {
    const choice = await openRestore()
    view!.unmount()
    view = undefined
    destroy()
    resetNavigationForTests()
    mockBeginRestore.mockClear()
    ;({ router, destroy } = await reloadApp(ROUTES))
    mountApp()
    await flushPromises()
    expect(historyPosition()).toBe(choice + 1)
    expect(mockBeginRestore).toHaveBeenCalledTimes(1)
    expect(restoring()).toBe(true)
  })

  it('a restore that cannot start again after a reload returns to the choice: no second copy of it', async () => {
    const choice = await openRestore()
    view!.unmount()
    view = undefined
    destroy()
    resetNavigationForTests()
    mockBeginRestore.mockRejectedValueOnce(new Error('another account'))
    ;({ router, destroy } = await reloadApp(ROUTES))
    const done = afterNavigation(router)
    mountApp()
    await done
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/setup')
    expect(historyPosition()).toBe(choice)
    expect(restoring()).toBe(false)
  })
})
