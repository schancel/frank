<template>
  <!-- Below the drawer breakpoint the navigation drawer is closed: this header's menu button is
  the way out of the page. -->
  <page-menu-header
    :title="$t('leftDrawer.wallet')"
    @toggleMyDrawerOpen="$emit('toggleMyDrawerOpen')"
  />
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6" data-testid="wallet-name">
            {{ $t('walletPanel.mainWallet') }}
          </div>
          <div class="text-caption" data-testid="wallet-chain">
            {{ $t('walletPanel.monad') }}
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
            {{ balanceText }}
          </div>
          <div
            v-if="hasError"
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
            :label="$t('walletPanel.receive')"
            color="primary"
            data-testid="wallet-receive-action"
            @click="openReceive"
          />
          <q-btn
            :label="$t('walletPanel.send')"
            color="primary"
            data-testid="wallet-send-action"
            @click="openSend"
          />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { useRouter } from 'vue-router'

import { copyToClipboard } from 'quasar'
import { useReceiveAddress } from 'src/composables/useReceiveAddress'
import PageMenuHeader from 'src/components/PageMenuHeader.vue'
import { useBalance } from 'src/composables/useBalance'
import { openPage } from 'src/utils/routes'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'

// One wallet's detail view in the main pane (#570): the Wallet rail tab's drawer shows the
// wallet list; picking a row lands here for that wallet's info and actions. Stealth payment
// initiation is deliberately absent until the stealth design (#71) lands -- no dead controls.
export default defineComponent({
  components: { PageMenuHeader },
  // Two root nodes: the layout's other route listeners have no single element to land on.
  inheritAttrs: false,
  emits: ['toggleMyDrawerOpen'],
  setup() {
    const router = useRouter()
    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const { formattedBalance, loaded, hasError } = useBalance()
    // An em dash (not "0") until the first successful fetch: an unloaded or failed balance must
    // not look like a real zero.
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    // The funded account, i.e. the one the balance above refers to and the Receive page shows
    // (#834). The identity address is a different account: funding it changes nothing here.
    const displayAddress = useReceiveAddress('walletPanel.failedLoadAddress')

    return {
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
