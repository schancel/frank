<template>
  <div class="not-found-container column full-height overflow-hidden">
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-toolbar-title class="h6">{{ $t('notFound.title') }}</q-toolbar-title>
      </q-toolbar>
    </q-header>
    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="q-pa-md column items-center justify-center text-center"
        :style-fn="pageStyle"
        data-test="not-found-page"
      >
        <q-icon name="explore_off" size="64px" color="grey-6" />
        <h1 class="text-h6 q-mt-md q-mb-sm">{{ $t('notFound.title') }}</h1>
        <p class="text-body2 text-grey-7">{{ $t('notFound.message') }}</p>
        <q-btn
          unelevated
          color="primary"
          no-caps
          :label="$t('notFound.home')"
          data-test="not-found-home"
          @click="goHome"
        />
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useRouter } from 'vue-router'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { viewportPageStyle } from '../utils/layout'

// Any address no route matches: the app's usual chrome, what happened, and a way home. Home
// replaces this entry, so Back does not return to the dead address.
export default defineComponent({
  name: 'NotFoundPage',
  emits: ['toggleMyDrawerOpen'],
  setup() {
    const router = useRouter()
    return {
      pageStyle: viewportPageStyle,
      myDrawerOpen: useMyDrawerOpen(),
      goHome() {
        void router.replace('/').catch(() => undefined)
      },
    }
  },
})
</script>

<style scoped>
.not-found-container {
  height: 100%;
  min-height: 0;
}
</style>
