<template>
  <div class="blackjack-move q-pa-sm" style="min-width: 220px">
    <div v-if="loading" class="text-caption">Loading hand...</div>
    <template v-else-if="state">
      <div class="text-caption text-weight-bold">
        Your hand: {{ cardLabels(state.playerCards) }}
        <span v-if="state.playerCards.length">({{ playerValue.total }}{{ playerValue.soft ? ' soft' : '' }})</span>
      </div>
      <div v-if="state.dealerUpCard !== undefined" class="text-caption">
        Dealer shows: {{ cardLabel(state.dealerUpCard) }}
      </div>
      <template v-if="state.phase === 'resolved'">
        <div class="text-caption">
          Dealer's hand: {{ cardLabels(state.dealerCards) }} ({{ dealerValue.total }})
        </div>
        <div class="text-caption text-weight-bold q-mt-xs">{{ outcomeText }}</div>
        <div v-if="verification" class="text-caption" :class="verification.valid ? 'text-positive' : 'text-negative'">
          {{ verification.valid ? '✓ Verified fair' : `⚠ Verification failed: ${verification.reason}` }}
        </div>
      </template>
      <div v-if="state.availableActions.length" class="q-gutter-sm q-mt-sm">
        <q-btn
          v-for="action in state.availableActions"
          :key="action"
          :label="actionLabel(action)"
          :loading="sending"
          :disable="sending"
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
import { cardLabel, handValue } from '@frank/wallet/blackjack/deck'
import {
  BlackjackAction,
  BlackjackGameState,
  verifyRevealedHand,
} from '@frank/wallet/blackjack/game'
import {
  getMessageItemPlugin,
  MessageItemContext,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import '@frank/wallet/message-item-plugins/blackjack'

import { useChatStore } from '../../../stores/chats'
import { useMonadWallet } from '../../../utils/clients'
import { useActiveWallet } from '../../../composables/useActiveWallet'
import { errorNotify } from '../../../utils/notifications'

// Fixed for v1 -- a real "choose your bet size" input is a natural fast-follow, not built yet
// (see this component's own PR/commit notes). Comfortably above the relay's stamp minimum so a
// bot dealer never rejects it as "below the table minimum."
const DEFAULT_WAGER_WEI = 100000000000000000n // 0.1 MON

const ACTION_LABELS: Record<BlackjackAction, string> = {
  bet: 'Deal me in (0.1 MON)',
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
    }
  },
  computed: {
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
      return ACTION_LABELS[action]
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
        outer: for (const message of messages) {
          for (let index = 0; index < message.items.length; index++) {
            const raw = message.items[index]
            if (raw.type !== 'blackjack-move' || raw.gameId !== this.item.gameId) {
              continue
            }
            const context: MessageItemContext = { message, index, provider: wallet.provider }
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
      try {
        if (action === 'bet') {
          const wallet = await useActiveWallet()
          const result = await activeChain.nativeTransfers.send({
            wallet,
            recipient: { raw: this.address },
            value: DEFAULT_WAGER_WEI,
          })
          const gameId = `bj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

        this.$emit('sendFollowUp', {
          items: [
            { type: 'blackjack-move', gameId: this.item.gameId, action },
          ],
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.sending = false
      }
    },
  },
})
</script>
