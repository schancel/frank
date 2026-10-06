<template>
  <div
    class="satoshi-dice-game q-pa-sm"
    style="min-width: 280px; max-width: 400px"
  >
    <!-- Header -->
    <div class="row items-center q-mb-xs">
      <q-icon name="casino" size="22px" class="q-mr-xs text-amber-9" />
      <span class="text-subtitle2 text-weight-bold">Satoshi Dice</span>
      <q-badge
        color="orange"
        text-color="black"
        class="q-ml-xs"
        label="1.9% House Edge"
      />
    </div>

    <!-- Result View if already rolled -->
    <template v-if="item.action === 'result'">
      <div class="q-my-xs">
        <div class="text-caption">
          🎯 Target: <strong>&lt; {{ item.target }}</strong> ({{
            winProbabilityPercent
          }}% chance)
        </div>
        <div class="text-caption">
          🎲 Lucky Number:
          <strong class="text-mono">{{ item.luckyNumber }}</strong> / 65,535
        </div>
      </div>

      <div
        class="text-subtitle1 q-my-xs text-weight-bold"
        :class="item.isWin ? 'text-positive' : 'text-negative'"
      >
        {{ item.isWin ? '🎉 YOU WIN!' : '💀 YOU LOSE!' }}
      </div>

      <div
        v-if="item.payoutWei && item.payoutWei !== '0'"
        class="text-caption text-positive q-mb-xs"
      >
        🏆 Payout: <strong>{{ displayMon(item.payoutWei) }}</strong>
        <div v-if="item.txHash" class="text-mono text-caption text-grey-7">
          tx: {{ item.txHash.slice(0, 10) }}...
        </div>
      </div>

      <!-- Verification details -->
      <details class="q-my-xs text-caption text-grey-8" style="font-size: 11px">
        <summary>Provable Fairness Proof</summary>
        <div class="q-pt-xs text-mono" style="word-break: break-all">
          <div>Secret: {{ item.serverSecret }}</div>
          <div>Nonce: {{ item.userNonce }}</div>
        </div>
      </details>
      <q-separator class="q-my-sm" />
    </template>

    <!-- Interactive Roll Controls (Custom Wager & Odds Selection) -->
    <div class="text-caption text-weight-medium q-mb-xs">
      1. Select Target & Odds:
    </div>
    <div class="row q-gutter-xs q-mb-sm">
      <q-btn
        v-for="preset in presets"
        :key="preset.target"
        dense
        no-caps
        size="xs"
        :color="target === preset.target ? 'primary' : 'grey-8'"
        :outline="target !== preset.target"
        :label="`${preset.label} (${preset.multiplier}x)`"
        :data-testid="`dice-preset-${preset.target}`"
        @click="target = preset.target"
      />
    </div>

    <div class="text-caption text-weight-medium q-mb-xs">2. Select Wager:</div>
    <div class="row q-gutter-xs items-center q-mb-xs">
      <q-btn
        v-for="chip in wagerChips"
        :key="chip.label"
        dense
        size="xs"
        :outline="wagerInput !== chip.value"
        color="amber-10"
        text-color="white"
        :label="chip.label"
        :data-testid="`dice-chip-${chip.value || 'free'}`"
        @click="wagerInput = chip.value"
      />
    </div>

    <q-input
      v-model="wagerInput"
      dense
      outlined
      label="Custom Wager Amount"
      suffix="MON"
      inputmode="decimal"
      class="q-mb-xs"
      data-testid="dice-wager-input"
      style="max-width: 220px"
    />

    <!-- Dynamic Payout Calculator -->
    <div class="text-caption text-grey-9 q-mb-sm" style="font-size: 12px">
      Multiplier: <strong>{{ currentMultiplier }}x</strong> | Est. Payout:
      <strong class="text-positive">{{ estimatedPayout }} MON</strong>
    </div>

    <q-btn
      dense
      no-caps
      color="amber-9"
      text-color="black"
      class="full-width text-weight-bold"
      label="🎲 Roll Satoshi Dice"
      data-testid="dice-roll-btn"
      :loading="rolling"
      :disable="rolling"
      @click="rollDice"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'
import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import { errorNotify } from '../../../utils/notifications'

export default defineComponent({
  name: 'ChatMessageDice',
  props: {
    item: {
      type: Object as PropType<SatoshiDiceItem>,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
  },
  emits: ['sendFollowUp'],
  data() {
    return {
      rolling: false,
      target: 32768,
      wagerInput: '0.01',
      wagerChips: [
        { label: 'Free', value: '' },
        { label: '0.01', value: '0.01' },
        { label: '0.05', value: '0.05' },
        { label: '0.1', value: '0.1' },
        { label: '0.5', value: '0.5' },
      ],
      presets: [
        { target: 64000, label: 'Safe', multiplier: '1.004' },
        { target: 32768, label: '50/50', multiplier: '1.96' },
        { target: 16384, label: '4-to-1', multiplier: '3.92' },
        { target: 6553, label: '10-to-1', multiplier: '9.81' },
        { target: 655, label: 'Jackpot', multiplier: '98x' },
        { target: 65, label: 'Moonshot', multiplier: '989x' },
      ],
    }
  },
  computed: {
    currentMultiplier(): number {
      if (this.target <= 0 || this.target >= 65536) return 0
      return Number(((65536 * 0.981) / this.target).toFixed(3))
    },
    winProbabilityPercent(): string {
      const t = this.item.target ?? this.target
      return ((t / 65536) * 100).toFixed(2)
    },
    estimatedPayout(): string {
      const wager = parseFloat(this.wagerInput || '0')
      if (isNaN(wager) || wager <= 0) return '0.00'
      return (wager * this.currentMultiplier).toFixed(4)
    },
  },
  methods: {
    displayMon(weiString?: string): string {
      if (!weiString) return '0 MON'
      try {
        return `${activeChain.toDisplayAmount(BigInt(weiString))} ${
          activeChain.unit
        }`
      } catch {
        return '0 MON'
      }
    },
    async rollDice() {
      if (this.rolling) return
      this.rolling = true
      try {
        const wagerPart = this.wagerInput.trim() ? this.wagerInput.trim() : '0'
        const cmd = `/roll ${wagerPart} ${this.target}`
        this.$emit('sendFollowUp', {
          items: [{ type: 'text', text: cmd }],
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.rolling = false
      }
    },
  },
})
</script>
