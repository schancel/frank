<template>
  <div class="q-py-sm" data-testid="solana-swap-panel">
    <q-card flat bordered>
      <q-card-section v-if="phase === 'loading'" class="text-center q-py-lg">
        <q-spinner color="primary" size="28px" />
        <div class="text-caption text-grey-7 q-mt-sm" role="status">
          {{ $t('solanaSwap.loading') }}
        </div>
      </q-card-section>

      <q-card-section
        v-else-if="phase === 'unsupported'"
        data-testid="solana-swap-unsupported"
      >
        <div class="text-subtitle1 text-weight-medium" role="status">
          {{ $t('solanaSwap.unsupportedTitle') }}
        </div>
        <p class="text-body2 text-grey-7 q-mt-sm q-mb-none">
          {{ $t('solanaSwap.unsupportedBody') }}
        </p>
      </q-card-section>

      <q-card-section
        v-else-if="phase === 'load-error'"
        data-testid="solana-swap-load-error"
      >
        <q-banner rounded class="bg-red-1 text-negative" role="alert">
          {{ $t(loadErrorKey) }}
          <div v-if="loadErrorDetail" class="text-caption q-mt-xs">
            {{ loadErrorDetail }}
          </div>
          <template #action>
            <q-btn
              flat
              no-caps
              color="negative"
              :label="$t('solanaSwap.retry')"
              data-testid="solana-swap-reload"
              @click="load"
            />
          </template>
        </q-banner>
      </q-card-section>

      <template v-else>
        <!-- Which exchange, on which network: always visible, never implied. -->
        <q-card-section class="q-pb-none">
          <div
            class="row items-center no-wrap q-gutter-x-sm"
            data-testid="solana-swap-venue"
          >
            <q-icon
              :name="isTestnet ? 'science' : 'public'"
              :color="isTestnet ? 'orange-8' : 'primary'"
              size="18px"
            />
            <div class="text-caption text-grey-8">
              {{
                $t(
                  isTestnet
                    ? 'solanaSwap.venueTestnet'
                    : 'solanaSwap.venueMainnet',
                  { venue: venueName, network: networkName },
                )
              }}
            </div>
          </div>
        </q-card-section>

        <!-- A swap that was signed: progress and result replace the form. -->
        <q-card-section v-if="swap" data-testid="solana-swap-progress">
          <div class="row items-center no-wrap q-gutter-x-sm q-mb-sm">
            <q-spinner
              v-if="swapInProgress"
              color="primary"
              size="22px"
              data-testid="solana-swap-spinner"
            />
            <q-icon
              v-else
              :name="swap.stage === 'confirmed' ? 'check_circle' : 'error'"
              :color="swap.stage === 'confirmed' ? 'positive' : 'negative'"
              size="24px"
            />
            <div
              class="text-subtitle1 text-weight-medium"
              role="status"
              aria-live="polite"
              data-testid="solana-swap-stage"
            >
              {{ $t(`solanaSwap.stage.${swap.stage}`) }}
            </div>
          </div>

          <q-list dense class="text-body2" data-testid="solana-swap-result">
            <q-item v-for="row in swap.rows" :key="row.key" class="q-px-none">
              <q-item-section class="text-grey-8">
                {{ row.label }}
              </q-item-section>
              <q-item-section
                side
                class="text-dark text-right"
                :class="row.emphasis"
                :data-testid="`solana-swap-result-${row.key}`"
              >
                {{ row.value }}
              </q-item-section>
            </q-item>
          </q-list>

          <p
            class="text-caption text-grey-7 q-mt-sm q-mb-none"
            data-testid="solana-swap-stage-note"
          >
            {{ $t(`solanaSwap.stageNote.${swap.stage}`) }}
          </p>

          <div class="row items-center justify-between q-mt-md">
            <a
              v-if="swap.signature && explorerLink"
              :href="explorerLink"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary text-caption"
              data-testid="solana-swap-explorer"
            >
              {{ $t('walletPanel.viewInExplorer') }}
            </a>
            <span v-else />
            <q-btn
              v-if="swap.stage === 'unknown'"
              unelevated
              no-caps
              color="primary"
              :label="$t('solanaSwap.checkAgain')"
              data-testid="solana-swap-check-again"
              @click="resumePending"
            />
            <q-btn
              v-else-if="!swapInProgress"
              unelevated
              no-caps
              color="primary"
              :label="$t('solanaSwap.newSwap')"
              data-testid="solana-swap-new"
              @click="reset"
            />
          </div>
        </q-card-section>

        <!-- Review: the whole swap in plain figures, then Confirm. -->
        <q-card-section
          v-else-if="reviewing && quote"
          data-testid="solana-swap-review"
        >
          <div class="text-subtitle1 text-weight-medium q-mb-xs">
            {{ $t('solanaSwap.reviewTitle') }}
          </div>
          <p
            class="text-body2 text-grey-8 q-mb-sm"
            data-testid="solana-swap-review-where"
          >
            {{
              $t(
                isTestnet
                  ? 'solanaSwap.reviewWhereTestnet'
                  : 'solanaSwap.reviewWhereMainnet',
                { venue: venueName, network: networkName },
              )
            }}
          </p>
          <q-list dense bordered class="rounded-borders text-body2">
            <q-item v-for="row in reviewRows" :key="row.key">
              <q-item-section class="text-grey-8">
                {{ row.label }}
                <div v-if="row.hint" class="text-caption text-grey-6">
                  {{ row.hint }}
                </div>
              </q-item-section>
              <q-item-section
                side
                class="text-dark text-right"
                :class="row.emphasis"
                :data-testid="`solana-swap-review-${row.key}`"
              >
                {{ row.value }}
              </q-item-section>
            </q-item>
          </q-list>
          <p
            class="text-body2 q-mt-sm q-mb-none"
            data-testid="solana-swap-review-net"
          >
            {{ netLine }}
          </p>
          <q-banner
            v-if="costWarning"
            rounded
            dense
            class="bg-orange-1 text-orange-10 q-mt-sm"
            role="alert"
            data-testid="solana-swap-cost-warning"
          >
            {{ costWarning }}
          </q-banner>
          <q-banner
            v-if="problem"
            rounded
            dense
            class="bg-red-1 text-negative q-mt-sm"
            role="alert"
            data-testid="solana-swap-error"
          >
            {{ problem.message }}
          </q-banner>
          <div class="row q-col-gutter-sm q-mt-md">
            <div class="col-4">
              <q-btn
                outline
                no-caps
                color="primary"
                class="full-width"
                :label="$t('solanaSwap.back')"
                data-testid="solana-swap-back"
                @click="reviewing = false"
              />
            </div>
            <div class="col-8">
              <q-btn
                unelevated
                no-caps
                color="primary"
                class="full-width"
                :loading="quoting"
                :disable="quoting || Boolean(quote.blocker)"
                :label="
                  quoteFresh
                    ? $t('solanaSwap.confirmSwap')
                    : $t('solanaSwap.refreshQuote')
                "
                data-testid="solana-swap-confirm"
                @click="confirm"
              />
            </div>
          </div>
        </q-card-section>

        <q-card-section v-else>
          <!-- Pay -->
          <div class="row items-center justify-between q-mb-xs">
            <span class="text-caption text-grey-7">
              {{ $t('swap.pay') }}
            </span>
            <span
              class="text-caption text-grey-7"
              data-testid="solana-swap-pay-balance"
            >
              {{ $t('swap.available') }}:
              {{ payToken ? display(payToken.amount, payToken) : '' }}
              <q-btn
                flat
                dense
                no-caps
                size="sm"
                color="primary"
                class="q-ml-xs"
                :label="$t('swap.max')"
                data-testid="solana-swap-max"
                @click="useMax"
              />
            </span>
          </div>
          <div class="row no-wrap q-col-gutter-sm">
            <div class="col">
              <q-input
                v-model="amountText"
                outlined
                dense
                inputmode="decimal"
                placeholder="0.0"
                :aria-label="$t('swap.pay')"
                :error="Boolean(inputProblem)"
                :error-message="inputProblem"
                data-testid="solana-swap-amount"
              />
            </div>
            <div class="col-5">
              <q-select
                v-model="payMint"
                outlined
                dense
                emit-value
                map-options
                :options="payOptions"
                :aria-label="$t('solanaSwap.payToken')"
                data-testid="solana-swap-pay-token"
              />
            </div>
          </div>

          <div class="row justify-center q-my-xs">
            <q-btn
              flat
              round
              dense
              icon="swap_vert"
              color="primary"
              :aria-label="$t('solanaSwap.flip')"
              data-testid="solana-swap-flip"
              @click="flip"
            />
          </div>

          <!-- Receive -->
          <div class="text-caption text-grey-7 q-mb-xs">
            {{ $t('swap.receive') }}
          </div>
          <div class="row no-wrap q-col-gutter-sm">
            <div class="col">
              <q-input
                :model-value="quote ? display(quote.expectedOutputAmount) : ''"
                outlined
                dense
                readonly
                placeholder="0.0"
                :loading="quoting"
                :aria-label="$t('swap.receive')"
                data-testid="solana-swap-receive-amount"
              />
            </div>
            <div class="col-5">
              <q-select
                v-model="receiveMint"
                outlined
                dense
                emit-value
                map-options
                :options="receiveOptions"
                :aria-label="$t('solanaSwap.receiveToken')"
                data-testid="solana-swap-receive-token"
              />
            </div>
          </div>

          <!-- Slippage -->
          <div class="row items-center justify-between q-mt-md">
            <span class="text-caption text-grey-7">
              {{ $t('solanaSwap.slippage') }}
            </span>
            <q-btn-toggle
              v-model="slippageBps"
              no-caps
              unelevated
              dense
              size="sm"
              toggle-color="primary"
              color="grey-3"
              text-color="grey-9"
              padding="2px 10px"
              :options="slippageOptions"
              data-testid="solana-swap-slippage"
            />
          </div>

          <!-- Quote details: everything here comes from the exchange or the chain. -->
          <q-list
            v-if="quote"
            dense
            bordered
            class="rounded-borders q-mt-md text-caption"
            data-testid="solana-swap-quote"
          >
            <q-item v-for="row in quoteRows" :key="row.key">
              <q-item-section class="text-grey-7">
                {{ row.label }}
              </q-item-section>
              <q-item-section
                side
                class="text-dark text-right"
                :class="row.emphasis"
                :data-testid="`solana-swap-quote-${row.key}`"
              >
                {{ row.value }}
              </q-item-section>
            </q-item>
          </q-list>

          <q-banner
            v-if="problem"
            rounded
            dense
            class="bg-red-1 text-negative q-mt-md"
            role="alert"
            data-testid="solana-swap-error"
          >
            {{ problem.message }}
            <div v-if="problem.detail" class="text-caption text-grey-8 q-mt-xs">
              {{ problem.detail }}
            </div>
          </q-banner>

          <q-btn
            unelevated
            no-caps
            color="primary"
            class="full-width q-mt-md"
            :disable="!canReview"
            :loading="quoting && Boolean(quote)"
            :label="reviewLabel"
            data-testid="solana-swap-review-btn"
            @click="review"
          />
          <p
            v-if="quote && !quote.platformFee"
            class="text-caption text-grey-6 text-center q-mt-sm q-mb-none"
          >
            {{ $t('solanaSwap.noPlatformFee') }}
          </p>
        </q-card-section>
      </template>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatBaseUnit, parseBaseUnit } from '@frank/wallet/chain/base-unit'
