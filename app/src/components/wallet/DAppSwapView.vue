<template>
  <div class="q-py-sm" data-testid="dapp-swap-view">
    <!-- One panel per chain family. The shell only decides which one the wallet gets. -->
    <template v-if="panel === 'evm' && chainIdentifier && venue">
      <!-- A chain with several venues lets the user pick; with one, it is simply named. -->
      <div
        v-if="venues.length > 1"
        class="row items-center q-gutter-x-sm q-px-xs q-pb-sm"
        data-testid="swap-venue-choice"
      >
        <span class="text-caption text-grey-7">{{
          $t('swap.venueChoice')
        }}</span>
        <q-btn
          v-for="option in venues"
          :key="option.id"
          dense
          no-caps
          unelevated
          size="sm"
          :outline="option.id !== venue.id"
          :color="option.id === venue.id ? 'primary' : 'grey-7'"
          :label="option.displayName"
          :data-testid="`swap-venue-${option.id}`"
          @click="chosenVenueId = option.id"
        />
      </div>
      <component
        :is="venuePanels[venue.protocol]"
        :key="`${chainIdentifier}:${venue.id}`"
        :chain-identifier="chainIdentifier"
        :wallet-id="selectedWallet"
        :venue-id="venue.id"
      />
    </template>
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
import { computed, defineComponent, ref, watch } from 'vue'
import {
  getChainRegistryEntry,
  resolveNetworkId,
} from '@frank/wallet/chain/chains-registry'
import { evmSwapVenues } from 'src/swap/evm-swap-session'
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
    /** The chain's venues, from configuration. A chain with none says so plainly. */
    const venues = computed(() =>
      family.value === 'evm' ? evmSwapVenues(chainIdentifier.value) : [],
    )
    const chosenVenueId = ref<string>()
    watch(chainIdentifier, () => {
      chosenVenueId.value = undefined
    })
    const venue = computed(
      () =>
        venues.value.find(option => option.id === chosenVenueId.value) ??
        venues.value[0],
    )
    const panel = computed<'evm' | 'solana' | 'none'>(() => {
      if (family.value === 'solana') return 'solana'
      return venue.value ? 'evm' : 'none'
    })
    return {
      chainIdentifier,
      panel,
      venues,
      venue,
      chosenVenueId,
      // One panel per protocol. Each takes the chain, the wallet and the venue id, and does
      // its own quoting, planning and execution behind that.
      venuePanels: { 'uniswap-v4': EvmSwapPanel },
    }
  },
})
</script>
