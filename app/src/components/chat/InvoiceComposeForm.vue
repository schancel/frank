<template>
  <q-card-section
    class="invoice-compose-form q-pa-sm"
    data-testid="invoice-compose-form"
  >
    <div class="row items-center justify-between q-mb-xs">
      <div class="text-subtitle2 text-weight-bold" data-testid="invoice-compose-title">
        {{ titleText }}
      </div>
      <q-badge
        color="primary"
        text-color="white"
        data-testid="invoice-compose-network"
      >
        {{ networkSummary }}
      </q-badge>
    </div>

    <div
      class="text-caption q-mb-sm invoice-compose-address"
      data-testid="invoice-compose-address"
      :title="effectiveReceiveAddress"
    >
      {{ destinationSummary }}
    </div>

    <q-input
      v-model="amountInput"
      dense
      outlined
      class="q-mb-xs"
      :label="amountFieldLabel"
      :placeholder="amountPlaceholder"
      :disable="busy"
      data-testid="invoice-compose-amount"
    />

    <div
      v-if="parsedBaseUnitsPreview"
      class="text-caption q-mb-xs invoice-compose-base-units"
      data-testid="invoice-compose-base-units"
    >
      {{ parsedBaseUnitsPreview }}
    </div>

    <q-input
      v-model="descriptionInput"
      dense
      outlined
      type="textarea"
      autogrow
      class="q-mb-xs"
      :label="descriptionFieldLabel"
      :placeholder="descriptionPlaceholder"
      :disable="busy"
      data-testid="invoice-compose-description"
    />

    <div
      class="text-caption q-mb-xs"
      :class="descriptionByteLength > maxDescriptionBytes ? 'text-negative' : ''"
      data-testid="invoice-compose-byte-count"
    >
      {{ byteCountSummary }}
    </div>

    <q-input
      v-model="expiresAtInput"
      dense
      outlined
      class="q-mb-xs"
      :label="expiryFieldLabel"
      :placeholder="expiryPlaceholder"
      :disable="busy"
      data-testid="invoice-compose-expiry"
    />

    <div
      class="row items-center q-gutter-xs q-mb-sm"
      data-testid="invoice-compose-expiry-presets"
    >
      <q-btn
        v-for="preset in expiryPresets"
        :key="preset.id"
        outline
        dense
        no-caps
        size="sm"
        color="primary"
        :label="preset.label"
        :disable="busy"
        :data-testid="`invoice-expiry-preset-${preset.id}`"
        @click="applyExpiryPreset(preset.durationMs)"
      />
      <q-btn
        v-if="expiresAtInput"
        flat
        dense
        no-caps
        size="sm"
        :label="clearExpiryLabel"
        :disable="busy"
        data-testid="invoice-expiry-preset-clear"
        @click="clearExpiry"
      />
    </div>

    <q-input
      v-model="privateTagsInput"
      dense
      outlined
      class="q-mb-xs"
      :label="privateTagsFieldLabel"
      :placeholder="privateTagsPlaceholder"
      :disable="busy"
      data-testid="invoice-compose-private-tags"
    />

    <div class="text-caption text-grey-7 q-mb-sm" data-testid="invoice-compose-private-hint">
      {{ privateTagsHintText }}
    </div>

    <div
      v-if="validationError"
      role="alert"
      class="text-caption text-negative q-mb-xs"
      data-testid="invoice-compose-error"
    >
      {{ validationError }}
    </div>

    <div class="row items-center justify-end q-gutter-xs q-mt-xs">
      <q-btn
        flat
        no-caps
        dense
        :label="cancelButtonLabel"
        :disable="busy"
        data-testid="invoice-compose-cancel"
        @click="$emit('cancel')"
      />
      <q-btn
        no-caps
        dense
        color="primary"
        :label="submitButtonLabel"
        :loading="busy"
        :disable="busy || !canSubmit"
        data-testid="invoice-compose-submit"
        @click="submitInvoice"
      />
    </div>
  </q-card-section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  defaultInvoicePrivateTagStore,
  generateInvoiceId,
  INVOICE_MAX_DESCRIPTION_BYTES,
  type InvoicePrivateTagStore,
  type InvoiceRequestPayload,
  parseHumanAmountToBaseUnits,
  toInvoiceApplicationItem,
  utf8ByteLength,
  validateInvoicePayload,
} from '@frank/wallet/message-item-plugins/invoice'

