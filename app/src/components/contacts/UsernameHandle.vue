<template>
  <!-- A username the relay confirms this account holds. Drawn as a bordered pill with an icon,
       which plain text such as a display name beginning with "@" cannot imitate. -->
  <span
    class="username-handle"
    data-test="username-handle"
    :title="$t('profile.usernameConfirmedTitle')"
  >
    <q-icon name="verified" size="12px" class="username-handle__icon" />@{{
      username
    }}
  </span>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'UsernameHandle',
  props: {
    /** The name without its leading @, exactly as the relay returned it. */
    username: {
      type: String,
      required: true,
    },
  },
})
</script>

<style scoped>
.username-handle {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: 1px solid currentColor;
  border-radius: 10px;
  color: var(--q-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  vertical-align: middle;
}
.username-handle__icon {
  margin-right: 3px;
}
</style>
