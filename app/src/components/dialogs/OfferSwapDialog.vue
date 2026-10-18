<template>
  <q-card
    class="offer-swap-dialog dialog-medium"
    data-testid="offer-swap-dialog"
  >
    <q-card-section class="swap-dialog-header">
      <div class="swap-dialog-title-row">
        <div class="swap-dialog-icon-badge">
          <q-icon name="swap_horiz" size="22px" />
        </div>
        <div class="swap-dialog-title-col">
          <div class="swap-dialog-title">{{ $t('signedSwap.title') }}</div>
          <p v-if="contact?.name" class="swap-dialog-contact">
            {{ contact.name }}
          </p>
          <p v-if="conversationName" class="swap-dialog-subtitle">
            {{ conversationName }}
          </p>
        </div>
        <span
          role="button"
          tabindex="0"
          class="swap-dialog-close-btn"
          v-close-popup
          @click="$emit('close')"
        >
          <q-icon name="close" size="18px" />
        </span>
      </div>

      <p class="swap-dialog-notice">{{ $t('signedSwap.negotiationOnly') }}</p>
      <p class="swap-dialog-context-pill">
        {{ address }} · {{ conversationId }}
      </p>

      <p
        v-if="unavailable"
        role="status"
        class="swap-dialog-banner swap-dialog-banner--status"
      >
        <q-icon name="info" size="16px" class="q-mr-xs" />
        <span>{{ $t(`signedSwap.states.${unavailable}`) }}</span>
      </p>
      <p
        v-if="status.error || error"
        role="alert"
        class="swap-dialog-banner swap-dialog-banner--error"
      >
        <q-icon name="error_outline" size="16px" class="q-mr-xs" />
        <span>
          {{ $t('signedSwap.error') }}:
          {{ $t(`signedSwap.errors.${error || status.error}`) }}
        </span>
      </p>
    </q-card-section>

    <q-card-section v-if="!reviewed" class="swap-dialog-body">
      <div class="swap-leg-group">
        <q-input
          v-model="xecAmount"
          outlined
          dense
          :label="
            $t('signedSwap.offerAmount', { network: xec.name, unit: xec.unit })
          "
          inputmode="decimal"
          class="swap-field"
          data-testid="swap-xec-amount"
        />
        <div class="swap-direction-divider">
          <span class="swap-direction-badge">
            <q-icon name="swap_vert" size="16px" />
          </span>
        </div>
        <q-input
          v-model="evmAmount"
          outlined
          dense
          :label="
            $t('signedSwap.requestAmount', {
              network: evm.name,
              unit: evm.unit,
            })
          "
          inputmode="decimal"
          class="swap-field"
          data-testid="swap-evm-amount"
        />
      </div>

      <div class="swap-expiry-group">
        <q-input
          v-model="expiryInput"
          outlined
          dense
          type="datetime-local"
          stack-label
          :label="$t('signedSwap.expiry', { timezone })"
          class="swap-field"
          data-testid="swap-expiry"
        />
        <div class="swap-expiry-presets">
          <span
            v-for="preset in expiryPresets"
            :key="preset.hours"
            role="button"
            tabindex="0"
            class="swap-preset-chip"
            :data-testid="`swap-expiry-preset-${preset.hours}h`"
            @click="applyExpiryPreset(preset.hours)"
          >
            {{ preset.label }}
          </span>
        </div>
      </div>
    </q-card-section>

    <q-card-section
      v-else
      class="swap-dialog-body"
      data-testid="swap-review-panel"
    >
      <div class="swap-review-ticket">
        <div class="swap-review-row">
          <p class="swap-review-line">
            <span class="swap-review-label">{{
              $t('signedSwap.offerAmount', {
                network: xec.name,
                unit: xec.unit,
              })
            }}</span
            >:
            <strong class="swap-review-value">{{ xecAmount }}</strong>
          </p>
        </div>
        <div class="swap-review-row">
          <p class="swap-review-line">
            <span class="swap-review-label">{{
              $t('signedSwap.requestAmount', {
                network: evm.name,
                unit: evm.unit,
              })
            }}</span
            >:
            <strong class="swap-review-value">{{ evmAmount }}</strong>
          </p>
        </div>
        <div class="swap-review-row">
          <p class="swap-review-line">
            <span class="swap-review-label">{{
              $t('signedSwap.expiry', { timezone })
            }}</span
            >:
            <strong class="swap-review-value">{{ expiryDisplay }}</strong>
          </p>
        </div>
        <div class="swap-review-row swap-review-row--muted">
          <p class="swap-review-line">
            <span class="swap-review-label">{{ $t('signedSwap.stamp') }}</span
            >:
            <span class="swap-review-mono">
              {{ reviewed.capture.stampValueWei }}
              {{ $t('signedSwap.baseUnits') }}
            </span>
          </p>
        </div>
      </div>
    </q-card-section>

    <q-card-actions class="swap-dialog-actions">
      <div class="swap-dialog-secondary-actions">
        <q-btn
          flat
          no-caps
          class="swap-btn-secondary"
          :label="$t('offerSwapDialog.cancelBtnLabel')"
          v-close-popup
          @click="$emit('close')"
        />
        <q-btn
          flat
          no-caps
          class="swap-btn-secondary"
          :label="$t('signedSwap.newOffer')"
          :disable="status.busy"
          @click="newOffer"
        />
      </div>
      <q-btn
        v-if="!reviewed"
        unelevated
        no-caps
        class="swap-btn-primary"
        :label="$t('signedSwap.review')"
        :disable="!!unavailable || status.busy || reviewing"
        :loading="reviewing"
        data-testid="swap-review"
        @click="review"
      />
      <q-btn
        v-else
        unelevated
        no-caps
        class="swap-btn-primary"
        :label="$t('signedSwap.propose')"
        :loading="status.busy"
        :disable="!!unavailable || status.busy"
        data-testid="swap-propose"
        @click="propose"
      />
    </q-card-actions>

    <q-card-section class="swap-dialog-drawers">
      <details class="swap-drawer" data-testid="swap-pending">
        <summary class="swap-drawer-summary">
          <span>{{ $t('signedSwap.pending') }}</span>
          <span class="swap-drawer-count">{{ pending.length }}</span>
        </summary>
        <div class="swap-drawer-content">
          <div
            v-for="record in pending"
            :key="record.intentKey"
            class="swap-pending-item"
          >
            <span class="swap-pending-text"
              >{{ $t(`signedSwap.phases.${record.phase}`) }} ·
              {{ pendingTerms(record) }}</span
            >
            <q-btn
              unelevated
              dense
              no-caps
              class="swap-btn-resume"
              :label="$t('signedSwap.resume')"
              :disable="!!unavailable || status.busy"
              @click="resume(record)"
            />
          </div>
        </div>
      </details>
      <details class="swap-drawer" data-testid="swap-history">
        <summary class="swap-drawer-summary">
          <span>{{ $t('signedSwap.history') }}</span>
          <span class="swap-drawer-count">{{ history.length }}</span>
        </summary>
        <div class="swap-drawer-content">
          <signed-negotiation-card
            v-for="entry in history"
            :key="entry.eventHex"
            :item="{
              type: 'application',
              itemType: 'swap-negotiation-v1',
              value: { eventHex: entry.eventHex },
            }"
            :address="address"
            :conversation-id="conversationId"
            delivery-status=""
            :sender-address="entry.senderAddress"
            :outbound="entry.outbound"
          />
        </div>
      </details>
    </q-card-section>
  </q-card>
