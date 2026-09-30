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
          @input="clearError(i)"
          class="seed-confirm__input"
          type="text"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          :aria-invalid="wrong[i] ? 'true' : 'false'"
          :aria-describedby="wrong[i] ? fieldErrorId(i) : undefined"
        />
        <div v-if="wrong[i]" :id="fieldErrorId(i)" class="text-negative">
          {{ $t('seedConfirm.wordError', { n: position }) }}
        </div>
      </div>

      <!-- Polite live region: present in the DOM before it has content so screen readers
           announce the text when it appears. -->
      <div
        class="text-negative"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <template v-if="wrongPositions.length">{{
          $t('seedConfirm.recheck', { positions: wrongPositions.join(', ') })
        }}</template>
      </div>

      <div class="row q-gutter-sm">
        <q-btn
          type="submit"
          color="primary"
          no-caps
          class="seed-confirm__check"
          :label="$t('seedConfirm.check')"
        />
        <q-btn
          type="button"
          outline
          color="primary"
          no-caps
          class="seed-confirm__toggle"
          :aria-expanded="showPhrase ? 'true' : 'false'"
          :aria-controls="phraseId"
          :label="
            showPhrase
              ? $t('seedConfirm.hidePhrase')
              : $t('seedConfirm.showPhrase')
          "
          @click="togglePhrase"
        />
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
  wrongConfirmationIndexes,
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
    // Per-field error flags, index-aligned with `positions`.
    const wrong = ref<boolean[]>(props.positions.map(() => false))
    const wrongPositions = computed(() =>
      props.positions.filter((_, i) => wrong.value[i]),
    )
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
        wrong.value = props.positions.map(() => false)
        showPhrase.value = false
      },
    )

    // Entering the step: move focus to its heading so keyboard and screen-reader users land
    // on the new content.
    void nextTick(() => heading.value?.focus())

    return {
      answers,
      wrong,
      wrongPositions,
      showPhrase,
      words,
      heading,
      phrase,
      success,
      headingId: `seed-confirm-heading-${uid}`,
      fieldErrorId: (i: number) => `seed-confirm-error-${uid}-${i}`,
      phraseId: `seed-confirm-phrase-${uid}`,
      inputId: (i: number) => `seed-confirm-word-${uid}-${i}`,
      setInputRef(el: unknown, i: number) {
        inputs[i] = el as HTMLInputElement | null
      },
      check() {
        if (
          checkConfirmationAnswers(props.seed, props.positions, answers.value)
        ) {
          wrong.value = props.positions.map(() => false)
          // Do not keep the typed words around once they are no longer needed.
          answers.value = props.positions.map(() => '')
          emit('confirmed')
          void nextTick(() => success.value?.focus?.())
          return
        }
        const bad = wrongConfirmationIndexes(
          props.seed,
          props.positions,
          answers.value,
        )
        wrong.value = props.positions.map((_, i) => bad.includes(i))
        // Focus the first wrong field (fall back to the first field if the challenge itself is
        // unusable, so the user is never left without focus).
        void nextTick(() => inputs[bad[0] ?? 0]?.focus())
      },
      clearError(i: number) {
        if (wrong.value[i])
          wrong.value = wrong.value.map((w, j) => j !== i && w)
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
/* Match the Quasar controls around it instead of the browser's default text box. */
.seed-confirm__input {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(128, 128, 128, 0.6);
  border-radius: 4px;
}
.seed-confirm__input:focus {
  outline: 2px solid var(--q-primary);
  outline-offset: 1px;
}
.seed-confirm__input[aria-invalid='true'] {
  border-color: var(--q-negative);
}
.seed-confirm__phrase {
  columns: 2;
  padding-left: 2em;
}
</style>
