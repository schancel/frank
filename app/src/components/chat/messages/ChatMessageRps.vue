<template>
  <div class="rps-game">
    <div class="row items-center q-mb-xs">
      <q-icon name="sports_esports" size="20px" class="q-mr-xs text-primary" />
      <span class="text-weight-bold">Rock-Paper-Scissors</span>
    </div>

    <!-- The bot has committed to its move, or this user/peer sent a P2P challenge commitment -->
    <template v-if="item.action === 'start'">
      <div
        v-if="outbound"
        class="q-mb-xs"
        :title="item.commitHash"
        data-testid="rps-own-committed"
      >
        {{ ownStartText }}
      </div>
      <template v-else>
        <!-- The commitment is a long hash: on hover here; the result says whether it matched. -->
        <div
          class="q-mb-xs"
          :title="item.commitHash"
          data-testid="rps-committed"
        >
          {{
            isP2pMatch
              ? $t('gameFairness.rpsPeerCommitted')
              : $t('gameFairness.rpsBotCommitted')
          }}
        </div>
        <template v-if="!played">
          <template v-if="fixedWagerWei !== undefined">
            <div
              class="text-weight-medium q-mb-xs"
              data-testid="rps-fixed-stake"
            >
              {{ fixedStakeLabel }}
            </div>
            <div class="text-grey-8 q-my-xs">
              {{ fixedStakeHint }}
            </div>
          </template>
          <template v-else>
            <div class="text-weight-medium q-mb-xs">Stake:</div>
            <div class="row items-center q-gutter-xs q-mb-xs">
              <q-btn
                v-for="chip in wagerChips"
                :key="chip.label"
                dense
                no-caps
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
            <div class="text-grey-8 q-my-xs">
              Your stake is paid with your move. A win pays twice the stake, a
              tie returns it.
            </div>
          </template>
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
        <div
          v-else-if="moveFailed"
          class="text-negative"
          data-testid="rps-move-not-sent"
        >
          {{ $t('gameFairness.moveNotSent') }}
        </div>
        <div v-else class="text-grey-7" data-testid="rps-moved">
          You have moved.
        </div>
      </template>
    </template>

    <!-- The player's own move, or an inbound move from a peer against our challenge -->
    <template v-else-if="item.action === 'move'">
      <div v-if="isPeerMove" data-testid="rps-peer-move">
        {{ peerMoveText }}
      </div>
      <div v-else data-testid="rps-move">
        You played <strong>{{ moveLabel(item.playerMove) }}</strong>
        <span v-if="item.wagerWei && item.wagerWei !== '0'">
          for {{ displayWager(item.wagerWei) }}</span
        >.
      </div>
      <div v-if="dealerStep" class="row q-gutter-xs q-mt-xs">
        <q-btn
          v-if="dealerStep.payWei > 0n"
          dense
          no-caps
          color="primary"
          data-testid="rps-dealer-pay"
          :disable="submitting"
          :label="
            $t('gameFairness.rpsDealerPay', {
              move: moveLabel(dealerStep.ownMove),
              amount: displayWager(dealerStep.payWei.toString()),
            })
          "
          @click="resolveAsDealer"
        />
        <q-btn
          v-else
          dense
          no-caps
          color="primary"
          data-testid="rps-dealer-reveal"
          :disable="submitting"
          :label="
            $t('gameFairness.rpsDealerReveal', {
              move: moveLabel(dealerStep.ownMove),
            })
          "
          @click="resolveAsDealer"
        />
      </div>
      <div
        v-else-if="waiting"
        :class="waiting.late ? 'text-weight-bold' : 'game-waiting-quiet'"
        data-testid="rps-waiting"
      >
        {{
          $t(
            waiting.late
              ? isP2pMatch
                ? 'gameFairness.noAnswerPeer'
                : 'gameFairness.noAnswer'
              : isP2pMatch
                ? 'gameFairness.awaitingPeer'
                : 'gameFairness.awaiting',
            {
              seconds: waiting.seconds,
            },
          )
        }}
      </div>
    </template>

    <template v-else-if="item.action === 'resolve'">
      <div class="q-my-xs">
        <div>
          {{ $t('gameFairness.rpsYouLabel') }}
          <strong>{{
            moveLabel(outbound ? item.botMove : item.playerMove)
          }}</strong>
        </div>
        <div>
          {{
            isP2pMatch
              ? $t('gameFairness.rpsOpponentLabel')
              : $t('gameFairness.rpsBotLabel')
          }}
          <strong>{{
            moveLabel(outbound ? item.playerMove : item.botMove)
          }}</strong>
        </div>
      </div>
      <div
        class="q-my-xs text-weight-bold"
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
        class="q-mb-xs"
        :class="{ 'text-negative': payout.short }"
        data-testid="rps-payout"
      >
        {{
          $t(
            payout.short
              ? 'gameFairness.payoutMissing'
              : isP2pMatch
                ? 'gameFairness.payoutClaimedPeer'
                : 'gameFairness.payoutClaimed',
            payout,
          )
        }}
      </div>
      <div v-if="check.ok" class="text-positive" data-testid="rps-verified">
        {{
          $t(
            isP2pMatch
              ? 'gameFairness.rpsVerifiedPeer'
              : 'gameFairness.rpsVerified',
          )
        }}
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
import { useChatStore } from '../../../stores/chats'
import { useContactStore } from '../../../stores/contacts'
import { formatDisplayAmount } from '../../../utils/chain-amount'
import {
  BOT_ANSWER_WAIT_MS,
  chatGameItems,
  parseWager,
  type ChatGameItem,
} from '../../../utils/chat-game-items'
import { errorNotify } from '../../../utils/notifications'
import {
  dealerRpsStepForMatch,
  loadRpsSecret,
  type DealerRpsStep,
  type P2pGameChatMessage,
} from '../../../utils/p2p-games'

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
    outbound: {
      type: Boolean,
      default: false,
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
    isP2pMatch(): boolean {
      if (
        this.outbound ||
        this.isPeerMove ||
        Boolean(this.item.opponentAddress)
      ) {
        return true
      }
      if (this.item.action === 'start' && this.item.wagerWei !== undefined) {
        return true
      }
      const all = chatGameItems('rps', this.address)
      if (
        all.some(
          entry =>
            entry.item.matchId === this.item.matchId &&
            ((entry.outbound && entry.item.action === 'start') ||
              (entry.outbound && entry.item.action === 'resolve') ||
              Boolean(entry.item.opponentAddress) ||
              (entry.item.action === 'start' &&
                entry.item.wagerWei !== undefined)),
        )
      ) {
        return true
      }
      try {
        const contact = useContactStore().getContact(this.address)
        if (contact?.profile && contact.profile.isBot === false) {
          return true
        }
      } catch {
        // Pinia store may be uninitialized in standalone component tests
      }
      return false
    },
    fixedWagerWei(): bigint | undefined {
      if (this.item.action !== 'start' || this.item.wagerWei === undefined) {
        return undefined
      }
      try {
        const parsed = BigInt(this.item.wagerWei)
        return parsed >= 0n ? parsed : undefined
      } catch {
        return undefined
      }
    },
    fixedStakeLabel(): string {
      if (this.fixedWagerWei === undefined || this.fixedWagerWei === 0n) {
        return this.$t('gameFairness.rpsFixedStakeFree')
      }
      return this.$t('gameFairness.rpsFixedStake', {
        amount: this.displayWager(this.fixedWagerWei.toString()),
      })
    },
    fixedStakeHint(): string {
      if (this.fixedWagerWei === undefined || this.fixedWagerWei === 0n) {
        return this.$t('gameFairness.rpsFixedStakeFreeHint')
      }
      return this.$t('gameFairness.rpsFixedStakeHint', {
        amount: this.displayWager(this.fixedWagerWei.toString()),
      })
    },
    outcomeHeadline(): string {
      if (this.outbound) {
        if (this.item.outcome === 'win') return 'YOU LOSE'
        if (this.item.outcome === 'lose') return 'YOU WIN'
        return 'A TIE'
      }
      if (this.item.outcome === 'win') return 'YOU WIN'
      if (this.item.outcome === 'lose') return 'YOU LOSE'
      return 'A TIE'
    },
    ownStartText(): string {
      const secret = this.item.matchId
        ? loadRpsSecret(
            'self',
            this.address,
            this.item.matchId,
            this.item.commitHash,
          )
        : undefined
      const staked =
        this.item.wagerWei !== undefined && this.item.wagerWei !== '0'
      if (secret) {
        if (staked) {
          return this.$t('gameFairness.rpsOwnCommittedMoveStaked', {
            move: this.moveLabel(secret.move),
            amount: this.displayWager(this.item.wagerWei),
          })
        }
        return this.$t('gameFairness.rpsOwnCommittedMove', {
          move: this.moveLabel(secret.move),
        })
      }
      if (staked) {
        return this.$t('gameFairness.rpsOwnCommittedStaked', {
          amount: this.displayWager(this.item.wagerWei),
        })
      }
      return this.$t('gameFairness.rpsOwnCommitted')
    },
    isPeerMove(): boolean {
      if (this.item.action !== 'move' || this.outbound) return false
      const all = chatGameItems('rps', this.address)
      return all.some(
        entry =>
          !entry.outbound &&
          entry.item === this.item &&
          all.some(
            prev =>
              prev.outbound &&
              prev.item.action === 'start' &&
              prev.item.matchId === this.item.matchId,
          ),
      )
    },
    peerMoveText(): string {
      const move = this.moveLabel(this.item.playerMove)
      if (this.item.wagerWei && this.item.wagerWei !== '0') {
        return this.$t('gameFairness.rpsPeerMoveStaked', {
          move,
          amount: this.displayWager(this.item.wagerWei),
        })
      }
      return this.$t('gameFairness.rpsPeerMove', { move })
    },
    dealerStep(): DealerRpsStep | undefined {
      if (this.item.action !== 'move' || !this.item.matchId) return undefined
      const messages = (useChatStore().activeConversation?.messages ??
        []) as readonly P2pGameChatMessage[]
      return dealerRpsStepForMatch(
        messages,
        'self',
        this.address,
        this.item.matchId,
      )
    },
    /** The message carrying the player's own move in this item's match, if there is one. */
    mineEntry(): ChatGameItem<RpsItem> | undefined {
      return chatGameItems('rps', this.address).find(
        entry =>
          entry.outbound &&
          entry.item.action === 'move' &&
          entry.item.matchId === this.item.matchId,
      )
    },
    mine(): RpsItem | undefined {
      return this.mineEntry?.item
    },
    played(): boolean {
      return !!this.mine
    },
    /** The move is in the chat but its send failed: the bot has not received it. */
    moveFailed(): boolean {
      return !!this.mineEntry?.failed
    },
    /** The game's outcome only: that the bot's revealed move is the one it committed to before
     * the player moved. A match played by typing has no move item of the player's, so it is
     * checked against the commitment the bot sent first. */
    check(): FairCheck {
      if (this.outbound) {
        const peerMove = chatGameItems('rps', this.address).find(
          entry =>
            !entry.outbound &&
            entry.item.action === 'move' &&
            entry.item.matchId === this.item.matchId,
        )?.item
        if (peerMove) return verifyRpsResult(this.item, peerMove)
        const ownStart = chatGameItems('rps', this.address).find(
          entry =>
            entry.outbound &&
            entry.item.action === 'start' &&
            entry.item.matchId === this.item.matchId,
        )?.item
        return verifyRpsTypedResult(this.item, ownStart)
      }
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
      if (this.item.action !== 'resolve' || !this.item.outcome || this.outbound)
        return null
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
      if (this.item.action !== 'move' || this.isPeerMove) return null
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
      const own = all.find(entry => entry.outbound && entry.item === this.item)
      // A message that failed to send is not being answered: its own line says it failed.
      if (own?.failed) return null
      const sentAt = own?.timeMs || this.mountedAt
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
      const wager =
        this.fixedWagerWei !== undefined
          ? this.fixedWagerWei
          : parseWager(this.wagerInput, a => activeChain.fromDisplayAmount(a))
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
        // The stake is the value of the move message itself: a free game carries no stamp.
        stampValueWei: wager,
        settled: () => {
          this.submitting = false
        },
      })
    },
    resolveAsDealer() {
      if (this.submitting || !this.dealerStep) return
      this.submitting = true
      this.$emit('sendFollowUp', {
        items: [this.dealerStep.item],
        stampValueWei: this.dealerStep.payWei,
        settled: () => {
          this.submitting = false
        },
      })
    },
    playAgain() {
      // Asking for another match is not a message to a person: it carries no stamp.
      this.$emit('sendFollowUp', {
        items: [{ type: 'text', text: '/rps' }],
        stampValueWei: 0n,
      })
    },
  },
})
</script>

<style scoped>
.rps-game {
  max-width: 100%;
  min-width: 0;
  font: inherit;
  letter-spacing: normal;
}
</style>
