<template>
  <q-card
    class="q-px-sm q-pb-md dialog-medium"
    data-testid="send-stealth-dialog"
  >
    <q-form @submit.prevent="sendStealth">
      <q-card-section class="q-pb-sm">
        <div class="text-h6 send-stealth-title">
          {{
            $t('sendStealthDialog.sendStealthTo') +
            ' ' +
            (contact?.profile?.name || contact?.name || address)
          }}
        </div>
        <div class="text-caption text-grey-7 send-stealth-subtitle">
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
          class="row items-center justify-between no-wrap text-caption text-grey-7"
          data-testid="wallet-balance-row"
        >
          <span>{{ $t('sendStealthDialog.balanceLabel') }}</span>
          <span
            class="text-right q-ml-sm"
            :class="
              availableBalanceAtomic === undefined ? 'text-italic' : 'text-bold'
            "
            data-testid="wallet-balance-value"
            :title="exactBalanceDisplay"
            aria-live="polite"
            >{{ currentWalletBalanceDisplay }}</span
          >
        </div>
      </q-card-section>
      <q-card-section class="q-py-sm">
        <q-input
          v-model="amount"
          class="text-bold text-h6"
          type="text"
          inputmode="decimal"
          enterkeyhint="send"
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
          @focus="revealFocused"
        />
      </q-card-section>
      <q-card-section class="q-py-sm">
        <q-input
          v-model="memo"
          filled
          dense
          enterkeyhint="send"
          :disable="busy"
          :hint="$t('sendStealthDialog.memoHint')"
          :placeholder="$t('sendStealthDialog.memoPlaceholder')"
          data-testid="stealth-memo-input"
          @focus="revealFocused"
        />
      </q-card-section>
      <q-card-section
        v-if="quote.status === 'error' && !quoteErrorStale"
        role="alert"
        class="text-negative text-caption q-pt-none"
        data-testid="stealth-quote-error"
        >{{ quote.message }}</q-card-section
      >
      <!-- Sticky: with the phone keyboard open the sheet scrolls, and Send stays in reach of
      the amount instead of below the fold. -->
      <q-card-actions align="right" class="send-stealth-actions">
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
import { shortenDisplayAmount } from '../../utils/chain-amount'
import {
  formatStealthAmount,
  parseStealthAmount,
  stealthAssetKey,
  type StealthAssetOption,
  type StealthDialogRequest,
  type StealthDialogQuoteState,
  type ReviewedStealthDialogIntent,
} from '../../stealth-payments/options'

