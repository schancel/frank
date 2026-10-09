<template>
  <div
    v-if="
      status === 'error' || status === 'payment-pending' || status === 'pending'
    "
    class="row items-center no-wrap q-gutter-xs"
  >
    <q-btn
      v-if="status === 'error'"
      icon="replay"
      :label="$t('outgoing.retry')"
      dense
      outline
      no-caps
      size="sm"
      class="q-btn text-white q-px-xs"
      style="background: rgba(255, 255, 255, 0.15); border-color: rgba(255, 255, 255, 0.4);"
      :aria-label="$t('a11y.resendMessage')"
      data-testid="outgoing-retry"
      @click="$emit('resendClick')"
    >
      <q-tooltip>{{ $t('outgoing.retry') }}</q-tooltip>
    </q-btn>
    <q-btn
      icon="delete"
      :label="$t('outgoing.discard')"
      dense
      outline
      no-caps
      size="sm"
      class="q-btn text-white q-px-xs"
      style="background: rgba(255, 255, 255, 0.15); border-color: rgba(255, 255, 255, 0.4);"
      :aria-label="$t('outgoing.discard')"
      data-testid="outgoing-discard"
      @click="$emit('discardClick')"
    >
      <q-tooltip>{{ $t('outgoing.discard') }}</q-tooltip>
    </q-btn>
  </div>
  <!-- Select mode (see this file's script header): a message has exactly one action while
  selecting -- delete -- shown plainly rather than behind a hover/tap reveal, since select mode
  itself is already the explicit "I'm here to delete things" gesture. -->
  <div v-else-if="status === 'confirmed' && selectMode">
    <q-btn
      icon="delete"
      dense
      flat
      padding="xs"
      class="q-btn"
      color="negative"
      :aria-label="$t('a11y.deleteMessage')"
      @click.stop="buttonClicked('delete')"
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
      :aria-label="$t('a11y.messageActions')"
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
        :aria-label="$t(buttonLabelKeys[button])"
        @click.stop="buttonClicked(button)"
        v-show="mouseOver || showMenu"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, inject, ref, type Ref } from 'vue'
import { useQuasar } from 'quasar'

// Direct user feedback (2026-09-28): delete used to sit in this same always-there hover row
// alongside reply/forward/info, one destructive click away during ordinary browsing. It's now
// exclusive to "select mode" (`chatSelectMode`, provided by ChatLayout.vue and toggled from its
// overflow menu -- see that file) -- everyday hover only ever offers reply/forward/info, and
// delete only ever appears once the user has explicitly opted into a delete-focused view.
const ButtonNames = ['reply', 'forward', 'info'] as const
const ButtonLabelKeys = {
  reply: 'a11y.replyToMessage',
  forward: 'a11y.forwardMessage',
  info: 'a11y.messageInfo',
} as const
const AllButtonEvents = ['delete', 'reply', 'forward', 'info'].map(
  buttonName => `${buttonName}Click` as const,
)
type ButtonType = (typeof ButtonNames)[number] | 'delete'

export default defineComponent({
  name: 'ChatMessageSuffixButtons',
  emits: [...AllButtonEvents, 'resendClick', 'discardClick'],
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
    // Falls back to "never in select mode" for any usage outside ChatLayout.vue's provide (e.g. a
    // future test harness) rather than throwing on a missing injection.
    const selectMode = inject<Ref<boolean>>('chatSelectMode', ref(false))
    return {
      mouseOver,
      showMenu,
      selectMode,
      buttonNames: ButtonNames,
      buttonLabelKeys: ButtonLabelKeys,
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