export default defineComponent({
  name: 'InvoiceComposeForm',
  props: {
    payeeIdentity: {
      type: String,
      default: '0x1111111111111111111111111111111111111111',
    },
    receiveAddress: {
      type: String,
      default: '0x1111111111111111111111111111111111111111',
    },
    chainKey: {
      type: String,
      default: 'monad',
    },
    networkId: {
      type: String,
      default: '10143',
    },
    nativeSymbol: {
      type: String,
      default: 'MON',
    },
    nativeDecimals: {
      type: Number,
      default: 18,
    },
    busy: {
      type: Boolean,
      default: false,
    },
    privateTagStore: {
      type: Object as PropType<InvoicePrivateTagStore>,
      default: () => defaultInvoicePrivateTagStore,
    },
  },
  emits: ['submit', 'cancel'],
  data() {
    return {
      amountInput: '',
      descriptionInput: '',
      expiresAtInput: '',
      privateTagsInput: '',
      submissionError: '',
      maxDescriptionBytes: INVOICE_MAX_DESCRIPTION_BYTES,
    }
  },
  computed: {
    effectiveReceiveAddress(): string {
      return this.receiveAddress.trim() || this.payeeIdentity.trim()
    },
    networkSummary(): string {
      return `${this.chainKey} (${this.networkId}) · ${this.nativeSymbol}`
    },
    destinationSummary(): string {
      const addr = this.effectiveReceiveAddress
      const short =
        addr.length > 16 ? `${addr.slice(0, 8)}...${addr.slice(-6)}` : addr
      return this.tr(
        'invoice.composeDestination',
        `Receive address: ${short}`,
        { address: short },
      )
    },
    titleText(): string {
      return this.tr('invoice.composeTitle', 'Create Native Invoice')
    },
    amountFieldLabel(): string {
      return this.tr(
        'invoice.amountLabel',
        `Amount (${this.nativeSymbol})`,
        { symbol: this.nativeSymbol },
      )
    },
    amountPlaceholder(): string {
      return '0.0'
    },
    descriptionFieldLabel(): string {
      return this.tr('invoice.descriptionLabel', 'Description (optional)')
    },
    descriptionPlaceholder(): string {
      return this.tr(
        'invoice.descriptionPlaceholder',
        'What is this invoice for?',
      )
    },
    expiryFieldLabel(): string {
      return this.tr(
        'invoice.expiryLabel',
        'Expires at ISO-8601 (optional)',
      )
    },
    expiryPlaceholder(): string {
      return '2030-01-01T00:00:00Z'
    },
    expiryPresets(): ReadonlyArray<{
      id: string
      label: string
      durationMs: number
    }> {
      return [
        {
          id: '1h',
          label: this.tr('invoice.expiryPreset1h', '1h'),
          durationMs: 60 * 60 * 1000,
        },
        {
          id: '24h',
          label: this.tr('invoice.expiryPreset24h', '24h'),
          durationMs: 24 * 60 * 60 * 1000,
        },
        {
          id: '7d',
          label: this.tr('invoice.expiryPreset7d', '7d'),
          durationMs: 7 * 24 * 60 * 60 * 1000,
        },
      ]
    },
    clearExpiryLabel(): string {
      return this.tr('invoice.clearExpiry', 'Clear')
    },
    privateTagsFieldLabel(): string {
      return this.tr(
        'invoice.privateTagsLabel',
        'Private local tags (comma-separated, never sent)',
      )
    },
    privateTagsPlaceholder(): string {
      return this.tr('invoice.privateTagsPlaceholder', 'tax, client-a')
    },
    privateTagsHintText(): string {
      return this.tr(
        'invoice.privateTagsHint',
        'Private tags stay on your device only and are excluded from the invoice message.',
      )
    },
    cancelButtonLabel(): string {
      return this.tr('invoice.cancel', 'Cancel')
    },
    submitButtonLabel(): string {
      return this.tr('invoice.sendInvoice', 'Send Invoice')
    },
    descriptionByteLength(): number {
      return utf8ByteLength(this.descriptionInput)
    },
    byteCountSummary(): string {
      return `${this.descriptionByteLength}/${this.maxDescriptionBytes} bytes`
    },
    parsedBaseUnits(): string | null {
      const raw = this.amountInput.trim()
      if (!raw) return null
      try {
        return parseHumanAmountToBaseUnits(raw, this.nativeDecimals)
      } catch {
        return null
      }
    },
    parsedBaseUnitsPreview(): string {
      if (!this.parsedBaseUnits) return ''
      return this.tr(
        'invoice.baseUnitsPreview',
        `Base units: ${this.parsedBaseUnits}`,
        { baseUnits: this.parsedBaseUnits },
      )
    },
    validationError(): string {
      if (this.submissionError) return this.submissionError
      if (this.amountInput.trim() && !this.parsedBaseUnits) {
        return this.tr(
          'invoice.invalidAmount',
          `Enter a valid positive ${this.nativeSymbol} amount (up to ${this.nativeDecimals} decimals).`,
        )
      }
      if (this.descriptionByteLength > this.maxDescriptionBytes) {
        return this.tr(
          'invoice.descriptionTooLong',
          `Description exceeds ${this.maxDescriptionBytes} UTF-8 bytes.`,
        )
      }
      if (
        this.expiresAtInput.trim() &&
        Number.isNaN(Date.parse(this.expiresAtInput.trim()))
      ) {
        return this.tr(
          'invoice.invalidExpiry',
          'Expiry must be a valid ISO-8601 timestamp.',
        )
      }
      return ''
    },
    canSubmit(): boolean {
      return (
        this.parsedBaseUnits !== null &&
        this.descriptionByteLength <= this.maxDescriptionBytes &&
        Boolean(this.effectiveReceiveAddress) &&
        (!this.expiresAtInput.trim() ||
          !Number.isNaN(Date.parse(this.expiresAtInput.trim())))
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
      if (typeof gp?.$te === 'function' && gp.$te(key) && typeof gp.$t === 'function') {
        return gp.$t(key, params)
      }
      return fallback
    },
    applyExpiryPreset(durationMs: number) {
      if (this.busy) return
      this.expiresAtInput = new Date(Date.now() + durationMs).toISOString()
    },
    clearExpiry() {
      if (this.busy) return
      this.expiresAtInput = ''
    },
    submitInvoice() {
      this.submissionError = ''
      if (this.busy || !this.canSubmit || !this.parsedBaseUnits) return
      try {
        const invoiceId = generateInvoiceId()
        const rawPayload: InvoiceRequestPayload = {
          action: 'request',
          schemaVersion: 1,
          invoiceId,
          payeeIdentity: this.payeeIdentity.trim() || this.effectiveReceiveAddress,
          chainKey: this.chainKey.trim(),
          networkId: String(this.networkId).trim(),
          nativeSymbol: this.nativeSymbol.trim(),
          nativeDecimals: this.nativeDecimals,
          amountBaseUnits: this.parsedBaseUnits,
          receiveAddress: this.effectiveReceiveAddress,
          description: this.descriptionInput,
          ...(this.expiresAtInput.trim()
            ? { expiresAtIso: this.expiresAtInput.trim() }
            : {}),
        }
        const payload = validateInvoicePayload(
          rawPayload,
        ) as InvoiceRequestPayload
        const item = toInvoiceApplicationItem(payload)

        const rawTags = this.privateTagsInput
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean)
        const savedPrivateTags =
          rawTags.length > 0
            ? this.privateTagStore.setTags(invoiceId, rawTags)
            : []

        this.$emit('submit', {
          payload,
          item,
          privateTags: savedPrivateTags,
        })
      } catch (err) {
        this.submissionError =
          err instanceof Error ? err.message : String(err)
      }
    },
  },
})
</script>

<style lang="scss" scoped>
.invoice-compose-form {
  min-width: min(420px, 90vw);
  padding: 16px !important;

  :deep(.q-field--outlined .q-field__control) {
    border-radius: 10px !important;
  }
}

.invoice-compose-address,
.invoice-compose-base-units {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
