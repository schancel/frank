<template>
  <div class="rps-game q-pa-sm" style="min-width: 260px; max-width: 380px">
    <!-- Header -->
    <div class="row items-center q-mb-xs">
      <q-icon name="sports_esports" size="20px" class="q-mr-xs text-primary" />
      <span class="text-caption text-weight-bold"
        >Rock-Paper-Scissors Arena</span
      >
    </div>

    <!-- Match Start / Bot Commitment -->
    <template v-if="item.action === 'start'">
      <div class="text-caption q-mb-xs">
        🔐 <strong>Secret Move Committed:</strong>
        <div
          class="text-mono text-grey-7 ellipsis text-caption"
          style="font-size: 11px"
        >
          {{ item.commitHash ? `0x${item.commitHash}` : 'Committed' }}
        </div>
      </div>

      <div
        v-if="item.wagerWei && item.wagerWei !== '0'"
        class="text-caption text-primary q-mb-xs"
      >
        💰 Wager: <strong>{{ displayWager(item.wagerWei) }}</strong>
      </div>

      <div class="text-caption text-weight-medium q-mt-sm q-mb-xs">
        Choose your move:
      </div>
      <div class="row q-gutter-xs">
        <q-btn
          dense
          no-caps
          color="primary"
          outline
          label="🪨 Rock"
          data-testid="rps-rock"
          :disable="submitting"
          @click="chooseMove('rock')"
        />
        <q-btn
          dense
          no-caps
          color="primary"
          outline
          label="📄 Paper"
          data-testid="rps-paper"
          :disable="submitting"
          @click="chooseMove('paper')"
        />
        <q-btn
          dense
          no-caps
          color="primary"
          outline
          label="✂️ Scissors"
          data-testid="rps-scissors"
          :disable="submitting"
          @click="chooseMove('scissors')"
        />
      </div>
    </template>

    <!-- Match Resolved -->
    <template v-else-if="item.action === 'resolve'">
      <div class="q-my-xs">
        <div class="text-caption">
          🧑 You: <strong>{{ moveEmoji(item.playerMove) }}</strong>
        </div>
        <div class="text-caption">
          🤖 Bot: <strong>{{ moveEmoji(item.botMove) }}</strong>
        </div>
      </div>

      <div
        class="text-subtitle2 q-my-xs text-weight-bold"
        :class="{
          'text-positive': item.outcome === 'win',
          'text-negative': item.outcome === 'lose',
          'text-warning': item.outcome === 'tie',
        }"
      >
        {{ outcomeHeadline }}
      </div>

      <div v-if="item.txHash" class="text-caption text-positive q-mb-xs">
        🏆 Payout sent! (tx:
        <span class="text-mono text-caption"
          >{{ item.txHash.slice(0, 10) }}...</span
        >)
      </div>

      <div
        v-if="item.secretSalt"
        class="text-caption text-grey-7"
        style="font-size: 11px"
      >
        ✓ Cryptographically verified with SHA-256
      </div>

      <!-- Play Again with Selectable Wager -->
      <q-separator class="q-my-sm" />
      <div class="text-caption text-weight-medium q-mb-xs">
        Select next wager:
      </div>
      <div class="row items-center q-gutter-xs q-mb-xs">
        <q-btn
          v-for="chip in wagerChips"
          :key="chip.label"
          dense
          size="sm"
          :outline="wagerInput !== chip.value"
          color="primary"
          :label="chip.label"
          :data-testid="`rps-chip-${chip.value || 'free'}`"
          @click="wagerInput = chip.value"
        />
      </div>
      <q-input
        v-model="wagerInput"
        dense
        outlined
        label="Custom Wager (MON)"
        suffix="MON"
        inputmode="decimal"
        data-testid="rps-wager-input"
        style="max-width: 200px"
      />
      <q-btn
        dense
        no-caps
        color="primary"
        class="q-mt-sm"
        label="🎮 Play Again"
        data-testid="rps-play-again"
        :disable="submitting"
        @click="playAgain"
      />
    </template>

    <!-- Challenge Mode -->
    <template v-else-if="item.action === 'challenge'">
      <div class="text-caption">
        ⚔️ <strong>P2P Challenge</strong>
        <div v-if="item.wagerWei && item.wagerWei !== '0'">
          Wager: {{ displayWager(item.wagerWei) }}
        </div>
      </div>
      <q-btn
        v-if="item.matchId"
        dense
        no-caps
        color="positive"
        class="q-mt-xs"
        label="Accept Challenge"
        :disable="submitting"
        @click="acceptChallenge(item.matchId)"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'
import type { RpsItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import { errorNotify } from '../../../utils/notifications'

export default defineComponent({
  name: 'ChatMessageRps',
  props: {
    item: {
      type: Object as PropType<RpsItem>,
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
      submitting: false,
      wagerInput: '',
      wagerChips: [
        { label: 'Free', value: '' },
        { label: '0.01', value: '0.01' },
        { label: '0.05', value: '0.05' },
        { label: '0.1', value: '0.1' },
      ],
    }
  },
  computed: {
    outcomeHeadline(): string {
      if (this.item.outcome === 'win') return '🎉 YOU WIN!'
      if (this.item.outcome === 'lose') return '💀 YOU LOSE!'
      if (this.item.outcome === 'tie') return "🤝 IT'S A TIE!"
      return 'Match Complete'
    },
  },
  methods: {
    displayWager(weiString?: string): string {
      if (!weiString) return '0 MON'
      try {
        return `${activeChain.toDisplayAmount(BigInt(weiString))} ${
          activeChain.unit
        }`
      } catch {
        return '0 MON'
      }
    },
    moveEmoji(move?: string): string {
      if (move === 'rock') return '🪨 Rock'
      if (move === 'paper') return '📄 Paper'
      if (move === 'scissors') return '✂️ Scissors'
      return 'Hidden'
    },
    async chooseMove(move: string) {
      if (this.submitting) return
      this.submitting = true
      try {
        this.$emit('sendFollowUp', {
          items: [{ type: 'text', text: `/${move}` }],
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.submitting = false
      }
    },
    async playAgain() {
      if (this.submitting) return
      this.submitting = true
      try {
        const cmd = this.wagerInput.trim()
          ? `/rps ${this.wagerInput.trim()}`
          : '/rps'
        this.$emit('sendFollowUp', {
          items: [{ type: 'text', text: cmd }],
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.submitting = false
      }
    },
    async acceptChallenge(matchId: string) {
      if (this.submitting) return
      this.submitting = true
      try {
        this.$emit('sendFollowUp', {
          items: [{ type: 'text', text: `/accept ${matchId}` }],
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.submitting = false
      }
    },
  },
})
</script>
