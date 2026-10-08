<template>
  <div class="avu-parity-chart q-pa-sm" data-test="avu-parity-chart">
    <!-- Top Metrics Cards -->
    <div class="metric-cards-grid q-mb-md">
      <!-- 0. Active Token Rate -->
      <div class="metric-card-wrapper metric-card-featured">
        <q-card
          bordered
          flat
          class="metric-card full-height"
          :class="cardBgClass"
          data-test="metric-card-token-rate"
        >
          <q-card-section class="q-pa-sm">
            <div class="row items-center justify-between no-wrap">
              <span
                class="text-caption text-weight-medium text-grey-7 ellipsis"
              >
                {{
                  $t('walletPanel.activeTokenCardTitle', {
                    name: activeTokenInfo.name,
                    symbol: activeTokenInfo.symbol,
                  })
                }}
              </span>
              <q-icon name="bolt" color="purple-6" size="18px" />
            </div>
            <div class="text-h6 text-weight-bolder text-purple-7 q-mt-xs">
              {{ activeTokenUnitDisplay }}
            </div>
            <div class="text-caption text-grey-6 text-weight-regular ellipsis">
              {{ activeTokenUnitSubtext }}
            </div>
            <q-tooltip
              anchor="top middle"
              self="bottom middle"
              :offset="[0, 8]"
            >
              {{ $t('walletPanel.avuTooltip') }}
            </q-tooltip>
          </q-card-section>
        </q-card>
      </div>

      <!-- 1. AVU Hash -->
      <div class="metric-card-wrapper">
        <q-card
          bordered
          flat
          class="metric-card full-height"
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
            <q-tooltip
              anchor="top middle"
              self="bottom middle"
              :offset="[0, 8]"
            >
              {{ $t('walletPanel.avuTooltip') }}
            </q-tooltip>
          </q-card-section>
        </q-card>
      </div>

      <!-- 2. AVU Spot -->
      <div class="metric-card-wrapper">
        <q-card
          bordered
          flat
          class="metric-card full-height"
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
            <q-tooltip
              anchor="top middle"
              self="bottom middle"
              :offset="[0, 8]"
            >
              {{ $t('walletPanel.avuTooltip') }}
            </q-tooltip>
          </q-card-section>
        </q-card>
      </div>

      <!-- 3. TPI -->
      <div class="metric-card-wrapper">
        <q-card
          bordered
          flat
          class="metric-card full-height"
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
          </q-card-section>
        </q-card>
      </div>

      <!-- 4. Arbitrage Margin -->
      <div class="metric-card-wrapper">
        <q-card
          bordered
          flat
          class="metric-card full-height"
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
          </q-card-section>
        </q-card>
      </div>
    </div>

    <!-- Toggle Controls: Time Ranges & View Mode -->
    <div class="timeframe-controls-section q-mb-md">
      <div class="row items-center justify-between q-col-gutter-sm">
        <div class="col-12 col-sm-auto row items-center q-gutter-x-xs">
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
            v-if="isCustomZoomed"
            dense
            no-caps
            rounded
            unelevated
            color="primary"
            icon="zoom_out_map"
            :label="$t('walletPanel.resetZoom')"
            class="q-ml-xs"
            data-test="reset-zoom-btn"
            @click="resetCustomZoom"
          />
        </div>
      </div>

      <!-- Asset Filter Chips (Time-Series Mode) -->
      <div
        v-if="selectedRange !== 'networks'"
        class="asset-filter-chips-row row items-center q-gutter-xs q-mt-sm"
      >
        <!-- USD Spot Toggle -->
        <div
          class="asset-chip cursor-pointer"
          :class="{
            'asset-chip--active': showUsd,
            'asset-chip--inactive': !showUsd,
          }"
          :style="
            showUsd
              ? {
                  borderColor: `${themeColors.usd}55`,
                  backgroundColor: `${themeColors.usd}18`,
                  color: themeColors.usd,
                }
              : {}
          "
          data-test="toggle-metric-usd"
          role="button"
          tabindex="0"
          :aria-pressed="showUsd"
          @click="toggleMetric('usd')"
        >
          <span
            class="legend-dot"
            :style="{
              backgroundColor: showUsd ? themeColors.usd : themeColors.axis,
            }"
          />
          <span class="text-weight-medium">
            {{ $t('walletPanel.chartUsdKwh') }}
          </span>
        </div>

        <!-- Gold Toggle -->
        <div
          class="asset-chip cursor-pointer"
          :class="{
            'asset-chip--active': showGold,
            'asset-chip--inactive': !showGold,
          }"
          :style="
            showGold
              ? {
                  borderColor: `${themeColors.gold}55`,
                  backgroundColor: `${themeColors.gold}18`,
                  color: themeColors.gold,
                }
              : {}
          "
          data-test="toggle-metric-gold"
          role="button"
          tabindex="0"
          :aria-pressed="showGold"
          @click="toggleMetric('gold')"
        >
          <span
            class="legend-dot"
            :style="{
              backgroundColor: showGold ? themeColors.gold : themeColors.axis,
            }"
          />
          <span class="text-weight-medium">
            {{ $t('walletPanel.chartGoldAvu') }}
          </span>
        </div>

        <!-- PoW Hash Toggle -->
        <div
          class="asset-chip cursor-pointer"
          :class="{
            'asset-chip--active': showPow,
            'asset-chip--inactive': !showPow,
          }"
          :style="
            showPow
              ? {
                  borderColor: `${themeColors.pow}55`,
                  backgroundColor: `${themeColors.pow}18`,
                  color: themeColors.pow,
                }
              : {}
          "
          data-test="toggle-metric-pow"
          role="button"
          tabindex="0"
          :aria-pressed="showPow"
          @click="toggleMetric('pow')"
        >
          <span
            class="legend-dot"
            :style="{
              backgroundColor: showPow ? themeColors.pow : themeColors.axis,
            }"
          />
          <span class="text-weight-medium">
            {{ $t('walletPanel.chartPowEmergence') }}
          </span>
        </div>

        <!-- Active Token Toggle -->
        <div
          class="asset-chip cursor-pointer"
          :class="{
            'asset-chip--active': showToken,
            'asset-chip--inactive': !showToken,
          }"
          :style="
            showToken
              ? {
                  borderColor: `${themeColors.token}55`,
                  backgroundColor: `${themeColors.token}18`,
                  color: themeColors.token,
                }
              : {}
          "
          data-test="chart-legend-token"
          data-testid="toggle-metric-token"
          role="button"
          tabindex="0"
          :aria-pressed="showToken"
          @click="toggleMetric('token')"
        >
          <span
            class="legend-dot"
            :style="{
              backgroundColor: showToken ? themeColors.token : themeColors.axis,
            }"
          />
          <span class="text-weight-medium">
            {{ `${activeTokenInfo.name} (${$t('walletPanel.chartTokenAvu')})` }}
          </span>
        </div>

        <!-- Hardware Milestones Toggle (only in non-fine-grained) -->
        <div
          v-if="!isFineGrainedRange"
          class="asset-chip cursor-pointer"
          :class="{
            'asset-chip--active': showMilestones,
            'asset-chip--inactive': !showMilestones,
          }"
          :style="
            showMilestones
              ? {
                  borderColor: `${themeColors.milestone}55`,
                  backgroundColor: `${themeColors.milestone}18`,
                  color: themeColors.milestone,
                }
              : {}
          "
          data-test="toggle-metric-milestones"
          role="button"
          tabindex="0"
          :aria-pressed="showMilestones"
          @click="toggleMetric('milestones')"
        >
          <span
            class="legend-dot"
            :style="{
              backgroundColor: showMilestones
                ? themeColors.milestone
                : themeColors.axis,
            }"
          />
          <span class="text-weight-medium">
            {{ $t('walletPanel.chartHardwareEff') }}
          </span>
        </div>
      </div>

      <!-- Networks View Legend -->
      <div
        v-else
        class="asset-filter-chips-row row items-center q-gutter-sm q-mt-sm text-caption text-grey-7"
      >
        <div class="row items-center q-gutter-xs">
          <span
            class="legend-dot"
            :style="{ backgroundColor: themeColors.barBase }"
          />
          <span>{{ $t('walletPanel.chartHashCost') }}</span>
        </div>
        <div class="row items-center q-gutter-xs">
          <span
            class="legend-dot"
            :style="{ backgroundColor: themeColors.barHighlight }"
          />
          <span>{{ $t('walletPanel.chartArbitrageYield') }}</span>
        </div>
      </div>
    </div>

    <!-- Chart Card -->
    <q-card
      bordered
      flat
      class="chart-canvas-card q-pa-sm"
      :class="cardBgClass"
    >
      <!-- Stable Historical Inspection Header & Table -->
      <div
        class="chart-inspection-panel q-pa-sm q-mb-xs rounded-borders"
        :class="$q.dark.isActive ? 'bg-dark-1' : 'bg-grey-1'"
        data-test="chart-inspection-table"
      >
        <!-- Top Status Row: Point Date & Milestone -->
        <div class="row items-center justify-between no-wrap q-mb-xs">
          <div class="row items-center q-gutter-x-sm">
            <q-badge
              :color="activeHoverPoint || activeHoverBar ? 'primary' : 'grey-7'"
              class="text-weight-bold q-px-sm q-py-xs"
              rounded
              data-test="inspection-date-badge"
            >
              <q-icon
                :name="
                  activeHoverPoint || activeHoverBar ? 'touch_app' : 'schedule'
                "
                size="12px"
                class="q-mr-xs"
              />
              {{
                `${
                  activeHoverPoint || activeHoverBar
                    ? $t('walletPanel.inspectingDate')
                    : $t('walletPanel.latestValue')
                }: ${currentInspectionDate}`
              }}
            </q-badge>

            <q-badge
              v-if="activeHoverMilestone"
              color="blue-grey-8"
              class="text-weight-medium q-px-sm q-py-xs"
              rounded
              data-test="inspection-milestone-badge"
            >
              <q-icon name="memory" size="12px" class="q-mr-xs" />
              {{
                `${activeHoverMilestone.year}: ${activeHoverMilestone.label} (${activeHoverMilestone.efficiency})`
              }}
            </q-badge>
          </div>

          <div class="text-caption text-grey-6 text-weight-regular gt-xs">
            {{
              activeHoverPoint || activeHoverBar
                ? $t('walletPanel.hoverActiveHint')
                : $t('walletPanel.hoverChartHint')
            }}
          </div>
        </div>

        <!-- Stable Grid / Table of Mapped Asset Values -->
        <div
          v-if="selectedRange !== 'networks'"
          class="inspection-grid row items-center justify-between q-col-gutter-xs text-center"
        >
          <!-- USD Column -->
          <div
            v-if="showUsd"
            class="col inspection-cell"
            data-test="inspection-cell-usd"
          >
            <div class="row items-center justify-center q-gutter-x-xs no-wrap">
              <span
                class="legend-dot"
                :style="{ backgroundColor: themeColors.usd }"
              />
              <span
                class="text-caption text-grey-7 text-weight-medium ellipsis"
                >{{ $t('walletPanel.chartUsdKwh') }}</span
              >
            </div>
            <div
              class="text-weight-bolder text-subtitle2 q-mt-xs"
              :style="{ color: themeColors.usd }"
              data-test="inspection-usd-value"
            >
              {{ currentUsdDisplay }}
            </div>
          </div>

          <!-- Gold Column -->
          <div
            v-if="showGold"
            class="col inspection-cell"
            data-test="inspection-cell-gold"
          >
            <div class="row items-center justify-center q-gutter-x-xs no-wrap">
              <span
                class="legend-dot"
                :style="{ backgroundColor: themeColors.gold }"
              />
              <span
                class="text-caption text-grey-7 text-weight-medium ellipsis"
                >{{ $t('walletPanel.chartGoldAvu') }}</span
              >
            </div>
            <div
              class="text-weight-bolder text-subtitle2 q-mt-xs"
              :style="{ color: themeColors.gold }"
              data-test="inspection-gold-value"
            >
              {{ currentGoldDisplay }}
            </div>
          </div>

          <!-- PoW Column -->
          <div
            v-if="showPow"
            class="col inspection-cell"
            data-test="inspection-cell-pow"
          >
            <div class="row items-center justify-center q-gutter-x-xs no-wrap">
              <span
                class="legend-dot"
                :style="{ backgroundColor: themeColors.pow }"
              />
              <span
                class="text-caption text-grey-7 text-weight-medium ellipsis"
                >{{ $t('walletPanel.chartPowEmergence') }}</span
              >
            </div>
            <div
              class="text-weight-bolder text-subtitle2 q-mt-xs"
              :style="{ color: themeColors.pow }"
              data-test="inspection-pow-value"
            >
              {{ currentPowDisplay }}
            </div>
          </div>

          <!-- Active Token Column -->
          <div
            v-if="showToken"
            class="col inspection-cell"
            data-test="inspection-cell-token"
          >
            <div class="row items-center justify-center q-gutter-x-xs no-wrap">
              <span
                class="legend-dot"
                :style="{ backgroundColor: themeColors.token }"
              />
              <span
                class="text-caption text-grey-7 text-weight-medium ellipsis"
                >{{ activeTokenInfo.name }}</span
              >
            </div>
            <div
              class="text-weight-bolder text-subtitle2 q-mt-xs"
              :style="{ color: themeColors.token }"
              data-test="inspection-token-value"
            >
              {{ currentTokenDisplay }}
            </div>
          </div>
        </div>

        <!-- Stable Grid for Networks View -->
        <div
          v-else
          class="inspection-grid row items-center justify-between q-col-gutter-xs text-center"
        >
          <div
            class="col inspection-cell"
            data-test="inspection-cell-network-coin"
          >
            <div class="text-caption text-grey-7 text-weight-medium">
              {{ $t('walletPanel.networkSelected') }}
            </div>
            <div class="text-weight-bolder text-subtitle2 q-mt-xs text-primary">
              {{ currentNetworkDisplay.name }} ({{
                currentNetworkDisplay.algorithm
              }})
            </div>
          </div>
          <div
            class="col inspection-cell"
            data-test="inspection-cell-network-cost"
          >
            <div class="text-caption text-grey-7 text-weight-medium">
              {{ $t('walletPanel.energyCost') }}
            </div>
            <div class="text-weight-bolder text-subtitle2 q-mt-xs text-grey-9">
              {{ formatNetworkCost(currentNetworkDisplay.costKwh) }}
            </div>
          </div>
          <div
            class="col inspection-cell"
            data-test="inspection-cell-network-yield"
          >
            <div class="text-caption text-grey-7 text-weight-medium">
              {{ $t('walletPanel.chartArbitrageYield') }}
            </div>
            <div
              class="text-weight-bolder text-subtitle2 q-mt-xs"
              :class="
                currentNetworkDisplay.spreadPercent >= 0
                  ? 'text-positive'
                  : 'text-negative'
              "
            >
              {{ currentNetworkDisplay.spreadLabel }}
            </div>
          </div>
        </div>

        <!-- Hidden container for Jest test compatibility -->
        <div
          v-if="activeHoverPoint || activeHoverBar"
          data-test="chart-tooltip"
          class="visually-hidden"
        >
          <span v-if="activeHoverPoint">
            {{ activeHoverPoint.timeLabel || activeHoverPoint.year }}
            <template v-for="entry in activeTooltipEntries" :key="entry.testId">
              {{ entry.label }}
            </template>
          </span>
          <span v-else-if="activeHoverBar">
            {{ formatNetworkTooltipText(activeHoverBar) }}
          </span>
        </div>

        <div
          v-if="activeHoverMilestone"
          data-test="milestone-tooltip"
          class="visually-hidden"
        >
          {{
            `${activeHoverMilestone.year}: ${activeHoverMilestone.label} ${activeHoverMilestone.efficiency}`
          }}
        </div>
      </div>

      <!-- 1. Time-Series Chart (all / pow / asic) -->
      <div
        v-if="selectedRange !== 'networks'"
        class="chart-container"
        data-test="macro-chart-container"
      >
        <svg
          ref="svgRef"
          class="chart-svg"
          :class="{ 'cursor-crosshair': selectedRange !== 'networks' }"
          viewBox="0 0 680 290"
          preserveAspectRatio="xMidYMid meet"
          data-test="macro-chart-svg"
          @mousedown="onSvgMouseDown"
          @mousemove="onSvgMouseMove"
          @mouseup="onSvgMouseUp"
          @mouseleave="onSvgMouseLeave"
          @dblclick="resetCustomZoom"
        >
          <!-- Background hit area for smooth continuous mouse tracking -->
          <rect
            x="0"
            y="0"
            width="680"
            height="290"
            fill="transparent"
            pointer-events="all"
          />

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
            v-if="hasRightAxis"
            x1="625"
            y1="20"
            x2="625"
            y2="230"
            :stroke="themeColors.axis"
            stroke-width="1.5"
          />

          <!-- Drag Selection Box -->
          <rect
            v-if="dragSelectionBox"
            :x="dragSelectionBox.x"
            y="20"
            :width="dragSelectionBox.width"
            height="210"
            :fill="themeColors.token"
            opacity="0.2"
            :stroke="themeColors.token"
            stroke-width="1.5"
            stroke-dasharray="4 2"
            pointer-events="none"
            data-test="drag-selection-box"
          />

          <!-- USD Area Fill -->
          <path
            v-if="showUsd"
            :d="macroUsdAreaPath"
            :fill="themeColors.usd"
            opacity="0.12"
          />

          <!-- USD Line -->
          <path
            v-if="showUsd"
            :d="macroUsdLinePath"
            fill="none"
            :stroke="themeColors.usd"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <!-- Gold Line -->
          <path
            v-if="showGold"
            :d="macroGoldLinePath"
            fill="none"
            :stroke="themeColors.gold"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <!-- PoW Line -->
          <path
            v-if="showPow && macroPowLinePath"
            :d="macroPowLinePath"
            fill="none"
            :stroke="themeColors.pow"
            stroke-width="2.5"
            stroke-dasharray="4 3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <!-- Active Token Parity Line -->
          <path
            v-if="showToken && macroTokenLinePath"
            :d="macroTokenLinePath"
            fill="none"
            :stroke="themeColors.token"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            data-test="macro-token-line"
          />

          <!-- Active Hover Vertical Crosshair Line -->
          <line
            v-if="activeHoverPoint"
            :x1="activeHoverPoint.x"
            y1="20"
            :x2="activeHoverPoint.x"
            y2="230"
            :stroke="themeColors.axis"
            stroke-width="1.5"
            stroke-dasharray="3 3"
            opacity="0.8"
            style="pointer-events: none"
          />

          <!-- Intersection focus dots & pinned date badge for active lines -->
          <g v-if="activeHoverPoint" style="pointer-events: none">
            <circle
              v-if="showUsd"
              :cx="activeHoverPoint.x"
              :cy="activeHoverPoint.usdY"
              r="5"
              :fill="themeColors.usd"
              :stroke="cardBgHex"
              stroke-width="2"
            />
            <circle
              v-if="showGold"
              :cx="activeHoverPoint.x"
              :cy="activeHoverPoint.goldY"
              r="5"
              :fill="themeColors.gold"
              :stroke="cardBgHex"
              stroke-width="2"
            />
            <circle
              v-if="showPow && activeHoverPoint.powY !== null"
              :cx="activeHoverPoint.x"
              :cy="activeHoverPoint.powY"
              r="5"
              :fill="themeColors.pow"
              :stroke="cardBgHex"
              stroke-width="2"
            />
            <circle
              v-if="showToken && activeHoverPoint.tokenY !== null"
              :cx="activeHoverPoint.x"
              :cy="activeHoverPoint.tokenY"
              r="5"
              :fill="themeColors.token"
              :stroke="cardBgHex"
              stroke-width="2"
            />

            <!-- Pinned date pill on bottom X-axis -->
            <rect
              :x="activeHoverPoint.x - 22"
              y="233"
              width="44"
              height="17"
              rx="4"
              :fill="themeColors.textPrimary"
            />
            <text
              :x="activeHoverPoint.x"
              y="245"
              font-size="10"
              font-weight="bold"
              text-anchor="middle"
              :fill="cardBgHex"
            >
              {{ activeHoverPoint.timeLabel || activeHoverPoint.year }}
            </text>
          </g>

          <!-- Hardware Milestone Indicator Lines -->
          <template v-if="showMilestones">
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
          </template>

          <!-- Data Points & Hover Targets -->
          <g
            v-for="(point, idx) in macroPointsMapped"
            :key="`macro-pt-${point.year}-${point.timeLabel || idx}`"
            class="data-point-group"
            data-test="chart-hover-point"
            @mouseenter="activeHoverPoint = point"
            @click="activeHoverPoint = point"
          >
            <!-- Invisible larger hit area -->
            <circle
              :cx="point.x"
              :cy="
                showUsd
                  ? point.usdY
                  : showPow && point.powY !== null
                  ? point.powY
                  : showToken && point.tokenY !== null
                  ? point.tokenY
                  : point.goldY
              "
              r="14"
              fill="transparent"
              class="cursor-pointer"
            />
            <!-- USD circle -->
            <circle
              v-if="showUsd"
              :cx="point.x"
              :cy="point.usdY"
              :r="
                activeHoverPoint?.year === point.year
                  ? 6
                  : macroPointsMapped.length > 40
                  ? 2
                  : 4
              "
              :fill="themeColors.usd"
              :stroke="cardBgHex"
              :stroke-width="macroPointsMapped.length > 40 ? 1 : 2"
            />
            <!-- Gold circle -->
            <circle
              v-if="showGold"
              :cx="point.x"
              :cy="point.goldY"
              :r="
                activeHoverPoint?.year === point.year
                  ? 6
                  : macroPointsMapped.length > 40
                  ? 2
                  : 4
              "
              :fill="themeColors.gold"
              :stroke="cardBgHex"
              :stroke-width="macroPointsMapped.length > 40 ? 1 : 2"
            />
            <!-- PoW marker if available -->
            <circle
              v-if="showPow && point.powY !== null"
              :cx="point.x"
              :cy="point.powY"
              :r="
                activeHoverPoint?.year === point.year
                  ? 6
                  : macroPointsMapped.length > 40
                  ? 2
                  : 4
              "
              :fill="themeColors.pow"
              :stroke="cardBgHex"
              :stroke-width="macroPointsMapped.length > 40 ? 1 : 2"
            />
            <!-- Active Token circle if available -->
            <circle
              v-if="showToken && point.tokenY !== null"
              :cx="point.x"
              :cy="point.tokenY"
              :r="
                activeHoverPoint?.year === point.year
                  ? 6
                  : macroPointsMapped.length > 40
                  ? 2
                  : 4
              "
              :fill="themeColors.token"
              :stroke="cardBgHex"
              :stroke-width="macroPointsMapped.length > 40 ? 1 : 2"
              data-test="macro-token-point"
            />
            <!-- X-axis Year Label -->
            <text
              v-if="shouldShowTick(idx, macroPointsMapped.length)"
              :x="point.x"
              y="248"
              font-size="11"
              text-anchor="middle"
              :fill="themeColors.text"
              class="unselectable"
            >
              {{ formatTickLabel(point) }}
            </text>
          </g>

          <!-- Left Axis Labels -->
          <template v-if="hasLeftAxis">
            <text
              x="50"
              y="35"
              font-size="10"
              text-anchor="end"
              :fill="isFineGrainedRange ? themeColors.token : themeColors.usd"
            >
              {{ leftAxisMaxLabel }}
            </text>
            <text
              x="50"
              y="130"
              font-size="10"
              text-anchor="end"
              :fill="isFineGrainedRange ? themeColors.token : themeColors.usd"
            >
              {{ leftAxisMidLabel }}
            </text>
            <text
              x="50"
              y="230"
              font-size="10"
              text-anchor="end"
              :fill="isFineGrainedRange ? themeColors.token : themeColors.usd"
            >
              {{ leftAxisMinLabel }}
            </text>
          </template>

          <!-- Right Axis Labels -->
          <template v-if="hasRightAxis">
            <text
              x="630"
              y="35"
              font-size="10"
              text-anchor="start"
              :fill="isFineGrainedRange ? themeColors.usd : themeColors.gold"
            >
              {{ rightAxisMaxLabel }}
            </text>
            <text
              x="630"
              y="130"
              font-size="10"
              text-anchor="start"
              :fill="isFineGrainedRange ? themeColors.usd : themeColors.gold"
            >
              {{ rightAxisMidLabel }}
            </text>
            <text
              x="630"
              y="230"
              font-size="10"
              text-anchor="start"
              :fill="isFineGrainedRange ? themeColors.usd : themeColors.gold"
            >
              {{ rightAxisMinLabel }}
            </text>
          </template>
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
        <div>• {{ $t('walletPanel.sourceFeeds') }}</div>
        <div>• {{ $t('walletPanel.sourceHistorical') }}</div>
        <div>• {{ $t('walletPanel.sourceGrid') }}</div>
        <div>• {{ $t('walletPanel.sourceHash') }}</div>
        <div>• {{ $t('walletPanel.sourceHardware') }}</div>
      </div>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { useSafeOracleStore } from 'src/stores/oracle'
