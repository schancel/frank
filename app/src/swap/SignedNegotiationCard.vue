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
    return { status: negotiationCommandStatus }
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
