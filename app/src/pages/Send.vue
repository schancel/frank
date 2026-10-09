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
            :placeholder="$t('sendAddressDialog.recipient')"
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
                {{ reviewedAmount }} {{ unit }}
              </span>
            </div>

            <div class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendAddressDialog.estimatedFee')
              }}</span>
              <span class="text-grey-7" data-test="review-fee">
                {{ estimatedFeeText || $t('sendAddressDialog.feeUnavailable') }}
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
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  ref,
  shallowRef,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { sentTransactionNotify, errorNotify } from '../utils/notifications'
import {
  activeChain,
  NativeTransactionSubmissionError,
} from '@frank/wallet/chain'
import {
  createNativeTransferContext,
  type NativeTransferContext,
  type NativeTransferBinding,
} from 'src/accounts/native-transfer'
import {
  parseNativeTransferInput,
  type ParsedNativeTransfer,
} from 'src/utils/native-transfer'
import { useTranslate } from 'src/composables/useTranslate'

export default defineComponent({
  setup() {
    const $t = useTranslate()
    const address = ref('')
    const amount = ref('')
    const isReviewing = ref(false)
    const sending = ref(false)
    const estimatedFeeText = ref('')

    const route = useRoute()
    const context = shallowRef<NativeTransferContext>()
    const review = shallowRef<{
      context: NativeTransferContext
      binding: NativeTransferBinding
      transfer: ParsedNativeTransfer
      amount: string
    }>()
    let disposed = false
    // A mounted Send page keeps its original network, including while the global UI changes.
    const requestedChain =
      route.query.chainIdentifier === undefined
        ? activeChain.chainIdentifier
        : route.query.chainIdentifier
    void (async () => {
      try {
        if (typeof requestedChain !== 'string')
          throw new Error('Invalid Send network')
        const captured = await createNativeTransferContext(requestedChain)
        if (!disposed) context.value = captured
      } catch (err) {
        if (!disposed)
          errorNotify(err, { fallbackKey: 'sendAddressDialog.invalidTransfer' })
      }
    })()
    onBeforeUnmount(() => {
      disposed = true
      review.value = undefined
      context.value = undefined
    })

    const chain = computed(
      () => review.value?.context.chain ?? context.value?.chain,
    )
    const parsedTransfer = computed(() =>
      context.value
        ? parseNativeTransferInput(
            context.value.chain,
            address.value,
            amount.value,
          )
        : undefined,
    )
    const reviewedAmount = computed(() => review.value?.amount ?? amount.value)
    const formattedRecipient = computed(() => {
      const transfer = review.value?.transfer ?? parsedTransfer.value
      return transfer && chain.value
        ? chain.value.formatAddress(transfer.recipient)
        : ''
    })
    const networkName = computed(() =>
      chain.value?.name === 'monad'
        ? $t('setup.networkTitle')
        : chain.value?.name ?? '',
    )
    const unit = computed(() => chain.value?.unit ?? '')
    const maxTotal = computed(() =>
      $t('sendAddressDialog.maxTotalWithFee', {
        amount: reviewedAmount.value,
        unit: unit.value,
      }),
    )

    const router = useRouter()

    return {
      address,
      amount,
      reviewedAmount,
      isReviewing,
      sending,
      estimatedFeeText,
      isValid: computed(() => parsedTransfer.value !== undefined),
      formattedRecipient,
      networkName,
      unit,
      maxTotal,
      reviewTransfer: async () => {
        if (sending.value) return
        const transfer = parsedTransfer.value
        const captured = context.value
        const capturedAmount = amount.value
        if (!transfer || !captured) {
          errorNotify(new Error('invalid transfer'), {
            fallbackKey: 'sendAddressDialog.invalidTransfer',
          })
          return
        }
        sending.value = true
        estimatedFeeText.value = ''
        try {
          const binding = await captured.captureWallet()
          if (disposed) return
          review.value = {
            context: captured,
            binding,
            transfer,
            amount: capturedAmount,
          }
          isReviewing.value = true
          try {
            const estimate =
              await captured.chain.nativeTransfers.estimateLegacyFee?.({
                wallet: binding.wallet,
                recipient: transfer.recipient,
                value: transfer.value,
              })
            if (estimate && !disposed) {
              estimatedFeeText.value = `${captured.chain.toDisplayAmount(
                estimate.totalFee,
              )} ${captured.chain.unit}`
            }
          } catch {
            estimatedFeeText.value = ''
          }
        } catch (err) {
          errorNotify(err, {
            fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
          })
        } finally {
          sending.value = false
        }
      },
      cancelReview: () => {
        if (sending.value) return
        review.value = undefined
        isReviewing.value = false
      },
      cancelEdit: () => {
        navigateBack(router)
      },
      confirmSend: async () => {
        if (sending.value) return
        const reviewed = review.value
        if (!reviewed) return
        sending.value = true
        let signedTxHash: string | undefined
        try {
          await reviewed.binding.assertCurrent()
          if (disposed) return
          const client = reviewed.context.chain.nativeTransfers
          const params = {
            wallet: reviewed.binding.wallet,
            recipient: reviewed.transfer.recipient,
            value: reviewed.transfer.value,
            onSigned: async (signed: { txHash: string }) => {
              signedTxHash = signed.txHash
            },
          }
          const result = client.sendLegacy
            ? await client.sendLegacy(params)
            : await client.send(params)
          sentTransactionNotify(result.txHash)
          navigateBack(router)
        } catch (err) {
          if (err instanceof NativeTransactionSubmissionError) {
            signedTxHash = err.transaction.txHash
          }
          if (signedTxHash) {
            errorNotify(err, {
              safeMessage: $t('sendAddressDialog.potentiallyBroadcast', {
                txHash: signedTxHash,
              }),
            })
          } else {
            errorNotify(err, {
              fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
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
