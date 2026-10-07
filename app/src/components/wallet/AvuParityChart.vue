<template>
  <div class="avu-parity-chart q-pa-sm" data-test="avu-parity-chart">
    <!-- Top Metrics Cards -->
    <div class="row q-col-gutter-sm q-mb-md">
      <!-- 1. AVU Hash -->
      <div class="col-12 col-sm-6 col-md-3">
        <q-card
          bordered
          flat
          class="metric-card"
          :class="cardBgClass"
          data-test="metric-card-avu-hash"
        >
          <q-card-section class="q-pa-sm">
            <div class="row items-center justify-between no-wrap">
              <span
                class="text-caption text-weight-medium text-grey-7 ellipsis"
              >
                {{ $t('walletPanel.avuHashLabel') }}
              </span>
              <q-icon name="memory" color="primary" size="18px" />
            </div>
            <div class="text-h6 text-weight-bolder text-primary q-mt-xs">
              {{ avuHashDisplay }}
            </div>
            <div class="text-caption text-grey-6 text-weight-regular ellipsis">
              {{ avuHashSubtext }}
            </div>
            <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
          </q-card-section>
        </q-card>
      </div>

      <!-- 2. AVU Spot -->
      <div class="col-12 col-sm-6 col-md-3">
        <q-card
          bordered
          flat
          class="metric-card"
          :class="cardBgClass"
          data-test="metric-card-avu-spot"
        >
          <q-card-section class="q-pa-sm">
            <div class="row items-center justify-between no-wrap">
              <span
                class="text-caption text-weight-medium text-grey-7 ellipsis"
              >
                {{ $t('walletPanel.avuSpotLabel') }}
              </span>
              <q-icon name="bolt" color="amber-8" size="18px" />
            </div>
            <div class="text-h6 text-weight-bolder text-amber-9 q-mt-xs">
              {{ avuSpotDisplay }}
            </div>
            <div class="text-caption text-grey-6 text-weight-regular ellipsis">
              {{ avuSpotSubtext }}
            </div>
            <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
          </q-card-section>
        </q-card>
      </div>

      <!-- 3. TPI -->
      <div class="col-12 col-sm-6 col-md-3">
        <q-card
          bordered
          flat
          class="metric-card"
          :class="cardBgClass"
          data-test="metric-card-tpi"
        >
          <q-card-section class="q-pa-sm">
            <div class="row items-center justify-between no-wrap">
              <span
                class="text-caption text-weight-medium text-grey-7 ellipsis"
              >
                {{ $t('walletPanel.tpiLabel') }}
              </span>
              <q-icon name="balance" color="positive" size="18px" />
            </div>
            <div class="text-h6 text-weight-bolder text-positive q-mt-xs">
              {{ tpiDisplay }}
            </div>
            <div class="text-caption text-grey-6 text-weight-regular ellipsis">
              {{ tpiSubtext }}
            </div>
            <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
          </q-card-section>
        </q-card>
      </div>

      <!-- 4. Arbitrage Margin -->
      <div class="col-12 col-sm-6 col-md-3">
        <q-card
          bordered
          flat
          class="metric-card"
          :class="cardBgClass"
          data-test="metric-card-arbitrage"
        >
          <q-card-section class="q-pa-sm">
            <div class="row items-center justify-between no-wrap">
              <span
                class="text-caption text-weight-medium text-grey-7 ellipsis"
              >
                {{ $t('walletPanel.arbitrageMargin') }}
              </span>
              <q-icon name="trending_up" color="secondary" size="18px" />
            </div>
            <div class="text-h6 text-weight-bolder text-secondary q-mt-xs">
              {{ arbitrageDisplay }}
            </div>
            <div class="text-caption text-grey-6 text-weight-regular ellipsis">
              {{ arbitrageSubtext }}
            </div>
            <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <!-- Toggle Controls: Time Ranges & Networks -->
    <div class="row items-center justify-between q-mb-sm q-col-gutter-xs">
      <div class="col-12 col-md-auto">
        <q-btn-toggle
          v-model="selectedRange"
          dense
          no-caps
          rounded
          unelevated
          toggle-color="primary"
          color="grey-4"
          text-color="grey-9"
          :options="rangeToggleOptions"
          data-test="view-toggle"
        />
      </div>

      <div
        class="col-12 col-md-auto row items-center q-gutter-x-sm text-caption text-grey-6"
      >
        <template v-if="selectedRange !== 'networks'">
          <span class="row items-center q-gutter-xs">
            <span
              class="legend-dot"
              :style="{ backgroundColor: themeColors.usd }"
            />
            <span>{{ $t('walletPanel.chartUsdKwh') }}</span>
          </span>
          <span class="row items-center q-gutter-xs">
            <span
              class="legend-dot"
              :style="{ backgroundColor: themeColors.gold }"
            />
            <span>{{ $t('walletPanel.chartGoldAvu') }}</span>
          </span>
          <span class="row items-center q-gutter-xs">
            <span
              class="legend-dot"
              :style="{ backgroundColor: themeColors.pow }"
            />
            <span>{{ $t('walletPanel.chartPowEmergence') }}</span>
          </span>
          <span class="row items-center q-gutter-xs">
            <span
              class="legend-dot"
              :style="{ backgroundColor: themeColors.milestone }"
            />
            <span>{{ $t('walletPanel.chartHardwareEff') }}</span>
          </span>
        </template>
        <template v-else>
          <span class="row items-center q-gutter-xs">
            <span
              class="legend-dot"
              :style="{ backgroundColor: themeColors.barBase }"
            />
            <span>{{ $t('walletPanel.chartHashCost') }}</span>
          </span>
          <span class="row items-center q-gutter-xs">
            <span
              class="legend-dot"
              :style="{ backgroundColor: themeColors.barHighlight }"
            />
            <span>{{ $t('walletPanel.chartArbitrageYield') }}</span>
          </span>
        </template>
      </div>
    </div>

    <!-- Chart Card -->
    <q-card
      bordered
      flat
      class="chart-canvas-card q-pa-sm"
      :class="cardBgClass"
    >
      <!-- 1. Time-Series Chart (all / pow / asic) -->
      <div
        v-if="selectedRange !== 'networks'"
        class="chart-container"
        data-test="macro-chart-container"
      >
        <svg
          class="chart-svg"
          viewBox="0 0 680 290"
          preserveAspectRatio="xMidYMid meet"
          data-test="macro-chart-svg"
          @mouseleave="clearHover"
        >
          <!-- Grid Lines (Horizontal) -->
          <g class="grid-lines" opacity="0.3">
            <line
              v-for="yTick in macroYGrid"
              :key="`grid-y-${yTick}`"
              x1="55"
              :y1="yTick"
              x2="625"
              :y2="yTick"
              :stroke="themeColors.grid"
              stroke-width="1"
              stroke-dasharray="3 3"
            />
          </g>

          <!-- Axes -->
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
          <line
            x1="625"
            y1="20"
            x2="625"
            y2="230"
            :stroke="themeColors.axis"
            stroke-width="1.5"
          />

          <!-- USD Area Fill -->
          <path :d="macroUsdAreaPath" :fill="themeColors.usd" opacity="0.12" />

          <!-- USD Line -->
          <path
            :d="macroUsdLinePath"
            fill="none"
            :stroke="themeColors.usd"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <!-- Gold Line -->
          <path
            :d="macroGoldLinePath"
            fill="none"
            :stroke="themeColors.gold"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <!-- PoW Line -->
          <path
            v-if="macroPowLinePath"
            :d="macroPowLinePath"
            fill="none"
            :stroke="themeColors.pow"
            stroke-width="2.5"
            stroke-dasharray="4 3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <!-- Hardware Milestone Indicator Lines -->
          <g
            v-for="m in activeMilestonesMapped"
            :key="`milestone-${m.year}-${m.label}`"
            class="milestone-group cursor-pointer"
            data-test="hardware-milestone-marker"
            @mouseenter="activeHoverMilestone = m"
            @click="activeHoverMilestone = m"
          >
            <line
              :x1="m.x"
              y1="25"
              :x2="m.x"
              y2="230"
              :stroke="themeColors.milestone"
              stroke-width="1.5"
              stroke-dasharray="2 3"
              opacity="0.75"
            />
            <circle
              :cx="m.x"
              cy="25"
              r="5"
              :fill="themeColors.milestone"
              :stroke="cardBgHex"
              stroke-width="1.5"
            />
          </g>

          <!-- Data Points & Hover Targets -->
          <g
            v-for="point in macroPointsMapped"
            :key="`macro-pt-${point.year}`"
            class="data-point-group"
            data-test="chart-hover-point"
            @mouseenter="activeHoverPoint = point"
            @click="activeHoverPoint = point"
          >
            <!-- Invisible larger hit area -->
            <circle
              :cx="point.x"
              :cy="point.usdY"
              r="14"
              fill="transparent"
              class="cursor-pointer"
            />
            <!-- USD circle -->
            <circle
              :cx="point.x"
              :cy="point.usdY"
              :r="activeHoverPoint?.year === point.year ? 6 : 4"
              :fill="themeColors.usd"
              :stroke="cardBgHex"
              stroke-width="2"
            />
            <!-- Gold circle -->
            <circle
              :cx="point.x"
              :cy="point.goldY"
              :r="activeHoverPoint?.year === point.year ? 6 : 4"
              :fill="themeColors.gold"
              :stroke="cardBgHex"
              stroke-width="2"
            />
            <!-- PoW marker if available -->
            <circle
              v-if="point.powY !== null"
              :cx="point.x"
              :cy="point.powY"
              :r="activeHoverPoint?.year === point.year ? 6 : 4"
              :fill="themeColors.pow"
              :stroke="cardBgHex"
              stroke-width="2"
            />
            <!-- X-axis Year Label -->
            <text
              :x="point.x"
              y="248"
              font-size="11"
              text-anchor="middle"
              :fill="themeColors.text"
              class="unselectable"
            >
              {{ point.year }}
            </text>
          </g>

          <!-- Left Axis Labels (USD) -->
          <text
            x="50"
            y="35"
            font-size="10"
            text-anchor="end"
            :fill="themeColors.usd"
          >
            {{ usdMaxLabel }}
          </text>
          <text
            x="50"
            y="130"
            font-size="10"
            text-anchor="end"
            :fill="themeColors.usd"
          >
            {{ usdMidLabel }}
          </text>
          <text
            x="50"
            y="230"
            font-size="10"
            text-anchor="end"
            :fill="themeColors.usd"
          >
            {{ usdMinLabel }}
          </text>

          <!-- Right Axis Labels (Gold) -->
          <text
            x="630"
            y="35"
            font-size="10"
            text-anchor="start"
            :fill="themeColors.gold"
          >
            {{ goldMaxLabel }}
          </text>
          <text
            x="630"
            y="130"
            font-size="10"
            text-anchor="start"
            :fill="themeColors.gold"
          >
            {{ goldMidLabel }}
          </text>
          <text
            x="630"
            y="230"
            font-size="10"
            text-anchor="start"
            :fill="themeColors.gold"
          >
            {{ goldMinLabel }}
          </text>

          <!-- Interactive Hover Tooltip Box (Data Point) -->
          <g
            v-if="activeHoverPoint"
            class="chart-svg-tooltip"
            data-test="chart-tooltip"
          >
            <rect
              :x="macroTooltipX"
              :y="macroTooltipY"
              width="210"
              height="85"
              rx="6"
              :fill="themeColors.tooltipBg"
              :stroke="themeColors.tooltipBorder"
              stroke-width="1"
              opacity="0.96"
            />
            <text
              :x="macroTooltipX + 12"
              :y="macroTooltipY + 20"
              font-size="12"
              font-weight="bold"
              :fill="themeColors.textPrimary"
            >
              {{ activeHoverPoint.year }}
            </text>
            <text
              :x="macroTooltipX + 12"
              :y="macroTooltipY + 38"
              font-size="11"
              :fill="themeColors.usd"
            >
              {{ `USD: ${activeHoverPoint.usdKwh.toFixed(1)} kWh/$` }}
            </text>
            <text
              :x="macroTooltipX + 12"
              :y="macroTooltipY + 54"
              font-size="11"
              :fill="themeColors.gold"
            >
              {{
                `Gold: ${activeHoverPoint.goldAvu.toLocaleString(
                  'en-US',
                )} AVU/oz`
              }}
            </text>
            <text
              v-if="activeHoverPoint.powHashRate"
              :x="macroTooltipX + 12"
              :y="macroTooltipY + 70"
              font-size="11"
              :fill="themeColors.pow"
            >
              {{ `PoW: ${activeHoverPoint.powHashRate} kWh/$` }}
            </text>
          </g>

          <!-- Milestone Tooltip Box -->
          <g
            v-else-if="activeHoverMilestone"
            class="chart-svg-tooltip"
            data-test="milestone-tooltip"
          >
            <rect
              :x="milestoneTooltipX"
              y="32"
              width="220"
              height="65"
              rx="6"
              :fill="themeColors.tooltipBg"
              :stroke="themeColors.milestone"
              stroke-width="1.5"
              opacity="0.96"
            />
            <text
              :x="milestoneTooltipX + 12"
              y="50"
              font-size="12"
              font-weight="bold"
              :fill="themeColors.milestone"
            >
              {{
                `${activeHoverMilestone.year}: ${activeHoverMilestone.label}`
              }}
            </text>
            <text
              :x="milestoneTooltipX + 12"
              y="68"
              font-size="11"
              :fill="themeColors.textPrimary"
            >
              {{ `Efficiency: ${activeHoverMilestone.efficiency}` }}
            </text>
            <text
              :x="milestoneTooltipX + 12"
              y="84"
              font-size="10"
              :fill="themeColors.text"
            >
              {{ `Reference: ${activeHoverMilestone.tech}` }}
            </text>
          </g>
        </svg>
      </div>

      <!-- 2. Network Parity Comparison Chart (Bar) -->
      <div v-else class="chart-container" data-test="networks-chart-container">
        <svg
          class="chart-svg"
          viewBox="0 0 680 280"
          preserveAspectRatio="xMidYMid meet"
          data-test="networks-chart-svg"
          @mouseleave="activeHoverBar = null"
        >
          <!-- Horizontal Grid Lines -->
          <g class="grid-lines" opacity="0.3">
            <line
              v-for="yTick in [50, 110, 170, 230]"
              :key="`grid-net-${yTick}`"
              x1="55"
              :y1="yTick"
              x2="625"
              :y2="yTick"
              :stroke="themeColors.grid"
              stroke-width="1"
              stroke-dasharray="3 3"
            />
          </g>

          <!-- Axes -->
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

          <!-- Y Axis Labels -->
          <text
            x="50"
            y="55"
            font-size="10"
            text-anchor="end"
            :fill="themeColors.text"
          >
            $0.15
          </text>
          <text
            x="50"
            y="115"
            font-size="10"
            text-anchor="end"
            :fill="themeColors.text"
          >
            $0.10
          </text>
          <text
            x="50"
            y="175"
            font-size="10"
            text-anchor="end"
            :fill="themeColors.text"
          >
            $0.05
          </text>
          <text
            x="50"
            y="230"
            font-size="10"
            text-anchor="end"
            :fill="themeColors.text"
          >
            $0.00
          </text>

          <!-- Network Bars -->
          <g
            v-for="bar in networkBarsMapped"
            :key="bar.id"
            class="bar-group"
            data-test="chart-hover-bar"
            @mouseenter="activeHoverBar = bar"
            @click="activeHoverBar = bar"
          >
            <!-- Bar Rect -->
            <rect
              :x="bar.x"
              :y="bar.y"
              :width="bar.width"
              :height="bar.height"
              rx="5"
              :fill="
                bar.isHighlight ? themeColors.barHighlight : themeColors.barBase
              "
              :opacity="activeHoverBar?.id === bar.id ? 1 : 0.85"
              class="cursor-pointer transition-colors"
            />

            <!-- Value Label on Top of Bar -->
            <text
              :x="bar.x + bar.width / 2"
              :y="bar.y - 8"
              font-size="11"
              font-weight="bold"
              text-anchor="middle"
              :fill="
                bar.isHighlight
                  ? themeColors.barHighlight
                  : themeColors.textPrimary
              "
            >
              {{ `$${bar.costKwh.toFixed(3)}` }}
            </text>

            <!-- Network Name Label -->
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

            <!-- Yield Spread Badge/Label -->
            <text
              :x="bar.x + bar.width / 2"
              y="264"
              font-size="10"
              text-anchor="middle"
              :fill="
                bar.spreadPercent > 0
                  ? themeColors.barHighlight
                  : themeColors.text
              "
            >
              {{ bar.spreadLabel }}
            </text>
          </g>

          <!-- Interactive Tooltip for Bar Chart -->
          <g
            v-if="activeHoverBar"
            class="chart-svg-tooltip"
            data-test="chart-tooltip"
          >
            <rect
              :x="networkTooltipX"
              :y="networkTooltipY"
              width="200"
              height="75"
              rx="6"
              :fill="themeColors.tooltipBg"
              :stroke="themeColors.tooltipBorder"
              stroke-width="1"
              opacity="0.96"
            />
            <text
              :x="networkTooltipX + 12"
              :y="networkTooltipY + 20"
              font-size="12"
              font-weight="bold"
              :fill="themeColors.textPrimary"
            >
              {{ `${activeHoverBar.name} (${activeHoverBar.algorithm})` }}
            </text>
            <text
              :x="networkTooltipX + 12"
              :y="networkTooltipY + 38"
              font-size="11"
              :fill="themeColors.textPrimary"
            >
              {{ `Energy Cost: $${activeHoverBar.costKwh.toFixed(3)}/kWh` }}
            </text>
            <text
              :x="networkTooltipX + 12"
              :y="networkTooltipY + 54"
              font-size="11"
              :fill="
                activeHoverBar.isHighlight
                  ? themeColors.barHighlight
                  : themeColors.text
              "
            >
              {{ `Arbitrage Yield: ${activeHoverBar.spreadLabel}` }}
            </text>
          </g>
        </svg>
      </div>
    </q-card>

    <!-- Methodology & Data Sources Citation Card -->
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
        <div>• {{ $t('walletPanel.sourceGrid') }}</div>
        <div>• {{ $t('walletPanel.sourceHash') }}</div>
        <div>• {{ $t('walletPanel.sourceHardware') }}</div>
      </div>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuasar } from 'quasar'

