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
const drawerBreakpoint = 800

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
      trueSplitterRatio: compactCutoff,
      // See `drawerBreakpoint`'s own comment above for why this can't just be `true`.
      myDrawerOpen: this.$q.screen.width >= drawerBreakpoint,
      contactDrawerOpen: false as boolean,
      compact: false,
      compactWidth,
      drawerBreakpoint,
    }
  },
  methods: {
    toggleContactDrawerOpen() {
      this.contactDrawerOpen = !this.contactDrawerOpen
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
