<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card v-if="stale" data-test="send-stale-card">
        <q-card-section>{{ $t('nativeOperation.stale') }}</q-card-section>
        <q-card-actions
          ><q-btn :label="$t('nativeOperation.back')" @click="cancelEdit"
        /></q-card-actions>
      </q-card>
      <!-- Edit State -->
      <q-card v-else-if="!isReviewing" data-test="send-edit-card">
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
            {{
              $t(
                dispatched
                  ? 'nativeOperation.title'
                  : 'sendAddressDialog.reviewTitle',
              )
            }}
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
                $t(
                  dispatched
                    ? 'nativeOperation.intendedAmount'
                    : 'sendAddressDialog.amount',
                )
              }}</span>
              <span
                class="text-weight-bold text-primary"
                data-test="review-amount"
              >
                {{ reviewedAmount }} {{ unit }}
              </span>
            </div>

            <div
              v-if="!dispatched"
              class="row justify-between items-center q-py-xs"
            >
              <span class="text-caption text-grey-7">{{
                $t('sendAddressDialog.estimatedFee')
              }}</span>
              <span class="text-grey-7" data-test="review-fee">
                {{ estimatedFeeText || $t('sendAddressDialog.feeUnavailable') }}
              </span>
            </div>

            <q-separator />

            <div
              v-if="!dispatched"
              class="row justify-between items-center q-py-xs"
            >
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

        <q-card-section v-if="!dispatched" class="q-pt-none">
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

        <!-- The network answered no: nothing was sent, and its reason is shown as given. -->
        <q-card-section
          v-if="refusal !== undefined && !dispatched"
          class="q-pt-none"
          role="alert"
          data-test="send-refused"
        >
          <q-banner dense rounded class="bg-red-1 text-red-10">
            {{ $t('sendAddressDialog.refused') }}
            <div v-if="refusal" class="text-caption text-break">
              {{ refusal }}
            </div>
          </q-banner>
        </q-card-section>

        <q-card-section
          v-if="dispatched"
          data-test="native-operation-outcome"
          role="status"
        >
          <p>
            {{
              $t(
                sending
                  ? 'nativeOperation.processing'
                  : `nativeOperation.${operation?.payment ?? 'unknown'}`,
                { network: networkName },
              )
            }}
          </p>
          <p v-if="operation" data-test="native-operation-id">
            {{ operation.operationId }}
          </p>
          <p
            v-if="outcomeHash && !operation"
            class="text-break"
            data-test="native-operation-hash"
          >
            {{ outcomeHash }}
          </p>
          <template v-if="operation">
            <p data-test="native-operation-fee">
              {{
                $t(`nativeOperation.fee${operation.feeCoverage}`, {
                  amount: observedFee,
                  unit,
                })
              }}
            </p>
            <p
              v-for="(member, index) in operation.members"
              :key="index"
              class="text-break"
            >
              {{ member.transactionHash }}
              <span v-if="member.blockNumber !== undefined">{{
                $t('nativeOperation.block', { block: member.blockNumber })
              }}</span>
            </p>
            <!-- Information, not an outcome: the payment line above is the outcome. -->
            <p
              class="text-caption text-grey-7"
              data-test="native-operation-sync"
            >
              {{
                $t(
                  operation.sharing === 'shared'
                    ? 'nativeOperation.syncShared'
                    : operation.sharing === 'failed'
                    ? 'nativeOperation.syncFailed'
                    : 'nativeOperation.syncNotShared',
                )
              }}
            </p>
          </template>
          <template v-if="operation?.payment !== 'included'">
            <p data-test="native-operation-recovery">
              {{ $t('nativeOperation.recoveryUnavailable') }}
            </p>
            <p>{{ $t('nativeOperation.reviewHeld') }}</p>
          </template>
        </q-card-section>
        <q-card-actions v-if="dispatched" align="right">
          <q-btn
            :label="$t('nativeOperation.back')"
            data-test="native-operation-back"
            @click="cancelEdit"
          />
        </q-card-actions>
        <q-card-actions v-else align="right">
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
  watch,
  watchEffect,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { sentTransactionNotify, errorNotify } from '../utils/notifications'
