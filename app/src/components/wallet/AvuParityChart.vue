<template>
  <section class="avu-parity-chart q-pa-sm" data-test="avu-parity-chart">
    <header class="price-history-header q-mb-sm">
      <h2
        class="text-subtitle1 text-weight-bold q-my-none"
        data-test="price-history-title"
      >
        {{ t('walletPanel.priceHistoryTitle', { symbol: quoteUnit }) }}
      </h2>
      <div class="text-h5 text-weight-bold" data-test="metric-value-token-rate">
        {{ currentRate || t('walletPanel.avuUnavailable') }}
      </div>
      <div
        class="text-caption text-grey-7"
        data-test="price-history-current-note"
      >
        {{ currentNote }}
      </div>
    </header>

    <div class="denomination-controls q-mb-sm">
      <q-btn-toggle
        v-model="denomination"
        dense
        no-caps
        unelevated
        toggle-color="primary"
        :options="denominationOptions"
        data-test="denomination-toggle"
      />
    </div>
    <div class="timeframe-controls-section q-mb-md">
      <div class="row items-center q-gutter-x-xs">
        <div class="timeframe-pill-track">
          <q-btn-toggle
            v-model="selectedRange"
            dense
            no-caps
            rounded
            unelevated
            toggle-color="primary"
            color="transparent"
            text-color="grey-8"
            class="timeframe-btn-toggle"
            :options="rangeToggleOptions"
            data-test="view-toggle"
          />
        </div>
        <q-btn
          v-if="zoom"
          dense
          no-caps
          rounded
          unelevated
          color="primary"
          icon="zoom_out_map"
          :label="$t('walletPanel.resetZoom')"
          data-test="reset-zoom-btn"
          @click="zoom = null"
        />
      </div>
    </div>

    <q-card
      bordered
      flat
      class="chart-canvas-card q-pa-sm"
      :class="cardBgClass"
    >
      <div
        class="text-caption text-weight-medium q-px-sm"
        data-test="price-history-axis"
      >
        {{ axisTitle }}
      </div>
      <!-- Lines: one circle per real data point, joined in order. No point is computed between them. -->
      <div class="chart-container" data-test="macro-chart-container">
        <svg
          class="chart-svg cursor-crosshair"
          viewBox="0 0 640 290"
          preserveAspectRatio="xMidYMid meet"
          data-test="macro-chart-svg"
          @mouseleave="leaveChart"
        >
          <g class="grid-lines" opacity="0.3">
            <line
              v-for="y in [55, 113, 172, 230]"
              :key="`grid-${y}`"
              x1="55"
              :y1="y"
              x2="625"
              :y2="y"
              :stroke="themeColors.gridLines"
              stroke-width="1"
              stroke-dasharray="3 3"
            />
          </g>
          <line
            x1="55"
            y1="230"
            x2="625"
            y2="230"
            :stroke="themeColors.axis"
            stroke-width="1.5"
          />
          <line
            x1="55"
            y1="20"
            x2="55"
            y2="230"
            :stroke="themeColors.axis"
            stroke-width="1.5"
          />

          <g v-for="line in drawnLines" :key="line.id">
            <path
              v-if="line.path"
              :d="line.path"
              fill="none"
              :stroke="line.color"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              :data-test="`chart-line-${line.id}`"
            />
            <circle
              v-for="point in line.points"
              :key="`${line.id}-${point.key}`"
              :cx="point.x"
              :cy="point.y"
              :r="line.points.length > 40 ? 2 : 4"
              :fill="line.color"
              :stroke="cardBgHex"
              stroke-width="1"
              :data-test="`chart-point-${line.id}`"
            />
          </g>

          <line
            v-if="hovered"
            :x1="hovered.x"
            y1="20"
            :x2="hovered.x"
            y2="230"
            :stroke="themeColors.axis"
            stroke-width="1.5"
            stroke-dasharray="3 3"
            style="pointer-events: none"
          />

          <!-- The stretch being dragged over; releasing zooms the chart to it -->
          <rect
            v-if="dragSelection"
            :x="dragSelection.x"
            y="20"
            :width="dragSelection.width"
            height="210"
            :fill="themeColors.axis"
            fill-opacity="0.2"
            style="pointer-events: none"
            data-test="zoom-selection"
          />

          <!-- One hover column per plotted position -->
          <g
            v-for="column in columns"
            :key="`col-${column.key}`"
            data-test="chart-hover-point"
            @mouseenter="hovered = column"
            @click="hovered = column"
          >
            <text
              v-if="column.tick"
              :x="column.x"
              y="248"
              font-size="11"
              :text-anchor="column.anchor"
              :fill="themeColors.text"
              class="unselectable"
              data-test="chart-time-tick"
            >
              {{ column.tick }}
            </text>
          </g>
          <rect
            x="55"
            y="20"
            width="570"
            height="210"
            fill="transparent"
            class="chart-range-interaction"
            data-test="chart-range-interaction"
            @pointerdown.prevent="startDrag"
            @pointermove="movePointer"
            @pointerup="finishDrag"
            @pointercancel="cancelDrag"
            @lostpointercapture="cancelDrag"
            @pointerleave="leaveChart"
          />
        </svg>
        <div
          v-for="side in axisLabels"
          :key="side.axis"
          class="chart-scale"
          :style="{
            gridTemplateRows: `${Y_TOP}fr ${Y_BOTTOM - Y_TOP}fr ${
              290 - Y_BOTTOM
            }fr`,
          }"
          data-test="chart-scale"
        >
          <div class="chart-scale-bounds">
            <div
              v-for="end in side.ends"
              :key="end.name"
              :data-test="`chart-${end.name}-label-${side.axis}`"
            >
              <span
                v-for="label in end.labels"
                :key="label.id"
                :style="{ color: label.color }"
                :data-test="`chart-scale-${end.name}-${label.id}`"
              >
                {{ label.text }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        class="chart-inspection-panel q-pa-sm q-mb-xs rounded-borders"
        :class="isDark ? 'bg-dark-1' : 'bg-grey-1'"
        data-test="chart-inspection-table"
      >
        <div class="inspection-grid text-center">
          <div class="inspection-cell" data-test="inspection-date">
            <div class="text-caption text-grey-7 text-weight-medium">
              {{
                hovered
                  ? $t('walletPanel.inspectingDate')
                  : $t('walletPanel.latestValue')
              }}
            </div>
            <div class="text-weight-bolder text-subtitle2 q-mt-xs">
              {{ inspected ? inspected.label : '—' }}
            </div>
          </div>
          <div
            v-for="cell in inspectedCells"
            :key="cell.id"
            class="inspection-cell"
            :data-test="`inspection-cell-${cell.id}`"
          >
            <div class="text-caption text-grey-7 text-weight-medium">
              {{ cell.label }}
            </div>
            <div
              class="text-weight-bolder text-subtitle2 q-mt-xs"
              :style="{ color: cell.color }"
            >
              {{ cell.value }}
            </div>
          </div>
        </div>
      </div>

      <div
        class="text-caption text-grey-7 q-px-sm q-py-xs"
        data-test="chart-data-note"
      >
        {{ dataNote }}
      </div>
    </q-card>
    <div
      v-if="priceSource && denomination !== 'gold'"
      class="text-caption text-grey-7 q-mt-sm"
      data-test="price-history-source"
    >
      {{ t('walletPanel.priceHistorySource', { source: priceSource }) }}
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import {
  useSafeOracleStore,
  formatAge,
  STALE_AFTER_MS,
} from 'src/stores/oracle'
import { UNIT_RATE_ASSET_METRICS, formatAvu } from 'src/utils/avu-units'
import { useTranslate } from 'src/composables/useTranslate'
import { useOracleHistory } from 'src/composables/useOracleFeed'
import {
  at as valueAt,
  avuHashAt,
  avuSpotAt,
  priceAssetId,
  seriesName,
  mergeSeries,
  type OracleFeed,
  type OracleInputs,
  type SupportedAsset,
} from '@frank/wallet/oracle'

const props = withDefaults(defineProps<{ selectedWallet?: string }>(), {
  selectedWallet: 'monad',
})

const oracle = useSafeOracleStore()
const t = useTranslate()

let $q: ReturnType<typeof useQuasar> | null = null
try {
  $q = useQuasar()
} catch {
  $q = null
}
const isDark = computed(() => Boolean($q?.dark?.isActive))
const cardBgClass = computed(() => (isDark.value ? 'bg-dark' : 'bg-white'))
const cardBgHex = computed(() => (isDark.value ? '#121212' : '#ffffff'))
const themeColors = computed(() =>
  isDark.value
    ? {
        grid: '#38bdf8',
        token: '#c084fc',
        gridLines: '#334155',
        axis: '#64748b',
        text: '#94a3b8',
        textPrimary: '#f8fafc',
        barBase: '#0284c7',
      }
    : {
        grid: '#0284c7',
        token: '#7c3aed',
        gridLines: '#e2e8f0',
        axis: '#94a3b8',
        text: '#64748b',
        textPrimary: '#0f172a',
        barBase: '#38bdf8',
      },
)

const DAY = 86_400
/** Range duration and requested history resolution, in seconds. */
const RANGES = {
  // Bitcoin's bundled history begins in 2010; nothing older can be asked for.
  'all': { span: Infinity, step: 30 * DAY },
  '5y': { span: 5 * 365 * DAY, step: 30 * DAY },
  '1y': { span: 365 * DAY, step: DAY },
  '30d': { span: 30 * DAY, step: 6 * 3600 },
  '7d': { span: 7 * DAY, step: 3600 },
  '24h': { span: DAY, step: 600 },
} as const
const EARLIEST = Date.UTC(2010, 0, 1) / 1000

export type TimeRange = keyof typeof RANGES
const selectedRange = ref<TimeRange>('all')
const timeRange = computed(() => RANGES[selectedRange.value])

const rangeToggleOptions = computed(() => [
  { label: t('walletPanel.rangeAll'), value: 'all' },
  { label: t('walletPanel.range5Y'), value: '5y' },
  { label: t('walletPanel.range1Y'), value: '1y' },
  { label: t('walletPanel.range30D'), value: '30d' },
  { label: t('walletPanel.range7D'), value: '7d' },
  { label: t('walletPanel.range24H'), value: '24h' },
])

/** The start of the selected range, fixed when the range is chosen. Unix seconds. */
const rangeStart = ref(EARLIEST)
watch(
  selectedRange,
  () => {
    const range = timeRange.value
    rangeStart.value =
      range && Number.isFinite(range.span)
        ? Math.floor(Date.now() / 1000) - range.span
        : EARLIEST
  },
  { immediate: true },
)

// ---- The coin whose wallet is open ---------------------------------------------------

const asset = computed(
  () => (props.selectedWallet || 'monad').toLowerCase() as SupportedAsset,
)
const unit = computed(
  () =>
    UNIT_RATE_ASSET_METRICS[asset.value] ?? {
      symbol: `1 ${asset.value.toUpperCase()}`,
      multiplier: 1,
    },
)
const tokenPriceSeries = computed(() => {
  const id = priceAssetId(asset.value)
  return id ? seriesName('price', id) : ''
})

const quoteUnit = computed(() =>
  unit.value.multiplier === 1
    ? unit.value.symbol.replace(/^1 /, '')
    : unit.value.symbol,
)
const inputs = computed<OracleInputs | undefined>(() => oracle.inputs)
type Denomination = 'hash' | 'spot' | 'gold'
const denomination = ref<Denomination>('hash')
const denominationOptions = computed(() => [
  { label: t('walletPanel.priceHistoryHash'), value: 'hash' },
  { label: t('walletPanel.priceHistorySpot'), value: 'spot' },
  { label: t('walletPanel.priceHistoryGold'), value: 'gold' },
])
const axisTitle = computed(() =>
  t(
    `walletPanel.priceHistoryAxis${
      denomination.value === 'hash'
        ? 'Hash'
        : denomination.value === 'spot'
        ? 'Spot'
        : 'Gold'
    }`,
    { symbol: quoteUnit.value },
  ),
)
const GOLD_MAX_AGE_SECONDS = 7 * DAY
function goldAt(feed: OracleInputs | undefined, time: number) {
  const series = feed?.series[seriesName('price', 'gold')]
  if (!series || !('unit' in series) || series.unit !== 'USD/troy ounce')
    return undefined
  const point = valueAt(series.points, time)
  return point && point[1] > 0 && time - point[0] <= GOLD_MAX_AGE_SECONDS
    ? point
    : undefined
}
function formatGold(value: number): string {
  return `${value.toLocaleString(undefined, {
    maximumSignificantDigits: 6,
  })} oz`
}
const currentRate = computed(() => {
  if (denomination.value === 'gold') {
    const now = Math.floor(Date.now() / 1000)
    const price = valueAt(
      inputs.value?.series[tokenPriceSeries.value]?.points,
      now,
    )
    const gold = goldAt(inputs.value, now)
    if (!price || !gold || price[1] <= 0) return ''
    const value = (price[1] / gold[1]) * unit.value.multiplier
    if (!Number.isFinite(value) || value <= 0) return ''
    const rate = `${unit.value.symbol} ≈ ${formatGold(value)}`
    return oracle.valuesAreTestnet
      ? t('walletPanel.avuTestnetValue', { rate })
      : rate
  }
  if (denomination.value === 'hash')
    return oracle.formatUnitRate?.(asset.value) ?? ''
  const price = valueAt(
    inputs.value?.series[tokenPriceSeries.value]?.points,
    Math.floor(Date.now() / 1000),
  )
  const value =
    price && oracle.current?.avuSpot.kwhPerValue
      ? price[1] * oracle.current.avuSpot.kwhPerValue * unit.value.multiplier
      : undefined
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ''
  const rate = `${unit.value.symbol} ≈ ${formatAvu(value)}`
  return oracle.valuesAreTestnet
    ? t('walletPanel.avuTestnetValue', { rate })
    : rate
})
const currentNote = computed(() => {
  if (denomination.value === 'gold') {
    const gold = goldAt(inputs.value, Math.floor(Date.now() / 1000))
    const age = Math.max(
      gold ? Date.now() - gold[0] * 1000 : 0,
      oracle.priceAgeMs?.(asset.value) ?? 0,
    )
    return gold && currentRate.value
      ? t(
          age > STALE_AFTER_MS
            ? 'walletPanel.avuPriceStaleNote'
            : 'walletPanel.avuPriceFreshNote',
          { age: formatAge(age) },
        )
      : t('walletPanel.priceHistoryGoldUnavailable')
  }
  const age = oracle.priceAgeMs?.(asset.value)
  if (!currentRate.value) return t('walletPanel.avuUnavailable')
  const parts =
    age === undefined
      ? []
      : [
          t(
            age > STALE_AFTER_MS
              ? 'walletPanel.avuPriceStaleNote'
              : 'walletPanel.avuPriceFreshNote',
            { age: formatAge(age) },
          ),
        ]
  const spot = oracle.current?.avuSpot
  if (denomination.value === 'spot' && spot?.at !== undefined) {
    const spotAge = Date.now() - spot.at * 1000
    if (spot.stale || spotAge > 3 * DAY * 1000)
      parts.push(t('walletPanel.avuSpotStale', { age: formatAge(spotAge) }))
  }
  return parts.join(' ')
})
const priceSource = computed(
  () => inputs.value?.series[tokenPriceSeries.value]?.source ?? '',
)

// ---- Lines ------------------------------------------------------------------------------

interface DataPoint {
  /** Unix seconds. */
  at: number
  value: number
  estimated?: boolean
}

interface Series {
  id: 'token'
  label: string
  color: string
  axis: 'left' | 'right'
  format: (value: number) => string
  points: DataPoint[]
  gaps: number[]
}

// Only the current zoom holds unthinned history; old detailed intervals never accumulate.
const detailedHistory = ref<OracleFeed[]>([])
const historyInputs = computed<OracleInputs | undefined>(() => {
  const held = inputs.value
  if (!held) return undefined
  const series = { ...held.series }
  for (const feed of detailedHistory.value) {
    for (const [name, received] of Object.entries(feed.series)) {
      series[name] = {
        ...received,
        points: mergeSeries(series[name]?.points ?? [], received.points),
      }
    }
  }
  return { ...held, series }
})

/** Only actual selected-coin price timestamps provide historical observations. */
const sampleTimes = computed<number[]>(() => {
  const points =
    historyInputs.value?.series[tokenPriceSeries.value]?.points ?? []
  const now = Math.floor(Date.now() / 1000)
  // Request resolution must not discard finer observations already held in the cache.
  return points
    .filter(([time]) => time >= rangeStart.value && time <= now)
    .map(([time]) => time)
})

const rangeSeries = computed<Series[]>(() => {
  const feed = historyInputs.value
  if (!feed) return []
  const points: DataPoint[] = []
  const gaps: number[] = []
  for (const time of sampleTimes.value) {
    const price = valueAt(feed.series[tokenPriceSeries.value]?.points, time)
    const hash =
      denomination.value === 'hash' ? avuHashAt(feed, time) : undefined
    const basis = denomination.value === 'hash' ? hash : avuSpotAt(feed, time)
    const gold = denomination.value === 'gold' ? goldAt(feed, time) : undefined
    const value =
      denomination.value === 'gold'
        ? price && gold
          ? price[1] / gold[1]
          : undefined
        : price && basis?.kwhPerValue
        ? price[1] * basis.kwhPerValue
        : undefined
    if (value !== undefined && Number.isFinite(value) && value > 0)
      points.push({
        at: time,
        value: value * unit.value.multiplier,
        estimated: hash?.entries.some(entry => entry.estimated),
      })
    else gaps.push(time)
  }
  return [
    {
      id: 'token',
      label: axisTitle.value,
      color: themeColors.value.token,
      axis: 'right',
      format: value =>
        denomination.value === 'gold' ? formatGold(value) : formatAvu(value),
      points,
      gaps,
    },
  ]
})

// Drag across the chart to zoom to that stretch. Zooming only hides points outside it.
const zoom = ref<{ min: number; max: number } | null>(null)
watch(
  zoom,
  () => {
    detailedHistory.value = []
  },
  { flush: 'sync' },
)
const series = computed<Series[]>(() => {
  const window = zoom.value
  if (!window) return rangeSeries.value
  return rangeSeries.value.map(s => ({
    ...s,
    points: s.points.filter(p => p.at >= window.min && p.at <= window.max),
  }))
})

function formatAt(at: number): string {
  const date = new Date(at * 1000)
  const extent = timeExtent.value
  const span = extent ? extent.max - extent.min : 0
  if (span > 365 * DAY) {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric',
    })
  }
  return span <= 2 * DAY
    ? date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(span > 90 * DAY ? { year: '2-digit' } : {}),
      })
}