let $q: any = null
try {
  $q = useQuasar()
} catch {
  $q = null
}

// Selected view toggle ('all' | 'pow' | 'asic' | 'networks')
const selectedRange = ref<'all' | 'pow' | 'asic' | 'networks'>('all')

const rangeToggleOptions = computed(() => [
  { label: 'All-Time (1930-Present)', value: 'all' },
  { label: 'PoW Era (2009-Present)', value: 'pow' },
  { label: 'Modern ASIC (2020-Present)', value: 'asic' },
  { label: 'Network Comparison', value: 'networks' },
])

// Theme-driven styling
const isDark = computed(() => Boolean($q?.dark?.isActive))
const cardBgClass = computed(() => (isDark.value ? 'bg-dark' : 'bg-white'))
const cardBgHex = computed(() => (isDark.value ? '#121212' : '#ffffff'))

const themeColors = computed(() => {
  if (isDark.value) {
    return {
      usd: '#38bdf8',
      gold: '#f59e0b',
      pow: '#10b981',
      milestone: '#a855f7',
      grid: '#334155',
      axis: '#64748b',
      text: '#94a3b8',
      textPrimary: '#f8fafc',
      tooltipBg: '#1e293b',
      tooltipBorder: '#475569',
      barBase: '#0284c7',
      barHighlight: '#10b981',
    }
  }
  return {
    usd: '#0284c7',
    gold: '#d97706',
    pow: '#059669',
    milestone: '#7e22ce',
    grid: '#e2e8f0',
    axis: '#94a3b8',
    text: '#64748b',
    textPrimary: '#0f172a',
    tooltipBg: '#ffffff',
    tooltipBorder: '#cbd5e1',
    barBase: '#38bdf8',
    barHighlight: '#059669',
  }
})

