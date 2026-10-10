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
      <div
        v-if="waiting"
        class="text-caption"
        :class="waiting.late ? 'text-negative' : 'text-grey-7'"
        data-testid="rps-waiting"
      >
        {{
          $t(waiting.late ? 'gameFairness.noAnswer' : 'gameFairness.awaiting', {
            seconds: waiting.seconds,
          })
        }}
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
        v-if="payout"
        class="text-caption q-mb-xs"
        :class="payout.short ? 'text-negative' : 'text-grey-8'"
        data-testid="rps-payout"
      >
        {{
          $t(
            payout.short
              ? 'gameFairness.payoutMissing'
              : 'gameFairness.payoutClaimed',
            payout,
          )
        }}
      </div>
      <div
        v-if="check.ok"
        class="text-caption text-positive"
        data-testid="rps-verified"
      >
        {{ $t('gameFairness.rpsVerified') }}
      </div>
      <q-banner
        v-else
        dense
        class="bg-negative text-white q-my-xs"
        data-testid="rps-not-verified"
      >
        <strong>{{ $t('gameFairness.notVerified') }}</strong>
        {{ check.reason }}
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
  verifyRpsTypedResult,
  type RpsMove,
} from '@frank/wallet/message-item-plugins/rps/fair'
import { formatDisplayAmount } from '../../../utils/chain-amount'
import {
  BOT_ANSWER_WAIT_MS,
  chatGameItems,
  parseWager,
} from '../../../utils/chat-game-items'
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
  mounted() {
    // Only a card that is waiting for the bot keeps time.
    if (this.item.action === 'move')
      this.timer = setInterval(() => (this.now = Date.now()), 1000)
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer)
  },
  data() {
    return {
      submitting: false,
      now: Date.now(),
      mountedAt: Date.now(),
      timer: undefined as ReturnType<typeof setInterval> | undefined,
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
      return chatGameItems('rps', this.address).find(
        entry =>
          entry.outbound &&
          entry.item.action === 'move' &&
          entry.item.matchId === this.item.matchId,
      )?.item
    },
    played(): boolean {
      return !!this.mine
    },
    /** The game's outcome only: that the bot's revealed move is the one it committed to before
     * the player moved. A match played by typing has no move item of the player's, so it is
     * checked against the commitment the bot sent first. */
    check(): FairCheck {
      if (this.mine) return verifyRpsResult(this.item, this.mine)
      const start = chatGameItems('rps', this.address).find(
        entry =>
          !entry.outbound &&
          entry.item.action === 'start' &&
          entry.item.matchId === this.item.matchId,
      )?.item
      return verifyRpsTypedResult(this.item, start)
    },
    /** What the result pays, and what the wallet reports its message carried: never shown as
     * verified, since the wallet's figure is not a chain check. */
    payout(): { amount: string; carried: string; short: boolean } | null {
      if (this.item.action !== 'resolve' || !this.item.outcome) return null
      const owed = rpsPayoutWei(
        BigInt(this.item.wagerWei ?? '0'),
        this.item.outcome,
      )
      if (owed <= 0n) return null
      const carried =
        chatGameItems('rps', this.address).find(
          entry =>
            !entry.outbound &&
            entry.item.action === 'resolve' &&
            entry.item.matchId === this.item.matchId,
        )?.stampValueWei ?? 0n
      return {
        amount: formatDisplayAmount(activeChain, owed),
        carried: formatDisplayAmount(activeChain, carried),
        short: carried < owed,
      }
    },
    /** The player's own move, while the bot has not answered it: how long it has waited. */
    waiting(): { seconds: number; late: boolean } | null {
      if (this.item.action !== 'move') return null
      const all = chatGameItems('rps', this.address)
      if (
        all.some(
          entry =>
            !entry.outbound &&
            entry.item.action === 'resolve' &&
            entry.item.matchId === this.item.matchId,
        )
      )
        return null
      const sentAt =
        all.find(entry => entry.outbound && entry.item === this.item)?.timeMs ||
        this.mountedAt
      const waited = Math.max(0, this.now - sentAt)
      return {
        seconds: Math.floor(waited / 1000),
        late: waited >= BOT_ANSWER_WAIT_MS,
      }
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
      if (this.submitting || !this.item.matchId || !this.item.commitHash) return
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
