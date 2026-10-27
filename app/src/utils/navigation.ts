import { defineComponent, onBeforeUnmount, watch } from 'vue'
import type {
  RouteLocationNormalized,
  RouteLocationRaw,
  Router,
  RouterHistory,
} from 'vue-router'

/**
 * How Frank moves through history, in one place. Ordinary app behaviour, so that going forward
 * and then back always lands where the user was:
 *
 * - A page the user asks for is pushed (`router.push`, `openChat`).
 * - A back arrow or Cancel does what the browser's or the phone's Back does: it goes back when
 *   there is an in-app entry before this one, and otherwise replaces this screen with its
 *   logical parent (`goBack`).
 * - A form that finishes leaves no entry Back would reopen: it goes back to where the user came
 *   from (`returnTo`) or replaces itself with its result (`router.replace`).
 * - Bottom tabs (and the drawer's rail) do not stack (`switchTab`): the Messages tab is the start
 *   screen at the bottom of the stack, any other tab sits right above it, so Back from a tab
 *   lands on Messages and Back from Messages leaves the app (Android/Material).
 * - On a phone, Back closes an open dialog, menu or drawer instead of navigating underneath it
 *   (`useBackDismiss`), in the browser and the installed app alike.
 *
 * The router's own entries carry `position` and `back` in `history.state` (vue-router); this
 * module adds `frankStartTab` to each entry: the position of the Messages entry under it, or
 * null when there is none.
 */

/** The start screen: the bottom tab the app's back stack rests on. */
export const START_TAB = '/chat'

const START_KEY = 'frankStartTab'

interface EntryState {
  back?: unknown
  position?: unknown
  [START_KEY]?: unknown
}

function entryState(): EntryState | null {
  if (typeof window === 'undefined') return null
  return (window.history.state as EntryState | null) ?? null
}

function entryPosition(): number | null {
  const position = entryState()?.position
  return typeof position === 'number' ? position : null
}

/** The in-app location of the entry before this one (vue-router's `history.state.back`), or
 * null for the first in-app entry: then Back would leave Frank. */
export function previousInAppLocation(): string | null {
  const back = entryState()?.back
  return typeof back === 'string' && back.length > 0 ? back : null
}

/** Position of the Messages entry under the current one, when there is one. */
let committedStart: number | null = null
/** The next navigation comes from the browser's (or phone's) Back/Forward. */
let popFromUser = false
/** A Back/Forward the app itself asked for: never mistaken for the user's. */
let programmaticPops = 0
let pendingTarget: RouteLocationNormalized | null = null

function recordStartTab(path: string) {
  const state = entryState()
  const position = entryPosition()
  if (!state || position === null) {
    committedStart = null
    return
  }
  let start: number | null = null
  if (path === START_TAB) start = position
  else {
    const own = state[START_KEY]
    // An entry seen before (Back, Forward, reload) or one that replaced it keeps its own.
    if (typeof own === 'number' && own < position) start = own
    // A pushed entry sits on the one it was pushed from.
    else if (committedStart !== null && committedStart < position)
      start = committedStart
  }
  committedStart = start
  if (state[START_KEY] !== start) {
    window.history.replaceState({ ...state, [START_KEY]: start }, '')
  }
}

/** Overlays open right now, the last one on top. */
const openOverlays: { close: () => void }[] = []

function removeOverlay(entry: { close: () => void }) {
  const index = openOverlays.indexOf(entry)
  if (index !== -1) openOverlays.splice(index, 1)
}

/** Closes the overlay on top, if any is open. */
export function dismissTopOverlay(): boolean {
  const top = openOverlays[openOverlays.length - 1]
  if (!top) return false
  removeOverlay(top)
  top.close()
  return true
}

/**
 * A dialog, menu or drawer that the phone's Back closes while it is open. One registration per
 * overlay, in its component's setup: `isOpen` is its v-model, `close` sets it false.
 */
export function useBackDismiss(isOpen: () => boolean, close: () => void) {
  const entry = { close }
  const stop = watch(
    isOpen,
    open => {
      removeOverlay(entry)
      if (open) openOverlays.push(entry)
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    stop()
    removeOverlay(entry)
  })
}

/** An Options API overlay: a `data()` flag that closing sets false, or its own open/close. */
type OptionsOverlay =
  | string
  | {
      isOpen: (vm: Record<string, unknown>) => boolean
      close: (vm: Record<string, unknown>) => void
    }

/**
 * `useBackDismiss` for Options API components: `mixins: [backDismissible('menuOpen')]`. Each
 * overlay, while open, is one the phone's Back closes.
 */
export function backDismissible(...overlays: OptionsOverlay[]) {
  const registered = new WeakMap<object, { close: () => void }[]>()
  return defineComponent({
    created() {
      const vm = this as unknown as Record<string, unknown>
      const entries = overlays.map(overlay => {
        const isOpen =
          typeof overlay === 'string'
            ? () => Boolean(vm[overlay])
            : () => overlay.isOpen(vm)
        const entry = {
          close:
            typeof overlay === 'string'
              ? () => {
                  vm[overlay] = false
                }
              : () => overlay.close(vm),
        }
        this.$watch(
          isOpen,
          (open: boolean) => {
            removeOverlay(entry)
            if (open) openOverlays.push(entry)
          },
          { immediate: true },
        )
        return entry
      })
      registered.set(this, entries)
    },
    beforeUnmount() {
      for (const entry of registered.get(this) ?? []) removeOverlay(entry)
      registered.delete(this)
    },
  })
}

