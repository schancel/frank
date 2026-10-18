<template>
  <div
    v-if="invoice"
    class="invoice-card q-pa-sm rounded-borders"
    data-testid="invoice-card"
  >
    <template v-if="invoice.action === 'request'">
      <div class="row items-center justify-between q-gutter-xs q-mb-xs">
        <div
          class="text-caption text-weight-bold invoice-id-pill"
          data-testid="invoice-id"
          :title="invoice.invoiceId"
        >
          {{ invoiceIdSummary }}
        </div>
        <q-badge
          :color="statusBadgeColor"
          text-color="white"
          class="invoice-status-pill"
          data-testid="invoice-status-badge"
        >
          {{ statusBadgeLabel }}
        </q-badge>
      </div>

      <div
        class="invoice-hero-amount q-mb-xs"
        data-testid="invoice-amount"
        :title="exactBaseUnitsTitle"
      >
        {{ formattedAmountWithSymbol }}
      </div>

      <div class="text-caption invoice-meta-row q-mb-xs" data-testid="invoice-network">
        {{ networkSummaryText }}
      </div>

      <div
        class="text-caption invoice-meta-row invoice-mono-row q-mb-xs"
        data-testid="invoice-payee"
        :title="invoice.payeeIdentity"
      >
        {{ payeeSummaryText }}
      </div>

      <div
        class="text-caption invoice-meta-row invoice-mono-row q-mb-xs"
        data-testid="invoice-destination"
        :title="invoice.receiveAddress"
      >
        {{ destinationSummaryText }}
      </div>

      <div
        v-if="invoice.description"
        class="text-body2 q-mb-xs invoice-description"
        data-testid="invoice-description"
      >
        {{ invoice.description }}
      </div>

      <div
        v-if="invoice.expiresAtIso"
        class="text-caption invoice-meta-row q-mb-xs"
        data-testid="invoice-expiry"
      >
        {{ expirySummaryText }}
      </div>

      <div
        v-if="resolution.exceptionReason"
        role="alert"
        class="text-caption text-negative q-mb-xs"
        data-testid="invoice-exception-reason"
      >
        {{ exceptionSummaryText }}
      </div>

      <div
        v-if="resolution.verifiedTxHash"
        class="text-caption text-positive q-mb-xs"
        data-testid="invoice-verified-tx"
      >
        {{ verifiedTxText }}
      </div>

      <!-- Private Local Tags Editor (stored locally only, never sent over wire) -->
      <div class="q-mt-xs q-mb-xs" data-testid="invoice-private-tags">
        <div
          v-if="privateTags.length > 0"
          class="row items-center q-gutter-xs q-mb-xs"
        >
          <q-badge
            v-for="tag in privateTags"
            :key="tag"
            class="text-caption invoice-tag-chip"
            data-testid="invoice-private-tag-chip"
          >
            {{ formatTagChip(tag) }}
            <q-btn
              flat
              dense
              round
              size="xs"
              icon="close"
              :aria-label="removeTagAriaLabel(tag)"
              data-testid="invoice-private-tag-remove"
              @click="onRemovePrivateTag(tag)"
            />
          </q-badge>
        </div>

        <div class="row items-center q-gutter-xs">
          <input
            v-model="newTagInput"
            type="text"
            class="col invoice-tag-input text-caption"
            :placeholder="privateTagInputPlaceholder"
            :aria-label="privateTagInputAriaLabel"
            data-testid="invoice-private-tag-input"
            @keyup.enter="onAddPrivateTag"
          />
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            color="info"
            :label="addPrivateTagLabel"
            data-testid="invoice-private-tag-add"
            @click="onAddPrivateTag"
          />
        </div>
      </div>

      <div
        v-if="blockReasonText"
        role="status"
        class="text-caption text-negative q-mb-xs"
        data-testid="invoice-block-reason"
      >
        {{ blockReasonText }}
      </div>

      <div
        v-if="payErrorText"
        role="alert"
        class="text-caption text-negative q-mb-xs"
        data-testid="invoice-pay-error"
      >
        {{ payErrorText }}
      </div>

      <!-- Step 1: Primary Pay trigger (never signs/broadcasts directly; opens explicit confirmation) -->
      <div v-if="!outbound && !confirming" class="row items-center justify-end q-mt-xs">
        <q-btn
          no-caps
          dense
          color="primary"
          class="invoice-pay-btn"
          :label="payButtonLabel"
          :loading="paying"
          :disable="paying || !canPay"
          data-testid="invoice-pay-btn"
          @click="openConfirm"
        />
      </div>

      <!-- Step 2: Explicit Confirmation Group before signing or broadcasting -->
      <div
        v-if="!outbound && confirming"
        class="invoice-confirm-box q-pa-xs q-mt-xs rounded-borders"
        role="group"
        tabindex="-1"
        :aria-label="confirmGroupAriaLabel"
        data-testid="invoice-confirm-group"
      >
        <div class="text-caption text-weight-bold q-mb-xs">
          {{ confirmHeaderText }}
        </div>
        <div class="text-caption invoice-meta-row invoice-mono-row" data-testid="invoice-confirm-payee">
          {{ confirmPayeeText }}
        </div>
        <div class="text-caption invoice-meta-row" data-testid="invoice-confirm-network">
          {{ confirmNetworkText }}
        </div>
        <div
          class="text-caption invoice-meta-row"
          data-testid="invoice-confirm-amount"
          :title="exactBaseUnitsTitle"
        >
          {{ confirmAmountText }}
        </div>
        <div
          class="text-caption invoice-meta-row invoice-mono-row"
          data-testid="invoice-confirm-destination"
          :title="invoice.receiveAddress"
        >
          {{ confirmDestinationText }}
        </div>
        <div class="text-caption invoice-meta-row q-mb-xs" data-testid="invoice-confirm-fee">
          {{ confirmFeeText }}
        </div>

        <div class="row items-center q-gutter-xs q-mt-xs">
          <q-btn
            no-caps
            dense
            color="primary"
            :label="confirmAndPayLabel"
            :loading="paying"
            :disable="paying || !canPay"
            data-testid="invoice-confirm-pay"
            @click="confirmAndPay"
          />
          <q-btn
            flat
            no-caps
            dense
            text-color="white"
            :label="cancelConfirmLabel"
            :disable="paying"
            data-testid="invoice-confirm-cancel"
            @click="cancelConfirm"
          />
        </div>
      </div>
    </template>

    <template v-else-if="invoice.action === 'receipt'">
      <div class="invoice-receipt-box" data-testid="invoice-receipt-card">
        <div class="text-caption text-weight-bold q-mb-xs">
          {{ receiptHeaderText }}
        </div>
        <div class="text-caption invoice-meta-row invoice-mono-row" data-testid="invoice-receipt-id">
          {{ receiptInvoiceIdText }}
        </div>
        <div
          class="text-caption invoice-meta-row invoice-mono-row"
          data-testid="invoice-receipt-tx"
          :title="invoice.txHash"
        >
          {{ receiptTxHashText }}
        </div>
        <div class="text-caption invoice-receipt-note" data-testid="invoice-receipt-note">
          {{ receiptCanonicalNoteText }}
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  defaultInvoiceAttemptStore,
  defaultInvoicePrivateTagStore,
  formatInvoiceAmount,
  type InvoiceAttemptStore,
  type InvoiceLifecycleStatus,
  type InvoicePayload,
  type InvoicePrivateTagStore,
  type InvoiceReceiptPayload,
  type InvoiceRequestPayload,
  type InvoiceResolution,
  type ObservedNativeTransfer,
  parseInvoiceApplicationItem,
  toInvoiceApplicationItem,
  verifyCanonicalInvoicePayment,
} from '@frank/wallet/message-item-plugins/invoice'

