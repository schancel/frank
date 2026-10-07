/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createRouter, createWebHashHistory, Router } from 'vue-router'

const mockAccountStatus = {
  status: 'ready',
  revision: 1,
  account: {
    descriptor: 'frankdesc1testdescriptor',
    fingerprint: 'abcd1234',
  },
}
const mockAccountSession = {
  state: mockAccountStatus,
  backupCodex32: jest.fn(async () => ['share1', 'share2', 'share3']),
}
jest.mock('src/accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: mockAccountSession,
}))

import SettingsPage from './Settings.vue'

// See navigate-back.jest.test.ts: vue-router 5's ESM-only dev-only dependencies.
// The panel's own behaviour is covered by its test; Settings only mounts it.
jest.mock('../utils/monad-identity-session', () => ({
  messagingState: { status: 'pending', reason: null, participants: {} },
  exportPublicIdentity: jest.fn(),
  refreshMessaging: jest.fn(),
}))
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
const mockApplyTheme = jest.fn()
jest.mock('src/utils/theme', () => {
  const actual = jest.requireActual('src/utils/theme')
  return {
    ...actual,
    applyTheme: (...args: any[]) => mockApplyTheme(...args),
  }
})
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
const mockSetTheme = jest.fn((theme: string) => {
  mockAppearanceStore.theme = theme
})
const mockSetDarkMode = jest.fn((darkMode: boolean) => {
  mockAppearanceStore.darkMode = darkMode
})
const mockAppearanceStore = jest.requireActual('vue').reactive({
  darkMode: false,
  locale: 'en-us',
  theme: 'carnelian',
  setDarkMode: mockSetDarkMode,
  setTheme: mockSetTheme,
})
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: () => mockAppearanceStore,
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () =>
    jest.requireActual('vue').reactive({ updateInterval: 60_000 }),
}))
jest.mock('src/components/settings/PersistentStoragePanel.vue', () => ({
  template: '<div />',
}))
jest.mock('src/utils/apply-locale', () => ({
  applyLocale: jest.fn(() => Promise.resolve()),
}))

const Blank = { render: () => null }

async function openDirectly(hash: string): Promise<Router> {
  // Entries from before the SPA (new-tab page, previous site) make history.length > 1 while the
  // app has no earlier route of its own -- the case from ticket #275.
  window.history.pushState(null, '', '#/before-the-app')
  window.history.pushState(null, '', hash)
  const router = createRouter({
    history: createWebHashHistory(),
    routes: ['/', '/forum', '/settings'].map(path => ({
      path,
      component: Blank,
    })),
  })
  await router.push(hash.slice(1))
  await router.isReady()
  return router
}

async function waitForPath(router: Router, path: string) {
  for (let i = 0; i < 50 && router.currentRoute.value.path !== path; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return router.currentRoute.value.path
}

function mountSettings(router: Router, qMocks: Record<string, any> = {}) {
  return shallowMount(SettingsPage, {
    global: {
      stubs: {
        QSplitter: {
          template: '<div><slot name="before" /><slot name="after" /></div>',
        },
      },
      mocks: {
        $t: (key: string) => key,
        $q: { dark: { set: jest.fn() }, notify: jest.fn(), ...qMocks },
        $i18n: { locale: 'en-us' },
        $router: router,
      },
    },
  })
}

type SettingsVm = { save: () => void; cancel: () => void }

describe('Settings Save/Cancel navigation (ticket #275 / #1001)', () => {
  beforeEach(() => {
    mockApplyTheme.mockClear()
    mockSetTheme.mockClear()
    mockSetDarkMode.mockClear()
    mockAppearanceStore.darkMode = false
    mockAppearanceStore.locale = 'en-us'
    mockAppearanceStore.theme = 'carnelian'
  })

  it('cancel stays inside the app when Settings was opened directly', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as unknown as SettingsVm).cancel()

    expect(await waitForPath(router, '/')).toBe('/')
    expect(window.location.hash).toBe('#/')
  })

  it('cancel returns to the previous in-app route when there is one', async () => {
    const router = await openDirectly('#/forum')
    await router.push('/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as unknown as SettingsVm).cancel()

    expect(await waitForPath(router, '/forum')).toBe('/forum')
  })

  it('save commits settings and stays on settings page with notification feedback (#1001)', async () => {
    const notifyMock = jest.fn()
    const router = await openDirectly('#/forum')
    await router.push('/settings')
    const wrapper = mountSettings(router, { notify: notifyMock })

    ;(wrapper.vm as unknown as SettingsVm).save()

    // Must stay on /settings without abruptly kicking the user back to /forum
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'positive',
        message: 'settings.savedNotification',
      }),
    )
  })
})

