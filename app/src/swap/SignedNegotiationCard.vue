<template>
  <section
    class="signed-negotiation-card"
    data-testid="signed-negotiation-card"
    :aria-label="$t('signedSwap.title')"
  >
    <div class="snc-header">
      <strong class="snc-title">{{ $t('signedSwap.title') }}</strong>
      <p role="status" class="snc-status-pill" :class="`snc-status--${state}`">
        {{ $t(`signedSwap.states.${state}`) }}
      </p>
    </div>
    <p class="snc-subtitle">{{ $t('signedSwap.negotiationOnly') }}</p>
    <p
      v-if="
        journal?.reduction.history.decision &&
        !journal.reduction.violation &&
        state !== journal.reduction.history.decision
      "
      class="snc-decision-note"
    >
      {{ $t(`signedSwap.states.${journal.reduction.history.decision}`) }}
    </p>
    <div v-if="offer" class="snc-terms-box">
      <p class="snc-leg-row">
        <span class="snc-leg-amount">
          {{ amount(offer.terms.xecPrincipal, xec.nativeDecimals!) }}
          {{ xec.unit }}
        </span>
        <span class="snc-leg-dot">·</span>
        <span class="snc-leg-chain">{{ xec.name }}</span>
      </p>
      <p class="snc-leg-row">
        <span class="snc-leg-amount">
          {{ amount(offer.terms.evmPrincipal, evm.nativeDecimals!) }}
          {{ evm.unit }}
        </span>
        <span class="snc-leg-dot">·</span>
        <span class="snc-leg-chain">{{ evm.name }}</span>
      </p>
      <p class="snc-expiry-row">
        {{
          new Date(Number(offer.terms.expiry) * 1000).toLocaleString(
            undefined,
            { timeZoneName: 'short' },
          )
        }}
      </p>
    </div>
    <p v-if="error" role="alert" class="snc-error-banner">
      {{ $t('signedSwap.error') }}: {{ $t(`signedSwap.errors.${error}`) }}
    </p>
    <div v-if="canRespond" class="snc-action-row">
      <q-btn
        unelevated
        no-caps
        class="snc-btn snc-btn--accept"
        :label="$t('signedSwap.accept')"
        :disable="status.busy || responding"
        @click="decision = 'accept'"
      />
      <q-btn
        flat
        no-caps
        class="snc-btn snc-btn--reject"
        :label="$t('signedSwap.reject')"
        :disable="status.busy || responding"
        @click="decision = 'reject'"
      />
    </div>
    <div
      v-if="decision && canRespond"
      class="snc-response-review"
      data-testid="swap-response-review"
    >
      <p class="snc-response-context">
        {{ address }} · {{ conversationId }} · {{ $t('signedSwap.stamp') }}: 0
        {{ $t('signedSwap.baseUnits') }}
      </p>
      <q-btn
        unelevated
        no-caps
        class="snc-btn snc-btn--confirm"
        :label="
          $t('signedSwap.confirmResponse', {
            decision: $t(`signedSwap.${decision}`),
          })
        "
        :loading="status.busy || responding"
        :disable="status.busy || responding"
        @click="respond"
      />
    </div>
    <div
      v-if="showExecutionPanel"
      class="snc-execution-panel"
      data-testid="swap-execution-panel"
    >
      <p
        class="snc-execution-status"
        data-testid="swap-execution-status"
        role="status"
      >
        {{ $t(`chatMessageSwap.${executionStatusKey}`) }}
      </p>
      <div
        v-if="executionRecord"
        class="snc-selected-inputs"
        data-testid="swap-selected-inputs"
      >
        <p
          v-for="inp in executionRecord.xecInputs"
          :key="`${inp.txid}:${inp.vout}`"
          class="snc-input-mono"
        >
          {{ `${inp.txid.slice(0, 12)}:${inp.vout} (${inp.valueSats})` }}
        </p>
        <p class="snc-input-mono">
          {{
            `${executionRecord.evmInput.address} #${executionRecord.evmInput.nonce}`
          }}
        </p>
      </div>
      <p
        v-if="executionRecord && executionRecord.reorgWarning"
        class="snc-error-banner"
        data-testid="swap-reorg-warning"
        role="alert"
      >
        {{ $t('signedSwap.error') }}: {{ executionRecord.reorgWarning }}
      </p>
      <div class="snc-action-row">
        <q-btn
          v-if="canPrepareExecution"
          unelevated
          no-caps
          class="snc-btn snc-btn--primary"
          data-testid="swap-prepare-btn"
          :label="$t('signedSwap.review')"
          :loading="execState.busy || executing"
          :disable="execState.busy || executing"
          @click="prepareExecution"
        />
        <q-btn
          v-if="canFundExecution"
          unelevated
          no-caps
          class="snc-btn snc-btn--accept"
          data-testid="swap-fund-btn"
          :label="
            $t('chatMessageSwap.lockDeposit', {
              amount: amount(offer!.terms.xecPrincipal, xec.nativeDecimals!),
              asset: xec.unit,
            })
          "
          :loading="execState.busy || executing"
          :disable="execState.busy || executing"
          @click="fundExecution"
        />
        <q-btn
          v-if="canCancelExecution"
          flat
          no-caps
          class="snc-btn snc-btn--reject"
          data-testid="swap-cancel-btn"
          :label="$t('chatMessageSwap.cancel')"
          :loading="execState.busy || executing"
          :disable="execState.busy || executing"
          @click="cancelExecution"
        />
        <q-btn
          v-if="canClaimExecution"
          unelevated
          no-caps
          class="snc-btn snc-btn--accept"
          data-testid="swap-claim-btn"
          :label="
            $t('chatMessageSwap.claimFunds', {
              amount: amount(offer!.terms.evmPrincipal, evm.nativeDecimals!),
              asset: evm.unit,
            })
          "
          :loading="execState.busy || executing"
          :disable="execState.busy || executing"
          @click="claimExecution"
        />
        <q-btn
          v-if="canRefundExecution"
          unelevated
          no-caps
          class="snc-btn snc-btn--warning"
          data-testid="swap-refund-btn"
          :label="$t('chatMessageSwap.refundDeposit')"
          :loading="execState.busy || executing"
          :disable="execState.busy || executing"
          @click="refundExecution"
        />
      </div>
    </div>
  </section>
