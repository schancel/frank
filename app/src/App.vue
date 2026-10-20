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
  <main
    v-else
    class="startup-loading"
    :aria-label="$t('startupFailure.loading')"
    aria-busy="true"
  >
    <div class="startup-loading__spinner" aria-hidden="true" />
  </main>
</template>

<script lang="ts">
import { defineAsyncComponent, defineComponent } from 'vue'
import { startupRestoration } from './boot/startup-state'

let appRuntimePromise: Promise<typeof import('./AppRuntime.vue')> | undefined

export function preloadAppRuntime() {
  appRuntimePromise ??= import('./AppRuntime.vue')
  return appRuntimePromise
}

export default defineComponent({
  components: {
    // Do not even import runtime stores/lifecycle dependencies until restoration succeeds.
    AppRuntime: defineAsyncComponent(() => preloadAppRuntime()),
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
.startup-failure h1 {
  font-size: clamp(1.5rem, 4vw, 2rem);
  line-height: 1.25;
}
.startup-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  width: 100%;
  box-sizing: border-box;
}
.startup-loading__spinner {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2.5px solid rgba(200, 67, 30, 0.2);
  border-top-color: var(--q-primary, #c8431e);
  animation: startup-loading-spin 0.75s linear infinite;
}
@keyframes startup-loading-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .startup-loading__spinner {
    animation: none;
  }
}
</style>