import {
  activeChain,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
  findEvmNativeOperationStatus,
  type EvmNativeOperationStatus,
} from '@frank/wallet/chain'
import {
  createNativeTransferContext,
  inspectNativeTransferOperations,
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
    const dispatched = ref(false)
    const stale = ref(false)
    const operation = shallowRef<EvmNativeOperationStatus>()
    const outcomeHash = ref<string>()
    const estimatedFeeText = ref('')
    // Set when the network refused the last attempt outright; holds the node's reason.
    const refusal = ref<string>()

    const route = useRoute()
    const context = shallowRef<NativeTransferContext>()
    const review = shallowRef<{
      context: NativeTransferContext
      binding: NativeTransferBinding
      transfer: ParsedNativeTransfer
      amount: string
    }>()
    let disposed = false
    const invalidate = () => {
      disposed = true
      stale.value = true
      review.value = undefined
      context.value = undefined
      operation.value = undefined
      outcomeHash.value = undefined
    }
    watch(() => route.fullPath, invalidate, { flush: 'sync' })
    watchEffect(() => {
      if (review.value && !review.value.binding.isCurrent()) invalidate()
    })
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
      dispatched,
      stale,
      operation,
      outcomeHash,
      observedFee: computed(() =>
        operation.value && chain.value
          ? chain.value.toDisplayAmount(BigInt(operation.value.observedFeeWei))
          : '',
      ),
      estimatedFeeText,
      refusal,
      isValid: computed(() => parsedTransfer.value !== undefined),
      formattedRecipient,
      networkName,
      unit,
      maxTotal,
      reviewTransfer: async () => {
        if (sending.value || dispatched.value || disposed) return
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
            if (!disposed) estimatedFeeText.value = ''
          }
        } catch (err) {
          if (disposed) return
          errorNotify(err, {
            fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
          })
        } finally {
          if (!disposed) sending.value = false
        }
      },
      cancelReview: () => {
        if (sending.value || dispatched.value || disposed) return
        review.value = undefined
        isReviewing.value = false
      },
      cancelEdit: () => {
        navigateBack(router)
      },
      confirmSend: async () => {
        if (sending.value || dispatched.value || disposed) return
        const reviewed = review.value
        if (!reviewed) return
        sending.value = true
        let signedTxHash: string | undefined
        const current = async () => {
          if (disposed) return false
          try {
            await reviewed.binding.assertCurrent()
            if (disposed) return false
            return true
          } catch {
            invalidate()
            return false
          }
        }
        const inspect = () => {
          const evidence = inspectNativeTransferOperations(
            reviewed.binding.wallet,
            reviewed.context.chain.chainIdentifier,
          )
          const found =
            evidence.status === 'available'
              ? findEvmNativeOperationStatus(
                  evidence.operations,
                  reviewed.context.chain.chainIdentifier,
                  signedTxHash,
                )
              : undefined
          // Intent checks are additional guards; identity comes only from the unique final hash.
          operation.value =
            found &&
            found.recipient.toLowerCase() ===
              reviewed.transfer.recipient.raw.toLowerCase() &&
            found.intendedValueWei === reviewed.transfer.value.toString()
              ? found
              : undefined
          outcomeHash.value = signedTxHash
          return evidence
        }
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
          // No post-dispatch error proves that a fresh payment is safe.
          refusal.value = undefined
          dispatched.value = true
          const result = client.sendLegacy
            ? await client.sendLegacy(params)
            : await client.send(params)
          signedTxHash = result.txHash
          if (!(await current())) return
          inspect()
          // An included payment is a completed send. Whether the wallet's other devices have
          // been told is information shown with the transfer, never a reason to hold this page.
          if (
            reviewed.binding.wallet.family === 'evm' &&
            (!operation.value || operation.value.payment !== 'included')
          )
            return
          sentTransactionNotify(result.txHash)
          navigateBack(router)
        } catch (err) {
          if (disposed) return
          if (!dispatched.value) {
            errorNotify(err, {
              fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
            })
            return
          }
          // The one exception: the network answered and refused, so nothing was sent.
          if (err instanceof NativeTransactionRefusedError) {
            dispatched.value = false
            refusal.value = err.reason
            return
          }
          if (err instanceof NativeTransactionSubmissionError)
            signedTxHash = err.transaction.txHash
          if (!(await current())) return
          inspect()
        } finally {
          if (!disposed) sending.value = false
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