// Metrics Cards Data
const avuHashDisplay = computed(() => '11.90 AVU/$')
const avuHashSubtext = computed(() => '11.90 kWh/$')
const avuSpotDisplay = computed(() => '12.20 AVU/$')
const avuSpotSubtext = computed(() => '12.20 kWh/$')
const tpiDisplay = computed(() => '1.02')
const tpiSubtext = computed(() => 'TPI ≈ 1.00')
const arbitrageDisplay = computed(() => '+67.8%')
const arbitrageSubtext = computed(() => 'eCash Yield Premium')

// 1. Time-Series Data (1930 - 2026)
interface MacroPoint {
  year: number
  usdKwh: number
  goldAvu: number
  powHashRate?: number
}

const allMacroData: MacroPoint[] = [
  { year: 1930, usdKwh: 143.0, goldAvu: 2953 },
  { year: 1950, usdKwh: 102.5, goldAvu: 3420 },
  { year: 1971, usdKwh: 68.2, goldAvu: 5100 },
  { year: 1990, usdKwh: 34.0, goldAvu: 9800 },
  { year: 2000, usdKwh: 28.5, goldAvu: 13400 },
  { year: 2009, usdKwh: 22.4, goldAvu: 18200, powHashRate: 1.0 },
  { year: 2010, usdKwh: 21.6, goldAvu: 19500, powHashRate: 2.2 },
  { year: 2013, usdKwh: 19.8, goldAvu: 21400, powHashRate: 4.8 },
  { year: 2016, usdKwh: 17.5, goldAvu: 23800, powHashRate: 7.6 },
  { year: 2017, usdKwh: 16.8, goldAvu: 24500, powHashRate: 8.5 },
  { year: 2020, usdKwh: 15.1, goldAvu: 27200, powHashRate: 10.4 },
  { year: 2021, usdKwh: 13.9, goldAvu: 28100, powHashRate: 11.2 },
  { year: 2024, usdKwh: 12.6, goldAvu: 30100, powHashRate: 11.7 },
  { year: 2026, usdKwh: 12.0, goldAvu: 31547, powHashRate: 11.9 },
]

