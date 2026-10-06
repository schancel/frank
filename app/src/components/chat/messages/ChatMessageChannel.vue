<template>
  <div
    class="channel-update-message q-pa-sm"
    data-testid="chat-message-channel"
    style="min-width: 280px; max-width: 440px"
  >
    <!-- Header -->
    <div class="row items-center justify-between q-mb-xs">
      <div class="row items-center">
        <q-icon :name="appIcon" size="20px" class="q-mr-xs text-primary" />
        <span class="text-subtitle2 text-weight-bold">{{ appTitle }}</span>
        <q-badge
          :color="appBadgeColor"
          class="q-ml-xs text-capitalize"
          :label="item.appId || 'channel'"
        />
      </div>
      <q-badge
        color="grey-8"
        class="text-mono"
        :label="`#${item.sequenceNumber}`"
      />
    </div>

    <!-- Channel Identifiers -->
    <div class="text-caption text-grey-7 row items-center q-mb-xs">
      <span class="text-mono text-weight-medium">Channel:</span>
      <span class="text-mono q-ml-xs">{{ truncatedChannelId }}</span>
      <span
        v-if="item.settlementRef"
        class="q-ml-sm text-mono text-positive text-weight-bold"
      >
        [Settled]
      </span>
    </div>

    <q-separator class="q-my-xs" />

    <!-- Application-Specific Views -->
    <!-- 1. Dice Game Payload -->
    <div v-if="decodedApp?.type === 'dice'" class="q-my-xs">
      <div class="row items-center justify-between">
        <span class="text-caption text-weight-bold">🎲 Satoshi Dice</span>
        <q-badge :color="diceActionColor" :label="decodedApp.data.action" />
      </div>
      <div class="text-caption q-mt-xs">
        Round: <strong>#{{ decodedApp.data.round }}</strong>
      </div>
      <div v-if="decodedApp.data.targetRoll !== undefined" class="text-caption">
        Target: <strong>&lt; {{ decodedApp.data.targetRoll }}</strong>
      </div>
      <div v-if="decodedApp.data.wager !== undefined" class="text-caption">
        Wager: <strong>{{ formatAmount(decodedApp.data.wager) }}</strong>
      </div>
      <div
        v-if="decodedApp.data.seedCommitment"
        class="text-caption text-mono text-grey-7"
        style="font-size: 10px"
      >
        Seed: {{ truncate(formatHex(decodedApp.data.seedCommitment)) }}
      </div>
    </div>

    <!-- 2. Poker Game Payload -->
    <div v-else-if="decodedApp?.type === 'poker'" class="q-my-xs">
      <div class="row items-center justify-between">
        <span class="text-caption text-weight-bold">🃏 Poker</span>
        <q-badge color="purple" :label="decodedApp.data.phase || 'hand'" />
      </div>
      <div class="text-caption q-mt-xs">
        Hand:
        <strong class="text-mono">{{
          truncate(formatHex(decodedApp.data.handId))
        }}</strong>
      </div>
      <div v-if="decodedApp.data.action" class="text-caption">
        Action: <strong>{{ decodedApp.data.action }}</strong>
      </div>
      <div
        v-if="decodedApp.data.cardCommitments?.length"
        class="text-caption text-grey-8"
      >
        Commitments: {{ decodedApp.data.cardCommitments.length }} cards
      </div>
    </div>

    <!-- 3. Swap Offer Payload -->
    <div v-else-if="decodedApp?.type === 'swap'" class="q-my-xs">
      <div class="row items-center justify-between">
        <span class="text-caption text-weight-bold">🔄 Atomic Swap</span>
        <q-badge color="primary" label="offer" />
      </div>
      <div class="q-mt-xs text-caption">
        <div>
          Swap:
          <strong class="text-mono">{{
            truncate(formatHex(decodedApp.data.swapId))
          }}</strong>
        </div>
        <div>
          Maker Amount:
          <strong>{{ formatAmount(decodedApp.data.makerAmount) }}</strong>
        </div>
        <div>
          Taker Amount:
          <strong>{{ formatAmount(decodedApp.data.takerAmount) }}</strong>
        </div>
        <div>Expiration: {{ decodedApp.data.expiration }}</div>
      </div>
    </div>

    <!-- 4. Raffle Payload -->
    <div v-else-if="decodedApp?.type === 'raffle'" class="q-my-xs">
      <div class="row items-center justify-between">
        <span class="text-caption text-weight-bold">🎟️ Raffle</span>
        <q-badge color="teal" label="raffle" />
      </div>
      <div class="text-caption q-mt-xs">
        <div>
          Raffle:
          <strong class="text-mono">{{
            truncate(formatHex(decodedApp.data.raffleId))
          }}</strong>
        </div>
        <div>
          Ticket Price:
          <strong>{{ formatAmount(decodedApp.data.ticketPrice) }}</strong>
        </div>
        <div>
          Tickets Sold: <strong>{{ decodedApp.data.ticketsSold }}</strong>
        </div>
      </div>
    </div>

    <!-- 5. Fallback/Generic Application State -->
    <div v-else class="q-my-xs">
      <div class="text-caption text-grey-8">
        Application State:
        <span class="text-mono" style="word-break: break-all">{{
          appStatePreview
        }}</span>
      </div>
    </div>

    <q-separator class="q-my-xs" />

    <!-- Channel Allocations -->
    <div class="channel-allocations q-my-xs">
      <div class="text-caption text-weight-medium text-grey-9 q-mb-xs">
        Allocations:
      </div>
      <div
        v-for="(alloc, aIdx) in item.allocations"
        :key="aIdx"
        class="bg-grey-2 q-pa-xs rounded-borders q-mb-xs"
        style="font-size: 11px"
      >
        <div
          class="row items-center justify-between text-weight-bold text-grey-8"
        >
          <span>{{ alloc.networkTag }}</span>
          <span v-if="alloc.token" class="text-mono">{{
            truncate(alloc.token)
          }}</span>
        </div>
        <div
          v-for="(bal, bIdx) in alloc.balances"
          :key="bIdx"
          class="row items-center justify-between q-mt-xs text-mono"
        >
          <span class="text-grey-7"
            >{{ truncatePubkey(bal.participant.pubKey) }}:</span
          >
          <span class="text-weight-medium">{{
            formatBalance(bal.balance, alloc.networkTag)
          }}</span>
        </div>
      </div>
    </div>

    <!-- Signatures and Verification Footer -->
    <div
      class="row items-center justify-between q-mt-xs text-caption text-grey-7"
      style="font-size: 11px"
    >
      <div class="row items-center">
        <q-icon name="verified" size="14px" color="positive" class="q-mr-xs" />
        <span
          >{{ item.signatures.length }} signature{{
            item.signatures.length === 1 ? '' : 's'
          }}
          verified</span
        >
      </div>
      <div v-if="item.settlementRef" class="text-mono">
        ref: {{ truncate(item.settlementRef) }}
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, type PropType } from 'vue'
import type { ChannelUpdateItem } from '@frank/cashweb/types/messages'
import {
  decodeAppPayload,
  fromHex,
  toHex,
  type DiceGamePayload,
  type PokerGamePayload,
  type SwapOfferPayload,
  type RafflePayload,
} from '@frank/codec'
import { activeChain } from '@frank/wallet/chain'

