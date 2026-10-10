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
              :stroke="themeColors.grid"
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
        <div>• {{ $t('walletPanel.sourceUnit') }}</div>
        <div>• {{ $t('walletPanel.sourceFeeds') }}</div>
        <div>• {{ $t('walletPanel.sourceHistorical') }}</div>
        <div>
          •
          {{
            $t('walletPanel.sourceGrid', {
              electricity: HISTORICAL_SOURCES.centsPerKwh,
              gold: HISTORICAL_SOURCES.goldUsd,
            })
          }}
        </div>
        <div>
          •
          {{
            $t('walletPanel.sourceHash', {
              chain: BTC_MINING_SOURCES.chain,
              subsidy: BTC_MINING_SOURCES.subsidy,
            })
          }}
        </div>
        <div data-test="source-efficiency">
          •
          {{
            $t('walletPanel.sourceEfficiency', {
              efficiency: BTC_MINING_SOURCES.efficiency,
              retrieved: BTC_MINING_SOURCES.retrieved,
            })
          }}
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
import { UNIT_RATE_ASSET_METRICS } from 'src/utils/avu-units'
import { useTranslate } from 'src/composables/useTranslate'
import {
  ASSET_FEED_SYMBOLS,
  BITCOIN_ENTRY_ID,
  BTC_MINING_SOURCES,
  BTC_MONTHLY_AVU_HASH,
  HISTORICAL_SOURCES,
  US_ANNUAL_ELECTRICITY_AND_GOLD,
  US_MONTHLY_INDUSTRIAL_ELECTRICITY,
  avuPerCoin,
  kwhPerDollar,
  latestAvuSpot,
  type HistoryRange,
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
        usd: '#38bdf8',
        hash: '#4ade80',
        gold: '#f59e0b',
        token: '#c084fc',
        grid: '#334155',
        axis: '#64748b',
        text: '#94a3b8',
        textPrimary: '#f8fafc',
        barBase: '#0284c7',
      }
    : {
        usd: '#0284c7',
        hash: '#16a34a',
        gold: '#d97706',
        token: '#7c3aed',
        grid: '#e2e8f0',
        axis: '#94a3b8',
        text: '#64748b',
        textPrimary: '#0f172a',
        barBase: '#38bdf8',
      },
)

