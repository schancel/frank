<template>
  <q-card-section
    data-testid="blackjack-challenge-form"
    style="min-width: 280px"
  >
    <div class="text-subtitle2">{{ $t('blackjackP2p.challengeTitle') }}</div>
    <q-option-group
      v-model="role"
      dense
      :options="[
        { label: $t('blackjackP2p.roleDealer'), value: 'dealer' },
        { label: $t('blackjackP2p.rolePlayer'), value: 'player' },
      ]"
    />
    <q-input
      v-model="maxBet"
      dense
      data-testid="blackjack-challenge-max"
      :label="$t('blackjackP2p.maxBet')"
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
    <q-btn
      class="q-mt-sm"
      dense
      color="primary"
      data-testid="blackjack-challenge-send"
      :label="$t('blackjackP2p.sendChallenge')"
      :disable="!!error || busy"
      @click="submit"
    />
  </q-card-section>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import {
  challengeLimitWei,
  type HandRole,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import { useBalance } from '../../composables/useBalance'
import { HAND_FEE_RESERVE_WEI } from '../../utils/blackjack-hand'

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
  emits: ['submit'],
  setup() {
    const { balance } = useBalance()
    return { balance }
  },
  data() {
    return { role: 'dealer' as HandRole, maxBet: '' }
  },
  computed: {
    unit(): string {
      return activeChain.unit
    },
    limitWei(): bigint | null {
      return this.balance === null
        ? null
        : challengeLimitWei(this.role, this.balance, HAND_FEE_RESERVE_WEI)
    },
    limitDisplay(): string {
      return this.limitWei === null
        ? '…'
        : `${activeChain.toDisplayAmount(this.limitWei)} ${activeChain.unit}`
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
      if (this.maxBetWei < activeChain.defaultStampValue)
        return this.$t('blackjackP2p.belowStamp', {
          amount: `${activeChain.toDisplayAmount(
            activeChain.defaultStampValue,
          )} ${activeChain.unit}`,
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
      if (this.error || this.maxBetWei === null) return
      this.$emit('submit', { role: this.role, maxBetWei: this.maxBetWei })
    },
  },
})
</script>