// Hardware Milestones
interface HardwareMilestone {
  year: number
  label: string
  efficiency: string
  tech: string
}

const ALL_HARDWARE_MILESTONES: HardwareMilestone[] = [
  {
    year: 2009,
    label: 'CPU Mining',
    efficiency: '~10 MJ/GH',
    tech: 'Satoshi Core Client',
  },
  {
    year: 2010,
    label: 'GPU OpenCL',
    efficiency: '~1.5 kJ/GH',
    tech: 'Radeon HD 5870',
  },
  {
    year: 2013,
    label: 'Early ASIC',
    efficiency: '~2 kJ/TH',
    tech: 'Avalon / Antminer S1',
  },
  {
    year: 2016,
    label: 'Mature 16nm',
    efficiency: '~100 J/TH',
    tech: 'Antminer S9',
  },
  {
    year: 2020,
    label: '7nm Generation',
    efficiency: '~30 J/TH',
    tech: 'Antminer S19 Pro',
  },
  {
    year: 2024,
    label: '3nm Ultra',
    efficiency: '16 J/TH',
    tech: 'Antminer S21 Pro',
  },
]

// Range-filtered points and axis limits
const filteredMacroData = computed(() => {
  if (selectedRange.value === 'asic') {
    return allMacroData.filter(p => p.year >= 2020)
  }
  if (selectedRange.value === 'pow') {
    return allMacroData.filter(p => p.year >= 2009)
  }
  return allMacroData
})

