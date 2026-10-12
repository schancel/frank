<template>
  <div data-test="avu-details-page">
    <q-header>
      <q-toolbar>
        <q-btn
          flat
          round
          dense
          icon="arrow_back"
          to="/wallet"
          :aria-label="t('walletPanel.backToWallet')"
          data-test="avu-back-wallet"
        />
        <q-toolbar-title>{{
          t('walletPanel.avuReferenceTitle')
        }}</q-toolbar-title>
      </q-toolbar>
    </q-header>
    <q-page-container>
      <q-page class="q-pa-md">
        <q-card flat class="avu-details-card" data-test="avu-explainer-card">
          <q-card-section class="row items-center q-pb-none">
            <h2 class="text-h6 text-weight-bold q-my-none">
              {{ t('walletPanel.avuReferenceTitle') }}
            </h2>
          </q-card-section>
          <q-card-section>
            <div class="reference-values q-mb-sm">
              <div
                v-for="benchmark in benchmarks"
                :key="benchmark.id"
                :data-test="`avu-reference-current-${benchmark.id}`"
              >
                <div class="text-caption" :style="{ color: benchmark.color }">
                  {{ benchmark.label }}
                </div>
                <div class="text-subtitle1 text-weight-bold">
                  {{ benchmark.current }}
                </div>
                <div class="text-caption text-grey-7">{{ benchmark.age }}</div>
              </div>
            </div>
            <p class="text-body2" data-test="avu-reference-measurement">
              {{ t('walletPanel.avuReferenceMeasurement') }}
            </p>
            <div
              class="reference-legend q-mb-sm"
              data-test="avu-reference-legend"
            >
              <span
                v-for="benchmark in benchmarks"
                :key="benchmark.id"
                class="reference-legend-item"
              >
                <span
                  class="legend-dot"
                  :style="{ backgroundColor: benchmark.color }"
                />{{ benchmark.label }}
              </span>
            </div>
            <div class="timeframe-pill-track q-mb-sm">
              <q-btn-toggle
                v-model="selectedRange"
                dense
                no-caps
                unelevated
                toggle-color="primary"
                :options="rangeOptions"
                class="reference-ranges"
                data-test="avu-reference-range"
              />
              <q-btn
                v-if="zoom"
                flat
                dense
                no-caps
                icon="zoom_out_map"
                :label="t('walletPanel.resetZoom')"
                data-test="avu-reference-reset"
                @click="zoom = null"
              />
            </div>
            <div
              class="text-caption text-weight-medium"
              data-test="avu-reference-axis"
            >
              {{ t('walletPanel.avuReferenceAxis') }}
            </div>
            <svg
              viewBox="0 0 600 260"
              class="reference-chart"
              role="img"
              :aria-label="t('walletPanel.avuReferenceTitle')"
              data-test="avu-reference-chart"
              @pointerdown="startSelection"
              @pointermove="moveSelection"
              @pointerup="finishSelection"
              @pointercancel="drag = null"
              @lostpointercapture="drag = null"
            >
              <line
                x1="60"
                y1="220"
                x2="560"
                y2="220"
                stroke="currentColor"
                opacity="0.4"
              />
              <line
                x1="60"
                y1="25"
                x2="60"
                y2="220"
                stroke="currentColor"
                opacity="0.4"
              />
              <text x="4" y="18" font-size="11" fill="currentColor">
                {{ scale ? dollars(scale.max) : '' }}
              </text>
              <text x="4" y="220" font-size="11" fill="currentColor">
                {{ scale ? dollars(scale.min) : '' }}
              </text>
              <g v-for="line in lines" :key="line.id">
                <path
                  v-if="line.path"
                  :d="line.path"
                  fill="none"
                  :stroke="line.color"
                  stroke-width="2.5"
                  :data-test="`avu-reference-line-${line.id}`"
                />
                <circle
                  v-for="point in line.points"
                  :key="point.at"
                  :cx="point.x"
                  :cy="point.y"
                  r="3"
                  :fill="line.color"
                  :data-test="`avu-reference-point-${line.id}`"
                >
                  <title>
                    {{ line.label }} · {{ dateLabel(point.at) }} ·
                    {{ dollars(point.value) }}
                  </title>
                </circle>
              </g>
              <rect
                v-if="drag && drag.from !== drag.to"
                :x="Math.min(drag.from, drag.to)"
                y="25"
                :width="Math.abs(drag.to - drag.from)"
                height="195"
                fill="currentColor"
                opacity="0.12"
                pointer-events="none"
                data-test="avu-reference-selection"
              />
              <text x="60" y="246" font-size="11" fill="currentColor">
                {{ extent ? dateLabel(extent.min) : '' }}
              </text>
              <text
                v-if="extent && extent.min !== extent.max"
                x="560"
                y="246"
                text-anchor="end"
                font-size="11"
                fill="currentColor"
              >
                {{ extent ? dateLabel(extent.max) : '' }}
              </text>
            </svg>
            <div
              class="text-caption text-grey-7"
              data-test="avu-reference-note"
            >
              {{ historyNote }}
            </div>
            <details class="q-mt-md" data-test="avu-reference-methodology">
              <summary>{{ t('walletPanel.avuReferenceMethod') }}</summary>
              <p class="text-body2 q-mt-sm">
                {{ t('walletPanel.avuReferenceMethodText') }}
              </p>
              <p class="text-body2">
                {{ t('walletPanel.avuReferenceSampling') }}
              </p>
            </details>
            <div class="q-mt-md" data-test="avu-rates-section">
              <div class="text-subtitle2 text-weight-bold">
                {{ t('walletPanel.avuRatesTitle') }}
              </div>
              <q-markup-table
                flat
                bordered
                dense
                separator="horizontal"
                class="coin-rates q-mt-xs"
                data-test="avu-rates-table"
              >
                <thead>
                  <tr class="text-left">
                    <th>{{ t('walletPanel.avuRatesAsset') }}</th>
                    <th>{{ t('walletPanel.priceHistoryHash') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in equivalencyRows"
                    :key="row.asset"
                    :data-test="`avu-rate-row-${row.asset}`"
                  >
                    <td>{{ row.label }}</td>
                    <td>{{ row.rateFormatted }}</td>
                  </tr>
                </tbody>
              </q-markup-table>
            </div>
          </q-card-section>
        </q-card>
      </q-page>
    </q-page-container>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  useSafeOracleStore,
  formatAge,
  MINING_STALE_AFTER_MS,
} from '../stores/oracle'
import { UNIT_RATE_ASSET_METRICS, formatAvu } from '../utils/avu-units'
import { useTranslate } from '../composables/useTranslate'
import { useOracleHistory } from '../composables/useOracleFeed'
import {
  SUPPORTED_ASSETS,
  ELECTRICITY_AGGREGATE,
  avuHashAt,
  avuSpotAt,
  seriesName,
} from '@frank/wallet/oracle'

const oracle = useSafeOracleStore()
const t = useTranslate()
const DAY = 86400
const ranges = {
  'all': { span: Infinity, step: 30 * DAY },
  '1y': { span: 365 * DAY, step: DAY },
  '30d': { span: 30 * DAY, step: 6 * 3600 },
  '7d': { span: 7 * DAY, step: 3600 },
} as const
const selectedRange = ref<keyof typeof ranges>('1y')
const since = ref(0)
const zoom = ref<{ min: number; max: number } | null>(null)
const drag = ref<{ id: number; from: number; to: number } | null>(null)
watch(
  selectedRange,
  () => {
    zoom.value = null
    drag.value = null
    since.value = Number.isFinite(ranges[selectedRange.value].span)
      ? Math.floor(Date.now() / 1000) - ranges[selectedRange.value].span
      : Date.UTC(2010, 0, 1) / 1000
  },
  { immediate: true },
)
const rangeOptions = computed(() => [
  { label: t('walletPanel.rangeAll'), value: 'all' },
  { label: t('walletPanel.range1Y'), value: '1y' },
  { label: t('walletPanel.range30D'), value: '30d' },
  { label: t('walletPanel.range7D'), value: '7d' },
])
function dollars(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}
function dateLabel(at: number): string {
  const short = extent.value && extent.value.max - extent.value.min <= 2 * DAY
  return new Date(at * 1000).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: short ? undefined : 'numeric',
    hour: short ? '2-digit' : undefined,
    minute: short ? '2-digit' : undefined,
    timeZone: 'UTC',
  })
}
const benchmarks = computed(() => {
  const now = Date.now()
  return [
    {
      id: 'hash',
      label: t('walletPanel.avuReferenceHash'),
      color: '#7c3aed',
      value: oracle.current?.avuHash?.kwhPerValue,
      at: oracle.current?.avuHash?.oldestInputAt,
      stale: oracle.current?.avuHash?.stale,
      threshold: MINING_STALE_AFTER_MS,
    },
    {
      id: 'spot',
      label: t('walletPanel.avuReferenceSpot'),
      color: '#0284c7',
      value: oracle.current?.avuSpot.kwhPerValue,
      at: oracle.current?.avuSpot.at,
      stale: oracle.current?.avuSpot.stale,
      threshold: 3 * DAY * 1000,
    },
  ].map(benchmark => ({
    ...benchmark,
    current:
      benchmark.value && benchmark.value > 0
        ? `≈ ${dollars(1 / benchmark.value)}`
        : t('walletPanel.avuUnavailable'),
    age:
      benchmark.at === undefined
        ? ''
        : t(
            benchmark.stale || now - benchmark.at * 1000 > benchmark.threshold
              ? 'walletPanel.avuPriceStaleNote'
              : 'walletPanel.avuPriceFreshNote',
            { age: formatAge(now - benchmark.at * 1000) },
          ),
  }))
})
const observations = computed(() => {
  const feed = oracle.inputs
  if (!feed) return []
  const names = new Set([ELECTRICITY_AGGREGATE])
  for (const entry of feed.basket.entries) {
    names.add(seriesName('efficiency', entry.algorithm))
    for (const chain of entry.chains)
      for (const kind of [
        'price',
        'marketCap',
        'hashrate',
        'minerRevenue',
      ] as const)
        names.add(seriesName(kind, chain.chain))
  }
  const times = new Set<number>()
  const now = Math.floor(Date.now() / 1000)
  for (const name of Array.from(names))
    for (const [at] of feed.series[name]?.points ?? [])
      if (at >= since.value && at <= now) times.add(at)
  return Array.from(times)
    .sort((a, b) => a - b)
    .map(at => {
      const hash = avuHashAt(feed, at)
      return {
        at,
        hash: hash?.kwhPerValue,
        estimated: hash?.entries.some(entry => entry.estimated),
        spot: avuSpotAt(feed, at).kwhPerValue,
      }
    })
})
const histories = computed(() =>
  benchmarks.value.map(benchmark => ({
    ...benchmark,
    points: observations.value
      .filter(
        point =>
          !zoom.value ||
          (point.at >= zoom.value.min && point.at <= zoom.value.max),
      )
      .map(point => {
        const kwhPerValue = benchmark.id === 'hash' ? point.hash : point.spot
        return {
          at: point.at,
          value: kwhPerValue && kwhPerValue > 0 ? 1 / kwhPerValue : undefined,
        }
      }),
  })),
)
const extent = computed(() => {
  const times = histories.value.flatMap(line =>
    line.points
      .filter(point => point.value !== undefined)
      .map(point => point.at),
  )
  return times.length
    ? { min: Math.min(...times), max: Math.max(...times) }
    : null
})
// Coordinates use the rendered SVG width, not its 600-unit viewBox width.
function plotX(event: PointerEvent): number | null {
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
  return rect.width > 0
    ? Math.max(
        60,
        Math.min(560, ((event.clientX - rect.left) / rect.width) * 600),
      )
    : null
}
function startSelection(event: PointerEvent) {
  if (
    event.isPrimary === false ||
    (event.pointerType === 'mouse' && event.button !== 0)
  )
    return
  if (!extent.value || extent.value.min === extent.value.max) return
  const x = plotX(event)
  if (x === null) return
  drag.value = { id: event.pointerId, from: x, to: x }
  ;(event.currentTarget as SVGSVGElement).setPointerCapture?.(event.pointerId)
}
function moveSelection(event: PointerEvent) {
  if (!drag.value || drag.value.id !== event.pointerId) return
  const x = plotX(event)
  if (x !== null) drag.value.to = x
}
function finishSelection(event: PointerEvent) {
  if (!drag.value || drag.value.id !== event.pointerId) return
  moveSelection(event)
  const selected = drag.value
  drag.value = null
  const bounds = extent.value
  if (!bounds || Math.abs(selected.to - selected.from) < 5) return
  const times = Array.from(
    new Set(lines.value.flatMap(line => line.points.map(point => point.at))),
  )
  const nearest = (x: number) => {
    const at = bounds.min + ((x - 60) / 500) * (bounds.max - bounds.min)
    return times.reduce((best, time) =>
      Math.abs(time - at) < Math.abs(best - at) ? time : best,
    )
  }
  const from = nearest(selected.from),
    to = nearest(selected.to)
  if (from !== to)
    zoom.value = { min: Math.min(from, to), max: Math.max(from, to) }
}
const scale = computed(() => {
  const values = histories.value.flatMap(line =>
    line.points.flatMap(point =>
      point.value === undefined ? [] : [point.value],
    ),
  )
  if (!values.length) return null
  const low = Math.min(...values),
    high = Math.max(...values)
  const pad = low === high ? Math.abs(high) * 0.05 || 1 : (high - low) * 0.1
  return { min: Math.max(0, low - pad), max: high + pad }
})
const lines = computed(() =>
  histories.value.map(line => {
    const bounds = extent.value,
      axis = scale.value
    const points = line.points.flatMap((point, index) =>
      point.value === undefined || !bounds || !axis
        ? []
        : [
            {
              at: point.at,
              value: point.value,
              index,
              x:
                bounds.max === bounds.min
                  ? 310
                  : 60 +
                    ((point.at - bounds.min) / (bounds.max - bounds.min)) * 500,
              y: 220 - ((point.value - axis.min) / (axis.max - axis.min)) * 195,
            },
          ],
    )
    return {
      ...line,
      points,
      path: points
        .flatMap((point, index) => {
          const next = points[index + 1]
          return next && next.index === point.index + 1
            ? [`M ${point.x},${point.y} L ${next.x},${next.y}`]
            : []
        })
        .join(' '),
    }
  }),
)
const historyNote = computed(() => {
  const count = lines.value.reduce((sum, line) => sum + line.points.length, 0)
  if (!count) return t('walletPanel.avuReferenceNoHistory')
  return [
    t('walletPanel.avuReferencePointCount', { count }),
    observations.value.some(point => point.estimated)
      ? t('walletPanel.avuHashEstimated')
      : '',
    lines.value.some(line => line.points.length === 1)
      ? t('walletPanel.avuReferenceSinglePoint')
      : '',
  ]
    .filter(Boolean)
    .join(' ')
})
const equivalencyRows = computed(() => [
  ...SUPPORTED_ASSETS.filter(asset => asset !== 'tempo').map(asset => ({
    asset,
    label: UNIT_RATE_ASSET_METRICS[asset].symbol,
    rateFormatted:
      oracle.formatUnitRate?.(asset) || t('walletPanel.avuUnavailable'),
  })),
  {
    asset: 'usd',
    label: '1 USD',
    rateFormatted: oracle.current?.avuHash?.kwhPerValue
      ? `≈ ${formatAvu(oracle.current.avuHash.kwhPerValue)}`
      : t('walletPanel.avuUnavailable'),
  },
])
useOracleHistory(() => ({
  since: since.value,
  step: ranges[selectedRange.value].step,
}))
// A coarse ALL/1Y request must not collapse newly collected recent history to one bucket.
useOracleHistory(() =>
  !zoom.value && ranges[selectedRange.value].step > 3600
    ? {
        since: Math.max(since.value, Math.floor(Date.now() / 1000) - 30 * DAY),
        step: 3600,
      }
    : null,
)
useOracleHistory(() =>
  zoom.value
    ? {
        since: zoom.value.min,
        until: zoom.value.max,
        step: Math.max(60, Math.ceil((zoom.value.max - zoom.value.min) / 600)),
      }
    : null,
)
</script>

<style scoped>
.avu-details-card {
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  min-width: 0;
}
.reference-values {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.reference-values > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.reference-chart {
  touch-action: pan-y;
  user-select: none;
  width: 100%;
  height: auto;
  display: block;
}
.reference-ranges {
  flex-wrap: wrap;
  max-width: 100%;
}
.coin-rates {
  width: 100%;
}
.coin-rates :deep(td),
.coin-rates :deep(th) {
  white-space: normal;
  overflow-wrap: anywhere;
}
@media (max-width: 360px) {
  .reference-values {
    grid-template-columns: minmax(0, 1fr);
  }
}

.reference-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.reference-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.timeframe-pill-track {
  display: inline-flex;
  max-width: 100%;
  padding: 2px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.05);
}
.reference-ranges :deep(.q-btn) {
  font-size: 11.5px;
  padding: 4px 10px;
  min-height: 28px;
  border-radius: 8px;
}
</style>
