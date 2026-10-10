<template>
  <div class="poker-game q-pa-sm" style="min-width: 290px; max-width: 440px">
    <!-- Header -->
    <div class="row items-center justify-between q-mb-xs">
      <div class="row items-center">
        <q-icon name="style" size="22px" class="q-mr-xs text-positive" />
        <span class="text-subtitle2 text-weight-bold">Texas Hold'em Poker</span>
      </div>
      <q-badge
        color="positive"
        text-color="white"
        class="text-weight-bold"
        :label="`${item.pot} Chips Pot`"
        data-testid="pot-badge"
      />
    </div>

    <!-- Table Header Info -->
    <div
      class="row items-center justify-between text-caption text-grey-7 q-mb-sm"
    >
      <span
        >Table:
        <span class="text-mono">{{ item.tableId?.slice(0, 8) }}</span></span
      >
      <q-badge
        v-if="item.street"
        color="grey-4"
        text-color="dark"
        :label="formatStreet(item.street)"
      />
    </div>

    <!-- Felt Table Container -->
    <div class="poker-felt q-pa-sm q-mb-sm rounded-borders">
      <!-- Community Board Cards -->
      <div class="text-caption text-weight-bold text-white text-center q-mb-xs">
        Community Board:
      </div>
      <div
        class="row justify-center q-gutter-xs q-mb-sm"
        data-testid="board-cards-container"
      >
        <template v-if="item.boardCards && item.boardCards.length > 0">
          <div
            v-for="card in item.boardCards"
            :key="card"
            class="poker-card"
            :class="isRed(card) ? 'card-red' : 'card-black'"
          >
            {{ formatCard(card) }}
          </div>
        </template>
        <div v-else class="text-caption text-grey-4 text-italic">
          (Waiting for Flop...)
        </div>
      </div>

      <!-- Players at Table Status -->
      <div class="row q-col-gutter-xs">
        <div v-for="p in item.players" :key="p.address" class="col-6">
          <div
            class="player-seat q-pa-xs rounded-borders text-caption"
            :class="{
              'active-turn': isTurn(p.address),
              'folded-seat': p.folded,
            }"
          >
            <div class="row items-center justify-between">
              <span class="ellipsis text-weight-medium" style="max-width: 80px">
                {{ p.isDealerButton ? '🔘 ' : ''
                }}{{ p.address.slice(0, 6) }}...
              </span>
              <span v-if="p.folded" class="text-grey-5">Folded</span>
              <span v-else-if="p.isAllIn" class="text-warning text-weight-bold"
                >ALL-IN</span
              >
              <span v-else class="text-weight-bold text-white">
                🪙 {{ p.chips }}
              </span>
            </div>
            <div
              v-if="p.currentStreetBet > 0"
              class="text-caption text-amber-3 text-right"
            >
              Bet: {{ p.currentStreetBet }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Private Hole Cards View (My Secret Cards) -->
    <div
      v-if="item.myHoleCards && item.myHoleCards.length === 2"
      class="q-pa-xs q-mb-sm bg-grey-2 rounded-borders text-center"
      data-testid="my-hole-cards"
    >
      <div class="text-caption text-weight-bold text-grey-8 q-mb-xs">
        🔒 Your Hole Cards:
      </div>
      <div class="row justify-center q-gutter-sm">
        <div
          v-for="card in item.myHoleCards"
          :key="card"
          class="poker-card"
          :class="isRed(card) ? 'card-red' : 'card-black'"
        >
          {{ formatCard(card) }}
        </div>
      </div>
    </div>

    <!-- Showdown / Winner Announcement -->
    <div
      v-if="
        item.action === 'showdown' || item.action === 'settle' || item.winners
      "
      class="q-pa-xs q-mb-sm bg-positive text-white rounded-borders text-center"
      data-testid="poker-winners-banner"
    >
      <div class="text-subtitle2 text-weight-bold">🏆 HAND SETTLED</div>
      <div v-for="w in item.winners" :key="w.address" class="text-caption">
        <strong>{{ w.address.slice(0, 8) }}...</strong> won
        <strong>{{ w.amount }} chips</strong>!
        <div v-if="w.handDescription" class="text-caption text-grey-2">
          {{ w.handDescription }}
        </div>
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="q-mt-sm">
      <!-- Join Table Button -->
      <q-btn
        v-if="item.action === 'create' || item.street === 'waiting'"
        dense
        no-caps
        color="positive"
        class="full-width q-mb-xs"
        label="♠️ Sit at Table (1000 chips)"
        data-testid="poker-join-btn"
        @click="sendJoin"
      />

      <!-- Start Hand Button -->
      <q-btn
        v-if="
          (item.action === 'create' ||
            item.action === 'join' ||
            item.street === 'waiting' ||
            item.street === 'settled') &&
          canStart
        "
        dense
        no-caps
        color="primary"
        class="full-width q-mb-xs"
        label="Deal Hand"
        data-testid="poker-start-btn"
        @click="sendStart"
      />

      <!-- In-Hand Action Bar (Active Turn) -->
      <template v-if="isMyTurn && isActiveHand">
        <div class="row q-gutter-xs q-mb-xs">
          <!-- Fold Button -->
          <div class="col">
            <q-btn
              dense
              no-caps
              color="negative"
              outline
              class="full-width"
              label="Fold"
              data-testid="poker-fold-btn"
              @click="sendFold"
            />
          </div>

          <!-- Check / Call Button -->
          <div class="col">
            <q-btn
              dense
              no-caps
              color="primary"
              class="full-width"
              :label="callNeeded === 0 ? 'Check' : `Call ${callNeeded}`"
              data-testid="poker-check-call-btn"
              @click="sendCheckCall"
            />
          </div>
        </div>

        <!-- Bet / Raise Controls -->
        <div class="row items-center q-col-gutter-xs q-mb-xs">
          <div class="col-7">
            <div
              class="row items-center justify-between bg-grey-2 q-px-xs rounded-borders"
            >
              <q-btn
                dense
                flat
                icon="remove"
                size="sm"
                :disable="raiseAmount <= minRaiseTotal"
                @click="
                  raiseAmount = Math.max(minRaiseTotal, raiseAmount - bigBlind)
                "
              />
              <span class="text-caption text-weight-bold"
                >{{ raiseAmount }} Chips</span
              >
              <q-btn
                dense
                flat
                icon="add"
                size="sm"
                @click="raiseAmount += bigBlind"
              />
            </div>
          </div>
          <div class="col-5">
            <q-btn
              dense
              no-caps
              color="amber-9"
              text-color="black"
              class="full-width text-weight-bold"
              :label="
                currentBet === 0 ? `Bet ${raiseAmount}` : `Raise ${raiseAmount}`
              "
              data-testid="poker-raise-btn"
              @click="sendRaise"
            />
          </div>
        </div>

        <!-- All-in Button -->
        <q-btn
          dense
          no-caps
          color="warning"
          text-color="black"
          class="full-width text-weight-bold q-mb-xs"
          label="🔥 ALL-IN!"
          data-testid="poker-allin-btn"
          @click="sendAllIn"
        />
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType, ref, computed } from 'vue'
import type { PokerItem, PokerStreet } from '@frank/cashweb/types/messages'
import { formatCard, isRedSuit } from '@frank/wallet/message-item-plugins/poker'

