<template>
  <div class="q-mb-sm" data-testid="chat-message-stealth">
    <q-card flat bordered class="q-pa-sm" :class="cardBg">
      <!-- Header row: Icon, Title, and Status Badge -->
      <div class="row items-center justify-between q-mb-xs">
        <div class="row items-center">
          <q-icon
            name="visibility_off"
            size="sm"
            color="primary"
            class="q-mr-xs"
          />
          <span
            class="text-weight-bold text-subtitle2"
            data-testid="stealth-title"
          >
            {{ title }}
          </span>
        </div>
        <q-badge :color="statusColor" data-testid="stealth-status-badge">
          {{ displayStatus }}
        </q-badge>
      </div>

      <!-- Amount and Currency row -->
      <div class="q-my-xs row items-baseline">
        <span class="text-h6 text-weight-bold" data-testid="stealth-amount">
          {{ displayAmount }}
        </span>
        <span
          v-if="amountIsClaim"
          class="text-caption text-grey-7 q-ml-xs"
          data-testid="stealth-amount-claimed"
        >
          ({{ $t('chatMessageStealth.claimedAmount') }})
        </span>
        <q-badge
          outline
          color="primary"
          class="q-ml-xs text-weight-bold"
          data-testid="stealth-currency-badge"
        >
          {{ displayUnit }}
        </q-badge>
        <q-badge
          v-if="displayChain"
          outline
          color="secondary"
          class="q-ml-xs"
          data-testid="stealth-chain-badge"
        >
          {{ displayChain }}
        </q-badge>
      </div>

      <!-- Optional Memo -->
      <div
        v-if="memo"
        class="text-caption text-grey-8 q-my-xs text-italic"
        data-testid="stealth-memo"
      >
        "{{ memo }}"
      </div>

      <!-- What the wallet read from the chain, when it differs from what the sender wrote -->
      <div
        v-if="amountMismatch"
        class="text-caption text-warning q-my-xs"
        data-testid="stealth-amount-mismatch"
      >
        {{ amountMismatch }}
      </div>

      <!-- What the wallet says about the money. Nothing is claimed for a sent payment. -->
      <div
        v-if="hint"
        class="row items-center text-caption text-grey-6 q-mt-xs"
      >
        <q-icon
          :name="hintIcon"
          size="xs"
          :color="statusColor"
          class="q-mr-xs"
        />
        <span data-testid="stealth-status-hint">{{ hint }}</span>
      </div>

      <!-- Explorer link (if transaction exists) -->
      <div v-if="primaryTx" class="row items-center q-mt-xs">
        <a
          v-if="explorerUrl"
          :href="explorerUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="row items-center text-caption text-primary stealth-tx-link"
          data-testid="stealth-explorer-link"
        >
          <q-icon name="open_in_new" size="xs" class="q-mr-xs" />
          <span>{{ truncatedTx }}</span>
        </a>
        <span
          v-else
          class="text-caption text-grey-6 font-monospace"
          data-testid="stealth-tx-hash"
        >
          {{ truncatedTx }}
        </span>
      </div>
    </q-card>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, type PropType } from 'vue'
import { useQuasar } from 'quasar'
import { Transaction } from 'ethers'
import { activeChain } from '@frank/wallet/chain'
import { resolveChainIdentifier } from '@frank/wallet/chain/chains-registry'
import { multiChainExplorerUrl } from '../../../utils/explorer'
import { useReceivedPayment } from '../../../composables/useReceivedPayment'
import { useTranslate } from '../../../composables/useTranslate'
import { errorNotify } from '../../../utils/notifications'

type WalletStatus = 'pending' | 'received' | 'not-received' | 'failed'

/**
 * A stealth payment in a conversation. The amount in the item is what the SENDER wrote. Whether
 * money arrived, how much, and whether it can be spent come from the wallet, which reads the
 * chain: `pending` until the chain shows it, `received` then, `not-received` when the chain still
 * shows no such transfer long after the message, `failed` when it can never arrive. Until it is
 * received the amount is labelled as the sender's claim. A payment the wallet holds no coin for is
 * shown as not checked.
 */
