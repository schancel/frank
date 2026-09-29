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
        v-if="state.availableActions.includes('bet')"
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
          hint="0.01 to 1 MON"
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
        :class="actionError ? 'text-negative' : ''"
      >
        {{ actionError }}
      </div>
      <div v-if="state.availableActions.length" class="q-gutter-sm q-mt-sm">
        <q-btn
          v-for="action in state.availableActions"
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
  BlackjackAction,
  BlackjackGameState,
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
import { blackjackErrorText, parseBetInput } from '../../../utils/blackjack-bet'

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
      state: null as BlackjackGameState | null,
      betAmountDisplay: DEFAULT_BET_AMOUNT_DISPLAY,
      // Inline (aria-live) message: send failures such as insufficient funds, and the dealer's
      // own rejection text. Kept alongside, not instead of, the toast.
      actionError: '',
    }
  },
  computed: {
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
  },
  methods: {
    cardLabel,
    cardLabels(cards: number[]): string {
      return cards.length ? cards.map(cardLabel).join(' ') : '—'
    },
    actionLabel(action: BlackjackAction): string {
      if (action === 'bet') return `Deal me in (${this.betAmountDisplay} MON)`
      if (action === 'double') {
        const wagerWei = this.state?.verifiedWagerWei
        return wagerWei !== undefined
          ? `Double down (${activeChain.toDisplayAmount(wagerWei)} MON)`
          : 'Double down'
      }
      return ACTION_LABELS[action] ?? action
    },
    async loadState() {
      this.loading = true
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

        let folded: BlackjackGameState | undefined
        this.actionError = ''
        outer: for (const message of messages) {
          for (let index = 0; index < message.items.length; index++) {
            const raw = message.items[index]
            // The dealer answers a rejected request with a plain "Blackjack: ..." text message.
            // If it lands while our optimistic double is still pending, surface it and unlock
            // (hit/stand only). Design limit: the text carries no gameId, and silence (an old bot
            // with no double branch) cannot be detected here, so the UI stays locked then.
            if (
              raw.type === 'text' &&
              !message.outbound &&
              folded?.doublePending
            ) {
              const errorText = blackjackErrorText(raw.text)
              if (errorText) {
                this.actionError = errorText
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
            if (raw === this.item) break outer
          }
        }
        this.state = folded ?? null
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.loading = false
      }
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
          const wagerWei = this.state?.verifiedWagerWei
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
      } finally {
        this.sending = false
      }
    },
  },
})
</script>