const rangeMinYear = computed(() => {
  if (selectedRange.value === 'asic') return 2020
  if (selectedRange.value === 'pow') return 2009
  return 1930
})

const rangeMaxYear = computed(() => 2026)

const usdMaxLimit = computed(() => {
  if (selectedRange.value === 'asic') return 20
  if (selectedRange.value === 'pow') return 30
  return 150
})

const usdMinLimit = computed(() => 0)

const goldMaxLimit = computed(() => 35000)
const goldMinLimit = computed(() => {
  if (selectedRange.value === 'asic') return 20000
  if (selectedRange.value === 'pow') return 10000
  return 0
})

// Axis Labels
const usdMaxLabel = computed(() => `${usdMaxLimit.value}`)
const usdMidLabel = computed(() => `${Math.round(usdMaxLimit.value / 2)}`)
const usdMinLabel = computed(() => `${usdMinLimit.value}`)

const goldMaxLabel = computed(() => `${Math.round(goldMaxLimit.value / 1000)}k`)
const goldMidLabel = computed(
  () => `${Math.round((goldMaxLimit.value + goldMinLimit.value) / 2000)}k`,
)
const goldMinLabel = computed(() => `${Math.round(goldMinLimit.value / 1000)}k`)

const macroYGrid = [55, 113, 172, 230]