describe('Settings Signet Theme Live Preview and Persistence (#1041)', () => {
  beforeEach(() => {
    mockApplyTheme.mockClear()
    mockSetTheme.mockClear()
    mockSetDarkMode.mockClear()
    mockAppearanceStore.darkMode = false
    mockAppearanceStore.locale = 'en-us'
    mockAppearanceStore.theme = 'carnelian'
  })

  it('selecting a theme stone applies live preview immediately', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).selectTheme('lapis')

    expect((wrapper.vm as any).theme).toBe('lapis')
    expect(mockApplyTheme).toHaveBeenCalledWith('lapis', false)
  })

  it('onSelectTheme also updates theme and applies live preview', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).onSelectTheme('bloodstone')

    expect((wrapper.vm as any).theme).toBe('bloodstone')
    expect(mockApplyTheme).toHaveBeenCalledWith('bloodstone', false)
  })

  it('cancel reverts the previewed theme to the store theme and navigates back', async () => {
    const router = await openDirectly('#/forum')
    await router.push('/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).selectTheme('bloodstone')
    expect(mockApplyTheme).toHaveBeenCalledWith('bloodstone', false)

    ;(wrapper.vm as unknown as SettingsVm).cancel()

    expect(mockApplyTheme).toHaveBeenLastCalledWith('carnelian', false)
    expect(await waitForPath(router, '/forum')).toBe('/forum')
  })

  it('unmounting without saving reverts the previewed theme to the store theme', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).selectTheme('onyx')
    expect(mockApplyTheme).toHaveBeenCalledWith('onyx', false)

    wrapper.unmount()

    expect(mockApplyTheme).toHaveBeenLastCalledWith('carnelian', false)
  })

  it('save calls appearanceStore.setTheme and appearanceStore.setDarkMode, applies theme, and stays on settings', async () => {
    const notifyMock = jest.fn()
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router, { notify: notifyMock })

    ;(wrapper.vm as any).selectTheme('sardonyx')
    ;(wrapper.vm as any).darkMode = true

    ;(wrapper.vm as unknown as SettingsVm).save()

    expect(mockSetTheme).toHaveBeenCalledWith('sardonyx')
    expect(mockSetDarkMode).toHaveBeenCalledWith(true)
    expect(mockApplyTheme).toHaveBeenCalledWith('sardonyx', true)
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'positive',
        message: 'settings.savedNotification',
      }),
    )

    // Unmounting after save must not revert to old carnelian theme
    mockApplyTheme.mockClear()
    wrapper.unmount()
    expect(mockApplyTheme).not.toHaveBeenCalled()
  })
})

describe('Settings header (ticket #369)', () => {
  it('has a title and a labelled Back control that leaves Settings like Cancel does', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    expect(wrapper.find('q-toolbar-title').text()).toBe('settings.title')
    const back = wrapper.find('[data-test="settings-back"]')
    expect(back.attributes('aria-label')).toBe('settings.back')

    await back.trigger('click')

    expect(await waitForPath(router, '/')).toBe('/')
  })

  it('has a labelled menu control that asks the layout to toggle the drawer', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const menu = wrapper.find('[data-test="settings-menu"]')
    expect(menu.attributes('aria-label')).toBe('settings.openMenu')

    await menu.trigger('click')

    expect(wrapper.emitted('toggleMyDrawerOpen')).toHaveLength(1)
  })
})

it('has no directory installation controls and retains storage controls', async () => {
  const router = await openDirectly('#/settings')
  const wrapper = mountSettings(router)
  expect(wrapper.find('persistent-storage-panel-stub').exists()).toBe(true)
  expect(wrapper.find('directory-provisioning-panel-stub').exists()).toBe(false)
  expect(wrapper.html()).not.toMatch(/directory/i)
  expect(wrapper.find('[data-test="settings-back"]').exists()).toBe(true)
})

it('does not contain account recovery tab, backup button, or descriptor', async () => {
  const router = await openDirectly('#/settings')
  const wrapper = mountSettings(router)
  expect(wrapper.find('[data-test="recovery-descriptor"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="backup-codex32-button"]').exists()).toBe(
    false,
  )
  expect(wrapper.text()).not.toContain('accountRecovery.frank_account_recovery')
})
