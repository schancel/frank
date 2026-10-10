<template>
  <div class="rps-game q-pa-sm" style="min-width: 260px; max-width: 380px">
    <div class="row items-center q-mb-xs">
      <q-icon name="sports_esports" size="20px" class="q-mr-xs text-primary" />
      <span class="text-caption text-weight-bold">Rock-Paper-Scissors</span>
    </div>

    <!-- The bot has committed to its move -->
    <template v-if="item.action === 'start'">
      <div class="text-caption q-mb-xs">
        The bot has committed to its move:
        <div
          class="text-mono text-grey-7 ellipsis text-caption"
          style="font-size: 11px"
        >
          {{ item.commitHash }}
        </div>
      </div>
      <template v-if="!played">
        <div class="text-caption text-weight-medium q-mb-xs">Stake:</div>
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
          label="Stake"
          :suffix="unit"
          inputmode="decimal"
          data-testid="rps-wager-input"
          style="max-width: 200px"
        />
        <div class="text-caption text-grey-8 q-my-xs" style="font-size: 12px">
          Your stake is paid with your move. A win pays twice the stake, a tie
          returns it.
        </div>
        <div class="row q-gutter-xs">
          <q-btn
            v-for="move in moves"
            :key="move"
            dense
            no-caps
            color="primary"
            outline
            :label="moveLabel(move)"
            :data-testid="`rps-${move}`"
            :disable="submitting"
            @click="chooseMove(move)"
          />
        </div>
      </template>
      <div v-else class="text-caption text-grey-7">You have moved.</div>
    </template>

    <!-- The player's own move -->
    <template v-else-if="item.action === 'move'">
      <div class="text-caption" data-testid="rps-move">
        You played <strong>{{ moveLabel(item.playerMove) }}</strong>
        <span v-if="item.wagerWei && item.wagerWei !== '0'">
          for {{ displayWager(item.wagerWei) }}</span
        >.
      </div>
    </template>

    <template v-else-if="item.action === 'resolve'">
      <div class="q-my-xs">
        <div class="text-caption">
          You: <strong>{{ moveLabel(item.playerMove) }}</strong>
        </div>
        <div class="text-caption">
          Bot: <strong>{{ moveLabel(item.botMove) }}</strong>
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
      <div
        v-if="check.ok"
        class="text-caption text-positive"
        data-testid="rps-verified"
      >
        Verified: the move and salt the bot revealed match the commitment it
        sent before you moved.
      </div>
      <q-banner
        v-else
        dense
        class="bg-negative text-white q-my-xs"
        data-testid="rps-not-verified"
      >
        <strong>NOT VERIFIED.</strong> {{ check.reason }}
      </q-banner>
      <q-separator class="q-my-sm" />
      <q-btn
        dense
        no-caps
        color="primary"
        label="Play again"
        data-testid="rps-play-again"
        @click="playAgain"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'
import type { RpsItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import type { FairCheck } from '@frank/wallet/message-item-plugins/dice/fair'
import {
  RPS_MOVES,
  rpsPayoutWei,
  verifyRpsResult,
  type RpsMove,
} from '@frank/wallet/message-item-plugins/rps/fair'
import { formatDisplayAmount } from '../../../utils/chain-amount'
import { chatGameItems, parseWager } from '../../../utils/chat-game-items'
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
      moves: RPS_MOVES,
      wagerChips: [
        { label: 'Free', value: '' },
        { label: '0.01', value: '0.01' },
        { label: '0.05', value: '0.05' },
        { label: '0.1', value: '0.1' },
      ],
    }
  },
  computed: {
    unit(): string {
      return activeChain.unit
    },
    outcomeHeadline(): string {
      if (this.item.outcome === 'win') return 'YOU WIN'
      if (this.item.outcome === 'lose') return 'YOU LOSE'
      return 'A TIE'
    },
    /** The player's own move in this item's match, if one was sent. */
    mine(): RpsItem | undefined {
      return chatGameItems('rps').find(
        entry =>
          entry.outbound &&
          entry.item.action === 'move' &&
          entry.item.matchId === this.item.matchId,
      )?.item
    },
    played(): boolean {
      return !!this.mine
    },
    check(): FairCheck {
      const checked = verifyRpsResult(this.item, this.mine)
      if (!checked.ok || !this.item.outcome) return checked
      // A payout is a payout only if this message carried it.
      const owed = rpsPayoutWei(
        BigInt(this.item.wagerWei ?? '0'),
        this.item.outcome,
      )
      const carried =
        chatGameItems('rps').find(
          entry =>
            !entry.outbound &&
            entry.item.action === 'resolve' &&
            entry.item.matchId === this.item.matchId,
        )?.stampValueWei ?? 0n
      return owed > 0n && carried < owed
        ? { ok: false, reason: 'What you won was not paid with this message.' }
        : checked
    },
  },
  methods: {
    displayWager(weiString?: string): string {
      try {
        return formatDisplayAmount(activeChain, BigInt(weiString ?? '0'))
      } catch {
        return formatDisplayAmount(activeChain, 0n)
      }
    },
    moveLabel(move?: string): string {
      if (move === 'rock') return 'Rock'
      if (move === 'paper') return 'Paper'
      if (move === 'scissors') return 'Scissors'
      return 'Hidden'
    },
    chooseMove(move: RpsMove) {
      if (this.submitting || !this.item.matchId || !this.item.commitHash)
        return
      const wager = parseWager(this.wagerInput, a =>
        activeChain.fromDisplayAmount(a),
      )
      if (wager === undefined) {
        errorNotify(new Error('Enter the stake as a number.'))
        return
      }
      this.submitting = true
      const mine: RpsItem = {
        type: 'rps',
        action: 'move',
        matchId: this.item.matchId,
        // The commitment being answered: what the reveal is checked against.
        commitHash: this.item.commitHash,
        playerMove: move,
        wagerWei: wager.toString(),
      }
      this.$emit('sendFollowUp', {
        items: [mine],
        // The stake is the value of the move message itself.
        ...(wager > 0n ? { stampValueWei: wager } : {}),
        settled: () => {
          this.submitting = false
        },
      })
    },
    playAgain() {
      this.$emit('sendFollowUp', { items: [{ type: 'text', text: '/rps' }] })
    },
  },
})
</script>
