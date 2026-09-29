<template>
  <div class="raffle-move q-pa-sm" style="min-width: 220px">
    <template v-if="item.action === 'announce'">
      <div class="text-caption text-weight-bold q-mb-xs">
        Raffle open -- {{ item.entryCount ?? 0 }}/{{ item.maxEntries ?? '?' }}
        entered
      </div>
      <div class="text-caption q-mb-xs">
        Entry: {{ displayPrice(item.entryPriceWei) }}
      </div>
      <q-btn
        label="Enter"
        dense
        color="primary"
        :loading="entering"
        :disable="entering"
        @click="onEnter"
      />
    </template>
    <div v-else-if="item.action === 'enter'" class="text-caption">
      Entered the raffle
    </div>
    <div
      v-else-if="item.action === 'joined'"
      class="text-caption"
      role="status"
      aria-live="polite"
    >
      Joined the raffle -- {{ item.entryCount ?? 0 }}/{{
        item.maxEntries ?? '?'
      }}
      entered. Waiting for the round to fill...
      <div class="q-mt-xs">
        <q-btn
          label="Leave"
          :aria-label="`Leave raffle round ${item.raffleId}`"
          dense
          flat
          color="negative"
          :loading="leaving"
          :disable="leaving"
          @click="onLeave"
        />
      </div>
    </div>
    <div
      v-else-if="item.action === 'left'"
      class="text-caption"
      role="status"
      aria-live="polite"
    >
      Left the raffle -- {{ item.entryCount ?? 0 }}/{{ item.maxEntries ?? '?' }}
      entered. Your entry was refunded.
    </div>
    <template v-else-if="item.action === 'draw'">
      <div class="text-caption text-weight-bold" :class="outcomeClass">
        {{ outcomeText }}
      </div>
      <div class="text-caption">Pot: {{ displayPrice(item.potWei) }}</div>
      <div class="text-caption">
        Winner: {{ shortAddress(item.winnerAddress) }}
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
      v-else-if="item.action === 'error'"
      class="text-caption text-negative"
      role="alert"
      aria-live="assertive"
    >
      {{ item.message }}
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { RaffleItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import { verifyRaffleDraw } from '@frank/wallet/message-item-plugins/raffle/draw'

import { useActiveWallet } from '../../../composables/useActiveWallet'
import { errorNotify } from '../../../utils/notifications'

// How long the Leave button stays disabled after a click (see `onLeave`).
export const LEAVE_GUARD_MS = 30_000

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
  data() {
    return {
      entering: false,
      leaving: false,
      leaveGuardTimer: null as ReturnType<typeof setTimeout> | null,
      myAddress: null as string | null,
    }
  },
  beforeUnmount() {
    if (this.leaveGuardTimer) clearTimeout(this.leaveGuardTimer)
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
    didIWin(): boolean | null {
      if (!this.myAddress || !this.item.winnerAddress) return null
      return (
        this.myAddress.toLowerCase() === this.item.winnerAddress.toLowerCase()
      )
    },
    outcomeText(): string {
      if (this.didIWin === true) return 'You won the raffle!'
      if (this.didIWin === false)
        return 'Raffle drawn -- you did not win this time.'
      return 'Raffle drawn'
    },
    outcomeClass(): string {
      if (this.didIWin === true) return 'text-positive'
      return ''
    },
    verification() {
      const {
        winnerAddress,
        serverSeed,
        serverSeedHash,
        entrants,
        entryTxHashes,
      } = this.item
      if (
        !winnerAddress ||
        !serverSeed ||
        !serverSeedHash ||
        !entrants ||
        !entryTxHashes
      ) {
        return null
      }
      return verifyRaffleDraw({
        serverSeed,
        serverSeedHash,
        entrants,
        entryTxHashes,
        winnerAddress,
      })
    },
  },
  methods: {
    displayPrice(weiString?: string): string {
      if (!weiString) return '0'
      return `${activeChain.toDisplayAmount(BigInt(weiString))} ${
        activeChain.unit
      }`
    },
    shortAddress(addr?: string): string {
      if (!addr) return '?'
      return `${addr.slice(0, 6)}...${addr.slice(-4)}`
    },
    async onEnter() {
      if (this.entering) return
      this.entering = true
      try {
        this.$emit('sendFollowUp', {
          items: [
            { type: 'raffle', raffleId: this.item.raffleId, action: 'enter' },
          ],
          stampValueWei: BigInt(this.item.entryPriceWei ?? '0'),
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.entering = false
      }
    },
    onLeave() {
      if (this.leaving) return
      // Stays disabled after the (synchronous) emit -- the bot's `left`/`error` answer arrives as
      // a new bubble, and this component has no chat/round state to observe it with, so a fixed
      // guard window (not the same tick) is what stops repeated clicks from sending repeated
      // stamped `leave` messages. Known limit: an old `joined` bubble is still clickable once the
      // guard expires or after a reload, since the component has no access to the round's current
      // state; the bot rejects such stale/duplicate leaves (one leave per address per round).
      this.leaving = true
      this.leaveGuardTimer = setTimeout(() => {
        this.leaving = false
        this.leaveGuardTimer = null
      }, LEAVE_GUARD_MS)
      try {
        // No stamp-value override -- a leave carries no payment of its own (the bot refunds the
        // original entry from its own balance), same pattern as blackjack's hit/stand rather than
        // its bet.
        this.$emit('sendFollowUp', {
          items: [
            { type: 'raffle', raffleId: this.item.raffleId, action: 'leave' },
          ],
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
        this.leaving = false
      }
    },
  },
})
</script>
