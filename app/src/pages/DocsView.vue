<template>
  <div class="docs-view-container column full-height overflow-hidden">
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
        <q-toolbar-title class="h6">{{ $t('docs.header') }}</q-toolbar-title>
        <q-btn
          flat
          dense
          icon="open_in_new"
          :label="$t('docs.openInTab')"
          href="/docs/"
          target="_blank"
          class="gt-xs q-mr-sm"
        />
      </q-toolbar>
    </q-header>

    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="no-padding full-width docs-container col full-height overflow-hidden relative-position"
        :style-fn="pageStyle"
      >
        <iframe
          src="/docs/"
          class="docs-iframe"
          :title="$t('docs.iframeTitle')"
        />
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { viewportPageStyle } from 'src/utils/layout'

export default defineComponent({
  name: 'DocsView',
  emits: ['toggleMyDrawerOpen'],
  setup(_, { emit }) {
    return {
      myDrawerOpen: useMyDrawerOpen(),
      pageStyle: viewportPageStyle,
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
    }
  },
})
</script>

<style scoped>
.docs-container {
  height: 100%;
  overflow: hidden;
}

.docs-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
