<template>
  <div class="blackjack-move q-pa-sm" style="min-width: 220px">
    <div v-if="loading" class="text-caption">Loading hand...</div>
    <template v-else-if="state">
      <div class="text-caption text-weight-bold">
        Your hand: {{ cardLabels(state.playerCards) }}
        <span v-if="state.playerCards.length"
          >({{ playerValue.total }}{{ playerValue.soft ? ' soft' : '' }})</span
        >
      </div>
      <div v-if="state.dealerUpCard !== undefined" class="text-caption">
        Dealer shows: {{ cardLabel(state.dealerUpCard) }}
      </div>
      <template v-if="state.phase === 'resolved'">
        <div class="text-caption">
          Dealer's hand: {{ cardLabels(state.dealerCards) }} ({{
            dealerValue.total
          }})
        </div>
        <div class="text-caption text-weight-bold q-mt-xs">
          {{ outcomeText }}
        </div>
        <div
          v-if="verification"
          class="text-caption"
          :class="verification.valid ? 'text-positive' : 'text-negative'"
        >
          {{
            verification.valid
              ? '✓ Verified fair'
              : `⚠ Verification failed: ${verification.reason}`
          }}
        </div>
      </template>
      <div
        v-if="actionState && actionState.availableActions.includes('bet')"
        class="row items-center q-gutter-xs q-mt-sm"
      >
        <q-input
          v-model="betAmountDisplay"
          dense
          outlined
          label="Bet amount"
          suffix="MON"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          :input-attrs="{ 'aria-label': 'Bet amount in MON' }"
          ref="betInput"
          :hint="betLimitsHint"
          :error="!!betError"
          :error-message="betError"
          style="width: 160px"
          :disable="sending"
          @keyup.enter="onAction('bet')"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        class="text-caption q-mt-xs"
        :class="visibleError ? 'text-negative' : ''"
      >
        {{ visibleError }}
      </div>
      <div
        v-if="actionState && actionState.availableActions.length"
        class="q-gutter-sm q-mt-sm"
      >
        <q-btn
          v-for="action in actionState.availableActions"
          :key="action"
          :label="actionLabel(action)"
          :loading="sending"
          :disable="sending || (action === 'bet' && !!betError)"
          dense
          color="primary"
          @click="onAction(action)"
        />
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { BlackjackMoveItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import {
  cardLabel,
  handValue,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  applyDoubleRejection,
  BLACKJACK_DEFAULT_MAX_WAGER_WEI,
  BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  BlackjackAction,
  BlackjackGameState,
  parseBlackjackError,
  verifyRevealedHand,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  getMessageItemPlugin,
  MessageItemContext,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import '@frank/wallet/message-item-plugins/blackjack/plugin'

import { useChatStore } from '../../../stores/chats'
import { useMonadWallet } from '../../../utils/clients'
import { useActiveWallet } from '../../../composables/useActiveWallet'
import { errorNotify } from '../../../utils/notifications'
import { parseBetInput } from '../../../utils/blackjack-bet'

// The bet-size input's starting value -- comfortably above the relay's stamp minimum so a bot
// dealer never rejects a first-try default as "below the table minimum."
const DEFAULT_BET_AMOUNT_DISPLAY = '0.1'

const ACTION_LABELS: Partial<Record<BlackjackAction, string>> = {
  hit: 'Hit',
  stand: 'Stand',
  deal: 'Deal',
  reveal: 'Reveal',
}

export default defineComponent({
  name: 'ChatMessageBlackjack',
  props: {
    item: {
      type: Object as PropType<BlackjackMoveItem>,
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
      loading: true,
      sending: false,
      // The hand as of THIS item (what an older message shows, read-only).
      state: null as BlackjackGameState | null,
      // The authoritative hand after folding every message of the game; only the latest item of
      // the game offers actions, so an old bubble can never send a stale move.
      liveState: null as BlackjackGameState | null,
      isLatest: false,
      // The dealer's rejection for THIS game while a double was pending (from the fold).
      dealerError: '',
      loadSeq: 0,
      betAmountDisplay: DEFAULT_BET_AMOUNT_DISPLAY,
      // Inline (aria-live) message: send failures such as insufficient funds, and the dealer's
      // own rejection text. Kept alongside, not instead of, the toast.
      actionError: '',
    }
  },
  computed: {
    actionState(): BlackjackGameState | null {
      return this.isLatest ? this.liveState : null
    },
    visibleError(): string {
      return this.isLatest ? this.actionError || this.dealerError : ''
    },
    betLimitsHint(): string {
      return `${activeChain.toDisplayAmount(
        BLACKJACK_DEFAULT_MIN_WAGER_WEI,
      )} to ${activeChain.toDisplayAmount(BLACKJACK_DEFAULT_MAX_WAGER_WEI)} MON`
    },
    // Changes whenever a message arrives in this chat, so the fold is redone with the latest.
    chatMessageCount(): number {
      return useChatStore().chats[this.address]?.messages?.length ?? 0
    },
    betError(): string {
      const parsed = parseBetInput(
        display => activeChain.fromDisplayAmount(display),
        this.betAmountDisplay,
      )
      return parsed.ok ? '' : parsed.error
    },
    playerValue() {
      return handValue(this.state?.playerCards ?? [])
    },
    dealerValue() {
      return handValue(this.state?.dealerCards ?? [])
    },
    outcomeText(): string {
      switch (this.state?.outcome) {
        case 'player_blackjack':
          return 'Blackjack! You win 3:2.'
        case 'player_win':
          return 'You win!'
        case 'dealer_win':
          return 'Dealer wins.'
        case 'push':
          return 'Push -- wager returned.'
        default:
          return ''
      }
    },
    verification() {
      if (!this.state || this.state.phase !== 'resolved') return null
      return verifyRevealedHand(this.state)
    },
  },
  watch: {
    'item.gameId': {
      immediate: true,
      handler() {
        void this.loadState()
      },
    },
    'chatMessageCount'() {
      void this.loadState()
    },
  },
  methods: {
    cardLabel,
    cardLabels(cards: number[]): string {
      return cards.length ? cards.map(cardLabel).join(' ') : '—'
    },
    actionLabel(action: BlackjackAction): string {
      if (action === 'bet') return `Deal me in (${this.betAmountDisplay} MON)`
      if (action === 'double') {
        const wagerWei = this.liveState?.verifiedWagerWei
        return wagerWei !== undefined
          ? `Double down (${activeChain.toDisplayAmount(wagerWei)} MON)`
          : 'Double down'
      }
      return ACTION_LABELS[action] ?? action
    },
    async loadState() {
      const seq = ++this.loadSeq
      // Only the first load shows the placeholder; later recomputes keep the hand on screen.
      if (!this.state) this.loading = true
      try {
        const chats = useChatStore()
        const wallet = useMonadWallet() as unknown as {
          provider: MessageItemContext['provider']
        }
        const chat = chats.chats[this.address]
        const messages = chat?.messages ?? []
        const plugin = getMessageItemPlugin('blackjack-move')
        if (!plugin?.reduceState) {
          throw new Error('blackjack-move plugin not registered')
        }

        // Fold EVERY message of this game (not just up to this item): the actions and errors on
        // screen must reflect the latest messages, and this item only decides what it displays.
        let folded: BlackjackGameState | undefined
        let atItem: BlackjackGameState | undefined
        let lastRaw: unknown
        let dealerError = ''
        for (const message of messages) {
          for (let index = 0; index < message.items.length; index++) {
            const raw = message.items[index]
            // The dealer answers a rejected request with a plain text message carrying a game
            // token. Only an error naming THIS game, arriving while our optimistic double is
            // still pending, unlocks (hit/stand only). Silence (an old bot with no double
            // branch) cannot be detected here, so the UI stays locked then.
            if (raw.type === 'text' && !message.outbound) {
              const parsed = parseBlackjackError(raw.text)
              if (
                parsed &&
                parsed.gameId === this.item.gameId &&
                folded?.doublePending
              ) {
                dealerError = parsed.text
                folded = applyDoubleRejection(folded)
              }
              continue
            }
            if (
              raw.type !== 'blackjack-move' ||
              raw.gameId !== this.item.gameId
            ) {
              continue
            }
            const context: MessageItemContext = {
              message,
              index,
              provider: wallet.provider,
            }
            const hydrated = await plugin.hydrate(raw, context)
            folded = plugin.reduceState(folded, hydrated, context)
            lastRaw = raw
            // The dealer's card for an accepted double supersedes an earlier assumed rejection.
            if (raw.action === 'double' && raw.playerCards) dealerError = ''
            if (raw === this.item) atItem = folded
          }
        }
        if (seq !== this.loadSeq) return // a newer load superseded this one
        this.state = atItem ?? folded ?? null
        this.liveState = folded ?? null
        this.isLatest = lastRaw === this.item
        this.dealerError = dealerError
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (seq === this.loadSeq) this.loading = false
      }
    },
    focusBetInput() {
      const input = this.$refs.betInput as { focus?: () => void } | undefined
      void this.$nextTick(() => input?.focus?.())
    },
    async onAction(action: BlackjackAction) {
      if (this.sending) return
      this.sending = true
      this.actionError = ''
      try {
        if (action === 'bet') {
          // Validate BEFORE any value leaves the wallet: the dealer refunds a rejected stake but a
          // refund is a second transfer, so never send one we know will be refused.
          const parsed = parseBetInput(
            display => activeChain.fromDisplayAmount(display),
            this.betAmountDisplay,
          )
          if (!parsed.ok) {
            this.actionError = parsed.error
            this.focusBetInput()
            return
          }
          const wagerWei = parsed.wei
          const wallet = await useActiveWallet()
          const result = await activeChain.nativeTransfers.send({
            wallet,
            recipient: { raw: this.address },
            value: wagerWei,
          })
          const gameId = `bj-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`
          this.$emit('sendFollowUp', {
            items: [
              {
                type: 'blackjack-move',
                gameId,
                action: 'bet',
                wagerTxHash: result.txHash,
              },
            ],
          })
          return
        }

        if (action === 'double') {
          const wagerWei = this.liveState?.verifiedWagerWei
          if (wagerWei === undefined) {
            this.actionError =
              'Cannot double down: original wager not verified yet'
            return
          }
          const wallet = await useActiveWallet()
          const result = await activeChain.nativeTransfers.send({
            wallet,
            recipient: { raw: this.address },
            value: wagerWei,
          })
          this.$emit('sendFollowUp', {
            items: [
              {
                type: 'blackjack-move',
                gameId: this.item.gameId,
                action: 'double',
                doubleWagerTxHash: result.txHash,
              },
            ],
          })
          return
        }

        this.$emit('sendFollowUp', {
          items: [{ type: 'blackjack-move', gameId: this.item.gameId, action }],
        })
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        // Announced inline (aria-live) as well as toasted, e.g. "insufficient funds".
        this.actionError = /insufficient/i.test(error.message)
          ? `Insufficient funds: ${error.message}`
          : error.message
        errorNotify(error)
        if (action === 'bet') this.focusBetInput()
      } finally {
        this.sending = false
      }
    },
  },
})
</script>