const X_MIN = 65
const X_MAX = 615
const Y_TOP = 30
const Y_BOTTOM = 230

const timeExtent = computed(() => {
  const all = series.value.flatMap(s => s.points.map(p => p.at))
  return all.length > 0
    ? { min: Math.min(...all), max: Math.max(...all) }
    : null
})

function xOf(at: number): number {
  const extent = timeExtent.value
  if (!extent || extent.max === extent.min) return (X_MIN + X_MAX) / 2
  return (
    X_MIN + ((at - extent.min) / (extent.max - extent.min)) * (X_MAX - X_MIN)
  )
}

const drawnLines = computed(() =>
  series.value
    .filter(s => s.points.length > 0)
    .map(s => {
      const values = s.points.map(p => p.value)
      const low = Math.min(...values)
      const high = Math.max(...values)
      // Pad the scale so a flat or single-point series sits mid-chart instead of on an edge.
      const pad = high === low ? Math.abs(high) * 0.05 || 1 : (high - low) * 0.1
      const min = Math.max(0, low - pad)
      const max = high + pad
      const points = s.points.map(p => ({
        key: p.at,
        x: Math.round(xOf(p.at) * 10) / 10,
        y:
          Math.round(
            (Y_BOTTOM - ((p.value - min) / (max - min)) * (Y_BOTTOM - Y_TOP)) *
              10,
          ) / 10,
      }))
      return {
        id: s.id,
        color: s.color,
        axis: s.axis,
        points,
        // Missing benchmark inputs break the line; isolated observations stay circles.
        path: points
          .flatMap((point, index) => {
            const next = points[index + 1]
            if (!next || s.gaps.some(at => at > point.key && at < next.key))
              return []
            return [`M ${point.x},${point.y} L ${next.x},${next.y}`]
          })
          .join(' '),
        minLabel: s.format(min),
        maxLabel: s.format(max),
      }
    }),
)