import {
  openSolanaSwapSession,
  PendingSwapsUnreadableError,
  SolanaSwapError,
  type SolanaSwapOutcome,
  type SolanaSwapQuote,
  type SolanaSwapRecord,
  type SolanaSwapSession,
  type SolanaSwapTokenBalance,
  type SwapAsset,
} from 'src/composables/useSolanaSwap'
import { useTranslate } from 'src/composables/useTranslate'
import { getExplorerUrl } from 'src/utils/explorer'

/**
 * The swap view passes the network, the wallet and the exchange it selected. Mounted without
 * them, the panel uses the app's current Solana network and that network's first exchange.
 * `walletId` is accepted for the view's sake; the Solana account is the session's.
 */
const props = defineProps<{
  chainIdentifier?: string
  walletId?: string
  venueId?: string
}>()

/** A quote older than this is refreshed before it can be confirmed. */
const QUOTE_MAX_AGE_MS = 10_000
const QUOTE_DEBOUNCE_MS = 500
/** With no input for this long the panel stops re-quoting by itself (each quote costs the
 * relay a simulation); it quotes again on input and before confirming. */
const IDLE_REQUOTE_LIMIT_MS = 120_000
/** Left in the wallet by MAX when paying SOL, for the network fee and account deposits. */
const SOL_RESERVE_LAMPORTS = 5_000_000n
/** Fees and deposits above this share of the amount swapped get a warning line. */
const COST_WARNING_PERCENT = 10n

