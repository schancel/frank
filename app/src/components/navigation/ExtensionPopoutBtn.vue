<template>
  <q-btn
    v-if="isExtensionPopup"
    class="q-px-xs"
    flat
    round
    dense
    icon="open_in_new"
    :aria-label="popoutLabel"
    :title="popoutLabel"
    data-testid="ext-popout-window-btn"
    @click="popOutExtensionWindow"
  >
    <q-tooltip>{{ popoutLabel }}</q-tooltip>
  </q-btn>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import {
  isBrowserExtensionRuntime,
  openExtensionInWindow,
} from '../../../src-bex/runtime-adapter'

export default defineComponent({
  name: 'ExtensionPopoutBtn',
  computed: {
    popoutLabel(): string {
      return 'Pop Out Window'
    },
    isExtensionPopup(): boolean {
      const routeQueryMode = (
        this.$router?.currentRoute?.value?.query as
          | Record<string, unknown>
          | undefined
      )?.extMode
      if (
        routeQueryMode === 'popup' ||
        routeQueryMode === 'sidepanel' ||
        routeQueryMode === 'sidebar'
      ) {
        return true
      }
      if (routeQueryMode === 'window' || routeQueryMode === 'tab') {
        return false
      }
      const docMode =
        typeof document !== 'undefined'
          ? document.documentElement?.getAttribute('data-ext-mode')
          : null
      if (
        docMode === 'popup' ||
        docMode === 'sidepanel' ||
        docMode === 'sidebar'
      ) {
        return true
      }
      if (docMode === 'window' || docMode === 'tab') {
        return false
      }
      if (typeof window !== 'undefined') {
        const search = window.location?.search ?? ''
        if (
          search.includes('extMode=popup') ||
          search.includes('extMode=sidepanel') ||
          search.includes('extMode=sidebar')
        ) {
          return true
        }
        if (
          search.includes('extMode=window') ||
          search.includes('extMode=tab')
        ) {
          return false
        }
      }
      return isBrowserExtensionRuntime()
    },
  },
  methods: {
    async popOutExtensionWindow() {
      const res = await openExtensionInWindow()
      if (
        res.opened &&
        typeof window !== 'undefined' &&
        typeof window.close === 'function'
      ) {
        try {
          window.close()
        } catch {
          // Ignore window.close errors in restricted contexts
        }
      }
    },
  },
})
</script>