/** The ends of each side's scales: per side, every line's highest and lowest figure. */
const axisLabels = computed(() =>
  (['left', 'right'] as const)
    .map(axis => {
      const lines = drawnLines.value.filter(line => line.axis === axis)
      const labels = (pick: 'maxLabel' | 'minLabel') =>
        lines.map(line => ({
          id: line.id,
          color: line.color,
          text: line[pick],
        }))
      return {
        axis,
        ends: [
          { name: 'max', labels: labels('maxLabel') },
          { name: 'min', labels: labels('minLabel') },
        ],
      }
    })
    .filter(side => side.ends[0].labels.length > 0),
)

interface Column {
  key: number
  x: number
  label: string
  tick: string
  anchor: 'start' | 'middle' | 'end'
}

const columns = computed<Column[]>(() => {
  // Array.from, not spread: the app's build target does not iterate a Set by spreading.
  const positions = Array.from(
    new Set(series.value.flatMap(s => s.points.map(p => p.at))),
  ).sort((a, b) => a - b)
  // Choose by time position, not sample index: irregular observations must not bunch
  // labels together. Three ticks and endpoint anchors fit the narrow SVG too.
  const ticks = new Set<number>()
  if (positions.length) {
    ticks.add(positions[0])
    const last = positions[positions.length - 1]
    ticks.add(last)
    const middle = positions.reduce((best, at) =>
      Math.abs(xOf(at) - (X_MIN + X_MAX) / 2) <
      Math.abs(xOf(best) - (X_MIN + X_MAX) / 2)
        ? at
        : best,
    )
    if (xOf(middle) - X_MIN >= 170 && X_MAX - xOf(middle) >= 170)
      ticks.add(middle)
  }
  return positions.map<Column>((at, index) => ({
    key: at,
    x: Math.round(xOf(at) * 10) / 10,
    label: formatAt(at),
    tick: ticks.has(at) ? formatAt(at) : '',
    anchor:
      positions.length === 1
        ? 'middle'
        : index === 0
        ? 'start'
        : index === positions.length - 1
        ? 'end'
        : 'middle',
  }))
})

