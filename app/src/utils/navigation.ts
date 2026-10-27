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
 *   from (`returnTo`), replaces itself with its result (`router.replace`), or, for a flow opened
 *   from a page that no longer applies, replaces both (`replaceFlow`).
 * - Bottom tabs (and the drawer's rail) do not stack (`switchTab`): the Messages tab (the list,
 *   or the conversation open in it) rests at the bottom of the stack, any other tab sits right
 *   above it, so Back from a tab lands where the user left Messages and Back from Messages
 *   leaves the app (Android/Material). No page in between is ever shown.
 * - On a phone, Back closes the overlay on top instead of navigating underneath it: any Quasar
 *   dialog, menu or select popup (found in the page, so none can be missed), or a drawer
 *   registered with `useBackDismiss`. A persistent dialog stays and Back does nothing, as with
 *   Quasar's own handling in a native app. Forward never closes anything.
 *
 * The router's own entries carry `position` and `back` in `history.state` (vue-router); this
 * module adds `frankStartTab` to each entry: the position of the Messages entry under it, or
 * null when there is none.
 */

/** The start screen: the bottom tab the app's back stack rests on. */
export const START_TAB = '/chat'

const START_KEY = 'frankStartTab'

/** The Messages tab: the list, and the conversation open in it. */
function isMessagesPath(path: string) {
  return path === START_TAB || path.startsWith(`${START_TAB}/`)
}

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
/** The router's history (`installNavigation`). */
let routerHistory: RouterHistory | null = null
/** The pending navigation is the browser's (or phone's) Back or Forward. */
let userPop: { direction: string; delta: number } | null = null
/** A Back or Forward has happened and the router's guards have not yet seen it. */
let popPending = false
/** Back/Forward steps the app itself asked for: never mistaken for the user's. */
let programmaticPops = 0
/** `router.push`/`router.replace` calls not yet settled. */
let callsInFlight = 0
let pendingTarget: RouteLocationNormalized | null = null
/** A user's Back that only closed an overlay: how far it had moved. */
let refusedPopDelta: number | null = null
/** A tab switch is under way. */
let switching = false

