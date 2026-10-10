<template>
  <div class="q-py-sm" data-testid="dapp-swap-view">
    <!-- One panel per chain family. The shell only decides which one the wallet gets. -->
    <evm-swap-panel
      v-if="panel === 'evm' && chainIdentifier"
      :key="chainIdentifier"
      :chain-identifier="chainIdentifier"
      :wallet-id="selectedWallet"
    />
    <solana-swap-panel v-else-if="panel === 'solana'" />
    <q-card v-else flat bordered>
      <q-card-section role="status" data-testid="swap-unavailable">
        <div class="text-subtitle1 text-weight-medium">
          {{ $t('walletPanel.swapUnavailable') }}
        </div>
        <p class="text-body2 text-grey-7 q-mt-sm q-mb-none">
          {{ $t('swap.unavailableNetwork') }}
        </p>
      </q-card-section>
    </q-card>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import {
  getChainRegistryEntry,
  resolveNetworkId,
} from '@frank/wallet/chain/chains-registry'
import { evmSwapDeployment } from 'src/swap/evm-swap-session'
import { nativeSendChainIdentifier } from 'src/utils/native-transfer'
import EvmSwapPanel from './EvmSwapPanel.vue'
import SolanaSwapPanel from './SolanaSwapPanel.vue'

export default defineComponent({
  name: 'DAppSwapView',
  components: { EvmSwapPanel, SolanaSwapPanel },
  props: {
    selectedWallet: {
      type: String,
      default: 'monad',
    },
    isTestnet: {
      type: Boolean,
      default: true,
    },
  },
  setup(props) {
    /** The wallet's family, from the registry entry of the network it is on. */
    const family = computed(
      () =>
        getChainRegistryEntry(
          resolveNetworkId(props.selectedWallet, props.isTestnet),
        )?.family,
    )
    /** The canonical chain this wallet can sign for now, when it has one. */
    const chainIdentifier = computed(() =>
      nativeSendChainIdentifier(props.selectedWallet, props.isTestnet),
    )
    const panel = computed<'evm' | 'solana' | 'none'>(() => {
      if (family.value === 'solana') return 'solana'
      if (family.value === 'evm' && evmSwapDeployment(chainIdentifier.value))
        return 'evm'
      return 'none'
    })
    return { chainIdentifier, panel }
  },
})
</script>