export type TimeRange = 'all' | '5y' | HistoryRange | 'networks'
const FETCHED_RANGES: readonly HistoryRange[] = ['1y', '30d', '7d', '24h']
const selectedRange = ref<TimeRange>('all')
const fetchedRange = computed<HistoryRange | null>(() =>
  (FETCHED_RANGES as readonly string[]).includes(selectedRange.value)
    ? (selectedRange.value as HistoryRange)
    : null,
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
const hasPriceSource = computed(() => Boolean(ASSET_FEED_SYMBOLS[asset.value]))

function formatNumber(value: number, digits = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Enough digits to tell neighbouring values apart, whatever the coin's scale. */
function formatAvuValue(value: number): string {
  if (value >= 1000) return formatNumber(value, 1)
  if (value >= 1) return formatNumber(value, 2)
  return value.toPrecision(3)
}

// ---- AVU_hash and AVU_spot ---------------------------------------------------------------

/** kWh per dollar read off mining, with the basket entries it was computed from. */
const avuHash = computed(() => oracle.snapshot?.avuHash)
/** kWh per dollar at the latest published electricity price. */
const avuSpot = latestAvuSpot()

const miningRows = computed(() => {
  const entries = avuHash.value?.entries ?? []
  const bitcoin = entries.find(entry => entry.id === BITCOIN_ENTRY_ID)
  return entries.map(entry => ({
    ...entry,
    // Against Bitcoin's dollars per kWh. Entries on one algorithm share an efficiency
    // figure, so between them this ratio does not depend on it.
    spreadPercent:
      bitcoin && entry.id !== BITCOIN_ENTRY_ID
        ? (entry.dollarsPerKwh / bitcoin.dollarsPerKwh - 1) * 100
        : undefined,
  }))
})

function formatSpread(percent: number): string {
  return `${percent >= 0 ? '+' : ''}${formatNumber(percent, 1)}%`
}

const LEFT_OUT_REASON_KEYS = {
  efficiency: 'walletPanel.avuHashLeftOutEfficiency',
  price: 'walletPanel.avuHashLeftOutPrice',
  chain: 'walletPanel.avuHashLeftOutChain',
} as const

function formatWeight(weight: number): string {
  return `${formatNumber(weight * 100, weight < 0.1 ? 1 : 0)}%`
}

/** Which basket entries AVU_hash used and with what weight, which it left out, and its age. */
const avuHashNote = computed(() => {
  const current = avuHash.value
  if (!current) return t('walletPanel.avuHashUnavailableNote')
  const parts = [
    t('walletPanel.avuHashNote', {
      used: current.entries.length,
      total: current.basketSize,
      weights: current.entries
        .map(entry => `${entry.label} ${formatWeight(entry.weight)}`)
        .join(', '),
      month: current.efficiencyMonth,
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
  const staleAge = oracle.avuHashStaleAgeMs?.()
  if (staleAge !== undefined) {
    parts.push(t('walletPanel.avuHashStale', { age: formatAge(staleAge) }))
  }
  return parts.join(' ')
})

const networkBars = computed(() => {
  const rows = miningRows.value
  const top = Math.max(...rows.map(r => r.dollarsPerKwh), 0)
  const step = 520 / Math.max(rows.length, 1)
  return rows.map((row, index) => {
    const height = top > 0 ? (row.dollarsPerKwh / top) * 170 : 0
    return {
      ...row,
      name: `${row.label} · ${formatWeight(row.weight)}`,
      x: 90 + index * step + (step - 60) / 2,
      y: 230 - height,
      width: 60,
      height,
      costLabel: `$${formatNumber(row.dollarsPerKwh, 3)}/kWh`,
      spreadLabel:
        row.spreadPercent === undefined
          ? t('walletPanel.miningBaseline')
          : formatSpread(row.spreadPercent),
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
  const price = oracle.snapshot?.prices?.[asset.value]
  const age = oracle.priceAgeMs?.(asset.value)
  const hash = avuHash.value
  const rateLine = oracle.formatUnitRate?.(asset.value) ?? ''
  let rateNote = t('walletPanel.avuNoPriceSource')
  if (rateLine && price !== undefined && age !== undefined) {
    rateNote = t(
      age > STALE_AFTER_MS
        ? 'walletPanel.avuPriceStaleNote'
        : 'walletPanel.avuPriceFreshNote',
      { usd: `$${price.toPrecision(6)}`, age: formatAge(age) },
    )
    const sources = oracle.snapshot?.priceSources?.[asset.value]
    if (sources !== undefined) {
      rateNote += ` ${
        sources > 1
          ? t('walletPanel.avuPriceSources', { count: sources })
          : t('walletPanel.avuPriceSingleSource')
      }`
    }
  } else if (price !== undefined && !hash) {
    rateNote = t('walletPanel.avuHashUnavailableNote')
  } else if (hasPriceSource.value) {
    rateNote = t('walletPanel.avuPriceNotFetched')
  }

  const ecash = miningRows.value.find(row => row.id === 'ecash')

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
      value: hash ? `${formatNumber(hash.kwhPerDollar, 2)} kWh/$` : '',
      note: avuHashNote.value,
    },
    {
      id: 'avu-spot',
      label: t('walletPanel.avuSpotLabel'),
      icon: 'bolt',
      color: 'amber-9',
      value: avuSpot ? `${formatNumber(avuSpot.kwhPerDollar, 2)} kWh/$` : '',
      note: avuSpot
        ? t('walletPanel.avuSpotNote', {
            cents: avuSpot.centsPerKwh,
            month: avuSpot.month,
          })
        : '',
    },
    {
      id: 'hash-vs-spot',
      label: t('walletPanel.avuHashVsSpotLabel'),
      icon: 'compare_arrows',
      color: 'primary',
      value:
        hash && avuSpot
          ? formatSpread((hash.kwhPerDollar / avuSpot.kwhPerDollar - 1) * 100)
          : '',
      note: t('walletPanel.avuHashVsSpotNote'),
    },
    {
      id: 'avu-unit',
      label: t('walletPanel.avuUnitLabel'),
      icon: 'straighten',
      color: 'primary',
      // One kWh in dollars as mining prices it: the inverse of AVU_hash.
      value: hash ? `1 AVU = $${formatNumber(1 / hash.kwhPerDollar, 4)}` : '',
      note: t('walletPanel.avuUnitNote'),
    },
    {
      id: 'arbitrage',
      label: t('walletPanel.arbitrageMargin'),
      icon: 'trending_up',
      color: 'secondary',
      value:
        ecash?.spreadPercent === undefined
          ? ''
          : formatSpread(ecash.spreadPercent),
      note: t('walletPanel.arbitrageNote'),
    },
  ]
})

// ---- Lines ------------------------------------------------------------------------------

interface DataPoint {
  /** Position along the time axis: a year, or a Unix time in milliseconds. */
  at: number
  value: number
}

interface Series {
  id: 'usd' | 'hash' | 'gold' | 'token'
  label: string
  color: string
  axis: 'left' | 'right'
  /** Series with the same scale are drawn against one shared axis, so they compare. */
  scale: 'kwhPerDollar' | 'gold' | 'token'
  format: (value: number) => string
  points: DataPoint[]
}

const longRangePoints = computed(() => {
  const lastYear =
    US_ANNUAL_ELECTRICITY_AND_GOLD[US_ANNUAL_ELECTRICITY_AND_GOLD.length - 1]
      .year
  const firstYear = selectedRange.value === '5y' ? lastYear - 4 : -Infinity
  return US_ANNUAL_ELECTRICITY_AND_GOLD.filter(p => p.year >= firstYear)
})

/**
 * AVU_hash for each calendar year the bundled months cover completely: the mean of that
 * year's twelve monthly values. Bitcoin only.
 */
const annualAvuHash = (() => {
  const byYear = new Map<number, number[]>()
  for (const month of BTC_MONTHLY_AVU_HASH) {
    const year = Number(month.month.slice(0, 4))
    byYear.set(year, [...(byYear.get(year) ?? []), month.kwhPerDollar])
  }
  return Array.from(byYear.entries())
    .filter(([, values]) => values.length === 12)
    .map(([year, values]) => ({
      year,
      kwhPerDollar: values.reduce((sum, v) => sum + v, 0) / 12,
    }))
})()

function monthMidpoint(month: string): number {
  return Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 15)
}

const tokenHistory = computed(() =>
  fetchedRange.value
    ? oracle.historyFor?.(asset.value, fetchedRange.value) ?? null
    : null,
)

const rangeSeries = computed<Series[]>(() => {
  if (selectedRange.value === 'networks') return []

  if (!fetchedRange.value) {
    const annual = longRangePoints.value
    return [
      {
        id: 'usd',
        label: t('walletPanel.chartUsdKwh'),
        color: themeColors.value.usd,
        axis: 'left',
        scale: 'kwhPerDollar',
        format: value => `${formatNumber(value, 1)} kWh/$`,
        points: annual.map(p => ({
          at: p.year,
          value: kwhPerDollar(p.centsPerKwh),
        })),
      },
      {
        id: 'hash',
        label: t('walletPanel.chartHashKwh'),
        color: themeColors.value.hash,
        axis: 'left',
        scale: 'kwhPerDollar',
        format: value => `${formatNumber(value, 1)} kWh/$`,
        points: annualAvuHash
          .filter(p => p.year >= annual[0].year)
          .map(p => ({ at: p.year, value: p.kwhPerDollar })),
      },
      {
        id: 'gold',
        label: t('walletPanel.chartGoldAvu'),
        color: themeColors.value.gold,
        axis: 'right',
        scale: 'gold',
        format: value => `${formatNumber(value, 0)} kWh/oz`,
        // A year without a published gold price has no gold point.
        points: annual.flatMap(p =>
          p.goldUsd === undefined
            ? []
            : [{ at: p.year, value: p.goldUsd * kwhPerDollar(p.centsPerKwh) }],
        ),
      },
    ]
  }

  // The bundled monthly electricity prices reach into the last year; no shorter range has
  // any. Gold has no history here finer than a year, so it has no line on these ranges.
  const oldest = Date.now() - 366 * 24 * 3_600_000
  const lastYear = (months: readonly { month: string; value: number }[]) =>
    fetchedRange.value === '1y'
      ? months.flatMap(m => {
          const at = monthMidpoint(m.month)
          return at >= oldest ? [{ at, value: m.value }] : []
        })
      : []
  const monthlyGrid = lastYear(
    US_MONTHLY_INDUSTRIAL_ELECTRICITY.map(m => ({
      month: m.month,
      value: kwhPerDollar(m.centsPerKwh),
    })),
  )
  const monthlyHash = lastYear(
    BTC_MONTHLY_AVU_HASH.map(m => ({ month: m.month, value: m.kwhPerDollar })),
  )
  const hash = avuHash.value

  return [
    {
      id: 'usd' as const,
      label: t('walletPanel.chartUsdKwh'),
      color: themeColors.value.usd,
      axis: 'right' as const,
      scale: 'kwhPerDollar' as const,
      format: (value: number) => `${formatNumber(value, 1)} kWh/$`,
      points: monthlyGrid,
    },
    {
      id: 'hash' as const,
      label: t('walletPanel.chartHashKwh'),
      color: themeColors.value.hash,
      axis: 'right' as const,
      scale: 'kwhPerDollar' as const,
      format: (value: number) => `${formatNumber(value, 1)} kWh/$`,
      points: monthlyHash,
    },
    {
      id: 'token',
      label: `${unit.value.symbol} (AVU)`,
      color: themeColors.value.token,
      axis: 'left',
      scale: 'token',
      format: value => `${formatAvuValue(value)} AVU`,
      // Each point is a price a provider published (or this app fetched) times the
      // current AVU_hash. Without AVU_hash there is no AVU value and so no point.
      points: (tokenHistory.value?.points ?? []).flatMap(p => {
        const value = avuPerCoin(p.price, hash)
        return value === undefined
          ? []
          : [{ at: p.timestamp, value: value * unit.value.multiplier }]
      }),
    },
  ]
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
  if (!fetchedRange.value) return String(at)
  const date = new Date(at)
  return fetchedRange.value === '24h'
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(fetchedRange.value === '1y' ? { year: '2-digit' } : {}),
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
      // One scale for every series measured in the same unit.
      const values = series.value
        .filter(other => other.scale === s.scale)
        .flatMap(other => other.points.map(p => p.value))
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
      value: `$${formatNumber(row.dollarsPerKwh, 3)}/kWh`,
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

/** Says what is drawn, from where, and when that is little or nothing. */
const dataNote = computed(() => {
  if (selectedRange.value === 'networks') {
    return avuHash.value
      ? t('walletPanel.chartNoteNetworks', {
          month: avuHash.value.efficiencyMonth,
        })
      : t('walletPanel.chartNoteNetworksUnavailable')
  }
  if (!fetchedRange.value) {
    const years = longRangePoints.value
    const hashYears = annualAvuHash.filter(p => p.year >= years[0].year)
    return [
      t('walletPanel.chartNoteAnnual', {
        from: years[0].year,
        to: years[years.length - 1].year,
      }),
      hashYears.length > 0
        ? t('walletPanel.chartNoteAnnualHash', {
            from: hashYears[0].year,
            to: hashYears[hashYears.length - 1].year,
          })
        : '',
    ]
      .filter(Boolean)
      .join(' ')
  }
  if (!hasPriceSource.value) {
    return t('walletPanel.chartNoteNoSource', { symbol: unit.value.symbol })
  }
  const history = tokenHistory.value
  const count = history?.points.length ?? 0
  if (!history || count === 0) {
    return t('walletPanel.chartNoteNoHistory', { symbol: unit.value.symbol })
  }
  if (!avuHash.value) return t('walletPanel.chartNoteNoHash')
  const first = formatAt(history.points[0].timestamp)
  const note =
    history.source === 'observed'
      ? t('walletPanel.chartNoteObserved', { count, first })
      : t('walletPanel.chartNoteProvider', {
          count,
          first,
          provider: history.source ?? '',
        })
  const testnet = oracle.balanceHasMarketValue?.(asset.value)
    ? ''
    : ` ${t('walletPanel.chartNoteMainnetPrice')}`
  const currentHash = t('walletPanel.chartNoteCurrentHash', {
    rate: formatNumber(avuHash.value.kwhPerDollar, 2),
  })
  return `${note} ${currentHash}${testnet}`
})

// Fetch what the open view needs. Nothing is drawn until real data arrives.
watch(
  [asset, fetchedRange],
  ([currentAsset, range]) => {
    if (range) void oracle.loadHistory?.(currentAsset, range)
  },
  { immediate: true },
)
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
