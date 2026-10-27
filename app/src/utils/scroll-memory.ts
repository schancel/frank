import { nextTick } from 'vue'
import type { Router, RouterHistory } from 'vue-router'
import { navigationPending } from './navigation'

/**
 * Where the user had scrolled, kept for each history entry, so that Back and Forward (and a
 * reload) return to the same place in the page, as a browser does for an ordinary site.
 *
 * Frank's pages do not scroll the window: each scrolls in its own element (Quasar's page
 * container, a scroll area, a virtual list). So positions are kept per element: each element
 * the user scrolls is recorded under the entry's history position (`history.state.position`)
 * with the route it showed. On Back or Forward the entry's elements are scrolled back, waiting
 * for content that is still loading (up to `RESTORE_LIMIT_MS`, never past the user's own
 * scrolling). A new page (a push, or a replace by another page) starts at the top: elements
 * that outlive the navigation (a layout's scroll area) are scrolled to the top; new ones start
 * there anyway. A change in place (a tab, a search, a filter: the same path) keeps its scroll.
 *
 * Not restored, because they keep their own place:
 * - the drawers (`.q-drawer`): the sidebar is not part of the page and stays as the user left
 *   it;
 * - anything inside `[data-scroll-restore="off"]`: a conversation opens on its newest message,
 *   or on its own history anchor (Chat.vue).
 *
 * Positions are kept for the tab (sessionStorage), so a reload finds them.
 */

export const SCROLL_STORAGE_KEY = 'frank:scroll-positions'
/** How long a restore waits for an entry's content to be long enough. */
const RESTORE_LIMIT_MS = 2000
/** At most this many entries are kept. */
const MAX_ENTRIES = 100
const EXCLUDED = '.q-drawer, [data-scroll-restore="off"]'
const DOCUMENT_KEY = 'document'
const ROOT_ID = 'q-app'

interface EntryScroll {
  /** The route the entry showed (its full path) when the offsets were recorded. */
  path: string
  /** Element key (`keyOf`) -> scrollTop. */
  offsets: Record<string, number>
}

let entries = new Map<number, EntryScroll>()
/** Elements the user has scrolled, still in the page: what a new page scrolls back to the top. */
const scrolled = new Set<Element>()
let router: Router | null = null
/** A Back or Forward is under way (seen by the history listener, not yet committed). */
let popped = false
/** The history position of the entry last committed. */
let lastPosition: number | null = null
/** A restore is running: scroll events then are the restore's own, not the user's. */
let restoring: { stop: () => void } | null = null
let persistTimer: ReturnType<typeof setTimeout> | undefined
let frame: number | undefined
const dirty = new Set<Element | Document>()
let cleanups: (() => void)[] = []

function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

function load() {
  entries = new Map()
  try {
    const raw = storage()?.getItem(SCROLL_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as [number, EntryScroll][]
    if (!Array.isArray(parsed)) return
    for (const [position, entry] of parsed) {
      if (
        typeof position === 'number' &&
        entry &&
        typeof entry.path === 'string' &&
        entry.offsets &&
        typeof entry.offsets === 'object'
      )
        entries.set(position, entry)
    }
  } catch {
    // Unreadable: start without saved positions.
  }
}

function persist() {
  if (persistTimer !== undefined) clearTimeout(persistTimer)
  persistTimer = undefined
  try {
    // The newest entries, when there are too many.
    const kept = [...entries.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-MAX_ENTRIES)
    storage()?.setItem(SCROLL_STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // No storage: Back and Forward still restore; only a reload does not.
  }
}

function schedulePersist() {
  if (persistTimer !== undefined) return
  persistTimer = setTimeout(persist, 300)
}

function currentPosition(): number | null {
  if (typeof window === 'undefined') return null
  const position = (window.history.state as { position?: unknown } | null)
    ?.position
  return typeof position === 'number' ? position : null
}

function root(): Element | null {
  return typeof document === 'undefined'
    ? null
    : document.getElementById(ROOT_ID) ?? document.body
}

/**
 * A stable name for an element: its path from the app's root, each step the tag and its index
 * among the siblings with that tag. The same route shows the same structure, so the name finds
 * the element again after the page is rebuilt.
 */
function keyOf(element: Element): string | null {
  if (typeof document !== 'undefined' && element === document.scrollingElement)
    return DOCUMENT_KEY
  const top = root()
  if (!top || !top.contains(element) || element === top) return null
  const steps: string[] = []
  let node: Element | null = element
  while (node && node !== top) {
    const parent: Element | null = node.parentElement
    if (!parent) return null
    const tag = node.tagName
    let index = 0
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) break
      if (sibling.tagName === tag) index++
    }
    steps.push(`${tag}:${index}`)
    node = parent
  }
  return steps.reverse().join('/')
}

function findByKey(key: string): Element | null {
  if (key === DOCUMENT_KEY) return document.scrollingElement
  let node: Element | null = root()
  for (const step of key.split('/')) {
    if (!node) return null
    const [tag, rawIndex] = step.split(':')
    const index = Number(rawIndex)
    node =
      Array.from(node.children as HTMLCollection).filter(
        (child: Element) => child.tagName === tag,
      )[index] ?? null
  }
  return node
}

function excluded(element: Element): boolean {
  return element !== document.scrollingElement && !!element.closest(EXCLUDED)
}

function scrollElement(target: EventTarget | null): Element | null {
  if (typeof document === 'undefined') return null
  if (target === document) return document.scrollingElement
  return target instanceof Element ? target : null
}

/**
 * Records the scroll offsets of the elements that scrolled since the last frame. `leaving`: a
 * navigation is starting, and the page on screen is still the entry's.
 */
