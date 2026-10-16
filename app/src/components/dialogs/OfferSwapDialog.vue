<template>
  <q-card class="q-px-sm q-pb-md dialog-medium" data-testid="offer-swap-dialog">
    <q-card-section>
      <div class="text-h6">{{ $t('signedSwap.title') }}</div>
      <p>{{ $t('signedSwap.negotiationOnly') }}</p>
      <p v-if="contact?.name">{{ contact.name }}</p>
      <p>{{ address }} · {{ conversationId }}</p>
      <p v-if="conversationName">{{ conversationName }}</p>
      <p v-if="unavailable" role="status">
        {{ $t(`signedSwap.states.${unavailable}`) }}
      </p>
      <p v-if="status.error || error" role="alert">
        {{ $t('signedSwap.error') }}:
        {{ $t(`signedSwap.errors.${error || status.error}`) }}
      </p>
    </q-card-section>
    <q-card-section v-if="!reviewed">
      <q-input
        v-model="xecAmount"
        :label="
          $t('signedSwap.offerAmount', { network: xec.name, unit: xec.unit })
        "
        inputmode="decimal"
        data-testid="swap-xec-amount"
      />
      <q-input
        v-model="evmAmount"
        :label="
          $t('signedSwap.requestAmount', { network: evm.name, unit: evm.unit })
        "
        inputmode="decimal"
        data-testid="swap-evm-amount"
      />
      <q-input
        v-model="expiryInput"
        type="datetime-local"
        :label="$t('signedSwap.expiry', { timezone })"
        data-testid="swap-expiry"
      />
      <q-btn
        :label="$t('signedSwap.review')"
        :disable="!!unavailable || status.busy || reviewing"
        :loading="reviewing"
        data-testid="swap-review"
        @click="review"
      />
    </q-card-section>
    <q-card-section v-else data-testid="swap-review-panel">
      <p>
        {{
          $t('signedSwap.offerAmount', { network: xec.name, unit: xec.unit })
        }}: {{ xecAmount }}
      </p>
      <p>
        {{
          $t('signedSwap.requestAmount', { network: evm.name, unit: evm.unit })
        }}: {{ evmAmount }}
      </p>
      <p>{{ $t('signedSwap.expiry', { timezone }) }}: {{ expiryDisplay }}</p>
      <p>
        {{ $t('signedSwap.stamp') }}: {{ reviewed.capture.stampValueWei }}
        {{ $t('signedSwap.baseUnits') }}
      </p>
      <q-btn
        :label="$t('signedSwap.propose')"
        :loading="status.busy"
        :disable="!!unavailable || status.busy"
        data-testid="swap-propose"
        @click="propose"
      />
    </q-card-section>
    <q-card-actions>
      <q-btn
        flat
        :label="$t('signedSwap.newOffer')"
        :disable="status.busy"
        @click="newOffer"
      />
      <q-btn flat :label="$t('offerSwapDialog.cancelBtnLabel')" v-close-popup />
    </q-card-actions>
    <q-card-section>
      <details data-testid="swap-pending">
        <summary>{{ $t('signedSwap.pending') }}</summary>
        <div v-for="record in pending" :key="record.intentKey">
          <span
            >{{ $t(`signedSwap.phases.${record.phase}`) }} ·
            {{ pendingTerms(record) }}</span
          >
          <q-btn
            :label="$t('signedSwap.resume')"
            :disable="!!unavailable || status.busy"
            @click="resume(record)"
          />
        </div>
      </details>
      <details data-testid="swap-history">
        <summary>{{ $t('signedSwap.history') }}</summary>
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
  emits: ['newOffer'],
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
  },
  methods: {
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
      } catch (e) {
        this.status.error = negotiationErrorCode(e)
      }
      await this.loadPending()
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
      } catch {
        /* Durable error is displayed across reopening. */
      } finally {
        await this.loadPending()
      }
    },
    newOffer() {
      this.reviewed = null
      this.error = ''
      this.$emit('newOffer')
    },
  },
})
</script>
