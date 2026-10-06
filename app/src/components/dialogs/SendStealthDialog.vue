<template>
  <q-card
    class="q-px-sm q-pb-md dialog-medium"
    data-testid="send-stealth-dialog"
  >
    <q-card-section>
      <div class="text-h6">
        {{
          $t('sendStealthDialog.sendStealthTo') +
          ' ' +
          (contact?.name || address)
        }}
      </div>
      <div class="text-caption text-grey-7">
        {{ $t('sendStealthDialog.subtitle') }}
      </div>
    </q-card-section>

    <!-- Wallet Selection Dropdown -->
    <q-card-section>
      <q-select
        v-model="selectedWalletId"
        :options="walletOptions"
        emit-value
        map-options
        filled
        dense
        :label="$t('sendStealthDialog.walletLabel') || $t('sendStealthDialog.chainLabel')"
        data-testid="stealth-wallet-select"
      />
    </q-card-section>

    <!-- Spendable Balance Row -->
    <q-card-section class="q-pt-none q-pb-xs">
      <div
        class="row items-center justify-between text-caption text-grey-7"
        data-testid="wallet-balance-row"
      >
        <span>{{ $t('sendStealthDialog.balanceLabel') }}</span>
        <span class="text-bold" data-testid="wallet-balance-value">
          {{ currentWalletBalanceDisplay }}
        </span>
      </div>
    </q-card-section>

    <!-- Amount Input -->
    <q-card-section>
      <q-input
        class="text-bold text-h6"
        v-model="amount"
        type="number"
        filled
        dense
        :suffix="currentUnit"
        :hint="amountHint"
        :error="isBelowDustLimit"
        :error-message="dustErrorMessage"
        :placeholder="$t('sendStealthDialog.amountPlaceholder')"
        data-testid="stealth-amount-input"
        ref="amountInput"
      />
    </q-card-section>

    <!-- Memo Input -->
    <q-card-section>
      <q-input
        v-model="memo"
        filled
        dense
        :hint="$t('sendStealthDialog.memoHint')"
        :placeholder="$t('sendStealthDialog.memoPlaceholder')"
        data-testid="stealth-memo-input"
      />
    </q-card-section>

    <q-card-actions align="right">
      <q-btn
        flat
        :label="$t('sendStealthDialog.cancelBtnLabel')"
        color="primary"
        v-close-popup
      />
      <q-btn
        flat
        :disable="!canSend || busy"
        :label="$t('sendStealthDialog.sendBtnLabel')"
        color="primary"
        data-testid="stealth-send-confirm-btn"
        v-close-popup
        @click="sendStealth"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'
import { useWalletNames } from '../../composables/useWalletNames'
import { useBalance } from '../../composables/useBalance'

export interface WalletOptionItem {
  value: string
  label: string
  chain: string
  networkTag: string
  curve: 'secp256k1' | 'ed25519'
  keyType: 1 | 2
  unit: string
  minDust: number
}

