<template>
  <div
    ref="root"
    class="evm-swap-panel"
    data-testid="evm-swap-panel"
    @pointerdown="touched"
    @keydown="touched"
    @focusin="touched"
  >
    <div
      v-if="unavailable"
      class="q-pa-md text-body2 text-grey-7"
      role="status"
      data-testid="swap-unavailable"
    >
      {{ $t(unavailableKey) }}
    </div>

    <div v-else class="column q-gutter-y-sm">
      <!-- Result of the last swap -->
      <q-card
        v-if="phase === 'done' && outcome"
        flat
        bordered
        class="q-pa-md swap-card"
        :class="`swap-card--${outcome.status}`"
        role="status"
        data-testid="swap-result"
      >
        <div class="row items-center q-gutter-x-sm q-mb-xs">
          <q-icon :name="resultIcon" :color="resultColor" size="22px" />
          <span class="text-subtitle1 text-weight-bold">
            {{ $t(resultTitleKey) }}
          </span>
        </div>
        <div
          v-if="outcome.status === 'confirmed' && outcome.received"
          class="text-h6 text-weight-bold"
          :title="outcome.receivedExact"
          data-testid="swap-result-received"
        >
          {{ outcome.received }} {{ outcome.toSymbol }}
        </div>
        <div class="text-body2 text-grey-7" data-testid="swap-result-detail">
          {{ $t(resultDetailKey, resultDetailParams) }}
        </div>
        <div
          v-if="outcome.paid"
          class="text-body2 q-mt-xs"
          data-testid="swap-result-paid"
        >
          {{ $t(outcome.paid.key, outcome.paid.params) }}
        </div>
        <div class="row items-center justify-between q-mt-sm">
          <a
            v-if="outcome.explorerUrl"
            :href="outcome.explorerUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-caption text-primary"
            data-testid="swap-result-explorer"
          >
            {{ $t('walletPanel.viewInExplorer') }}
          </a>
          <span v-else class="text-caption text-grey-6 ellipsis">
            {{ outcome.txHash }}
          </span>
          <q-btn
            flat
            no-caps
            dense
            color="primary"
            :label="$t('swap.newSwap')"
            data-testid="swap-new-btn"
            @click="startOver"
          />
        </div>
      </q-card>

      <template v-else>
        <!-- You pay -->
        <q-card
          flat
          bordered
          class="q-pa-md swap-card"
          :class="{ 'swap-card--error': insufficient }"
        >
          <div class="row items-center justify-between q-mb-xs">
            <span class="text-caption text-grey-7">{{ $t('swap.pay') }}</span>
            <span
              class="text-caption text-weight-medium"
              :class="insufficient ? 'text-negative' : 'text-primary'"
              :title="payBalanceExact"
              data-testid="swap-pay-balance"
            >
              {{ $t('swap.available') }}: {{ payBalanceText }}
            </span>
          </div>
          <div class="row items-center q-gutter-sm no-wrap">
            <div
              class="swap-amount-box col row items-center no-wrap"
              :class="{ 'swap-amount-box--error': insufficient }"
            >
              <q-input
                v-model="amountText"
                dense
                borderless
                inputmode="decimal"
                placeholder="0.0"
                class="col text-h5"
                input-class="text-weight-bold"
                :disable="locked"
                :aria-label="$t('swap.pay')"
                data-testid="swap-pay-amount"
              />
              <q-btn
                flat
                dense
                no-caps
                size="sm"
                color="primary"
                class="swap-max-pill q-px-xs q-mr-xs text-weight-bolder"
                :disable="locked || !canMax"
                :label="$t('swap.max')"
                data-testid="swap-max-btn"
                @click="useMax"
              />
            </div>
            <q-select
              v-model="payIndex"
              :options="tokenOptions($t('swap.testToken'))"
              dense
              outlined
              emit-value
              map-options
              class="col-auto asset-select"
              :disable="locked"
              :aria-label="$t('swap.payToken')"
              data-testid="swap-pay-token"
            />
          </div>
          <div
            v-if="otherAccountsText"
            class="text-caption text-grey-6 q-mt-xs"
            data-testid="swap-other-accounts"
          >
            {{ $t('swap.otherAccounts', { amount: otherAccountsText }) }}
          </div>
        </q-card>

        <div class="swap-flip-container">
          <q-btn
            round
            dense
            icon="swap_vert"
            color="primary"
            class="swap-flip-btn shadow-2"
            :disable="locked"
            :aria-label="$t('swap.switchTokens')"
            data-testid="swap-flip-btn"
            @click="flip"
          />
        </div>

        <!-- You receive -->
        <q-card flat bordered class="q-pa-md swap-card">
          <div class="row items-center justify-between q-mb-xs">
            <span class="text-caption text-grey-7">
              {{ $t('swap.receive') }}
            </span>
            <span
              class="text-caption text-grey-6"
              :title="receiveBalanceExact"
              data-testid="swap-receive-balance"
            >
              {{ $t('swap.balance') }}: {{ receiveBalanceText }}
            </span>
          </div>
          <div class="row items-center q-gutter-sm no-wrap">
            <div
              class="swap-amount-box swap-amount-box--readonly col row items-center no-wrap"
            >
              <q-skeleton
                v-if="quoteState === 'loading' && !quote"
                type="text"
                class="col text-h5"
                data-testid="swap-quote-loading"
              />
              <div
                v-else
                class="col text-h5 text-weight-bold swap-receive-amount"
                :class="quote ? 'text-positive' : 'text-grey-5'"
                :title="quote ? receiveExact : undefined"
                data-testid="swap-receive-amount"
              >
                {{ quote ? receiveText : '0.0' }}
              </div>
            </div>
            <q-select
              v-model="receiveIndex"
              :options="tokenOptions($t('swap.testToken'))"
              dense
              outlined
              emit-value
              map-options
              class="col-auto asset-select"
              :disable="locked"
              :aria-label="$t('swap.receiveToken')"
              data-testid="swap-receive-token"
            />
          </div>
        </q-card>

        <!-- What the chain quoted -->
        <q-card
          v-if="quote"
          flat
          bordered
          class="q-pa-sm text-caption swap-card swap-details"
          data-testid="swap-details"
        >
          <div class="swap-row">
            <span class="text-grey-7">{{ $t('swap.rate') }}</span>
            <span class="text-weight-medium" data-testid="swap-rate">
              {{ rateText }}
            </span>
          </div>
          <div class="swap-row">
            <span class="text-grey-7">{{ $t('swap.priceImpact') }}</span>
            <span
              class="text-weight-medium"
              :class="impactClass"
              data-testid="swap-price-impact"
            >
              {{ impactText }}
            </span>
          </div>
          <div class="swap-row">
            <span class="text-grey-7">{{ $t('swap.poolFee') }}</span>
            <span class="text-weight-medium" data-testid="swap-pool-fee">
              {{ poolFeeText }}
            </span>
          </div>
          <div class="swap-row">
            <span class="text-grey-7">
              {{ $t('swap.minimumReceived') }}
            </span>
            <span
              class="text-weight-medium"
              :title="minimumExact"
              data-testid="swap-minimum-received"
            >
              {{ minimumText }} {{ receiveToken.symbol }}
            </span>
          </div>
          <div class="swap-row">
            <span class="text-grey-7">{{ $t('swap.networkFee') }}</span>
            <span class="text-weight-medium" data-testid="swap-network-fee">
              {{ $t(feeLine.key, feeLine.params) }}
            </span>
          </div>
          <div v-if="interfaceFeeText" class="swap-row">
            <span class="text-grey-7">
              {{ $t('swap.interfaceFee', { rate: interfaceFeeRate }) }}
            </span>
            <span class="text-weight-medium" data-testid="swap-interface-fee">
              {{ interfaceFeeText }} {{ receiveToken.symbol }}
            </span>
          </div>
          <div
            v-if="approvalsNeeded > 0"
            class="swap-row"
            data-testid="swap-approval-needed"
          >
            <span class="text-grey-7">{{ $t('swap.approval') }}</span>
            <span class="text-weight-medium text-right">
              {{
                $t('swap.approvalNeeded', {
                  count: approvalsNeeded,
                  asset: payToken.symbol,
                })
              }}
            </span>
          </div>
          <q-separator class="q-my-xs" />
          <div class="swap-row items-center">
            <span class="text-grey-7">{{ $t('swap.slippage') }}</span>
            <div class="row items-center q-gutter-x-xs no-wrap">
              <q-btn
                v-for="option in slippageOptions"
                :key="option"
                dense
                no-caps
                unelevated
                size="sm"
                :outline="slippageBps !== option"
                :color="slippageBps === option ? 'primary' : 'grey-7'"
                :label="`${option / 100}%`"
                :disable="locked"
                :data-testid="`swap-slippage-${option}`"
                @click="setSlippage(option)"
              />
              <q-input
                v-model="customSlippage"
                dense
                outlined
                inputmode="decimal"
                suffix="%"
                class="swap-slippage-input"
                :error="customSlippageInvalid"
                hide-bottom-space
                :disable="locked"
                :aria-label="$t('swap.slippageCustom')"
                data-testid="swap-slippage-custom"
              />
            </div>
          </div>
        </q-card>

        <!-- Why the swap cannot go ahead, in plain words -->
        <div
          v-if="problem"
          class="row items-start no-wrap q-px-xs text-caption text-weight-medium"
          :class="problem.blocking ? 'text-negative' : 'text-warning'"
          role="alert"
          data-testid="swap-problem"
        >
          <q-icon name="error_outline" size="16px" class="q-mr-xs" />
          <span>{{ $t(problem.key, problem.params) }}</span>
        </div>

        <!-- Confirm step -->
        <q-card
          v-if="phase === 'review' && quote"
          flat
          bordered
          class="q-pa-md swap-card swap-card--review"
          data-testid="swap-review"
        >
          <div class="text-subtitle2 text-weight-bold q-mb-xs">
            {{ $t('swap.reviewTitle') }}
          </div>
          <!-- The swap as a whole: everything that leaves the wallet, and what arrives. -->
          <div class="text-body2" data-testid="swap-review-pay">
            {{ $t(payLine.key, payLine.params) }}
          </div>
          <div class="text-body2" data-testid="swap-review-receive">
            {{
              $t('swap.reviewReceive', {
                receive: receiveText,
                asset: receiveToken.symbol,
                minimum: minimumText,
              })
            }}
          </div>
          <div
            v-if="moveText"
            class="text-body2 q-mt-xs"
            data-testid="swap-review-move"
          >
            {{
              $t('swap.reviewMove', { amount: moveText, unit: nativeSymbol })
            }}
          </div>
          <div class="text-caption text-grey-7 q-mt-xs">
            {{ $t('swap.reviewNote', { seconds: deadlineSeconds }) }}
          </div>
          <div
            v-if="quoteStale"
            class="text-caption text-warning text-weight-medium q-mt-xs"
            role="status"
            data-testid="swap-review-stale"
          >
            {{ $t('swap.reviewStale') }}
          </div>
          <div class="row q-gutter-sm q-mt-sm">
            <q-btn
              flat
              no-caps
              color="grey-8"
              class="col"
              :label="$t('swap.back')"
              data-testid="swap-back-btn"
              @click="backToForm"
            />
            <q-btn
              unelevated
              no-caps
              color="primary"
              class="col text-weight-bold"
              :label="$t('swap.confirm')"
              :loading="confirming"
              :disable="!canConfirm"
              data-testid="swap-confirm-btn"
              @click="confirm"
            />
          </div>
        </q-card>

        <!-- Progress -->
        <q-card
          v-else-if="phase === 'working'"
          flat
          bordered
          class="q-pa-md swap-card"
          role="status"
          data-testid="swap-progress"
        >
          <div class="row items-center q-gutter-x-sm">
            <q-spinner color="primary" size="20px" />
            <span class="text-body2 text-weight-medium">
              {{ $t(progressKey, progressParams) }}
            </span>
          </div>
          <q-linear-progress
            indeterminate
            color="primary"
            class="q-mt-sm"
            rounded
          />
          <div class="text-caption text-grey-7 q-mt-xs">
            {{ $t('swap.progressKeepOpen') }}
          </div>
        </q-card>

        <q-btn
          v-else
          unelevated
          no-caps
          :color="insufficient ? 'negative' : 'primary'"
          class="full-width swap-action-btn text-weight-bold"
          :icon="insufficient ? 'warning' : 'swap_horiz'"
          :label="$t(actionKey, actionParams)"
          :disable="!canReview"
          :loading="quoteState === 'loading' && reviewing"
          data-testid="swap-review-btn"
          @click="review"
        />
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import {
  quoteIsFresh,
  readTokenBalance,
  SwapNoLiquidityError,
  SwapNoRouteError,
  swapRevertReasonOf,
  SWAP_DEADLINE_SECONDS,
} from '@frank/wallet/swap/evm-swap'
import type { EvmDexQuote } from '@frank/wallet/swap/evm-dex'
import {
  networkFeeShare,
  SwapRefusedError,
  type SwapCost,
  type SwapFailure,
  type SwapProgress,
  type SwapResult,
} from '@frank/wallet/swap/swap-execution'
import { minimumOutput, MAX_SLIPPAGE_BPS } from '@frank/wallet/swap/uniswap-v4'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import {
  EvmSwapUnavailableError,
  openEvmSwapSession,
  type EvmSwapSession,
  type SignedContractCallRecord,
  type EvmSwapUnavailable,
} from 'src/swap/evm-swap-session'
import {
  exactTokenAmount,
  outputPerUnit,
  parseTokenAmount,
  readablePercent,
  readableTokenAmount,
} from 'src/swap/amounts'
import { useSwapHistory } from 'src/composables/useSwapHistory'
import type { SwapRecord } from 'src/stores/swaps'
import { getExplorerUrl } from 'src/utils/explorer'

