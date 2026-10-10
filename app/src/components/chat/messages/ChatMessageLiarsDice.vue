<template>
  <div
    class="liars-dice-game q-pa-sm"
    style="min-width: 280px; max-width: 420px"
  >
    <!-- Header -->
    <div class="row items-center justify-between q-mb-xs">
      <div class="row items-center">
        <q-icon name="casino" size="22px" class="q-mr-xs text-amber-9" />
        <span class="text-subtitle2 text-weight-bold"
          >Liar's Dice (Perudo)</span
        >
      </div>
      <q-badge
        v-if="item.potWei"
        color="amber-9"
        text-color="black"
        class="text-weight-bold"
        :label="`${displayMon(item.potWei)} Pot`"
      />
    </div>

    <!-- Table info -->
    <div
      class="row items-center justify-between text-caption text-grey-7 q-mb-sm"
    >
      <span
        >Table:
        <span class="text-mono">{{ item.tableId?.slice(0, 8) }}</span></span
      >
      <span v-if="item.roundNumber">Round {{ item.roundNumber }}</span>
    </div>

    <!-- Public Table View: Players & Dice Counts -->
    <div class="q-mb-sm bg-grey-2 q-pa-xs rounded-borders">
      <div class="text-caption text-weight-medium q-mb-xs">
        Players at Table:
      </div>
      <div class="row q-col-gutter-xs">
        <div v-for="(player, idx) in item.players" :key="player" class="col-6">
          <div
            class="q-pa-xs rounded-borders text-caption"
            :class="{
              'bg-amber-1 text-weight-bold border-active': isTurn(player),
              'text-grey-5': isEliminated(idx),
            }"
          >
            <div class="row items-center justify-between">
              <span class="ellipsis" style="max-width: 80px"
                >{{ player.slice(0, 6) }}...</span
              >
              <span
                v-if="isEliminated(idx)"
                class="text-negative text-weight-bold"
                >☠️ Out</span
              >
              <span v-else class="text-weight-bold text-amber-9">
                🎲 {{ getDiceCount(idx) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Current Bid Banner -->
    <div
      v-if="item.currentBid"
      class="q-pa-xs q-mb-sm bg-amber-2 rounded-borders text-center"
      data-testid="current-bid-banner"
    >
      <div class="text-caption text-grey-8">Current Bid:</div>
      <div class="text-subtitle1 text-weight-bolder text-dark">
        {{ item.currentBid.quantity }}x
        <span class="dice-badge">{{ diceUnicode(item.currentBid.face) }}</span>
        ({{ item.currentBid.face }}s{{
          item.currentBid.face === 1 ? ' - Aces Wild!' : ''
        }})
      </div>
      <div class="text-caption text-grey-7">
        by {{ item.currentBid.bidder.slice(0, 8) }}...
      </div>
    </div>

    <!-- Private Cup View (My Secret Dice) -->
    <div
      v-if="item.myDice && item.myDice.length > 0"
      class="q-pa-xs q-mb-sm bg-grey-3 rounded-borders text-center"
      data-testid="my-dice-cup"
    >
      <div class="text-caption text-weight-bold text-grey-8 q-mb-xs">
        🤫 Your Secret Cup:
      </div>
      <div class="row justify-center q-gutter-xs">
        <span
          v-for="(die, idx) in item.myDice"
          :key="idx"
          class="dice-symbol"
          :class="{ 'text-amber-9': die === 1 }"
        >
          {{ diceUnicode(die) }}
        </span>
      </div>
    </div>

    <!-- Showdown View (All Cups Revealed) -->
    <div
      v-if="item.action === 'showdown' && item.challengeResult"
      class="q-pa-xs q-mb-sm bg-red-1 rounded-borders"
      data-testid="showdown-results"
    >
      <div
        class="text-subtitle2 text-weight-bold text-negative text-center q-mb-xs"
      >
        🚨 SHOWDOWN RESULT!
      </div>
      <div class="text-caption q-mb-xs text-center">
        Challenge on
        <strong
          >{{ item.challengeResult.bidQuantity }}x [{{
            item.challengeResult.bidFace
          }}]s</strong
        >
      </div>
      <div class="text-caption text-center q-mb-xs">
        Total Matching: <strong>{{ item.challengeResult.actualCount }}</strong>
        <span v-if="item.challengeResult.bidFace !== 1" class="text-grey-7">
          ({{ item.challengeResult.wildAcesCount }} wild Aces)
        </span>
      </div>
      <div
        class="text-caption text-weight-bold text-center q-mb-xs"
        :class="
          item.challengeResult.challengerWon ? 'text-positive' : 'text-negative'
        "
      >
        {{
          item.challengeResult.challengerWon
            ? '🎉 Challenger was Right!'
            : '❌ Bidder was Truthful!'
        }}
      </div>
      <div class="text-caption text-center text-negative">
        💀 {{ item.challengeResult.loserAddress.slice(0, 8) }}... loses 1 die!
        <span v-if="item.challengeResult.eliminated" class="text-weight-bold">
          (ELIMINATED ☠️)
        </span>
      </div>

      <!-- Revealed Cups -->
      <div v-if="item.revealedCups" class="q-mt-xs">
        <div class="text-caption text-grey-7">All Revealed Dice:</div>
        <div
          v-for="(dice, playerAddr) in item.revealedCups"
          :key="playerAddr"
          class="row items-center justify-between text-caption text-mono"
        >
          <span>{{ playerAddr.slice(0, 6) }}:</span>
          <span>
            <span
              v-for="(d, i) in dice"
              :key="i"
              class="q-mx-xs text-body2"
              :class="{
                'text-amber-9 text-weight-bold':
                  d === item.challengeResult.bidFace ||
                  (item.challengeResult.bidFace !== 1 && d === 1),
              }"
            >
              {{ diceUnicode(d) }}
            </span>
          </span>
        </div>
      </div>
    </div>

    <!-- Winner Announcement -->
    <div
      v-if="item.winnerAddress"
      class="q-pa-xs q-mb-sm bg-positive text-white rounded-borders text-center"
      data-testid="winner-banner"
    >
      <div class="text-subtitle1 text-weight-bold">🏆 VICTORY!</div>
      <div class="text-caption">
        {{ item.winnerAddress.slice(0, 8) }}... won the table!
      </div>
      <div v-if="item.potWei" class="text-caption text-weight-bold">
        Pot: {{ displayMon(item.potWei) }}
      </div>
    </div>

    <!-- Interactive Actions -->
    <div class="q-mt-sm">
      <!-- Join Table Action -->
      <q-btn
        v-if="item.action === 'create' || item.action === 'join'"
        dense
        no-caps
        color="primary"
        class="full-width q-mb-xs"
        label="🎲 Join Table"
        data-testid="join-table-btn"
        @click="sendJoin"
      />

      <!-- Bidding Controls -->
      <template v-if="item.action === 'round_start' || item.action === 'bid'">
        <div class="row items-center justify-between q-mb-xs">
          <div class="text-caption text-weight-medium">Make a Raise:</div>
          <!-- Red Call Liar Button -->
          <q-btn
            v-if="item.currentBid"
            dense
            no-caps
            color="negative"
            label="🚨 Call Liar!"
            data-testid="call-liar-btn"
            @click="sendCallLiar"
          />
        </div>

        <div class="row items-center q-col-gutter-xs q-mb-xs">
          <!-- Quantity Stepper -->
          <div class="col-5">
            <div
              class="row items-center justify-center bg-grey-2 rounded-borders"
            >
              <q-btn
                dense
                flat
                icon="remove"
                size="sm"
                :disable="bidQuantity <= 1"
                @click="bidQuantity = Math.max(1, bidQuantity - 1)"
              />
              <span class="q-px-sm text-weight-bold">{{ bidQuantity }}x</span>
              <q-btn dense flat icon="add" size="sm" @click="bidQuantity++" />
            </div>
          </div>

          <!-- Face Selector -->
          <div class="col-7">
            <div class="row justify-between">
              <q-btn
                v-for="face in [2, 3, 4, 5, 6, 1]"
                :key="face"
                dense
                no-caps
                size="sm"
                :color="bidFace === face ? 'amber-9' : 'grey-4'"
                :text-color="bidFace === face ? 'black' : 'dark'"
                class="q-px-xs text-weight-bold"
                :label="face === 1 ? '★1' : `${face}`"
                @click="bidFace = face"
              />
            </div>
          </div>
        </div>

        <!-- Submit Bid Button -->
        <q-btn
          dense
          no-caps
          color="amber-9"
          text-color="black"
          class="full-width text-weight-bold"
          :label="`Bid ${bidQuantity}x [${bidFace === 1 ? 'Aces' : bidFace}]`"
          data-testid="submit-bid-btn"
          @click="sendBid"
        />
      </template>

      <!-- Next Round Button at Showdown -->
      <q-btn
        v-if="item.action === 'showdown' && !item.winnerAddress"
        dense
        no-caps
        color="primary"
        class="full-width q-mt-xs"
        label="🎲 Start Next Round"
        data-testid="next-round-btn"
        @click="sendStartRound"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType, ref } from 'vue'
