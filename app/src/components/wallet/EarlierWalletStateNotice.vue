<template>
  <q-banner
    v-if="earlier"
    dense
    rounded
    role="status"
    class="bg-amber-1 text-brown-10 q-ma-sm"
    data-test="earlier-wallet-state"
  >
    <template #avatar>
      <q-icon name="history_toggle_off" color="warning" />
    </template>
    <div class="text-weight-bold text-caption">
      {{ $t('walletMaintenance.earlierStateTitle') }}
    </div>
    <div class="text-caption q-mt-xs">
      {{ $t('walletMaintenance.earlierStateBody') }}
    </div>
    <ul class="text-caption q-my-xs q-pl-md">
      <li
        v-for="location in earlier.earlierLocations"
        :key="location"
        class="earlier-location"
        data-test="earlier-wallet-state-location"
      >
        <code>{{ databasesOf(location) }}</code>
      </li>
    </ul>
  </q-banner>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { getChainRegistryEntry } from '@frank/wallet/chain'
import { accountSession, accountStatus } from 'src/accounts/session'
import { openEvmWallet } from 'src/accounts/evm-wallets'
import { earlierStateOf } from 'src/accounts/wallet-reconcile'
import type { EarlierWalletState } from '@frank/wallet/chain/evm-chain'

/**
 * Says, without blocking anything, that this account has wallet state an earlier build wrote
 * under another name, which is no longer read, and how to find the funds again. The wallet
 * found it at open by name only; nothing is opened, migrated or deleted here.
 */
const props = defineProps<{ chainIdentifier?: string }>()

const earlier = ref<EarlierWalletState>()
/** How the browser names the location's stores in IndexedDB (Level's own prefix). */
const databasesOf = (location: string) => `level-js-${location}/…`

async function look(chainIdentifier: string | undefined) {
  earlier.value = undefined
  if (!chainIdentifier || accountStatus.status !== 'ready') return
  const primary = accountSession.peekWallet()
  if (!primary) return
  if (primary.chainIdentifier === chainIdentifier) {
    earlier.value = earlierStateOf(primary)
    return
  }
  const entry = getChainRegistryEntry(chainIdentifier)
  if (entry?.family !== 'evm' || entry.kind === 'tempo' || !entry.wallet) return
  try {
    const { wallet } = await openEvmWallet(chainIdentifier)
    if (props.chainIdentifier === chainIdentifier)
      earlier.value = earlierStateOf(wallet)
  } catch {
    // The page shows the network's own open failure; this notice is advice only.
  }
}

watch(
  () => [props.chainIdentifier, accountStatus.status] as const,
  ([chainIdentifier]) => void look(chainIdentifier),
  { immediate: true },
)
</script>

<style scoped>
.earlier-location {
  overflow-wrap: anywhere;
}
</style>
