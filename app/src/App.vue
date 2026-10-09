<template>
  <AppRuntime v-if="startup.phase === 'restored'" />
  <main
    v-else-if="startup.phase === 'failed'"
    class="startup-failure"
    aria-labelledby="startup-failure-title"
  >
    <h1 id="startup-failure-title">{{ $t('startupFailure.title') }}</h1>
    <p role="alert">{{ $t('startupFailure.message') }}</p>
  </main>
  <main v-else :aria-label="$t('startupFailure.loading')" aria-busy="true" />
</template>

<script lang="ts">
import { defineAsyncComponent, defineComponent } from 'vue'
import { startupRestoration } from './boot/startup-state'

export default defineComponent({
  components: {
    // Do not even import runtime stores/lifecycle dependencies until restoration succeeds.
    AppRuntime: defineAsyncComponent(() => import('./AppRuntime.vue')),
  },
  setup() {
    return { startup: startupRestoration }
  },
})
</script>

<style scoped>
.startup-failure {
  max-width: 42rem;
  margin: 10vh auto;
  padding: 2rem;
}
</style>