interface MappedMacroPoint extends MacroPoint {
  x: number
  usdY: number
  goldY: number
  powY: number | null
}

const macroPointsMapped = computed<MappedMacroPoint[]>(() => {
  const xMin = 65
  const xMax = 615
  const yTop = 30
  const yBottom = 230
  const yHeight = yBottom - yTop

  const minYear = rangeMinYear.value
  const maxYear = rangeMaxYear.value
  const maxUsd = usdMaxLimit.value
  const minGold = goldMinLimit.value
  const maxGold = goldMaxLimit.value

  return filteredMacroData.value.map(pt => {
    const x = xMin + ((pt.year - minYear) / (maxYear - minYear)) * (xMax - xMin)
    const usdY = yBottom - (Math.min(pt.usdKwh, maxUsd) / maxUsd) * yHeight
    const goldFrac = Math.max(pt.goldAvu - minGold, 0) / (maxGold - minGold)
    const goldY = yBottom - goldFrac * yHeight
    const powY =
      pt.powHashRate !== undefined
        ? yBottom - (Math.min(pt.powHashRate, maxUsd) / maxUsd) * yHeight
        : null

    return {
      ...pt,
      x: Math.round(x * 10) / 10,
      usdY: Math.round(usdY * 10) / 10,
      goldY: Math.round(goldY * 10) / 10,
      powY: powY !== null ? Math.round(powY * 10) / 10 : null,
    }
  })
})

