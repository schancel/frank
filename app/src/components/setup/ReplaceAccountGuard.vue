<template>
  <section
    class="replace-guard q-gutter-y-md"
    :aria-labelledby="headingId"
    data-test="replace-guard"
  >
    <h2 :id="headingId" ref="heading" class="text-h6 q-ma-none" tabindex="-1">
      {{ $t('replaceGuard.title') }}
    </h2>
    <p class="q-ma-none">{{ $t('replaceGuard.intro') }}</p>

    <p v-if="confirmed" class="q-ma-none text-positive" data-test="confirmed">
      {{ $t('replaceGuard.confirmed') }}
    </p>

    <div class="row q-gutter-sm">
      <button
        type="button"
        data-test="cancel"
        class="replace-guard__primary"
        @click="$emit('cancel')"
      >
        {{ $t('replaceGuard.cancel') }}
      </button>
      <button
        v-if="!confirmed"
        type="button"
        data-test="confirm-current"
        @click="confirmOpen = true"
      >
        {{ $t('replaceGuard.confirmCurrent') }}
      </button>
      <button
        type="button"
        data-test="replace-toggle"
        :aria-expanded="replaceOpen ? 'true' : 'false'"
        :aria-controls="replaceId"
        @click="toggleReplace"
      >
        {{ $t('replaceGuard.replaceToggle') }}
      </button>
    </div>

    <q-dialog v-model="confirmOpen">
      <seed-confirm-dialog />
    </q-dialog>

    <form
      v-if="replaceOpen"
      :id="replaceId"
      class="q-gutter-y-sm"
      novalidate
      data-test="replace-form"
      @submit.prevent="tryReplace"
    >
      <p class="q-ma-none text-negative" role="note">
        {{ $t('replaceGuard.warning') }}
      </p>
      <label :for="inputId" style="display: block">
        {{ $t('replaceGuard.typeLabel', { word: $t('replaceGuard.word') }) }}
      </label>
      <input
        :id="inputId"
        ref="input"
        v-model="typed"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        style="width: 100%; padding: 8px"
        :aria-invalid="mismatch ? 'true' : 'false'"
        :aria-describedby="statusId"
      />
      <div
        :id="statusId"
        role="status"
        aria-live="polite"
        class="text-negative"
      >
        <template v-if="mismatch">{{ $t('replaceGuard.mismatch') }}</template>
      </div>
      <button type="submit" data-test="replace">
        {{ $t('replaceGuard.replace') }}
      </button>
    </form>
  </section>
</template>

<script lang="ts">
import { defineComponent, nextTick, ref } from 'vue'
import SeedConfirmDialog from '../dialogs/SeedConfirmDialog.vue'

let counter = 0

/**
 * Shown instead of the onboarding steps when an account already exists on this device (#304).
 * Primary paths are Cancel and "confirm my current phrase"; replacing the account is a
 * deliberate, typed acknowledgement. It only emits: it never writes or reads a seed itself.
 */
export default defineComponent({
  components: { SeedConfirmDialog },
  props: {
    /** The stored phrase is already confirmed. */
    confirmed: { type: Boolean, default: false },
  },
  emits: ['cancel', 'acknowledge'],
  setup(_props, { emit }) {
    const uid = ++counter
    const typed = ref('')
    const mismatch = ref(false)
    const replaceOpen = ref(false)
    const confirmOpen = ref(false)
    const heading = ref<HTMLElement | null>(null)
    const input = ref<HTMLInputElement | null>(null)
    void nextTick(() => heading.value?.focus())
    return {
      typed,
      mismatch,
      replaceOpen,
      confirmOpen,
      heading,
      input,
      headingId: `replace-guard-h-${uid}`,
      replaceId: `replace-guard-form-${uid}`,
      inputId: `replace-guard-input-${uid}`,
      statusId: `replace-guard-status-${uid}`,
      toggleReplace() {
        replaceOpen.value = !replaceOpen.value
        typed.value = ''
        mismatch.value = false
        if (replaceOpen.value) void nextTick(() => input.value?.focus())
      },
      emitAcknowledge: () => emit('acknowledge'),
    }
  },
  methods: {
    tryReplace() {
      if (this.typed.trim() !== this.$t('replaceGuard.word')) {
        this.mismatch = true
        void nextTick(() => this.input?.focus())
        return
      }
      this.mismatch = false
      this.emitAcknowledge()
    },
  },
})
</script>
