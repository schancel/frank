<template>
  <section
    data-testid="signed-negotiation-card"
    :aria-label="$t('signedSwap.title')"
  >
    <strong>{{ $t('signedSwap.title') }}</strong>
    <p>{{ $t('signedSwap.negotiationOnly') }}</p>
    <p role="status">{{ $t(`signedSwap.states.${state}`) }}</p>
    <p
      v-if="
        journal?.reduction.history.decision &&
        !journal.reduction.violation &&
        state !== journal.reduction.history.decision
      "
    >
      {{ $t(`signedSwap.states.${journal.reduction.history.decision}`) }}
    </p>
    <template v-if="offer">
      <p>
        {{ amount(offer.terms.xecPrincipal, xec.nativeDecimals!) }}
        {{ xec.unit }} · {{ xec.name }}
      </p>
      <p>
        {{ amount(offer.terms.evmPrincipal, evm.nativeDecimals!) }}
        {{ evm.unit }} · {{ evm.name }}
      </p>
      <p>
        {{
          new Date(Number(offer.terms.expiry) * 1000).toLocaleString(
            undefined,
            { timeZoneName: 'short' },
          )
        }}
      </p>
    </template>
    <p v-if="deliveryStatus">
      {{ $t('signedSwap.delivery') }}:
      {{ $t(`signedSwap.deliveryStates.${deliveryStatus}`) }}
    </p>
    <p v-if="error" role="alert">
      {{ $t('signedSwap.error') }}: {{ $t(`signedSwap.errors.${error}`) }}
    </p>
    <template v-if="canRespond">
      <q-btn
        :label="$t('signedSwap.accept')"
        :disable="status.busy || responding"
        @click="decision = 'accept'"
      />
      <q-btn
        :label="$t('signedSwap.reject')"
        :disable="status.busy || responding"
        @click="decision = 'reject'"
      />
    </template>
    <div v-if="decision && canRespond" data-testid="swap-response-review">
      <p>
        {{ address }} · {{ conversationId }} · {{ $t('signedSwap.stamp') }}: 0
        {{ $t('signedSwap.baseUnits') }}
      </p>
      <q-btn
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
    <div v-if="showExecutionPanel" data-testid="swap-execution-panel">
      <p data-testid="swap-execution-status" role="status">
        {{ $t(`chatMessageSwap.${executionStatusKey}`) }}
      </p>
      <div v-if="executionRecord" data-testid="swap-selected-inputs">
        <p
          v-for="inp in executionRecord.xecInputs"
          :key="`${inp.txid}:${inp.vout}`"
        >
          {{ `${inp.txid.slice(0, 12)}:${inp.vout} (${inp.valueSats})` }}
        </p>
        <p>
          {{
            `${executionRecord.evmInput.address} #${executionRecord.evmInput.nonce}`
          }}
        </p>
      </div>
      <p
        v-if="executionRecord && executionRecord.reorgWarning"
        data-testid="swap-reorg-warning"
        role="alert"
      >
        {{ $t('signedSwap.error') }}: {{ executionRecord.reorgWarning }}
      </p>
      <q-btn
        v-if="canPrepareExecution"
        data-testid="swap-prepare-btn"
        :label="$t('signedSwap.review')"
        :loading="execState.busy || executing"
        :disable="execState.busy || executing"
        @click="prepareExecution"
      />
      <q-btn
        v-if="canFundExecution"
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
        data-testid="swap-cancel-btn"
        :label="$t('chatMessageSwap.cancel')"
        :loading="execState.busy || executing"
        :disable="execState.busy || executing"
        @click="cancelExecution"
      />
      <q-btn
        v-if="canClaimExecution"
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
        data-testid="swap-refund-btn"
        :label="$t('chatMessageSwap.refundDeposit')"
        :loading="execState.busy || executing"
        :disable="execState.busy || executing"
        @click="refundExecution"
      />
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
} from './swap-execution-commands'
export default defineComponent({
  name: 'SignedNegotiationCard',
  props: {
    item: { type: Object as PropType<ApplicationMessageItem>, required: true },
    address: { type: String, required: true },
    conversationId: { type: String, required: true },
    deliveryStatus: { type: String, required: true },
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
      now: BigInt(Math.floor(Date.now() / 1000)),
      timer: undefined as ReturnType<typeof setInterval> | undefined,
    }
  },
  mounted() {
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
