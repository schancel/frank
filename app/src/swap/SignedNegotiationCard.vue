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
    <p class="snc-subtitle">{{ $t('signedSwap.negotiationOnly', units) }}</p>
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
      <p class="snc-expiry-row" data-testid="swap-deadline-accept">
        {{ $t('signedSwap.deadlines.acceptBy') }}:
        {{ when(offer.terms.expiry) }}
      </p>
      <p class="snc-deadline-row" data-testid="swap-deadline-evm">
        {{ $t('signedSwap.deadlines.lockExpires', { unit: evm.unit }) }}:
        {{ when(offer.terms.evmExpiry) }}
      </p>
      <p class="snc-deadline-row" data-testid="swap-deadline-xec">
        {{ $t('signedSwap.deadlines.lockExpires', { unit: xec.unit }) }}:
        {{ when(offer.terms.xecRefundTime) }}
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
    <p
      v-if="executionFailed"
      class="snc-error-banner"
      data-testid="swap-execution-failed"
      role="alert"
    >
      {{
        $t(`signedSwap.execution.failures.${execState.failure}`, {
          ...units,
          database: execState.oldDatabase,
        })
      }}
    </p>
    <div
      v-if="showExecutionPanel"
      class="snc-execution-panel"
      data-testid="swap-execution-panel"
    >
      <p
        class="snc-execution-status"
        data-testid="swap-execution-phase"
        role="status"
      >
        {{ phaseText }}
      </p>
      <p
        v-if="view && view.phase === 'invalid' && view.detail"
        class="snc-execution-detail"
        data-testid="swap-execution-detail"
      >
        {{ view.detail }}
      </p>
      <p
        v-for="warning in view?.warnings ?? []"
        :key="warning"
        class="snc-warning-banner"
        :data-testid="`swap-warning-${warning}`"
        role="alert"
      >
        {{ $t(`signedSwap.execution.warnings.${warning}`, units) }}
      </p>
      <p
        v-if="view?.error"
        class="snc-execution-detail"
        data-testid="swap-execution-error"
        :title="view.error"
      >
        {{ $t('signedSwap.execution.retrying') }}
      </p>
      <p
        v-if="observingOnly"
        class="snc-execution-detail"
        data-testid="swap-execution-other-device"
      >
        {{ $t('signedSwap.execution.otherDevice') }}
      </p>
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
  buildResponseIntent,
  captureNegotiation,
  sendNegotiation,
  negotiationCommandStatus,
  negotiationUnavailable,
  negotiationErrorCode,
} from './negotiation-commands'
import { swapExecutionState, swapExecutionView } from './swap-execution-state'
/** Phases in which the swap has ended: nothing is left for any device to do. */
const FINISHED_PHASES = new Set([
  'rejected',
  'expired',
  'claimed',
  'claimedByPeer',
  'complete',
  'lostToRefund',
  'abandoned',
  'refunded',
  'invalid',
  'unsupported',
])
/**
 * One signed swap negotiation and, once it is accepted, the swap's progress. The card has no
 * swap actions: the session's runner (`htlc-swap-execution.ts`) locks, claims and refunds on
 * its own, whether or not this card is on screen; the card shows its snapshot and the deadlines
 * from the signed offer (E, T_B, T_A).
 */
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
      now: BigInt(Math.floor(Date.now() / 1000)),
      timer: undefined as ReturnType<typeof setInterval> | undefined,
    }
  },
  mounted() {
    // Only the clock of the expiry label; the swap itself is the runner's.
    this.timer = setInterval(() => {
      this.now = BigInt(Math.floor(Date.now() / 1000))
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
    units(): { xec: string; evm: string } {
      return { xec: this.xec.unit, evm: this.evm.unit }
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
    view() {
      return this.swapIdHex ? swapExecutionView(this.swapIdHex) : undefined
    },
    // The swap's progress is shown from the offer on: A's lock follows the accept automatically.
    showExecutionPanel(): boolean {
      return (
        !!this.offer &&
        !!this.journal &&
        !this.journal.reduction.violation &&
        (!!this.view || this.execState.status === 'starting')
      )
    },
    phaseText(): string {
      const view = this.view
      if (!view) return this.$t('signedSwap.execution.starting')
      // A's and B's phases have names of their own; the shared ones read the same for both.
      return this.$t(`signedSwap.execution.phases.${view.phase}`, this.units)
    },
    // This device's swaps cannot run (records unavailable, or retired records to delete): said on
    // every offer, since an offer's lock follows its accept.
    executionFailed(): boolean {
      return !!this.execState.failure && !!this.offer
    },
    observingOnly(): boolean {
      return (
        !this.execState.activeDevice &&
        !!this.view &&
        !FINISHED_PHASES.has(this.view.phase)
      )
    },
    state(): string {
      if (negotiationUnavailable()) return negotiationUnavailable()
      if (!this.journal) return 'awaitingAdmission'
      if (this.journal.reduction.violation) return 'conflict'
      const decision = this.journal.reduction.history.decision
      // E bounds the acceptance only: an accepted swap goes on past it.
      if (this.offer && !decision && this.now >= this.offer.terms.expiry)
        return 'expired'
      return decision ?? (this.offer ? 'offered' : 'incomplete')
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
    when(seconds: bigint): string {
      return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
        timeZoneName: 'short',
      })
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
          stampValue: 0n,
        })
        const intent = await buildResponseIntent(
          captured,
          context,
          encoded.value,
          decision,
        )
        if (this.address !== address || this.conversationId !== conversationId)
          throw new Error('Conversation changed during response')
        await sendNegotiation(captured, intent)
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

.snc-execution-detail {
  margin: 0 0 6px;
  font-size: 0.74rem;
  color: #cbd5e1;
}

.snc-deadline-row {
  margin: 0;
  font-size: 0.75rem;
  color: #cbd5e1;
}

.snc-warning-banner {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 0.78rem;
  background: rgba(245, 158, 11, 0.18);
  color: #fcd34d;
  border: 1px solid rgba(245, 158, 11, 0.35);
}
</style>