interface Problem {
  key: string
  params?: Record<string, unknown>
  /** A blocking problem disables the swap; a warning only informs. */
  blocking: boolean
}

interface Outcome {
  status: 'confirmed' | 'reverted' | 'pending'
  txHash: string
  toSymbol: string
  received?: string
  receivedExact?: string
  /** What left the wallet for this swap, from the receipts. */
  paid?: { key: string; params: Record<string, unknown> }
  reason?: string
  explorerUrl?: string
}

const QUOTE_DEBOUNCE_MS = 350
const QUOTE_REFRESH_MS = 6_000
const BALANCE_REFRESH_MS = 15_000
/** Without any input for this long, the form stops asking the network until it is touched. */
const IDLE_AFTER_MS = 120_000
const SLIPPAGE_OPTIONS = [10, 50, 100]
/** Price impact, in parts per million, from which the figure is shown as a warning or as bad. */
const IMPACT_WARN_PPM = 10_000
const IMPACT_BAD_PPM = 50_000
/** The network fee as a share of the amount, in percent, from which the form says so. */
const FEE_SHARE_WARN_PERCENT = 10

const FAILURE_KEYS: Record<SwapFailure, string> = {
  'slippage': 'swap.errorPriceMoved',
  'deadline': 'swap.errorExpired',
  'allowance': 'swap.errorAllowance',
  'insufficient-funds': 'swap.errorInsufficientNative',
  'insufficient-native': 'swap.errorInsufficientNative',
  'account-busy': 'swap.errorAccountBusy',
  'approval-failed': 'swap.errorApprovalFailed',
}

