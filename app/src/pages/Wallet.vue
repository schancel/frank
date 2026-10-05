<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6" data-testid="wallet-name">
            {{
              selectedChain === 'ecash'
                ? $t('walletPanel.ecash')
                : selectedChain === 'solana'
                  ? $t('walletPanel.solana')
                  : $t('walletPanel.mainWallet')
            }}
          </div>
          <div class="text-caption" data-testid="wallet-chain">
            {{
              selectedChain === 'ecash'
                ? $t('walletPanel.ecash')
                : selectedChain === 'solana'
                  ? $t('walletPanel.solana')
                  : $t('walletPanel.monad')
            }}
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section>
          <div
            class="text-bold text-subtitle1 text-center"
            role="status"
            aria-live="polite"
            data-testid="wallet-balance"
          >
            {{
              selectedChain === 'ecash'
                ? $t('walletPanel.zeroXec')
                : selectedChain === 'solana'
                  ? $t('walletPanel.zeroSol')
                  : balanceText
            }}
          </div>
          <div
            v-if="selectedChain === 'monad' && hasError"
            class="text-negative text-caption text-center"
            data-testid="wallet-balance-error"
          >
            {{ $t('walletPanel.balanceUnavailable') }}
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section>
          <div class="row">
            <q-input
              class="fit"
              filled
              auto-grow
              v-model="displayAddress"
              readonly
            >
              <template #after>
                <q-btn
                  dense
                  color="primary"
                  flat
                  icon="content_copy"
                  :aria-label="$t('a11y.copyAddress')"
                  :disable="!displayAddress"
                  data-testid="wallet-copy-address"
                  @click="copyAddress"
                />
              </template>
            </q-input>
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            no-caps
            :label="
              selectedChain === 'ecash'
                ? $t('walletPanel.receiveXec')
                : selectedChain === 'solana'
                  ? $t('walletPanel.receiveSol')
                  : $t('walletPanel.receive')
            "
            color="primary"
            :disable="selectedChain !== 'monad'"
            data-testid="wallet-receive-action"
            @click="openReceive"
          />
          <q-btn
            no-caps
            :label="
              selectedChain === 'ecash'
                ? $t('walletPanel.sendXec')
                : selectedChain === 'solana'
                  ? $t('walletPanel.sendSol')
                  : $t('walletPanel.send')
            "
            color="primary"
            :disable="selectedChain !== 'monad'"
            data-testid="wallet-send-action"
            @click="openSend"
          />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { copyToClipboard } from 'quasar'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { openPage } from 'src/utils/routes'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { accountSession, accountStatus } from '../accounts/session'

// One wallet's detail view in the main pane (#570): the Wallet rail tab's drawer shows the
// wallet list; picking a row lands here for that wallet's info and actions. Stealth payment
// initiation is deliberately absent until the stealth design (#71) lands -- no dead controls.
export default defineComponent({
  setup() {
    const route = useRoute()
    const router = useRouter()
    const selectedChain = computed<'monad' | 'ecash' | 'solana'>(() => {
      const chain = (route?.query?.chain as string)?.toLowerCase()
      if (chain === 'ecash' || chain === 'solana') return chain
      return 'monad'
    })

    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const { formattedBalance, loaded, hasError } = useBalance()
    // An em dash (not "0") until the first successful fetch: an unloaded or failed balance must
    // not look like a real zero.
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    const displayAddress = ref('')

    watch(
      () => [accountStatus.status, accountStatus.revision, selectedChain.value],
      async ([status, _revision, chain], _previous, onCleanup) => {
        displayAddress.value = ''
        if (status !== 'ready') return
        let current = true
        onCleanup(() => {
          current = false
        })
        try {
          if (chain === 'monad') {
            const wallet = await useActiveWallet()
            if (current) displayAddress.value = wallet.identity.displayAddress
          } else {
            const address = await accountSession.getChainAddress(
              chain as 'ecash' | 'solana',
            )
            if (current) displayAddress.value = address
          }
        } catch (err) {
          if (current)
            errorNotify(err, { fallbackKey: 'walletPanel.failedLoadAddress' })
        }
      },
      { immediate: true, flush: 'sync' },
    )

    return {
      selectedChain,
      displayAddress,
      balanceText,
      hasError,
      async copyAddress() {
        if (!displayAddress.value) return
        try {
          await copyToClipboard(displayAddress.value)
          addressCopiedNotify()
        } catch (err) {
          errorNotify(err, { fallbackKey: 'walletPanel.unableCopyAddress' })
        }
      },
      openSend() {
        openPage(router, '/send')
      },
      openReceive() {
        openPage(router, '/receive')
      },
    }
  },
})
</script>