export default defineComponent({
  name: 'ChatMessageInvoice',
  props: {
    item: {
      type: Object as PropType<ApplicationMessageItem | InvoicePayload>,
      required: true,
    },
    address: {
      type: String,
      default: '',
    },
    outbound: {
      type: Boolean,
      default: false,
    },
    activeChainKey: {
      type: String,
      default: 'monad',
    },
    activeNetworkId: {
      type: String,
      default: '10143',
    },
    estimatedFeeBaseUnits: {
      type: String,
      default: '210000000000000',
    },
    observedTransfer: {
      type: Object as PropType<ObservedNativeTransfer | null>,
      default: null,
    },
    receiptHints: {
      type: Array as PropType<ReadonlyArray<InvoiceReceiptPayload>>,
      default: () => [],
    },
    nowMs: {
      type: Number,
      default: undefined,
    },
    attemptStore: {
      type: Object as PropType<InvoiceAttemptStore>,
      default: () => defaultInvoiceAttemptStore,
    },
    privateTagStore: {
      type: Object as PropType<InvoicePrivateTagStore>,
      default: () => defaultInvoicePrivateTagStore,
    },
    payHandler: {
      type: Function as PropType<
        (params: {
          invoice: InvoiceRequestPayload
          onSigned: (txHash: string) => void
        }) => Promise<{ txHash: string }>
      >,
      default: undefined,
    },
  },
  emits: ['sendFollowUp', 'paid', 'statusChange'],
  data() {
    return {
      confirming: false,
      paying: false,
      payErrorText: '',
      newTagInput: '',
      tagVersion: 0,
      attemptVersion: 0,
    }
  },
  computed: {
    invoice(): InvoicePayload | null {
      try {
        return parseInvoiceApplicationItem(this.item)
      } catch {
        return null
      }
    },
    requestInvoice(): InvoiceRequestPayload | null {
      return this.invoice?.action === 'request' ? this.invoice : null
    },
    resolution(): InvoiceResolution {
      // Touch reactive version counter so attemptStore updates trigger recomputation
      void this.attemptVersion
      if (!this.requestInvoice) {
        return {
          invoiceId: this.invoice?.invoiceId ?? '',
          status: 'open',
          expectedAmountBaseUnits: this.invoice?.amountBaseUnits ?? '0',
          receiptHintTxHashes: [],
          paymentBlocked: true,
        }
      }
      return verifyCanonicalInvoicePayment(
        this.requestInvoice,
        this.observedTransfer,
        {
          activeChainKey: this.activeChainKey,
          activeNetworkId: this.activeNetworkId,
          nowMs: this.nowMs,
          attemptStore: this.attemptStore,
          receiptHints: this.receiptHints,
        },
      )
    },
    lifecycleStatus(): InvoiceLifecycleStatus {
      return this.resolution.status
    },
    statusBadgeColor(): string {
      switch (this.lifecycleStatus) {
        case 'paid_confirmed':
          return 'positive'
        case 'signing_or_broadcasting':
          return 'info'
        case 'outcome_unknown':
          return 'warning'
        case 'exception_manual_review':
          return 'negative'
        case 'expired':
          return 'grey-7'
        default:
          return 'primary'
      }
    },
    statusBadgeLabel(): string {
      switch (this.lifecycleStatus) {
        case 'open':
          return this.tr('invoice.status.open', 'open')
        case 'signing_or_broadcasting':
          return this.tr(
            'invoice.status.signingOrBroadcasting',
            'signing_or_broadcasting',
          )
        case 'outcome_unknown':
          return this.tr('invoice.status.outcomeUnknown', 'outcome_unknown')
        case 'paid_confirmed':
          return this.tr('invoice.status.paidConfirmed', 'paid_confirmed')
        case 'expired':
          return this.tr('invoice.status.expired', 'expired')
        case 'exception_manual_review':
          return this.tr(
            'invoice.status.exceptionManualReview',
            'exception_manual_review',
          )
      }
    },
    invoiceIdSummary(): string {
      if (!this.invoice) return ''
      const id = this.invoice.invoiceId
      const short = id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id
      return this.tr('invoice.idLabel', `Invoice #${short}`, { id: short })
    },
    formattedAmount(): string {
      if (!this.requestInvoice) return '0'
      return formatInvoiceAmount(
        this.requestInvoice.amountBaseUnits,
        this.requestInvoice.nativeDecimals,
      )
    },
    formattedAmountWithSymbol(): string {
      if (!this.requestInvoice) return ''
      return `${this.formattedAmount} ${this.requestInvoice.nativeSymbol}`
    },
    exactBaseUnitsTitle(): string {
      if (!this.requestInvoice) return ''
      return `${this.requestInvoice.amountBaseUnits} base units`
    },
    formattedEstimatedFee(): string {
      if (!this.requestInvoice) return '0'
      const feeStr = String(this.estimatedFeeBaseUnits || '').trim()
      if (!/^[1-9]\d{0,77}$/.test(feeStr)) {
        return `0 ${this.requestInvoice.nativeSymbol}`
      }
      return `${formatInvoiceAmount(
        feeStr,
        this.requestInvoice.nativeDecimals,
      )} ${this.requestInvoice.nativeSymbol}`
    },
    networkSummaryText(): string {
      if (!this.requestInvoice) return ''
      return this.tr(
        'invoice.networkSummary',
        `Chain: ${this.requestInvoice.chainKey} (${this.requestInvoice.networkId})`,
        {
          chain: this.requestInvoice.chainKey,
          network: this.requestInvoice.networkId,
        },
      )
    },
    payeeSummaryText(): string {
      if (!this.requestInvoice) return ''
      return this.tr(
        'invoice.payeeSummary',
        `Payee: ${this.shortIdentifier(this.requestInvoice.payeeIdentity)}`,
        { payee: this.shortIdentifier(this.requestInvoice.payeeIdentity) },
      )
    },
    destinationSummaryText(): string {
      if (!this.requestInvoice) return ''
      return this.tr(
        'invoice.destinationSummary',
        `To: ${this.shortIdentifier(this.requestInvoice.receiveAddress)}`,
        {
          address: this.shortIdentifier(this.requestInvoice.receiveAddress),
        },
      )
    },
    expirySummaryText(): string {
      if (!this.requestInvoice?.expiresAtIso) return ''
      return this.tr(
        'invoice.expirySummary',
        `Expires: ${this.requestInvoice.expiresAtIso}`,
        { expiresAt: this.requestInvoice.expiresAtIso },
      )
    },
    exceptionSummaryText(): string {
      if (!this.resolution.exceptionReason) return ''
      return this.tr(
        'invoice.exceptionSummary',
        `Manual review required: ${this.resolution.exceptionReason}`,
        { reason: this.resolution.exceptionReason },
      )
    },
    verifiedTxText(): string {
      if (!this.resolution.verifiedTxHash) return ''
      return this.tr(
        'invoice.verifiedTxSummary',
        `Confirmed on-chain: ${this.shortIdentifier(
          this.resolution.verifiedTxHash,
        )}`,
        { txHash: this.shortIdentifier(this.resolution.verifiedTxHash) },
      )
    },
    privateTags(): string[] {
      void this.tagVersion
      if (!this.invoice) return []
      return this.privateTagStore.getTags(this.invoice.invoiceId)
    },
    privateTagInputPlaceholder(): string {
      return this.tr('invoice.addPrivateTagPlaceholder', 'Add private tag…')
    },
    privateTagInputAriaLabel(): string {
      return this.tr('invoice.addPrivateTagAria', 'Private local tag')
    },
    addPrivateTagLabel(): string {
      return this.tr('invoice.addTagBtn', 'Add Tag')
    },
    canPay(): boolean {
      return (
        this.requestInvoice !== null &&
        !this.outbound &&
        this.lifecycleStatus === 'open' &&
        !this.resolution.paymentBlocked
      )
    },
    blockReasonText(): string {
      if (!this.requestInvoice) return ''
      if (this.resolution.paymentBlocked && this.resolution.paymentBlockedReason) {
        return this.resolution.paymentBlockedReason
      }
      return ''
    },
    payButtonLabel(): string {
      if (!this.requestInvoice) return ''
      return this.tr(
        'invoice.payBtn',
        `Pay ${this.formattedAmountWithSymbol}`,
        { amount: this.formattedAmountWithSymbol },
      )
    },
    confirmGroupAriaLabel(): string {
      return this.tr(
        'invoice.confirmGroupAria',
        'Confirm native invoice payment details',
      )
    },
    confirmHeaderText(): string {
      return this.tr(
        'invoice.confirmHeader',
        'Review & confirm native payment:',
      )
    },
    confirmPayeeText(): string {
      if (!this.requestInvoice) return ''
      return `Payee: ${this.requestInvoice.payeeIdentity}`
    },
    confirmNetworkText(): string {
      if (!this.requestInvoice) return ''
      return `Network: ${this.requestInvoice.chainKey} (${this.requestInvoice.networkId})`
    },
    confirmAmountText(): string {
      if (!this.requestInvoice) return ''
      return `Amount: ${this.formattedAmountWithSymbol} (${this.requestInvoice.amountBaseUnits} base units)`
    },
    confirmDestinationText(): string {
      if (!this.requestInvoice) return ''
      return `Destination: ${this.requestInvoice.receiveAddress}`
    },
    confirmFeeText(): string {
      return `Estimated fee: ${this.formattedEstimatedFee}`
    },
    confirmAndPayLabel(): string {
      return this.tr('invoice.confirmAndPayBtn', 'Confirm & Pay')
    },
    cancelConfirmLabel(): string {
      return this.tr('invoice.cancelConfirmBtn', 'Cancel')
    },
    receiptHeaderText(): string {
      return this.tr('invoice.receiptHeader', 'Invoice Payment Receipt')
    },
    receiptInvoiceIdText(): string {
      if (!this.invoice) return ''
      return `Invoice ID: ${this.invoice.invoiceId}`
    },
    receiptTxHashText(): string {
      if (!this.invoice || this.invoice.action !== 'receipt') return ''
      return `Tx: ${this.invoice.txHash}`
    },
    receiptCanonicalNoteText(): string {
      return this.tr(
        'invoice.receiptCanonicalNote',
        'Receipt is a correlation hint; settlement requires canonical on-chain verification.',
      )
    },
  },
  methods: {
    tr(
      key: string,
      fallback: string,
      params?: Record<string, unknown>,
    ): string {
      const gp = (
        this as unknown as {
          $?: {
            appContext?: {
              config?: {
                globalProperties?: {
                  $te?: (k: string) => boolean
                  $t?: (k: string, p?: Record<string, unknown>) => string
                }
              }
            }
          }
        }
      ).$?.appContext?.config?.globalProperties
      if (
        typeof gp?.$te === 'function' &&
        gp.$te(key) &&
        typeof gp.$t === 'function'
      ) {
        return gp.$t(key, params)
      }
      return fallback
    },
    shortIdentifier(value?: string): string {
      if (!value) return '?'
      const trimmed = value.trim()
      if (trimmed.length <= 14) return trimmed
      return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`
    },
    formatTagChip(tag: string): string {
      return `#${tag.replace(/^#+/, '')}`
    },
    removeTagAriaLabel(tag: string): string {
      return `Remove private tag ${tag}`
    },
    onAddPrivateTag() {
      if (!this.invoice) return
      const trimmed = this.newTagInput.trim()
      if (!trimmed) return
      try {
        this.privateTagStore.addTag(this.invoice.invoiceId, trimmed)
        this.newTagInput = ''
        this.tagVersion++
      } catch (err) {
        this.payErrorText = err instanceof Error ? err.message : String(err)
      }
    },
    onRemovePrivateTag(tag: string) {
      if (!this.invoice) return
      this.privateTagStore.removeTag(this.invoice.invoiceId, tag)
      this.tagVersion++
    },
    focusFor(testid: string) {
      void this.$nextTick(() => {
        const root = this.$el as HTMLElement | undefined
        root?.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.focus()
      })
    },
    openConfirm() {
      if (this.paying || !this.canPay) return
      this.payErrorText = ''
      this.confirming = true
      this.focusFor('invoice-confirm-group')
    },
    cancelConfirm() {
      this.confirming = false
      this.focusFor('invoice-pay-btn')
    },
    async confirmAndPay() {
      const req = this.requestInvoice
      if (this.paying || !this.confirming || !req || !this.canPay) return

      this.confirming = false
      this.paying = true
      this.payErrorText = ''

      let signedTxId: string | undefined
      try {
        // 1. Durably record pre-broadcast attempt BEFORE signing/broadcasting
        this.attemptStore.recordPreBroadcast({
          invoiceId: req.invoiceId,
          chainKey: req.chainKey,
          networkId: req.networkId,
          receiveAddress: req.receiveAddress,
          amountBaseUnits: req.amountBaseUnits,
        })
        this.attemptVersion++
        this.$emit('statusChange', 'signing_or_broadcasting')

        // 2. Execute native payment via provided handler
        if (!this.payHandler) {
          throw new Error(
            'No native wallet payment handler available for invoice settlement',
          )
        }

        const result = await this.payHandler({
          invoice: req,
          onSigned: (txHash: string) => {
            signedTxId = txHash
            this.attemptStore.attachSignedTxId(req.invoiceId, txHash)
            this.attemptVersion++
          },
        })

        const finalTxHash = result.txHash || signedTxId
        if (!finalTxHash) {
          throw new Error(
            'Broadcast returned no transaction hash; submission outcome is unknown',
          )
        }
        this.attemptStore.attachSignedTxId(req.invoiceId, finalTxHash)
        this.attemptVersion++

        // 3. Emit follow-up receipt message item with correlation hint
        const receiptPayload: InvoiceReceiptPayload = {
          action: 'receipt',
          schemaVersion: 1,
          invoiceId: req.invoiceId,
          txHash: finalTxHash,
          chainKey: req.chainKey,
          networkId: req.networkId,
          amountBaseUnits: req.amountBaseUnits,
        }
        const receiptItem = toInvoiceApplicationItem(receiptPayload)

        this.$emit('sendFollowUp', {
          items: [receiptItem],
        })
        this.$emit('paid', {
          invoiceId: req.invoiceId,
          txHash: finalTxHash,
          receipt: receiptPayload,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.attemptStore.markOutcomeUnknown(req.invoiceId, {
          signedTxId,
          errorReason: message,
        })
        this.attemptVersion++
        this.payErrorText = message
        this.$emit('statusChange', 'outcome_unknown')
      } finally {
        this.paying = false
      }
    },
  },
})
</script>

<style lang="scss" scoped>
.invoice-card {
  background: linear-gradient(145deg, #0f172a 0%, #1e293b 100%);
  color: #f8fafc;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  padding: 14px 16px !important;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.28);
  min-width: 270px;
  max-width: 420px;
}

.invoice-id-pill {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 8px;
  border-radius: 999px;
}

.invoice-status-pill {
  border-radius: 999px;
  padding: 3px 8px;
  font-weight: 600;
}

.invoice-hero-amount,
[data-testid='invoice-amount'] {
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #ffffff;
}

.invoice-meta-row {
  color: #cbd5e1;
}

.invoice-mono-row {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.invoice-description {
  white-space: pre-wrap;
  word-break: break-word;
  color: #f1f5f9;
  background: rgba(15, 23, 42, 0.45);
  border-radius: 8px;
  padding: 6px 10px;
}

.invoice-tag-chip {
  background: rgba(255, 255, 255, 0.12) !important;
  color: #e2e8f0 !important;
  border-radius: 999px;
  padding: 2px 8px;
}

.invoice-confirm-box {
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(59, 130, 246, 0.5);
  border-radius: 12px;
  padding: 10px 12px !important;
  color: #f8fafc;
}

.invoice-tag-input {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  padding: 4px 10px;
  color: #f8fafc;
  outline: none;

  &::placeholder {
    color: rgba(203, 213, 225, 0.65);
  }
}

.invoice-receipt-box,
[data-testid='invoice-receipt-card'] {
  border-left: 3px solid #10b981;
  padding-left: 10px;
  color: #f8fafc;
}

.invoice-receipt-note {
  color: #cbd5e1;
  margin-top: 4px;
}
</style>
