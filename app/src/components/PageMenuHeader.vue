<template>
  <!-- The header every main-pane page needs: below the drawer breakpoint the navigation drawer
  is closed, so without this button a page has no way to reach the rest of the app. Same
  control, name and event as the Chat, Forum and Settings headers. -->
  <q-header>
    <q-toolbar class="q-pl-sm">
      <q-btn
        class="q-px-sm"
        flat
        dense
        icon="menu"
        :aria-label="$t('a11y.openNavigation')"
        :aria-expanded="myDrawerOpen"
        data-testid="page-menu"
        @click="$emit('toggleMyDrawerOpen')"
      />
      <q-toolbar-title class="h6">{{ title }}</q-toolbar-title>
    </q-toolbar>
  </q-header>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'

export default defineComponent({
  name: 'PageMenuHeader',
  props: {
    title: { type: String, required: true },
  },
  emits: ['toggleMyDrawerOpen'],
  setup() {
    return { myDrawerOpen: useMyDrawerOpen() }
  },
})
</script>