export default defineComponent({
  name: 'EvmSwapPanel',
  props: {
    /** Canonical chain identifier of the wallet being shown. */
    chainIdentifier: { type: String, required: true },
    /** The wallet page's name for this wallet; swap history is listed under it. */
    walletId: { type: String, required: true },
    /** Which of the chain's venues this panel swaps on. */
    venueId: { type: String, required: true },
  },
  setup(props) {
    const history = useSwapHistory()
    const session = shallowRef<EvmSwapSession>()
    const unavailable = ref<EvmSwapUnavailable | 'error'>()
    const root = ref<HTMLElement>()
    /** Balances by token index. Only the two tokens on screen are kept current. */
    const balances = ref<Record<number, bigint>>({})
    const otherAccounts = ref(0n)
    /** What the reviewed swap needs moved into the main account first; shown and confirmed. */
    const moveWei = ref(0n)
    /** A refresh failed while reviewing: the figures shown are the last ones the chain gave. */
    const quoteStale = ref(false)

    const payIndex = ref(0)
    const receiveIndex = ref(1)
    const amountText = ref('')
    const slippageBps = ref(50)
    const customSlippage = ref('')

    const quote = shallowRef<EvmDexQuote>()
    /** The network fee of every transaction the quoted swap needs, as it will be charged. */
    const cost = shallowRef<SwapCost>()
    const fee = computed(() => cost.value?.swapFee)
    const approvalsNeeded = ref(0)
    const quoteState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
    const quoteProblem = ref<Problem>()
    const flowProblem = ref<Problem>()

    const phase = ref<'form' | 'review' | 'working' | 'done'>('form')
    const reviewing = ref(false)
    const confirming = ref(false)
    const reviewed = shallowRef<EvmDexQuote>()
    const progress = ref<SwapProgress>()
    const outcome = shallowRef<Outcome>()

    const tokens = computed(() => session.value?.dex.tokens ?? [])
    const payToken = computed(() => tokens.value[payIndex.value]!)
    const receiveToken = computed(() => tokens.value[receiveIndex.value]!)
    const nativeIndex = computed(() =>
      tokens.value.findIndex(token => token.address === null),
    )
    const nativeSymbol = computed(
      () => tokens.value[nativeIndex.value]?.symbol ?? '',
    )
    const tokenOptions = (testTokenLabel: string) =>
      tokens.value.map((token, value) => ({
        label: token.testToken
          ? `${token.symbol} · ${testTokenLabel}`
          : token.symbol,
        value,
      }))
    const locked = computed(
      () => phase.value === 'working' || phase.value === 'review',
    )

    const amount = computed(() =>
      tokens.value.length
        ? parseTokenAmount(amountText.value, payToken.value.decimals)
        : undefined,
    )
    const balanceOf = (index: number): bigint | undefined =>
      balances.value[index]
    const balanceText = (index: number) => {
      const value = balanceOf(index)
      const token = tokens.value[index]
      return value === undefined || !token
        ? '…'
        : `${readableTokenAmount(value, token.decimals)} ${token.symbol}`
    }
    const balanceExact = (index: number) => {
      const value = balanceOf(index)
      const token = tokens.value[index]
      return value === undefined || !token
        ? undefined
        : exactTokenAmount(value, token.decimals)
    }
    const payingNative = computed(() => payIndex.value === nativeIndex.value)
    /** What the pay side can draw on: the account's balance, plus, for the native coin, what
     * the wallet can first move in from its other accounts. */
    const spendable = computed(() => {
      const own = balanceOf(payIndex.value)
      if (own === undefined) return undefined
      return payingNative.value ? own + otherAccounts.value : own
    })
    const insufficient = computed(() => {
      if (amount.value === undefined || spendable.value === undefined)
        return false
      const feeWei =
        payingNative.value && fee.value ? fee.value.maximumFeeWei : 0n
      return amount.value + feeWei > spendable.value
    })

    const problem = computed<Problem | undefined>(() => {
      if (flowProblem.value) return flowProblem.value
      if (insufficient.value)
        return {
          key:
            payingNative.value &&
            amount.value !== undefined &&
            spendable.value !== undefined &&
            amount.value <= spendable.value
              ? 'swap.errorInsufficientForFee'
              : 'swap.errorInsufficientBalance',
          params: { asset: payToken.value.symbol },
          blocking: true,
        }
      if (quoteProblem.value) return quoteProblem.value
      if (quote.value && quote.value.priceImpactPpm >= IMPACT_BAD_PPM)
        return { key: 'swap.warnHighImpact', blocking: false }
      // The network fee beside the amount, when both are the native coin.
      const share =
        quote.value && cost.value
          ? networkFeeShare({
              networkFeeWei: cost.value.networkFeeWei,
              quote: quote.value,
            })
          : undefined
      if (share !== undefined && share > 100)
        return { key: 'swap.warnFeeLarger', blocking: false }
      if (share !== undefined && share > FEE_SHARE_WARN_PERCENT)
        return {
          key: 'swap.warnFeeShare',
          params: { percent: Math.round(share) },
          blocking: false,
        }
      return undefined
    })

    const nativeAmount = (wei: bigint) =>
      readableTokenAmount(wei, tokens.value[nativeIndex.value]?.decimals ?? 18)
    /** The "Network fee" row: what will be charged, for every transaction that can be priced. */
    const feeLine = computed(() => {
      const c = cost.value
      if (!c || (c.networkFeeWei === 0n && !c.complete))
        return { key: 'swap.networkFeeLater', params: {} }
      return {
        key: c.complete ? 'swap.networkFeeKnown' : 'swap.networkFeePartial',
        params: {
          fee: nativeAmount(c.networkFeeWei),
          unit: nativeSymbol.value,
        },
      }
    })
    /** One line for everything that leaves the wallet. Assets are never converted. */
    const payLine = computed(() => {
      const q = quote.value
      const c = cost.value
      if (!q) return { key: 'swap.reviewPayNoFee', params: {} }
      const params = {
        amount: exactTokenAmount(q.amountIn, q.tokenIn.decimals),
        asset: q.tokenIn.symbol,
        fee: c ? nativeAmount(c.networkFeeWei) : '',
        unit: nativeSymbol.value,
        total: c ? nativeAmount(q.amountIn + c.networkFeeWei) : '',
      }
      if (!c || (c.networkFeeWei === 0n && !c.complete))
        return { key: 'swap.reviewPayNoFee', params }
      if (!c.complete) return { key: 'swap.reviewPayPartial', params }
      return {
        key:
          q.tokenIn.address === null
            ? 'swap.reviewPaySame'
            : 'swap.reviewPayOther',
        params,
      }
    })
    /** After the swap: what was actually charged, from the receipts. */
    const paidLine = (
      q: EvmDexQuote,
      totalFeeWei: bigint,
      nativeDecimals: number,
      result: SwapResult,
    ) => {
      const amountIn =
        result.status === 'reverted'
          ? 0n
          : (result.status === 'confirmed' ? result.amountIn : undefined) ??
            q.amountIn
      const fee = readableTokenAmount(totalFeeWei, nativeDecimals)
      const params = {
        amount: exactTokenAmount(amountIn, q.tokenIn.decimals),
        asset: q.tokenIn.symbol,
        fee,
        unit: nativeSymbol.value,
        total: readableTokenAmount(amountIn + totalFeeWei, nativeDecimals),
      }
      return {
        key:
          result.status === 'reverted'
            ? 'swap.resultPaidFeeOnly'
            : q.tokenIn.address === null
            ? 'swap.resultPaidSame'
            : 'swap.resultPaidOther',
        params,
      }
    }

    const minimum = computed(() =>
      quote.value
        ? minimumOutput(quote.value.amountOut, slippageBps.value)
        : undefined,
    )
    const rateText = computed(() => {
      const q = quote.value
      if (!q) return ''
      return `1 ${q.tokenIn.symbol} ≈ ${readableTokenAmount(
        outputPerUnit(q.amountIn, q.amountOut, q.tokenIn.decimals),
        q.tokenOut.decimals,
      )} ${q.tokenOut.symbol}`
    })
    const impactClass = computed(() => {
      const ppm = quote.value?.priceImpactPpm ?? 0
      return ppm >= IMPACT_BAD_PPM
        ? 'text-negative'
        : ppm >= IMPACT_WARN_PPM
        ? 'text-warning'
        : 'text-positive'
    })

    let quoteSequence = 0
    let debounce: ReturnType<typeof setTimeout> | undefined
    let quoteTimer: ReturnType<typeof setInterval> | undefined
    let balanceTimer: ReturnType<typeof setInterval> | undefined
    let alive = true

    const problemOf = (error: unknown, fallback: string): Problem => {
      if (error instanceof SwapRefusedError)
        return { key: FAILURE_KEYS[error.reason], blocking: true }
      if (error instanceof SwapNoRouteError)
        return { key: 'swap.errorNoRoute', blocking: true }
      if (error instanceof SwapNoLiquidityError)
        return { key: 'swap.errorNoLiquidity', blocking: true }
      const reason = swapRevertReasonOf(error)
      if (reason) return { key: FAILURE_KEYS[reason], blocking: true }
      if (
        (error as { code?: unknown } | null)?.code === 'INSUFFICIENT_FUNDS' ||
        (error instanceof RangeError && /Insufficient/.test(error.message))
      )
        return { key: 'swap.errorInsufficientNative', blocking: true }
      return { key: fallback, blocking: true }
    }

    /** The main account's balance of the two tokens on screen: two node requests. */
    async function refreshBalances(): Promise<void> {
      const current = session.value
      if (!current) return
      const indices =
        payIndex.value === receiveIndex.value
          ? [payIndex.value]
          : [payIndex.value, receiveIndex.value]
      try {
        const values = await Promise.all(
          indices.map(index =>
            readTokenBalance(
              current.reader,
              current.dex.tokens[index]!,
              current.account,
            ),
          ),
        )
        if (!alive || session.value !== current) return
        const next = { ...balances.value }
        indices.forEach((index, i) => {
          next[index] = values[i]!
        })
        balances.value = next
      } catch {
        /* The last balances stay on screen; the next refresh tries again. */
      }
    }
    /**
     * What the wallet's other accounts hold. This read walks every account of the wallet, so it
     * is made when the form opens and after a swap, never on a timer.
     */
    async function refreshOtherAccounts(): Promise<void> {
      const current = session.value
      if (!current) return
      try {
        const other = await current.otherAccountsBalance()
        if (alive && session.value === current) otherAccounts.value = other
      } catch {
        /* Unknown stays at the last known figure. */
      }
    }

    // The timers only run while someone is looking: not in a hidden tab, not while the panel is
    // off screen, and not after two minutes without any input.
    let lastInputAt = Date.now()
    let onScreen = true
    let observer: IntersectionObserver | undefined
    const watching = () =>
      !document.hidden && onScreen && Date.now() - lastInputAt < IDLE_AFTER_MS
    function touched(): void {
      const wasWatching = watching()
      lastInputAt = Date.now()
      if (!wasWatching && watching()) resumeRefreshing()
    }
    function resumeRefreshing(): void {
      void refreshBalances()
      if (wantsQuoteRefresh()) void refreshQuote()
    }
    const wantsQuoteRefresh = () =>
      !confirming.value &&
      !reviewing.value &&
      ((phase.value === 'form' && quote.value !== undefined) ||
        phase.value === 'review')
    const onVisibility = () => {
      if (watching()) resumeRefreshing()
    }

    /** Reads a quote for exactly what is typed. Returns it only if it is still the latest. */
    async function refreshQuote(): Promise<EvmDexQuote | undefined> {
      const current = session.value
      const amountIn = amount.value
      const sequence = ++quoteSequence
      if (!current || amountIn === undefined) {
        quote.value = undefined
        cost.value = undefined
        approvalsNeeded.value = 0
        quoteProblem.value = undefined
        quoteState.value = 'idle'
        return undefined
      }
      if (payIndex.value === receiveIndex.value) {
        quote.value = undefined
        quoteProblem.value = { key: 'swap.errorSameAsset', blocking: true }
        quoteState.value = 'error'
        return undefined
      }
      quoteState.value = 'loading'
      try {
        const next = await current.dex.quote({
          tokenIn: payToken.value,
          tokenOut: receiveToken.value,
          amountIn,
        })
        const plan = await current.dex.plan({
          quote: next,
          slippageBps: slippageBps.value,
          account: current.account,
        })
        const nextCost = await current.dex.cost({
          plan,
          account: current.account,
          moveWei: phase.value === 'review' ? moveWei.value : 0n,
        })
        if (!alive || sequence !== quoteSequence) return undefined
        quote.value = next
        cost.value = nextCost
        approvalsNeeded.value = plan.approvals.length
        quoteProblem.value = undefined
        quoteState.value = 'ready'
        quoteStale.value = false
        return next
      } catch (error) {
        if (!alive || sequence !== quoteSequence) return undefined
        if (phase.value === 'review' && quote.value) {
          // Stay on the review card with the last figures, marked stale. Confirm waits for a
          // fresh quote; Back is always there; the next refresh tries again.
          quoteStale.value = true
          quoteState.value = 'error'
          return undefined
        }
        quote.value = undefined
        cost.value = undefined
        approvalsNeeded.value = 0
        quoteProblem.value = problemOf(error, 'swap.errorQuote')
        quoteState.value = 'error'
        return undefined
      }
    }

    function scheduleQuote(): void {
      // What is on screen was quoted for a different input: never show it beside the new one.
      quote.value = undefined
      cost.value = undefined
      quoteProblem.value = undefined
      flowProblem.value = undefined
      quoteSequence++
      if (debounce) clearTimeout(debounce)
      if (amount.value === undefined) {
        quoteState.value = 'idle'
        return
      }
      quoteState.value = 'loading'
      debounce = setTimeout(() => void refreshQuote(), QUOTE_DEBOUNCE_MS)
    }

    watch([amountText, payIndex, receiveIndex], scheduleQuote)
    watch([payIndex, receiveIndex], () => void refreshBalances())
    watch([amountText, payIndex, receiveIndex, slippageBps], touched)
    watch(payIndex, (now, before) => {
      if (now === receiveIndex.value) receiveIndex.value = before
    })
    watch(receiveIndex, (now, before) => {
      if (now === payIndex.value) payIndex.value = before
    })

    const customSlippageInvalid = computed(() => {
      const text = customSlippage.value.trim()
      if (!text) return false
      const bps = Math.round(Number(text) * 100)
      return !(Number.isFinite(bps) && bps >= 1 && bps <= MAX_SLIPPAGE_BPS)
    })
    watch(customSlippage, text => {
      if (!text.trim() || customSlippageInvalid.value) return
      slippageBps.value = Math.round(Number(text) * 100)
    })
    function setSlippage(bps: number): void {
      customSlippage.value = ''
      slippageBps.value = bps
    }

    const canMax = computed(() => (balanceOf(payIndex.value) ?? 0n) > 0n)
    function useMax(): void {
      const own = balanceOf(payIndex.value)
      if (own === undefined) return
      // The native coin also pays the network fee: leave the estimated fee, or, before any
      // estimate exists, nothing is assumed and the balance check speaks once it is known.
      const reserve =
        payingNative.value && fee.value ? fee.value.maximumFeeWei : 0n
      const usable = own > reserve ? own - reserve : 0n
      amountText.value = exactTokenAmount(usable, payToken.value.decimals)
    }
    function flip(): void {
      const pay = payIndex.value
      payIndex.value = receiveIndex.value
      receiveIndex.value = pay
      amountText.value = ''
    }

    const canReview = computed(
      () =>
        phase.value === 'form' &&
        amount.value !== undefined &&
        quote.value !== undefined &&
        !customSlippageInvalid.value &&
        !problem.value?.blocking,
    )
    const canConfirm = computed(
      () =>
        phase.value === 'review' &&
        quote.value !== undefined &&
        !quoteStale.value &&
        !insufficient.value &&
        !quoteProblem.value?.blocking,
    )

    async function review(): Promise<void> {
      if (!canReview.value) return
      reviewing.value = true
      flowProblem.value = undefined
      try {
        // Always the chain's current answer, never the one that was on screen.
        const fresh = await refreshQuote()
        if (!fresh || problem.value?.blocking) return
        // What, if anything, has to be moved into the main account first. The user sees the
        // amount on the review card and confirms it with the swap.
        const current = session.value
        if (!current) return
        const reviewPlan = await current.dex.plan({
          quote: fresh,
          slippageBps: slippageBps.value,
          account: current.account,
        })
        const need = await current.dex.consolidation({
          plan: reviewPlan,
          swapFee: fee.value,
        })
        if (!need.possible) {
          flowProblem.value = {
            key: 'swap.errorInsufficientNative',
            blocking: true,
          }
          return
        }
        moveWei.value = need.moveWei
        // With the move known, the total includes its transfer fee as well.
        cost.value = await current.dex.cost({
          plan: reviewPlan,
          account: current.account,
          moveWei: need.moveWei,
        })
        reviewed.value = fresh
        quoteStale.value = false
        phase.value = 'review'
      } catch (error) {
        flowProblem.value = problemOf(error, 'swap.errorQuote')
      } finally {
        reviewing.value = false
      }
    }

    const explorerUrlOf = (txHash: string) => {
      try {
        // The canonical identifier, not the wallet's alias: the alias names the mainnet explorer.
        return getExplorerUrl(txHash, props.chainIdentifier, {
          isTestnet:
            getChainRegistryEntry(props.chainIdentifier)?.isTestnet ?? true,
        })
      } catch {
        return undefined
      }
    }

    /**
     * Keeps the record the wallet's contract send was given, once the swap is signed and before
     * it is broadcast. The record is first kept on this device (if that fails this throws and
     * the swap is not sent), then a note carrying it is written to the account's own messages.
     * That note never holds up or repeats the swap: if it fails, only the note is owed.
     */
    const signedAt = new Map<string, number>()
    async function recordSigned(signed: SignedContractCallRecord): Promise<void> {
      const { record } = signed
      signedAt.set(signed.transactionId, signed.signedAtMs)
      const nativeDecimals = tokens.value[nativeIndex.value]?.decimals ?? 18
      const pending: SwapRecord = {
        id: swapRecordId(signed.transactionId),
        timestamp: signed.signedAtMs,
        chain: props.walletId,
        chainIdentifier: record.chainIdentifier,
        fromAsset: record.assetIn.symbol,
        toAsset: record.assetOut.symbol,
        fromAmount: exactTokenAmount(record.amountIn, record.assetIn.decimals),
        toAmount: `≥${readableTokenAmount(
          record.minimumAmountOut,
          record.assetOut.decimals,
        )}`,
        txHash: signed.transactionId,
        route: session.value?.dex.entry.displayName ?? record.venueId,
        feeDisplay: `${readableTokenAmount(
          record.networkFeeWei,
          nativeDecimals,
        )} ${nativeSymbol.value}`,
        destinationAddress: record.account,
        status: 'pending',
        recovery: {
          operationId: signed.operationId,
          venueId: record.venueId,
          account: record.account,
          route: record.route,
          call: signed.call,
          toDecimals: record.assetOut.decimals,
        },
      }
      history.saveLocal(pending)
      void Promise.resolve()
        .then(() => history.noteToSelf(pending))
        .catch(() => undefined)
    }
    /** The same id on every frontend of the account: it is the transaction's. */
    const swapRecordId = (transactionId: string) => `swap-${transactionId}`

    function recordOf(
      timestamp: number,
      q: EvmDexQuote,
      minimumOut: bigint,
      result: SwapResult,
      swapCall: { to: string; data: string; value: bigint },
    ): SwapRecord {
      const current = session.value!
      const base = {
        id: swapRecordId(result.txHash),
        timestamp,
        chain: props.walletId,
        chainIdentifier: props.chainIdentifier,
        fromAsset: q.tokenIn.symbol,
        toAsset: q.tokenOut.symbol,
        fromAmount: exactTokenAmount(q.amountIn, q.tokenIn.decimals),
        txHash: result.txHash,
        route: current.dex.entry.displayName,
        destinationAddress: current.account,
      }
      const nativeDecimals = tokens.value[nativeIndex.value]?.decimals ?? 18
      const feeDisplay =
        'totalFeeWei' in result
          ? `${readableTokenAmount(result.totalFeeWei, nativeDecimals)} ${
              nativeSymbol.value
            }`
          : ''
      if (result.status === 'confirmed')
        return {
          ...base,
          // From the receipt. When the receipt did not show it, nothing is claimed.
          toAmount:
            result.amountOut === undefined
              ? '?'
              : readableTokenAmount(result.amountOut, q.tokenOut.decimals),
          feeDisplay,
          status: 'confirmed',
        }
      if (result.status === 'reverted')
        return {
          ...base,
          toAmount: '0',
          feeDisplay,
          status: 'failed',
          failureReason: result.reason ?? 'reverted',
        }
      return {
        ...base,
        toAmount: `≥${readableTokenAmount(minimumOut, q.tokenOut.decimals)}`,
        feeDisplay,
        status: 'pending',
        recovery: {
          operationId: result.operationId,
          venueId: current.dex.entry.id,
          account: current.account,
          route: q.route,
          call: {
            to: swapCall.to,
            data: swapCall.data,
            value: swapCall.value.toString(),
          },
          toDecimals: q.tokenOut.decimals,
        },
      }
    }

    function outcomeOf(result: SwapResult, q: EvmDexQuote): Outcome {
      const nativeDecimals = tokens.value[nativeIndex.value]?.decimals ?? 18
      return {
        status: result.status,
        txHash: result.txHash,
        toSymbol: q.tokenOut.symbol,
        explorerUrl: explorerUrlOf(result.txHash),
        ...(result.status === 'confirmed' && result.amountOut !== undefined
          ? {
              received: readableTokenAmount(
                result.amountOut,
                q.tokenOut.decimals,
              ),
              receivedExact: exactTokenAmount(
                result.amountOut,
                q.tokenOut.decimals,
              ),
            }
          : {}),
        ...('totalFeeWei' in result
          ? { paid: paidLine(q, result.totalFeeWei, nativeDecimals, result) }
          : {}),
        ...(result.status === 'reverted' ? { reason: result.reason } : {}),
      }
    }

    async function confirm(): Promise<void> {
      const current = session.value
      const accepted = reviewed.value
      if (!current || !accepted || !canConfirm.value || confirming.value) return
      confirming.value = true
      flowProblem.value = undefined
      try {
        if (!current.isCurrent()) {
          flowProblem.value = {
            key: 'swap.errorAccountChanged',
            blocking: true,
          }
          phase.value = 'form'
          return
        }
        // A quote more than a few seconds old is read again before anything is signed.
        let q = quote.value
        if (!q || !quoteIsFresh(q, Date.now())) q = await refreshQuote()
        if (!q || problem.value?.blocking) return
        if (
          q.amountOut < minimumOutput(accepted.amountOut, slippageBps.value)
        ) {
          // Worse than what was accepted, beyond the slippage: show the new figures and ask again.
          reviewed.value = q
          flowProblem.value = { key: 'swap.errorPriceMoved', blocking: false }
          return
        }
        const plan = await current.dex.plan({
          quote: q,
          slippageBps: slippageBps.value,
          account: current.account,
        })
        phase.value = 'working'
        progress.value = undefined
        // The wallet keeps the swap's record (`recordSigned`) once it is signed and before it
        // is broadcast; if the record cannot be kept, nothing is broadcast.
        const result = await current.dex.execute({
          plan,
          account: current.account,
          consolidateWei: moveWei.value,
          onProgress: next => {
            progress.value = next
          },
        })
        history.saveLocal(
          recordOf(
            signedAt.get(result.txHash) ?? Date.now(),
            q,
            plan.minimumAmountOut,
            result,
            plan.swap,
          ),
        )
        outcome.value = outcomeOf(result, q)
        phase.value = 'done'
        amountText.value = ''
        void refreshBalances()
        void refreshOtherAccounts()
      } catch (error) {
        flowProblem.value = {
          ...problemOf(error, 'swap.errorExecution'),
          blocking: false,
        }
        phase.value = 'form'
        void refreshBalances()
        void refreshOtherAccounts()
      } finally {
        confirming.value = false
      }
    }

    function backToForm(): void {
      quoteStale.value = false
      flowProblem.value = undefined
      phase.value = 'form'
      void refreshQuote()
    }
    function startOver(): void {
      outcome.value = undefined
      flowProblem.value = undefined
      phase.value = 'form'
    }

    /** Swaps this device recorded as submitted and never saw finish: ask the chain now. */
    async function reconcilePending(current: EvmSwapSession): Promise<void> {
      const pending = history
        .getSwapsForChain(props.walletId, props.chainIdentifier)
        .value.filter(
          record =>
            record.status === 'pending' &&
            record.recovery &&
            record.recovery.venueId === current.dex.entry.id &&
            record.chainIdentifier === props.chainIdentifier &&
            record.recovery.account.toLowerCase() ===
              current.account.toLowerCase(),
        )
      for (const record of pending) {
        const recovery = record.recovery!
        try {
          const result = await current.dex.reconcile({
            transactionId: record.txHash,
            operationId: recovery.operationId,
            account: recovery.account,
            route: recovery.route,
            call: recovery.call,
          })
          if (!alive || result.status === 'pending') continue
          const nativeDecimals = tokens.value[nativeIndex.value]?.decimals ?? 18
          const rest: SwapRecord = { ...record }
          delete rest.recovery
          history.saveLocal({
            ...rest,
            status: result.status === 'confirmed' ? 'confirmed' : 'failed',
            toAmount:
              result.status !== 'confirmed'
                ? '0'
                : result.amountOut === undefined
                ? '?'
                : readableTokenAmount(result.amountOut, recovery.toDecimals),
            feeDisplay: `${readableTokenAmount(
              result.feeWei,
              nativeDecimals,
            )} ${nativeSymbol.value}`,
            ...(result.status === 'reverted'
              ? { failureReason: result.reason ?? 'reverted' }
              : {}),
          })
        } catch {
          /* Still unknown: the record stays pending and is looked at again next time. */
        }
      }
      // A contract call that was signed and never seen in a block (an approval whose broadcast
      // was lost) holds the account until it lands: hand the same bytes to the network again.
      for (const call of current.unresolvedContractCalls())
        await current.resumeOperation(call.operationId).catch(() => undefined)
      void refreshBalances()
    }

    onMounted(async () => {
      try {
        const opened = await openEvmSwapSession(
          props.chainIdentifier,
          props.venueId,
          recordSigned,
        )
        if (!alive) return
        session.value = opened
        const usdc = opened.dex.tokens.findIndex(
          token => token.address !== null,
        )
        payIndex.value = opened.dex.tokens.findIndex(
          token => token.address === null,
        )
        if (payIndex.value < 0) payIndex.value = 0
        receiveIndex.value = usdc >= 0 ? usdc : payIndex.value === 0 ? 1 : 0
        await refreshBalances()
        void refreshOtherAccounts()
        balanceTimer = setInterval(() => {
          if (watching()) void refreshBalances()
        }, BALANCE_REFRESH_MS)
        // While a quote is on screen, and someone is looking, it is kept current. During
        // review this also retries after a refresh that failed.
        quoteTimer = setInterval(() => {
          if (watching() && wantsQuoteRefresh()) void refreshQuote()
        }, QUOTE_REFRESH_MS)
        document.addEventListener('visibilitychange', onVisibility)
        if (typeof IntersectionObserver !== 'undefined' && root.value) {
          observer = new IntersectionObserver(entries => {
            const visible = entries.some(entry => entry.isIntersecting)
            const resumed = visible && !onScreen
            onScreen = visible
            if (resumed && watching()) resumeRefreshing()
          })
          observer.observe(root.value)
        }
        void reconcilePending(opened)
      } catch (error) {
        if (!alive) return
        unavailable.value =
          error instanceof EvmSwapUnavailableError ? error.reason : 'error'
      }
    })
    onBeforeUnmount(() => {
      alive = false
      if (debounce) clearTimeout(debounce)
      if (quoteTimer) clearInterval(quoteTimer)
      if (balanceTimer) clearInterval(balanceTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
    })

    const progressKey = computed(() => {
      const stage = progress.value?.stage
      return stage === 'recovering'
        ? 'swap.progressRecovering'
        : stage === 'consolidating'
        ? 'swap.progressConsolidating'
        : stage === 'approving'
        ? 'swap.progressApproving'
        : stage === 'submitted'
        ? 'swap.progressSubmitted'
        : 'swap.progressSigning'
    })
    const progressParams = computed(() =>
      progress.value?.stage === 'approving'
        ? { step: progress.value.step, of: progress.value.of }
        : {},
    )

    return {
      interfaceFeeText: computed(() =>
        quote.value?.interfaceFee
          ? readableTokenAmount(
              quote.value.interfaceFee.amount,
              quote.value.tokenOut.decimals,
            )
          : '',
      ),
      interfaceFeeRate: computed(() =>
        quote.value?.interfaceFee
          ? `${quote.value.interfaceFee.bps / 100}%`
          : '',
      ),
      root,
      touched,
      quoteStale,
      backToForm,
      moveText: computed(() =>
        moveWei.value > 0n
          ? readableTokenAmount(
              moveWei.value,
              tokens.value[nativeIndex.value]?.decimals ?? 18,
            )
          : '',
      ),
      unavailable,
      unavailableKey: computed(() =>
        unavailable.value === 'error'
          ? 'swap.unavailableError'
          : unavailable.value === 'no-wallet'
          ? 'swap.unavailableWallet'
          : 'swap.unavailableNetwork',
      ),
      phase,
      outcome,
      resultIcon: computed(() =>
        outcome.value?.status === 'confirmed'
          ? 'check_circle'
          : outcome.value?.status === 'reverted'
          ? 'cancel'
          : 'schedule',
      ),
      resultColor: computed(() =>
        outcome.value?.status === 'confirmed'
          ? 'positive'
          : outcome.value?.status === 'reverted'
          ? 'negative'
          : 'warning',
      ),
      resultTitleKey: computed(() =>
        outcome.value?.status === 'confirmed'
          ? 'swap.resultConfirmed'
          : outcome.value?.status === 'reverted'
          ? 'swap.resultReverted'
          : 'swap.resultPending',
      ),
      resultDetailKey: computed(() => {
        const o = outcome.value
        if (!o) return ''
        if (o.status === 'confirmed')
          return o.received
            ? 'swap.resultConfirmedDetail'
            : 'swap.resultConfirmedUnknown'
        if (o.status === 'pending') return 'swap.resultPendingDetail'
        return o.reason === 'slippage'
          ? 'swap.resultRevertedSlippage'
          : o.reason === 'deadline'
          ? 'swap.resultRevertedDeadline'
          : 'swap.resultRevertedOther'
      }),
      resultDetailParams: computed(() => ({
        asset: outcome.value?.toSymbol ?? '',
      })),
      nativeSymbol,
      insufficient,
      amountText,
      locked,
      canMax,
      useMax,
      payIndex,
      receiveIndex,
      tokenOptions,
      payToken,
      receiveToken,
      payBalanceText: computed(() => balanceText(payIndex.value)),
      payBalanceExact: computed(() => balanceExact(payIndex.value)),
      receiveBalanceText: computed(() => balanceText(receiveIndex.value)),
      receiveBalanceExact: computed(() => balanceExact(receiveIndex.value)),
      otherAccountsText: computed(() =>
        payingNative.value && otherAccounts.value > 0n
          ? `${readableTokenAmount(
              otherAccounts.value,
              payToken.value.decimals,
            )} ${payToken.value.symbol}`
          : '',
      ),
      flip,
      quote,
      quoteState,
      receiveText: computed(() =>
        quote.value
          ? readableTokenAmount(
              quote.value.amountOut,
              quote.value.tokenOut.decimals,
            )
          : '',
      ),
      receiveExact: computed(() =>
        quote.value
          ? exactTokenAmount(
              quote.value.amountOut,
              quote.value.tokenOut.decimals,
            )
          : '',
      ),
      payExact: computed(() =>
        quote.value
          ? exactTokenAmount(quote.value.amountIn, quote.value.tokenIn.decimals)
          : '',
      ),
      rateText,
      impactText: computed(() =>
        quote.value ? readablePercent(quote.value.priceImpactPpm) : '',
      ),
      impactClass,
      poolFeeText: computed(() =>
        quote.value ? readablePercent(quote.value.lpFeePpm) : '',
      ),
      minimumText: computed(() =>
        minimum.value !== undefined && quote.value
          ? readableTokenAmount(minimum.value, quote.value.tokenOut.decimals)
          : '',
      ),
      minimumExact: computed(() =>
        minimum.value !== undefined && quote.value
          ? exactTokenAmount(minimum.value, quote.value.tokenOut.decimals)
          : '',
      ),
      feeLine,
      payLine,
      approvalsNeeded,
      slippageBps,
      slippageOptions: SLIPPAGE_OPTIONS,
      customSlippage,
      customSlippageInvalid,
      setSlippage,
      problem,
      deadlineSeconds: SWAP_DEADLINE_SECONDS,
      canReview,
      canConfirm,
      reviewing,
      confirming,
      review,
      confirm,
      startOver,
      progressKey,
      progressParams,
      actionKey: computed(() =>
        amount.value === undefined
          ? 'swap.enterAmount'
          : insufficient.value
          ? 'swap.errorInsufficientBalance'
          : 'swap.review',
      ),
      actionParams: computed(() => ({ asset: payToken.value?.symbol ?? '' })),
    }
  },
})
</script>

<style scoped>
.evm-swap-panel {
  width: 100%;
  margin: 0 auto;
}
.swap-card {
  border-radius: 12px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.swap-card--error {
  border-color: var(--q-negative, #c10015) !important;
  box-shadow: 0 0 0 1px rgba(193, 0, 21, 0.2);
}
.swap-card--review {
  border-color: var(--q-primary, #1976d2);
}
.swap-card--confirmed {
  border-color: var(--q-positive, #21ba45);
}
.swap-card--reverted {
  border-color: var(--q-negative, #c10015);
}
.swap-card--pending {
  border-color: var(--q-warning, #f2c037);
}
.swap-amount-box {
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  padding: 2px 8px;
  min-height: 48px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}
.body--dark .swap-amount-box {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.15);
}
.swap-amount-box:focus-within {
  border-color: var(--q-primary, #1976d2);
  box-shadow: 0 0 0 1px var(--q-primary, #1976d2);
}
.swap-amount-box--readonly,
.swap-amount-box--readonly:focus-within {
  background: rgba(0, 0, 0, 0.015);
  border-color: rgba(0, 0, 0, 0.06);
  box-shadow: none;
}
.body--dark .swap-amount-box--readonly,
.body--dark .swap-amount-box--readonly:focus-within {
  background: rgba(255, 255, 255, 0.02);
  border-color: rgba(255, 255, 255, 0.08);
}
.swap-amount-box--error {
  border-color: var(--q-negative, #c10015) !important;
  background-color: rgba(193, 0, 21, 0.04) !important;
}
.swap-receive-amount {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.swap-max-pill {
  border-radius: 6px;
  font-size: 11px;
  line-height: 1;
  padding: 4px 6px;
  background-color: rgba(25, 118, 210, 0.1);
}
.body--dark .swap-max-pill {
  background-color: rgba(255, 255, 255, 0.1);
}
.swap-flip-container {
  display: flex;
  justify-content: center;
  align-items: center;
  margin: -14px auto;
  height: 28px;
  z-index: 3;
  position: relative;
}
.swap-flip-btn {
  background-color: #ffffff;
  border: 2px solid var(--q-primary);
  color: var(--q-primary);
  width: 36px;
  height: 36px;
  transition: transform 0.25s ease;
}
.body--dark .swap-flip-btn {
  background-color: #1d1d1d;
}
.swap-flip-btn:hover {
  transform: rotate(180deg);
}
.swap-details {
  background: rgba(0, 0, 0, 0.02);
}
.body--dark .swap-details {
  background: rgba(255, 255, 255, 0.03);
}
.swap-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 4px;
}
.swap-slippage-input {
  width: 76px;
}
.swap-action-btn {
  height: 50px;
  border-radius: 10px;
  font-size: 15px;
}
.asset-select {
  min-width: 120px;
}
</style>