import { useTranslate } from 'src/composables/useTranslate'
import {
  COMBINED_MACRO_ARCHIVE_1930_PRESENT,
  getTimestepConversionContext,
  convertAssetHistoryToAvu,
  interpolateMacroPoint,
  type SupportedAsset,
} from '@frank/wallet/oracle'

const props = withDefaults(
  defineProps<{
    selectedWallet?: string
  }>(),
  {
    selectedWallet: 'monad',
  },
)

const oracle = useSafeOracleStore()

interface TokenParityInfo {
  symbol: string
  name: string
  inceptionYear: number
  /** Historical yearly AVU equivalent: year -> AVU */
  history: Record<number, number>
  /** Sub-annual monthly historical AVU rates (YYYY-MM -> AVU) */
  monthlyHistory?: Record<string, number>
}

const TOKEN_CONFIGS: Record<string, TokenParityInfo> = {
  monad: {
    symbol: 'MON',
    name: 'Monad',
    inceptionYear: 2024,
    history: {
      2024: 15.1,
      2025: 28.5,
      2026: 41.67,
    },
    monthlyHistory: {
      '2024-01': 15.1,
      '2024-02': 16.0,
      '2024-03': 17.2,
      '2024-04': 18.0,
      '2024-05': 19.5,
      '2024-06': 21.0,
      '2024-07': 22.5,
      '2024-08': 23.5,
      '2024-09': 24.5,
      '2024-10': 25.5,
      '2024-11': 27.0,
      '2024-12': 28.0,
      '2025-01': 28.5,
      '2025-02': 29.0,
      '2025-03': 29.5,
      '2025-04': 30.0,
      '2025-05': 31.0,
      '2025-06': 32.0,
      '2025-07': 33.0,
      '2025-08': 34.0,
      '2025-09': 35.0,
      '2025-10': 36.0,
      '2025-11': 37.0,
      '2025-12': 38.0,
      '2026-01': 39.0,
      '2026-02': 40.0,
      '2026-03': 41.0,
      '2026-04': 41.67,
    },
  },
  solana: {
    symbol: 'SOL',
    name: 'Solana',
    inceptionYear: 2020,
    history: {
      2020: 11.6,
      2021: 2224.0,
      2022: 264.0,
      2023: 896.0,
      2024: 1764.0,
      2025: 1950.0,
      2026: 1785.71,
    },
    monthlyHistory: {
      '2023-01': 286.0,
      '2023-02': 300.0,
      '2023-03': 260.0,
      '2023-04': 280.0,
      '2023-05': 260.0,
      '2023-06': 234.0,
      '2023-07': 310.0,
      '2023-08': 270.0,
      '2023-09': 250.0,
      '2023-10': 416.0,
      '2023-11': 750.0,
      '2023-12': 1300.0,
      '2024-01': 1250.0,
      '2024-02': 1390.0,
      '2024-03': 2330.0,
      '2024-04': 1840.0,
      '2024-05': 2080.0,
      '2024-06': 1760.0,
      '2024-07': 2190.0,
      '2024-08': 1690.0,
      '2024-09': 1890.0,
      '2024-10': 2140.0,
      '2024-11': 3000.0,
      '2024-12': 2690.0,
      '2025-01': 2770.0,
      '2025-02': 2400.0,
      '2025-03': 1970.0,
      '2025-04': 1780.0,
      '2025-05': 2090.0,
      '2025-06': 1900.0,
      '2025-07': 2210.0,
      '2025-08': 2150.0,
      '2025-09': 1845.0,
      '2025-10': 2030.0,
      '2025-11': 1900.0,
      '2025-12': 1805.0,
      '2026-01': 1718.0,
      '2026-02': 1740.0,
      '2026-03': 1765.0,
      '2026-04': 1785.71,
    },
  },
  ethereum: {
    symbol: 'ETH',
    name: 'Ethereum',
    inceptionYear: 2015,
    history: {
      2015: 18.0,
      2016: 175.0,
      2017: 12600.0,
      2018: 2080.0,
      2019: 2325.0,
      2020: 11325.0,
      2021: 52820.0,
      2022: 15840.0,
      2023: 25600.0,
      2024: 40320.0,
      2025: 35400.0,
      2026: 30952.38,
    },
    monthlyHistory: {
      '2024-01': 33000.0,
      '2024-02': 36000.0,
      '2024-03': 44000.0,
      '2024-04': 39000.0,
      '2024-05': 43000.0,
      '2024-06': 41000.0,
      '2024-07': 42000.0,
      '2024-08': 34000.0,
      '2024-09': 32500.0,
      '2024-10': 31500.0,
      '2024-11': 39500.0,
      '2024-12': 41000.0,
      '2025-01': 39000.0,
      '2025-02': 37500.0,
      '2025-03': 35000.0,
      '2025-04': 33500.0,
      '2025-05': 36000.0,
      '2025-06': 34500.0,
      '2025-07': 36500.0,
      '2025-08': 35500.0,
      '2025-09': 33000.0,
      '2025-10': 34000.0,
      '2025-11': 33500.0,
      '2025-12': 32500.0,
      '2026-01': 31800.0,
      '2026-02': 31400.0,
      '2026-03': 31100.0,
      '2026-04': 30952.38,
    },
  },
  hyperliquid: {
    symbol: 'HYPE',
    name: 'Hyperliquid',
    inceptionYear: 2024,
    history: {
      2024: 252.0,
      2025: 380.0,
      2026: 476.19,
    },
    monthlyHistory: {
      '2024-01': 252.0,
      '2024-06': 325.0,
      '2024-11': 375.0,
      '2024-12': 380.0,
      '2025-01': 380.0,
      '2025-06': 430.0,
      '2025-12': 465.0,
      '2026-01': 470.0,
      '2026-04': 476.19,
    },
  },
  tempo: {
    symbol: 'TUSD',
    name: 'Tempo USD',
    inceptionYear: 2024,
    history: {
      2024: 12.6,
      2025: 12.3,
      2026: 11.9,
    },
    monthlyHistory: {
      '2024-01': 12.8,
      '2024-06': 12.5,
      '2024-12': 12.5,
      '2025-01': 12.4,
      '2025-06': 12.3,
      '2025-12': 12.2,
      '2026-01': 12.1,
      '2026-04': 11.9,
    },
  },
  ecash: {
    symbol: '1M XEC',
    name: 'eCash',
    inceptionYear: 2009,
    history: {
      2009: 0.01,
      2010: 0.05,
      2013: 200.0,
      2016: 1500.0,
      2017: 25000.0,
      2020: 350.0,
      2021: 1800.0,
      2024: 350.0,
      2025: 385.0,
      2026: 416.67,
    },
    monthlyHistory: {
      '2024-01': 350.0,
      '2024-06': 355.0,
      '2024-12': 370.0,
      '2025-01': 375.0,
      '2025-06': 385.0,
      '2025-12': 400.0,
      '2026-01': 405.0,
      '2026-04': 416.67,
    },
  },
}

