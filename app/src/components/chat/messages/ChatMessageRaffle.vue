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
    <div v-else-if="item.action === 'joined'" class="text-caption">
      Joined the raffle -- {{ item.entryCount ?? 0 }}/{{
        item.maxEntries ?? '?'
      }}
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
import { verifyRaffleDrawAgainstThread } from '@frank/wallet/message-item-plugins/raffle/draw'

import { useChatStore } from '../../../stores/chats'
import { useActiveWallet } from '../../../composables/useActiveWallet'
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
  data() {
    return {
      entering: false,
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
    // Checked against the seed commitment this round announced EARLIER, in an inbound `announce`
    // from the SAME sender as the draw (a joined reply comes after the entrant paid, so it does
    // not count). Not found in the chat, or an outbound/other-sender item: no claim either way.
    // A pass only shows the seed was not changed after the commitment and the winner follows
    // from the listed entrants; see wallet raffle/draw.ts for what it does not prove.
    verification() {
      if (this.item.action !== 'draw') return null
      const messages = useChatStore().chats[this.address]?.messages ?? []
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
      return verifyRaffleDrawAgainstThread(this.item, prior)
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
  },
})
</script>
