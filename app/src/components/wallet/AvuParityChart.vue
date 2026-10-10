<template>
  <div class="avu-parity-chart q-pa-sm" data-test="avu-parity-chart">
    <!-- Figures: each is fetched, read from a bundled published table, or the stated unit -->
    <div class="metric-cards-grid q-mb-md">
      <div
        v-for="tile in tiles"
        :key="tile.id"
        class="metric-card-wrapper"
        :class="{ 'metric-card-featured': tile.featured }"
      >
        <q-card
          bordered
          flat
          class="metric-card full-height"
          :class="cardBgClass"
          :data-test="`metric-card-${tile.id}`"
        >
          <q-card-section class="q-pa-sm">
            <div class="row items-center justify-between no-wrap">
              <span
                class="text-caption text-weight-medium text-grey-7 ellipsis"
              >
                {{ tile.label }}
              </span>
              <q-icon :name="tile.icon" :color="tile.color" size="18px" />
            </div>
            <div
              class="text-h6 text-weight-bolder q-mt-xs"
              :class="tile.value ? `text-${tile.color}` : 'text-grey-6'"
              :data-test="`metric-value-${tile.id}`"
            >
              {{ tile.value || $t('walletPanel.avuUnavailable') }}
            </div>
            <div class="text-caption text-grey-6 text-weight-regular">
              {{ tile.note }}
            </div>
          </q-card-section>
        </q-card>
      </div>
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

      <div
        v-if="legend.length > 0"
        class="asset-filter-chips-row row items-center q-gutter-xs q-mt-sm"
      >
        <div
          v-for="entry in legend"
          :key="entry.id"
          class="asset-chip asset-chip--active"
          :style="{
            borderColor: `${entry.color}55`,
            backgroundColor: `${entry.color}18`,
            color: entry.color,
          }"
          :data-test="`chart-legend-${entry.id}`"
        >
          <span class="legend-dot" :style="{ backgroundColor: entry.color }" />
          <span class="text-weight-medium">{{ entry.label }}</span>
        </div>
      </div>
    </div>

    <q-card
      bordered
      flat
      class="chart-canvas-card q-pa-sm"
      :class="cardBgClass"
    >
      <!-- What the drawn points are and where they came from; says so when there are few or none -->
      <div
        class="text-caption text-grey-7 q-px-sm q-pb-xs"
        data-test="chart-data-note"
      >
        {{ dataNote }}
      </div>

      <div
        class="chart-inspection-panel q-pa-sm q-mb-xs rounded-borders"
        :class="isDark ? 'bg-dark-1' : 'bg-grey-1'"
        data-test="chart-inspection-table"
      >
        <div
          class="inspection-grid row items-center justify-between q-col-gutter-xs text-center"
        >
          <div class="col inspection-cell" data-test="inspection-date">
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
            class="col inspection-cell"
            :data-test="`inspection-cell-${cell.id}`"
          >
            <div class="text-caption text-grey-7 text-weight-medium ellipsis">
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

      <!-- Lines: one circle per real data point, joined in order. No point is computed between them. -->
      <div
        v-if="selectedRange !== 'networks'"
        class="chart-container"
        data-test="macro-chart-container"
      >
        <svg
          class="chart-svg cursor-crosshair"
          viewBox="0 0 680 290"
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
            <text
              :x="line.axis === 'left' ? 50 : 630"
              y="35"
              font-size="10"
              :text-anchor="line.axis === 'left' ? 'end' : 'start'"
              :fill="line.color"
            >
              {{ line.maxLabel }}
            </text>
            <text
              :x="line.axis === 'left' ? 50 : 630"
              y="230"
              font-size="10"
              :text-anchor="line.axis === 'left' ? 'end' : 'start'"
              :fill="line.color"
            >
              {{ line.minLabel }}
            </text>
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
            @mousedown.prevent="dragFrom = column"
            @mouseup="finishDrag(column)"
          >
            <rect
              :x="column.x - columnHitWidth / 2"
              y="20"
              :width="columnHitWidth"
              height="210"
              fill="transparent"
              pointer-events="all"
            />
            <text
              v-if="column.tick"
              :x="column.x"
              y="248"
              font-size="11"
              text-anchor="middle"
              :fill="themeColors.text"
              class="unselectable"
            >
              {{ column.tick }}
            </text>
          </g>
        </svg>
      </div>

      <!-- Dollars per kWh of mining for each basket entry AVU_hash was computed from -->
      <div v-else class="chart-container" data-test="networks-chart-container">
        <svg
          class="chart-svg"
          viewBox="0 0 680 280"
          preserveAspectRatio="xMidYMid meet"
          data-test="networks-chart-svg"
        >
          <line
            x1="55"
            y1="230"
            x2="625"
            y2="230"
            :stroke="themeColors.axis"
            stroke-width="1.5"
          />
          <g
            v-for="bar in networkBars"
            :key="bar.id"
            class="bar-group"
            data-test="chart-hover-bar"
          >
            <rect
              :x="bar.x"
              :y="bar.y"
              :width="bar.width"
              :height="bar.height"
              rx="5"
              :fill="themeColors.barBase"
              opacity="0.85"
            />
            <text
              :x="bar.x + bar.width / 2"
              :y="bar.y - 8"
              font-size="11"
              font-weight="bold"
              text-anchor="middle"
              :fill="themeColors.textPrimary"
            >
              {{ bar.costLabel }}
            </text>
            <text
              :x="bar.x + bar.width / 2"
              y="248"
              font-size="12"
              font-weight="bold"
              text-anchor="middle"
              :fill="themeColors.textPrimary"
            >
              {{ bar.name }}
            </text>
            <text
              :x="bar.x + bar.width / 2"
              y="264"
              font-size="10"
              text-anchor="middle"
              :fill="themeColors.text"
            >
              {{ bar.spreadLabel }}
            </text>
          </g>
        </svg>
      </div>
    </q-card>

    <q-card
      bordered
      flat
      class="q-mt-sm q-pa-sm"
      :class="cardBgClass"
      data-test="chart-sources"
    >
      <div
        class="row items-center q-gutter-xs text-weight-bold text-caption text-primary q-mb-xs"
      >
        <q-icon name="menu_book" size="16px" />
        <span>{{ $t('walletPanel.sourcesTitle') }}</span>
      </div>
      <div class="text-caption text-grey-7 q-gutter-y-xs">
        <div
          v-for="line in sourceLines"
          :key="line.id"
          :data-test="`source-${line.id}`"
        >
          • {{ line.text }}
        </div>
      </div>
    </q-card>
  </div>
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
  ELECTRICITY_AGGREGATE,
  MINER_SHARE_STEPS,
  US_ANNUAL_ELECTRICITY_AND_GOLD,
  at as valueAt,
  avuHashAt,
  avuPerCoin,
  avuSpotAt,
  priceAssetId,
  seriesName,
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
        gold: '#f59e0b',
        token: '#c084fc',
        gridLines: '#334155',
        axis: '#64748b',
        text: '#94a3b8',
        textPrimary: '#f8fafc',
        barBase: '#0284c7',
      }
    : {
        grid: '#0284c7',
        gold: '#d97706',
        token: '#7c3aed',
        gridLines: '#e2e8f0',
        axis: '#94a3b8',
        text: '#64748b',
        textPrimary: '#0f172a',
        barBase: '#38bdf8',
      },
)

