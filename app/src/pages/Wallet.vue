<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-md column full-height">
      <q-card
        flat
        class="col column full-width bg-transparent"
        style="max-width: 600px; margin: 0 auto"
      >
        <q-card-section>
          <div class="text-h6 row items-center" data-testid="wallet-name">
            <span>
              {{
                getCustomName(selectedWallet) ||
                (selectedWallet === 'ecash'
                  ? isTestnet
                    ? $t('walletPanel.ecashTestnet')
                    : $t('walletPanel.ecash')
                  : selectedWallet === 'solana'
                  ? isTestnet
                    ? $t('walletPanel.solanaTestnet')
                    : $t('walletPanel.solana')
                  : $t('walletPanel.mainWallet'))
              }}
            </span>
            <q-badge
              v-if="isTestnet"
              color="orange"
              text-color="black"
              :label="$t('walletPanel.testnet')"
              class="q-ml-sm text-bold"
              data-testid="wallet-testnet-badge"
            />
          </div>
          <div class="text-caption" data-testid="wallet-chain">
            {{
              selectedWallet === 'ecash'
                ? isTestnet
                  ? $t('walletPanel.ecashTestnet')
                  : $t('walletPanel.ecash')
                : selectedWallet === 'solana'
                ? isTestnet
                  ? $t('walletPanel.solanaTestnet')
                  : $t('walletPanel.solana')
                : isTestnet
                ? $t('walletPanel.monadTestnet')
                : $t('walletPanel.monad')
            }}
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section class="q-py-sm">
          <div
            class="text-bold text-subtitle1 text-center"
            role="status"
            aria-live="polite"
            data-testid="wallet-balance"
          >
            {{
              selectedWallet === 'ecash'
                ? isTestnet
                  ? $t('walletPanel.zeroTxec')
                  : $t('walletPanel.zeroXec')
                : selectedWallet === 'solana'
                ? isTestnet
                  ? $t('walletPanel.zeroTsol')
                  : $t('walletPanel.zeroSol')
                : balanceText
            }}
          </div>
          <div
            v-if="selectedWallet === 'monad' && hasError"
            class="text-negative text-caption text-center"
            data-testid="wallet-balance-error"
          >
            {{ $t('walletPanel.balanceUnavailable') }}
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section>
          <div
            class="row justify-center items-center"
            style="min-height: 300px"
            data-testid="wallet-qr-container"
          >
            <qrcode-vue
              v-if="displayAddress"
              style="margin-left: auto; margin-right: auto"
              :value="displayAddress"
              :size="300"
              level="H"
              data-testid="wallet-qr"
            />
            <q-skeleton
              v-else
              size="300px"
              square
              data-testid="wallet-qr-skeleton"
            />
          </div>
          <div class="row q-mt-md">
            <q-input
              class="fit"
              filled
              auto-grow
              :loading="!displayAddress"
              v-model="displayAddress"
              readonly
            >
              <template #append>
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
          <q-card-actions
            align="right"
            class="q-px-none q-pt-md bg-transparent"
          >
            <q-btn
              no-caps
              outline
              color="primary"
              :label="$t('walletPanel.sendToContact')"
              :disable="selectedWallet !== 'monad'"
              data-testid="wallet-contact-send-action"
              @click="openSendContact"
            />
            <q-btn
              no-caps
              :label="
                selectedWallet === 'ecash'
                  ? isTestnet
                    ? $t('walletPanel.sendTxec')
                    : $t('walletPanel.sendXec')
                  : selectedWallet === 'solana'
                  ? isTestnet
                    ? $t('walletPanel.sendTsol')
                    : $t('walletPanel.sendSol')
                  : isTestnet
                  ? $t('walletPanel.sendMont')
                  : $t('walletPanel.send')
              "
              color="primary"
              :disable="selectedWallet !== 'monad'"
              data-testid="wallet-send-action"
              data-test="wallet-legacy-send-action"
              @click="openSend"
            />
          </q-card-actions>
        </q-card-section>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import QrcodeVue from 'qrcode.vue'
import { copyToClipboard } from 'quasar'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { useWalletNames } from 'src/composables/useWalletNames'
import { openPage } from 'src/utils/routes'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { accountSession, accountStatus } from '../accounts/session'
import { activeChain } from '@frank/wallet/chain'

// One wallet's detail view in the main pane (#570): the Wallet rail tab's drawer shows the
// wallet list; picking a row lands here for that wallet's info and actions. Stealth payment
// initiation is deliberately absent until the stealth design (#71) lands -- no dead controls.
export default defineComponent({
  components: {
    QrcodeVue,
  },
  setup() {
    const route = useRoute()
    const router = useRouter()
    const isTestnet = computed(() => activeChain.isTestnet ?? false)
    const { getCustomName } = useWalletNames()

    const selectedWallet = computed<'monad' | 'ecash' | 'solana'>(() => {
      const walletParam = (route?.params?.wallet as string)?.toLowerCase()
      if (walletParam === 'ecash' || walletParam === 'solana')
        return walletParam
      if (walletParam === 'monad') return 'monad'
      const chainParam = (route?.params?.chain as string)?.toLowerCase()
      if (chainParam === 'ecash' || chainParam === 'solana') return chainParam
      if (chainParam === 'monad') return 'monad'
      const query = (
        (route?.query?.chain || route?.query?.wallet) as string
      )?.toLowerCase()
      if (query === 'ecash' || query === 'solana') return query
      return 'monad'
    })

    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const { formattedBalance, loaded, hasError } = useBalance()
    // An em dash (not "0") until the first successful fetch: an unloaded or failed balance must
    // not look like a real zero.
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    const displayAddress = ref(
      accountSession.getCachedChainAddress?.(selectedWallet.value) ?? '',
    )

    const prewarmChains = (active: 'monad' | 'ecash' | 'solana') => {
      if (accountStatus.status === 'ready') {
        if (active !== 'ecash') {
          accountSession?.getChainAddress?.('ecash')?.catch(() => undefined)
        }
        if (active !== 'solana') {
          accountSession?.getChainAddress?.('solana')?.catch(() => undefined)
        }
      }
    }

    watch(
      () => [
        accountStatus.status,
        accountStatus.revision,
        selectedWallet.value,
      ],
      async ([status, , chain], _previous, onCleanup) => {
        if (status !== 'ready') {
          displayAddress.value = ''
          return
        }
        prewarmChains(chain)
        const cached = accountSession.getCachedChainAddress?.(chain)
        if (cached) {
          displayAddress.value = cached
        } else {
          displayAddress.value = ''
        }
        let current = true
        onCleanup(() => {
          current = false
        })
        try {
          if (chain === 'monad') {
            const wallet = await useActiveWallet()
            if (!current) return
            let address: unknown
            if (typeof wallet.getReceiveAddress === 'function') {
              address = await wallet.getReceiveAddress()
            } else if (wallet.identity?.displayAddress) {
              address = wallet.identity.displayAddress
            }
            if (current && address) {
              displayAddress.value =
                typeof address === 'string'
                  ? address
                  : activeChain.addressToString(
                      address as Parameters<
                        typeof activeChain.addressToString
                      >[0],
                    )
            }
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
      selectedWallet,
      selectedChain: selectedWallet,
      isTestnet,
      displayAddress,
      balanceText,
      hasError,
      getCustomName,
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
      openSendContact() {
        openPage(router, '/send-contact')
      },
      openReceive() {
        openPage(router, '/wallet')
      },
    }
  },
})
</script>