function recordStartTab(path: string) {
  const state = entryState()
  const position = entryPosition()
  if (!state || position === null) {
    committedStart = null
    return
  }
  let start: number | null = null
  if (isMessagesPath(path)) start = position
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

/** Registered overlays (drawers) open right now, the last one on top. */
const openOverlays: { close: () => void }[] = []

function removeOverlay(entry: { close: () => void }) {
  const index = openOverlays.indexOf(entry)
  if (index !== -1) openOverlays.splice(index, 1)
}

/**
 * A Quasar dialog (a modal one: not a seamless banner), menu or select popup that is showing.
 * Every one of them, `$q.dialog` and `Dialog.create` included, sits in a portal under `body`.
 * One on its way out (its leave transition) no longer counts; a closing dialog also stops being
 * modal at once.
 */
function quasarOverlayShowing(): boolean {
  if (typeof document === 'undefined') return false
  return Array.from(
    document.querySelectorAll('.q-dialog--modal, .q-menu'),
  ).some(
    element => !/leave-(active|to)/.test(element.getAttribute('class') ?? ''),
  )
}

/**
 * Quasar's own dismissal of the overlay on top: the Escape key. A dismissible dialog or menu
 * closes; a persistent dialog stays (and shakes), as it does for Back in Quasar's native-app
 * handling.
 */
function pressEscape() {
  for (const type of ['keydown', 'keyup']) {
    const event = new KeyboardEvent(type, { key: 'Escape', code: 'Escape' })
    // Quasar reads `keyCode`, which the constructor does not set.
    Object.defineProperty(event, 'keyCode', { get: () => 27 })
    window.dispatchEvent(event)
  }
}

/**
 * Back on an open overlay: dismisses the one on top. True when an overlay was showing, a
 * persistent dialog that stays included: Back then does nothing else.
 */
export function dismissTopOverlay(): boolean {
  // Quasar's overlays are portals above everything else, the drawers included.
  if (quasarOverlayShowing()) {
    pressEscape()
    return true
  }
  const top = openOverlays[openOverlays.length - 1]
  if (!top) return false
  removeOverlay(top)
  top.close()
  return true
}

/**
 * A drawer (an overlay that is not a Quasar dialog or menu) that the phone's Back closes while
 * it covers the page. `isOpen` says whether it does now (a drawer only does on a narrow screen);
 * `close` closes it.
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

/** An Options API overlay's open state and close. */
interface OptionsOverlay {
  isOpen: (vm: Record<string, unknown>) => boolean
  close: (vm: Record<string, unknown>) => void
}

/** `useBackDismiss` for Options API components: `mixins: [backDismissible({ isOpen, close })]`. */
export function backDismissible(...overlays: OptionsOverlay[]) {
  const registered = new WeakMap<object, { close: () => void }[]>()
  return defineComponent({
    created() {
      const vm = this as unknown as Record<string, unknown>
      const entries = overlays.map(overlay => {
        const entry = { close: () => overlay.close(vm) }
        this.$watch(
          () => overlay.isOpen(vm),
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

/**
 * A navigation has been asked for and is not yet committed or refused: from the moment of the
 * `router.push`/`replace` call or of the Back/Forward, not only once the router's guards run.
 */
export function navigationPending(): boolean {
  return (
    callsInFlight > 0 ||
    popPending ||
    programmaticPops > 0 ||
    pendingTarget !== null
  )
}

/** Resolves once no navigation is pending (or after a second, whatever happens). */
function navigationIdle(): Promise<void> {
  const started = Date.now()
  return new Promise(resolve => {
    const check = () => {
      if (!navigationPending() || Date.now() - started > 1000) resolve()
      else setTimeout(check, 10)
    }
    check()
  })
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
  routerHistory = history
  backClosesOverlays = options.backClosesOverlays
  // Pending from the call on, so that whatever watches `navigationPending` does not depend on
  // when the router's first guard happens to run.
  for (const method of ['push', 'replace'] as const) {
    if (typeof router[method] !== 'function') continue
    const navigate = router[method].bind(router)
    router[method] = (to: RouteLocationRaw) => {
      callsInFlight++
      const result = navigate(to)
      void settled(result).then(() => {
        callsInFlight--
      })
      return result
    }
  }
  history.listen((_to, _from, info) => {
    if (programmaticPops > 0) {
      programmaticPops--
      return
    }
    userPop = { direction: info.direction, delta: info.delta }
    popPending = true
  })
  // Registered before every other guard: a Back that closes an overlay stops here.
  router.beforeEach(to => {
    pendingTarget = to
    popPending = false
    const pop = userPop
    userPop = null
    if (
      pop?.direction === 'back' &&
      backClosesOverlays() &&
      dismissTopOverlay()
    ) {
      // vue-router puts the URL back where it was: Back only closed the overlay.
      pendingTarget = null
      refusedPopDelta = pop.delta
      return false
    }
  })
  router.afterEach((to, _from, failure) => {
    if (to === pendingTarget) pendingTarget = null
    userPop = null
    popPending = false
    const refused = refusedPopDelta
    refusedPopDelta = null
    // A Back onto an address that redirects (#/, /receive, ...) is followed as a replace, not as
    // the Back itself, so vue-router does not put the URL back when it is refused: do it here.
    if (failure && refused !== null && to.redirectedFrom) {
      routerHistory?.go(-refused, false)
    }
    if (!failure) recordStartTab(to.path)
  })
  router.onError(() => {
    pendingTarget = null
    userPop = null
    popPending = false
    refusedPopDelta = null
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
 * Moves the session history by `delta` without the router following: neither the pages in
 * between nor the one landed on are shown. The caller then replaces the entry landed on.
 */
function moveUnseen(delta: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      window.removeEventListener('popstate', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 1000)
    window.addEventListener('popstate', done)
    if (routerHistory) routerHistory.go(delta, false)
    else done()
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
 * A finished flow going to `target`, when it was opened from `from`, a page that no longer
 * applies once the flow is done (Welcome, once there is an account): the flow and that page
 * both give way to `target`, unseen, so Back returns to neither. Otherwise the flow replaces
 * itself.
 */
export async function replaceFlow(
  router: Pick<Router, 'replace' | 'resolve'>,
  from: string,
  target: RouteLocationRaw,
): Promise<void> {
  const previous = previousInAppLocation()
  if (
    previous !== null &&
    router.resolve(previous).path === router.resolve(from).path
  ) {
    await moveUnseen(-1)
  }
  await settled(router.replace(target))
}

/**
 * A bottom-tab (or rail) tap. Tabs do not stack: Messages (`START_TAB`: the list, or the
 * conversation open in it) rests at the bottom and every other tab's root replaces the one
 * above it, so Back from any tab lands where the user left Messages and Back from Messages
 * leaves the app. No page in between is ever shown.
 *
 * `beforeStep` runs right before the router step.
 */
export async function switchTab(
  router: Router,
  tab: string,
  options?: { beforeStep?: () => void },
): Promise<void> {
  // A second tap while the first is under way would act on a position about to change.
  if (switching) return
  switching = true
  try {
    // So would a Back (or any navigation) that is still being decided.
    await navigationIdle()
    await switchTabNow(router, tab, options?.beforeStep ?? (() => undefined))
  } finally {
    switching = false
  }
}

async function switchTabNow(router: Router, tab: string, step: () => void) {
  if (router.currentRoute.value.path === tab) return
  const position = entryPosition()
  const start = committedStart
  if (position !== null && start !== null && start <= position) {
    if (start === position) {
      // On Messages. Messages itself, from a conversation: its list (Back to it when it is
      // right under the conversation). Any other tab opens above it.
      step()
      if (tab === START_TAB && previousInAppLocation() === START_TAB)
        await goAndSettle(router, -1)
      else await settled(router.push(tab))
      return
    }
    if (tab === START_TAB) {
      // Back to Messages as the user left it: one step, only that entry is shown.
      step()
      await goAndSettle(router, start - position)
      return
    }
    // Deeper inside another tab: back to that tab's root, right above Messages, unseen.
    step()
    if (position - start > 1) await moveUnseen(start + 1 - position)
    await settled(router.replace(tab))
    return
  }
  // No Messages under this screen (the app was opened elsewhere): Messages takes this entry,
  // unseen, and the tab opens above it.
  step()
  if (tab === START_TAB) {
    await settled(router.replace(START_TAB))
    return
  }
  markEntryAsMessages()
  await settled(router.push(tab))
}

/** Makes the current entry the Messages entry without showing Messages. */
function markEntryAsMessages() {
  const position = entryPosition()
  if (!routerHistory || position === null) return
  routerHistory.replace(START_TAB)
  const state = entryState()
  if (state)
    window.history.replaceState({ ...state, [START_KEY]: position }, '')
  committedStart = position
}

/**
 * The phone's own Back button (Capacitor). An open overlay closes first, and a persistent dialog
 * keeps Back from doing anything. The Messages list, the start screen, leaves the app, as does
 * the first screen of the session; anywhere else Back goes back.
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
  routerHistory = null
  userPop = null
  popPending = false
  programmaticPops = 0
  callsInFlight = 0
  pendingTarget = null
  refusedPopDelta = null
  switching = false
  openOverlays.splice(0)
  backClosesOverlays = () => false
}