function record(leaving = false) {
  frame = undefined
  const elements = [...dirty]
  dirty.clear()
  // While a navigation or a restore is under way, the page on screen is not (yet) the entry's.
  if (!router || restoring || popped || (!leaving && navigationPending()))
    return
  const position = currentPosition()
  if (position === null) return
  const path = router.currentRoute.value.fullPath
  let entry = entries.get(position)
  if (!entry || entry.path !== path) entry = { path, offsets: {} }
  for (const target of elements) {
    const element = scrollElement(target)
    if (!element || !element.isConnected || excluded(element)) continue
    const key = keyOf(element)
    if (!key) continue
    scrolled.add(element)
    entry.offsets[key] = element.scrollTop
  }
  entries.set(position, entry)
  schedulePersist()
}

function onScroll(event: Event) {
  if (!event.target) return
  dirty.add(event.target as Element | Document)
  if (frame === undefined) frame = requestAnimationFrame(() => record())
}

/** The elements the user scrolled that outlived the navigation. */
function lastingScrolled(): Element[] {
  for (const element of [...scrolled])
    if (!element.isConnected) scrolled.delete(element)
  const lasting = [...scrolled]
  const page = document.scrollingElement
  if (page && !lasting.includes(page)) lasting.push(page)
  return lasting.filter(element => !excluded(element))
}

function toTop() {
  for (const element of lastingScrolled())
    if (element.scrollTop !== 0) element.scrollTop = 0
}

/** Scrolls the entry's elements back, as its content arrives. */
function restore(saved: EntryScroll) {
  restoring?.stop()
  // What outlived the navigation and the entry did not scroll starts at the top.
  toTop()
  const started = Date.now()
  const remaining = new Map(Object.entries(saved.offsets))
  let timer: number | undefined
  const stop = () => {
    if (timer !== undefined) cancelAnimationFrame(timer)
    timer = undefined
    for (const type of USER_SCROLL_EVENTS)
      window.removeEventListener(type, stop, true)
    if (restoring?.stop === stop) restoring = null
  }
  restoring = { stop }
  // The user's own scrolling wins: the restore stops at once.
  for (const type of USER_SCROLL_EVENTS)
    window.addEventListener(type, stop, { capture: true, passive: true })
  const step = () => {
    timer = undefined
    for (const [key, top] of [...remaining]) {
      const element = findByKey(key)
      if (!element || excluded(element)) continue
      scrolled.add(element)
      element.scrollTop = top
      // Done once the element is long enough to be at that offset.
      if (Math.abs(element.scrollTop - top) <= 1) remaining.delete(key)
    }
    if (remaining.size === 0 || Date.now() - started > RESTORE_LIMIT_MS) {
      stop()
      return
    }
    timer = requestAnimationFrame(step)
  }
  step()
}

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown']

/**
 * Keeps scroll positions per history entry (see above). `history` is the router's history:
 * installed before the router first listens to it, so a Back or Forward is known as one before
 * the navigation is followed.
 */
export function installScrollMemory(
  appRouter: Router,
  history: RouterHistory,
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  router = appRouter
  load()
  const stopListening = history.listen(() => {
    popped = true
  })
  appRouter.beforeEach((_to, from) => {
    // Takes what the last frame has not recorded yet, while the page on screen is still the
    // entry's (a Back or Forward has already moved the entry: its events stop counting).
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      if (!popped && from.matched.length) record(true)
      else dirty.clear()
      frame = undefined
    }
  })
  appRouter.afterEach((to, from, failure) => {
    const wasPop = popped
    popped = false
    if (failure) return
    const position = currentPosition()
    const previous = lastPosition
    lastPosition = position
    const saved = position === null ? undefined : entries.get(position)
    const restorable = saved && saved.path === to.fullPath ? saved : undefined
    // Back or Forward, or the first navigation (a load or a reload): the entry's own
    // positions, if it has any.
    if (wasPop || !from.matched.length) {
      void nextTick(() => {
        if (restorable) restore(restorable)
        else if (wasPop) {
          restoring?.stop()
          toTop()
        }
      })
      return
    }
    // A push: what was kept for this entry and every one after it (the entries Forward had)
    // is gone.
    const pushed = position !== null && position !== previous
    if (pushed) {
      for (const kept of [...entries.keys()])
        if (kept >= position) entries.delete(kept)
      schedulePersist()
    }
    // A change in place keeps its scroll: a tab, a search, a filter, a form's next step.
    if (from.path === to.path) {
      if (!pushed && saved && saved.path === from.fullPath) {
        saved.path = to.fullPath
        schedulePersist()
      }
      return
    }
    // Another page: it starts at the top.
    if (!pushed && position !== null && entries.delete(position))
      schedulePersist()
    restoring?.stop()
    void nextTick(() => toTop())
  })
  document.addEventListener('scroll', onScroll, {
    capture: true,
    passive: true,
  })
  const onHide = () => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      record(true)
    }
    persist()
  }
  window.addEventListener('pagehide', onHide)
  cleanups = [
    stopListening,
    () => document.removeEventListener('scroll', onScroll, { capture: true }),
    () => window.removeEventListener('pagehide', onHide),
  ]
}

/** Test seam: forget the router and what was recorded in memory. */
export function resetScrollMemoryForTests() {
  for (const cleanup of cleanups) cleanup()
  cleanups = []
  restoring?.stop()
  restoring = null
  router = null
  popped = false
  lastPosition = null
  entries = new Map()
  scrolled.clear()
  dirty.clear()
  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
  if (persistTimer !== undefined) clearTimeout(persistTimer)
  persistTimer = undefined
}