const hovered = ref<Column | null>(null)
const dragFrom = ref<{ pointerId: number; x: number; at: number } | null>(null)
const pointerX = ref<number | null>(null)
watch([selectedRange, asset, denomination], () => {
  hovered.value = null
  cancelDrag()
  zoom.value = null
})

// Convert rendered coordinates through the SVG's actual transform, including letterboxing.
function pointerPosition(event: PointerEvent) {
  const target = event.currentTarget as SVGRectElement
  const svg = target.ownerSVGElement
  const transform = svg?.getScreenCTM()
  const extent = timeExtent.value
  if (!svg || !transform || !extent || extent.min === extent.max) return null
  const point = svg.createSVGPoint()
  point.x = event.clientX
  point.y = event.clientY
  const local = point.matrixTransform(transform.inverse())
  const x = Math.max(X_MIN, Math.min(X_MAX, local.x))
  return {
    x,
    at: Math.round(
      extent.min + ((x - X_MIN) / (X_MAX - X_MIN)) * (extent.max - extent.min),
    ),
  }
}
function movePointer(event: PointerEvent) {
  if (dragFrom.value && dragFrom.value.pointerId !== event.pointerId) return
  const position = pointerPosition(event)
  if (!position) return
  pointerX.value = position.x
  hovered.value = columns.value.reduce<Column | null>(
    (best, column) =>
      !best || Math.abs(column.x - position.x) < Math.abs(best.x - position.x)
        ? column
        : best,
    null,
  )
}
function startDrag(event: PointerEvent) {
  if (dragFrom.value || !event.isPrimary || event.button !== 0) return
  const position = pointerPosition(event)
  if (!position) return
  dragFrom.value = { pointerId: event.pointerId, ...position }
  movePointer(event)
  ;(event.currentTarget as SVGRectElement).setPointerCapture(event.pointerId)
}
const dragSelection = computed(() => {
  const from = dragFrom.value
  const to = pointerX.value
  if (!from || to === null || from.x === to) return null
  return { x: Math.min(from.x, to), width: Math.abs(to - from.x) }
})
function finishDrag(event: PointerEvent) {
  const from = dragFrom.value
  if (!from || from.pointerId !== event.pointerId) return
  const to = pointerPosition(event)
  cancelDrag()
  ;(event.currentTarget as SVGRectElement).releasePointerCapture(
    event.pointerId,
  )
  if (!to || Math.abs(from.x - to.x) < 4 || from.at === to.at) return
  zoom.value = { min: Math.min(from.at, to.at), max: Math.max(from.at, to.at) }
  hovered.value = null
}
function cancelDrag() {
  dragFrom.value = null
  pointerX.value = null
}
function leaveChart() {
  if (!dragFrom.value) hovered.value = null
}