type Stage =
  | 'signing'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'unknown'

interface Row {
  key: string
  label: string
  value: string
  hint?: string
  emphasis?: string
}

interface SwapView {
  stage: Stage
  signature?: string
  assetIn: SwapAsset
  assetOut: SwapAsset
  amountIn: bigint
  quotedAmountOut: bigint
  rows: Row[]
}

const t = useTranslate()

const phase = ref<'loading' | 'unsupported' | 'load-error' | 'ready'>('loading')
const loadErrorKey = ref('solanaSwap.loadError')
const loadErrorDetail = ref('')
const session = ref<SolanaSwapSession>()
const tokens = ref<SolanaSwapTokenBalance[]>([])
const payMint = ref('')
const receiveMint = ref('')
const amountText = ref('')
const slippageBps = ref(50)
const quote = ref<SolanaSwapQuote | null>(null)
const quoting = ref(false)
const quoteError = ref<{ code: string; detail?: string } | null>(null)
const reviewing = ref(false)
const swap = ref<SwapView | null>(null)
const now = ref(Date.now())

let quoteGeneration = 0
let lastInputAt = Date.now()
let debounce: ReturnType<typeof setTimeout> | undefined
let ticker: ReturnType<typeof setInterval> | undefined
let unmounted = false

const isTestnet = computed(() => session.value?.isTestnet ?? true)
const venueName = computed(() => session.value?.venueName ?? '')
const networkName = computed(() => session.value?.networkName ?? '')
const token = (mint: string) => tokens.value.find(entry => entry.mint === mint)
const payToken = computed(() => token(payMint.value))
const receiveToken = computed(() => token(receiveMint.value))
const nativeToken = computed(() => tokens.value.find(entry => entry.native))

