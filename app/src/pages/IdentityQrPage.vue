<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm identity-qr-page">
      <identity-qr-dialog
        :model-value="true"
        inline
        @update:model-value="onClose"
        @scan="onScan"
      />
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import IdentityQrDialog from '../components/dialogs/IdentityQrDialog.vue'
import { openPage } from '../utils/routes'

export default defineComponent({
  name: 'IdentityQrPage',
  components: {
    IdentityQrDialog,
  },
  methods: {
    onClose(val: boolean) {
      if (val) return
      const from = this.$route?.query?.from
      const returnPath =
        typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
          ? from
          : '/chat'
      openPage(this.$router, returnPath)
    },
    onScan(scanned: string) {
      const trimmed = (scanned || '').trim()
      if (!trimmed) return
      const mode = this.$route?.query?.mode
      const basePath = mode === 'contact' ? '/add-contact' : '/new-conversation'
      openPage(this.$router, `${basePath}?to=${encodeURIComponent(trimmed)}`)
    },
  },
})
</script>

<style scoped>
.identity-qr-page {
  max-width: 100%;
  overflow-x: hidden;
}
</style>