</template>
<script lang="ts">
import { defineComponent, markRaw, type PropType } from 'vue'
import { addressFromCompressedPubkey, fromHex, toHex } from '@frank/codec'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import {
  parseNegotiationAmount,
  decodeLocalNegotiationIntent,
  formatNegotiationAmount,
  type NegotiationRecord,
  type LocalNegotiationIntent,
} from '@frank/swap-protocol/src/outgoing-negotiation'
import {
  TESTNET_NEGOTIATION_POLICY,
  decodeNegotiationEventStandalone,
} from '@frank/swap-protocol/src/negotiation'
import {
  captureNegotiation,
  sendNegotiation,
  negotiationCommandStatus,
  negotiationUnavailable,
  negotiationErrorCode,
  type CapturedNegotiation,
} from '../../swap/negotiation-commands'
import { negotiationRecoveryStatus } from '../../utils/negotiation-recovery'
import { store } from '../../adapters/level-message-store'
import { accountSession } from '../../accounts/session'
import SignedNegotiationCard from '../../swap/SignedNegotiationCard.vue'
export default defineComponent({
  name: 'OfferSwapDialog',
  components: { SignedNegotiationCard },
  props: {
    address: { type: String, required: true },
    conversationId: { type: String, required: true },
    contact: { type: Object, default: () => ({}) },
    swapId: { type: Object as PropType<Uint8Array>, required: true },
    stampValue: { type: String, required: true },
    stampUnavailable: { type: String, default: '' },
    conversationName: { type: String, default: '' },
  },
  emits: ['newOffer', 'close'],
  setup() {
    return { status: negotiationCommandStatus }
  },
  data() {
    return {
      xecAmount: '',
      evmAmount: '',
      expiryInput: '',
      error: '',
      reviewing: false,
      pending: [] as readonly NegotiationRecord[],
      reviewed: null as {
        capture: CapturedNegotiation
        intent: LocalNegotiationIntent
      } | null,
    }
  },
  mounted() {
    void this.loadPending()
  },
  computed: {
    xec() {
      return getChainRegistryEntry(
        TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
      )!
    },
    evm() {
      return getChainRegistryEntry(
        TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
      )!
    },
    timezone(): string {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    unavailable(): string {
      return this.stampUnavailable ? 'unsupported' : negotiationUnavailable()
    },
    expiryDisplay(): string {
      return new Date(this.expiryInput).toLocaleString(undefined, {
        timeZoneName: 'short',
      })
    },
    expiryPresets(): readonly { hours: number; label: string }[] {
      return [
        { hours: 1, label: '+1h' },
        { hours: 24, label: '+24h' },
        { hours: 168, label: '+7d' },
      ]
    },
    history() {
      return (negotiationRecoveryStatus.snapshot?.journals ?? [])
        .filter(
          j =>
            toHex(j.context.conversationId) ===
            this.conversationId.replace(/-/g, ''),
        )
        .flatMap(j =>
          j.entries.map(e => ({
            eventHex: toHex(e.eventBytes),
            senderAddress:
              '0x' + toHex(addressFromCompressedPubkey(e.senderPublicKey)),
            outbound: e.direction === 'outbound-replay',
          })),
        )
    },
  },
  watch: {
    address() {
      this.reviewed = null
    },
    conversationId() {
      this.reviewed = null
    },
    swapId() {
      this.reviewed = null
    },
    xecAmount() {
      this.clearTransientError()
    },
    evmAmount() {
      this.clearTransientError()
    },
    expiryInput() {
      this.clearTransientError()
    },
  },
  methods: {
    clearTransientError() {
      if (this.error) this.error = ''
      if (this.status.error) this.status.error = ''
    },
    applyExpiryPreset(hours: number) {
      const target = new Date(Date.now() + hours * 3600 * 1000)
      const pad = (n: number) => String(n).padStart(2, '0')
      this.expiryInput = `${target.getFullYear()}-${pad(
        target.getMonth() + 1,
      )}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(
        target.getMinutes(),
      )}`
    },
    pendingTerms(record: NegotiationRecord): string {
      try {
        const intent = decodeLocalNegotiationIntent(fromHex(record.intentHex))
        const decoded =
          intent.action === 'offer'
            ? null
            : decodeNegotiationEventStandalone(
                intent.offerBytes,
                intent.context,
              )
        const terms =
          intent.action === 'offer'
            ? intent
            : decoded?.ok && decoded.value.kind === 'offer'
            ? decoded.value.terms
            : null
        if (!terms) return this.$t('signedSwap.errors.invalidIntent')
        return `${this.$t(
          `signedSwap.actions.${intent.action}`,
        )} · ${formatNegotiationAmount(
          terms.xecPrincipal,
          this.xec.nativeDecimals!,
        )} ${this.xec.unit} / ${formatNegotiationAmount(
          terms.evmPrincipal,
          this.evm.nativeDecimals!,
        )} ${this.evm.unit} · ${new Date(
          Number(terms.expiry) * 1000,
        ).toLocaleString(undefined, { timeZoneName: 'short' })}`
      } catch {
        return this.$t('signedSwap.errors.invalidIntent')
      }
    },
    async loadPending() {
      try {
        const accountId =
          accountSession.state.account?.receipt.context.accountId
        if (!accountId) return
        const conversationId = this.conversationId
        const revision = accountSession.state.revision
        const records = await (
          await store
        ).outgoingApplicationMessages({ accountId })
        if (
          accountSession.state.account?.receipt.context.accountId !==
            accountId ||
          accountSession.state.revision !== revision ||
          this.conversationId !== conversationId
        )
          return
        this.pending = records.filter(r => r.conversationId === conversationId)
      } catch (e) {
        this.status.error = negotiationErrorCode(e)
      }
    },
    async resume(record: NegotiationRecord) {
      try {
        const intent = decodeLocalNegotiationIntent(fromHex(record.intentHex))
        const capture = await captureNegotiation({
          address: this.address,
          conversationId: this.conversationId,
          swapId: intent.context.swapId,
          stampValue: BigInt(record.stampValueWei),
          responseContext: intent.context,
        })
        await sendNegotiation(capture, intent)
        this.$emit('close')
      } catch (e) {
        this.status.error = negotiationErrorCode(e)
        await this.loadPending()
      }
    },
    async review() {
      if (this.reviewing) return
      this.reviewing = true
      this.error = ''
      this.status.error = ''
      try {
        const xecPrincipal = parseNegotiationAmount(
          this.xecAmount,
          this.xec.nativeDecimals!,
          64,
        )
        const evmPrincipal = parseNegotiationAmount(
          this.evmAmount,
          this.evm.nativeDecimals!,
          256,
        )
        if (!this.expiryInput) throw new Error('Select expiry')
        const ms = new Date(this.expiryInput).getTime()
        if (!Number.isFinite(ms) || ms <= Date.now())
          throw new Error('Negotiation expired')
        const original = {
          address: this.address,
          conversationId: this.conversationId,
          swapId: this.swapId,
          stampValue: BigInt(this.stampValue),
          xecAmount: this.xecAmount,
          evmAmount: this.evmAmount,
          expiryInput: this.expiryInput,
        }
        const capture = await captureNegotiation(original)
        if (
          this.address !== original.address ||
          this.conversationId !== original.conversationId ||
          this.swapId !== original.swapId ||
          this.xecAmount !== original.xecAmount ||
          this.evmAmount !== original.evmAmount ||
          this.expiryInput !== original.expiryInput
        )
          throw new Error('Conversation changed during review')
        this.reviewed = markRaw({
          capture,
          intent: {
            action: 'offer' as const,
            context: capture.context,
            xecPrincipal,
            evmPrincipal,
            expiry: BigInt(Math.floor(ms / 1000)),
          },
        })
      } catch (e) {
        this.error = negotiationErrorCode(e)
        this.status.error = this.error
      } finally {
        this.reviewing = false
      }
    },
    async propose() {
      if (!this.reviewed) return
      try {
        await sendNegotiation(this.reviewed.capture, this.reviewed.intent)
        this.reviewed = null
        this.$emit('newOffer')
        this.$emit('close')
      } catch {
        /* Durable error is displayed across reopening. */
        await this.loadPending()
      }
    },
    newOffer() {
      this.reviewed = null
      this.error = ''
      this.status.error = ''
      this.$emit('newOffer')
    },
  },
})
</script>
<style scoped>
.offer-swap-dialog {
  width: min(500px, 94vw);
  max-width: 500px;
  border-radius: 18px !important;
  background: #ffffff;
  color: #0f172a;
  border: 1px solid rgba(15, 23, 42, 0.12);
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.22);
  overflow: hidden;
}