const tokenOptions = (exclude: string) =>
  tokens.value
    .filter(entry => entry.mint !== exclude)
    .map(entry => ({ label: entry.symbol, value: entry.mint }))
const payOptions = computed(() => tokenOptions(receiveMint.value))
const receiveOptions = computed(() => tokenOptions(payMint.value))
const slippageOptions = [10, 50, 100].map(bps => ({
  label: `${bps / 100}%`,
  value: bps,
}))

type Unit = { symbol: string; decimals: number }

/** An amount with its symbol. Without a unit it is the quote's output token. */
function display(amount: bigint, of?: Unit): string {
  const unit = of ?? receiveToken.value
  return unit ? `${formatBaseUnit(amount, unit.decimals)} ${unit.symbol}` : ''
}

function displayLamports(lamports: bigint): string {
  const sol = nativeToken.value
  return sol ? display(lamports, sol) : `${lamports} lamports`
}

const assetOf = (entry: SolanaSwapTokenBalance): SwapAsset => ({
  symbol: entry.symbol,
  address: entry.native ? null : entry.mint,
  decimals: entry.decimals,
})

const amount = computed<bigint | null>(() => {
  const text = amountText.value.trim()
  if (!text || !payToken.value) return null
  try {
    const parsed = parseBaseUnit(text, payToken.value.decimals)
    return parsed > 0n ? parsed : null
  } catch {
    return null
  }
})

const inputProblem = computed(() => {
  if (!amountText.value.trim() || !payToken.value) return ''
  if (amount.value === null) {
    return t('solanaSwap.invalidAmount', {
      decimals: payToken.value.decimals,
    })
  }
  if (amount.value > payToken.value.amount) {
    return t('swap.errorInsufficientBalance', {
      asset: payToken.value.symbol,
    })
  }
  return ''
})

const quoteMatchesInput = computed(
  () =>
    quote.value !== null &&
    quote.value.inputAmount === amount.value &&
    quote.value.inputMint === payMint.value &&
    quote.value.outputMint === receiveMint.value &&
    quote.value.slippageBps === slippageBps.value,
)
const quoteFresh = computed(
  () =>
    quote.value !== null &&
    now.value - quote.value.fetchedAt <= QUOTE_MAX_AGE_MS,
)

