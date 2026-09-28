<template>
  <div>
    <router-view />
    <status-footer v-if="legacyRelayEnabled" />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import StatusFooter from '../components/StatusFooter.vue'
import { legacyLotusModeEnabled } from '../utils/runtime-mode'

export default defineComponent({
  components: { StatusFooter },
  setup() {
    return { legacyRelayEnabled: legacyLotusModeEnabled() }
  },
})
</script>
