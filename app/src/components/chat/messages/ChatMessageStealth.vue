<template>
  <div class="q-mb-sm" data-testid="chat-message-stealth">
    <q-card flat bordered class="q-pa-sm" :class="cardBg">
      <!-- Header row: Icon, Title, and Status Badge -->
      <div class="row items-center justify-between q-mb-xs">
        <div class="row items-center">
          <q-icon name="visibility_off" size="sm" color="primary" class="q-mr-xs" />
          <span class="text-weight-bold text-subtitle2" data-testid="stealth-title">
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

      <!-- Direct credit indicator (no sweep friction needed) -->
      <div class="row items-center text-caption text-grey-6 q-mt-xs">
        <q-icon name="check_circle" size="xs" color="positive" class="q-mr-xs" />
        <span data-testid="stealth-direct-credit-hint">
          {{ $t('chatMessageStealth.directCreditHint') || 'Indexed into spendable balance' }}
        </span>
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
import { multiChainExplorerUrl } from '../../../utils/explorer'

export default defineComponent({
  name: 'ChatMessageStealth',
  props: {
    amount: {
      type: [Number, String],
      required: true,
    },
    chainId: {
      type: String,
      default: undefined,
    },
    networkTag: {
      type: String,
      default: undefined,
    },
    transactions: {
      type: Array as PropType<string[]>,
      default: () => [],
    },
    txHash: {
      type: String,
      default: undefined,
    },
    status: {
      type: String,
      default: 'confirmed',
    },
    outbound: {
      type: Boolean,
      default: false,
    },
    unit: {
      type: String,
      default: undefined,
    },
    memo: {
      type: String,
      default: undefined,
    },
  },
  setup() {
    const $q = useQuasar()
    const isDark = computed(() => $q?.dark?.isActive ?? false)
    return {
      isDark,
    }
  },
  computed: {
    cardBg(): string {
      return this.isDark ? 'bg-grey-10' : 'bg-grey-1'
    },
    primaryTx(): string | undefined {
      if (this.txHash) return this.txHash
      if (this.transactions && this.transactions.length > 0) {
        return this.transactions[0]
      }
      return undefined
    },
    truncatedTx(): string {
      const tx = this.primaryTx
      if (!tx) return ''
      if (tx.length <= 16) return tx
      return `${tx.slice(0, 8)}...${tx.slice(-6)}`
    },
    networkIdentifier(): string {
      return this.networkTag || this.chainId || 'monad-testnet'
    },
    displayUnit(): string {
      if (this.unit) return this.unit
      const net = this.networkIdentifier.toLowerCase()
      if (net.includes('sol')) {
        return net.includes('dev') || net.includes('test') ? 'tSOL' : 'SOL'
      }
      if (net.includes('xec') || net.includes('ecash')) {
        return net.includes('test') ? 'tXEC' : 'XEC'
      }
      if (net.includes('mon')) {
        return net.includes('test') || net === 'mont' ? 'MONT' : 'MON'
      }
      return 'MON'
    },
    displayChain(): string {
      const net = this.networkIdentifier.toLowerCase()
      if (net.includes('sol')) return 'Solana'
      if (net.includes('ecash') || net.includes('xec')) return 'eCash'
      if (net.includes('mon')) return 'Monad'
      return this.networkTag || this.chainId || ''
    },
    displayAmount(): string {
      if (this.amount === undefined || this.amount === null) return '0'
      return String(this.amount)
    },
    title(): string {
      if (this.outbound) {
        return (
          (this.$t('chatMessageStealth.sentTitle') as string) ||
          'Sent Stealth Payment'
        )
      }
      return (
        (this.$t('chatMessageStealth.receivedTitle') as string) ||
        'Received Stealth Payment'
      )
    },
    displayStatus(): string {
      if (this.status) {
        const s = this.status.toLowerCase()
        if (s === 'confirmed') {
          return (
            (this.$t('chatMessageStealth.confirmed') as string) || 'Confirmed'
          )
        }
        return this.status
      }
      return (
        (this.$t('chatMessageStealth.confirmed') as string) || 'Confirmed'
      )
    },
    statusColor(): string {
      const s = (this.status || 'confirmed').toLowerCase()
      if (s === 'confirmed' || s === 'settled' || s === 'success') {
        return 'positive'
      }
      if (s === 'pending') return 'warning'
      if (s === 'failed' || s === 'rejected') return 'negative'
      return 'primary'
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
