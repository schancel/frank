/** @jest-environment jsdom */

import { createRouter, createWebHashHistory, Router } from 'vue-router'

import { navigateBack } from './navigate-back'

// vue-router 5 loads `nostics` and `@vue/devtools-api` (both ESM-only for Jest) just for dev
// warnings and the devtools hook; the tests need the real router's history handling, not those.
jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({
    setupDevtoolsPlugin: () => undefined,
  }),
)
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))

const Blank = { render: () => null }

/** Simulates a tab whose session history already holds entries from before the SPA (the new-tab
 * page, a previous site) and whose current entry is `hash`, with nothing in-app before it. */
async function openDirectly(hash: string): Promise<Router> {
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

describe('navigateBack (ticket #275)', () => {
  it('lands on / when the page was opened directly, even though the tab has earlier history entries', async () => {
    const router = await openDirectly('#/settings')
    // The bug: this is > 1, so the old `history.length > 1 ? go(-1) : push("/")` left the app.
    expect(window.history.length).toBeGreaterThan(1)
    const go = jest.spyOn(router, 'go')

    navigateBack(router)

    expect(await waitForPath(router, '/')).toBe('/')
    expect(go).not.toHaveBeenCalled()
    go.mockRestore()
  })

  it('returns to the previous in-app route when there is one', async () => {
    const router = await openDirectly('#/forum')
    await router.push('/settings')
    expect(router.currentRoute.value.path).toBe('/settings')

    navigateBack(router)

    expect(await waitForPath(router, '/forum')).toBe('/forum')
  })
})