export default defineComponent({
  name: 'ChatMessageChannel',
  props: {
    item: {
      type: Object as PropType<ChannelUpdateItem>,
      required: true,
    },
    address: {
      type: String,
      required: false,
      default: '',
    },
    payloadDigest: {
      type: String,
      required: false,
      default: '',
    },
  },
  emits: ['sendFollowUp'],
  setup(props) {
    const truncatedChannelId = computed(() => {
      const id = props.item.channelId || ''
      if (id.length <= 16) return id
      return `${id.slice(0, 8)}...${id.slice(-6)}`
    })

    const appIcon = computed(() => {
      switch (props.item.appId?.toLowerCase()) {
        case 'dice':
        case 'liars-dice':
          return 'casino'
        case 'poker':
          return 'style'
        case 'swap':
          return 'swap_horiz'
        case 'raffle':
          return 'confirmation_number'
        default:
          return 'hub'
      }
    })

    const appTitle = computed(() => {
      switch (props.item.appId?.toLowerCase()) {
        case 'dice':
          return 'Satoshi Dice'
        case 'liars-dice':
          return "Liar's Dice"
        case 'poker':
          return "Texas Hold'em"
        case 'swap':
          return 'Atomic Swap'
        case 'raffle':
          return 'Raffle'
        default:
          return 'State Channel'
      }
    })

    const appBadgeColor = computed(() => {
      switch (props.item.appId?.toLowerCase()) {
        case 'dice':
        case 'liars-dice':
          return 'amber-9'
        case 'poker':
          return 'purple'
        case 'swap':
          return 'indigo'
        case 'raffle':
          return 'teal'
        default:
          return 'blue-grey'
      }
    })

    const diceActionColor = computed(() => {
      const decoded = decodedApp.value
      if (decoded?.type !== 'dice') return 'grey'
      switch (decoded.data.action) {
        case 'roll':
          return 'primary'
        case 'reveal':
          return 'positive'
        case 'commit':
          return 'warning'
        default:
          return 'grey-8'
      }
    })

    const appStateBytes = computed<Uint8Array | null>(() => {
      const state = props.item.appState
      if (!state) return null
      if (state instanceof Uint8Array) return state
      if (typeof state === 'string') {
        const clean = state.startsWith('0x') ? state.slice(2) : state
        if (clean.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(clean)) {
          return fromHex(clean)
        }
      }
      return null
    })

    const appStatePreview = computed(() => {
      const state = props.item.appState
      if (!state) return 'None'
      if (typeof state === 'string') {
        return state.length > 32
          ? `${state.slice(0, 16)}...${state.slice(-8)}`
          : state
      }
      return `${state.length} bytes`
    })

    type DecodedApp =
      | { type: 'dice'; data: DiceGamePayload }
      | { type: 'poker'; data: PokerGamePayload }
      | { type: 'swap'; data: SwapOfferPayload }
      | { type: 'raffle'; data: RafflePayload }
      | { type: 'unknown'; data: Uint8Array | null }

    const decodedApp = computed<DecodedApp | null>(() => {
      const bytes = appStateBytes.value
      if (!bytes) return null
      try {
        const decoded = decodeAppPayload(props.item.appId, bytes)
        if (decoded instanceof Uint8Array) {
          return { type: 'unknown', data: decoded }
        }
        switch (props.item.appId?.toLowerCase()) {
          case 'dice':
          case 'liars-dice':
            return { type: 'dice', data: decoded as DiceGamePayload }
          case 'poker':
            return { type: 'poker', data: decoded as PokerGamePayload }
          case 'swap':
            return { type: 'swap', data: decoded as SwapOfferPayload }
          case 'raffle':
            return { type: 'raffle', data: decoded as RafflePayload }
          default:
            return { type: 'unknown', data: bytes }
        }
      } catch {
        return { type: 'unknown', data: bytes }
      }
    })

    function truncate(str?: string): string {
      if (!str) return ''
      return str.length <= 14 ? str : `${str.slice(0, 6)}...${str.slice(-4)}`
    }

    function truncatePubkey(pk?: string): string {
      if (!pk) return ''
      return pk.length <= 12 ? pk : `${pk.slice(0, 6)}...${pk.slice(-4)}`
    }

    function formatHex(val?: Uint8Array | string): string {
      if (!val) return ''
      return typeof val === 'string' ? val : toHex(val)
    }

    function formatAmount(val?: Uint8Array | bigint | number | string): string {
      if (val === undefined || val === null) return '0'
      if (val instanceof Uint8Array) {
        return toHex(val)
      }
      try {
        const bi = typeof val === 'bigint' ? val : BigInt(val)
        return `${activeChain.toDisplayAmount(bi)} ${activeChain.unit}`
      } catch {
        return String(val)
      }
    }

    function formatBalance(
      balance: string | number | bigint,
      networkTag: string,
    ): string {
      try {
        const val = BigInt(balance)
        if (networkTag.toLowerCase().includes('monad')) {
          return `${activeChain.toDisplayAmount(val)} ${activeChain.unit}`
        }
        return val.toString()
      } catch {
        return String(balance)
      }
    }

    return {
      truncatedChannelId,
      appIcon,
      appTitle,
      appBadgeColor,
      diceActionColor,
      decodedApp,
      appStatePreview,
      truncate,
      truncatePubkey,
      formatHex,
      formatAmount,
      formatBalance,
    }
  },
})
</script>

<style scoped>
.channel-update-message {
  border-radius: 8px;
}
.channel-allocations {
  max-height: 180px;
  overflow-y: auto;
}
</style>
