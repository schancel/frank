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
        :outline="stakeText !== chip.value"
        color="primary"
        :label="chip.value || $t('gameFairness.rpsStakeFree')"
        :data-testid="`rps-challenge-chip-${chip.value || 'free'}`"
        :disable="busy"
        @click="stakeText = chip.value"
      />
    </div>
    <q-input
      v-model="stakeText"
      dense
      outlined
      :label="$t('gameFairness.rpsStakeLabel')"
      :suffix="unit"
      :disable="busy"
      inputmode="decimal"
      data-testid="rps-challenge-wager-input"
      style="max-width: 200px"
    />
    <div
      v-if="minimumStake > 0n"
      class="text-caption q-mt-xs"
      data-testid="rps-challenge-stake-minimum"
    >
      {{ $t('gameFairness.stakeMinimum', { amount: minimumStakeText }) }}
    </div>
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
import {
  stakeAllowed,
  stakeMinimumWei,
} from '@frank/wallet/message-item-plugins/shared/stake-minimum'
import { formatDisplayAmount } from '../../utils/chain-amount'
import { parseWager } from '../../utils/chat-game-items'
import { PAYMENT_FLOOR_INJECTION, stakeChipsWei } from '../../utils/game-stakes'
import { errorNotify } from '../../utils/notifications'

export default defineComponent({
  name: 'RpsChallengeForm',
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ['submit', 'cancel'],
  inject: {
    /** The wallet's payment floor for this chain (`PAYMENT_FLOOR_INJECTION`), zero if unknown. */
    paymentFloorWei: {
      from: PAYMENT_FLOOR_INJECTION,
      default: () => (): bigint => 0n,
    },
  },
  data() {
    return {
      move: 'rock' as RpsMove,
      /** What the player typed or picked; `null` until then, when the stake is the minimum. */
      wagerInput: null as string | null,
    }
  },
  computed: {
    unit(): string {
      return activeChain.unit
    },
    /** The smallest stake a match takes: twice the payment floor (`stakeMinimumWei`). Zero
     * while the floor is not known. */
    minimumStake(): bigint {
      return stakeMinimumWei(
        (this.paymentFloorWei as unknown as () => bigint)(),
      )
    },
    minimumStakeText(): string {
      return formatDisplayAmount(activeChain, this.minimumStake)
    },
    /** Free, then the paid stakes the floor allows; never a stake below the minimum. */
    wagerChips(): { value: string }[] {
      return [
        { value: '' },
        ...stakeChipsWei(
          (this.paymentFloorWei as unknown as () => bigint)(),
        ).map(wei => ({ value: activeChain.toDisplayAmount(wei) })),
      ]
    },
    /** The stake field: what the player chose, or the minimum until they choose. */
    stakeText: {
      get(): string {
        if (this.wagerInput !== null) return this.wagerInput
        return this.minimumStake > 0n
          ? activeChain.toDisplayAmount(this.minimumStake)
          : ''
      },
      set(value: string) {
        this.wagerInput = value
      },
    },
  },
  methods: {
    submit() {
      if (this.busy) return
      const wagerWei = parseWager(this.stakeText, a =>
        activeChain.fromDisplayAmount(a),
      )
      if (wagerWei === undefined) {
        errorNotify(new Error(this.$t('gameFairness.rpsInvalidStake')))
        return
      }
      if (!stakeAllowed(wagerWei, this.minimumStake)) {
        errorNotify(
          new Error(
            this.$t('gameFairness.stakeBelowMinimum', {
              amount: this.minimumStakeText,
            }),
          ),
        )
        return
      }
      this.$emit('submit', { move: this.move, wagerWei })
    },
  },
})
</script>
