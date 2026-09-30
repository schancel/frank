<template>
  <div class="blackjack-move q-pa-sm" style="min-width: 220px">
    <!-- The dealer's opening message (#395): table limits, rules and the inline bet control. -->
    <template v-if="isWelcome">
      <div class="text-subtitle2" data-testid="blackjack-welcome-title">
        {{ $t('blackjackWelcome.title') }}
      </div>
      <div class="text-caption" data-testid="blackjack-welcome-limits">
        {{ $t('blackjackBet.limits', welcomeLimits) }}
      </div>
      <div
        v-if="welcomeRules"
        class="text-caption q-mt-xs"
        data-testid="blackjack-welcome-rules"
      >
        {{ welcomeRules }}
      </div>
      <blackjack-bet-control
        v-if="isLatest && blackjackChat && dealerOffersTable"
        class="q-mt-sm"
        data-testid="blackjack-welcome-bet"
        :address="address"
        :dealer-name="dealerName"
        :table="table"
        :stamp-wei="chatStampWei"
        :submit="blackjackChat.submit"
      />
    </template>
    <div v-else-if="loading" class="text-caption">Loading hand...</div>
    <template v-else-if="state">
      <template v-if="state.phase === 'awaiting_deal'">
        <div
          class="text-caption text-weight-bold"
          data-testid="blackjack-bet-line"
        >
          {{ betLine }}
        </div>
        <div class="text-caption">{{ $t('blackjackHand.betWaiting') }}</div>
      </template>
      <div v-else class="text-caption text-weight-bold">
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
          v-if="payoutText"
          class="text-caption"
          data-testid="blackjack-payout"
        >
          {{ payoutText }}
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
      <!-- Play again: the same durable, confirmed bet control as the welcome's. -->
      <blackjack-bet-control
        v-if="
          actionState &&
          actionState.availableActions.includes('bet') &&
          blackjackChat &&
          dealerOffersTable
        "
        class="q-mt-sm"
        data-testid="blackjack-play-again"
        :title="$t('blackjackBet.playAgainTitle')"
        :address="address"
        :dealer-name="dealerName"
        :table="table"
        :stamp-wei="chatStampWei"
        :submit="blackjackChat.submit"
      />
      <!-- Ticket #366: a paid move nobody answered. Only a plain hit/stand can be re-sent, and only
      behind an explicit consent: a resend is a second paid message, and a repeated hit could be
      played twice once the dealer returns. A wager (bet/double) is never re-sent. -->
      <div
        v-if="dealerSilent"
        role="status"
        aria-live="polite"
        class="dealer-silent text-caption q-mt-sm q-pa-xs text-negative"
        data-testid="dealer-silent"
      >
        <div class="text-weight-bold">
          {{ $t('blackjackDealer.silentTitle') }}
        </div>
        <div>{{ $t('blackjackDealer.silentBody') }}</div>
        <div>{{ $t('blackjackDealer.silentWait') }}</div>
        <div>{{ $t('blackjackDealer.silentRefund') }}</div>
        <template v-if="resendAction">
          <q-checkbox
            v-model="resendConfirmed"
            dense
            data-testid="dealer-resend-confirm"
            :label="
              $t('blackjackDealer.resendConfirm', {
                action: actionLabel(resendAction).toLowerCase(),
              })
            "
          />
          <q-btn
            dense
            color="primary"
            data-testid="dealer-resend"
            :label="$t('blackjackDealer.resend')"
            :disable="!resendConfirmed || sending"
            @click="onResend"
          />
        </template>
        <div v-else>{{ $t('blackjackDealer.silentNoResend') }}</div>
      </div>
      <div
        role="status"
        aria-live="polite"
        class="text-caption q-mt-xs"
        :class="visibleError ? 'text-negative' : ''"
      >
        {{ visibleError }}
      </div>
      <div v-if="moveActions.length" class="q-gutter-sm q-mt-sm">
        <q-btn
          v-for="action in moveActions"
          :key="action"
          :label="actionLabel(action)"
          :loading="sending"
          :disable="sending || dealerSilent"
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
  blackjackPayoutWei,
  BlackjackAction,
  BlackjackGameState,
  parseBlackjackError,
  parseBlackjackWelcome,
  verifyRevealedHand,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  getMessageItemPlugin,
  MessageItemContext,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import '@frank/wallet/message-item-plugins/blackjack/plugin'

