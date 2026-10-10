<template>
  <div class="bj-row" data-testid="blackjack-row">
    <!-- The sentence is what assistive technology reads; the chips are its picture. -->
    <span class="q-sr-only">{{ sentence }}</span>
    <span class="bj-row__label" aria-hidden="true">{{ label }}</span>
    <span class="bj-row__cards" aria-hidden="true">
      <span
        v-for="(card, index) in faces"
        :key="index"
        class="bj-card"
        :class="{ 'bj-card--red': card.red }"
        data-testid="blackjack-card"
      >
        <span class="bj-card__rank">{{ card.rank }}</span>
        <span class="bj-card__suit">{{ card.suit }}</span>
      </span>
      <span
        v-for="n in hidden"
        :key="`hidden-${n}`"
        class="bj-card bj-card--back"
        data-testid="blackjack-card-back"
      />
    </span>
    <span
      v-if="total !== undefined"
      class="bj-row__total"
      aria-hidden="true"
      :data-testid="totalTestid || undefined"
      >{{ total }}</span
    >
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { cardLabel } from '@frank/wallet/message-item-plugins/blackjack/deck'

/** One row of a blackjack hand: whose cards, the cards as chips, and their total. Display only;
 * the cards and the total are computed by the hand's state machine and passed in. */
export default defineComponent({
  name: 'BlackjackCards',
  props: {
    /** Whose cards these are ("Player", "Dealer"). */
    label: { type: String, required: true },
    cards: { type: Array as PropType<number[]>, required: true },
    /** The hand's value; omitted while it is not known (a dealer showing one card). */
    total: { type: Number, default: undefined },
    /** Face-down cards drawn after the known ones. */
    hidden: { type: Number, default: 0 },
    /** The row as one sentence ("Player: 4♠ 7♠ (11)"), for screen readers. */
    sentence: { type: String, required: true },
    totalTestid: { type: String, default: '' },
  },
  computed: {
    faces(): { rank: string; suit: string; red: boolean }[] {
      return this.cards.map(card => {
        const text = cardLabel(card)
        const suit = text.slice(-1)
        return {
          rank: text.slice(0, -1),
          suit,
          red: suit === '♥' || suit === '♦',
        }
      })
    },
  },
})
</script>

<style scoped>
.bj-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.bj-row__label {
  flex: 0 0 auto;
  min-width: 3.6em;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0.8;
}

.bj-row__cards {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

/* A playing card is white with black or red pips whatever the bubble or the colour mode. */
.bj-card {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 30px;
  height: 42px;
  border: 1px solid rgba(0, 0, 0, 0.25);
  border-radius: 5px;
  background: #ffffff;
  color: #1c1c1c;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.bj-card--red {
  color: #c62828;
}

.bj-card__rank {
  font-size: 0.9rem;
  font-weight: 700;
}

.bj-card__suit {
  margin-top: 2px;
  font-size: 0.95rem;
}

.bj-card--back {
  border-color: rgba(255, 255, 255, 0.85);
  background: repeating-linear-gradient(
    45deg,
    #8e2a12,
    #8e2a12 4px,
    #b23a1c 4px,
    #b23a1c 8px
  );
}

.bj-row__total {
  flex: 0 0 auto;
  min-width: 1.9em;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.22);
  font-size: 0.8rem;
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
