<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6">
            {{ $t('receiveBitcoinDialog.walletStatus') }}
          </div>
        </q-card-section>
        <q-card-section>
          <div class="text-bold text-subtitle1 text-center">
            {{ formattedBalance }}
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
import { defineComponent, onMounted, ref } from 'vue'
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
    const { formattedBalance } = useBalance()
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
      formattedBalance,
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
