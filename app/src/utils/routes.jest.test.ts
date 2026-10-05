/**
 * Unit tests for `utils/routes.ts` -- the shared navigation helper every "open a page"/"open a
 * chat" call site in the app goes through (`LeftDrawer.vue`, `SettingsPanel.vue`, `TopicList.vue`,
 * etc.). The one behavior worth locking down: navigating *from* a settings-family route replaces
 * history instead of pushing, so "back" from e.g. /send doesn't return you to /profile -- it
 * returns you to wherever you were before you entered the settings flow at all.
 */
import type { Router } from 'vue-router'
import {
  openPage,
  openChat,
  openContactProfile,
  settingsRoutes,
} from './routes'

function makeRouter(currentPath: string): Router {
  return {
    currentRoute: { value: { path: currentPath } },
    push: jest.fn(),
    replace: jest.fn(),
  } as unknown as Router
}

describe('openPage', () => {
  it('pushes a new history entry when navigating from a non-settings route', () => {
    const router = makeRouter('/chat/0xabc')
    openPage(router, '/settings')
    expect(router.push).toHaveBeenCalledWith('/settings')
    expect(router.replace).not.toHaveBeenCalled()
  })

  it.each(settingsRoutes)(
    'replaces the current history entry when already on %s',
    settingsRoute => {
      const router = makeRouter(settingsRoute)
      openPage(router, '/send')
      expect(router.replace).toHaveBeenCalledWith('/send')
      expect(router.push).not.toHaveBeenCalled()
    },
  )

  it('matches a settings route by prefix (e.g. a sub-path of /profile)', () => {
    const router = makeRouter('/profile/edit')
    openPage(router, '/send')
    expect(router.replace).toHaveBeenCalledWith('/send')
  })
})

describe('openChat', () => {
  it('builds a /chat/:address route and opens it via openPage', () => {
    const router = makeRouter('/topic/news')
    openChat(router, '0xabc')
    expect(router.push).toHaveBeenCalledWith('/chat/0xabc')
  })

  it('replaces rather than pushes when opening a chat from a settings route', () => {
    const router = makeRouter('/receive')
    openChat(router, '0xabc')
    expect(router.replace).toHaveBeenCalledWith('/chat/0xabc')
  })
})

describe('openContactProfile', () => {
  it('builds a /chat/:address?info=true route and opens it via openPage', () => {
    const router = makeRouter('/forum')
    openContactProfile(router, '0xabc')
    expect(router.push).toHaveBeenCalledWith('/chat/0xabc?info=true')
  })

  it('replaces rather than pushes when opening profile from a settings route', () => {
    const router = makeRouter('/settings')
    openContactProfile(router, '0xabc')
    expect(router.replace).toHaveBeenCalledWith('/chat/0xabc?info=true')
  })
})
