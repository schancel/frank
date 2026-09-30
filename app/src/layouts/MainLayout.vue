<template>
  <q-layout view="lHr lpr lFr">
    <q-drawer
      v-model="myDrawerOpen"
      :width="splitterRatio"
      :breakpoint="drawerBreakpoint"
      show-if-above
    >
      <!-- `closeDrawer` bubbles up from ChatList.vue (several layers below, via LeftDrawer.vue's
      own `v-bind="$attrs"` on `<chat-list>` -- LeftDrawer.vue declares no `emits` of its own, so
      this listener lands in its `$attrs` and forwards straight through). See ChatList.vue's own
      comment on `setActiveChat` for why. -->
      <left-drawer @closeDrawer="myDrawerOpen = false" />
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
        if (failure || railTab) return
        if (isNarrowWidth(this.$q.screen.width)) {
          this.myDrawerOpen = false
          this.restoreFocusAfterOverlay()
        }
      },
    )
    // A guard that throws (e.g. redirectIfNoProfile) skips afterEach entirely and routes to
    // onError instead, so the marker would otherwise survive and keep the overlay open for the
    // *next* navigation.
    this.removeOnError = this.$router.onError(() => {
      this.railNavigation = false
    })
  },
  beforeUnmount() {
    this.removeAfterEach?.()
    this.removeOnError?.()
  },
  methods: {
    toggleContactDrawerOpen() {
      this.contactDrawerOpen = !this.contactDrawerOpen
    },
    // Closing the overlay unmounts/hides the control that had focus, which drops focus to <body>
    // (keyboard and screen-reader users lose their place). Hand it back to the control that
    // opened the drawer if it survived the navigation, else to the main content region.
    async restoreFocusAfterOverlay() {
      await this.$nextTick()
      const opener = this.drawerOpener
      this.drawerOpener = null
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
      if (!this.myDrawerOpen && document.activeElement instanceof HTMLElement) {
        this.drawerOpener = document.activeElement
      }
      this.myDrawerOpen = !this.myDrawerOpen
    },
  },
  computed: {
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