const problem = computed(() => {
  const error = quote.value?.blocker ?? quoteError.value
  if (!error) return null
  // 'insufficient-sol' -> solanaSwap.error.insufficientSol
  const key = `solanaSwap.error.${error.code.replace(
    /-(\w)/g,
    (_, letter: string) => letter.toUpperCase(),
  )}`
  const message = t(key)
  return {
    message: message === key ? t('solanaSwap.error.unexpected') : message,
    // Chain and exchange wording is shown as given, for anything not self-explanatory.
    detail:
      error.code === 'simulation-failed' ||
      error.code === 'venue-unavailable' ||
      error.code === 'unsafe-transaction' ||
      error.code === 'unexpected'
        ? error.detail
        : undefined,
  }
})

const canReview = computed(
  () =>
    quote.value !== null &&
    !quote.value.blocker &&
    !quoting.value &&
    !inputProblem.value &&
    quoteMatchesInput.value,
)

const reviewLabel = computed(() => {
  if (!amountText.value.trim()) return t('solanaSwap.enterAmount')
  return t('solanaSwap.reviewSwap')
})

const routeText = (current: SolanaSwapQuote) =>
  `${current.venueName} · ${current.route.map(hop => hop.label).join(' → ')}`

const quoteRows = computed<Row[]>(() => {
  const current = quote.value
  const pay = token(current?.inputMint ?? '')
  const receive = token(current?.outputMint ?? '')
  if (!current || !pay || !receive) return []
  const rate =
    Number(formatBaseUnit(current.expectedOutputAmount, receive.decimals)) /
    Number(formatBaseUnit(current.inputAmount, pay.decimals))
  const impact = current.priceImpactBps
  const feeToken = token(current.tradeFee?.mint ?? '')
  const rows: Row[] = [
    {
      key: 'rate',
      label: t('solanaSwap.rate'),
      value: `1 ${pay.symbol} ≈ ${Number(rate.toPrecision(6))} ${
        receive.symbol
      }`,
    },
    {
      key: 'impact',
      label: t('solanaSwap.priceImpact'),
      value:
        impact === null
          ? '—'
          : impact < 1
          ? '< 0.01%'
          : `${(impact / 100).toFixed(2)}%`,
      emphasis: impact !== null && impact >= 100 ? 'text-negative' : undefined,
    },
    {
      key: 'minimum',
      label: t('solanaSwap.minimumReceived'),
      value: display(current.minOutputAmount, receive),
      emphasis: 'text-weight-medium',
    },
  ]
  if (current.tradeFee && feeToken) {
    rows.push({
      key: 'trade-fee',
      label: t('solanaSwap.tradeFee'),
      value: display(current.tradeFee.amount, feeToken),
    })
  }
  rows.push({
    key: 'network-fee',
    label: t('solanaSwap.networkFee'),
    value: displayLamports(current.networkFeeLamports),
  })
  rows.push({
    key: 'route',
    label: t('solanaSwap.route'),
    value: routeText(current),
  })
  return rows
})

/**
 * Everything that leaves the wallet, each in its own asset: the amount paid, plus the SOL the
 * transaction is charged (network fee) and deposits into token accounts it opens.
 */
function leaving(
  pay: Unit & { native?: boolean },
  paid: bigint,
  solCharged: bigint,
): string {
  if (pay.native) return displayLamports(paid + solCharged)
  return solCharged > 0n
    ? `${display(paid, pay)} + ${displayLamports(solCharged)}`
    : display(paid, pay)
}