export default defineComponent({
  name: 'ChatMessageStealth',
  props: {
    /** The sender's stated amount, in the chain's base unit. A JS number: approximate. */
    amount: {
      type: [Number, String],
      required: true,
    },
    /** The same stated amount exactly (decimal string), when the item carries it. */
    amountWei: {
      type: String,
      default: undefined,
    },
    chainId: {
      type: String,
      default: undefined,
    },
    networkTag: {
      type: String,
      default: undefined,
    },
    /** The item's ephemeral key: what the wallet's coin for this payment is found by. */
    ephemeralPubKey: {
      type: String,
      default: undefined,
    },
    transactions: {
      type: Array as PropType<string[]>,
      default: () => [],
    },
    outbound: {
      type: Boolean,
      default: false,
    },
    memo: {
      type: String,
      default: undefined,
    },
  },
  setup(props) {
    const $q = useQuasar()
    const $t = useTranslate()
    const isDark = computed(() => $q?.dark?.isActive ?? false)
    // A payment this wallet sent is not one it received: the wallet is not asked.
    // The user is told, once, when a payment a sender claimed did not arrive.
    const { payment } = useReceivedPayment(
      () => (props.outbound ? undefined : props.ephemeralPubKey),
      undefined,
      known => {
        const notice = $t('chatMessageStealth.notReceivedNotice', {
          amount: `${activeChain.toDisplayAmount(known.claimedAmountWei)} ${
            activeChain.unit
          }`,
        })
        errorNotify(new Error(notice), { safeMessage: notice })
      },
    )
    return {
      isDark,
      payment,
    }
  },
  computed: {
    cardBg(): string {
      // The card sets its own text colour with its background: inside the sender's bubble it
      // would otherwise inherit the bubble's (white on a near-white card).
      return this.isDark ? 'bg-grey-10 text-white' : 'bg-grey-1 text-dark'
    },
    /** The hash of the transfer the item carries: a bare hash, or a signed transaction's. */
    primaryTx(): string | undefined {
      const first = this.transactions?.[0]
      if (!first) return undefined
      const hex = first.replace(/^0x/, '').toLowerCase()
      if (/^[0-9a-f]{64}$/.test(hex)) return `0x${hex}`
      try {
        return Transaction.from(`0x${hex}`).hash ?? undefined
      } catch {
        return undefined
      }
    },
    truncatedTx(): string {
      const tx = this.primaryTx
      if (!tx) return ''
      return `${tx.slice(0, 8)}...${tx.slice(-6)}`
    },
    networkIdentifier(): string {
      return this.networkTag || this.chainId || 'monad-testnet'
    },
    /** The unit the chain registry gives the payment's network; the active chain's when the
     * item names a network the registry does not know. */
    displayUnit(): string {
      return (
        resolveChainIdentifier(this.networkIdentifier)?.unit ?? activeChain.unit
      )
    },
    displayChain(): string {
      const net = this.networkIdentifier.toLowerCase()
      if (net.includes('sol')) return 'Solana'
      if (net.includes('ecash') || net.includes('xec')) return 'eCash'
      if (net.includes('mon')) return 'Monad'
      return this.networkTag || this.chainId || ''
    },
    /** What the sender stated, exactly where an exact figure exists: the wallet's record of the
     * claim, else the item's exact field, else the item's approximate number. */
    statedWei(): bigint {
      if (!this.outbound && this.payment !== undefined)
        return this.payment.claimedAmountWei
      try {
        return BigInt(this.amountWei ?? this.amount ?? 0)
      } catch {
        return 0n
      }
    },
    /** Never `received` without an amount the chain showed arriving. */
    walletStatus(): WalletStatus | undefined {
      if (this.outbound) return undefined
      const status = this.payment?.status
      return status === 'received' &&
        !((this.payment?.receivedAmountWei ?? 0n) > 0n)
        ? 'pending'
        : status
    },
    /** What arrived, as the chain showed it, once the wallet has seen it. */
    arrivedWei(): bigint | undefined {
      return this.walletStatus === 'received'
        ? this.payment?.receivedAmountWei
        : undefined
    },
    /** Received: the amount the chain showed. Otherwise: what the sender stated. */
    displayAmount(): string {
      return activeChain.toDisplayAmount(this.arrivedWei ?? this.statedWei)
    },
    /** A received payment the chain has not shown: the figure is the sender's claim, and is
     * labelled so. */
    amountIsClaim(): boolean {
      return !this.outbound && this.arrivedWei === undefined
    },
    amountMismatch(): string {
      const arrived = this.arrivedWei
      if (arrived === undefined || arrived === this.statedWei) return ''
      return this.$t('chatMessageStealth.statedAmount', {
        stated: `${activeChain.toDisplayAmount(this.statedWei)} ${
          this.displayUnit
        }`,
        actual: `${activeChain.toDisplayAmount(arrived)} ${this.displayUnit}`,
      }) as string
    },
    title(): string {
      return this.$t(
        this.outbound
          ? 'chatMessageStealth.sentTitle'
          : 'chatMessageStealth.receivedTitle',
      ) as string
    },
    displayStatus(): string {
      if (this.outbound) return this.$t('chatMessageStealth.sent') as string
      switch (this.walletStatus) {
        case 'received':
          return this.$t('chatMessageStealth.received') as string
        case 'pending':
          return this.$t('chatMessageStealth.pending') as string
        case 'not-received':
          return this.$t('chatMessageStealth.notReceived') as string
        case 'failed':
          return this.$t('chatMessageStealth.failed') as string
        default:
          return this.$t('chatMessageStealth.unverified') as string
      }
    },
    statusColor(): string {
      if (this.outbound) return 'primary'
      switch (this.walletStatus) {
        case 'received':
          return 'positive'
        case 'pending':
          return 'warning'
        case 'not-received':
        case 'failed':
          return 'negative'
        default:
          return 'grey'
      }
    },
    hint(): string {
      if (this.outbound) return ''
      switch (this.walletStatus) {
        case 'received':
          return this.$t(
            this.payment?.spendable
              ? 'chatMessageStealth.spendableHint'
              : 'chatMessageStealth.spentHint',
          ) as string
        case 'pending':
          return this.$t('chatMessageStealth.pendingHint') as string
        case 'not-received':
          return this.$t('chatMessageStealth.notReceivedHint') as string
        case 'failed':
          return this.$t('chatMessageStealth.failedHint') as string
        default:
          return this.$t('chatMessageStealth.unverifiedHint') as string
      }
    },
    hintIcon(): string {
      if (this.walletStatus === 'received') return 'check_circle'
      if (this.walletStatus === 'pending') return 'schedule'
      return 'error_outline'
    },
    explorerUrl(): string | undefined {
      const tx = this.primaryTx
      if (!tx) return undefined
      return multiChainExplorerUrl(tx, this.networkIdentifier)
    },
  },
})
</script>

<style scoped>
.stealth-tx-link {
  text-decoration: none;
}
.stealth-tx-link:hover {
  text-decoration: underline;
}
</style>
