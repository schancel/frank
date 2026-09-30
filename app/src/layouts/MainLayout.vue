<template>
  <q-layout view="lHr lpr lFr">
    <q-drawer
      v-model="myDrawerOpen"
      :width="splitterRatio"
      :breakpoint="drawerBreakpoint"
      show-if-above
      @keydown.esc="closeOverlayOnEscape"
    >
      <!-- `closeDrawer` bubbles up from ChatList.vue (several layers below, via LeftDrawer.vue's
      own `v-bind="$attrs"` on `<chat-list>` -- LeftDrawer.vue declares no `emits` of its own, so
      this listener lands in its `$attrs` and forwards straight through). See ChatList.vue's own
      comment on `setActiveChat` for why. -->
      <left-drawer @closeDrawer="closeDrawerForNavigation" />
    </q-drawer>
    <router-view
      @toggleContactDrawerOpen="toggleContactDrawerOpen"
      @toggleMyDrawerOpen="toggleMyDrawerOpen"
      @setupCompleted="$emit('setupCompleted')"
    />
  </q-layout>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { NavigationFailure, RouteLocationNormalized } from 'vue-router'

import { DRAWER_BREAKPOINT, isNarrowWidth } from '../utils/layout'

import LeftDrawer from '../components/panels/LeftDrawer.vue'

const compactWidth = 70
const compactCutoff = 325
const compactMidpoint = (compactCutoff + compactWidth) / 2
// Same value passed to `q-drawer`'s own `:breakpoint` below -- kept as one named constant so
// the two can't silently drift apart, since `myDrawerOpen`'s own initial value (see `data()`)
// has to agree with it to avoid the mobile bug this constant's introduction fixed (ticket #123,
// found live): `show-if-above` only forces the drawer open *above* the breakpoint -- below it,
// visibility is governed by `v-model` alone, and `myDrawerOpen` defaulted to `true`
// unconditionally, so a page loaded directly at a narrow width (no resize event to trigger
// Quasar's own breakpoint-crossing logic) showed the drawer open as a permanent overlay,
// squeezing the actual chat/forum content into a sliver instead of collapsing it out of the way.
const drawerBreakpoint = DRAWER_BREAKPOINT

