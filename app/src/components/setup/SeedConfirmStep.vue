<template>
  <form
    class="seed-confirm col q-gutter-y-md"
    novalidate
    :aria-labelledby="headingId"
    @submit.prevent="check"
  >
    <h2 :id="headingId" class="text-h6 q-ma-none" tabindex="-1" ref="heading">
      {{ $t('seedConfirm.title') }}
    </h2>
    <p class="q-ma-none">{{ $t('seedConfirm.instructions') }}</p>

    <div
      v-if="confirmed"
      role="status"
      class="text-positive"
      tabindex="-1"
      ref="success"
    >
      {{ $t('seedConfirm.success') }}
    </div>

    <template v-else>
      <div
        v-for="(position, i) in positions"
        :key="`${position}`"
        class="q-mb-sm"
      >
        <label
          :for="inputId(i)"
          class="text-body2 q-mb-xs"
          style="display: block"
        >
          {{ $t('seedConfirm.wordLabel', { n: position }) }}
        </label>
        <input
          :id="inputId(i)"
          :ref="el => setInputRef(el, i)"
          v-model="answers[i]"
          class="seed-confirm__input"
          style="width: 100%; padding: 8px"
          type="text"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          :aria-invalid="failed ? 'true' : 'false'"
          :aria-describedby="failed ? errorId : undefined"
        />
      </div>

      <!-- Polite live region: present in the DOM before it has content so screen readers
           announce the text when it appears. -->
      <div
        :id="errorId"
        class="text-negative"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <template v-if="failed">{{ $t('seedConfirm.error') }}</template>
      </div>

      <div class="row q-gutter-sm">
        <button type="submit" class="seed-confirm__check">
          {{ $t('seedConfirm.check') }}
        </button>
        <button
          type="button"
          class="seed-confirm__toggle"
          :aria-expanded="showPhrase ? 'true' : 'false'"
          :aria-controls="phraseId"
          @click="togglePhrase"
        >
          {{
            showPhrase
              ? $t('seedConfirm.hidePhrase')
              : $t('seedConfirm.showPhrase')
          }}
        </button>
      </div>
    </template>

    <ol
      v-if="showPhrase && !confirmed"
      :id="phraseId"
      ref="phrase"
      class="seed-confirm__phrase"
      tabindex="-1"
      :aria-label="$t('seedConfirm.phraseLabel')"
    >
      <li v-for="(word, i) in words" :key="i">{{ word }}</li>
    </ol>
  </form>
</template>

<script lang="ts">
import { computed, defineComponent, nextTick, PropType, ref, watch } from 'vue'
import {
  checkConfirmationAnswers,
  normalizeSetupMnemonic,
} from '../../utils/setup-account'

let instanceCounter = 0

export default defineComponent({
  props: {
    /** The phrase being confirmed. Never logged, never emitted. */
    seed: { type: String, required: true },
    /** 1-based word positions to ask for. */
    positions: { type: Array as PropType<number[]>, required: true },
    /** True once this exact phrase has been confirmed. */
    confirmed: { type: Boolean, default: false },
  },
  emits: ['confirmed'],
  setup(props, { emit }) {
    const uid = ++instanceCounter
    const answers = ref<string[]>(props.positions.map(() => ''))
    const failed = ref(false)
    const showPhrase = ref(false)
    const inputs: Array<HTMLInputElement | null> = []
    const heading = ref<HTMLElement | null>(null)
    const phrase = ref<HTMLElement | null>(null)
    const success = ref<HTMLElement | null>(null)

    const words = computed(() =>
      normalizeSetupMnemonic(props.seed).split(/\s+/).filter(Boolean),
    )

    // A different phrase or different positions means a different challenge: drop every
    // answer and any error, and hide the phrase.
    watch(
      () => [props.seed, props.positions.join(',')],
      () => {
        answers.value = props.positions.map(() => '')
        failed.value = false
        showPhrase.value = false
      },
    )

    // Entering the step: move focus to its heading so keyboard and screen-reader users land
    // on the new content.
    void nextTick(() => heading.value?.focus())

    return {
      answers,
      failed,
      showPhrase,
      words,
      heading,
      phrase,
      success,
      headingId: `seed-confirm-heading-${uid}`,
      errorId: `seed-confirm-error-${uid}`,
      phraseId: `seed-confirm-phrase-${uid}`,
      inputId: (i: number) => `seed-confirm-word-${uid}-${i}`,
      setInputRef(el: unknown, i: number) {
        inputs[i] = el as HTMLInputElement | null
      },
      check() {
        if (
          checkConfirmationAnswers(props.seed, props.positions, answers.value)
        ) {
          failed.value = false
          // Do not keep the typed words around once they are no longer needed.
          answers.value = props.positions.map(() => '')
          emit('confirmed')
          void nextTick(() => success.value?.focus?.())
          return
        }
        failed.value = true
        void nextTick(() => inputs[0]?.focus())
      },
      togglePhrase() {
        showPhrase.value = !showPhrase.value
        if (showPhrase.value) void nextTick(() => phrase.value?.focus())
      },
    }
  },
})
</script>

<style scoped>
.seed-confirm__phrase {
  columns: 2;
  padding-left: 2em;
}
</style>
