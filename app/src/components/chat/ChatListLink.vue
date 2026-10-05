<template>
  <!-- TODO: We need a better way to handle multiple pages and types of chats. -->
  <q-item
    :active="isActive"
    active-class="active-chat-list-item"
    clickable
    class="chat-list-link-item"
    @click="setRoute()"
  >
    <q-item-section avatar class="chat-list-link-avatar-section">
      <q-avatar rounded size="32px">
        <img
          src="~assets/brand-plainspoken/raster/plainspoken-transparent-512.png"
          v-if="!icon"
        />
        <q-icon :name="icon" size="24px" v-if="icon" />
      </q-avatar>
    </q-item-section>
    <q-item-section>
      <q-item-label>{{ title }}</q-item-label>
    </q-item-section>
  </q-item>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { useRouter } from 'vue-router'

export default defineComponent({
  setup(props) {
    const router = useRouter()
    return {
      isActive: computed(() => {
        return router.currentRoute.value.path === props.route
      }),
      setRoute() {
        router.push(props.route).catch(() => {
          // Don't care. Probably duplicate route
        })
      },
    }
  },
  props: {
    title: {
      type: String,
      required: true,
    },
    route: {
      type: String,
      required: true,
    },
    icon: {
      type: String,
      required: false,
      default: () => null,
    },
  },
})
</script>
<style lang="scss" scoped>
.active-chat-list-item {
  background: var(--q-color-bg-active);
}

.chat-list-link-item {
  min-height: 50px;
  height: 50px;
  max-height: 50px;
  box-sizing: border-box;
  padding: 0 16px;
}

.chat-list-link-avatar-section {
  min-width: 36px;
  padding-right: 12px;
}
</style>