export default defineComponent({
  components: {
    LeftDrawer,
  },
  setup() {
    return {}
  },
  emits: ['setupCompleted'],
  data() {
    return {
      railNavigation: false,
      removeAfterEach: undefined as (() => void) | undefined,
      removeOnError: undefined as (() => void) | undefined,
      // Control that had focus when the overlay was opened (the page header's menu button).
      drawerOpener: null as HTMLElement | null,
      // Set by @closeDrawer (chat picked): the restore then waits for the navigation to settle,
      // because the opener may be swapped out with the route. `ownedClose` tells the
      // myDrawerOpen watcher not to also restore for that same close.
      pendingRestore: null as { opener: HTMLElement | null } | null,
      pendingRestoreTimer: undefined as
        | ReturnType<typeof setTimeout>
        | undefined,
      ownedClose: false,
      // Background layout children this component marked `inert` for the open overlay; only these
      // are un-marked again, so an `inert` set by anything else is never touched (#277).
      inertedByOverlay: [] as HTMLElement[],
      // Set in beforeUnmount: a restore still in flight must not touch a dead layout's page.
      disposed: false,
      trueSplitterRatio: compactCutoff,
      // See `drawerBreakpoint`'s own comment above for why this can't just be `true`.
      myDrawerOpen: !isNarrowWidth(this.$q.screen.width),
      contactDrawerOpen: false as boolean,
      compact: false,
      compactWidth,
      drawerBreakpoint,
    }
  },
  provide() {
    return {
      markRailNavigation: () => {
        this.railNavigation = true
      },
    }
  },
  created() {
    // Every navigation that picks a destination from the drawer (chat select, forum topic,
    // settings items, balance/receive, ...) must dismiss the overlay on narrow screens, otherwise it
    // stays on top of the page just navigated to. One router hook instead of a per-call-site
    // emit; desktop keeps the drawer open.
    this.removeAfterEach = this.$router.afterEach(
      (
        _to: RouteLocationNormalized,
        _from: RouteLocationNormalized,
        failure?: NavigationFailure | void,
      ) => {
        // Consume the rail-tab marker on every navigation outcome so it can't leak.
        const railTab = this.railNavigation
        this.railNavigation = false
        // Duplicate/cancelled/blocked navigations never left the drawer; rail-tab switches
        // stay inside it.
        // The navigation has settled: a pending @closeDrawer focus restore can run now.
        this.flushPendingRestore()
        if (failure || railTab) return
        if (isNarrowWidth(this.$q.screen.width)) {
          // Focus is restored by the myDrawerOpen watcher, shared with every other way the
          // overlay can close (Escape, backdrop, swipe, @closeDrawer).
          this.myDrawerOpen = false
        }
      },
    )
    // A guard that throws (e.g. redirectIfNoProfile) skips afterEach entirely and routes to
    // onError instead, so the marker would otherwise survive and keep the overlay open for the
    // *next* navigation.
    this.removeOnError = this.$router.onError(() => {
      this.railNavigation = false
      this.flushPendingRestore()
    })
  },
  beforeUnmount() {
    this.disposed = true
    this.setBackgroundInert(false)
    this.removeAfterEach?.()
    this.removeOnError?.()
    clearTimeout(this.pendingRestoreTimer)
  },
  watch: {
    // While the drawer is an overlay, nothing behind it may take focus or clicks (#277): Tab must
    // stay in the drawer, and a screen reader must not read the page under the backdrop. Synchronous
    // so the background is interactive again before any focus restore for the same close runs.
    overlayOpen: {
      handler(open: boolean) {
        this.setBackgroundInert(open)
      },
      flush: 'sync',
    },
    // Any open/close, however triggered: refresh the opener on every open so a stale one is never
    // restored, and hand focus back on every narrow-screen close.
    myDrawerOpen(open: boolean, wasOpen: boolean) {
      const narrow = isNarrowWidth(this.$q.screen.width)
      if (open) {
        // Only the narrow overlay hands focus back; never keep a control from a desktop open.
        const active = document.activeElement
        this.drawerOpener =
          narrow && active instanceof HTMLElement && active !== document.body
            ? active
            : null
        if (narrow) void this.moveFocusIntoDrawer()
        return
      }
      // Every close forgets the opener, restored or not.
      const opener = this.drawerOpener
      this.drawerOpener = null
      if (this.ownedClose) {
        this.ownedClose = false
        return
      }
      if (wasOpen && narrow) this.restoreFocusAfterOverlay(opener)
    },
  },
  methods: {
    // Opening the overlay leaves focus on the (now covered) opener, so the first Tab walked the
    // whole page behind the drawer before reaching it (#277). Land on the rail's selected tab -- the
    // drawer's roving-tabindex stop -- or, failing that, the first control in the drawer.
    async moveFocusIntoDrawer() {
      await this.$nextTick()
      if (this.disposed || !this.overlayOpen) return
      const drawer = this.$el?.querySelector?.('.q-drawer') as
        | HTMLElement
        | null
        | undefined
      const target =
        drawer?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        ) ??
        drawer?.querySelector<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        )
      target?.focus({ preventScroll: true })
    },
    // Quasar's own Escape handling is a window-level keydown+keyup pair that does not fire while a
    // rail tab or drawer item has focus in the browser -- exactly where focus now lands on open --
    // so the drawer closes itself on Escape from anywhere inside it.
    closeOverlayOnEscape() {
      if (this.overlayOpen) this.myDrawerOpen = false
    },
    setBackgroundInert(on: boolean) {
      if (!on) {
        for (const el of this.inertedByOverlay) el.removeAttribute('inert')
        this.inertedByOverlay = []
        return
      }
      const root = this.$el as HTMLElement | undefined
      if (!root?.children) return
      for (const child of Array.from(root.children) as HTMLElement[]) {
        // The drawer (and its backdrop) live in Quasar's drawer container; everything else in the
        // layout -- header, page container, footer, the forum's own drawer -- is background.
        if (child.classList.contains('q-drawer-container')) continue
        if (child.classList.contains('q-drawer')) continue
        if (child.hasAttribute('inert')) continue
        child.setAttribute('inert', '')
        this.inertedByOverlay.push(child)
      }
    },
    toggleContactDrawerOpen() {
      this.contactDrawerOpen = !this.contactDrawerOpen
    },
    // Closing the overlay unmounts/hides the control that had focus, which drops focus to <body>
    // (keyboard and screen-reader users lose their place). Hand it back to the control that
    // opened the drawer if it survived the navigation, else to the main content region.
    closeDrawerForNavigation() {
      if (this.myDrawerOpen && isNarrowWidth(this.$q.screen.width)) {
        this.pendingRestore = { opener: this.drawerOpener }
        this.drawerOpener = null
        this.ownedClose = true
        // Fallback for a pick that never navigates at all.
        clearTimeout(this.pendingRestoreTimer)
        this.pendingRestoreTimer = setTimeout(
          () => this.flushPendingRestore(),
          1500,
        )
      }
      this.myDrawerOpen = false
    },
    flushPendingRestore() {
      const pending = this.pendingRestore
      if (!pending) return
      this.pendingRestore = null
      clearTimeout(this.pendingRestoreTimer)
      this.restoreFocusAfterOverlay(pending.opener)
    },
    async restoreFocusAfterOverlay(opener: HTMLElement | null) {
      await this.$nextTick()
      if (this.disposed) return
      // Only repair focus the close lost or trapped; never move focus the user put elsewhere
      // (e.g. typing in the composer when a resize hid the drawer).
      const active = document.activeElement
      const focusLost =
        !active ||
        active === document.body ||
        active === document.documentElement ||
        // A click on the backdrop focuses the nearest focusable ancestor, the layout root itself
        // (Quasar gives it tabindex -1): that is focus lost as well, not a place the user chose.
        active.classList.contains('q-layout') ||
        active.closest('.q-drawer') !== null
      if (!focusLost) return
      const target =
        opener?.isConnected && opener !== document.body
          ? opener
          : document.querySelector<HTMLElement>(
              '[role="main"], main, .q-page-container',
            )
      if (!target) return
      if (
        !target.matches('a[href], button, input, select, textarea, [tabindex]')
      ) {
        target.setAttribute('tabindex', '-1')
      }
      target.focus({ preventScroll: true })
    },
    toggleMyDrawerOpen() {
      if (this.compact) {
        this.compact = false
        this.trueSplitterRatio = compactCutoff
      }
      this.myDrawerOpen = !this.myDrawerOpen
    },
  },
  computed: {
    overlayOpen(): boolean {
      return this.myDrawerOpen && isNarrowWidth(this.$q.screen.width)
    },
    splitterRatio: {
      get(): number {
        return this.trueSplitterRatio
      },
      set(inputRatio: number): void {
        this.trueSplitterRatio = inputRatio
        this.$nextTick(() => {
          if (inputRatio < compactMidpoint) {
            this.trueSplitterRatio = compactWidth
            this.compact = true
          } else if (
            inputRatio > compactMidpoint &&
            inputRatio < compactCutoff
          ) {
            this.compact = false
            this.trueSplitterRatio = compactCutoff
          } else {
            this.compact = false
          }
        })
      },
    },
  },
})
</script>

<style lang="scss">
// The main region is only a programmatic focus target (restoreFocusAfterOverlay); it must not
// draw a focus ring around the whole page.
.q-page-container[tabindex='-1']:focus {
  outline: none;
}
</style>
