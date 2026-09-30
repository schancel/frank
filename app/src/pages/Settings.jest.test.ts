/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createRouter, createWebHashHistory, Router } from 'vue-router'

import SettingsPage from './Settings.vue'

// See navigate-back.jest.test.ts: vue-router 5's ESM-only dev-only dependencies.
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
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: () =>
    jest.requireActual('vue').reactive({ darkMode: false, locale: 'en-us' }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () =>
    jest.requireActual('vue').reactive({ updateInterval: 60_000 }),
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

function mountSettings(router: Router) {
  return shallowMount(SettingsPage, {
    global: {
      mocks: {
        $t: (key: string) => key,
        $q: { dark: { set: jest.fn() } },
        $i18n: { locale: 'en-us' },
        $router: router,
      },
    },
  })
}

type SettingsVm = { save: () => void; cancel: () => void }

describe('Settings Save/Cancel navigation (ticket #275)', () => {
  it.each(['save', 'cancel'] as const)(
    '%s stays inside the app when Settings was opened directly',
    async action => {
      const router = await openDirectly('#/settings')
      const wrapper = mountSettings(router)

      ;(wrapper.vm as unknown as SettingsVm)[action]()

      expect(await waitForPath(router, '/')).toBe('/')
      expect(window.location.hash).toBe('#/')
    },
  )

  it.each(['save', 'cancel'] as const)(
    '%s returns to the previous in-app route when there is one',
    async action => {
      const router = await openDirectly('#/forum')
      await router.push('/settings')
      const wrapper = mountSettings(router)

      ;(wrapper.vm as unknown as SettingsVm)[action]()

      expect(await waitForPath(router, '/forum')).toBe('/forum')
    },
  )
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
