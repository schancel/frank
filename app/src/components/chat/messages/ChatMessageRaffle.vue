<template>
  <div class="raffle-move q-pa-sm" style="min-width: 220px">
    <template v-if="item.action === 'announce'">
      <div class="text-caption text-weight-bold q-mb-xs">
        Raffle open: {{ item.entryCount ?? 0 }}/{{ item.maxEntries ?? '?' }}
        entered
      </div>
      <div class="text-caption q-mb-xs">
        Entry: {{ displayPrice(item.entryPriceWei) }}
      </div>
      <q-btn
        no-caps
        v-if="!confirming"
        :label="$t('raffle.enter')"
        dense
        color="primary"
        data-testid="raffle-enter"
        :loading="entering"
        :disable="entering || entryPrice === null"
        @click="openConfirm"
      />
      <!-- Entering pays the sender of this card at once (the entry price is the stamp of the
      entry message, and the price is whatever this card says), so it always takes a second,
      explicit step that shows the amount. -->
      <div
        v-else
        class="q-pa-xs"
        role="group"
        tabindex="-1"
        :aria-label="$t('raffle.confirmGroupLabel')"
        data-testid="raffle-confirm"
      >
        <div class="text-caption" :title="exactEntryPrice || undefined">
          {{
            $t('raffle.confirmPrompt', {
              amount: displayPrice(item.entryPriceWei),
            })
          }}
        </div>
        <div
          v-if="confirmBlockedText"
          role="status"
          class="text-caption text-negative"
          data-testid="raffle-confirm-blocked"
        >
          {{ confirmBlockedText }}
        </div>
        <div class="q-gutter-xs q-mt-xs">
          <q-btn
            no-caps
            :label="$t('raffle.confirm')"
            dense
            color="primary"
            data-testid="raffle-confirm-enter"
            :loading="entering"
            :disable="entering || !canAfford"
            @click="confirmAndEnter"
          />
          <q-btn
            no-caps
            :label="$t('raffle.cancel')"
            dense
            flat
            data-testid="raffle-confirm-cancel"
            :disable="entering"
            @click="cancelConfirm"
          />
        </div>
      </div>
    </template>
    <div v-else-if="item.action === 'enter'" class="text-caption">
      Entered the raffle
    </div>
    <div v-else-if="item.action === 'joined'" class="text-caption">
      Joined the raffle: {{ item.entryCount ?? 0 }}/{{ item.maxEntries ?? '?' }}
      entered. Waiting for the round to fill...
    </div>
    <template v-else-if="item.action === 'draw'">
      <div class="text-caption text-weight-bold" :class="outcomeClass">
        {{ outcomeText }}
      </div>
      <div class="text-caption">Pot: {{ displayPrice(item.potWei) }}</div>
      <div class="text-caption">
        Winner: {{ shortAddress(item.winnerAddress) }}
      </div>
      <div v-if="verification" role="status" class="text-caption">
        <div :class="verification.valid ? 'text-positive' : 'text-negative'">
          {{
            verification.valid
              ? `✓ ${$t('raffleDraw.verified')}`
              : `⚠ ${$t('raffleDraw.failed', { reason: verification.reason })}`
          }}
        </div>
        <details class="raffle-explainer">
          <summary>{{ $t('raffleDraw.explainerToggle') }}</summary>
          <p class="q-mb-none">{{ $t('raffleDraw.explainerShows') }}</p>
          <p class="q-mb-none">{{ $t('raffleDraw.explainerNotShown') }}</p>
          <p
            v-if="verification.valid && !verification.countVerified"
            class="q-mb-none"
          >
            {{ $t('raffleDraw.explainerCountUnverified') }}
          </p>
        </details>
      </div>
    </template>
    <div v-else-if="item.action === 'error'" class="text-caption text-negative">
      {{ item.message }}
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType, toRaw } from 'vue'

import { RaffleItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import {
  formatDisplayAmount,
  formatRawAmount,
} from '../../../utils/chain-amount'
import { verifyRaffleDrawAgainstThread } from '@frank/wallet/message-item-plugins/raffle/draw'

import { useChatStore } from '../../../stores/chats'
import { useActiveWallet } from '../../../composables/useActiveWallet'
import { useBalance } from '../../../composables/useBalance'
import { errorNotify } from '../../../utils/notifications'

export default defineComponent({
  name: 'ChatMessageRaffle',
  props: {
    item: {
      type: Object as PropType<RaffleItem>,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
  },
  emits: ['sendFollowUp'],
  setup() {
    // The spendable balance only: cordoned funds cannot pay an entry.
    const { balance } = useBalance()
    return { balance }
  },
  data() {
    return {
      entering: false,
      confirming: false,
      myAddress: null as string | null,
    }
  },
  async mounted() {
    if (this.item.action !== 'draw') return
    try {
      const wallet = await useActiveWallet()
      this.myAddress = wallet.identity.displayAddress
    } catch {
      // Not fatal -- just means the win/lose framing below falls back to "Winner: <address>" only.
    }
  },
  computed: {
    /** The entry price this card states, or null when it is not a plain amount. Peer data. */
    entryPrice(): bigint | null {
      const text = String(this.item.entryPriceWei ?? '')
      return /^\d{1,40}$/.test(text) ? BigInt(text) : null
    },
    exactEntryPrice(): string {
      return this.entryPrice === null
        ? ''
        : formatRawAmount(activeChain, this.entryPrice)
    },
    canAfford(): boolean {
      return (
        this.entryPrice !== null &&
        this.balance !== null &&
        this.entryPrice <= this.balance
      )
    },
    /** Why Confirm is unavailable, in words; empty when it is available. */
    confirmBlockedText(): string {
      if (this.canAfford || this.entryPrice === null) return ''
      if (this.balance === null) return this.$t('raffle.balanceUnknown')
      return this.$t('raffle.insufficient', {
        balance: formatDisplayAmount(activeChain, this.balance),
      })
    },
    didIWin(): boolean | null {
      if (!this.myAddress || !this.item.winnerAddress) return null
      return (
        this.myAddress.toLowerCase() === this.item.winnerAddress.toLowerCase()
      )
    },
    outcomeText(): string {
      if (this.didIWin === true) return 'You won the raffle!'
      if (this.didIWin === false)
        return 'Raffle drawn: you did not win this time.'
      return 'Raffle drawn'
    },
    outcomeClass(): string {
      if (this.didIWin === true) return 'text-positive'
      return ''
    },
    // Checked against the seed commitment this round announced EARLIER, in an inbound `announce`
    // from the SAME sender as the draw (a joined reply comes after the entrant paid, so it does
    // not count). Not found in the chat, or an outbound/other-sender item: no claim either way.
    // A pass only shows the seed was not changed after the commitment and the winner follows
    // from the listed entrants; see wallet raffle/draw.ts for what it does not prove.
    verification() {
      if (this.item.action !== 'draw') return null
      const messages = useChatStore().activeConversation?.messages ?? []
      const me = toRaw(this.item)
      const at = messages.findIndex(m => m.items.some(i => toRaw(i) === me))
      if (at === -1 || messages[at].outbound) return null
      const sender = (messages[at].senderAddress ?? '').toLowerCase()
      if (!sender) return null
      const prior = messages
        .slice(0, at)
        .filter(
          m => !m.outbound && (m.senderAddress ?? '').toLowerCase() === sender,
        )
        .flatMap(m =>
          m.items.filter((i): i is RaffleItem => i.type === 'raffle'),
        )
      try {
        return verifyRaffleDrawAgainstThread(this.item, prior)
      } catch {
        return { valid: false, reason: 'the draw could not be verified' }
      }
    },
  },
  methods: {
    // Peer data: never throw while rendering.
    displayPrice(weiString?: string): string {
      if (!weiString) return '0'
      try {
        if (!/^\d{1,40}$/.test(String(weiString))) return '?'
        return formatDisplayAmount(activeChain, BigInt(weiString))
      } catch {
        return '?'
      }
    },
    shortAddress(addr?: string): string {
      if (!addr) return '?'
      return `${addr.slice(0, 6)}...${addr.slice(-4)}`
    },
    // The control that had focus is removed when the confirmation opens or closes, so focus
    // moves to the new place explicitly instead of dropping to the page.
    focusFor(testid: string) {
      void this.$nextTick(() => {
        ;(this.$el as HTMLElement)
          .querySelector<HTMLElement>(`[data-testid="${testid}"]`)
          ?.focus()
      })
    },
    openConfirm() {
      if (this.entering || this.entryPrice === null) return
      this.confirming = true
      this.focusFor('raffle-confirm')
    },
    cancelConfirm() {
      this.confirming = false
      this.focusFor('raffle-enter')
    },
    async confirmAndEnter() {
      const price = this.entryPrice
      if (this.entering || !this.confirming || price === null) return
      if (!this.canAfford) return
      // One confirmation pays for one entry: close it before anything is sent.
      this.confirming = false
      this.focusFor('raffle-enter')
      this.entering = true
      try {
        this.$emit('sendFollowUp', {
          items: [
            { type: 'raffle', raffleId: this.item.raffleId, action: 'enter' },
          ],
          stampValueWei: price,
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.entering = false
      }
    },
  },
})
</script>