/** Back closes overlays where the user has a Back gesture and overlays cover the page: a
 * phone-width browser or installed web app. Native shells route their Back button through
 * `handleHardwareBack` instead. */
let backClosesOverlays: () => boolean = () => false

/** A navigation has started and has not yet been committed or refused. */
export function navigationPending(): boolean {
  return pendingTarget !== null
}

/**
 * Wires the router to this module. `history` must be the router's history, passed before the
 * router itself first listens to it, so that a Back/Forward is known as one before any guard
 * runs.
 */
export function installNavigation(
  router: Router,
  history: RouterHistory,
  options: { backClosesOverlays: () => boolean },
) {
  backClosesOverlays = options.backClosesOverlays
  history.listen(() => {
    if (programmaticPops > 0) programmaticPops--
    else popFromUser = true
  })
  // Registered before every other guard: a Back that closes an overlay stops here.
  router.beforeEach(to => {
    pendingTarget = to
    const fromUser = popFromUser
    popFromUser = false
    if (fromUser && backClosesOverlays() && dismissTopOverlay()) {
      // vue-router puts the URL back where it was: Back only closed the overlay.
      pendingTarget = null
      return false
    }
  })
  router.afterEach((to, _from, failure) => {
    if (to === pendingTarget) pendingTarget = null
    popFromUser = false
    if (!failure) recordStartTab(to.path)
  })
  router.onError(() => {
    pendingTarget = null
    popFromUser = false
  })
}

/** A router call's outcome, its refusal included, as one settled promise. */
function settled(navigation: unknown): Promise<unknown> {
  return Promise.resolve(navigation).catch(() => undefined)
}

/** Back, asked for by the app (an arrow, a Cancel). */
function historyGo(router: Pick<Router, 'go'>, delta: number) {
  programmaticPops++
  router.go(delta)
}

/** Resolves when the navigation `go(delta)` started has settled. */
function goAndSettle(router: Router, delta: number): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      stop()
      clearTimeout(timer)
      resolve()
    }
    const stop = router.afterEach(finish)
    const timer = setTimeout(finish, 1000)
    historyGo(router, delta)
  })
}

/**
 * A back arrow, close button or Cancel: exactly what Back does when there is an in-app page
 * before this one; otherwise (a deep link, a reload of the first page) this screen gives way to
 * its logical `parent`, replacing it so that Back does not come back here.
 */
export function goBack(
  router: Pick<Router, 'go' | 'replace'>,
  parent: RouteLocationRaw,
): void {
  if (previousInAppLocation() !== null) {
    historyGo(router, -1)
    return
  }
  void settled(router.replace(parent))
}

/**
 * A finished or cancelled form going to `target`: back, when `target` is the page before it,
 * otherwise replacing the form. Either way Back never reopens the form.
 */
export function returnTo(
  router: Pick<Router, 'go' | 'replace' | 'resolve'>,
  target: RouteLocationRaw,
): void {
  const previous = previousInAppLocation()
  if (
    previous !== null &&
    router.resolve(previous).fullPath === router.resolve(target).fullPath
  ) {
    historyGo(router, -1)
    return
  }
  void settled(router.replace(target))
}

/**
 * A bottom-tab (or rail) tap. Tabs do not stack: Messages (`START_TAB`) rests at the bottom and
 * every other tab's root replaces the one above it, so Back from any tab lands on Messages and
 * Back from Messages leaves the app.
 *
 * `beforeStep` runs before each router step (a tab switch can be a Back followed by a replace).
 */
export async function switchTab(
  router: Router,
  tab: string,
  options?: { beforeStep?: () => void },
): Promise<void> {
  const step = options?.beforeStep ?? (() => undefined)
  if (router.currentRoute.value.path === tab) return
  const position = entryPosition()
  const start = committedStart
  if (position !== null && start !== null && start <= position) {
    if (start === position) {
      // On Messages: the tab opens above it.
      step()
      await settled(router.push(tab))
      return
    }
    if (tab === START_TAB) {
      step()
      await goAndSettle(router, start - position)
      return
    }
    // Deeper inside another tab: first back to that tab's root, right above Messages.
    if (position - start > 1) {
      step()
      await goAndSettle(router, start + 1 - position)
    }
    step()
    await settled(router.replace(tab))
    return
  }
  // No Messages under this screen (the app was opened elsewhere): Messages takes this entry and
  // the tab opens above it.
  step()
  await settled(router.replace(START_TAB))
  if (tab === START_TAB) return
  step()
  await settled(router.push(tab))
}

/**
 * The phone's own Back button (Capacitor). An open overlay closes first. Messages, the start
 * screen, leaves the app, as does the first screen of the session; anywhere else Back goes back.
 */
export function handleHardwareBack(
  router: Pick<Router, 'go' | 'currentRoute'>,
  exitApp: () => void,
): void {
  if (dismissTopOverlay()) return
  const path = router.currentRoute.value.path
  if (path === START_TAB || previousInAppLocation() === null) {
    exitApp()
    return
  }
  historyGo(router, -1)
}

/** Test seam: forget what was recorded about the last router. */
export function resetNavigationForTests() {
  committedStart = null
  popFromUser = false
  programmaticPops = 0
  pendingTarget = null
  openOverlays.splice(0)
  backClosesOverlays = () => false
}