const activeTokenInfo = computed(() => {
  const key = (props.selectedWallet || 'monad').toLowerCase()
  return (
    TOKEN_CONFIGS[key] ?? {
      symbol: key.toUpperCase(),
      name: key.toUpperCase(),
      inceptionYear: 2024,
      history: { 2024: 10.0, 2026: 11.9 },
    }
  )
})

const currentLiveRate = computed(() => {
  const asset = (
    props.selectedWallet || 'monad'
  ).toLowerCase() as SupportedAsset
  const rate = oracle.rates?.[asset]
  if (typeof rate === 'number' && rate > 0) {
    if (asset === 'ecash') {
      return rate * 1_000_000
    }
    return rate
  }
  return activeTokenInfo.value.history[2026] ?? 41.67
})

const activeTokenUnitDisplay = computed(() => {
  const val = currentLiveRate.value
  if (val >= 1000) {
    return `${val.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} AVU`
  }
  return `${val.toFixed(2)} AVU`
})

const activeTokenUnitSubtext = computed(() => {
  const val = currentLiveRate.value
  return `1 ${activeTokenInfo.value.symbol} ≈ ${val.toFixed(2)} kWh`
})

let $q: any = null
try {
  $q = useQuasar()
} catch {
  $q = null
}

const t = useTranslate()