</template>
<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import { addressFromCompressedPubkey, toHex } from '@frank/codec'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import { formatNegotiationAmount } from '@frank/swap-protocol/src/outgoing-negotiation'
import { TESTNET_NEGOTIATION_POLICY } from '@frank/swap-protocol/src/negotiation'
import { negotiationRecoveryStatus } from '../utils/negotiation-recovery'
import { accountSession } from '../accounts/session'
import {
  captureNegotiation,
  sendNegotiation,
  negotiationCommandStatus,
  negotiationUnavailable,
  negotiationErrorCode,
} from './negotiation-commands'
import {
  swapExecutionState,
  getSwapExecutionRecord,
  prepareSwapExecution,
  fundSwapExecution,
  claimSwapExecution,
  refundSwapExecution,
  cancelSwapExecution,
  reconcileSwapExecution,
} from './swap-execution-commands'
export default defineComponent({
  name: 'SignedNegotiationCard',
  props: {
    item: { type: Object as PropType<ApplicationMessageItem>, required: true },
    address: { type: String, required: true },
    conversationId: { type: String, required: true },
    deliveryStatus: { type: String, default: '' },
    senderAddress: { type: String, required: true },
    outbound: { type: Boolean, required: true },
  },
  setup() {
    return { status: negotiationCommandStatus, execState: swapExecutionState }
  },
  data() {
    return {
      decision: null as 'accept' | 'reject' | null,
      error: '',
      responding: false,
      executing: false,
      ticks: 0,
      now: BigInt(Math.floor(Date.now() / 1000)),
      timer: undefined as ReturnType<typeof setInterval> | undefined,
    }
  },
  mounted() {
    this.timer = setInterval(() => {
      this.now = BigInt(Math.floor(Date.now() / 1000))
      this.ticks += 1
      if (
        this.ticks % 5 === 0 &&
        !this.executing &&
        !this.execState.busy &&
        this.swapIdHex &&
        (this.executionRecord?.phase === 'funding' ||
          this.executionRecord?.phase === 'claiming' ||
          this.executionRecord?.phase === 'refund-pending')
      ) {
        void reconcileSwapExecution(this.swapIdHex).catch(() => undefined)
      }
    }, 1000)
  },
  beforeUnmount() {
    clearInterval(this.timer)
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
    journal() {
      const value = this.item.value
      if (
        !value ||
        typeof value !== 'object' ||
        !('eventHex' in value) ||
        typeof value.eventHex !== 'string'
      )
        return undefined
      const publicKey = accountSession.getCachedCurvePublicKey('secp256k1')
      return negotiationRecoveryStatus.snapshot?.journals.find(
        j =>
          j.owner.messagingChainIdentifier ===
            TESTNET_NEGOTIATION_POLICY.evmChainIdentifier &&
          publicKey &&
          toHex(j.owner.localPublicKey) === toHex(publicKey) &&
          toHex(j.context.conversationId) ===
            this.conversationId.replace(/-/g, '') &&
          j.entries.some(
            e =>
              toHex(e.eventBytes) === value.eventHex &&
              e.direction ===
                (this.outbound ? 'outbound-replay' : 'incoming') &&
              this.senderAddress.toLowerCase() ===
                '0x' + toHex(addressFromCompressedPubkey(e.senderPublicKey)) &&
              this.address.toLowerCase() ===
                '0x' +
                  toHex(
                    addressFromCompressedPubkey(
                      this.outbound ? e.recipientPublicKey : e.senderPublicKey,
                    ),
                  ),
          ),
      )
    },
    offer() {
      return this.journal?.reduction.history.offer ?? null
    },
    swapIdHex(): string {
      return this.journal ? toHex(this.journal.context.swapId) : ''
    },
    executionRecord() {
      if (!this.swapIdHex) return undefined
      return getSwapExecutionRecord(this.swapIdHex)
    },
    showExecutionPanel(): boolean {
      if (!this.execState.coordinator || !this.offer || !this.journal)
        return false
      return (
        this.state === 'accept' ||
        (!!this.executionRecord &&
          this.journal.reduction.history.decision === 'accept')
      )
    },
    executionStatusKey(): string {
      const phase = this.executionRecord?.phase
      if (!phase || phase === 'prepared' || phase === 'cancelled')
        return 'statusUnfunded'
      if (phase === 'funding' || phase === 'funded' || phase === 'claiming')
        return 'statusLocked'
      if (phase === 'complete') return 'statusWithdrawn'
      if (phase === 'refund-pending' || phase === 'refunded')
        return 'statusRefunded'
      return 'statusExpired'
    },
    canPrepareExecution(): boolean {
      return (
        this.showExecutionPanel &&
        !this.executionRecord &&
        this.state === 'accept'
      )
    },
    canFundExecution(): boolean {
      return (
        this.showExecutionPanel && this.executionRecord?.phase === 'prepared'
      )
    },
    canCancelExecution(): boolean {
      return (
        this.showExecutionPanel &&
        this.executionRecord?.phase === 'prepared' &&
        !this.executionRecord.fundingAuthorized
      )
    },
    canClaimExecution(): boolean {
      if (!this.showExecutionPanel || !this.executionRecord) return false
      const phase = this.executionRecord.phase
      return (
        phase === 'funded' ||
        (!!this.executionRecord.adaptorSecretHex &&
          phase !== 'complete' &&
          phase !== 'refunded' &&
          phase !== 'cancelled')
      )
    },
    canRefundExecution(): boolean {
      if (!this.showExecutionPanel || !this.executionRecord) return false
      const r = this.executionRecord
      if (
        r.phase === 'complete' ||
        r.phase === 'refunded' ||
        r.phase === 'cancelled' ||
        !r.fundingAuthorized
      )
        return false
      return (
        r.phase === 'recovery-required' ||
        r.phase === 'refund-pending' ||
        Number(this.now) >= r.xecRefundTimestamp ||
        Number(this.now) >= r.evmOpeningTimestamp + r.evmChallengeDuration
      )
    },
    state(): string {
      if (negotiationUnavailable()) return negotiationUnavailable()
      if (!this.journal) return 'awaitingAdmission'
      if (this.journal.reduction.violation) return 'conflict'
      if (this.offer && this.now >= this.offer.terms.expiry) return 'expired'
      return (
        this.journal.reduction.history.decision ??
        (this.offer ? 'offered' : 'incomplete')
      )
    },
    canRespond(): boolean {
      const own = accountSession.getCachedCurvePublicKey('secp256k1')
      return (
        this.state === 'offered' &&
        !!own &&
        !!this.journal &&
        toHex(own) === toHex(this.journal.context.parties[1])
      )
    },
  },
  methods: {
    amount: formatNegotiationAmount,
    async prepareExecution() {
      if (this.executing || !this.journal || !this.offer) return
      const own = accountSession.getCachedCurvePublicKey('secp256k1')
      if (!own) return
      this.error = ''
      this.executing = true
      try {
        const ownHex = toHex(own)
        const p0Hex = toHex(this.journal.context.parties[0])
        const p1Hex = toHex(this.journal.context.parties[1])
        const role = ownHex === p0Hex ? 'initiator' : 'responder'
        const peerPublicKey = ownHex === p0Hex ? p1Hex : p0Hex
        await prepareSwapExecution({
          swapId: this.swapIdHex,
          conversationId: this.conversationId,
          peerPublicKey,
          role,
          xecChainIdentifier: TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
          evmChainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
          xecPrincipal: this.offer.terms.xecPrincipal,
          evmPrincipal: this.offer.terms.evmPrincipal,
          expiry: Number(this.offer.terms.expiry),
          nowSec: Number(this.now),
        })
      } catch (e) {
        this.error = negotiationErrorCode(e)
      } finally {
        this.executing = false
      }
    },
    async fundExecution() {
      if (this.executing || !this.swapIdHex) return
      this.error = ''
      this.executing = true
      try {
        await fundSwapExecution(this.swapIdHex)
      } catch (e) {
        this.error = negotiationErrorCode(e)
      } finally {
        this.executing = false
      }
    },
    async cancelExecution() {
      if (this.executing || !this.swapIdHex) return
      this.error = ''
      this.executing = true
      try {
        await cancelSwapExecution(this.swapIdHex)
      } catch (e) {
        this.error = negotiationErrorCode(e)
      } finally {
        this.executing = false
      }
    },
    async claimExecution() {
      if (this.executing || !this.swapIdHex) return
      this.error = ''
      this.executing = true
      try {
        await claimSwapExecution(this.swapIdHex)
      } catch (e) {
        this.error = negotiationErrorCode(e)
      } finally {
        this.executing = false
      }
    },
    async refundExecution() {
      if (this.executing || !this.swapIdHex) return
      this.error = ''
      this.executing = true
      try {
        await refundSwapExecution(this.swapIdHex, Number(this.now))
      } catch (e) {
        this.error = negotiationErrorCode(e)
      } finally {
        this.executing = false
      }
    },
    async respond() {
      if (
        this.responding ||
        !this.canRespond ||
        !this.journal ||
        !this.offer ||
        !this.decision
      )
        return
      this.error = ''
      this.responding = true
      const decision = this.decision
      const address = this.address,
        conversationId = this.conversationId
      const offer = this.offer
      const context = this.journal.context
      try {
        // The actual admitted offer is required even when rendering a response card.
        const { encodeSignedSwapEvent } = await import(
          '@frank/swap-protocol/src'
        )
        const encoded = encodeSignedSwapEvent(offer.event)
        if (!encoded.ok) throw new Error(encoded.error.code)
        const captured = await captureNegotiation({
          address,
          conversationId,
          swapId: context.swapId,
          stampValue: 0n,
          responseContext: context,
        })
        if (this.address !== address || this.conversationId !== conversationId)
          throw new Error('Conversation changed during response')
        await sendNegotiation(captured, {
          context,
          action: decision,
          offerBytes: encoded.value,
        })
      } catch (e) {
        this.error = negotiationErrorCode(e)
      } finally {
        this.responding = false
      }
    },
  },
})
</script>
<style scoped>
.signed-negotiation-card {
  background: linear-gradient(145deg, #0f172a 0%, #1e293b 100%);
  color: #f8fafc;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-left: 4px solid #38bdf8;
  border-radius: 16px;
  padding: 14px 16px;
  min-width: 270px;
  max-width: 420px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.28);
  text-align: left;
}