export default defineComponent({
  name: 'SendStealthDialog',
  props: {
    address: {
      type: String,
      default: '',
    },
    contact: {
      type: Object,
      default: () => ({ name: 'Unknown' }),
    },
    busy: {
      type: Boolean,
      default: false,
    },
    /** Optional balance overrides for test or multi-wallet injection */
    walletBalances: {
      type: Object as () => Record<string, string | number>,
      default: () => ({}),
    },
  },
  emits: ['send'],
  setup() {
    const { getCustomName } = useWalletNames()
    const { balance, formattedBalance, loaded: balanceLoaded } = useBalance()
    return {
      getCustomName,
      balance,
      formattedBalance,
      balanceLoaded,
    }
  },
  data() {
    return {
      selectedWalletId: 'monad',
      selectedChainId: activeChain.networkName || 'monad-testnet',
      amount: '',
      memo: '',
    }
  },
  watch: {
    selectedChainId(newVal: string) {
      if (!newVal) return
      const lower = newVal.toLowerCase()
      if (lower.includes('solana') && this.selectedWalletId !== 'solana') {
        this.selectedWalletId = 'solana'
      } else if (
        (lower.includes('xec') || lower.includes('ecash')) &&
        this.selectedWalletId !== 'ecash'
      ) {
        this.selectedWalletId = 'ecash'
      } else if (lower.includes('monad') && this.selectedWalletId !== 'monad') {
        this.selectedWalletId = 'monad'
      }
    },
    selectedWalletId(newVal: string) {
      const opt = this.walletOptions.find(o => o.value === newVal)
      if (opt && this.selectedChainId !== opt.networkTag) {
        this.selectedChainId = opt.networkTag
      }
    },
  },
  computed: {
    isTestnet(): boolean {
      return activeChain.isTestnet ?? false
    },
    walletOptions(): WalletOptionItem[] {
      const monadCustom = this.getCustomName('monad')
      const solanaCustom = this.getCustomName('solana')
      const ecashCustom = this.getCustomName('ecash')

      return [
        {
          value: 'monad',
          label:
            monadCustom ||
            (this.isTestnet ? 'Monad Testnet' : 'Monad Wallet'),
          chain: 'monad',
          networkTag: this.isTestnet ? 'monad-testnet' : 'monad-mainnet',
          curve: 'secp256k1',
          keyType: 1,
          unit: this.isTestnet ? 'MONT' : 'MON',
          minDust: 0,
        },
        {
          value: 'solana',
          label:
            solanaCustom ||
            (this.isTestnet ? 'Solana Testnet' : 'Solana Stash'),
          chain: 'solana',
          networkTag: this.isTestnet ? 'solana-devnet' : 'solana-mainnet',
          curve: 'ed25519',
          keyType: 2,
          unit: this.isTestnet ? 'tSOL' : 'SOL',
          minDust: 0.00089, // 890,880 lamports
        },
        {
          value: 'ecash',
          label:
            ecashCustom ||
            (this.isTestnet ? 'eCash Testnet' : 'eCash Wallet'),
          chain: 'ecash',
          networkTag: this.isTestnet ? 'ecash-testnet' : 'ecash-mainnet',
          curve: 'secp256k1',
          keyType: 1,
          unit: this.isTestnet ? 'tXEC' : 'XEC',
          minDust: 5.46,
        },
      ]
    },
    // Backwards-compatible alias for existing tests
    chainOptions() {
      return this.walletOptions.map(w => ({
        label: `${w.label} (${w.unit})`,
        value: w.networkTag,
        unit: w.unit,
      }))
    },
    selectedWallet(): WalletOptionItem {
      return (
        this.walletOptions.find(w => w.value === this.selectedWalletId) ||
        this.walletOptions[0]
      )
    },
    currentUnit(): string {
      return this.selectedWallet.unit
    },
    currentWalletBalanceDisplay(): string {
      const customBal = this.walletBalances?.[this.selectedWalletId]
      if (customBal !== undefined) {
        return `${customBal} ${this.currentUnit}`
      }
      if (this.selectedWalletId === 'monad') {
        if (this.formattedBalance) {
          return this.formattedBalance
        }
        if (this.balance !== null && this.balance !== undefined) {
          return `${activeChain.toDisplayAmount(this.balance)} ${this.currentUnit}`
        }
        return `0.00 ${this.currentUnit}`
      }
      if (this.selectedWalletId === 'solana') {
        return `0.00000000 ${this.currentUnit}`
      }
      return `0.00 ${this.currentUnit}`
    },
    isBelowDustLimit(): boolean {
      const parsed = parseFloat(this.amount)
      if (isNaN(parsed) || parsed <= 0) return false
      return !!(
        this.selectedWallet.minDust && parsed < this.selectedWallet.minDust
      )
    },
    dustErrorMessage(): string {
      if (this.isBelowDustLimit) {
        return `Amount must be at least ${this.selectedWallet.minDust} ${this.currentUnit} (dust limit)`
      }
      return ''
    },
    amountHint(): string {
      if (this.selectedWallet.minDust > 0) {
        return `Min: ${this.selectedWallet.minDust} ${this.currentUnit} (dust limit)`
      }
      return (
        (this.$t('sendStealthDialog.amountHint') as string) || 'Amount to send'
      )
    },
    canSend(): boolean {
      const parsed = parseFloat(this.amount)
      if (isNaN(parsed) || parsed <= 0) return false
      if (this.isBelowDustLimit) return false
      return true
    },
  },
  methods: {
    sendStealth() {
      const numAmount = parseFloat(this.amount)
      this.$emit('send', {
        address: this.address,
        chainId: this.selectedChainId,
        amount: numAmount,
        memo: this.memo.trim(),
        wallet: this.selectedWalletId,
        walletName: this.selectedWallet.label,
        networkTag: this.selectedWallet.networkTag,
        chain: this.selectedWallet.chain,
        curve: this.selectedWallet.curve,
        keyType: this.selectedWallet.keyType,
        unit: this.currentUnit,
      })
    },
  },
  mounted() {
    const input = this.$refs.amountInput as { focus?: () => void } | undefined
    input?.focus?.()
  },
})
</script>