export type TimeRange =
  | 'all'
  | '5y'
  | '1y'
  | '30d'
  | '7d'
  | '24h'
  | 'networks'
  | 'pow'
  | 'asic'
  | 'recent'

// Selected view toggle ('all' | '5y' | '1y' | '30d' | '7d' | '24h' | 'networks' | 'pow' | 'asic' | 'recent')
const selectedRange = ref<TimeRange>('all')

const rangeToggleOptions = computed(() => [
  { label: t('walletPanel.rangeAll'), value: 'all' },
  { label: t('walletPanel.range5Y'), value: '5y' },
  { label: t('walletPanel.range1Y'), value: '1y' },
  { label: t('walletPanel.range30D'), value: '30d' },
  { label: t('walletPanel.range7D'), value: '7d' },
  { label: t('walletPanel.range24H'), value: '24h' },
  { label: t('walletPanel.rangeNetworks'), value: 'networks' },
])

const isFineGrainedRange = computed(() => {
  return ['24h', 'recent', '7d', '30d', '1y'].includes(selectedRange.value)
})

// Metric visibility toggles
const showUsd = ref(true)
const showPow = ref(true)
const showGold = ref(true)
const showToken = ref(true)
const showMilestones = ref(true)

function toggleMetric(metric: 'usd' | 'pow' | 'gold' | 'token' | 'milestones') {
  if (metric === 'usd') showUsd.value = !showUsd.value
  else if (metric === 'pow') showPow.value = !showPow.value
  else if (metric === 'gold') showGold.value = !showGold.value
  else if (metric === 'token') showToken.value = !showToken.value
  else if (metric === 'milestones') showMilestones.value = !showMilestones.value
}

const hasLeftAxis = computed(() => {
  return showUsd.value || showPow.value || showToken.value
})

const hasRightAxis = computed(() => {
  if (isFineGrainedRange.value) {
    return showUsd.value || showPow.value
  }
  return showGold.value || (showToken.value && isLargeTokenScale.value)
})

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
      token: '#c084fc',
      milestone: '#94a3b8',
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
    token: '#7c3aed',
    milestone: '#64748b',
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
  year: number | string
  timeLabel?: string
  usdKwh: number
  goldAvu: number
  powHashRate?: number
  tokenAvu?: number
  centsPerKwh?: number
  goldUsd?: number
  cpiIndex?: number
  notes?: string
}

const allMacroData: MacroPoint[] = [...COMBINED_MACRO_ARCHIVE_1930_PRESENT]

/**
 * Generates fine-grained intraday and multi-day time-series points,
 * anchoring cleanly to the live token rate and energy baskets at the final point ('Now').
 */
function generateTimeSeries(
  count: number,
  labelFn: (idx: number, total: number) => string,
  volToken: number,
  volUsd: number,
  volGold: number,
): MacroPoint[] {
  const modernCtx = getTimestepConversionContext(2026)
  const liveTokenRate = currentLiveRate.value
  const baseUsdKwh = modernCtx.usdKwh
  const baseGoldAvu = modernCtx.goldAvu ?? 31547
  const basePow = modernCtx.powHashRate ?? 11.9
  const points: MacroPoint[] = []

  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1
    const phase = ((i - (count - 1)) / count) * 2 * Math.PI
    const tokenFluctuation =
      Math.sin(phase) * volToken + Math.sin(phase * 2) * (volToken * 0.4)
    const usdFluctuation =
      Math.sin(phase) * volUsd + Math.cos(phase * 1.5) * (volUsd * 0.3)
    const goldFluctuation = Math.sin(phase) * volGold
    const powFluctuation = Math.sin(phase + 0.3) * volUsd

    const tokenVal = isLast
      ? liveTokenRate
      : Math.round(liveTokenRate * (1 + tokenFluctuation) * 100) / 100
    const usdVal = isLast
      ? baseUsdKwh
      : Math.round(baseUsdKwh * (1 + usdFluctuation) * 100) / 100
    const goldVal = isLast
      ? baseGoldAvu
      : Math.round(baseGoldAvu * (1 + goldFluctuation))
    const powVal = isLast
      ? basePow
      : Math.round(basePow * (1 + powFluctuation) * 100) / 100

    const label = labelFn(i, count)
    points.push({
      year: label,
      timeLabel: label,
      usdKwh: usdVal,
      goldAvu: goldVal,
      powHashRate: powVal,
      tokenAvu: tokenVal,
    })
  }

  return points
}

const data24h = computed<MacroPoint[]>(() =>
  generateTimeSeries(
    24,
    (i, total) => {
      const h = total - 1 - i
      return h === 0 ? 'Now' : `-${h}h`
    },
    0.012,
    0.004,
    0.008,
  ),
)

const recentHourlyData = data24h

const data7d = computed<MacroPoint[]>(() =>
  generateTimeSeries(
    28,
    (i, total) => {
      const stepsAgo = total - 1 - i
      if (stepsAgo === 0) return 'Now'
      const days = stepsAgo / 4
      return stepsAgo % 4 === 0
        ? `-${days}d`
        : `-${Math.round(days * 10) / 10}d`
    },
    0.035,
    0.008,
    0.015,
  ),
)

const data30d = computed<MacroPoint[]>(() =>
  generateTimeSeries(
    30,
    (i, total) => {
      const d = total - 1 - i
      return d === 0 ? 'Now' : `-${d}d`
    },
    0.06,
    0.015,
    0.025,
  ),
)

interface MonthlyMacroAnchor {
  monthKey: string
  label: string
  yearNum: number
  usdKwh: number
  goldAvu: number
  powHashRate: number
  tokenRates: Record<string, number>
}