:global(.body--dark) .offer-swap-dialog {
  background: #0f172a;
  color: #f8fafc;
  border-color: rgba(255, 255, 255, 0.14);
}

.offer-swap-dialog :deep(.q-field--outlined .q-field__control) {
  border-radius: 12px !important;
}

.swap-dialog-header {
  padding: 18px 20px 12px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
}

:global(.body--dark) .swap-dialog-header {
  border-bottom-color: rgba(255, 255, 255, 0.08);
}

.swap-dialog-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.swap-dialog-icon-badge {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(135deg, #ea580c 0%, #f97316 100%);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(234, 88, 12, 0.28);
}

.swap-dialog-title-col {
  flex: 1;
  min-width: 0;
}

.swap-dialog-title {
  font-size: 1.15rem;
  font-weight: 800;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.swap-dialog-contact {
  margin: 2px 0 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #ea580c;
}

:global(.body--dark) .swap-dialog-contact {
  color: #fb923c;
}

.swap-dialog-subtitle {
  margin: 2px 0 0;
  font-size: 0.78rem;
  color: #64748b;
}

.swap-dialog-close-btn {
  color: #64748b;
}

.swap-dialog-notice {
  margin: 0 0 8px;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #475569;
}

:global(.body--dark) .swap-dialog-notice {
  color: #94a3b8;
}

.swap-dialog-context-pill {
  margin: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: #f1f5f9;
  color: #475569;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem;
  line-height: 1.35;
  word-break: break-all;
}

:global(.body--dark) .swap-dialog-context-pill {
  background: rgba(255, 255, 255, 0.06);
  color: #94a3b8;
}

.swap-dialog-banner {
  margin: 10px 0 0;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 0.8rem;
  line-height: 1.4;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.swap-dialog-banner--status {
  background: rgba(59, 130, 246, 0.1);
  color: #1d4ed8;
  border: 1px solid rgba(59, 130, 246, 0.25);
}

:global(.body--dark) .swap-dialog-banner--status {
  background: rgba(59, 130, 246, 0.16);
  color: #93c5fd;
}

.swap-dialog-banner--error {
  background: rgba(239, 68, 68, 0.1);
  color: #b91c1c;
  border: 1px solid rgba(239, 68, 68, 0.28);
}

:global(.body--dark) .swap-dialog-banner--error {
  background: rgba(239, 68, 68, 0.18);
  color: #fca5a5;
}

.swap-dialog-body {
  padding: 16px 20px 8px;
}

.swap-leg-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.swap-direction-divider {
  display: flex;
  justify-content: center;
  margin: -2px 0;
}

.swap-direction-badge {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  border: 1px solid rgba(15, 23, 42, 0.1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

:global(.body--dark) .swap-direction-badge {
  background: #1e293b;
  color: #cbd5e1;
  border-color: rgba(255, 255, 255, 0.12);
}

.swap-expiry-group {
  margin-top: 14px;
}

.swap-expiry-presets {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.swap-preset-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 11px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  background: rgba(234, 88, 12, 0.1);
  color: #c2410c;
  border: 1px solid rgba(234, 88, 12, 0.24);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease, transform 0.1s ease;
}

.swap-preset-chip:hover {
  background: rgba(234, 88, 12, 0.18);
}

:global(.body--dark) .swap-preset-chip {
  background: rgba(249, 115, 22, 0.16);
  color: #fdba74;
  border-color: rgba(249, 115, 22, 0.3);
}

.swap-review-ticket {
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.1);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

:global(.body--dark) .swap-review-ticket {
  background: #1e293b;
  border-color: rgba(255, 255, 255, 0.12);
}

.swap-review-row {
  padding-bottom: 8px;
  border-bottom: 1px dashed rgba(15, 23, 42, 0.1);
}

:global(.body--dark) .swap-review-row {
  border-bottom-color: rgba(255, 255, 255, 0.1);
}

.swap-review-row:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.swap-review-line {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.45;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.swap-review-label {
  color: #64748b;
  font-weight: 500;
}

:global(.body--dark) .swap-review-label {
  color: #94a3b8;
}

.swap-review-value {
  font-weight: 700;
  color: #0f172a;
}

:global(.body--dark) .swap-review-value {
  color: #f8fafc;
}

.swap-review-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.76rem;
  color: #475569;
}

:global(.body--dark) .swap-review-mono {
  color: #cbd5e1;
}

.swap-dialog-actions {
  padding: 12px 20px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.swap-dialog-secondary-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.swap-btn-secondary {
  border-radius: 999px;
  font-weight: 600;
  color: #64748b;
  padding: 4px 12px;
}

:global(.body--dark) .swap-btn-secondary {
  color: #94a3b8;
}

.swap-btn-primary {
  border-radius: 999px;
  padding: 6px 20px;
  font-weight: 700;
  background: linear-gradient(135deg, #ea580c 0%, #c2410c 100%);
  color: #ffffff;
  box-shadow: 0 4px 14px rgba(234, 88, 12, 0.3);
}

.swap-dialog-drawers {
  padding: 0 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.swap-drawer {
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.08);
  padding: 8px 12px;
}

:global(.body--dark) .swap-drawer {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

.swap-drawer-summary {
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
  display: flex;
  align-items: center;
  justify-content: space-between;
  list-style: none;
}

:global(.body--dark) .swap-drawer-summary {
  color: #94a3b8;
}

.swap-drawer-count {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.7rem;
  background: rgba(15, 23, 42, 0.08);
}

:global(.body--dark) .swap-drawer-count {
  background: rgba(255, 255, 255, 0.1);
}

.swap-drawer-content {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.swap-pending-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.78rem;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.04);
}

:global(.body--dark) .swap-pending-item {
  background: rgba(255, 255, 255, 0.05);
}

.swap-btn-resume {
  border-radius: 999px;
  background: #ea580c;
  color: #ffffff;
  font-size: 0.74rem;
  padding: 2px 10px;
}
</style>
