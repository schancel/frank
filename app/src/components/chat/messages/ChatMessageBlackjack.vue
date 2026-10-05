<template>
  <div class="blackjack-hand q-pa-sm" style="min-width: 220px">
    <!-- What this message was. -->
    <div class="text-caption text-weight-bold" data-testid="blackjack-line">
      {{ itemLine }}
    </div>

    <!-- On the latest message of the hand, render the current running hand state -->
    <template v-if="state && isLatest">
      <div v-if="view.playerCards.length" class="text-caption">
        {{
          $t('blackjackP2p.playerHand', {
            cards: cardLabels(view.playerCards),
            total: playerTotal,
          })
        }}
      </div>
      <div
        v-if="view.dealerUpCard !== undefined && state.phase !== 'resolved'"
        class="text-caption"
      >
        {{
          $t('blackjackP2p.dealerShows', {
            card: cardLabel(view.dealerUpCard),
          })
        }}
      </div>
      <div
        v-if="state.wagerWei > 0n"
        class="text-caption"
        data-testid="blackjack-wager"
      >
        {{ $t('blackjackP2p.wager', { amount: display(stake) }) }}
      </div>
      <template v-if="state.phase === 'resolved'">
        <div class="text-caption">
          {{
            $t('blackjackP2p.dealerHand', {
              cards: cardLabels(state.dealerCards),
              total: dealerTotal,
            })
          }}
        </div>
        <div
          class="text-caption text-weight-bold"
          data-testid="blackjack-outcome"
        >
          {{ outcomeText }}
        </div>
        <div class="text-caption" data-testid="blackjack-payout">
          {{ payoutText }}
        </div>
        <div class="text-caption text-positive">
          {{ $t('blackjackP2p.verified') }}
        </div>
        <q-btn
          dense
          color="primary"
          class="q-mt-sm"
          data-testid="blackjack-play-again"
          :label="$t('blackjackP2p.playAgain')"
          @click="$emit('playAgain')"
        />
      </template>
      <div
        v-if="state.phase === 'refunded'"
        class="text-caption"
        data-testid="blackjack-refunded"
      >
        {{
          $t('blackjackP2p.refunded', {
            amount: display(state.refundedWei || 0n),
          })
        }}
      </div>
      <q-btn
        v-if="state.phase === 'refunded'"
        dense
        color="primary"
        class="q-mt-sm"
        data-testid="blackjack-play-again"
        :label="$t('blackjackP2p.playAgain')"
        @click="$emit('playAgain')"
      />
      <div
        role="status"
        aria-live="polite"
        class="text-caption q-mt-xs"
        :class="{ 'text-weight-bold': !!undelivered }"
        data-testid="blackjack-status"
      >
        {{ statusText }}
      </div>
      <!-- This user's own message of the hand that the other side does not have. -->
      <q-btn
        v-if="undelivered === 'failed'"
        dense
        color="primary"
        class="q-mt-xs"
        data-testid="blackjack-retry"
        :label="$t('blackjackP2p.retry')"
        @click="$emit('retry')"
      />
      <div
        v-if="problem"
        role="status"
        class="text-caption text-negative"
        data-testid="blackjack-problem"
      >
        {{ problem }}
      </div>

      <!-- The challenged user deals: accept with a max bet it can cover. -->
      <div v-if="canAccept" class="q-mt-sm">
        <q-input
          v-model="amount"
          dense
          data-testid="blackjack-accept-max"
          :label="$t('blackjackP2p.maxBet')"
          :suffix="unit"
          inputmode="decimal"
        />
        <q-btn
          dense
          color="primary"
          class="q-mt-xs"
          data-testid="blackjack-accept"
          :label="$t('blackjackP2p.accept')"
          :disable="busy || !!amountError"
          @click="onAccept"
        />
      </div>
      <!-- The player bets: the bet is this message's own stamp. -->
      <div v-if="canBet" class="q-mt-sm">
        <q-input
          v-model="amount"
          dense
          data-testid="blackjack-bet-amount"
          :label="
            $t('blackjackP2p.betAmount', { max: display(state.maxBetWei) })
          "
          :suffix="unit"
          inputmode="decimal"
        />
        <q-btn
          dense
          color="primary"
          class="q-mt-xs"
          data-testid="blackjack-bet"
          :label="$t('blackjackP2p.bet')"
          :disable="busy || !!amountError"
          @click="onBet"
        />
      </div>
      <div
        v-if="(canAccept || canBet) && amountError"
        class="text-caption text-negative"
        data-testid="blackjack-amount-error"
      >
        {{ amountError }}
      </div>
      <div v-if="moves.length" class="q-gutter-sm q-mt-sm">
        <q-btn
          v-for="move in moves"
          :key="move"
          dense
          color="primary"
          :data-testid="`blackjack-${move}`"
          :label="moveLabel(move)"
          :disable="busy || (move === 'double' && !canAffordDouble)"
          @click="onMove(move)"
        />
      </div>
      <!-- Dealer messages that pay need the dealer's confirmation. -->
      <q-btn
        v-if="payStep"
        dense
        color="primary"
        class="q-mt-sm"
        data-testid="blackjack-pay"
        :label="payLabel"
        :disable="busy"
        @click="onPay"
      />
      <q-btn
        v-if="refundBet"
        dense
        flat
        color="primary"
        class="q-mt-sm"
        data-testid="blackjack-refund-bet"
        :label="
          $t('blackjackP2p.refundBet', { amount: display(state.wagerWei) })
        "
        :disable="busy"
        @click="onRefundBet"
      />
    </template>

    <!-- For earlier messages in the hand, keep what was dealt permanently in the chat log -->
    <template v-else-if="item.action === 'deal'">
      <div v-if="dealPlayerCards.length" class="text-caption">
        {{
          $t('blackjackP2p.playerHand', {
            cards: cardLabels(dealPlayerCards),
            total: dealPlayerTotal,
          })
        }}
      </div>
      <div v-if="dealUpCard !== undefined" class="text-caption">
        {{
          $t('blackjackP2p.dealerShows', {
            card: cardLabel(dealUpCard),
          })
        }}
      </div>
    </template>
    <template v-else-if="item.action === 'card'">
      <div v-if="itemCard !== undefined" class="text-caption">
        {{ $t('blackjackP2p.cardDealtN', { card: cardLabel(itemCard) }) }}
      </div>
      <div v-if="cardPlayerCards.length" class="text-caption">
        {{
          $t('blackjackP2p.playerHand', {
            cards: cardLabels(cardPlayerCards),
            total: cardPlayerTotal,
          })
        }}
      </div>
    </template>
    <template v-else-if="item.action === 'reveal' && state">
      <div v-if="state.playerCards.length" class="text-caption">
        {{
          $t('blackjackP2p.playerHand', {
            cards: cardLabels(state.playerCards),
            total: playerTotal,
          })
        }}
      </div>
      <div v-if="state.dealerCards.length" class="text-caption">
        {{
          $t('blackjackP2p.dealerHand', {
            cards: cardLabels(state.dealerCards),
            total: dealerTotal,
          })
        }}
      </div>
      <div
        class="text-caption text-weight-bold"
        data-testid="blackjack-outcome"
      >
        {{ outcomeText }}
      </div>
      <div class="text-caption" data-testid="blackjack-payout">
        {{ payoutText }}
      </div>
      <div class="text-caption text-positive">
        {{ $t('blackjackP2p.verified') }}
      </div>
      <q-btn
        dense
        color="primary"
        class="q-mt-sm"
        data-testid="blackjack-play-again"
        :label="$t('blackjackP2p.playAgain')"
        @click="$emit('playAgain')"
      />
    </template>
    <template v-else-if="item.action === 'refund' && state">
      <div class="text-caption" data-testid="blackjack-refunded">
        {{
          $t('blackjackP2p.refunded', {
            amount: display(state.refundedWei || 0n),
          })
        }}
      </div>
      <q-btn
        dense
        color="primary"
        class="q-mt-sm"
        data-testid="blackjack-play-again"
        :label="$t('blackjackP2p.playAgain')"
        @click="$emit('playAgain')"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import type { BlackjackHandItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import {
  cardLabel,
  handValue,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  buildAccept,
  buildBet,
  checkWager,
  dealerStep,
  foldHand,
  handView,
  maxDealerBetWei,
  playerMoves,
  playerStep,
  refundBetStep,
  refundShortfallWei,
  roleOf,
  totalStakeWei,
  type DealerStep,
  type HandMoneyError,
  type HandRejection,
  type HandRole,
  type HandState,
} from '@frank/wallet/message-item-plugins/blackjack/hand'

import { useChatStore } from '../../../stores/chats'
import { useBalance } from '../../../composables/useBalance'
import { getOwnCanonicalAddress } from '../../../utils/own-address'
import {
  chatHandEvents,
  HAND_FEE_RESERVE_WEI,
  loadSeed,
  newSeed,
  saveSeed,
} from '../../../utils/blackjack-hand'

type Move = 'hit' | 'stand' | 'double'

/**
 * One message of a peer-to-peer blackjack hand. Every bubble says what its message was; the
 * LATEST bubble of a hand also shows the hand and the buttons that are valid for this user's role
 * in the hand's current state. The state is folded from the chat's stored messages by the shared
 * state machine, so it does not depend on which bubbles are on screen.
 *
 * Money is only ever the stamp of the message a button sends: the bet, the equal second bet of a
 * double, the dealer's payout and a refund.
 *
 * No message states a card. Each side keeps a seed of its own and the hand's messages open one
 * link of it per card; the cards shown are computed from the links opened so far. Right after
 * the deal the player sees its first cards before the dealer does: its first move opens them.
 */
export default defineComponent({
  name: 'ChatMessageBlackjack',
  props: {
    item: {
      type: Object as PropType<BlackjackHandItem>,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    /** The digest of the message this item came in. */
    payloadDigest: {
      type: String,
      default: '',
    },
  },
  emits: ['sendFollowUp', 'retry', 'playAgain'],
  setup() {
    const { balance } = useBalance()
    return { balance }
  },
  data() {
    return { own: '', sending: false, amount: '' }
  },
  computed: {
    unit(): string {
      return activeChain.unit
    },
    folded(): {
      state: HandState | undefined
      rejected: { digest: string; error: HandRejection }[]
      lastDigest: string | undefined
    } {
      if (!this.own)
        return { state: undefined, rejected: [], lastDigest: undefined }
      const messages = useChatStore().chats[this.address]?.messages ?? []
      const events = chatHandEvents(
        messages,
        this.own,
        this.address,
        this.item.gameId,
      )
      return {
        ...foldHand(events),
        lastDigest: events[events.length - 1]?.digest,
      }
    },
    state(): HandState | undefined {
      return this.folded.state
    },
    // Only the last message of the hand offers actions, so an old bubble never sends a stale move.
    isLatest(): boolean {
      return (
        this.payloadDigest !== '' &&
        this.folded.lastDigest === this.payloadDigest
      )
    },
    role(): HandRole | undefined {
      return this.state ? roleOf(this.state, this.own) : undefined
    },
    // Buttons are visibly disabled while any message of this chat is still being sent.
    busy(): boolean {
      const messages = useChatStore().chats[this.address]?.messages ?? []
      return this.sending || messages.some(m => m.status === 'pending')
    },
    seed(): string | undefined {
      return this.state
        ? loadSeed(this.own, this.address, this.state.gameId)
        : undefined
    },
    stake(): bigint {
      return this.state ? totalStakeWei(this.state) : 0n
    },
    // The cards this user can see: those both sides opened, plus, for the player right after
    // the deal, the first cards its own seed already gives.
    view(): { playerCards: number[]; dealerUpCard?: number } {
      return handView(this.state, this.seed)
    },
    playerTotal(): number {
      return handValue(this.view.playerCards).total
    },
    dealerTotal(): number {
      return handValue(this.state?.dealerCards ?? []).total
    },
    dealPlayerCards(): number[] {
      const item = this.item
      if (item.action === 'deal' && 'playerCards' in item) {
        return [...(item.playerCards as number[])]
      }
      if (item.action === 'deal') {
        return this.view.playerCards
      }
      return []
    },
    dealPlayerTotal(): number {
      return handValue(this.dealPlayerCards).total
    },
    dealUpCard(): number | undefined {
      const item = this.item
      if (item.action === 'deal' && 'dealerUpCard' in item) {
        return item.dealerUpCard as number
      }
      if (item.action === 'deal') {
        return this.view.dealerUpCard
      }
      return undefined
    },
    itemCard(): number | undefined {
      const item = this.item
      if (item.action === 'card') {
        if ('card' in item && typeof (item as any).card === 'number') {
          return (item as any).card as number
        }
        if (
          'playerCards' in item &&
          Array.isArray(item.playerCards) &&
          item.playerCards.length > 0
        ) {
          return item.playerCards[item.playerCards.length - 1] as number
        }
        if (this.view.playerCards.length >= 3) {
          return this.view.playerCards[this.view.playerCards.length - 1]
        }
      }
      return undefined
    },
    cardPlayerCards(): number[] {
      const item = this.item
      if (
        item.action === 'card' &&
        'playerCards' in item &&
        Array.isArray(item.playerCards)
      ) {
        return [...(item.playerCards as number[])]
      }
      if (item.action === 'card') {
        return this.view.playerCards
      }
      return []
    },
    cardPlayerTotal(): number {
      return handValue(this.cardPlayerCards).total
    },
    canAccept(): boolean {
      return this.state?.phase === 'challenged' && this.role === 'dealer'
    },
    canBet(): boolean {
      return this.state?.phase === 'open' && this.role === 'player'
    },
    moves(): Move[] {
      if (this.role !== 'player') return []
      const moves = playerMoves(this.state, this.seed).filter(
        (move): move is Move => move !== 'bet',
      )
      // A natural can only stand, and that is sent without asking.
      return moves.length === 1 && this.view.playerCards.length === 2
        ? []
        : moves
    },
    canAffordDouble(): boolean {
      return (
        !!this.state &&
        this.balance !== null &&
        checkWager(
          this.state,
          this.state.wagerWei,
          this.balance,
          HAND_FEE_RESERVE_WEI,
        ) === undefined
      )
    },
    dealerNext(): DealerStep | undefined {
      if (this.role !== 'dealer' || !this.state) return undefined
      // A refund needs no seed; everything else does.
      return dealerStep(this.state, this.seed ?? '')
    },
    payStep(): DealerStep | undefined {
      return this.dealerNext?.payWei !== undefined ? this.dealerNext : undefined
    },
    refundBet(): DealerStep | undefined {
      return this.role === 'dealer' ? refundBetStep(this.state) : undefined
    },
    payLabel(): string {
      const step = this.payStep
      if (!step) return ''
      const amount = this.display(step.payWei ?? 0n)
      return step.item.action === 'refund'
        ? this.$t('blackjackP2p.refund', { amount })
        : this.$t('blackjackP2p.payAndReveal', { amount })
    },
    amountWei(): bigint | null {
      try {
        return activeChain.fromDisplayAmount(this.amount)
      } catch {
        return null
      }
    },
    amountError(): string {
      const state = this.state
      if (!state) return ''
      if (this.balance === null) return this.$t('blackjackP2p.balanceUnknown')
      if (this.amount.trim() === '' || this.amountWei === null)
        return this.$t('blackjackP2p.enterAmount')
      if (this.amountWei < activeChain.defaultStampValue)
        return this.$t('blackjackP2p.belowStamp', {
          amount: this.display(activeChain.defaultStampValue),
        })
      let error: HandMoneyError | undefined
      if (this.canAccept) {
        const built = buildAccept({
          state,
          spendableWei: this.balance,
          reserveWei: HAND_FEE_RESERVE_WEI,
          seed: '0'.repeat(64),
          wantedMaxBetWei: this.amountWei,
        })
        error = 'error' in built ? built.error : undefined
      } else {
        error = checkWager(
          state,
          this.amountWei,
          this.balance,
          HAND_FEE_RESERVE_WEI,
        )
      }
      if (error === 'above-max-bet')
        return this.$t('blackjackP2p.aboveMaxBet', {
          amount: this.display(state.maxBetWei),
        })
      if (error === 'above-own-limit')
        return this.$t('blackjackP2p.aboveOwnLimit', {
          amount: this.display(
            this.canAccept
              ? maxDealerBetWei(this.balance, HAND_FEE_RESERVE_WEI)
              : this.balance > HAND_FEE_RESERVE_WEI
              ? this.balance - HAND_FEE_RESERVE_WEI
              : 0n,
          ),
        })
      return error ? this.$t('blackjackP2p.enterAmount') : ''
    },
    itemLine(): string {
      const item = this.item
      switch (item.action) {
        case 'challenge':
          return this.$t(
            item.role === 'dealer'
              ? 'blackjackP2p.lineChallengeDealer'
              : 'blackjackP2p.lineChallengePlayer',
            { amount: this.displayText(item.maxBetWei) },
          )
        case 'accept':
          return this.$t('blackjackP2p.lineAccept', {
            amount: this.displayText(item.maxBetWei),
          })
        default:
          return this.$t(`blackjackP2p.line.${item.action}`)
      }
    },
    // Whether this bubble's own message has reached the other side. A hand counts a message
    // from the moment it is in the chat, so until it is delivered the hand has not moved on for
    // the other user, whatever the folded state says.
    undelivered(): 'sending' | 'failed' | undefined {
      const messages = useChatStore().chats[this.address]?.messages ?? []
      const message = messages.find(m => m.payloadDigest === this.payloadDigest)
      if (!message || !message.outbound || message.status === 'confirmed')
        return undefined
      return message.status === 'error' ? 'failed' : 'sending'
    },
    undeliveredReason(): string {
      const messages = useChatStore().chats[this.address]?.messages ?? []
      const reason = messages.find(m => m.payloadDigest === this.payloadDigest)
        ?.delivery?.failureReason
      const keys: Record<string, string> = {
        'unreachable': 'outgoing.reasonUnreachable',
        'unavailable': 'outgoing.reasonUnavailable',
        'rejected': 'outgoing.reasonRejected',
        'interrupted': 'outgoing.reasonInterrupted',
        'unverified': 'outgoing.reasonUnverified',
        'recovered': 'outgoing.reasonRecovered',
        'insufficient-funds': 'outgoing.reasonInsufficientFunds',
      }
      return this.$t(keys[reason ?? ''] ?? 'outgoing.reasonError')
    },
    statusText(): string {
      const state = this.state
      if (!state || !this.role) return ''
      if (this.undelivered === 'sending')
        return this.$t('blackjackP2p.notDeliveredYet')
      if (this.undelivered === 'failed')
        return this.$t('blackjackP2p.notDelivered', {
          reason: this.undeliveredReason,
        })
      const mine = this.role === 'dealer'
      switch (state.phase) {
        case 'challenged':
          return mine ? '' : this.$t('blackjackP2p.waitAccept')
        case 'open':
          return mine ? this.$t('blackjackP2p.waitBet') : ''
        case 'awaiting_deal':
        case 'awaiting_card':
          return mine
            ? this.$t('blackjackP2p.dealing')
            : this.$t('blackjackP2p.waitDealer')
        case 'player_turn':
          return mine ? this.$t('blackjackP2p.waitPlayer') : ''
        case 'dealer_turn':
          return mine
            ? this.payStep
              ? ''
              : this.$t('blackjackP2p.dealing')
            : this.$t('blackjackP2p.waitReveal')
        default:
          return ''
      }
    },
    problem(): string {
      const state = this.state
      if (!state) return ''
      if (
        this.role === 'player' &&
        state.phase === 'dealer_turn' &&
        this.folded.rejected.some(
          r => r.error === 'bad-reveal' || r.error === 'bad-link',
        )
      )
        return this.$t('blackjackP2p.badReveal')
      if (
        this.role === 'dealer' &&
        !this.seed &&
        ['awaiting_deal', 'awaiting_card', 'dealer_turn'].includes(state.phase)
      )
        return this.$t('blackjackP2p.noSeed')
      if (this.role === 'player' && !this.seed && state.phase === 'player_turn')
        return this.$t('blackjackP2p.noSeedPlayer')
      // Counted by what refunds actually paid: a short refund leaves the rest owed.
      const owed = refundShortfallWei(state)
      if (this.role === 'player' && owed > 0n)
        return this.$t('blackjackP2p.refundOwed', {
          amount: this.display(owed),
        })
      return ''
    },
    outcomeText(): string {
      const outcome = this.state?.outcome
      if (!outcome || !this.role) return ''
      return this.$t(`blackjackP2p.outcome.${this.role}.${outcome}`)
    },
    payoutText(): string {
      const state = this.state
      if (!state || state.owedWei === undefined) return ''
      if (state.owedWei === 0n) return this.$t('blackjackP2p.noPayout')
      const paid = state.paidWei ?? 0n
      return paid >= state.owedWei
        ? this.$t('blackjackP2p.paid', { amount: this.display(state.owedWei) })
        : this.$t('blackjackP2p.shortPaid', {
            owed: this.display(state.owedWei),
            paid: this.display(paid),
          })
    },
  },
  watch: {
    // Suggest the largest amount this user may name, once, when the form appears.
    canAccept: { immediate: true, handler: 'suggestAmount' },
    canBet: { immediate: true, handler: 'suggestAmount' },
    balance: 'suggestAmount',
  },
  async created() {
    this.own = (await getOwnCanonicalAddress()) ?? ''
  },
  methods: {
    cardLabel,
    cardLabels(cards: number[]): string {
      return cards.map(cardLabel).join(' ')
    },
    display(wei: bigint): string {
      return `${activeChain.toDisplayAmount(wei)} ${activeChain.unit}`
    },
    displayText(wei: string): string {
      return /^[0-9]{1,40}$/.test(wei) ? this.display(BigInt(wei)) : '?'
    },
    suggestAmount() {
      const state = this.state
      if (!state || this.amount !== '' || this.balance === null) return
      if (!this.canAccept && !this.canBet) return
      const own = this.canAccept
        ? maxDealerBetWei(this.balance, HAND_FEE_RESERVE_WEI)
        : this.balance > HAND_FEE_RESERVE_WEI
        ? this.balance - HAND_FEE_RESERVE_WEI
        : 0n
      const suggested = own < state.maxBetWei ? own : state.maxBetWei
      if (suggested > 0n) this.amount = activeChain.toDisplayAmount(suggested)
    },
    moveLabel(move: Move): string {
      return move === 'double' && this.state
        ? this.$t('blackjackP2p.double', {
            amount: this.display(this.state.wagerWei),
          })
        : this.$t(`blackjackP2p.${move}`)
    },
    send(item: BlackjackHandItem, stampValueWei?: bigint) {
      if (this.busy) return
      this.sending = true
      this.$emit('sendFollowUp', {
        items: [item],
        stampValueWei,
        settled: () => {
          this.sending = false
        },
      })
    },
    onAccept() {
      const state = this.state
      if (!state || this.amountError || this.balance === null) return
      const seed = newSeed(state.gameId, this.own)
      const built = buildAccept({
        state,
        spendableWei: this.balance,
        reserveWei: HAND_FEE_RESERVE_WEI,
        seed,
        wantedMaxBetWei: this.amountWei ?? undefined,
      })
      if ('error' in built) return
      // The seed is kept before its commitment leaves this device.
      saveSeed(this.own, this.address, state.gameId, seed)
      this.send(built.item)
    },
    onBet() {
      if (!this.state || this.amountError || this.amountWei === null) return
      const seed = newSeed(this.state.gameId, this.own)
      const bet = buildBet(this.state, seed)
      if (!bet) return
      // The player's seed is kept before its commitment leaves this device with the bet.
      saveSeed(this.own, this.address, this.state.gameId, seed)
      this.send(bet, this.amountWei)
    },
    onMove(move: Move) {
      if (!this.state || !this.seed) return
      // The move opens the link of the card it asks for (or, to stand or double, the rest).
      const item = playerStep(this.state, move, this.seed)
      if (!item) return
      this.send(item, move === 'double' ? this.state.wagerWei : undefined)
    },
    onPay() {
      const step = this.payStep
      if (step) this.send(step.item, step.payWei)
    },
    onRefundBet() {
      const step = this.refundBet
      if (step) this.send(step.item, step.payWei)
    },
  },
})
</script>