const RECENT_MONTHLY_ANCHORS: MonthlyMacroAnchor[] = [
  // 2023
  {
    monthKey: '2023-01',
    label: 'Jan 2023',
    yearNum: 2023.0,
    usdKwh: 13.0,
    goldAvu: 29200,
    powHashRate: 11.5,
    tokenRates: {
      solana: 286.0,
      monad: 12.0,
      ethereum: 21000.0,
      hyperliquid: 200.0,
      tempo: 13.0,
      ecash: 320.0,
    },
  },
  {
    monthKey: '2023-02',
    label: 'Feb 2023',
    yearNum: 2023.083,
    usdKwh: 13.0,
    goldAvu: 29100,
    powHashRate: 11.5,
    tokenRates: {
      solana: 300.0,
      monad: 12.2,
      ethereum: 21500.0,
      hyperliquid: 205.0,
      tempo: 13.0,
      ecash: 325.0,
    },
  },
  {
    monthKey: '2023-03',
    label: 'Mar 2023',
    yearNum: 2023.167,
    usdKwh: 13.0,
    goldAvu: 29400,
    powHashRate: 11.5,
    tokenRates: {
      solana: 260.0,
      monad: 12.5,
      ethereum: 23000.0,
      hyperliquid: 210.0,
      tempo: 13.0,
      ecash: 330.0,
    },
  },
  {
    monthKey: '2023-04',
    label: 'Apr 2023',
    yearNum: 2023.25,
    usdKwh: 13.0,
    goldAvu: 29500,
    powHashRate: 11.5,
    tokenRates: {
      solana: 280.0,
      monad: 12.8,
      ethereum: 24500.0,
      hyperliquid: 215.0,
      tempo: 13.0,
      ecash: 335.0,
    },
  },
  {
    monthKey: '2023-05',
    label: 'May 2023',
    yearNum: 2023.333,
    usdKwh: 13.0,
    goldAvu: 29300,
    powHashRate: 11.5,
    tokenRates: {
      solana: 260.0,
      monad: 13.0,
      ethereum: 24000.0,
      hyperliquid: 220.0,
      tempo: 13.0,
      ecash: 335.0,
    },
  },
  {
    monthKey: '2023-06',
    label: 'Jun 2023',
    yearNum: 2023.417,
    usdKwh: 12.9,
    goldAvu: 29000,
    powHashRate: 11.5,
    tokenRates: {
      solana: 234.0,
      monad: 13.2,
      ethereum: 24800.0,
      hyperliquid: 225.0,
      tempo: 12.9,
      ecash: 340.0,
    },
  },
  {
    monthKey: '2023-07',
    label: 'Jul 2023',
    yearNum: 2023.5,
    usdKwh: 12.9,
    goldAvu: 29200,
    powHashRate: 11.5,
    tokenRates: {
      solana: 310.0,
      monad: 13.5,
      ethereum: 24200.0,
      hyperliquid: 230.0,
      tempo: 12.9,
      ecash: 345.0,
    },
  },
  {
    monthKey: '2023-08',
    label: 'Aug 2023',
    yearNum: 2023.583,
    usdKwh: 12.9,
    goldAvu: 29100,
    powHashRate: 11.5,
    tokenRates: {
      solana: 270.0,
      monad: 13.8,
      ethereum: 21500.0,
      hyperliquid: 235.0,
      tempo: 12.9,
      ecash: 340.0,
    },
  },
  {
    monthKey: '2023-09',
    label: 'Sep 2023',
    yearNum: 2023.667,
    usdKwh: 13.0,
    goldAvu: 29000,
    powHashRate: 11.5,
    tokenRates: {
      solana: 250.0,
      monad: 14.0,
      ethereum: 21700.0,
      hyperliquid: 240.0,
      tempo: 13.0,
      ecash: 340.0,
    },
  },
  {
    monthKey: '2023-10',
    label: 'Oct 2023',
    yearNum: 2023.75,
    usdKwh: 13.0,
    goldAvu: 29400,
    powHashRate: 11.5,
    tokenRates: {
      solana: 416.0,
      monad: 14.2,
      ethereum: 23500.0,
      hyperliquid: 245.0,
      tempo: 13.0,
      ecash: 345.0,
    },
  },
  {
    monthKey: '2023-11',
    label: 'Nov 2023',
    yearNum: 2023.833,
    usdKwh: 12.9,
    goldAvu: 29600,
    powHashRate: 11.5,
    tokenRates: {
      solana: 750.0,
      monad: 14.5,
      ethereum: 26500.0,
      hyperliquid: 248.0,
      tempo: 12.9,
      ecash: 350.0,
    },
  },
  {
    monthKey: '2023-12',
    label: 'Dec 2023',
    yearNum: 2023.917,
    usdKwh: 12.9,
    goldAvu: 29800,
    powHashRate: 11.5,
    tokenRates: {
      solana: 1300.0,
      monad: 15.0,
      ethereum: 29500.0,
      hyperliquid: 250.0,
      tempo: 12.9,
      ecash: 350.0,
    },
  },

  // 2024
  {
    monthKey: '2024-01',
    label: 'Jan 2024',
    yearNum: 2024.0,
    usdKwh: 12.8,
    goldAvu: 26240,
    powHashRate: 11.6,
    tokenRates: {
      solana: 1250.0,
      monad: 15.1,
      ethereum: 33000.0,
      hyperliquid: 252.0,
      tempo: 12.8,
      ecash: 350.0,
    },
  },
  {
    monthKey: '2024-02',
    label: 'Feb 2024',
    yearNum: 2024.083,
    usdKwh: 12.8,
    goldAvu: 26800,
    powHashRate: 11.6,
    tokenRates: {
      solana: 1390.0,
      monad: 16.0,
      ethereum: 36000.0,
      hyperliquid: 265.0,
      tempo: 12.8,
      ecash: 355.0,
    },
  },
  {
    monthKey: '2024-03',
    label: 'Mar 2024',
    yearNum: 2024.167,
    usdKwh: 12.7,
    goldAvu: 27500,
    powHashRate: 11.6,
    tokenRates: {
      solana: 2330.0,
      monad: 17.2,
      ethereum: 44000.0,
      hyperliquid: 280.0,
      tempo: 12.7,
      ecash: 370.0,
    },
  },
  {
    monthKey: '2024-04',
    label: 'Apr 2024',
    yearNum: 2024.25,
    usdKwh: 12.7,
    goldAvu: 29600,
    powHashRate: 11.7,
    tokenRates: {
      solana: 1840.0,
      monad: 18.0,
      ethereum: 39000.0,
      hyperliquid: 295.0,
      tempo: 12.7,
      ecash: 360.0,
    },
  },
  {
    monthKey: '2024-05',
    label: 'May 2024',
    yearNum: 2024.333,
    usdKwh: 12.6,
    goldAvu: 29800,
    powHashRate: 11.7,
    tokenRates: {
      solana: 2080.0,
      monad: 19.5,
      ethereum: 43000.0,
      hyperliquid: 310.0,
      tempo: 12.6,
      ecash: 365.0,
    },
  },
  {
    monthKey: '2024-06',
    label: 'Jun 2024',
    yearNum: 2024.417,
    usdKwh: 12.5,
    goldAvu: 29500,
    powHashRate: 11.7,
    tokenRates: {
      solana: 1760.0,
      monad: 21.0,
      ethereum: 41000.0,
      hyperliquid: 325.0,
      tempo: 12.5,
      ecash: 355.0,
    },
  },
  {
    monthKey: '2024-07',
    label: 'Jul 2024',
    yearNum: 2024.5,
    usdKwh: 12.5,
    goldAvu: 30125,
    powHashRate: 11.7,
    tokenRates: {
      solana: 2190.0,
      monad: 22.5,
      ethereum: 42000.0,
      hyperliquid: 340.0,
      tempo: 12.5,
      ecash: 360.0,
    },
  },
  {
    monthKey: '2024-08',
    label: 'Aug 2024',
    yearNum: 2024.583,
    usdKwh: 12.5,
    goldAvu: 31200,
    powHashRate: 11.7,
    tokenRates: {
      solana: 1690.0,
      monad: 23.5,
      ethereum: 34000.0,
      hyperliquid: 350.0,
      tempo: 12.5,
      ecash: 350.0,
    },
  },
  {
    monthKey: '2024-09',
    label: 'Sep 2024',
    yearNum: 2024.667,
    usdKwh: 12.6,
    goldAvu: 33000,
    powHashRate: 11.7,
    tokenRates: {
      solana: 1890.0,
      monad: 24.5,
      ethereum: 32500.0,
      hyperliquid: 360.0,
      tempo: 12.6,
      ecash: 355.0,
    },
  },
  {
    monthKey: '2024-10',
    label: 'Oct 2024',
    yearNum: 2024.75,
    usdKwh: 12.6,
    goldAvu: 34400,
    powHashRate: 11.7,
    tokenRates: {
      solana: 2140.0,
      monad: 25.5,
      ethereum: 31500.0,
      hyperliquid: 370.0,
      tempo: 12.6,
      ecash: 360.0,
    },
  },
  {
    monthKey: '2024-11',
    label: 'Nov 2024',
    yearNum: 2024.833,
    usdKwh: 12.6,
    goldAvu: 33500,
    powHashRate: 11.7,
    tokenRates: {
      solana: 3000.0,
      monad: 27.0,
      ethereum: 39500.0,
      hyperliquid: 375.0,
      tempo: 12.6,
      ecash: 375.0,
    },
  },
  {
    monthKey: '2024-12',
    label: 'Dec 2024',
    yearNum: 2024.917,
    usdKwh: 12.5,
    goldAvu: 33125,
    powHashRate: 11.7,
    tokenRates: {
      solana: 2690.0,
      monad: 28.0,
      ethereum: 41000.0,
      hyperliquid: 380.0,
      tempo: 12.5,
      ecash: 370.0,
    },
  },

  // 2025
  {
    monthKey: '2025-01',
    label: 'Jan 2025',
    yearNum: 2025.0,
    usdKwh: 12.4,
    goldAvu: 33230,
    powHashRate: 11.8,
    tokenRates: {
      solana: 2770.0,
      monad: 28.5,
      ethereum: 39000.0,
      hyperliquid: 380.0,
      tempo: 12.4,
      ecash: 375.0,
    },
  },
  {
    monthKey: '2025-02',
    label: 'Feb 2025',
    yearNum: 2025.083,
    usdKwh: 12.4,
    goldAvu: 32800,
    powHashRate: 11.8,
    tokenRates: {
      solana: 2400.0,
      monad: 29.0,
      ethereum: 37500.0,
      hyperliquid: 390.0,
      tempo: 12.4,
      ecash: 378.0,
    },
  },
  {
    monthKey: '2025-03',
    label: 'Mar 2025',
    yearNum: 2025.167,
    usdKwh: 12.4,
    goldAvu: 32500,
    powHashRate: 11.8,
    tokenRates: {
      solana: 1970.0,
      monad: 29.5,
      ethereum: 35000.0,
      hyperliquid: 400.0,
      tempo: 12.4,
      ecash: 380.0,
    },
  },
  {
    monthKey: '2025-04',
    label: 'Apr 2025',
    yearNum: 2025.25,
    usdKwh: 12.3,
    goldAvu: 32100,
    powHashRate: 11.8,
    tokenRates: {
      solana: 1780.0,
      monad: 30.0,
      ethereum: 33500.0,
      hyperliquid: 410.0,
      tempo: 12.3,
      ecash: 382.0,
    },
  },
  {
    monthKey: '2025-05',
    label: 'May 2025',
    yearNum: 2025.333,
    usdKwh: 12.3,
    goldAvu: 31365,
    powHashRate: 11.8,
    tokenRates: {
      solana: 2090.0,
      monad: 31.0,
      ethereum: 36000.0,
      hyperliquid: 420.0,
      tempo: 12.3,
      ecash: 385.0,
    },
  },
  {
    monthKey: '2025-06',
    label: 'Jun 2025',
    yearNum: 2025.417,
    usdKwh: 12.3,
    goldAvu: 31100,
    powHashRate: 11.8,
    tokenRates: {
      solana: 1900.0,
      monad: 32.0,
      ethereum: 34500.0,
      hyperliquid: 430.0,
      tempo: 12.3,
      ecash: 385.0,
    },
  },
  {
    monthKey: '2025-07',
    label: 'Jul 2025',
    yearNum: 2025.5,
    usdKwh: 12.2,
    goldAvu: 30900,
    powHashRate: 11.8,
    tokenRates: {
      solana: 2210.0,
      monad: 33.0,
      ethereum: 36500.0,
      hyperliquid: 440.0,
      tempo: 12.2,
      ecash: 388.0,
    },
  },
  {
    monthKey: '2025-08',
    label: 'Aug 2025',
    yearNum: 2025.583,
    usdKwh: 12.2,
    goldAvu: 30750,
    powHashRate: 11.8,
    tokenRates: {
      solana: 2150.0,
      monad: 34.0,
      ethereum: 35500.0,
      hyperliquid: 445.0,
      tempo: 12.2,
      ecash: 388.0,
    },
  },
  {
    monthKey: '2025-09',
    label: 'Sep 2025',
    yearNum: 2025.667,
    usdKwh: 12.3,
    goldAvu: 31000,
    powHashRate: 11.8,
    tokenRates: {
      solana: 1845.0,
      monad: 35.0,
      ethereum: 33000.0,
      hyperliquid: 450.0,
      tempo: 12.3,
      ecash: 390.0,
    },
  },
  {
    monthKey: '2025-10',
    label: 'Oct 2025',
    yearNum: 2025.75,
    usdKwh: 12.3,
    goldAvu: 31200,
    powHashRate: 11.8,
    tokenRates: {
      solana: 2030.0,
      monad: 36.0,
      ethereum: 34000.0,
      hyperliquid: 455.0,
      tempo: 12.3,
      ecash: 392.0,
    },
  },
  {
    monthKey: '2025-11',
    label: 'Nov 2025',
    yearNum: 2025.833,
    usdKwh: 12.3,
    goldAvu: 31350,
    powHashRate: 11.8,
    tokenRates: {
      solana: 1900.0,
      monad: 37.0,
      ethereum: 33500.0,
      hyperliquid: 460.0,
      tempo: 12.3,
      ecash: 395.0,
    },
  },
  {
    monthKey: '2025-12',
    label: 'Dec 2025',
    yearNum: 2025.917,
    usdKwh: 12.2,
    goldAvu: 31476,
    powHashRate: 11.8,
    tokenRates: {
      solana: 1805.0,
      monad: 38.0,
      ethereum: 32500.0,
      hyperliquid: 465.0,
      tempo: 12.2,
      ecash: 400.0,
    },
  },

  // 2026
  {
    monthKey: '2026-01',
    label: 'Jan 2026',
    yearNum: 2026.0,
    usdKwh: 12.1,
    goldAvu: 31460,
    powHashRate: 11.9,
    tokenRates: {
      solana: 1718.0,
      monad: 39.0,
      ethereum: 31800.0,
      hyperliquid: 470.0,
      tempo: 12.1,
      ecash: 405.0,
    },
  },
  {
    monthKey: '2026-02',
    label: 'Feb 2026',
    yearNum: 2026.083,
    usdKwh: 12.1,
    goldAvu: 31500,
    powHashRate: 11.9,
    tokenRates: {
      solana: 1740.0,
      monad: 40.0,
      ethereum: 31400.0,
      hyperliquid: 472.0,
      tempo: 12.1,
      ecash: 410.0,
    },
  },
  {
    monthKey: '2026-03',
    label: 'Mar 2026',
    yearNum: 2026.167,
    usdKwh: 12.0,
    goldAvu: 31520,
    powHashRate: 11.9,
    tokenRates: {
      solana: 1765.0,
      monad: 41.0,
      ethereum: 31100.0,
      hyperliquid: 475.0,
      tempo: 12.0,
      ecash: 414.0,
    },
  },
  {
    monthKey: '2026-04',
    label: 'Apr 2026',
    yearNum: 2026.25,
    usdKwh: 12.0,
    goldAvu: 31547,
    powHashRate: 11.9,
    tokenRates: {
      solana: 1785.71,
      monad: 41.67,
      ethereum: 30952.38,
      hyperliquid: 476.19,
      tempo: 11.9,
      ecash: 416.67,
    },
  },
]

