<template>
  <div>
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="toggleSettingsDrawerOpen"
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
        />
        <q-toolbar-title class="h6">Documentation & Protocol</q-toolbar-title>
        <q-btn
          flat
          dense
          icon="open_in_new"
          label="Open in Tab"
          href="/docs/"
          target="_blank"
          class="gt-xs q-mr-sm"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="no-padding full-width docs-container">
        <iframe src="/docs/" class="docs-iframe" title="Frank Documentation" />
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'

export default defineComponent({
  name: 'DocsView',
  emits: ['toggleMyDrawerOpen'],
  setup(_, { emit }) {
    return {
      myDrawerOpen: useMyDrawerOpen(),
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
    }
  },
})
</script>

<style scoped>
.docs-container {
  height: calc(100vh - 50px);
  overflow: hidden;
}

.docs-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
