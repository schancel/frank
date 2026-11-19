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
      <!-- Buy-in: lock, join, refund after the deadline (newest card of the table only) -->
      <table-buy-in-panel
        v-if="item.escrow && isNewest"
        game="poker"
        :table-id="item.tableId"
        :buy-in-wei="item.buyInWei"
        :escrow="item.escrow"
        :joinable="joinable"
        :seated="!!localPlayer"
        :join-item="joinItem"
        @sendFollowUp="$emit('sendFollowUp', $event)"
      />

      <!-- Start Hand Button -->
      <q-btn
        v-if="
          (item.action === 'create' ||
            item.action === 'join' ||
            streetIs(item.street, 'waiting') ||
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
import type {
  PokerItem,
  PokerStreet,
  TableBuyInLockItem,
} from '@frank/cashweb/types/messages'
import { formatCard, isRedSuit } from '@frank/wallet/message-item-plugins/poker'
import { chatGameItems } from '../../../utils/chat-game-items'
import { useReactiveOwnCanonicalAddress } from '../../../utils/own-address'
import TableBuyInPanel from './TableBuyInPanel.vue'

export default defineComponent({
  name: 'ChatMessagePoker',
  components: { TableBuyInPanel },
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
    // `address` is the conversation's peer (the bot); the seats name identities.
    const ownAddress = useReactiveOwnCanonicalAddress()
    const sameAddress = (a?: string | null, b?: string | null) =>
      !!a && !!b && a.toLowerCase() === b.toLowerCase()
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

    const isMyTurn = computed(() =>
      sameAddress(props.item.activePlayer, ownAddress.value),
    )

    // 'waiting' is not a street the hand type names. A table that has not dealt
    // still arrives with that value, so the comparison stays on the string.
    const streetIs = (street: string | undefined, value: string): boolean =>
      street === value

    const isActiveHand = computed(() => {
      return (
        !streetIs(props.item.street, 'waiting') &&
        props.item.street !== 'showdown' &&
        props.item.street !== 'settled'
      )
    })

    const canStart = computed(() => {
      return (props.item.players?.length ?? 0) >= 2
    })

    const localPlayer = computed(() =>
      props.item.players?.find(p => sameAddress(p.address, ownAddress.value)),
    )

    /** This card is the newest the bot sent for its table: only it offers the buy-in. */
    const isNewest = computed(() => {
      const ofTable = chatGameItems('poker', props.address).filter(
        entry => !entry.outbound && entry.item.tableId === props.item.tableId,
      )
      const newest = ofTable[ofTable.length - 1]
      return !newest || newest.item === props.item
    })

    /** The table takes players: no hand dealt yet. */
    const joinable = computed(
      () =>
        (props.item.action === 'create' || props.item.action === 'join') &&
        !props.item.street,
    )

    const joinItem = (buyInLock: TableBuyInLockItem): PokerItem => ({
      type: 'poker',
      tableId: props.item.tableId,
      action: 'join',
      smallBlind: props.item.smallBlind,
      bigBlind: props.item.bigBlind,
      pot: 0,
      buyInLock,
    })

    const callNeeded = computed(() => {
      if (!localPlayer.value) return 0
      return Math.max(0, currentBet.value - localPlayer.value.currentStreetBet)
    })

    /** A command to the bot: a text item, paying nothing. */
    const sendText = (text: string) => {
      emit('sendFollowUp', {
        items: [{ type: 'text', text }],
        stampValueWei: 0n,
      })
    }

    const sendStart = () => {
      sendText('/poker start')
    }

    const sendFold = () => {
      sendText('/fold')
    }

    const sendCheckCall = () => {
      if (callNeeded.value === 0) {
        sendText('/check')
      } else {
        sendText('/call')
      }
    }

    const sendRaise = () => {
      if (currentBet.value === 0) {
        sendText(`/bet ${raiseAmount.value}`)
      } else {
        sendText(`/raise ${raiseAmount.value}`)
      }
    }

    const sendAllIn = () => {
      sendText('/allin')
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
      streetIs,
      canStart,
      callNeeded,
      localPlayer,
      isNewest,
      joinable,
      joinItem,
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