const reviewRows = computed<Row[]>(() => {
  const current = quote.value
  const pay = token(current?.inputMint ?? '')
  const receive = token(current?.outputMint ?? '')
  if (!current || !pay || !receive) return []
  const rows: Row[] = [
    {
      key: 'pay',
      label: t('solanaSwap.paid'),
      value: display(current.inputAmount, pay),
      emphasis: 'text-weight-medium',
    },
  ]
  const feeToken = token(current.platformFee?.mint ?? '')
  if (current.platformFee && feeToken) {
    rows.push({
      key: 'platform-fee',
      label: t('solanaSwap.platformFee', {
        percent: current.platformFee.bps / 100,
      }),
      hint: t(
        current.platformFee.mint === current.inputMint
          ? 'solanaSwap.platformFeeFromInput'
          : 'solanaSwap.platformFeeFromOutput',
      ),
      value: display(current.platformFee.amount, feeToken),
    })
  }
  rows.push({
    key: 'network-fee',
    label: t('solanaSwap.networkFee'),
    value: displayLamports(current.networkFeeLamports),
  })
  if (current.accountRentLamports > 0n) {
    rows.push({
      key: 'rent',
      label: t('solanaSwap.accountRent', { token: receive.symbol }),
      hint: t('solanaSwap.accountRentHint'),
      value: displayLamports(current.accountRentLamports),
    })
  }
  rows.push({
    key: 'total',
    label: t('solanaSwap.totalLeaving'),
    value: leaving(
      pay,
      current.inputAmount,
      current.networkFeeLamports + current.accountRentLamports,
    ),
    emphasis: 'text-weight-bold',
  })
  if (current.temporaryRentLamports > 0n) {
    rows.push({
      key: 'temporary',
      label: t('solanaSwap.temporaryRent'),
      hint: t('solanaSwap.temporaryRentHint'),
      value: displayLamports(current.temporaryRentLamports),
    })
  }
  rows.push(
    {
      key: 'receive',
      label: t('solanaSwap.expected'),
      value: display(current.expectedOutputAmount, receive),
      emphasis: 'text-weight-bold',
    },
    {
      key: 'minimum',
      label: t('solanaSwap.minimumReceived'),
      value: display(current.minOutputAmount, receive),
    },
    {
      key: 'route',
      label: t('solanaSwap.route'),
      value: routeText(current),
    },
  )
  return rows
})

const netLine = computed(() => {
  const current = quote.value
  const pay = token(current?.inputMint ?? '')
  const receive = token(current?.outputMint ?? '')
  if (!current || !pay || !receive) return ''
  return t('solanaSwap.netLine', {
    give: leaving(
      pay,
      current.inputAmount,
      current.networkFeeLamports + current.accountRentLamports,
    ),
    get: display(current.expectedOutputAmount, receive),
    minimum: display(current.minOutputAmount, receive),
  })
})

/** Fees and deposits against the amount swapped, only where both are in SOL: no conversion
 * between assets is invented. */
const costWarning = computed(() => {
  const current = quote.value
  const pay = token(current?.inputMint ?? '')
  const receive = token(current?.outputMint ?? '')
  if (!current || !pay || !receive) return ''
  const solSide = pay.native
    ? current.inputAmount
    : receive.native
    ? current.expectedOutputAmount
    : null
  if (solSide === null) return ''
  const costs =
    current.networkFeeLamports +
    current.accountRentLamports +
    (current.platformFee && token(current.platformFee.mint)?.native
      ? current.platformFee.amount
      : 0n)
  if (costs * 100n <= solSide * COST_WARNING_PERCENT) return ''
  return t('solanaSwap.costWarning', {
    costs: displayLamports(costs),
    amount: displayLamports(solSide),
    percent: Number((costs * 1000n) / solSide) / 10,
  })
})

const swapInProgress = computed(
  () => swap.value?.stage === 'signing' || swap.value?.stage === 'submitted',
)
const explorerLink = computed(() =>
  swap.value?.signature && session.value
    ? getExplorerUrl(swap.value.signature, session.value.chainIdentifier, {
        isTestnet: session.value.isTestnet,
      })
    : undefined,
)

async function loadTokens() {
  if (!session.value) return
  const loaded = await session.value.loadTokens()
  if (unmounted) return
  tokens.value = loaded
  if (!token(payMint.value)) payMint.value = loaded[0]?.mint ?? ''
  if (!token(receiveMint.value) || receiveMint.value === payMint.value) {
    receiveMint.value =
      loaded.find(entry => entry.mint !== payMint.value)?.mint ?? ''
  }
}

async function load() {
  phase.value = 'loading'
  loadErrorKey.value = 'solanaSwap.loadError'
  loadErrorDetail.value = ''
  try {
    session.value = await openSolanaSwapSession(
      props.chainIdentifier,
      props.venueId,
    )
    if (!session.value) {
      phase.value = 'unsupported'
      return
    }
    await loadTokens()
    if (unmounted) return
    // A swap sent earlier may still land: pick it up instead of offering a new one. If its
    // record cannot be read, say so; do not show a form as though nothing were pending.
    const pending = session.value.pending()
    phase.value = 'ready'
    if (pending) void followPending(pending)
  } catch (error) {
    if (unmounted) return
    if (error instanceof PendingSwapsUnreadableError) {
      loadErrorKey.value = 'solanaSwap.pendingUnreadable'
    } else {
      loadErrorDetail.value = error instanceof Error ? error.message : ''
    }
    phase.value = 'load-error'
  }
}