function getSubAnnualMacroSlice(
  startYear: number,
  endYear: number,
): MacroPoint[] {
  if (endYear >= 2023) {
    const maxBound = endYear >= 2026 ? 2026.5 : endYear + 0.05
    const filtered = RECENT_MONTHLY_ANCHORS.filter(
      m => m.yearNum >= startYear - 0.05 && m.yearNum <= maxBound,
    )

    if (filtered.length >= 2) {
      const tokenKey = (props.selectedWallet || 'monad').toLowerCase()
      const tokenConf = activeTokenInfo.value

      return filtered.map((anchor, idx) => {
        const isLast = idx === filtered.length - 1
        let tokenAvu: number | undefined = undefined

        if (anchor.yearNum >= tokenConf.inceptionYear) {
          if (isLast && anchor.monthKey === '2026-04') {
            tokenAvu = currentLiveRate.value
          } else {
            tokenAvu =
              tokenConf.monthlyHistory?.[anchor.monthKey] ??
              anchor.tokenRates[tokenKey] ??
              tokenConf.history[Math.floor(anchor.yearNum)]
          }
        }

        return {
          year: anchor.yearNum,
          timeLabel: anchor.label,
          usdKwh: anchor.usdKwh,
          goldAvu: anchor.goldAvu,
          powHashRate: anchor.powHashRate,
          tokenAvu,
        }
      })
    }
  }

  // Historical sub-annual slice (e.g. quarterly interpolation)
  const points: MacroPoint[] = []
  const step = 0.25
  const sY = Math.max(1930, startYear)
  const eY = Math.min(2026, endYear)
  for (let y = sY; y <= eY + 0.01; y += step) {
    const pt = interpolateMacroPoint(y)
    const yearInt = Math.floor(y)
    const quarter = Math.round((y - yearInt) / 0.25) + 1
    const qLabel = quarter <= 4 ? `Q${quarter} ${yearInt}` : `${yearInt}`
    points.push({
      year: Math.round(y * 100) / 100,
      timeLabel: qLabel,
      usdKwh: pt.usdKwh,
      goldAvu: pt.goldAvu,
      powHashRate: pt.powHashRate,
      centsPerKwh: pt.centsPerKwh,
      goldUsd: pt.goldUsd,
      cpiIndex: pt.cpiIndex,
      notes: pt.notes,
    })
  }
  return points.length >= 2 ? points : allMacroData.slice(0, 2)
}

const data1y = computed<MacroPoint[]>(() => {
  const last12 = RECENT_MONTHLY_ANCHORS.slice(-12)
  const tokenKey = (props.selectedWallet || 'monad').toLowerCase()
  const tokenConf = activeTokenInfo.value

  return last12.map((anchor, idx) => {
    const isLast = idx === last12.length - 1
    const stepsAgo = 11 - idx
    const timeLabel = stepsAgo === 0 ? 'Now' : `-${stepsAgo}m`

    let tokenAvu: number | undefined = undefined
    if (anchor.yearNum >= tokenConf.inceptionYear) {
      if (isLast) {
        tokenAvu = currentLiveRate.value
      } else {
        tokenAvu =
          tokenConf.monthlyHistory?.[anchor.monthKey] ??
          anchor.tokenRates[tokenKey] ??
          tokenConf.history[Math.floor(anchor.yearNum)]
      }
    }

    return {
      year: timeLabel,
      timeLabel: timeLabel,
      usdKwh: anchor.usdKwh,
      goldAvu: anchor.goldAvu,
      powHashRate: anchor.powHashRate,
      tokenAvu: tokenAvu ?? currentLiveRate.value,
    }
  })
})

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

// Custom Zoom State
const customZoomRange = ref<{
  startIndex: number
  endIndex: number
  startYear?: number
  endYear?: number
} | null>(null)
const isCustomZoomed = computed(() => customZoomRange.value !== null)

function resetCustomZoom() {
  customZoomRange.value = null
}

watch(selectedRange, () => {
  resetCustomZoom()
})

const currentRangeData = computed<MacroPoint[]>(() => {
  switch (selectedRange.value) {
    case '24h':
    case 'recent':
      return data24h.value
    case '7d':
      return data7d.value
    case '30d':
      return data30d.value
    case '1y':
      return data1y.value
    case '5y':
      return allMacroData.filter(p => (p.year as number) >= 2021)
    case 'pow':
      return allMacroData.filter(p => (p.year as number) >= 2009)
    case 'asic':
      return allMacroData.filter(p => (p.year as number) >= 2020)
    case 'all':
    default:
      return allMacroData
  }
})

const activeMacroData = computed<MacroPoint[]>(() => {
  const raw = currentRangeData.value
  if (!customZoomRange.value) {
    return raw
  }
  const { startIndex, endIndex, startYear, endYear } = customZoomRange.value

  if (isFineGrainedRange.value) {
    const clampedStart = Math.max(0, Math.min(startIndex, raw.length - 2))
    const clampedEnd = Math.max(
      clampedStart + 1,
      Math.min(endIndex, raw.length - 1),
    )
    return raw.slice(clampedStart, clampedEnd + 1)
  }

  const rawStartYear =
    startYear ??
    (typeof raw[startIndex]?.year === 'number'
      ? (raw[startIndex].year as number)
      : undefined)
  const rawEndYear =
    endYear ??
    (typeof raw[endIndex]?.year === 'number'
      ? (raw[endIndex].year as number)
      : undefined)

  if (typeof rawStartYear === 'number' && typeof rawEndYear === 'number') {
    const yearSpan = rawEndYear - rawStartYear
    if (yearSpan <= 3.5 || rawStartYear >= 2023) {
      return getSubAnnualMacroSlice(rawStartYear, rawEndYear)
    }
  }

  const clampedStart = Math.max(0, Math.min(startIndex, raw.length - 2))
  const clampedEnd = Math.max(
    clampedStart + 1,
    Math.min(endIndex, raw.length - 1),
  )
  return raw.slice(clampedStart, clampedEnd + 1)
})

const svgRef = ref<SVGSVGElement | null>(null)
const isDragging = ref(false)
const dragStartX = ref<number | null>(null)
const dragCurrentX = ref<number | null>(null)

function getSvgCoordinates(event: MouseEvent): { x: number; y: number } | null {
  if (!svgRef.value) return null
  const rect = svgRef.value.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const x = ((event.clientX - rect.left) / rect.width) * 680
  const y = ((event.clientY - rect.top) / rect.height) * 290
  return { x, y }
}

const dragSelectionBox = computed(() => {
  if (
    !isDragging.value ||
    dragStartX.value === null ||
    dragCurrentX.value === null
  ) {
    return null
  }
  const x1 = Math.min(dragStartX.value, dragCurrentX.value)
  const x2 = Math.max(dragStartX.value, dragCurrentX.value)
  const width = x2 - x1
  if (width < 2) return null
  return {
    x: x1,
    width,
  }
})

function onSvgMouseDown(event: MouseEvent) {
  if (selectedRange.value === 'networks') return
  const pt = getSvgCoordinates(event)
  if (!pt) return
  if (pt.x >= 55 && pt.x <= 625 && pt.y >= 20 && pt.y <= 240) {
    isDragging.value = true
    dragStartX.value = pt.x
    dragCurrentX.value = pt.x
    clearHover()
  }
}

function onSvgMouseMove(event: MouseEvent) {
  const pt = getSvgCoordinates(event)
  if (!pt) return

  if (isDragging.value) {
    dragCurrentX.value = Math.max(55, Math.min(625, pt.x))
    return
  }

  if (selectedRange.value === 'networks') {
    return
  }

  // If outside plot area, clear hover
  if (pt.x < 45 || pt.x > 635 || pt.y < 10 || pt.y > 265) {
    clearHover()
    return
  }

  // Check if cursor is hovering near a hardware milestone marker (near top marker icon)
  if (showMilestones.value) {
    const milestones = activeMilestonesMapped.value
    const hoveredMilestone = milestones.find(
      m => Math.abs(pt.x - m.x) <= 10 && pt.y <= 55,
    )
    activeHoverMilestone.value = hoveredMilestone || null
  } else {
    activeHoverMilestone.value = null
  }

  // Find nearest data point along the X axis across ALL points
  const points = macroPointsMapped.value
  if (!points.length) return

  let closest: MappedMacroPoint = points[0]
  let minDiff = Math.abs(points[0].x - pt.x)

  for (let i = 1; i < points.length; i++) {
    const diff = Math.abs(points[i].x - pt.x)
    if (diff < minDiff) {
      minDiff = diff
      closest = points[i]
    }
  }

  activeHoverPoint.value = closest
}

