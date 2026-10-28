<template>
  <div>
    <!-- The page's app header: its back arrow does what the card's own Back / Cancel / Edit
    button does at this step, nothing else. -->
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          icon="arrow_back"
          :aria-label="$t('settings.back')"
          :disable="isReviewing && !stale && !dispatched && sending"
          data-test="send-header-back"
          @click="
            isReviewing && !stale && !dispatched ? cancelReview() : cancelEdit()
          "
        />
        <q-toolbar-title class="h6" data-test="send-title">{{
          $t('sendAddressDialog.sendToAddress')
        }}</q-toolbar-title>
      </q-toolbar>
    </q-header>
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
            <q-input
              class="text-bold text-h6"
              v-model="address"
              filled
              dense
              data-test="send-address-input"
              :placeholder="$t('sendAddressDialog.recipient')"
            />
          </q-card-section>
          <q-btn
            flat
            icon="qr_code_scanner"
            :label="$t('qrScanner.open')"
            :disable="!chainReady"
            data-test="send-scan"
            @click="showScanner = true"
          />
          <p class="q-px-md text-caption">{{ $t('qrScanner.paymentHint') }}</p>
          <q-card-section>
            <q-input
              class="text-bold text-h6"
              v-model="amount"
              inputmode="decimal"
              filled
              dense
              data-test="send-amount-input"
              :placeholder="$t('sendAddressDialog.enterAmount', { unit })"
            >
              <template v-if="maxSupported" #append>
                <q-btn
                  flat
                  dense
                  no-caps
                  :label="$t('sendAddressDialog.sendMax')"
                  :disable="!recipientValid || sending || fillingMax"
                  :loading="fillingMax"
                  data-test="send-max-button"
                  @click="fillMax"
                />
              </template>
            </q-input>
            <p
              v-if="maxUnavailableReason"
              class="text-caption text-negative q-mt-xs q-mb-none"
              role="alert"
              data-test="send-max-unavailable"
            >
              {{
                $t('sendAddressDialog.sendMaxUnavailable', {
                  reason: maxUnavailableReason,
                })
              }}
            </p>
            <!-- The payment floor: the wallet refused the amount (or everything it can send), and
                 says the minimum. Nothing was signed. -->
            <p
              v-if="belowFloorText"
              class="text-caption text-negative q-mt-xs q-mb-none"
              role="alert"
              data-test="send-below-floor"
            >
              {{ belowFloorText }}
            </p>
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
          <!-- The wallet could not open on this network: say why, instead of blaming the input. -->
          <q-card-section
            v-if="openFailure"
            class="q-pt-none"
            role="alert"
            data-test="send-wallet-unavailable"
          >
            <q-banner dense rounded class="bg-red-1 text-red-10">
              {{ $t(openFailure) }}
            </q-banner>
          </q-card-section>
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
                <span class="text-grey-7 text-right" data-test="review-fee">
                  {{
                    estimatedFeeText ||
                    (feeEstimating
                      ? $t('sendAddressDialog.feeEstimating')
                      : feeUnavailableReason
                      ? $t('sendAddressDialog.feeUnavailableBecause', {
                          reason: feeUnavailableReason,
                        })
                      : $t('sendAddressDialog.feeUnavailable'))
                  }}
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

          <q-card-section
            v-if="feeChanged && !dispatched"
            class="q-pt-none"
            role="alert"
            data-test="send-fee-changed"
          >
            <q-banner dense rounded class="bg-amber-1 text-amber-10">
              {{ $t('sendAddressDialog.feeChanged') }}
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
            <!-- While the send is under way its record is not read yet: a neutral line, never the
                 recovery wording a reopened, unresolved transfer gets. -->
            <p data-test="native-operation-line">
              {{
                sending
                  ? $t('nativeOperation.submitting', { network: networkName })
                  : $t(outcomeLine.key, outcomeLine.params)
              }}
            </p>
            <!-- The recipient is paid, but the rest of the send (its change) is not in a block
                 yet: the page does not claim the send is final. -->
            <p v-if="settling" data-test="native-operation-settling">
              {{
                $t(
                  settling.confirmed <= 1
                    ? 'nativeOperation.changeSettlingOne'
                    : 'nativeOperation.changeSettling',
                  settling,
                )
              }}
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
              <!-- Information, not an outcome: the payment line above is the outcome. Nothing is
                   shared while no transfer has landed: a transfer that never lands never is. -->
              <p
                v-if="operation.sharing !== 'none'"
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
            <!-- In the mempool, or not at the node yet: the wallet is watching for its block. -->
            <p v-if="watching" data-test="native-operation-watching">
              {{ $t('nativeOperation.watching') }}
            </p>
            <template v-else-if="!sending && operation?.payment !== 'included'">
              <!-- Only while the outcome is still open. A transfer that reverted, was replaced or
                   was cancelled is final, and its line above says so. -->
              <p
                v-if="
                  operation === undefined ||
                  ((operation.payment === 'unknown' ||
                    operation.payment === 'partial') &&
                    !nativeOperationProgress(operation))
                "
                data-test="native-operation-recovery"
              >
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
        <qr-scanner-dialog
          v-model="showScanner"
          :network-name="networkName"
          :context="scannerContext"
          :validate-address="validateScannedAddress"
          @scan="address = $event"
        />
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import QrScannerDialog from 'src/components/dialogs/QrScannerDialog.vue'
import { accountSession } from 'src/accounts/session'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import {
  FORM_STEP,
  formStart,
  formStep,
  formStepLocation,
  goBack,
  leaveForm,
  settleForm,
} from 'src/utils/navigation'
import {
  nativeOperationOutcome,
  nativeOperationProgress,
  nativeOperationSettling,
} from 'src/utils/native-operation-outcome'
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
import { fundsInPendingSendMessage } from '../utils/funds-in-pending-send'
import {
  activeChain,
  onActiveChainChange,
  NativeFeeExceededError,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
  ContactPaymentBelowFloorError,
  findEvmNativeOperationStatus,
  type EvmNativeOperationStatus,
} from '@frank/wallet/chain'
import {
  createNativeTransferContext,
  inspectNativeTransferOperations,
  inspectNativeTransferOperation,
  type NativeOperationInspection,
  type NativeTransferContext,
  type NativeTransferBinding,
} from 'src/accounts/native-transfer'
import {
  parseNativeTransferInput,
  type ParsedNativeTransfer,
} from 'src/utils/native-transfer'
import { useTranslate } from 'src/composables/useTranslate'
import {
  walletOpenFailureKey,
  type WalletOpenFailureKey,
} from 'src/accounts/wallet-open-failure'