async function fetchQuote() {
  const generation = ++quoteGeneration
  const current = session.value
  if (!current || amount.value === null || inputProblem.value) {
    quote.value = null
    quoteError.value = null
    quoting.value = false
    return
  }
  quoting.value = true
  try {
    const fresh = await current.quote({
      inputMint: payMint.value,
      outputMint: receiveMint.value,
      amount: amount.value,
      slippageBps: slippageBps.value,
    })
    if (generation !== quoteGeneration || unmounted) return
    quote.value = fresh
    quoteError.value = null
    now.value = Date.now()
  } catch (error) {
    if (generation !== quoteGeneration || unmounted) return
    quote.value = null
    reviewing.value = false
    quoteError.value =
      error instanceof SolanaSwapError
        ? { code: error.code, detail: error.detail }
        : {
            code: 'unexpected',
            detail: error instanceof Error ? error.message : String(error),
          }
  } finally {
    if (generation === quoteGeneration) quoting.value = false
  }
}

watch([payMint, receiveMint, amountText, slippageBps], () => {
  // What is on screen no longer matches the inputs: drop it until the new quote arrives.
  lastInputAt = Date.now()
  quote.value = null
  quoteError.value = null
  reviewing.value = false
  quoteGeneration++
  quoting.value = amount.value !== null && !inputProblem.value
  clearTimeout(debounce)
  debounce = setTimeout(fetchQuote, QUOTE_DEBOUNCE_MS)
})

watch(
  () => [props.chainIdentifier, props.venueId],
  () => {
    // Another network or exchange is another session; nothing quoted carries over.
    quote.value = null
    quoteError.value = null
    reviewing.value = false
    amountText.value = ''
    if (!swapInProgress.value) swap.value = null
    void load()
  },
)

function useMax() {
  const pay = payToken.value
  if (!pay) return
  const spendable =
    pay.native && pay.amount > SOL_RESERVE_LAMPORTS
      ? pay.amount - SOL_RESERVE_LAMPORTS
      : pay.native
      ? 0n
      : pay.amount
  amountText.value = formatBaseUnit(spendable, pay.decimals)
}

function flip() {
  const previousPay = payMint.value
  payMint.value = receiveMint.value
  receiveMint.value = previousPay
  amountText.value = ''
}

/** Opens the review card, on a quote that is current. */
async function review() {
  if (!canReview.value) return
  lastInputAt = Date.now()
  if (!quoteFresh.value) await fetchQuote()
  if (quote.value && !quote.value.blocker) reviewing.value = true
}

function inProgressRows(view: {
  assetIn: SwapAsset
  assetOut: SwapAsset
  amountIn: bigint
  quotedAmountOut: bigint
}): Row[] {
  return [
    {
      key: 'paid',
      label: t('solanaSwap.paid'),
      value: display(view.amountIn, view.assetIn),
      emphasis: 'text-weight-medium',
    },
    {
      key: 'expected',
      label: t('solanaSwap.expected'),
      value: display(view.quotedAmountOut, view.assetOut),
    },
  ]
}

/** What the confirmed transaction actually charged and delivered. */
function outcomeRows(
  view: SwapView,
  outcome: Extract<SolanaSwapOutcome, { status: 'confirmed' }>,
): Row[] {
  const solCharged = outcome.networkFeeLamports + outcome.accountRentLamports
  const rows: Row[] = [
    {
      key: 'paid',
      label: t('solanaSwap.actuallyPaid'),
      value: display(outcome.spentAmount, view.assetIn),
    },
    {
      key: 'network-fee',
      label: t('solanaSwap.networkFeeCharged'),
      value: displayLamports(outcome.networkFeeLamports),
    },
  ]
  if (outcome.accountRentLamports > 0n) {
    rows.push({
      key: 'rent',
      label: t('solanaSwap.accountRent', { token: view.assetOut.symbol }),
      value: displayLamports(outcome.accountRentLamports),
    })
  }
  rows.push(
    {
      key: 'total',
      label: t('solanaSwap.totalLeft'),
      value: leaving(
        { ...view.assetIn, native: view.assetIn.address === null },
        outcome.spentAmount,
        solCharged,
      ),
      emphasis: 'text-weight-medium',
    },
    {
      key: 'received',
      label: t('solanaSwap.received'),
      value: display(outcome.receivedAmount, view.assetOut),
      emphasis: 'text-weight-bold text-positive',
    },
  )
  return rows
}

