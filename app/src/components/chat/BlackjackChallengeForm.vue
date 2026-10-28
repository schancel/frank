<template>
  <q-card-section
    data-testid="blackjack-challenge-form"
    style="min-width: 280px"
  >
    <div class="text-subtitle2">{{ $t('blackjackP2p.challengeTitle') }}</div>
    <q-option-group
      v-model="role"
      :disable="busy"
      dense
      :options="[
        { label: $t('blackjackP2p.roleDealer'), value: 'dealer' },
        { label: $t('blackjackP2p.rolePlayer'), value: 'player' },
      ]"
    />
    <q-input
      v-model="maxBet"
      :disable="busy"
      dense
      data-testid="blackjack-challenge-max"
      :label="$t('blackjackP2p.challengeBetLimit')"
      :suffix="unit"
      inputmode="decimal"
    />
    <div class="text-caption" data-testid="blackjack-challenge-limit">
      {{
        role === 'dealer'
          ? $t('blackjackP2p.limitDealer', { amount: limitDisplay })
          : $t('blackjackP2p.limitPlayer', { amount: limitDisplay })
      }}
    </div>
    <div
      v-if="error"
      role="status"
      class="text-caption text-negative"
      data-testid="blackjack-challenge-error"
    >
      {{ error }}
    </div>
    <div class="text-caption q-mt-xs" data-testid="blackjack-challenge-review">
      {{
        $t(
          role === 'dealer'
            ? 'blackjackP2p.challengeDealerReview'
            : 'blackjackP2p.challengeBeforeBet',
        )
      }}
    </div>
    <div
      v-if="busy"
      role="status"
      class="text-caption q-mt-xs"
      data-testid="blackjack-challenge-pending"
    >
      {{ $t('blackjackP2p.preparingChallenge') }}
    </div>
    <q-btn
      no-caps
      class="q-mt-sm"
      dense
      color="primary"
      data-testid="blackjack-challenge-send"
      :label="$t('blackjackP2p.sendChallenge')"
      :disable="!!error || busy"
      :loading="busy"
      @click="submit"
    />
    <q-btn
      flat
      no-caps
      dense
      class="q-mt-sm q-ml-sm"
      data-testid="blackjack-challenge-cancel"
      :label="$t('blackjackP2p.cancel')"
      @click="$emit('cancel')"
    />
  </q-card-section>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { formatDisplayAmount } from '../../utils/chain-amount'
import {
  challengeLimitWei,
  type HandRole,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import { useBalance } from '../../composables/useBalance'
import { HAND_FEE_RESERVE_WEI } from '../../utils/blackjack-hand'
import { stakeMinimumWei } from '@frank/wallet/message-item-plugins/shared/stake-minimum'
import { PAYMENT_FLOOR_INJECTION } from '../../utils/game-stakes'

/**
 * The challenge form opened from the composer's message-type menu, in any chat with any contact.
 * The challenger picks a role and a max bet. The max bet is limited by what this wallet can
 * actually spend: a dealer must cover the worst case from its own balance, a player its own bet.
 */
export default defineComponent({
  name: 'BlackjackChallengeForm',
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ['submit', 'cancel'],
  inject: {
    /** The wallet's payment floor for this chain (`PAYMENT_FLOOR_INJECTION`), zero if unknown. */
    paymentFloorWei: {
      from: PAYMENT_FLOOR_INJECTION,
      default: () => (): bigint => 0n,
    },
  },
  setup() {
    const { available, availableLoaded, availableError, availableSupported } =
      useBalance()
    return { available, availableLoaded, availableError, availableSupported }
  },
  data() {
    // The player role first: it is the one the hosted dealer bot can answer.
    return { role: 'player' as HandRole, maxBet: '' }
  },
  computed: {
    /** The smallest bet: twice the payment floor (`stakeMinimumWei`, the rule every game
     * shares; the dealer bot applies the same rule and returns a smaller bet undealt). */
    minimumStake(): bigint {
      return stakeMinimumWei(
        (this.paymentFloorWei as unknown as () => bigint)(),
      )
    },
    unit(): string {
      return activeChain.unit
    },
    limitWei(): bigint | null {
      return !this.availableSupported ||
        !this.availableLoaded ||
        this.availableError ||
        this.available === null
        ? null
        : challengeLimitWei(this.role, this.available, HAND_FEE_RESERVE_WEI)
    },
    limitDisplay(): string {
      return this.limitWei === null
        ? '…'
        : formatDisplayAmount(activeChain, this.limitWei)
    },
    maxBetWei(): bigint | null {
      try {
        return activeChain.fromDisplayAmount(this.maxBet)
      } catch {
        return null
      }
    },
    error(): string {
      if (this.limitWei === null) return this.$t('blackjackP2p.balanceUnknown')
      if (this.maxBet.trim() === '') return this.$t('blackjackP2p.enterAmount')
      if (this.maxBetWei === null || this.maxBetWei <= 0n)
        return this.$t('blackjackP2p.enterAmount')
      if (this.maxBetWei < this.minimumStake)
        return this.$t('blackjackP2p.belowMinimumBet', {
          amount: formatDisplayAmount(activeChain, this.minimumStake),
        })
      if (this.maxBetWei > this.limitWei)
        return this.$t('blackjackP2p.aboveOwnLimit', {
          amount: this.limitDisplay,
        })
      return ''
    },
  },
  methods: {
    submit() {
      if (this.busy || this.error || this.maxBetWei === null) return
      this.$emit('submit', { role: this.role, maxBetWei: this.maxBetWei })
    },
  },
})
</script>