/** How often, and for how long, the outcome page re-reads a sent transfer's journal row while
 * its change and its note to the account's other devices are still going out. */
const SETTLE_READ_INTERVAL_MS = 2_000
/** The form's review step, in the address (`?step=review`). */
const REVIEW_STEP = 'review'
const SETTLE_READ_LIMIT_MS = 15 * 60_000

export default defineComponent({
  components: { QrScannerDialog },
  setup() {
    const $t = useTranslate()
    const showScanner = ref(false)
    onBeforeUnmount(
      onActiveChainChange(() => {
        showScanner.value = false
      }),
    )
    const route = useRoute()
    // A recipient handed over by another page (a persona top-up), still reviewed here.
    const address = ref(
      typeof route.query.to === 'string' ? route.query.to : '',
    )
    const amount = ref('')
    // "Max": the wallet's answer for the most one transfer can send now, and why it has none.
    const fillingMax = ref(false)
    const maxUnavailableReason = ref('')
    // Set when the wallet refused the amount (or, for Max, everything it can send) below the
    // payment floor: the message naming the minimum. Cleared when the amount changes.
    const belowFloorText = ref('')
    /** Refused because the money is still in an earlier send's change that has not reached the
     * chain (`FundsInPendingSendError`): the words, with the amount; otherwise undefined. */
    const tiedUpText = (err: unknown, chain: NativeTransferContext['chain']) =>
      fundsInPendingSendMessage(
        err,
        wei => `${chain.toDisplayAmount(wei)} ${chain.unit}`,
        (key, params) => $t(key, params),
      )
    const floorRefusal = (
      err: unknown,
      captured: NativeTransferContext,
      max: boolean,
    ): string | undefined =>
      err instanceof ContactPaymentBelowFloorError
        ? $t(
            max
              ? 'sendAddressDialog.maxBelowMinimum'
              : 'sendAddressDialog.belowMinimum',
            {
              amount: `${captured.chain.toDisplayAmount(err.floorWei)} ${
                captured.chain.unit
              }`,
              max: `${captured.chain.toDisplayAmount(err.valueWei)} ${
                captured.chain.unit
              }`,
            },
          )
        : undefined
    const isReviewing = ref(false)
    const sending = ref(false)
    const dispatched = ref(false)
    const stale = ref(false)
    const operation = shallowRef<EvmNativeOperationStatus>()
    // True while the shown transfer is not in a block yet and the wallet is looking for it.
    const watching = ref(false)
    const outcomeHash = ref<string>()
    const estimatedFeeText = ref('')
    // The wallet's own quote for the reviewed transfer, and why there is none when it fails.
    const estimatedFeeWei = ref<bigint>()
    const feeEstimating = ref(false)
    const feeUnavailableReason = ref('')
    // Set when the network refused the last attempt outright; holds the node's reason.
    const refusal = ref<string>()
    // Set when this network's wallet could not open: an app-owned reason, shown on the page.
    const openFailure = ref<WalletOpenFailureKey>()
    // The fee the review screen showed, in base units: the ceiling the send may not exceed.
    let reviewedFee: bigint | undefined
    // Set when the fee rose above the reviewed one, so the new fee is reviewed before sending.
    const feeChanged = ref(false)

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
    // Another address (another network, another recipient) is another page; the form's own
    // step (the review) is not.
    const pageAddress = () => {
      const [beforeHash, hash] = route.fullPath.split('#')
      const [path, search] = (beforeHash ?? '').split('?')
      const query = new URLSearchParams(search ?? '')
      query.delete(FORM_STEP)
      const rest = query.toString()
      return `${path}${rest ? `?${rest}` : ''}${hash ? `#${hash}` : ''}`
    }
    watch(pageAddress, invalidate, { flush: 'sync' })
    watch(amount, () => {
      belowFloorText.value = ''
    })
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
        if (disposed) return
        openFailure.value = walletOpenFailureKey(err)
        errorNotify(err, { fallbackKey: openFailure.value })
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
    const networkName = computed(
      () =>
        getChainRegistryEntry(chain.value?.chainIdentifier ?? '')?.name ??
        chain.value?.name ??
        '',
    )
    const unit = computed(() => chain.value?.unit ?? '')
    // With the wallet's quote, the exact sum; without one, the amount and a note that the fee
    // comes on top.
    const maxTotal = computed(() => {
      const fee = estimatedFeeWei.value
      const value = review.value?.transfer.value
      return fee !== undefined && value !== undefined && chain.value
        ? `${chain.value.toDisplayAmount(value + fee)} ${unit.value}`
        : $t('sendAddressDialog.maxTotalWithFee', {
            amount: reviewedAmount.value,
            unit: unit.value,
          })
    })

    const router = useRouter()
    // The form's first entry (utils/navigation). A review reached by its address alone (a
    // reload, a link) has nothing to review: the form shows in its place.
    if (formStep(route)) void router.replace(formStepLocation(route, null))
    const start = formStart()
    /** The review's entry gives way to the form's: Back, as from the review. */
    const leaveReviewStep = () => {
      if (formStep(route) === REVIEW_STEP)
        goBack(router, formStepLocation(route, null))
    }

    /**
     * Once the transfer went out (sent or pending), or may have (an error after which money may
     * have moved), its outcome takes the form's place in history: neither Back nor Forward
     * reaches the form or its review again. Refused with nothing sent (before signing, or by
     * the network after signing, its coins freed), the review stays a step: Back still reaches
     * the form.
     */
    let settling: Promise<void> | undefined
    const settleOutcome = (): Promise<void> => {
      if (disposed) return Promise.resolve()
      settling ??= (async () => {
        if (formStep(route)) await router.replace(formStepLocation(route, null))
        if (!disposed) await settleForm(router, start, '/wallet')
      })()
      return settling
    }

    const reviewTransfer = async () => {
      if (sending.value || dispatched.value || disposed) return
      const transfer = parsedTransfer.value
      const captured = context.value
      const capturedAmount = amount.value
      if (!transfer || !captured) {
        errorNotify(new Error('invalid transfer'), {
          fallbackKey: openFailure.value ?? 'sendAddressDialog.invalidTransfer',
        })
        return
      }
      sending.value = true
      // Where the user was when quoting began: a quote landing after they moved (Back off a
      // review reached by Forward) must not navigate them again.
      const quotedOn = route.fullPath
      estimatedFeeText.value = ''
      estimatedFeeWei.value = undefined
      feeUnavailableReason.value = ''
      reviewedFee = undefined
      feeChanged.value = false
      belowFloorText.value = ''
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
        feeEstimating.value = true
        try {
          const estimate =
            await captured.chain.nativeTransfers.estimateLegacyFee?.({
              wallet: binding.wallet,
              recipient: transfer.recipient,
              value: transfer.value,
            })
          if (estimate && !disposed) {
            reviewedFee = estimate.totalFee
            estimatedFeeWei.value = estimate.totalFee
            estimatedFeeText.value = `${captured.chain.toDisplayAmount(
              estimate.totalFee,
            )} ${captured.chain.unit}`
          }
        } catch (err) {
          // Below the payment floor: no review. The amount is refused, with the minimum, on
          // the page where it is entered.
          const refused = disposed
            ? undefined
            : floorRefusal(err, captured, false)
          if (refused) {
            review.value = undefined
            isReviewing.value = false
            belowFloorText.value = refused
            leaveReviewStep()
            return
          }
          // Said, with the wallet's reason: never a silent "unavailable". Money still in an
          // earlier send's change is said plainly, with the amount.
          if (!disposed) {
            estimatedFeeText.value = ''
            feeUnavailableReason.value =
              tiedUpText(err, captured.chain) ??
              (err instanceof Error && err.message ? err.message : String(err))
          }
        } finally {
          if (!disposed) feeEstimating.value = false
        }
        if (disposed) return
        if (route.fullPath !== quotedOn) {
          // The user moved while the quote was on its way: off the review, it is dropped.
          if (formStep(route) !== REVIEW_STEP) {
            review.value = undefined
            isReviewing.value = false
          }
          return
        }
        // The review is a step of its own once the amount is accepted (a refused amount stays
        // on the form, with no step to go Forward to): Back returns to the form, filled in.
        if (isReviewing.value && formStep(route) !== REVIEW_STEP)
          void router.push(formStepLocation(route, REVIEW_STEP))
      } catch (err) {
        if (disposed) return
        errorNotify(err, {
          fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
        })
      } finally {
        if (!disposed) sending.value = false
      }
    }

    // Back from the review shows the form, filled in as it was; Forward onto it reviews the
    // form again (a fresh quote). A send under way or made stays as it is: it is never
    // re-entered, and an address with nothing to review shows the form.
    watch(
      () => formStep(route),
      step => {
        if (disposed) return
        if (step === REVIEW_STEP) {
          if (isReviewing.value) return
          if (
            !dispatched.value &&
            !sending.value &&
            parsedTransfer.value &&
            context.value
          )
            void reviewTransfer()
          else void router.replace(formStepLocation(route, null))
          return
        }
        if (isReviewing.value && !sending.value && !dispatched.value) {
          review.value = undefined
          isReviewing.value = false
        }
      },
    )

    return {
      address,
      showScanner,
      chainReady: computed(() => !!context.value),
      scannerContext: () => {
        const state = accountSession.state
        if (
          disposed ||
          isReviewing.value ||
          !context.value ||
          state.status !== 'ready'
        )
          return undefined
        return `${state.revision}:${context.value.chain.chainIdentifier}:${activeChain.chainIdentifier}:${route.fullPath}`
      },
      validateScannedAddress: (value: string) =>
        !!context.value?.chain.parseAddress(value),
      amount,
      reviewedAmount,
      isReviewing,
      sending,
      dispatched,
      stale,
      operation,
      watching,
      outcomeHash,
      // A send still under way reads as such; "unresolved" only when it is (`nativeOperationProgress`).
      outcomeLine: computed(() =>
        nativeOperationOutcome(operation.value, networkName.value),
      ),
      nativeOperationProgress,
      settling: computed(() =>
        operation.value ? nativeOperationSettling(operation.value) : undefined,
      ),
      observedFee: computed(() =>
        operation.value && chain.value
          ? chain.value.toDisplayAmount(BigInt(operation.value.observedFeeWei))
          : '',
      ),
      estimatedFeeText,
      feeEstimating,
      feeUnavailableReason,
      refusal,
      openFailure,
      feeChanged,
      isValid: computed(() => parsedTransfer.value !== undefined),
      maxSupported: computed(
        () => !!context.value?.chain.nativeTransfers.estimateLegacyMax,
      ),
      recipientValid: computed(
        () => !!context.value?.chain.parseAddress(address.value.trim()),
      ),
      fillingMax,
      maxUnavailableReason,
      belowFloorText,
      // Everything the wallet can send now in one transfer, less its fee: the same selection
      // the send makes, so reviewing this amount shows the fee that will be paid.
      fillMax: async () => {
        const captured = context.value
        const recipient = captured?.chain.parseAddress(address.value.trim())
        const transfers = captured?.chain.nativeTransfers
        if (
          !captured ||
          !recipient ||
          !transfers?.estimateLegacyMax ||
          fillingMax.value
        )
          return
        fillingMax.value = true
        maxUnavailableReason.value = ''
        try {
          const binding = await captured.captureWallet()
          const max = await transfers.estimateLegacyMax({
            wallet: binding.wallet,
            recipient,
          })
          if (disposed || context.value !== captured) return
          amount.value = captured.chain.toDisplayAmount(max.value)
        } catch (err) {
          if (disposed) return
          const refused = floorRefusal(err, captured, true)
          if (refused) belowFloorText.value = refused
          else
            maxUnavailableReason.value =
              err instanceof Error && err.message ? err.message : String(err)
        } finally {
          if (!disposed) fillingMax.value = false
        }
      },
      formattedRecipient,
      networkName,
      unit,
      maxTotal,
      reviewTransfer,
      cancelReview: () => {
        if (sending.value || dispatched.value || disposed) return
        if (formStep(route) === REVIEW_STEP) {
          leaveReviewStep()
          return
        }
        review.value = undefined
        isReviewing.value = false
      },
      cancelEdit: () => {
        leaveForm(router, start, '/wallet')
      },
      confirmSend: async () => {
        if (sending.value || dispatched.value || disposed) return
        const reviewed = review.value
        if (!reviewed) return
        sending.value = true
        let signedTxHash: string | undefined
        let signedOperationId: string | undefined
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
        const matching = (evidence: NativeOperationInspection) => {
          const found =
            evidence.status === 'available'
              ? findEvmNativeOperationStatus(
                  evidence.operations,
                  reviewed.context.chain.chainIdentifier,
                  signedTxHash,
                )
              : undefined
          return found &&
            (!signedOperationId || found.operationId === signedOperationId) &&
            found.recipient.toLowerCase() ===
              reviewed.transfer.recipient.raw.toLowerCase() &&
            found.intendedValueWei === reviewed.transfer.value.toString()
            ? found
            : undefined
        }
        const inspect = async () => {
          if (disposed || !reviewed.binding.isCurrent()) return
          const wallet = reviewed.binding.wallet
          const chainIdentifier = reviewed.context.chain.chainIdentifier
          let evidence = inspectNativeTransferOperations(
            wallet,
            chainIdentifier,
          )
          let found = matching(evidence)
          if (!found && evidence.status === 'available' && signedOperationId) {
            evidence = await inspectNativeTransferOperation(
              wallet,
              chainIdentifier,
              signedOperationId,
            )
            found = matching(evidence)
          }
          // The account or route may have changed while completed history was being read.
          if (disposed || !reviewed.binding.isCurrent()) return
          if (found && !signedOperationId) signedOperationId = found.operationId
          operation.value = found
          outcomeHash.value = signedTxHash
        }
        // A transfer that is in the mempool, or that the node does not have yet, is not final:
        // the wallet looks again at each look of its block watcher and this page re-reads the
        // journal after each, until the chain shows the transfer in a block (or the page goes).
        // Without this the page kept the answer of the one look made right after the broadcast.
        const notFinal = () =>
          operation.value?.payment === 'pending' ||
          operation.value?.payment === 'missing' ||
          operation.value?.payment === 'unknown'
        // Once the payment is in a block, the rest of the operation still happens: its change
        // lands and the note telling the account's other devices goes out (it is sent after the
        // transactions it describes land). The page keeps reading the journal, which is local,
        // until those are done, so it never keeps saying "not yet shared" after the note went
        // out. The QA run that found this saw it several minutes after History said "sent".
        const unsettled = () => {
          const op = operation.value
          return (
            op?.payment === 'included' &&
            (op.sharing === 'not-shared' ||
              op.sharing === 'failed' ||
              op.members.some(
                member =>
                  member.state !== 'included-success' &&
                  member.state !== 'included-revert' &&
                  member.state !== 'superseded',
              ))
          )
        }
        const settle = async () => {
          const until = Date.now() + SETTLE_READ_LIMIT_MS
          while (
            !disposed &&
            reviewed.binding.isCurrent() &&
            unsettled() &&
            Date.now() < until
          ) {
            await new Promise(resolve =>
              setTimeout(resolve, SETTLE_READ_INTERVAL_MS),
            )
            if (disposed) return
            await inspect()
          }
        }
        const watch = async () => {
          const wallet = reviewed.binding.wallet
          const id = operation.value?.operationId
          if (!id || !notFinal() || !wallet.watchNativeOperation) return
          watching.value = true
          try {
            while (!disposed && reviewed.binding.isCurrent() && notFinal()) {
              await wallet.watchNativeOperation(id)
              if (disposed) return
              await inspect()
            }
            if (
              !disposed &&
              reviewed.binding.isCurrent() &&
              operation.value?.payment === 'included'
            ) {
              sentTransactionNotify(
                reviewed.context.chain.chainIdentifier,
                signedTxHash,
              )
              void settle()
            }
          } catch {
            // The wallet was closed: what is shown stays; the journal keeps the transfer.
          } finally {
            if (!disposed) watching.value = false
          }
        }
        try {
          await reviewed.binding.assertCurrent()
          if (disposed) return
          const client = reviewed.context.chain.nativeTransfers
          const params = {
            wallet: reviewed.binding.wallet,
            recipient: reviewed.transfer.recipient,
            value: reviewed.transfer.value,
            // The reviewed fee binds: the wallet may pay less, never more.
            maxFee: reviewedFee,
            onSigned: async (signed: { txHash: string }) => {
              signedTxHash = signed.txHash
              // onSigned runs before broadcast, while the original row is still active.
              if (
                !signedOperationId &&
                !disposed &&
                reviewed.binding.isCurrent()
              )
                signedOperationId = matching(
                  inspectNativeTransferOperations(
                    reviewed.binding.wallet,
                    reviewed.context.chain.chainIdentifier,
                  ),
                )?.operationId
            },
          }
          // No post-dispatch error proves that a fresh payment is safe.
          refusal.value = undefined
          feeChanged.value = false
          dispatched.value = true
          const result = client.sendLegacy
            ? await client.sendLegacy(params)
            : await client.send(params)
          signedTxHash = result.txHash
          // Sent or pending: the payment's outcome.
          void settleOutcome()
          if (!(await current())) return
          await inspect()
          if (disposed || !reviewed.binding.isCurrent()) return
          // An included payment is a completed send. Whether the wallet's other devices have
          // been told is information shown with the transfer, never a reason to hold this page.
          if (reviewed.binding.wallet.family === 'evm') {
            // The page stays on the outcome: sent, its block and its fee, from the journal.
            if (operation.value?.payment === 'included') {
              sentTransactionNotify(
                reviewed.context.chain.chainIdentifier,
                result.txHash,
              )
              void settle()
            } else void watch()
            return
          }
          sentTransactionNotify(
            reviewed.context.chain.chainIdentifier,
            result.txHash,
          )
          await settleOutcome()
          if (!disposed) leaveForm(router, start, '/wallet')
        } catch (err) {
          if (disposed) return
          if (!dispatched.value) {
            const tiedUp = tiedUpText(err, reviewed.context.chain)
            errorNotify(
              err,
              tiedUp
                ? { safeMessage: tiedUp }
                : { fallbackKey: 'sendAddressDialog.definitelyNotBroadcast' },
            )
            return
          }
          // Refused below the payment floor before anything was signed (the floor rose since
          // the review): back to the amount, saying the minimum.
          const refused = floorRefusal(err, reviewed.context, false)
          if (refused && signedTxHash === undefined) {
            dispatched.value = false
            review.value = undefined
            isReviewing.value = false
            belowFloorText.value = refused
            return
          }
          // The one exception: the network answered and refused, so nothing was sent.
          if (err instanceof NativeTransactionRefusedError) {
            dispatched.value = false
            refusal.value = err.reason
            return
          }
          // Nothing was signed: the fee is now higher than the one reviewed. Back to review,
          // showing the new fee, which becomes the ceiling if the user confirms again.
          if (err instanceof NativeFeeExceededError) {
            dispatched.value = false
            feeChanged.value = true
            reviewedFee = err.fee
            estimatedFeeWei.value = err.fee
            estimatedFeeText.value = `${reviewed.context.chain.toDisplayAmount(
              err.fee,
            )} ${reviewed.context.chain.unit}`
            return
          }
          if (err instanceof NativeTransactionSubmissionError)
            signedTxHash = err.transaction.txHash
          // Nothing was signed (the wallet reports a signature before it hands anything to the
          // network, and it reported none): the transfer was refused while it was being
          // planned, so nothing can have moved. Say so, with the reason, and go back to the
          // review. Shown as "unresolved, funds may have moved" before, with nothing on chain.
          if (
            reviewed.binding.wallet.family === 'evm' &&
            signedTxHash === undefined
          ) {
            dispatched.value = false
            // Money still in an earlier send's change (owner ruling 2026-10-26): said plainly,
            // with the amount; the user tries again in a moment.
            const tiedUp = tiedUpText(err, reviewed.context.chain)
            errorNotify(
              err,
              tiedUp
                ? { safeMessage: tiedUp }
                : { fallbackKey: 'sendAddressDialog.definitelyNotBroadcast' },
            )
            return
          }
          // Money may have moved: the outcome, never the form again.
          void settleOutcome()
          if (!(await current())) return
          await inspect()
          if (disposed || !reviewed.binding.isCurrent()) return
          if (operation.value?.payment === 'included') void settle()
          else void watch()
        } finally {
          if (!disposed) sending.value = false
        }
      },
      send: async function (this: { confirmSend(): Promise<void> }) {
        return this.confirmSend()
      },
      cancel: function (this: { cancelEdit(): void }) {
        return this.cancelEdit()
      },
    }
  },
})
</script>
