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
        v-if="quote.status === 'pending'"
        role="status"
        data-testid="stealth-quote-pending"
        >{{ $t('sendStealthDialog.checkingQuote') }}</q-card-section
      >
      <q-card-section
        v-else-if="quote.status === 'error'"
        role="alert"
        data-testid="stealth-quote-error"
        >{{ quote.message }}</q-card-section
      >
      <q-card-section
        v-if="matchingQuote && selectedOption"
        data-testid="stealth-quote-summary"
      >
        <div>
          {{ $t('sendStealthDialog.recipientAmount') }}:
          <span data-testid="stealth-reviewed-amount"
            >{{
              format(
                matchingQuote.payment.amountAtomic,
                selectedOption.decimals,
              )
            }}
            {{ selectedOption.unit }}</span
          >
        </div>
        <div>
          {{ $t('sendStealthDialog.nativeBalance') }}:
          <span data-testid="stealth-native-balance"
            >{{
              format(
                matchingQuote.payment.nativeBalanceAtomic,
                selectedOption.nativeDecimals,
              )
            }}
            {{ selectedOption.nativeUnit }}</span
          >
        </div>
        <div>
          {{ $t('sendStealthDialog.nativeFee') }}:
          <span data-testid="stealth-native-fee"
            >{{
              format(
                matchingQuote.payment.estimatedNativeFeeAtomic,
                selectedOption.nativeDecimals,
              )
            }}
            {{ selectedOption.nativeUnit }}</span
          >
        </div>
        <div>
          {{ $t('sendStealthDialog.feeCeiling') }}:
          <span data-testid="stealth-fee-ceiling"
            >{{
              format(
                matchingQuote.maxNativeFeeAtomic,
                selectedOption.nativeDecimals,
              )
            }}
            {{ selectedOption.nativeUnit }}</span
          >
        </div>
        <div>
          {{ $t('sendStealthDialog.messageStamp') }}:
          <span data-testid="stealth-message-stamp"
            >{{
              format(
                matchingQuote.stampValueAtomic,
                matchingQuote.stampDecimals,
              )
            }}
            {{ matchingQuote.stampUnit }}</span
          >
        </div>
        <div>
          {{ $t('sendStealthDialog.messageStampFee') }}:
          <span data-testid="stealth-message-stamp-fee"
            >{{
              format(matchingQuote.stampFeeAtomic, matchingQuote.stampDecimals)
            }}
            {{ matchingQuote.stampUnit }}</span
          >
        </div>
      </q-card-section>
      <q-card-section
        v-if="matchingQuote && !readyQuote"
        role="alert"
        data-testid="stealth-insufficient-funds"
        >{{ $t('sendStealthDialog.insufficientFunds') }}</q-card-section
      >
      <q-card-actions align="right">
        <q-btn
          flat
          :label="$t('sendStealthDialog.cancelBtnLabel')"
          color="primary"
          v-close-popup
        />
        <q-btn
          flat
          :disable="!canReview || busy || quote.status === 'pending'"
          :label="$t('sendStealthDialog.reviewBtnLabel')"
          color="primary"
          data-testid="stealth-review-btn"
          @click="reviewStealth"
        />
        <q-btn
          flat
          :disable="!readyQuote || busy"
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
import {
  formatStealthAmount,
  parseStealthAmount,
  sameStealthAsset,
  sameStealthRequest,
  stealthAssetKey,
  type StealthAssetOption,
  type StealthDialogRequest,
  type StealthDialogQuoteState,
  type ReviewedStealthDialogIntent,
} from '../../stealth-payments/options'