function onSvgMouseUp() {
  if (!isDragging.value) return
  if (dragStartX.value !== null && dragCurrentX.value !== null) {
    const x1 = Math.min(dragStartX.value, dragCurrentX.value)
    const x2 = Math.max(dragStartX.value, dragCurrentX.value)
    const rawPoints = macroPointsMapped.value
    if (x2 - x1 >= 15 && rawPoints.length >= 2) {
      let startIndex = 0
      let endIndex = rawPoints.length - 1

      for (let i = 0; i < rawPoints.length; i++) {
        if (rawPoints[i].x <= x1) startIndex = i
        if (rawPoints[i].x <= x2) endIndex = i
      }

      if (x2 >= rawPoints[rawPoints.length - 1].x) {
        endIndex = rawPoints.length - 1
      }

      if (endIndex - startIndex >= 1) {
        const baseOffset = customZoomRange.value?.startIndex ?? 0
        const startPt = rawPoints[startIndex]
        const endPt = rawPoints[endIndex]
        const startY =
          typeof startPt?.year === 'number'
            ? startPt.year
            : parseFloat(String(startPt?.year))
        const endY =
          typeof endPt?.year === 'number'
            ? endPt.year
            : parseFloat(String(endPt?.year))
        customZoomRange.value = {
          startIndex: baseOffset + startIndex,
          endIndex: baseOffset + endIndex,
          startYear: isNaN(startY) ? undefined : startY,
          endYear: isNaN(endY) ? undefined : endY,
        }
      }
    }
  }
  isDragging.value = false
  dragStartX.value = null
  dragCurrentX.value = null
}

function onSvgMouseLeave() {
  if (isDragging.value) {
    onSvgMouseUp()
  }
  clearHover()
}

const rangeMinYear = computed(() => {
  if (selectedRange.value === '5y') return 2021
  if (selectedRange.value === 'asic') return 2020
  if (selectedRange.value === 'pow') return 2009
  return 1930
})

const rangeMaxYear = computed(() => 2026)

const isLargeTokenScale = computed(() => {
  return currentLiveRate.value > 200
})

const leftAxisValues = computed(() => {
  const slice = activeMacroData.value
  const vals: number[] = []

  for (const pt of slice) {
    if (showUsd.value && typeof pt.usdKwh === 'number') {
      vals.push(pt.usdKwh)
    }
    if (showPow.value && typeof pt.powHashRate === 'number') {
      vals.push(pt.powHashRate)
    }
    if (showToken.value && !isLargeTokenScale.value) {
      const yearNum = typeof pt.year === 'number' ? pt.year : 2026
      if (yearNum >= activeTokenInfo.value.inceptionYear) {
        const tVal =
          pt.tokenAvu ??
          (yearNum === 2026
            ? currentLiveRate.value
            : activeTokenInfo.value.history[Math.floor(yearNum)])
        if (typeof tVal === 'number') {
          vals.push(tVal)
        }
      }
    }
  }

  return vals
})

const usdMaxLimit = computed(() => {
  const vals = leftAxisValues.value
  if (!vals.length) return 150

  const rawMax = Math.max(...vals)

  // In unzoomed 'all' range with USD visible, maintain the 150 benchmark ceiling
  if (
    selectedRange.value === 'all' &&
    !isCustomZoomed.value &&
    showUsd.value &&
    rawMax > 50
  ) {
    return Math.max(150, Math.ceil(rawMax / 10) * 10)
  }

  // Otherwise, scale dynamically based on the active series in view
  const target = rawMax * 1.15
  if (target <= 10) return 10
  if (target <= 20) return 20
  if (target <= 30) return 30
  if (target <= 50) return 50
  if (target <= 100) return 100
  return Math.ceil(target / 10) * 10
})

const usdMinLimit = computed(() => 0)

const goldMaxLimit = computed(() => {
  if (!showGold.value && showToken.value && isLargeTokenScale.value) {
    const slice = activeMacroData.value
    const tokenVals = slice
      .map(p => p.tokenAvu)
      .filter((v): v is number => typeof v === 'number')
    if (tokenVals.length) {
      const maxVal = Math.max(...tokenVals, currentLiveRate.value)
      return Math.ceil((maxVal * 1.15) / 100) * 100
    }
  }
  return 35000
})

const goldMinLimit = computed(() => {
  if (!showGold.value && showToken.value && isLargeTokenScale.value) {
    return 0
  }
  if (selectedRange.value === '5y' || selectedRange.value === 'asic')
    return 20000
  if (selectedRange.value === 'pow') return 10000
  return 0
})

// Axis Labels
const usdMaxLabel = computed(() => `${usdMaxLimit.value}`)
const usdMidLabel = computed(() => `${Math.round(usdMaxLimit.value / 2)}`)
const usdMinLabel = computed(() => `${usdMinLimit.value}`)

const goldMaxLabel = computed(() => {
  if (!showGold.value && showToken.value && isLargeTokenScale.value) {
    return formatTokenAxisLabel(goldMaxLimit.value)
  }
  return `${Math.round(goldMaxLimit.value / 1000)}k`
})
const goldMidLabel = computed(() => {
  if (!showGold.value && showToken.value && isLargeTokenScale.value) {
    return formatTokenAxisLabel((goldMaxLimit.value + goldMinLimit.value) / 2)
  }
  return `${Math.round((goldMaxLimit.value + goldMinLimit.value) / 2000)}k`
})
const goldMinLabel = computed(() => {
  if (!showGold.value && showToken.value && isLargeTokenScale.value) {
    return formatTokenAxisLabel(goldMinLimit.value)
  }
  return `${Math.round(goldMinLimit.value / 1000)}k`
})

function formatTokenAxisLabel(val: number): string {
  if (val >= 1000) {
    const kVal = val / 1000
    return kVal % 1 === 0 ? `${kVal.toFixed(0)}k` : `${kVal.toFixed(1)}k`
  }
  if (val >= 100) {
    return `${Math.round(val)}`
  }
  return `${val.toFixed(1)}`
}

function formatTickLabel(point: MacroPoint): string {
  if (point.timeLabel) {
    return point.timeLabel
  }
  return String(point.year)
}

function shouldShowTick(idx: number, total: number): boolean {
  if (total <= 14) return true
  const pt = activeMacroData.value[idx]
  if (
    pt &&
    typeof pt.year === 'number' &&
    Number.isInteger(pt.year) &&
    total > 50
  ) {
    return (pt.year - 1930) % 20 === 0 || idx === total - 1
  }
  if (total <= 25) return idx % 4 === 0 || idx === total - 1
  if (total <= 35) return idx % 5 === 0 || idx === total - 1
  return idx % Math.ceil(total / 6) === 0 || idx === total - 1
}

const leftAxisMaxLabel = computed(() => {
  if (isFineGrainedRange.value) {
    const slice = activeMacroData.value
    const tokenVals = slice.map(p => p.tokenAvu ?? currentLiveRate.value)
    const tokenMin = Math.min(...tokenVals)
    const tokenMax = Math.max(...tokenVals)
    const tokenSpan = Math.max(tokenMax - tokenMin, tokenMax * 0.03, 0.2)
    return formatTokenAxisLabel(tokenMax + tokenSpan * 0.25)
  }
  return usdMaxLabel.value
})

const leftAxisMidLabel = computed(() => {
  if (isFineGrainedRange.value) {
    const slice = activeMacroData.value
    const tokenVals = slice.map(p => p.tokenAvu ?? currentLiveRate.value)
    const tokenMin = Math.min(...tokenVals)
    const tokenMax = Math.max(...tokenVals)
    return formatTokenAxisLabel((tokenMax + tokenMin) / 2)
  }
  return usdMidLabel.value
})

const leftAxisMinLabel = computed(() => {
  if (isFineGrainedRange.value) {
    const slice = activeMacroData.value
    const tokenVals = slice.map(p => p.tokenAvu ?? currentLiveRate.value)
    const tokenMin = Math.min(...tokenVals)
    const tokenMax = Math.max(...tokenVals)
    const tokenSpan = Math.max(tokenMax - tokenMin, tokenMax * 0.03, 0.2)
    return formatTokenAxisLabel(Math.max(0, tokenMin - tokenSpan * 0.25))
  }
  return usdMinLabel.value
})

const rightAxisMaxLabel = computed(() => {
  if (isFineGrainedRange.value) {
    const slice = activeMacroData.value
    const energyVals: number[] = []
    if (showUsd.value) {
      energyVals.push(...slice.map(p => p.usdKwh))
    }
    if (showPow.value) {
      energyVals.push(
        ...slice
          .filter(p => p.powHashRate !== undefined)
          .map(p => p.powHashRate!),
      )
    }
    if (!energyVals.length) {
      energyVals.push(10, 15)
    }
    const energyMin = Math.min(...energyVals)
    const energyMax = Math.max(...energyVals)
    const energySpan = Math.max(energyMax - energyMin, 0.25)
    return (energyMax + energySpan * 0.25).toFixed(1)
  }
  return goldMaxLabel.value
})

const rightAxisMidLabel = computed(() => {
  if (isFineGrainedRange.value) {
    const slice = activeMacroData.value
    const energyVals: number[] = []
    if (showUsd.value) {
      energyVals.push(...slice.map(p => p.usdKwh))
    }
    if (showPow.value) {
      energyVals.push(
        ...slice
          .filter(p => p.powHashRate !== undefined)
          .map(p => p.powHashRate!),
      )
    }
    if (!energyVals.length) {
      energyVals.push(10, 15)
    }
    const energyMin = Math.min(...energyVals)
    const energyMax = Math.max(...energyVals)
    return ((energyMax + energyMin) / 2).toFixed(1)
  }
  return goldMidLabel.value
})

const rightAxisMinLabel = computed(() => {
  if (isFineGrainedRange.value) {
    const slice = activeMacroData.value
    const energyVals: number[] = []
    if (showUsd.value) {
      energyVals.push(...slice.map(p => p.usdKwh))
    }
    if (showPow.value) {
      energyVals.push(
        ...slice
          .filter(p => p.powHashRate !== undefined)
          .map(p => p.powHashRate!),
      )
    }
    if (!energyVals.length) {
      energyVals.push(10, 15)
    }
    const energyMin = Math.min(...energyVals)
    const energyMax = Math.max(...energyVals)
    const energySpan = Math.max(energyMax - energyMin, 0.25)
    return Math.max(0, energyMin - energySpan * 0.25).toFixed(1)
  }
  return goldMinLabel.value
})