const DAY = 86_400
/** How far back each range reaches and how fine its points are, in seconds. */
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

export type TimeRange = keyof typeof RANGES | 'networks'
const selectedRange = ref<TimeRange>('all')
const timeRange = computed(() =>
  selectedRange.value === 'networks' ? null : RANGES[selectedRange.value],
)

const rangeToggleOptions = computed(() => [
  { label: t('walletPanel.rangeAll'), value: 'all' },
  { label: t('walletPanel.range5Y'), value: '5y' },
  { label: t('walletPanel.range1Y'), value: '1y' },
  { label: t('walletPanel.range30D'), value: '30d' },
  { label: t('walletPanel.range7D'), value: '7d' },
  { label: t('walletPanel.range24H'), value: '24h' },
  { label: t('walletPanel.rangeNetworks'), value: 'networks' },
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

function formatNumber(value: number, digits = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function formatSpread(percent: number): string {
  return `${percent >= 0 ? '+' : ''}${formatNumber(percent, 1)}%`
}

function formatWeight(weight: number): string {
  return `${formatNumber(weight * 100, weight < 0.1 ? 1 : 0)}%`
}

/** "9 Oct 2026": a day of a daily series (they are stamped in UTC). */
function formatDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// ---- AVU_hash and AVU_spot, now -----------------------------------------------------------

const inputs = computed<OracleInputs | undefined>(() => oracle.inputs)
/** Energy per unit of value read off mining, with the basket entries it was computed from. */
const avuHash = computed(() => oracle.current?.avuHash)
/** Energy per unit of value at the mean wholesale electricity price. */
const avuSpot = computed(() => oracle.current?.avuSpot)

/**
 * What a kWh of wholesale electricity costs, in AVU: its price times AVU_hash, which is
 * AVU_hash divided by AVU_spot. At 1 the two readings agree: mining pays for a kWh
 * exactly what the grid charges for one. Stated without any currency.
 */
function gridKwhInAvu(
  hash: { kwhPerValue: number } | undefined,
  spot: { kwhPerValue?: number } | undefined,
): number | undefined {
  return hash && spot?.kwhPerValue
    ? hash.kwhPerValue / spot.kwhPerValue
    : undefined
}

const miningRows = computed(() => {
  const hash = avuHash.value
  return (hash?.entries ?? []).map(entry => {
    // AVU a kWh of this entry's mining earns: its pay per kWh priced by the basket.
    const avuPerKwh = entry.valuePerKwh * hash!.kwhPerValue
    return {
      ...entry,
      avuPerKwh,
      // Against the basket: 1 AVU per kWh is the basket's own (weighted harmonic) pay.
      spreadPercent: (avuPerKwh - 1) * 100,
    }
  })
})

const LEFT_OUT_REASON_KEYS = {
  efficiency: 'walletPanel.avuHashLeftOutEfficiency',
  price: 'walletPanel.avuHashLeftOutPrice',
  chain: 'walletPanel.avuHashLeftOutChain',
} as const

/** Which basket entries AVU_hash used and with what weight, which it left out, and its age. */
const basketNote = computed(() => {
  const current = avuHash.value
  if (!current) return t('walletPanel.avuHashUnavailableNote')
  const parts = [
    t('walletPanel.avuHashNote', {
      weights: current.entries
        .map(entry => `${entry.label} ${formatWeight(entry.weight)}`)
        .join(', '),
    }),
  ]
  if (current.leftOut.length > 0) {
    parts.push(
      t('walletPanel.avuHashLeftOut', {
        coins: current.leftOut
          .map(
            entry =>
              `${entry.label} (${t(LEFT_OUT_REASON_KEYS[entry.reason])})`,
          )
          .join(', '),
      }),
    )
  }
  if (current.entries.some(entry => entry.estimated)) {
    parts.push(t('walletPanel.avuHashEstimated'))
  }
  const staleAge = oracle.avuHashStaleAgeMs?.()
  if (staleAge !== undefined) {
    parts.push(t('walletPanel.avuHashStale', { age: formatAge(staleAge) }))
  }
  return parts.join(' ')
})

const networkBars = computed(() => {
  const rows = miningRows.value
  const top = Math.max(...rows.map(r => r.avuPerKwh), 0)
  const step = 520 / Math.max(rows.length, 1)
  return rows.map((row, index) => {
    const height = top > 0 ? (row.avuPerKwh / top) * 170 : 0
    return {
      ...row,
      name: `${row.label} · ${formatWeight(row.weight)}`,
      x: 90 + index * step + (step - 60) / 2,
      y: 230 - height,
      width: 60,
      height,
      costLabel: `${formatNumber(row.avuPerKwh, 2)} AVU/kWh`,
      spreadLabel: formatSpread(row.spreadPercent),
    }
  })
})

// ---- Figures ---------------------------------------------------------------------------

interface Tile {
  id: string
  label: string
  icon: string
  color: string
  /** Empty when the figure is unavailable; the tile then says so. */
  value: string
  note: string
  featured?: boolean
}

const tiles = computed<Tile[]>(() => {
  const age = oracle.priceAgeMs?.(asset.value)
  const hash = avuHash.value
  const spot = avuSpot.value
  const rateLine = oracle.formatUnitRate?.(asset.value) ?? ''
  let rateNote = t('walletPanel.avuNoPrice')
  if (rateLine && age !== undefined) {
    rateNote = t(
      age > STALE_AFTER_MS
        ? 'walletPanel.avuPriceStaleNote'
        : 'walletPanel.avuPriceFreshNote',
      { age: formatAge(age) },
    )
  } else if (!hash) {
    rateNote = t('walletPanel.avuHashUnavailableNote')
  }

  const grid = gridKwhInAvu(hash, spot)
  let spotNote = ''
  if (spot?.kwhPerValue && spot.at !== undefined) {
    const electricity = inputs.value?.electricity
    const priceDay = spot.at
    const regions = electricity?.regions ?? []
    // A region counts in the figure when the feed says it counted in that day's price.
    const counted = regions.filter(
      region => region.lastContributed === priceDay,
    )
    const dropped = regions.filter(
      region => region.lastContributed !== priceDay,
    )
    spotNote = t('walletPanel.avuSpotNote', {
      window: electricity?.windowDays ?? '',
      latest: formatDay(priceDay),
      regions: counted.map(region => region.label).join('; '),
    })
    if (dropped.length > 0) {
      spotNote += ` ${t('walletPanel.avuSpotRegionsLeftOut', {
        regions: dropped
          .map(region =>
            region.lastContributed === undefined
              ? region.label
              : t('walletPanel.avuSpotRegionLast', {
                  region: region.label,
                  day: formatDay(region.lastContributed),
                }),
          )
          .join('; '),
      })}`
    }
    const spotAge = Date.now() - priceDay * 1000
    if (spot.stale || spotAge > 3 * DAY * 1000) {
      spotNote += ` ${t('walletPanel.avuSpotStale', {
        age: formatAge(spotAge),
      })}`
    }
  } else if (spot?.unavailable) {
    spotNote = t(
      spot.unavailable === 'not-positive'
        ? 'walletPanel.avuSpotNotPositive'
        : 'walletPanel.avuSpotNoData',
    )
  }
  // What a kWh of mining earns against what a kWh costs at wholesale.
  const miningVsGrid = grid === undefined ? undefined : (1 / grid - 1) * 100

  return [
    {
      id: 'token-rate',
      label: t('walletPanel.activeTokenCardTitle', {
        symbol: unit.value.symbol,
      }),
      icon: 'bolt',
      color: 'purple-7',
      value: rateLine,
      note: rateNote,
      featured: true,
    },
    {
      id: 'avu-hash',
      label: t('walletPanel.avuHashLabel'),
      icon: 'memory',
      color: 'positive',
      value: hash
        ? t('walletPanel.avuHashValue', {
            used: hash.entries.length,
            total: hash.basketSize,
          })
        : '',
      note: basketNote.value,
    },
    {
      id: 'avu-spot',
      label: t('walletPanel.avuSpotLabel'),
      icon: 'bolt',
      color: 'amber-9',
      value:
        grid === undefined
          ? ''
          : t('walletPanel.avuSpotValue', { avu: formatNumber(grid, 2) }),
      note: spotNote,
    },
    {
      id: 'hash-vs-spot',
      label: t('walletPanel.avuHashVsSpotLabel'),
      icon: 'compare_arrows',
      color: 'primary',
      value: miningVsGrid === undefined ? '' : formatSpread(miningVsGrid),
      note:
        miningVsGrid === undefined
          ? t('walletPanel.avuHashVsSpotNote')
          : t(
              miningVsGrid < 0
                ? 'walletPanel.avuHashVsSpotLess'
                : 'walletPanel.avuHashVsSpotMore',
              { percent: formatNumber(Math.abs(miningVsGrid), 0) },
            ),
    },
    {
      id: 'avu-unit',
      label: t('walletPanel.avuUnitLabel'),
      icon: 'straighten',
      color: 'primary',
      value: t('walletPanel.avuUnitValue'),
      note: t('walletPanel.avuUnitNote'),
    },
  ]
})

// ---- Lines ------------------------------------------------------------------------------

interface DataPoint {
  /** Unix seconds. */
  at: number
  value: number
}

interface Series {
  id: 'grid' | 'gold' | 'token'
  label: string
  color: string
  axis: 'left' | 'right'
  format: (value: number) => string
  points: DataPoint[]
}

/**
 * The times the lines are evaluated at: the times of the points the local series actually
 * hold inside the range (the selected coin's price, the basket's prices, the electricity
 * price), the last one in each step of the range. Every line is the same functions that
 * give today's figures, evaluated at these times; no time is made up between them.
 */
const sampleTimes = computed<number[]>(() => {
  const feed = inputs.value
  const range = timeRange.value
  if (!feed || !range) return []
  const names = new Set<string>([ELECTRICITY_AGGREGATE])
  if (tokenPriceSeries.value) names.add(tokenPriceSeries.value)
  for (const entry of feed.basket.entries) {
    for (const chain of entry.chains)
      names.add(seriesName('price', chain.chain))
  }
  const now = Math.floor(Date.now() / 1000)
  const lastInStep = new Map<number, number>()
  names.forEach(name => {
    for (const point of feed.series[name]?.points ?? []) {
      if (point[0] < rangeStart.value || point[0] > now) continue
      const bucket = Math.floor(point[0] / range.step)
      if ((lastInStep.get(bucket) ?? -1) < point[0]) {
        lastInStep.set(bucket, point[0])
      }
    }
  })
  return Array.from(lastInStep.values()).sort((a, b) => a - b)
})

const rangeSeries = computed<Series[]>(() => {
  const feed = inputs.value
  if (!feed || selectedRange.value === 'networks') return []
  const grid: DataPoint[] = []
  const token: DataPoint[] = []
  for (const time of sampleTimes.value) {
    const hash = avuHashAt(feed, time)
    if (!hash) continue
    const kwh = gridKwhInAvu(hash, avuSpotAt(feed, time))
    if (kwh !== undefined) grid.push({ at: time, value: kwh })
    const price = valueAt(feed.series[tokenPriceSeries.value]?.points, time)
    const value = price ? avuPerCoin(price[1], hash) : undefined
    if (value !== undefined) {
      token.push({ at: time, value: value * unit.value.multiplier })
    }
  }
  const lines: Series[] = [
    {
      id: 'grid',
      label: t('walletPanel.chartGridAvu'),
      color: themeColors.value.grid,
      axis: 'left',
      format: value => `${formatNumber(value, 2)} AVU`,
      points: grid,
    },
    {
      id: 'token',
      label: `${unit.value.symbol} (AVU)`,
      color: themeColors.value.token,
      axis: 'right',
      format: value => formatAvu(value),
      points: token,
    },
  ]
  if (selectedRange.value === 'all' || selectedRange.value === '5y') {
    lines.push({
      id: 'gold',
      label: t('walletPanel.chartGoldAvu'),
      color: themeColors.value.gold,
      axis: 'right',
      format: value => `${formatAvu(value)}/oz`,
      // The published yearly gold price times AVU_hash at the middle of that year: an
      // ounce's AVU value, as any coin's. A year with no gold price or no AVU_hash has
      // no point.
      points: US_ANNUAL_ELECTRICITY_AND_GOLD.flatMap(year => {
        const middle = Date.UTC(year.year, 6, 1) / 1000
        if (year.goldUsd === undefined || middle < rangeStart.value) return []
        const value = avuPerCoin(year.goldUsd, avuHashAt(feed, middle))
        return value === undefined ? [] : [{ at: middle, value }]
      }),
    })
  }
  return lines
})

// Drag across the chart to zoom to that stretch. Zooming only hides points outside it.
const zoom = ref<{ min: number; max: number } | null>(null)
const series = computed<Series[]>(() => {
  const window = zoom.value
  if (!window) return rangeSeries.value
  return rangeSeries.value.map(s => ({
    ...s,
    points: s.points.filter(p => p.at >= window.min && p.at <= window.max),
  }))
})

const legend = computed(() => series.value.filter(s => s.points.length > 0))

function formatAt(at: number): string {
  const date = new Date(at * 1000)
  if (selectedRange.value === 'all' || selectedRange.value === '5y') {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric',
    })
  }
  return selectedRange.value === '24h'
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(selectedRange.value === '1y' ? { year: '2-digit' } : {}),
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
        // Two points make a line; one point is drawn as a point.
        path:
          points.length < 2
            ? ''
            : points
                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`)
                .join(' '),
        minLabel: s.format(min),
        maxLabel: s.format(max),
      }
    }),
)

interface Column {
  key: number
  x: number
  label: string
  tick: string
}

const columns = computed<Column[]>(() => {
  // Array.from, not spread: the app's build target does not iterate a Set by spreading.
  const positions = Array.from(
    new Set(series.value.flatMap(s => s.points.map(p => p.at))),
  ).sort((a, b) => a - b)
  const every = Math.max(1, Math.ceil(positions.length / 7))
  return positions.map((at, index) => ({
    key: at,
    x: Math.round(xOf(at) * 10) / 10,
    label: formatAt(at),
    tick:
      index % every === 0 || index === positions.length - 1 ? formatAt(at) : '',
  }))
})

const columnHitWidth = computed(() =>
  Math.max(4, (X_MAX - X_MIN) / Math.max(columns.value.length, 1)),
)

const hovered = ref<Column | null>(null)
const dragFrom = ref<Column | null>(null)
watch([selectedRange, asset], () => {
  hovered.value = null
  dragFrom.value = null
  zoom.value = null
})

const dragSelection = computed(() => {
  const from = dragFrom.value
  const to = hovered.value
  if (!from || !to || from.key === to.key) return null
  return { x: Math.min(from.x, to.x), width: Math.abs(to.x - from.x) }
})

function finishDrag(column: Column) {
  const from = dragFrom.value
  dragFrom.value = null
  if (!from || from.key === column.key) return
  zoom.value = {
    min: Math.min(from.key, column.key),
    max: Math.max(from.key, column.key),
  }
  hovered.value = null
}

function leaveChart() {
  hovered.value = null
  dragFrom.value = null
}

const inspected = computed<Column | null>(
  () => hovered.value ?? columns.value[columns.value.length - 1] ?? null,
)

const inspectedCells = computed(() => {
  if (selectedRange.value === 'networks') {
    return miningRows.value.map(row => ({
      id: row.id,
      label: row.label,
      color: themeColors.value.textPrimary,
      value: `${formatNumber(row.avuPerKwh, 2)} AVU/kWh`,
    }))
  }
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

/** Whether any point drawn rests on an efficiency figure that is an estimate. */
const drawsEstimates = computed(() => {
  const feed = inputs.value
  const first = sampleTimes.value[0]
  if (!feed || first === undefined) return false
  return feed.basket.entries.some(entry => {
    const one = feed.series[seriesName('efficiency', entry.algorithm)]
    const step = valueAt(one?.points, first)
    return (
      one?.estimatedBefore !== undefined &&
      step !== undefined &&
      step[0] < one.estimatedBefore
    )
  })
})

/** Says what is drawn, from where, and when that is little or nothing. */
const dataNote = computed(() => {
  if (selectedRange.value === 'networks') {
    return avuHash.value
      ? t('walletPanel.chartNoteNetworks')
      : t('walletPanel.chartNoteNetworksUnavailable')
  }
  if (!inputs.value) return t('walletPanel.chartNoteNoFeed')
  const drawn = columns.value
  if (drawn.length === 0) return t('walletPanel.chartNoteNoHistory')
  const parts = [
    t('walletPanel.chartNoteLines', {
      count: drawn.length,
      first: drawn[0].label,
    }),
  ]
  if (!legend.value.some(line => line.id === 'token')) {
    parts.push(
      t('walletPanel.chartNoteNoTokenPrice', { symbol: unit.value.symbol }),
    )
  }
  if (drawsEstimates.value) parts.push(t('walletPanel.chartNoteEstimated'))
  if (oracle.valuesAreTestnet) parts.push(t('walletPanel.chartNoteTestnet'))
  return parts.join(' ')
})

// ---- Sources ----------------------------------------------------------------------------

/** The eCash miner's share now and before, from the dated steps read off the chain. */
function ecashShareNote(): string {
  const steps = MINER_SHARE_STEPS['xec-mainnet'] ?? []
  const current = steps[steps.length - 1]
  const previous = steps[steps.length - 2]
  if (!current || !previous) return ''
  const percent = (share: number) => `${formatNumber(share * 100, 0)}%`
  return t('walletPanel.sourceEcashShare', {
    share: percent(current.share),
    previous: percent(previous.share),
    since: formatDay(Date.parse(`${current.from}T00:00:00Z`) / 1000),
  })
}

/** One line per kind of input, naming where the feed says its values come from. */
const sourceLines = computed(() => {
  const feed = inputs.value
  const labels = (kind: string) =>
    Array.from(
      new Set(
        Object.entries(feed?.series ?? {}).flatMap(([name, one]) =>
          name.startsWith(`${kind}/`) && one
            ? [(one as { source?: string }).source ?? '']
            : [],
        ),
      ),
    )
      .filter(Boolean)
      .join('; ')
  const lines = [{ id: 'unit', text: t('walletPanel.sourceUnit') }]
  if (!feed) return lines
  lines.push(
    {
      id: 'prices',
      text: t('walletPanel.sourcePrices', { sources: labels('price') }),
    },
    {
      id: 'chains',
      text: [
        t('walletPanel.sourceChains', { sources: labels('difficulty') }),
        ecashShareNote(),
      ]
        .filter(Boolean)
        .join(' '),
    },
    {
      id: 'efficiency',
      text: t('walletPanel.sourceEfficiency', {
        sources: labels('efficiency'),
      }),
    },
    {
      id: 'electricity',
      text: t('walletPanel.sourceElectricity', {
        sources: feed.electricity.regions
          .map(region => `${region.label} (${region.attribution})`)
          .join('; '),
      }),
    },
    { id: 'gold', text: t('walletPanel.sourceGold') },
  )
  return lines
})

// While this chart is on screen, the oracle's local series are made to hold the range it
// shows: the feed is asked only for the stretches they lack. Nothing is drawn until real
// data is there.
useOracleHistory(() => {
  const range = timeRange.value
  return range ? { since: rangeStart.value, step: range.step } : null
})
</script>

<style scoped>
.avu-parity-chart {
  width: 100%;
}

.metric-cards-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.metric-card-wrapper {
  display: flex;
}

.metric-card-featured {
  grid-column: span 2;
}

@media (max-width: 520px) {
  .metric-cards-grid {
    grid-template-columns: 1fr;
  }
  .metric-card-featured {
    grid-column: span 1;
  }
}

.metric-card {
  border-radius: 8px;
  width: 100%;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.metric-card:hover {
  transform: translateY(-1px);
}

.chart-canvas-card {
  border-radius: 8px;
  overflow: hidden;
}

.chart-container {
  width: 100%;
  position: relative;
}

.chart-svg {
  width: 100%;
  height: auto;
  display: block;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  transition: background-color 0.15s ease;
}

.legend-item {
  padding: 3px 8px;
  border-radius: 6px;
  transition: all 0.15s ease;
  user-select: none;
  border: 1px solid transparent;
}

.legend-item:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.body--dark .legend-item:hover {
  background-color: rgba(255, 255, 255, 0.08);
}

.legend-item--active {
  border-color: rgba(0, 0, 0, 0.06);
}

.body--dark .legend-item--active {
  border-color: rgba(255, 255, 255, 0.1);
}

.legend-item--inactive {
  opacity: 0.45;
}

.legend-item--inactive:hover {
  opacity: 0.75;
}

.timeframe-controls-section {
  width: 100%;
}

.timeframe-pill-track {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 10px;
  padding: 2px;
  display: inline-flex;
  align-items: center;
}

.body--dark .timeframe-pill-track {
  background: rgba(255, 255, 255, 0.08);
}

.timeframe-btn-toggle :deep(.q-btn) {
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 10px;
  min-height: 28px;
  border-radius: 8px;
  transition: all 0.15s ease;
}

.asset-filter-chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

.asset-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 16px;
  font-size: 11.5px;
  line-height: 1.2;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.03);
  color: #555;
  transition: all 0.15s ease;
  user-select: none;
}

.body--dark .asset-chip {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #bbb;
}

.asset-chip:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.06);
}

.asset-chip--inactive {
  opacity: 0.45;
  text-decoration: line-through;
  background: transparent !important;
  border-style: dashed !important;
  border-color: rgba(0, 0, 0, 0.15) !important;
}

.body--dark .asset-chip--inactive {
  border-color: rgba(255, 255, 255, 0.2) !important;
}

.chart-inspection-panel {
  border: 1px solid rgba(0, 0, 0, 0.06);
  transition: background-color 0.2s ease;
}

.body--dark .chart-inspection-panel {
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.inspection-grid {
  min-height: 48px;
}

.inspection-cell {
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.02);
  margin: 0 3px;
  transition: background-color 0.15s ease;
}

.body--dark .inspection-cell {
  background: rgba(255, 255, 255, 0.03);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.unselectable {
  user-select: none;
}

.cursor-crosshair {
  cursor: crosshair;
}

.chart-svg-tooltip {
  pointer-events: none;
  user-select: none;
}
</style>
