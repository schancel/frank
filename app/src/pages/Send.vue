<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <!-- Edit State -->
      <q-card v-if="!isReviewing" data-test="send-edit-card">
        <q-card-section>
          <div class="text-h6">{{ $t('sendAddressDialog.sendToAddress') }}</div>
        </q-card-section>
        <q-card-section>
          <q-input
            class="text-bold text-h6"
            v-model="address"
            filled
            dense
            data-test="send-address-input"
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
            data-test="send-amount-input"
            :placeholder="$t('sendAddressDialog.enterAmount')"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            :label="$t('sendAddressDialog.cancel')"
            color="negative"
            data-test="send-cancel-button"
            @click="cancelEdit"
          />
          <q-btn
            :disable="!isValid || sending"
            :loading="sending"
            :label="$t('sendAddressDialog.review')"
            color="primary"
            data-test="send-review-button"
            @click="reviewTransfer"
          />
        </q-card-actions>
      </q-card>

      <!-- Review State -->
      <q-card v-else data-test="send-review-card">
        <q-card-section>
          <div class="text-h6" data-test="review-title">
            {{ $t('sendAddressDialog.reviewTitle') }}
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <div class="q-gutter-y-sm">
            <div class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendAddressDialog.network')
              }}</span>
              <span class="text-weight-medium" data-test="review-network">{{
                networkName
              }}</span>
            </div>

            <div class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendAddressDialog.recipient')
              }}</span>
              <span
                class="text-weight-bold text-body2 text-right ellipsis"
                style="max-width: 260px"
                data-test="review-recipient"
              >
                {{ formattedRecipient }}
              </span>
            </div>

            <div class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendAddressDialog.amount')
              }}</span>
              <span
                class="text-weight-bold text-primary"
                data-test="review-amount"
              >
                {{ amount }} {{ unit }}
              </span>
            </div>

            <div class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendAddressDialog.estimatedFee')
              }}</span>
              <span class="text-grey-7" data-test="review-fee">
                {{ $t('sendAddressDialog.feeUnavailable') }}
              </span>
            </div>

            <q-separator />

            <div class="row justify-between items-center q-py-xs">
              <span class="text-subtitle2">{{
                $t('sendAddressDialog.maxTotal')
              }}</span>
              <span
                class="text-subtitle1 text-weight-bold"
                data-test="review-total"
              >
                {{ maxTotal }}
              </span>
            </div>
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <q-banner
            class="bg-amber-1 text-grey-9 q-pa-sm"
            rounded
            role="alert"
            data-test="review-warning"
          >
            <template #avatar>
              <q-icon name="warning" color="warning" />
            </template>
            {{ $t('sendAddressDialog.irreversibleWarning') }}
          </q-banner>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn
            :disable="sending"
            :label="$t('sendAddressDialog.editTransfer')"
            flat
            color="primary"
            data-test="review-cancel-button"
            @click="cancelReview"
          />
          <q-btn
            :disable="sending"
            :loading="sending"
            :label="$t('sendAddressDialog.confirmAndSend')"
            color="primary"
            data-test="review-confirm-button"
            @click="confirmSend"
          />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { navigateBack } from 'src/utils/navigate-back'
import { computed, defineComponent, ref } from 'vue'
import { useRouter } from 'vue-router'

import { sentTransactionNotify, errorNotify } from '../utils/notifications'
import { activeChain } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { parseNativeTransferInput } from 'src/utils/native-transfer'
import { useTranslate } from 'src/composables/useTranslate'

export default defineComponent({
  setup() {
    const $t = useTranslate()
    const address = ref('')
    const amount = ref('')
    const isReviewing = ref(false)
    const sending = ref(false)

    const parsedTransfer = computed(() =>
      parseNativeTransferInput(activeChain, address.value, amount.value),
    )

    const formattedRecipient = computed(() => {
      const transfer = parsedTransfer.value
      if (!transfer) return ''
      return activeChain.formatAddress(transfer.recipient)
    })

    const networkName = computed(() => {
      return activeChain.name === 'monad'
        ? $t('setup.networkTitle')
        : activeChain.name
    })

    const unit = computed(() => activeChain.unit)

    const maxTotal = computed(() => {
      return $t('sendAddressDialog.maxTotalWithFee', {
        amount: amount.value,
        unit: activeChain.unit,
      })
    })

    const router = useRouter()

    return {
      address,
      amount,
      isReviewing,
      sending,
      isValid: computed(() => parsedTransfer.value !== undefined),
      formattedRecipient,
      networkName,
      unit,
      maxTotal,
      reviewTransfer: () => {
        const transfer = parsedTransfer.value
        if (!transfer) {
          errorNotify({
            message: $t('sendAddressDialog.invalidTransfer'),
          })
          return
        }
        isReviewing.value = true
      },
      cancelReview: () => {
        isReviewing.value = false
      },
      cancelEdit: () => {
        navigateBack(router)
      },
      confirmSend: async () => {
        if (sending.value) return
        const transfer = parsedTransfer.value
        if (!transfer) {
          errorNotify({
            message: $t('sendAddressDialog.invalidTransfer'),
          })
          return
        }
        sending.value = true
        let signedTxHash: string | undefined
        try {
          const wallet = await useActiveWallet()
          const result = await activeChain.nativeTransfers.send({
            wallet,
            recipient: transfer.recipient,
            value: transfer.value,
            onSigned: async signed => {
              signedTxHash = signed.txHash
            },
          })
          sentTransactionNotify(result.txHash)
          navigateBack(router)
        } catch (err) {
          if (signedTxHash) {
            errorNotify({
              message: $t('sendAddressDialog.potentiallyBroadcast', {
                txHash: signedTxHash,
              }),
            })
          } else {
            errorNotify({
              message: $t('sendAddressDialog.definitelyNotBroadcast'),
            })
          }
        } finally {
          sending.value = false
        }
      },
      send: async function () {
        return this.confirmSend()
      },
      cancel: function () {
        return this.cancelEdit()
      },
    }
  },
})
</script>