import type { LiarsDiceItem } from '@frank/cashweb/types/messages'
import { formatMon } from '@frank/wallet/monad-amount'

const DICE_UNICODE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅']

export default defineComponent({
  name: 'ChatMessageLiarsDice',
  props: {
    item: {
      type: Object as PropType<LiarsDiceItem>,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
  },
  emits: ['sendFollowUp'],
  setup(props, { emit }) {
    const bidQuantity = ref(
      props.item.currentBid ? props.item.currentBid.quantity + 1 : 2,
    )
    const bidFace = ref(props.item.currentBid ? props.item.currentBid.face : 2)

    const diceUnicode = (face: number): string => {
      return DICE_UNICODE[face] ?? `${face}`
    }

    const displayMon = (weiStr?: string): string => {
      if (!weiStr) return '0'
      try {
        return formatMon(BigInt(weiStr))
      } catch {
        return weiStr
      }
    }

    const isTurn = (playerAddr: string): boolean => {
      return props.item.activePlayer?.toLowerCase() === playerAddr.toLowerCase()
    }

    const isEliminated = (idx: number): boolean => {
      return (props.item.diceCounts?.[idx] ?? 0) <= 0
    }

    const getDiceCount = (idx: number): number => {
      return props.item.diceCounts?.[idx] ?? props.item.dicePerPlayer ?? 5
    }

    const sendJoin = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: '/table join',
      })
    }

    const sendStartRound = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: '/start',
      })
    }

    const sendBid = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: `/bid ${bidQuantity.value} ${bidFace.value}`,
      })
    }

    const sendCallLiar = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: '/liar',
      })
    }

    return {
      bidQuantity,
      bidFace,
      diceUnicode,
      displayMon,
      isTurn,
      isEliminated,
      getDiceCount,
      sendJoin,
      sendStartRound,
      sendBid,
      sendCallLiar,
    }
  },
})
</script>

<style scoped>
.dice-symbol {
  font-size: 26px;
  line-height: 1;
}

.dice-badge {
  font-size: 20px;
  vertical-align: middle;
}

.border-active {
  border: 1px solid #f59e0b;
}
</style>