const activeMilestonesMapped = computed(() => {
  const xMin = 65
  const xMax = 615
  const minYear = rangeMinYear.value
  const maxYear = rangeMaxYear.value

  return ALL_HARDWARE_MILESTONES.filter(
    m => m.year >= minYear && m.year <= maxYear,
  ).map(m => ({
    ...m,
    x:
      Math.round(
        (xMin + ((m.year - minYear) / (maxYear - minYear)) * (xMax - xMin)) *
          10,
      ) / 10,
  }))
})

const macroUsdLinePath = computed(() => {
  const pts = macroPointsMapped.value
  return pts.reduce(
    (acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.usdY}`,
    '',
  )
})

const macroUsdAreaPath = computed(() => {
  const pts = macroPointsMapped.value
  if (!pts.length) return ''
  const first = pts[0]
  const last = pts[pts.length - 1]
  return `${macroUsdLinePath.value} L ${last.x},230 L ${first.x},230 Z`
})

const macroGoldLinePath = computed(() => {
  const pts = macroPointsMapped.value
  return pts.reduce(
    (acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.goldY}`,
    '',
  )
})

const macroPowLinePath = computed(() => {
  const powPts = macroPointsMapped.value.filter(p => p.powY !== null)
  if (!powPts.length) return ''
  return powPts.reduce(
    (acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.powY}`,
    '',
  )
})

const activeHoverPoint = ref<MappedMacroPoint | null>(null)
const activeHoverMilestone = ref<HardwareMilestone | null>(null)

function clearHover() {
  activeHoverPoint.value = null
  activeHoverMilestone.value = null
}

const macroTooltipX = computed(() => {
  if (!activeHoverPoint.value) return 0
  const x = activeHoverPoint.value.x
  return x > 440 ? x - 220 : x + 15
})

const macroTooltipY = computed(() => {
  if (!activeHoverPoint.value) return 0
  return Math.max(30, Math.min(activeHoverPoint.value.usdY - 40, 140))
})

const milestoneTooltipX = computed(() => {
  if (!activeHoverMilestone.value) return 0
  const m = activeMilestonesMapped.value.find(
    item => item.label === activeHoverMilestone.value?.label,
  )
  const x = m?.x ?? 200
  return x > 440 ? x - 230 : x + 10
})

// 2. Network Parity Comparison Data
interface NetworkItem {
  id: string
  name: string
  costKwh: number
  spreadPercent: number
  algorithm: string
  isHighlight?: boolean
}

const rawNetworkData: NetworkItem[] = [
  {
    id: 'btc',
    name: 'BTC',
    costKwh: 0.084,
    spreadPercent: 0,
    algorithm: 'SHA-256',
  },
  {
    id: 'xec',
    name: 'XEC',
    costKwh: 0.141,
    spreadPercent: 67.8,
    algorithm: 'SHA-256',
    isHighlight: true,
  },
  {
    id: 'bch',
    name: 'BCH',
    costKwh: 0.081,
    spreadPercent: -3.6,
    algorithm: 'SHA-256',
  },
  {
    id: 'ltc',
    name: 'LTC',
    costKwh: 0.092,
    spreadPercent: 9.5,
    algorithm: 'Scrypt',
  },
  {
    id: 'kas',
    name: 'KAS',
    costKwh: 0.105,
    spreadPercent: 25.0,
    algorithm: 'kHeavyHash',
  },
]

interface MappedNetworkBar extends NetworkItem {
  x: number
  y: number
  width: number
  height: number
  spreadLabel: string
}

const networkBarsMapped = computed<MappedNetworkBar[]>(() => {
  const xStart = 90
  const totalWidth = 520
  const barWidth = 60
  const count = rawNetworkData.length
  const step = totalWidth / count
  const yBottom = 230
  const yTop = 40
  const yHeight = yBottom - yTop
  const maxCost = 0.16

  return rawNetworkData.map((item, idx) => {
    const x = xStart + idx * step + (step - barWidth) / 2
    const height = Math.max(10, (item.costKwh / maxCost) * yHeight)
    const y = yBottom - height
    const spreadLabel =
      item.spreadPercent === 0
        ? 'Baseline'
        : `${item.spreadPercent > 0 ? '+' : ''}${item.spreadPercent.toFixed(
            1,
          )}%`

    return {
      ...item,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      width: barWidth,
      height: Math.round(height * 10) / 10,
      spreadLabel,
    }
  })
})

const activeHoverBar = ref<MappedNetworkBar | null>(null)

const networkTooltipX = computed(() => {
  if (!activeHoverBar.value) return 0
  const x = activeHoverBar.value.x
  return x > 440 ? x - 210 : x + activeHoverBar.value.width + 10
})

const networkTooltipY = computed(() => {
  if (!activeHoverBar.value) return 0
  return Math.max(30, Math.min(activeHoverBar.value.y, 140))
})
</script>

<style scoped>
.avu-parity-chart {
  width: 100%;
}

.metric-card {
  border-radius: 8px;
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
}

.unselectable {
  user-select: none;
}
</style>