/** Presentation only: composition supplies supported assets, observed balances and unsigned quotes. */
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
    review: (request: StealthDialogRequest) => request.amountAtomic > 0n,
    send: (intent: ReviewedStealthDialogIntent) => intent.amountAtomic > 0n,
  },
  data() {
    return {
      selectedKey: this.options[0]?.key ?? '',
      amount: '',
      memo: '',
      reviewedRequest: undefined as StealthDialogRequest | undefined,
      quoteAtReview: undefined as StealthDialogQuoteState | undefined,
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
    canReview(): boolean {
      const request = this.request,
        balance = this.selectedOption?.balanceAtomic
      return (
        !!request && (balance === undefined || request.amountAtomic <= balance)
      )
    },
    matchingQuote():
      | Extract<StealthDialogQuoteState, { status: 'ready' }>
      | undefined {
      const quote = this.quote,
        request = this.request
      if (
        quote.status !== 'ready' ||
        quote === this.quoteAtReview ||
        !this.reviewedRequest ||
        !request ||
        !sameStealthRequest(quote.request, request) ||
        !sameStealthRequest(this.reviewedRequest, request)
      )
        return undefined
      const payment = quote.payment
      if (
        payment.chainIdentifier !== request.chainIdentifier ||
        !sameStealthAsset(payment.asset, request.asset) ||
        payment.amountAtomic !== request.amountAtomic ||
        payment.assetBalanceAtomic < 0n ||
        payment.nativeBalanceAtomic < 0n ||
        payment.estimatedNativeFeeAtomic < 0n ||
        quote.maxNativeFeeAtomic < payment.estimatedNativeFeeAtomic ||
        quote.stampValueAtomic < 0n ||
        quote.stampFeeAtomic < 0n
      )
        return undefined
      return quote
    },
    readyQuote():
      | Extract<StealthDialogQuoteState, { status: 'ready' }>
      | undefined {
      const quote = this.matchingQuote
      if (
        !quote ||
        quote.payment.assetBalanceAtomic < quote.request.amountAtomic
      )
        return undefined
      const nativeNeeded =
        quote.maxNativeFeeAtomic +
        (quote.request.asset.kind === 'native'
          ? quote.request.amountAtomic
          : 0n)
      return quote.payment.nativeBalanceAtomic >= nativeNeeded
        ? quote
        : undefined
    },
    currentWalletBalanceDisplay(): string {
      const option = this.selectedOption
      if (!option) return '…'
      const balance =
        this.matchingQuote?.payment.assetBalanceAtomic ?? option.balanceAtomic
      return balance === undefined
        ? '…'
        : `${formatStealthAmount(balance, option.decimals)} ${option.unit}`
    },
  },
  watch: {
    selectedKey() {
      this.amount = ''
      this.reviewedRequest = undefined
    },
    amount() {
      this.reviewedRequest = undefined
    },
    memo() {
      this.reviewedRequest = undefined
    },
    address() {
      this.reviewedRequest = undefined
    },
    options() {
      if (!this.options.some(option => option.key === this.selectedKey))
        this.selectedKey = this.options[0]?.key ?? ''
      this.reviewedRequest = undefined
    },
  },
  methods: {
    format: formatStealthAmount,
    reviewStealth() {
      if (
        this.busy ||
        !this.canReview ||
        this.quote.status === 'pending' ||
        !this.request
      )
        return
      this.reviewedRequest = this.request
      this.quoteAtReview = this.quote
      this.$emit('review', this.reviewedRequest)
    },
    sendStealth() {
      const quote = this.readyQuote
      if (this.busy || !quote || !this.request) return
      const payment = quote.payment
      this.$emit('send', {
        ...this.request,
        quote: {
          ...payment,
          asset: { ...payment.asset },
          recipientDestination: new Uint8Array(payment.recipientDestination),
          recipientSpendPublicKey: new Uint8Array(
            payment.recipientSpendPublicKey,
          ),
          ephemeralPublicKey: new Uint8Array(payment.ephemeralPublicKey),
        },
        maxNativeFeeAtomic: quote.maxNativeFeeAtomic,
        stampValue: quote.stampValueAtomic,
      })
    },
  },
  mounted() {
    ;(this.$refs.amountInput as { focus?: () => void } | undefined)?.focus?.()
  },
})
</script>