const inspected = computed<Column | null>(
  () => hovered.value ?? columns.value[columns.value.length - 1] ?? null,
)

const inspectedCells = computed(() => {
  const column = inspected.value
  if (!column) return []
  return series.value.flatMap(s => {
    const point = s.points.find(p => p.at === column.key)
    return point
      ? [
          {
            id: s.id,
            label: s.label,
            color: s.color,
            value: s.format(point.value),
          },
        ]
      : []
  })
})

/** Missing or single observations never become a substitute series or a fabricated line. */
const dataNote = computed(() => {
  if (denomination.value === 'gold' && columns.value.length === 0)
    return t('walletPanel.priceHistoryGoldUnavailable')
  if (!inputs.value) return t('walletPanel.chartNoteNoFeed')
  const drawn = columns.value
  if (drawn.length === 0)
    return sampleTimes.value.length > 0
      ? t('walletPanel.priceHistoryBenchmarkUnavailable', {
          benchmark: t(
            denomination.value === 'hash'
              ? 'walletPanel.priceHistoryHash'
              : 'walletPanel.priceHistorySpot',
          ),
        })
      : t('walletPanel.chartNoteNoTokenPrice', { symbol: unit.value.symbol })
  const parts = [
    t('walletPanel.priceHistoryCoverage', {
      count: drawn.length,
      first: drawn[0].label,
      last: drawn[drawn.length - 1].label,
      range:
        rangeToggleOptions.value.find(
          option => option.value === selectedRange.value,
        )?.label ?? '',
    }),
  ]
  if (drawn.length === 1) parts.push(t('walletPanel.priceHistorySinglePoint'))
  if (series.value.some(line => line.points.some(point => point.estimated)))
    parts.push(t('walletPanel.avuHashEstimated'))
  if (oracle.valuesAreTestnet) parts.push(t('walletPanel.chartNoteTestnet'))
  return parts.join(' ')
})

