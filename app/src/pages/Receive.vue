<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6" id="receive-balance-heading">
            {{ $t('receiveBitcoinDialog.walletStatus') }}
          </div>
        </q-card-section>
        <q-card-section>
          <div
            class="text-bold text-subtitle1 text-center"
            role="status"
            aria-live="polite"
            aria-labelledby="receive-balance-heading"
            data-testid="receive-balance"
          >
            {{ balanceText }}
          </div>
          <div
            v-if="hasError"
            class="text-negative text-caption text-center"
            data-testid="receive-balance-error"
          >
            {{ $t('receiveBitcoinDialog.balanceUnavailable') }}
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section>
          <div class="row">
            <qrcode-vue
              style="margin-left: auto; margin-right: auto"
              :value="displayAddress"
              :size="300"
              level="H"
            />
          </div>
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
                  @click="copyAddress"
                />
              </template>
            </q-input>
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn :label="$t('close')" color="primary" @click="close" />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import QrcodeVue from 'qrcode.vue'
import { copyToClipboard } from 'quasar'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'

export default defineComponent({
  setup() {
    const router = useRouter()
    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const { formattedBalance, loaded, hasError } = useBalance()
    // An em dash (not "0") until the first successful fetch: an unloaded or failed balance must
    // not look like a real zero.
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    const displayAddress = ref('')

    onMounted(async () => {
      try {
        const wallet = await useActiveWallet()
        displayAddress.value = wallet.identity.displayAddress
      } catch (err) {
        errorNotify(
          err instanceof Error
            ? err
            : new Error('Failed to load Monad wallet balance'),
        )
      }
    })

    return {
      displayAddress,
      balanceText,
      hasError,
      close() {
        window.history.length > 1 ? router.go(-1) : router.push('/')
      },
      async copyAddress() {
        if (!displayAddress.value) return
        try {
          await copyToClipboard(displayAddress.value)
          addressCopiedNotify()
        } catch {
          errorNotify(new Error('Unable to copy the Monad address'))
        }
      },
    }
  },
  components: {
    QrcodeVue,
  },
})
</script>
