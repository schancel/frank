<template>
  <q-btn
    flat
    round
    dense
    icon="swap_vert"
    :aria-label="uiText.switchNetworkAria"
    data-testid="wallet-network-switcher-btn"
  >
    <q-tooltip>{{ uiText.switchNetworkTooltip }}</q-tooltip>
    <q-menu
      anchor="bottom right"
      self="top right"
      data-testid="wallet-network-switcher-menu"
    >
      <q-list dense style="min-width: 240px; max-width: 300px">
        <q-item-label header class="text-weight-bold text-caption">
          {{ $t('walletPanel.title') }}
        </q-item-label>
        <q-item
          v-for="wallet in visibleWallets"
          :key="wallet.id"
          v-close-popup
          clickable
          :active="selectedWallet === wallet.id"
          active-class="text-primary text-weight-bold"
          :data-testid="`wallet-switch-${wallet.id}`"
          @click="selectWallet(wallet.id)"
        >
          <q-item-section avatar style="min-width: 32px">
            <q-icon :name="wallet.icon" size="20px" />
          </q-item-section>
          <q-item-section>
            <q-item-label class="ellipsis">
              {{ getCustomName(wallet.id) || $t(wallet.defaultNameKey) }}
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="row items-center no-wrap q-gutter-x-xs">
              <q-badge
                v-if="walletIsTestnet(wallet.id)"
                outline
                color="amber-9"
                :label="$t('walletPanel.testnet')"
              />
              <q-icon
                v-if="selectedWallet === wallet.id"
                name="check"
                color="primary"
                size="16px"
              />
            </div>
          </q-item-section>
        </q-item>
        <q-separator class="q-my-xs" />
        <q-item class="q-py-xs">
          <q-item-section>
            <q-item-label caption class="text-grey-7">
              {{ uiText.faucetHint }}
            </q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-menu>
  </q-btn>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { activeChain, onActiveChainChange } from '@frank/wallet/chain'
import { useWalletNames } from '../../composables/useWalletNames'
import { openPage } from '../../utils/routes'
import { walletSupport } from '../../utils/wallet-support'
import { MAIN_WALLET_ID, WALLET_CONFIGS } from '../../utils/wallet-configs'

defineProps<{
  selectedWallet: string
}>()

const router = useRouter()
const { getCustomName } = useWalletNames()
const isTestnet = shallowRef(activeChain.isTestnet ?? false)

onBeforeUnmount(
  onActiveChainChange(chain => {
    isTestnet.value = chain.isTestnet ?? false
  }),
)

const uiText = {
  switchNetworkAria: 'Switch wallet network',
  switchNetworkTooltip: 'Switch Network / Chain',
  faucetHint:
    'Testnet MON powers stamps & fees during preview (Lotus on mainnet). Message Official Faucet in Contacts for free MON.',
}

const visibleWallets = computed(() =>
  WALLET_CONFIGS.filter(
    wallet =>
      wallet.enabled !== false &&
      walletSupport(wallet.id, isTestnet.value).status === 'available',
  ),
)

function walletIsTestnet(walletId: string): boolean {
  return walletSupport(walletId, isTestnet.value).entry?.isTestnet ?? false
}

function selectWallet(walletId: string) {
  openPage(router, `/wallet/${walletId || MAIN_WALLET_ID}`)
}
</script>
