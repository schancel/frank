<template>
  <div v-if="status === 'error'">
    <q-btn
      icon="replay"
      dense
      flat
      padding="xs"
      class="q-btn"
      @click="$emit('resendClick')"
    />
  </div>
  <div
    v-else-if="status === 'confirmed'"
    @mouseover="mouseoverCheckMobile()"
    @mouseleave="mouseOver = false"
  >
    <q-btn
      dense
      flat
      icon="more_vert"
      class="q-btn"
      padding="xs"
      aria-label="Show message actions"
      @click.stop="menuClicked"
      v-show="!showMenu && !mouseOver"
    />
    <template v-for="button in buttonNames" :key="button">
      <q-btn
        :icon="button"
        dense
        flat
        padding="xs"
        class="q-btn"
        :color="button === 'delete' ? 'negative' : undefined"
        :aria-label="`${button} message`"
        @click.stop="buttonClicked(button)"
        v-show="mouseOver || showMenu"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue'
import { useQuasar } from 'quasar'

// The overflow trigger occupies the right edge of the row. Keep Delete at the opposite edge so
// expanding the row can never replace the dots with a destructive target under the pointer.
const ButtonNames = ['delete', 'reply', 'forward', 'info'] as const
const ButtonEvents = ButtonNames.map(
  buttonName => `${buttonName}Click` as const,
)
type ButtonType = (typeof ButtonNames)[number]

export default defineComponent({
  name: 'ChatMessageSuffixButtons',
  emits: [...ButtonEvents, 'resendClick'],
  props: {
    status: {
      type: String,
      required: true,
    },
  },
  setup(props, { emit }) {
    const showMenu = ref(false)
    const mouseOver = ref(false)
    const $q = useQuasar()
    return {
      mouseOver,
      showMenu,
      buttonNames: ButtonNames,
      mouseoverCheckMobile() {
        // only set mouseover if not on mobile
        mouseOver.value = !$q.platform.is.mobile
      },
      menuClicked() {
        showMenu.value = !showMenu.value
      },
      buttonClicked(button: ButtonType) {
        const clickEvent = `${button}Click` as const
        emit(clickEvent)
        // Only flip boolean state if using 3-dot menu button on mobile
        if ($q.platform.is.mobile) {
          showMenu.value = !showMenu.value
        }
      },
    }
  },
})
</script>
