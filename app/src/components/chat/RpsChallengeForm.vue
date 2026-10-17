<template>
  <q-card-section data-testid="rps-challenge-form" style="min-width: 280px">
    <div class="text-subtitle2">{{ $t('gameFairness.rpsChallengeTitle') }}</div>
    <div class="text-caption q-mt-xs q-mb-sm">
      {{ $t('gameFairness.rpsChallengeHint') }}
    </div>
    <q-option-group
      v-model="move"
      :disable="busy"
      dense
      :options="[
        { label: $t('gameFairness.rpsMoveRock'), value: 'rock' },
        { label: $t('gameFairness.rpsMovePaper'), value: 'paper' },
        { label: $t('gameFairness.rpsMoveScissors'), value: 'scissors' },
      ]"
    />
    <q-btn
      no-caps
      class="q-mt-sm"
      dense
      color="primary"
      data-testid="rps-challenge-send"
      :label="$t('gameFairness.rpsSendChallenge')"
      :disable="busy"
      :loading="busy"
      @click="submit"
    />
    <q-btn
      flat
      no-caps
      dense
      class="q-mt-sm q-ml-sm"
      data-testid="rps-challenge-cancel"
      :label="$t('gameFairness.rpsCancel')"
      @click="$emit('cancel')"
    />
  </q-card-section>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { RpsMove } from '@frank/wallet/message-item-plugins/rps/fair'

export default defineComponent({
  name: 'RpsChallengeForm',
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ['submit', 'cancel'],
  data() {
    return {
      move: 'rock' as RpsMove,
    }
  },
  methods: {
    submit() {
      if (this.busy) return
      this.$emit('submit', { move: this.move })
    },
  },
})
</script>