import { useChatStore } from '../../../stores/chats'
import { useContactStore } from '../../../stores/contacts'
import { useMonadWallet } from '../../../utils/clients'
import { useActiveWallet } from '../../../composables/useActiveWallet'
import { errorNotify } from '../../../utils/notifications'
import {
  BlackjackTable,
  betLimitsDisplay,
  latestDealerTable,
  peerOffersDealerTable,
} from '../../../utils/blackjack-bet'
import BlackjackBetControl from '../BlackjackBetControl.vue'
import type { MessageItem } from '@frank/cashweb/types/messages'

/** What a chat page offers its bubbles for placing a bet (`provide`d by `pages/Chat.vue`): the
 * awaited, idle-waiting delivery of the bet message, and the stamp the chat will pay for it. */
export interface BlackjackChatContext {
  submit: (payload: { items: MessageItem[]; address: string }) => Promise<void>
  stampWei: () => bigint | null
}

// How long a paid move may go unanswered before the bubble says so (ticket #366). Comfortably above
// a bot's normal poll + reply time so a slow-but-alive dealer never triggers it.
const DEALER_ANSWER_TIMEOUT_MS = 45_000

const ACTION_LABELS: Partial<Record<BlackjackAction, string>> = {
  hit: 'Hit',
  stand: 'Stand',
  deal: 'Deal',
  reveal: 'Reveal',
}