export default defineComponent({
  name: 'ChatMessagePoker',
  props: {
    item: {
      type: Object as PropType<PokerItem>,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
  },
  emits: ['sendFollowUp'],
  setup(props, { emit }) {
    const currentBet = computed(() => props.item.currentBet ?? 0)
    const bigBlind = computed(() => props.item.bigBlind ?? 20)
    const minRaise = computed(() => props.item.minRaise ?? bigBlind.value)
    const minRaiseTotal = computed(() => currentBet.value + minRaise.value)

    const raiseAmount = ref(minRaiseTotal.value)

    const isRed = (card: number): boolean => {
      return isRedSuit(card)
    }

    const formatStreet = (street?: PokerStreet): string => {
      if (!street) return ''
      switch (street) {
        case 'preflop':
          return 'Pre-flop'
        case 'flop':
          return 'Flop'
        case 'turn':
          return 'Turn'
        case 'river':
          return 'River'
        case 'showdown':
          return 'Showdown'
        case 'settled':
          return 'Hand Over'
        default:
          return street
      }
    }

    const isTurn = (playerAddr: string): boolean => {
      return props.item.activePlayer?.toLowerCase() === playerAddr.toLowerCase()
    }

    const isMyTurn = computed(() => {
      return isTurn(props.address)
    })

    const isActiveHand = computed(() => {
      return (
        props.item.street !== 'waiting' &&
        props.item.street !== 'showdown' &&
        props.item.street !== 'settled'
      )
    })

    const canStart = computed(() => {
      return (props.item.players?.length ?? 0) >= 2
    })

    const localPlayer = computed(() => {
      return props.item.players?.find(
        p => p.address.toLowerCase() === props.address.toLowerCase(),
      )
    })

    const callNeeded = computed(() => {
      if (!localPlayer.value) return 0
      return Math.max(0, currentBet.value - localPlayer.value.currentStreetBet)
    })

    const sendJoin = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: '/poker join',
      })
    }

    const sendStart = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: '/poker start',
      })
    }

    const sendFold = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: '/fold',
      })
    }

    const sendCheckCall = () => {
      if (callNeeded.value === 0) {
        emit('sendFollowUp', {
          type: 'text',
          text: '/check',
        })
      } else {
        emit('sendFollowUp', {
          type: 'text',
          text: '/call',
        })
      }
    }

    const sendRaise = () => {
      if (currentBet.value === 0) {
        emit('sendFollowUp', {
          type: 'text',
          text: `/bet ${raiseAmount.value}`,
        })
      } else {
        emit('sendFollowUp', {
          type: 'text',
          text: `/raise ${raiseAmount.value}`,
        })
      }
    }

    const sendAllIn = () => {
      emit('sendFollowUp', {
        type: 'text',
        text: '/allin',
      })
    }

    return {
      currentBet,
      bigBlind,
      minRaiseTotal,
      raiseAmount,
      isRed,
      formatCard,
      formatStreet,
      isTurn,
      isMyTurn,
      isActiveHand,
      canStart,
      callNeeded,
      sendJoin,
      sendStart,
      sendFold,
      sendCheckCall,
      sendRaise,
      sendAllIn,
    }
  },
})
</script>

<style scoped>
.poker-felt {
  background: radial-gradient(circle, #1b5e20 0%, #0d3810 100%);
  border: 2px solid #2e7d32;
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.5);
}

.player-seat {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.active-turn {
  border: 1px solid #ffd54f !important;
  background: rgba(255, 213, 79, 0.2) !important;
}

.folded-seat {
  opacity: 0.5;
}

.poker-card {
  width: 32px;
  height: 44px;
  background: #ffffff;
  border-radius: 4px;
  border: 1px solid #dcdcdc;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 14px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.card-red {
  color: #d32f2f;
}

.card-black {
  color: #111111;
}
</style>
