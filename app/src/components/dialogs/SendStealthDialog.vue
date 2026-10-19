<template>
  <q-card
    class="q-px-sm q-pb-md dialog-medium"
    data-testid="send-stealth-dialog"
  >
    <q-form @submit.prevent="sendStealth">
      <q-card-section>
        <div class="text-h6">
          {{
            $t('sendStealthDialog.sendStealthTo') +
            ' ' +
            (contact?.profile?.name || contact?.name || address)
          }}
        </div>
        <div class="text-caption text-grey-7">
          {{ $t('sendStealthDialog.subtitle') }}
        </div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        <q-select
          v-model="selectedKey"
          :options="selectOptions"
          emit-value
          map-options
          filled
          dense
          :disable="busy"
          :label="$t('sendStealthDialog.assetLabel')"
          data-testid="stealth-asset-select"
        />
      </q-card-section>
      <q-card-section class="q-pt-none q-pb-xs">
        <div
          class="row items-center justify-between text-caption text-grey-7"
          data-testid="wallet-balance-row"
        >
          <span>{{ $t('sendStealthDialog.balanceLabel') }}</span>
          <span class="text-bold" data-testid="wallet-balance-value">{{
            currentWalletBalanceDisplay
          }}</span>
        </div>
      </q-card-section>
      <q-card-section>
        <q-input
          v-model="amount"
          class="text-bold text-h6"
          type="text"
          inputmode="decimal"
          filled
          dense
          :disable="busy"
          :suffix="selectedOption?.unit"
          :hint="$t('sendStealthDialog.amountHint')"
          :placeholder="$t('sendStealthDialog.amountPlaceholder')"
          :error="amountExceedsBalance"
          :error-message="amountErrorMessage"
          data-testid="stealth-amount-input"
          ref="amountInput"
        />
      </q-card-section>
      <q-card-section>
        <q-input
          v-model="memo"
          filled
          dense
          :disable="busy"
          :hint="$t('sendStealthDialog.memoHint')"
          :placeholder="$t('sendStealthDialog.memoPlaceholder')"
          data-testid="stealth-memo-input"
        />
      </q-card-section>
      <q-card-section
        v-if="quote.status === 'error'"
        role="alert"
        class="text-negative text-caption q-pt-none"
        data-testid="stealth-quote-error"
        >{{ quote.message }}</q-card-section
      >
      <q-card-actions align="right">
        <q-btn
          flat
          :label="$t('sendStealthDialog.cancelBtnLabel')"
          color="primary"
          v-close-popup
          @click="$emit('cancel')"
        />
        <q-btn
          flat
          :disable="!canSend || busy"
          :loading="busy"
          :label="$t('sendStealthDialog.sendBtnLabel')"
          color="primary"
          data-testid="stealth-send-confirm-btn"
          type="submit"
        />
      </q-card-actions>
    </q-form>
  </q-card>
</template>
<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { useBalance } from '../../composables/useBalance'
import {
  formatStealthAmount,
  parseStealthAmount,
  stealthAssetKey,
  type StealthAssetOption,
  type StealthDialogRequest,
  type StealthDialogQuoteState,
  type ReviewedStealthDialogIntent,
} from '../../stealth-payments/options'

/** Direct stealth payment composer: select asset, enter amount and optional memo, and send in one step. */
export default defineComponent({
  name: 'SendStealthDialog',
  props: {
    address: { type: String, default: '' },
    contact: { type: Object, default: () => ({}) },
    busy: { type: Boolean, default: false },
    options: {
      type: Array as PropType<readonly StealthAssetOption[]>,
      default: () => [],
    },
    quote: {
      type: Object as PropType<StealthDialogQuoteState>,
      default: () => ({ status: 'idle' }),
    },
  },
  emits: {
    cancel: () => true,
    review: (request: StealthDialogRequest) => request.amountAtomic > 0n,
    send: (intent: StealthDialogRequest | ReviewedStealthDialogIntent) =>
      intent.amountAtomic > 0n,
  },
  setup() {
    const { balance: activeBalance, loaded: balanceLoaded } = useBalance()
    return {
      activeBalance,
      balanceLoaded,
    }
  },
  data() {
    return {
      selectedKey: this.options[0]?.key ?? '',
      amount: '',
      memo: '',
    }
  },
  computed: {
    selectOptions() {
      return this.options.map(option => ({
        label: option.label,
        value: option.key,
      }))
    },
    selectedOption(): StealthAssetOption | undefined {
      return this.options.find(
        option =>
          option.key === this.selectedKey &&
          option.key === stealthAssetKey(option.chainIdentifier, option.asset),
      )
    },
    value(): bigint | undefined {
      return (
        this.selectedOption &&
        parseStealthAmount(this.amount, this.selectedOption.decimals)
      )
    },
    request(): StealthDialogRequest | undefined {
      const option = this.selectedOption,
        value = this.value
      if (!option || value === undefined) return undefined
      return {
        address: this.address,
        assetKey: option.key,
        chainIdentifier: option.chainIdentifier,
        asset: { ...option.asset },
        amountAtomic: value,
        memo: this.memo.trim(),
      }
    },
    canSend(): boolean {
      const request = this.request,
        balance = this.availableBalanceAtomic
      return (
        !!request && (balance === undefined || request.amountAtomic <= balance)
      )
    },
    availableBalanceAtomic(): bigint | undefined {
      const option = this.selectedOption
      if (!option) return undefined
      if (option.balanceAtomic !== undefined) {
        return option.balanceAtomic
      }
      if (
        option.chainIdentifier === activeChain.chainIdentifier &&
        option.asset.kind === 'native' &&
        this.balanceLoaded &&
        this.activeBalance !== null
      ) {
        return this.activeBalance
      }
      return undefined
    },
    currentWalletBalanceDisplay(): string {
      const option = this.selectedOption
      if (!option) return '…'
      const balance = this.availableBalanceAtomic
      return balance === undefined
        ? '…'
        : `${formatStealthAmount(balance, option.decimals)} ${option.unit}`
    },
    amountExceedsBalance(): boolean {
      const value = this.value
      const balance = this.availableBalanceAtomic
      if (value === undefined || balance === undefined) return false
      return value > balance
    },
    amountErrorMessage(): string {
      if (this.amountExceedsBalance) {
        return this.$t('sendStealthDialog.insufficientBalance')
      }
      return ''
    },
  },
  watch: {
    selectedKey() {
      this.amount = ''
    },
    options() {
      if (!this.options.some(option => option.key === this.selectedKey))
        this.selectedKey = this.options[0]?.key ?? ''
    },
  },
  methods: {
    format: formatStealthAmount,
    sendStealth() {
      if (this.busy || !this.canSend || !this.request) return
      this.$emit('send', {
        ...this.request,
        asset: { ...this.request.asset },
      })
    },
  },
  mounted() {
    ;(this.$refs.amountInput as { focus?: () => void } | undefined)?.focus?.()
  },
})
</script>

<style scoped lang="scss">
.dialog-medium {
  width: 100%;
  max-width: 560px;
  min-width: 0;
  margin: 0 auto;
}
</style>
