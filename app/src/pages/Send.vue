<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6">{{ $t('sendAddressDialog.sendToAddress') }}</div>
        </q-card-section>
        <q-card-section>
          <q-input
            class="text-bold text-h6"
            v-model="address"
            filled
            dense
            :placeholder="$t('sendAddressDialog.enterBitcoinCashAddress')"
          />
        </q-card-section>
        <q-card-section>
          <q-input
            class="text-bold text-h6"
            v-model="amount"
            inputmode="decimal"
            filled
            dense
            :placeholder="$t('sendAddressDialog.enterAmount')"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            :label="$t('sendAddressDialog.cancel')"
            color="negative"
            @click="cancel"
          />
          <q-btn
            :disable="!isValid || sending"
            :loading="sending"
            :label="$t('sendAddressDialog.send')"
            color="primary"
            @click="send()"
          />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue'
import { useRouter } from 'vue-router'

import { sentTransactionNotify, errorNotify } from '../utils/notifications'
import { activeChain } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { parseNativeTransferInput } from 'src/utils/native-transfer'

export default defineComponent({
  setup() {
    const address = ref('')
    const amount = ref('')
    const sending = ref(false)
    const parsedTransfer = computed(() =>
      parseNativeTransferInput(activeChain, address.value, amount.value),
    )

    const router = useRouter()
    return {
      address,
      amount,
      sending,
      isValid: computed(() => parsedTransfer.value !== undefined),
      send: async () => {
        const transfer = parsedTransfer.value
        if (!transfer) {
          errorNotify({
            message: 'Enter a valid Monad address and MON amount.',
          })
          return
        }
        sending.value = true
        try {
          const wallet = await useActiveWallet()
          const result = await activeChain.nativeTransfers.send({
            wallet,
            recipient: transfer.recipient,
            value: transfer.value,
          })
          sentTransactionNotify(result.txHash)
          window.history.length > 1 ? router.go(-1) : router.push('/')
        } catch (err) {
          errorNotify(
            err instanceof Error
              ? err
              : new Error('Failed to send Monad transaction'),
          )
        } finally {
          sending.value = false
        }
      },
      cancel() {
        window.history.length > 1 ? router.go(-1) : router.push('/')
      },
    }
  },
})
</script>