const macroYGrid = [55, 113, 172, 230]

interface MappedMacroPoint extends MacroPoint {
  x: number
  usdY: number
  goldY: number
  powY: number | null
  tokenAvu?: number
  tokenY: number | null
}

const macroPointsMapped = computed<MappedMacroPoint[]>(() => {
  const xMin = 65
  const xMax = 615
  const yTop = 30
  const yBottom = 230
  const yHeight = yBottom - yTop

  const slice = activeMacroData.value
  const count = slice.length
  if (count === 0) return []

  if (isFineGrainedRange.value) {
    const tokenVals = slice.map(p => p.tokenAvu ?? currentLiveRate.value)
    const tokenMin = Math.min(...tokenVals)
    const tokenMax = Math.max(...tokenVals)
    const tokenSpan = Math.max(tokenMax - tokenMin, tokenMax * 0.03, 0.2)
    const tokenYMin = Math.max(0, tokenMin - tokenSpan * 0.25)
    const tokenYMax = tokenMax + tokenSpan * 0.25

    const energyVals: number[] = []
    if (showUsd.value) {
      energyVals.push(...slice.map(p => p.usdKwh))
    }
    if (showPow.value) {
      energyVals.push(
        ...slice
          .filter(p => p.powHashRate !== undefined)
          .map(p => p.powHashRate!),
      )
    }
    if (!energyVals.length) {
      energyVals.push(10, 15)
    }
    const energyMin = Math.min(...energyVals)
    const energyMax = Math.max(...energyVals)
    const energySpan = Math.max(energyMax - energyMin, 0.25)
    const energyYMin = Math.max(0, energyMin - energySpan * 0.25)
    const energyYMax = energyMax + energySpan * 0.25

    const goldVals = slice.map(p => p.goldAvu)
    const goldMin = Math.min(...goldVals)
    const goldMax = Math.max(...goldVals)
    const goldSpan = Math.max(goldMax - goldMin, 200)
    const goldYMin = Math.max(0, goldMin - goldSpan * 0.25)
    const goldYMax = goldMax + goldSpan * 0.25

    return slice.map((pt, i) => {
      const x =
        count === 1
          ? (xMin + xMax) / 2
          : xMin + (i / (count - 1)) * (xMax - xMin)
      const usdY =
        yBottom -
        ((pt.usdKwh - energyYMin) / (energyYMax - energyYMin)) * yHeight
      const goldY =
        yBottom - ((pt.goldAvu - goldYMin) / (goldYMax - goldYMin)) * yHeight
      const powY =
        pt.powHashRate !== undefined
          ? yBottom -
            ((pt.powHashRate - energyYMin) / (energyYMax - energyYMin)) *
              yHeight
          : null
      const tokenAvu = pt.tokenAvu ?? currentLiveRate.value
      const tokenY =
        yBottom - ((tokenAvu - tokenYMin) / (tokenYMax - tokenYMin)) * yHeight

      return {
        ...pt,
        x: Math.round(x * 10) / 10,
        usdY: Math.round(usdY * 10) / 10,
        goldY: Math.round(goldY * 10) / 10,
        powY: powY !== null ? Math.round(powY * 10) / 10 : null,
        tokenAvu,
        tokenY: Math.round(tokenY * 10) / 10,
      }
    })
  }

  const minYear = rangeMinYear.value
  const maxYear = rangeMaxYear.value
  const maxUsd = usdMaxLimit.value
  const minGold = goldMinLimit.value
  const maxGold = goldMaxLimit.value

  return slice.map((pt, i) => {
    const yearNum = typeof pt.year === 'number' ? pt.year : 2026
    const x =
      isCustomZoomed.value || count === 1
        ? count === 1
          ? (xMin + xMax) / 2
          : xMin + (i / (count - 1)) * (xMax - xMin)
        : xMin + ((yearNum - minYear) / (maxYear - minYear)) * (xMax - xMin)

    const usdY = yBottom - (Math.min(pt.usdKwh, maxUsd) / maxUsd) * yHeight
    const goldFrac = Math.max(pt.goldAvu - minGold, 0) / (maxGold - minGold)
    const goldY = yBottom - goldFrac * yHeight
    const powY =
      pt.powHashRate !== undefined
        ? yBottom - (Math.min(pt.powHashRate, maxUsd) / maxUsd) * yHeight
        : null

    let tokenAvu: number | undefined = pt.tokenAvu
    if (
      tokenAvu === undefined &&
      yearNum >= activeTokenInfo.value.inceptionYear
    ) {
      tokenAvu =
        yearNum === 2026
          ? currentLiveRate.value
          : activeTokenInfo.value.history[Math.floor(yearNum)]
    }

    let tokenY: number | null = null
    if (tokenAvu !== undefined) {
      if (!isLargeTokenScale.value) {
        tokenY = yBottom - (Math.min(tokenAvu, maxUsd) / maxUsd) * yHeight
      } else {
        const goldFrac = Math.max(tokenAvu - minGold, 0) / (maxGold - minGold)
        tokenY = yBottom - Math.min(goldFrac, 1.0) * yHeight
      }
    }

    return {
      ...pt,
      x: Math.round(x * 10) / 10,
      usdY: Math.round(usdY * 10) / 10,
      goldY: Math.round(goldY * 10) / 10,
      powY: powY !== null ? Math.round(powY * 10) / 10 : null,
      tokenAvu,
      tokenY: tokenY !== null ? Math.round(tokenY * 10) / 10 : null,
    }
  })
})

const activeMilestonesMapped = computed(() => {
  if (isFineGrainedRange.value || isCustomZoomed.value) {
    return []
  }
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

const macroTokenPoints = computed(() => {
  return macroPointsMapped.value.filter(
    (p): p is MappedMacroPoint & { tokenY: number; tokenAvu: number } =>
      p.tokenY !== null && p.tokenAvu !== undefined,
  )
})

const macroTokenLinePath = computed(() => {
  const pts = macroTokenPoints.value
  if (pts.length < 2) return ''
  return pts.reduce(
    (acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.tokenY}`,
    '',
  )
})

function formatTokenAvuHover(avu: number): string {
  if (avu >= 1000) {
    return `${avu.toLocaleString('en-US', {
      maximumFractionDigits: 1,
    })} AVU (kWh)`
  }
  return `${avu.toFixed(1)} AVU (kWh)`
}

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

const activeTooltipEntries = computed(() => {
  if (!activeHoverPoint.value) return []
  const pt = activeHoverPoint.value
  const entries: Array<{ label: string; color: string; testId?: string }> = []

  if (showUsd.value && typeof pt.usdKwh === 'number') {
    entries.push({
      label: `USD: ${pt.usdKwh.toFixed(1)} kWh/$`,
      color: themeColors.value.usd,
    })
  }

  if (showGold.value && typeof pt.goldAvu === 'number') {
    entries.push({
      label: `Gold: ${pt.goldAvu.toLocaleString('en-US')} AVU/oz`,
      color: themeColors.value.gold,
    })
  }

  if (showPow.value && pt.powHashRate !== undefined) {
    entries.push({
      label: `PoW: ${pt.powHashRate} kWh/$`,
      color: themeColors.value.pow,
    })
  }

  if (showToken.value && pt.tokenAvu !== undefined) {
    entries.push({
      label: `${activeTokenInfo.value.symbol}: ${formatTokenAvuHover(
        pt.tokenAvu,
      )}`,
      color: themeColors.value.token,
      testId: 'chart-tooltip-token',
    })
  }

  return entries
})

const macroTooltipY = computed(() => {
  if (!activeHoverPoint.value) return 0
  const pt = activeHoverPoint.value
  const targetY =
    (showToken.value && pt.tokenY !== null ? pt.tokenY : null) ??
    (showUsd.value ? pt.usdY : null) ??
    (showPow.value && pt.powY !== null ? pt.powY : null) ??
    pt.goldY
  return Math.max(30, Math.min(targetY - 40, 140))
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

const activeOrLatestPoint = computed<MappedMacroPoint | null>(() => {
  if (activeHoverPoint.value) return activeHoverPoint.value
  const points = macroPointsMapped.value
  if (!points || points.length === 0) return null
  return points[points.length - 1]
})

const currentInspectionDate = computed(() => {
  const pt = activeOrLatestPoint.value
  if (!pt) return '\u2014'
  return pt.timeLabel || String(pt.year)
})

const currentUsdDisplay = computed(() => {
  const pt = activeOrLatestPoint.value
  if (!pt || typeof pt.usdKwh !== 'number') return '\u2014'
  return `${pt.usdKwh.toFixed(1)} kWh/$`
})

const currentGoldDisplay = computed(() => {
  const pt = activeOrLatestPoint.value
  if (!pt || typeof pt.goldAvu !== 'number') return '\u2014'
  return `${pt.goldAvu.toLocaleString('en-US')} AVU/oz`
})

const currentPowDisplay = computed(() => {
  const pt = activeOrLatestPoint.value
  if (!pt || pt.powHashRate === undefined || pt.powHashRate === null)
    return '\u2014'
  return `${pt.powHashRate} kWh/$`
})

const currentTokenDisplay = computed(() => {
  const pt = activeOrLatestPoint.value
  if (!pt || pt.tokenAvu === undefined || pt.tokenAvu === null) return '\u2014'
  return formatTokenAvuHover(pt.tokenAvu)
})

const activeOrLatestNetworkBar = computed(() => {
  if (activeHoverBar.value) return activeHoverBar.value
  const bars = networkBarsMapped.value
  if (!bars || bars.length === 0) {
    return {
      id: 'btc',
      name: 'BTC',
      costKwh: 0.084,
      spreadPercent: 0,
      algorithm: 'SHA-256',
      spreadLabel: 'Baseline',
      isHighlight: false,
    }
  }
  return bars.find(b => b.isHighlight) || bars[0]
})

const currentNetworkDisplay = computed(() => {
  return activeOrLatestNetworkBar.value
})

function formatNetworkCost(cost: number): string {
  return `$${cost.toFixed(3)}/kWh`
}

function formatNetworkTooltipText(bar: MappedNetworkBar): string {
  return `${bar.name} (${bar.algorithm}) Energy Cost: $${bar.costKwh.toFixed(
    3,
  )}/kWh Arbitrage Yield: ${bar.spreadLabel}`
}
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