type AvailableState =
  | { readonly key: string; readonly status: 'loading' | 'unknown' | 'error' }
  | { readonly key: string; readonly status: 'ready'; readonly atomic: bigint }

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
    /** Reads what a payment of an option could draw on (read-only, reserves nothing).
     * Undefined from it: that wallet only knows once the payment is quoted. */
    loadAvailable: {
      type: Function as PropType<
        (option: StealthAssetOption) => Promise<bigint | undefined>
      >,
      default: undefined,
    },
  },
  emits: {
    cancel: () => true,
    review: (request: StealthDialogRequest) => request.amountAtomic > 0n,
    send: (intent: StealthDialogRequest | ReviewedStealthDialogIntent) =>
      intent.amountAtomic > 0n,
  },
  setup() {
    const {
      balance: activeBalance,
      loaded: balanceLoaded,
      hasError: balanceFailed,
    } = useBalance()
    return {
      activeBalance,
      balanceLoaded,
      balanceFailed,
    }
  },
  data() {
    return {
      selectedKey: this.options[0]?.key ?? '',
      amount: '',
      memo: '',
      available: undefined as AvailableState | undefined,
      availableSequence: 0,
      /** The last failure was for another asset or amount than the one now chosen. */
      quoteErrorStale: false,
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
    /** The active network's own coin, whose balance the shared balance loop already reads. */
    usesActiveBalance(): boolean {
      const option = this.selectedOption
      return (
        !!option &&
        option.balanceAtomic === undefined &&
        option.chainIdentifier === activeChain.chainIdentifier &&
        option.asset.kind === 'native'
      )
    },
    availableBalanceAtomic(): bigint | undefined {
      const option = this.selectedOption
      if (!option) return undefined
      if (option.balanceAtomic !== undefined) {
        return option.balanceAtomic
      }
      if (this.usesActiveBalance) {
        return this.balanceLoaded && this.activeBalance !== null
          ? this.activeBalance
          : undefined
      }
      const available = this.available
      return available?.key === option.key && available.status === 'ready'
        ? available.atomic
        : undefined
    },
    /** The exact available amount, for the shortened row's title. */
    exactBalanceDisplay(): string | undefined {
      const option = this.selectedOption
      const balance = this.availableBalanceAtomic
      return option && balance !== undefined
        ? `${formatStealthAmount(balance, option.decimals)} ${option.unit}`
        : undefined
    },
    /** Never an endless "…": loading, a real figure, or why there is none. */
    currentWalletBalanceDisplay(): string {
      const option = this.selectedOption
      if (!option) return '…'
      const balance = this.availableBalanceAtomic
      if (balance !== undefined)
        // Read like every other balance (digits cut, never rounded up); the exact amount is in
        // the row's title.
        return `${shortenDisplayAmount(
          formatStealthAmount(balance, option.decimals),
        )} ${option.unit}`
      if (this.usesActiveBalance)
        return this.balanceFailed
          ? this.$t('sendStealthDialog.balanceUnavailable')
          : '…'
      const available = this.available
      if (!this.loadAvailable) return this.$t('sendStealthDialog.balanceAtSend')
      if (available?.key !== option.key || available.status === 'loading')
        return '…'
      return available.status === 'error'
        ? this.$t('sendStealthDialog.balanceUnavailable')
        : this.$t('sendStealthDialog.balanceAtSend')
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
      this.quoteErrorStale = true
      void this.refreshAvailable()
    },
    amount() {
      this.quoteErrorStale = true
    },
    quote() {
      this.quoteErrorStale = false
    },
    options() {
      if (!this.options.some(option => option.key === this.selectedKey))
        this.selectedKey = this.options[0]?.key ?? ''
      else void this.refreshAvailable()
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
    /** One read per selected option; the latest selection's answer wins. */
    async refreshAvailable() {
      const option = this.selectedOption
      const sequence = ++this.availableSequence
      if (
        !option ||
        !this.loadAvailable ||
        option.balanceAtomic !== undefined ||
        this.usesActiveBalance
      ) {
        this.available = undefined
        return
      }
      this.available = { key: option.key, status: 'loading' }
      try {
        const atomic = await this.loadAvailable(option)
        if (sequence !== this.availableSequence) return
        this.available =
          atomic === undefined
            ? { key: option.key, status: 'unknown' }
            : { key: option.key, status: 'ready', atomic }
      } catch (error) {
        // The provider's text (URLs, response bodies) stays in the console.
        console.error(error)
        if (sequence === this.availableSequence)
          this.available = { key: option.key, status: 'error' }
      }
    },
    /** Keeps the focused field in view inside the sheet, also once the keyboard has opened.
     * Only the sheet scrolls. A phone's own focus reveal also scrolls clipping (overflow:
     * hidden) boxes of the chat column, which moves the sheet out of sight; those go back. */
    revealFocused() {
      const root = this.$el as HTMLElement | undefined
      const active = document.activeElement
      if (!root || !(active instanceof HTMLElement) || !root.contains(active))
        return
      let scroller: HTMLElement | undefined
      for (let node = root.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (!scroller && /auto|scroll/.test(style.overflowY)) {
          scroller = node
          continue
        }
        if (style.overflowY === 'hidden' || style.overflowX === 'hidden') {
          if (node.scrollTop) node.scrollTop = 0
          if (node.scrollLeft) node.scrollLeft = 0
        }
      }
      if (!scroller) return
      const field = (active.closest('.q-field') as HTMLElement | null) ?? active
      const view = scroller.getBoundingClientRect()
      const box = field.getBoundingClientRect()
      // The sticky Send row covers the bottom of the sheet.
      const actions =
        root.querySelector('.send-stealth-actions')?.getBoundingClientRect()
          .height ?? 0
      const margin = 8
      if (box.top < view.top + margin)
        scroller.scrollTop -= view.top + margin - box.top
      else if (box.bottom > view.bottom - actions - margin)
        scroller.scrollTop += box.bottom - (view.bottom - actions - margin)
    },
  },
  mounted() {
    void this.refreshAvailable()
    window.visualViewport?.addEventListener('resize', this.revealFocused, {
      passive: true,
    })
    // On a phone, focusing here would open the keyboard over the sheet before it is read;
    // the user taps the amount instead.
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: fine)').matches
    )
      (this.$refs.amountInput as { focus?: () => void } | undefined)?.focus?.()
  },
  beforeUnmount() {
    this.availableSequence++
    window.visualViewport?.removeEventListener('resize', this.revealFocused)
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

.send-stealth-title {
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.send-stealth-actions {
  position: sticky;
  // Sticky stops at the sheet's padding (Chat.vue `.chat-inline-sheet`, q-pa-sm = 8px); the
  // memo field scrolled below showed through that strip under Send/Cancel. The row reaches the
  // sheet's edge instead and keeps the same space inside itself.
  bottom: -8px;
  padding-bottom: 16px;
  z-index: 1;
  background: #fff;
}

.body--dark .send-stealth-actions {
  background: var(--q-dark);
}

// A short screen (a phone with its keyboard open): the subtitle gives way to the fields.
// iOS keeps the layout height with the keyboard up, so its class from
// utils/mobile-viewport-scale.ts is checked as well as the media height.
html.frank-keyboard-open .send-stealth-subtitle {
  display: none;
}
@media (max-height: 560px) {
  .send-stealth-subtitle {
    display: none;
  }
}
</style>