// While this chart is on screen, the oracle's local series are made to hold the range it
// shows: the feed is asked only for the stretches they lack. Nothing is drawn until real
// data is there.
useOracleHistory(
  () => {
    const range = timeRange.value
    const window = zoom.value
    if (!window) return { since: rangeStart.value, step: range.step }
    const span = window.max - window.min
    const resolution = Object.values(RANGES)
      .filter(candidate => candidate.span >= span)
      .reduce((step, candidate) => Math.min(step, candidate.step), range.step)
    return { since: window.min, until: window.max, step: resolution }
  },
  feeds => {
    if (zoom.value) detailedHistory.value = feeds
  },
)

// A newly collected coin can have its whole history in one monthly bucket. Keep the
// full-range request above and also ask for recent observations at hourly resolution.
// 30 days is at most 720 steps, within the feed's range bound. No timestamp is invented.
useOracleHistory(() =>
  timeRange.value.step > 3600 && !zoom.value
    ? {
        since: Math.max(
          rangeStart.value,
          Math.floor(Date.now() / 1000) - 30 * DAY,
        ),
        step: 3600,
      }
    : null,
)
</script>

<style scoped>
.avu-parity-chart,
.chart-canvas-card,
.chart-container,
.price-history-header,
.timeframe-controls-section {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.price-history-header,
.inspection-cell,
[data-test='chart-data-note'],
[data-test='price-history-source'] {
  overflow-wrap: anywhere;
}
.chart-canvas-card {
  border-radius: 8px;
}
.chart-container {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  column-gap: 8px;
}
.chart-scale {
  display: grid;
  min-width: 5.5em;
  font-size: 12px;
  line-height: 1.2;
}
.chart-scale-bounds {
  grid-row: 2;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  white-space: nowrap;
}
.chart-svg {
  width: 100%;
  height: auto;
  display: block;
}
.timeframe-pill-track {
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  padding: 2px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.05);
}
.timeframe-btn-toggle {
  flex-wrap: wrap;
  max-width: 100%;
}
.denomination-controls {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  padding: 2px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.05);
}
.denomination-controls :deep(.q-btn) {
  font-size: 11.5px;
  padding: 4px 10px;
  min-height: 28px;
  border-radius: 8px;
}
.denomination-controls :deep(.q-btn-toggle) {
  flex-wrap: wrap;
  max-width: 100%;
}
.timeframe-btn-toggle :deep(.q-btn) {
  font-size: 11.5px;
  padding: 4px 10px;
  min-height: 28px;
}
.inspection-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.inspection-cell {
  min-width: 0;
  padding: 4px 6px;
}
@media (max-width: 360px) {
  .inspection-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.chart-svg {
  touch-action: none;
}

.unselectable {
  user-select: none;
}
.cursor-crosshair {
  cursor: crosshair;
}
</style>
