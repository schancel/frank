<template>
  <q-page-container v-if="legacyLotusMode">
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6">{{ $t('wipeWallet.warning') }}</div>
        </q-card-section>
        <q-card-section>
          <div>{{ $t('wipeWallet.warningMsg') }}</div>
          <div>{{ $t('wipeWallet.cannotBeUndone') }}</div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            @click="cancel"
            :label="$t('wipeWallet.cancel')"
            color="negative"
            class="q-ma-sm"
          />
          <q-btn
            @click="wipeWallet"
            :label="$t('wipeWallet.wipe')"
            color="primary"
            class="q-ma-sm"
          />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { navigateBack } from 'src/utils/navigate-back'
import { defineComponent } from 'vue'

import { useChatStore } from 'src/stores/chats'
import { errorNotify } from '../utils/notifications'
import { legacyLotusModeEnabled } from 'src/utils/runtime-mode'

export default defineComponent({
  setup() {
    const chatStore = useChatStore()
    return {
      legacyLotusMode: legacyLotusModeEnabled(),
      deleteMessage: chatStore.deleteMessage,
    }
  },
  props: {},
  data() {
    return {}
  },
  methods: {
    async wipeWallet() {
      if (!legacyLotusModeEnabled()) return

      this.$q.loading.show({
        delay: 100,
        message: this.$t('wipeWallet.spinnerText'),
      })
      try {
        await this.$relayClient.wipeWallet(({ address, payloadDigest }) => {
          this.deleteMessage({ address, payloadDigest })
        })
      } catch (err) {
        errorNotify(err)
      } finally {
        this.$q.loading.hide()
      }
    },
    cancel() {
      navigateBack(this.$router)
    },
  },
})
</script>