.snc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.snc-title {
  font-size: 1rem;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: #ffffff;
}

.snc-status-pill {
  margin: 0;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  background: rgba(56, 189, 248, 0.16);
  color: #7dd3fc;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.snc-status--accept {
  background: rgba(16, 185, 129, 0.18);
  color: #6ee7b7;
  border-color: rgba(16, 185, 129, 0.35);
}

.snc-status--reject,
.snc-status--expired,
.snc-status--conflict,
.snc-status--storage-error {
  background: rgba(239, 68, 68, 0.18);
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.35);
}

.snc-subtitle {
  margin: 0 0 10px;
  font-size: 0.76rem;
  line-height: 1.4;
  color: #94a3b8;
}

.snc-decision-note {
  margin: 0 0 8px;
  padding: 5px 9px;
  border-radius: 8px;
  font-size: 0.76rem;
  background: rgba(255, 255, 255, 0.06);
  color: #cbd5e1;
}

.snc-terms-box {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.snc-leg-row {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.snc-leg-amount {
  font-size: 1.05rem;
  font-weight: 800;
  color: #ffffff;
}

.snc-leg-dot {
  color: #64748b;
}

.snc-leg-chain {
  font-size: 0.78rem;
  font-weight: 600;
  color: #94a3b8;
}

.snc-expiry-row {
  margin: 2px 0 0;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  font-size: 0.75rem;
  color: #cbd5e1;
}

.snc-meta-row {
  margin: 0 0 8px;
  font-size: 0.76rem;
  color: #cbd5e1;
}

.snc-error-banner {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 0.78rem;
  background: rgba(239, 68, 68, 0.18);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.35);
}

.snc-action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.snc-btn {
  border-radius: 999px;
  font-weight: 700;
  font-size: 0.8rem;
  padding: 4px 14px;
}

.snc-btn--accept {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  color: #ffffff;
}

.snc-btn--reject {
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
}

.snc-btn--primary,
.snc-btn--confirm {
  background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
  color: #ffffff;
}

.snc-btn--warning {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  color: #ffffff;
}

.snc-response-review {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(56, 189, 248, 0.35);
}

.snc-response-context {
  margin: 0 0 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem;
  color: #94a3b8;
  word-break: break-all;
}

.snc-execution-panel {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}

.snc-execution-status {
  margin: 0 0 6px;
  font-size: 0.8rem;
  font-weight: 700;
  color: #38bdf8;
}

.snc-selected-inputs {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 8px;
  padding: 6px 8px;
  margin-bottom: 8px;
}

.snc-input-mono {
  margin: 2px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
  color: #cbd5e1;
}
</style>
