<template>
  <router-link
    :to="`/forum/${digest}`"
    class="forum-parent-link text-caption text-grey-7 ellipsis"
    data-test="forum-parent-link"
  >
    ↳ {{ $t('forum.replyTo', { parent: label || shortDigest }) }}
  </router-link>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

// Navigable "reply to" indicator for a post with a parent. Links by digest, so it works
// before the parent has been fetched; the label falls back to a short digest then.
export default defineComponent({
  props: {
    digest: { type: String, required: true },
    label: { type: String, default: '' },
  },
  computed: {
    shortDigest(): string {
      return this.digest.replace(/^0x/, '').slice(0, 8)
    },
  },
})
</script>

<style lang="scss" scoped>
.forum-parent-link {
  display: block;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}
</style>