function showOutcome(outcome: SolanaSwapOutcome) {
  const view = swap.value
  if (!view || unmounted) return
  swap.value = {
    ...view,
    stage: outcome.status,
    signature: outcome.signature,
    rows:
      outcome.status === 'confirmed'
        ? outcomeRows(view, outcome)
        : outcome.status === 'failed'
        ? [
            {
              key: 'network-fee',
              label: t('solanaSwap.networkFeeCharged'),
              value: displayLamports(outcome.networkFeeLamports),
            },
          ]
        : [],
  }
  void loadTokens().catch(() => undefined)
}

function markUnknown() {
  if (swap.value && swapInProgress.value) {
    swap.value = { ...swap.value, stage: 'unknown' }
  }
}

async function confirm() {
  const current = session.value
  const accepted = quote.value
  const pay = token(accepted?.inputMint ?? '')
  const receive = token(accepted?.outputMint ?? '')
  if (!current || !accepted || !pay || !receive || accepted.blocker) return
  if (!quoteFresh.value) {
    // Never confirm figures older than a few seconds: show the new ones and ask again.
    await fetchQuote()
    return
  }
  quoteGeneration++
  const view = {
    assetIn: assetOf(pay),
    assetOut: assetOf(receive),
    amountIn: accepted.inputAmount,
    quotedAmountOut: accepted.expectedOutputAmount,
  }
  reviewing.value = false
  swap.value = { ...view, stage: 'signing', rows: inProgressRows(view) }
  let submitted = false
  try {
    showOutcome(
      await current.execute(
        accepted,
        { assetIn: view.assetIn, assetOut: view.assetOut },
        record => {
          submitted = true
          if (swap.value) {
            swap.value = {
              ...swap.value,
              stage: 'submitted',
              signature: record.transactionId,
            }
          }
        },
      ),
    )
  } catch (error) {
    if (submitted) {
      // It was handed to the network: never offer a fresh swap in its place. Until the chain
      // answers, the outcome is unknown and the recorded transaction is what gets checked.
      markUnknown()
      return
    }
    // Thrown before anything was sent: back to the form with the reason.
    swap.value = null
    quote.value = null
    quoteError.value =
      error instanceof SolanaSwapError
        ? { code: error.code, detail: error.detail }
        : {
            code: 'unexpected',
            detail: error instanceof Error ? error.message : String(error),
          }
  }
}

async function followPending(pending: SolanaSwapRecord) {
  const current = session.value
  if (!current) return
  const view = {
    assetIn: pending.assetIn,
    assetOut: pending.assetOut,
    amountIn: BigInt(pending.amountIn),
    quotedAmountOut: BigInt(pending.quotedAmountOut),
  }
  swap.value = {
    ...view,
    stage: 'submitted',
    signature: pending.transactionId,
    rows: inProgressRows(view),
  }
  try {
    showOutcome(await current.resume(pending))
  } catch {
    markUnknown()
  }
}

function resumePending() {
  try {
    const pending = session.value?.pending()
    if (pending) void followPending(pending)
    else reset() // resolved meanwhile by the tracker that outlived this screen
  } catch {
    void load()
  }
}

function reset() {
  swap.value = null
  quote.value = null
  quoteError.value = null
  reviewing.value = false
  amountText.value = ''
}

onMounted(() => {
  void load()
  ticker = setInterval(() => {
    now.value = Date.now()
    // Keep the quote on screen current while the user is here and active. Hidden tab, or no
    // input for a while: stop asking; `review` and `confirm` refresh a stale quote themselves.
    if (
      quote.value &&
      !quoting.value &&
      !swap.value &&
      quoteMatchesInput.value &&
      !quoteFresh.value &&
      !document.hidden &&
      now.value - lastInputAt < IDLE_REQUOTE_LIMIT_MS
    ) {
      void fetchQuote()
    }
  }, 1000)
})

onBeforeUnmount(() => {
  unmounted = true
  clearTimeout(debounce)
  clearInterval(ticker)
})
</script>
