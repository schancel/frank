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
    <div class="text-weight-medium q-mt-sm q-mb-xs">
      {{ $t('gameFairness.rpsStakeLabel') }}
    </div>
    <div class="row items-center q-gutter-xs q-mb-xs">
      <q-btn
        v-for="chip in wagerChips"
        :key="chip.value || 'free'"
        dense
        no-caps
        size="sm"
        :outline="wagerInput !== chip.value"
        color="primary"
        :label="chip.value || $t('gameFairness.rpsStakeFree')"
        :data-testid="`rps-challenge-chip-${chip.value || 'free'}`"
        :disable="busy"
        @click="wagerInput = chip.value"
      />
    </div>
    <q-input
      v-model="wagerInput"
      dense
      outlined
      :label="$t('gameFairness.rpsStakeLabel')"
      :suffix="unit"
      :disable="busy"
      inputmode="decimal"
      data-testid="rps-challenge-wager-input"
      style="max-width: 200px"
    />
    <div class="q-mt-sm">
      <q-btn
        no-caps
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
        class="q-ml-sm"
        data-testid="rps-challenge-cancel"
        :label="$t('gameFairness.rpsCancel')"
        @click="$emit('cancel')"
      />
    </div>
  </q-card-section>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import type { RpsMove } from '@frank/wallet/message-item-plugins/rps/fair'
import { parseWager } from '../../utils/chat-game-items'
import { errorNotify } from '../../utils/notifications'

export default defineComponent({
  name: 'RpsChallengeForm',
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ['submit', 'cancel'],
  data() {
    return {
      move: 'rock' as RpsMove,
      wagerInput: '0.01',
      wagerChips: [
        { value: '' },
        { value: '0.01' },
        { value: '0.05' },
        { value: '0.1' },
      ],
    }
  },
  computed: {
    unit(): string {
      return activeChain.unit
    },
  },
  methods: {
    submit() {
      if (this.busy) return
      const wagerWei = parseWager(this.wagerInput, a =>
        activeChain.fromDisplayAmount(a),
      )
      if (wagerWei === undefined) {
        errorNotify(new Error(this.$t('gameFairness.rpsInvalidStake')))
        return
      }
      this.$emit('submit', { move: this.move, wagerWei })
    },
  },
})
</script>
