<template>
  <q-card
    class="q-px-sm q-pb-md dialog-medium"
    data-testid="send-stealth-dialog"
  >
    <q-card-section>
      <div class="text-h6">
        {{
          $t('sendStealthDialog.sendStealthTo') +
          ' ' +
          (contact?.name || address)
        }}
      </div>
      <div class="text-caption text-grey-7">
        {{ $t('sendStealthDialog.subtitle') }}
      </div>
    </q-card-section>

    <!-- Spendable Balance Row -->
    <q-card-section class="q-pt-none q-pb-xs">
      <div
        class="row items-center justify-between text-caption text-grey-7"
        data-testid="wallet-balance-row"
      >
        <span>{{ $t('sendStealthDialog.balanceLabel') }}</span>
        <span class="text-bold" data-testid="wallet-balance-value">
          {{ currentWalletBalanceDisplay }}
        </span>
      </div>
    </q-card-section>

    <!-- Amount Input -->
    <q-card-section>
      <q-input
        class="text-bold text-h6"
        v-model="amount"
        type="number"
        filled
        dense
        :suffix="currentUnit"
        :hint="$t('sendStealthDialog.amountHint')"
        :placeholder="$t('sendStealthDialog.amountPlaceholder')"
        data-testid="stealth-amount-input"
        ref="amountInput"
      />
    </q-card-section>

    <!-- Memo Input -->
    <q-card-section>
      <q-input
        v-model="memo"
        filled
        dense
        :hint="$t('sendStealthDialog.memoHint')"
        :placeholder="$t('sendStealthDialog.memoPlaceholder')"
        data-testid="stealth-memo-input"
      />
    </q-card-section>

    <q-card-actions align="right">
      <q-btn
        flat
        :label="$t('sendStealthDialog.cancelBtnLabel')"
        color="primary"
        v-close-popup
      />
      <q-btn
        flat
        :disable="!canSend || busy"
        :label="$t('sendStealthDialog.sendBtnLabel')"
        color="primary"
        data-testid="stealth-send-confirm-btn"
        v-close-popup
        @click="sendStealth"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { useBalance } from '../../composables/useBalance'

/**
 * Asks for the amount and memo of a payment to this contact, on the wallet's own chain: the one
 * chain a payment to a contact works on. It sends nothing itself; the page pays through the
 * wallet's `sendToContact`.
 */
export default defineComponent({
  name: 'SendStealthDialog',
  props: {
    address: {
      type: String,
      default: '',
    },
    contact: {
      type: Object,
      default: () => ({ name: 'Unknown' }),
    },
    busy: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['send'],
  setup() {
    const { formattedBalance, loaded: balanceLoaded } = useBalance()
    return {
      formattedBalance,
      balanceLoaded,
    }
  },
  data() {
    return {
      amount: '',
      memo: '',
    }
  },
  computed: {
    currentUnit(): string {
      return activeChain.unit
    },
    /** The wallet's real balance, or nothing while it is not known. Never a placeholder figure. */
    currentWalletBalanceDisplay(): string {
      return this.balanceLoaded ? this.formattedBalance : '…'
    },
    /** The amount in the chain's base unit, or undefined when it is not a positive amount. */
    value(): bigint | undefined {
      const text = String(this.amount ?? '').trim()
      if (text === '' || !(Number(text) > 0)) return undefined
      try {
        const value = activeChain.fromDisplayAmount(text)
        return value > 0n ? value : undefined
      } catch {
        return undefined
      }
    },
    canSend(): boolean {
      return this.value !== undefined
    },
  },
  methods: {
    sendStealth() {
      if (this.value === undefined) return
      this.$emit('send', {
        address: this.address,
        value: this.value,
        memo: this.memo.trim(),
      })
    },
  },
  mounted() {
    const input = this.$refs.amountInput as { focus?: () => void } | undefined
    input?.focus?.()
  },
})
</script>