export default defineComponent({
  name: 'ChatMessageBlackjack',
  components: { BlackjackBetControl },
  inject: {
    blackjackChat: { from: 'blackjackChat', default: null },
  },
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
      // Derived from the persisted send time of the last move, so it survives a reload.
      dealerSilent: false,
      // The unanswered move's action, and the player's explicit consent to pay for it again.
      unansweredAction: undefined as BlackjackAction | undefined,
      resendConfirmed: false,
      dealerTimer: undefined as ReturnType<typeof setTimeout> | undefined,
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
    // Only a plain hit/stand can be re-sent: a bet or double carries a wager transfer that would be
    // paid a second time.
    resendAction(): 'hit' | 'stand' | undefined {
      const action = this.unansweredAction
      return this.dealerSilent && (action === 'hit' || action === 'stand')
        ? action
        : undefined
    },
    isWelcome(): boolean {
      return this.item.action === 'welcome'
    },
    // A welcome or "play again" box moves real MON. Only the curated dealer may offer one (#422).
    dealerOffersTable(): boolean {
      return peerOffersDealerTable(
        useContactStore().getContact(this.address)?.profile,
      )
    },
    // The move buttons of the live hand. A bet is not one of them: it is the bet control's job.
    moveActions(): BlackjackAction[] {
      return (this.actionState?.availableActions ?? []).filter(
        action => action !== 'bet',
      )
    },
    // The table the bet controls play at: the dealer's LATEST welcome in this chat (a newer welcome
    // supersedes an older one), or the documented fallback. Recomputed as messages arrive.
    table(): BlackjackTable {
      return latestDealerTable(
        useChatStore().chats[this.address]?.messages ?? [],
      )
    },
    // This welcome bubble's own advertised limits (an older welcome still shows what it said);
    // a malformed one shows the table in force.
    welcomeLimits(): { min: string; max: string } {
      const own = parseBlackjackWelcome(this.item)
      return betLimitsDisplay(
        own ? { minWei: own.minWagerWei, maxWei: own.maxWagerWei } : this.table,
      )
    },
    welcomeRules(): string {
      return parseBlackjackWelcome(this.item)?.rules ?? ''
    },
    dealerName(): string {
      return useContactStore().getContact(this.address)?.profile?.name ?? ''
    },
    chatStampWei(): bigint | null {
      return (
        (this.blackjackChat as BlackjackChatContext | null)?.stampWei() ?? null
      )
    },
    // Changes whenever a message arrives in this chat, so the fold is redone with the latest.
    chatMessageCount(): number {
      return useChatStore().chats[this.address]?.messages?.length ?? 0
    },
    playerValue() {
      return handValue(this.state?.playerCards ?? [])
    },
    dealerValue() {
      return handValue(this.state?.dealerCards ?? [])
    },
    betLine(): string {
      const wager = this.state?.verifiedWagerWei
      return wager !== undefined
        ? this.$t('blackjackHand.bet', {
            amount: activeChain.toDisplayAmount(wager),
          })
        : this.$t('blackjackHand.betUnverified')
    },
    // What the dealer sends back for a win or a push (a loss sends nothing, said by the outcome).
    // A promise, not a receipt: the dealer sends the reveal first and the payout transfer after
    // it, and the chat has no record of that transfer. Never shown for a hand whose fairness
    // check failed, since the figure would rest on data that did not verify.
    payoutText(): string {
      if (this.verification && !this.verification.valid) return ''
      const payout = this.state ? blackjackPayoutWei(this.state) : undefined
      return payout
        ? this.$t('blackjackHand.payout', {
            amount: activeChain.toDisplayAmount(payout),
          })
        : ''
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
  beforeUnmount() {
    clearTimeout(this.dealerTimer)
  },
  methods: {
    cardLabel,
    cardLabels(cards: number[]): string {
      return cards.length ? cards.map(cardLabel).join(' ') : '—'
    },
    actionLabel(action: BlackjackAction): string {
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
        // Only the newest blackjack item of the whole chat offers actions or a bet control: once a
        // later hand (or message) exists, an older bubble is history and can never send a move.
        let chatLastRaw: unknown
        for (const message of messages) {
          for (const raw of message.items) {
            if (raw.type === 'blackjack-move') chatLastRaw = raw
          }
        }
        if (this.isWelcome) {
          // A welcome belongs to no hand: nothing to fold or verify.
          this.isLatest = chatLastRaw === this.item
          this.loading = false
          return
        }
        const plugin = getMessageItemPlugin('blackjack-move')
        if (!plugin?.reduceState) {
          throw new Error('blackjack-move plugin not registered')
        }

        // Fold EVERY message of this game (not just up to this item): the actions and errors on
        // screen must reflect the latest messages, and this item only decides what it displays.
        let folded: BlackjackGameState | undefined
        let atItem: BlackjackGameState | undefined
        let lastRaw: unknown
        let lastMessage: (typeof messages)[number] | undefined
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
            lastMessage = message
            // The dealer's card for an accepted double supersedes an earlier assumed rejection.
            if (raw.action === 'double' && raw.playerCards) dealerError = ''
            if (raw === this.item) atItem = folded
          }
        }
        if (seq !== this.loadSeq) return // a newer load superseded this one
        this.state = atItem ?? folded ?? null
        this.liveState = folded ?? null
        this.isLatest = chatLastRaw === this.item
        this.dealerError = dealerError
        const awaiting =
          this.isLatest &&
          lastMessage?.outbound === true &&
          lastMessage.status !== 'pending' &&
          lastMessage.status !== 'error'
        this.unansweredAction = awaiting
          ? (lastRaw as BlackjackMoveItem).action
          : undefined
        this.armDealerTimer(awaiting ? lastMessage?.serverTime ?? 0 : 0)
      } catch (err) {
        // A superseded load's failure is irrelevant: the newer load owns the display.
        if (seq === this.loadSeq) {
          errorNotify(err instanceof Error ? err : new Error(String(err)))
        }
      } finally {
        if (seq === this.loadSeq) this.loading = false
      }
    },
    // Flips `dealerSilent` once DEALER_ANSWER_TIMEOUT_MS has passed since the unanswered move was
    // sent; a reply (or any state where nothing awaits the dealer) clears it again.
    armDealerTimer(sentAt: number) {
      clearTimeout(this.dealerTimer)
      this.dealerTimer = undefined
      if (!sentAt) {
        this.dealerSilent = false
        return
      }
      const remaining = sentAt + DEALER_ANSWER_TIMEOUT_MS - Date.now()
      this.dealerSilent = remaining <= 0
      if (remaining > 0) {
        this.dealerTimer = setTimeout(() => {
          this.dealerSilent = true
        }, remaining)
      }
    },
    onResend() {
      const action = this.resendAction
      if (!action || !this.resendConfirmed || this.sending) return
      // One consent buys one resend.
      this.resendConfirmed = false
      void this.onAction(action)
    },
    async onAction(action: BlackjackAction) {
      if (this.sending) return
      this.sending = true
      this.actionError = ''
      try {
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
      } finally {
        this.sending = false
      }
    },
  },
})
</script>
