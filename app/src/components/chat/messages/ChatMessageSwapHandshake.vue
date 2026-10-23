<template>
  <div
    v-if="resolvedState"
    class="swap-handshake-card q-pa-md rounded-borders"
    data-testid="swap-handshake-card"
  >
    <!-- Header: Mode Title + Swap ID + Phase Badge -->
    <div class="row items-center justify-between q-mb-sm">
      <div class="row items-center q-gutter-xs">
        <span class="swap-mode-pill text-caption text-weight-bold">
          {{ modeLabel }}
        </span>
        <span
          class="swap-id-pill text-caption font-monospace"
          :title="resolvedState.swapId"
          data-testid="swap-id"
        >
          {{ shortSwapId }}
        </span>
      </div>
      <q-badge
        :color="phaseBadgeColor"
        class="swap-phase-badge text-weight-bold"
        data-testid="swap-phase-badge"
      >
        {{ phaseBadgeText }}
      </q-badge>
    </div>

    <!-- 4-Step Progress Indicator -->
    <div
      class="swap-stepper row items-center justify-between q-mb-md"
      data-testid="swap-progress-steps"
    >
      <div
        v-for="(step, idx) in progressSteps"
        :key="step.key"
        class="swap-step-item row items-center"
        :class="{
          'swap-step-done': step.done,
          'swap-step-active': step.active,
        }"
      >
        <span class="swap-step-dot">{{ step.indexText }}</span>
        <span class="swap-step-label text-caption">{{ step.label }}</span>
        <span v-if="idx < progressSteps.length - 1" class="swap-step-arrow">
          {{ arrowSymbol }}
        </span>
      </div>
    </div>

    <!-- Give Leg <-> Want Leg Amounts & Chain Badges -->
    <div class="swap-legs-grid row items-stretch q-gutter-sm q-mb-sm">
      <div
        class="col swap-leg-box q-pa-sm rounded-borders"
        data-testid="swap-give-leg"
      >
        <div class="text-caption swap-leg-heading">{{ giveHeadingText }}</div>
        <div class="text-subtitle1 text-weight-bold swap-leg-amount">
          {{ giveAmountText }}
        </div>
        <div class="row items-center q-gutter-xs q-mt-xs">
          <q-badge
            outline
            color="cyan-4"
            class="swap-chain-badge"
            data-testid="swap-give-chain"
          >
            {{ resolvedState.giveLeg.chainKey }}
          </q-badge>
          <span class="text-caption swap-recipient-text font-monospace">
            {{ shortAddress(resolvedState.giveLeg.recipientAddress) }}
          </span>
        </div>
      </div>

      <div class="swap-legs-divider column justify-center items-center">
        <span class="swap-exchange-glyph">{{ exchangeGlyph }}</span>
      </div>

      <div
        class="col swap-leg-box q-pa-sm rounded-borders"
        data-testid="swap-want-leg"
      >
        <div class="text-caption swap-leg-heading">{{ wantHeadingText }}</div>
        <div class="text-subtitle1 text-weight-bold swap-leg-amount">
          {{ wantAmountText }}
        </div>
        <div class="row items-center q-gutter-xs q-mt-xs">
          <q-badge
            outline
            color="amber-4"
            class="swap-chain-badge"
            data-testid="swap-want-chain"
          >
            {{ resolvedState.wantLeg.chainKey }}
          </q-badge>
          <span class="text-caption swap-recipient-text font-monospace">
            {{ shortAddress(resolvedState.wantLeg.recipientAddress) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Optional Memo -->
    <div
      v-if="resolvedState.memo"
      class="text-caption swap-memo-row q-mb-xs"
      data-testid="swap-memo"
    >
      {{ resolvedState.memo }}
    </div>

    <!-- Hashlock & Settlement Metadata -->
    <div
      class="text-caption swap-meta-row font-monospace q-mb-xs"
      data-testid="swap-hashlock"
    >
      {{ hashlockSummaryText }}
    </div>

    <div
      v-if="resolvedState.revealedPreimageHex"
      class="text-caption text-positive font-monospace q-mb-xs"
      data-testid="swap-revealed-preimage"
    >
      {{ preimageSummaryText }}
    </div>

    <!-- Multi-Device Execution Lease Status Banner -->
    <div
      v-if="activeLease"
      class="swap-lease-banner row items-center justify-between q-pa-xs q-mb-sm rounded-borders"
      :class="leaseBannerClass"
      data-testid="swap-device-lease"
    >
      <span class="text-caption">{{ leaseStatusText }}</span>
      <q-btn
        v-if="requiresFailoverTakeover"
        dense
        no-caps
        color="warning"
        text-color="dark"
        size="sm"
        :label="resumeOnThisDeviceLabel"
        data-testid="swap-takeover-btn"
        @click="onTakeoverLease"
      />
    </div>

    <!-- Lifecycle Action Buttons -->
    <div
      v-if="!isTerminalPhase"
      class="row items-center justify-end q-gutter-xs q-mt-xs"
      data-testid="swap-actions-row"
    >
      <q-btn
        v-if="showAcceptButton"
        dense
        no-caps
        color="primary"
        :label="acceptAndLockLabel"
        :disable="!canExecuteAction('accept_and_lock')"
        data-testid="swap-accept-btn"
        @click="onAction('accept_and_lock')"
      />
      <q-btn
        v-if="showCounterLockButton"
        dense
        no-caps
        color="secondary"
        :label="counterLockLabel"
        :disable="!canExecuteAction('counter_lock')"
        data-testid="swap-counter-lock-btn"
        @click="onAction('counter_lock')"
      />
      <q-btn
        v-if="showSettleButton"
        dense
        no-caps
        color="positive"
        :label="settleClaimLabel"
        :disable="!canExecuteAction('settle_claim')"
        data-testid="swap-settle-btn"
        @click="onAction('settle_claim')"
      />
      <q-btn
        v-if="showRefundButton"
        dense
        no-caps
        outline
        color="warning"
        :label="refundLabel"
        :disable="!canExecuteAction('refund')"
        data-testid="swap-refund-btn"
        @click="onAction('refund')"
      />
      <q-btn
        v-if="showCancelButton"
        dense
        no-caps
        flat
        color="negative"
        :label="cancelLabel"
        :disable="!canExecuteAction('cancel')"
        data-testid="swap-cancel-btn"
        @click="onAction('cancel')"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, type PropType } from 'vue'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  foldSwapHandshakeState,
  formatSwapLegAmount,
  type FoldedSwapHandshakeState,
  type SwapDeviceLeaseState,
  type SwapHandshakeAction,
  type SwapHandshakePayload,
  type SwapHandshakeRole,
} from '@frank/wallet/message-item-plugins/swap-handshake'
import { useTranslate } from '../../../composables/useTranslate'

interface ProgressStepView {
  key: string
  indexText: string
  label: string
  done: boolean
  active: boolean
}

function tr(
  $t: (key: string, params?: Record<string, unknown>) => string,
  key: string,
  fallback: string,
  params?: Record<string, unknown>,
): string {
  const value = $t(key, params)
  if (!value || value === key) {
    return fallback
  }
  return value
}

export default defineComponent({
  name: 'ChatMessageSwapHandshake',
  props: {
    state: {
      type: Object as PropType<FoldedSwapHandshakeState | null>,
      default: null,
    },
    item: {
      type: Object as PropType<
        ApplicationMessageItem | SwapHandshakePayload | null
      >,
      default: null,
    },
    items: {
      type: Array as PropType<
        Array<ApplicationMessageItem | SwapHandshakePayload>
      >,
      default: () => [],
    },
    localDeviceId: {
      type: String,
      default: undefined,
    },
    localAddress: {
      type: String,
      default: undefined,
    },
    localRole: {
      type: String as PropType<SwapHandshakeRole | undefined>,
      default: undefined,
    },
    nowMs: {
      type: Number,
      default: undefined,
    },
    outbound: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['action', 'takeover'],
  setup(props, { emit }) {
    const $t = useTranslate()

    const resolvedState = computed<FoldedSwapHandshakeState | null>(() => {
      if (props.state) {
        return props.state
      }
      const sourceItems =
        props.items && props.items.length > 0
          ? props.items
          : props.item
          ? [props.item]
          : []
      if (sourceItems.length === 0) {
        return null
      }
      return foldSwapHandshakeState(sourceItems, {
        localDeviceId: props.localDeviceId,
        localAddress: props.localAddress,
        localRole: props.localRole,
        nowMs: props.nowMs,
      })
    })

    const activeLease = computed<SwapDeviceLeaseState | null>(() => {
      const s = resolvedState.value
      if (!s) return null
      if (props.localRole === 'taker' && s.takerLease) {
        return s.takerLease
      }
      if (props.localRole === 'maker' && s.makerLease) {
        return s.makerLease
      }
      if (
        s.takerLease &&
        (!s.takerLease.canLocalDeviceExecute ||
          s.takerLease.requiresFailoverTakeover)
      ) {
        return s.takerLease
      }
      if (
        s.makerLease &&
        (!s.makerLease.canLocalDeviceExecute ||
          s.makerLease.requiresFailoverTakeover)
      ) {
        return s.makerLease
      }
      return s.takerLease ?? s.makerLease ?? null
    })

    const canLocalDeviceExecute = computed<boolean>(() => {
      const lease = activeLease.value
      return lease ? lease.canLocalDeviceExecute : true
    })

    const requiresFailoverTakeover = computed<boolean>(() => {
      const lease = activeLease.value
      return lease ? lease.requiresFailoverTakeover : false
    })

    const modeLabel = computed<string>(() => {
      const s = resolvedState.value
      if (!s) return ''
      return s.mode === 'milestone_escrow'
        ? tr(
            $t,
            'chatMessageSwapHandshake.modeMilestoneEscrow',
            'Milestone Escrow',
          )
        : tr($t, 'chatMessageSwapHandshake.modeAtomicSwap', 'P2P Atomic Swap')
    })

    const shortSwapId = computed<string>(() => {
      const s = resolvedState.value
      if (!s) return ''
      return s.swapId.length > 16
        ? `${s.swapId.slice(0, 10)}…${s.swapId.slice(-4)}`
        : s.swapId
    })

    const phaseBadgeText = computed<string>(() => {
      const s = resolvedState.value
      if (!s) return ''
      switch (s.phase) {
        case 'proposed':
          return tr($t, 'chatMessageSwapHandshake.phase.proposed', 'Proposed')
        case 'maker_locked':
          return tr(
            $t,
            'chatMessageSwapHandshake.phase.makerLocked',
            'Maker Locked',
          )
        case 'both_locked':
          return tr(
            $t,
            'chatMessageSwapHandshake.phase.bothLocked',
            'Both Locked',
          )
        case 'settled':
          return tr($t, 'chatMessageSwapHandshake.phase.settled', 'Settled')
        case 'refunded':
          return tr($t, 'chatMessageSwapHandshake.phase.refunded', 'Refunded')
        case 'cancelled':
          return tr($t, 'chatMessageSwapHandshake.phase.cancelled', 'Cancelled')
        case 'expired':
          return tr($t, 'chatMessageSwapHandshake.phase.expired', 'Expired')
      }
      return ''
    })

    const phaseBadgeColor = computed<string>(() => {
      const s = resolvedState.value
      if (!s) return 'grey-7'
      switch (s.phase) {
        case 'proposed':
          return 'info'
        case 'maker_locked':
          return 'primary'
        case 'both_locked':
          return 'amber-8'
        case 'settled':
          return 'positive'
        case 'refunded':
          return 'warning'
        case 'cancelled':
        case 'expired':
          return 'negative'
      }
      return 'grey-7'
    })

    const progressSteps = computed<ProgressStepView[]>(() => {
      const phase = resolvedState.value?.phase ?? 'proposed'
      const order: Record<string, number> = {
        proposed: 0,
        maker_locked: 1,
        both_locked: 2,
        settled: 3,
        refunded: 3,
        cancelled: 0,
        expired: 0,
      }
      const currentIdx = order[phase] ?? 0
      const finalLabel =
        phase === 'refunded'
          ? tr($t, 'chatMessageSwapHandshake.phase.refunded', 'Refunded')
          : phase === 'settled'
          ? tr($t, 'chatMessageSwapHandshake.phase.settled', 'Settled')
          : tr(
              $t,
              'chatMessageSwapHandshake.phase.settledOrRefunded',
              'Settled / Refunded',
            )

      const labels = [
        tr($t, 'chatMessageSwapHandshake.phase.proposed', 'Proposed'),
        tr($t, 'chatMessageSwapHandshake.phase.makerLocked', 'Maker Locked'),
        tr($t, 'chatMessageSwapHandshake.phase.bothLocked', 'Both Locked'),
        finalLabel,
      ]

      return labels.map((label, idx) => ({
        key: `step-${idx}`,
        indexText: String(idx + 1),
        label,
        done: idx < currentIdx || (idx === 3 && currentIdx === 3),
        active: idx === currentIdx,
      }))
    })

    const arrowSymbol = computed<string>(() => '→')
    const exchangeGlyph = computed<string>(() => '⇄')

    const giveHeadingText = computed<string>(() =>
      tr($t, 'chatMessageSwapHandshake.giveLeg', 'Give Leg'),
    )
    const wantHeadingText = computed<string>(() =>
      tr($t, 'chatMessageSwapHandshake.wantLeg', 'Want Leg'),
    )

    const giveAmountText = computed<string>(() => {
      const leg = resolvedState.value?.giveLeg
      if (!leg) return ''
      return `${formatSwapLegAmount(leg.amountAtomic, leg.decimals)} ${
        leg.assetSymbol
      }`
    })

    const wantAmountText = computed<string>(() => {
      const leg = resolvedState.value?.wantLeg
      if (!leg) return ''
      return `${formatSwapLegAmount(leg.amountAtomic, leg.decimals)} ${
        leg.assetSymbol
      }`
    })

    const hashlockSummaryText = computed<string>(() => {
      const s = resolvedState.value
      if (!s) return ''
      const shortHash = `${s.hashlockSha256Hex.slice(
        0,
        10,
      )}…${s.hashlockSha256Hex.slice(-6)}`
      return tr(
        $t,
        'chatMessageSwapHandshake.hashlockSummary',
        `Hashlock SHA-256: ${shortHash}`,
        { hashlock: shortHash },
      )
    })

    const preimageSummaryText = computed<string>(() => {
      const preimage = resolvedState.value?.revealedPreimageHex
      if (!preimage) return ''
      const shortPreimage = `${preimage.slice(0, 10)}…${preimage.slice(-6)}`
      return tr(
        $t,
        'chatMessageSwapHandshake.preimageRevealed',
        `Preimage verified: ${shortPreimage}`,
        { preimage: shortPreimage },
      )
    })

    const leaseStatusText = computed<string>(() => {
      const lease = activeLease.value
      if (!lease) return ''
      if (!canLocalDeviceExecute.value) {
        return tr(
          $t,
          'chatMessageSwapHandshake.executingOnAnotherDevice',
          `Executing on another device (${lease.executorDeviceId})`,
          { deviceId: lease.executorDeviceId },
        )
      }
      if (requiresFailoverTakeover.value) {
        return tr(
          $t,
          'chatMessageSwapHandshake.leaseExpiredTakeoverAvailable',
          `Execution lease on ${lease.executorDeviceId} expired`,
          { deviceId: lease.executorDeviceId },
        )
      }
      return tr(
        $t,
        'chatMessageSwapHandshake.activeLeaseOnThisDevice',
        `Execution lease active (${lease.executorDeviceId})`,
        { deviceId: lease.executorDeviceId },
      )
    })

    const leaseBannerClass = computed<string>(() => {
      if (!canLocalDeviceExecute.value) {
        return 'swap-lease-locked'
      }
      if (requiresFailoverTakeover.value) {
        return 'swap-lease-expired'
      }
      return 'swap-lease-leader'
    })

    const resumeOnThisDeviceLabel = computed<string>(() =>
      tr(
        $t,
        'chatMessageSwapHandshake.resumeOnThisDevice',
        'Resume on This Device',
      ),
    )

    const acceptAndLockLabel = computed<string>(() =>
      tr($t, 'chatMessageSwapHandshake.acceptAndLock', 'Accept & Lock'),
    )
    const counterLockLabel = computed<string>(() =>
      tr($t, 'chatMessageSwapHandshake.counterLock', 'Counter-Lock'),
    )
    const settleClaimLabel = computed<string>(() =>
      tr($t, 'chatMessageSwapHandshake.settleClaim', 'Settle & Claim'),
    )
    const refundLabel = computed<string>(() =>
      tr($t, 'chatMessageSwapHandshake.refund', 'Refund'),
    )
    const cancelLabel = computed<string>(() =>
      tr($t, 'chatMessageSwapHandshake.cancel', 'Cancel'),
    )

    const isTerminalPhase = computed<boolean>(() => {
      const phase = resolvedState.value?.phase
      return (
        phase === 'settled' || phase === 'refunded' || phase === 'cancelled'
      )
    })

    const showAcceptButton = computed<boolean>(() => {
      const s = resolvedState.value
      if (!s) return false
      return (
        s.phase === 'proposed' || s.availableActions.includes('accept_and_lock')
      )
    })

    const showCounterLockButton = computed<boolean>(() => {
      const s = resolvedState.value
      if (!s) return false
      return (
        s.phase === 'maker_locked' ||
        s.availableActions.includes('counter_lock')
      )
    })

    const showSettleButton = computed<boolean>(() => {
      const s = resolvedState.value
      if (!s) return false
      return (
        s.phase === 'both_locked' || s.availableActions.includes('settle_claim')
      )
    })

    const showRefundButton = computed<boolean>(() => {
      const s = resolvedState.value
      if (!s) return false
      return (
        s.phase === 'maker_locked' ||
        s.phase === 'both_locked' ||
        s.phase === 'expired' ||
        s.availableActions.includes('refund')
      )
    })

    const showCancelButton = computed<boolean>(() => {
      const s = resolvedState.value
      if (!s) return false
      return s.phase === 'proposed' || s.availableActions.includes('cancel')
    })

    function canExecuteAction(action: SwapHandshakeAction): boolean {
      const s = resolvedState.value
      if (!s || !canLocalDeviceExecute.value) {
        return false
      }
      if (s.availableActions.length > 0) {
        return s.availableActions.includes(action)
      }
      switch (action) {
        case 'accept_and_lock':
        case 'cancel':
          return s.phase === 'proposed'
        case 'counter_lock':
          return s.phase === 'maker_locked'
        case 'settle_claim':
          return s.phase === 'both_locked'
        case 'refund':
          return (
            s.phase === 'maker_locked' ||
            s.phase === 'both_locked' ||
            s.phase === 'expired'
          )
        default:
          return false
      }
    }

    function onAction(action: SwapHandshakeAction): void {
      if (!canExecuteAction(action)) {
        return
      }
      emit('action', action)
    }

    function onTakeoverLease(): void {
      emit('action', 'lease_heartbeat')
      emit('takeover', 'lease_heartbeat')
    }

    function shortAddress(address: string): string {
      if (!address) return ''
      return address.length > 14
        ? `${address.slice(0, 6)}…${address.slice(-4)}`
        : address
    }

    return {
      resolvedState,
      activeLease,
      canLocalDeviceExecute,
      requiresFailoverTakeover,
      modeLabel,
      shortSwapId,
      phaseBadgeText,
      phaseBadgeColor,
      progressSteps,
      arrowSymbol,
      exchangeGlyph,
      giveHeadingText,
      wantHeadingText,
      giveAmountText,
      wantAmountText,
      hashlockSummaryText,
      preimageSummaryText,
      leaseStatusText,
      leaseBannerClass,
      resumeOnThisDeviceLabel,
      acceptAndLockLabel,
      counterLockLabel,
      settleClaimLabel,
      refundLabel,
      cancelLabel,
      isTerminalPhase,
      showAcceptButton,
      showCounterLockButton,
      showSettleButton,
      showRefundButton,
      showCancelButton,
      canExecuteAction,
      onAction,
      onTakeoverLease,
      shortAddress,
    }
  },
})
</script>

<style scoped>
.swap-handshake-card {
  background: linear-gradient(145deg, #0f172a 0%, #1e293b 100%);
  border: 1px solid rgba(148, 163, 184, 0.24);
  color: #f8fafc;
  min-width: 280px;
}

.swap-mode-pill {
  color: #38bdf8;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.swap-id-pill {
  color: #94a3b8;
}

.swap-stepper {
  background: rgba(15, 23, 42, 0.55);
  border-radius: 6px;
  padding: 6px 8px;
}

.swap-step-item {
  color: #64748b;
  gap: 4px;
}

.swap-step-done {
  color: #34d399;
}

.swap-step-active {
  color: #f8fafc;
  font-weight: 600;
}

.swap-step-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  background: rgba(148, 163, 184, 0.2);
}

.swap-step-arrow {
  margin: 0 4px;
  color: #475569;
}

.swap-leg-box {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.16);
}

.swap-leg-heading {
  color: #94a3b8;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
}

.swap-leg-amount {
  color: #f1f5f9;
}

.swap-recipient-text {
  color: #94a3b8;
}

.swap-exchange-glyph {
  font-size: 18px;
  color: #38bdf8;
}

.swap-memo-row {
  color: #cbd5e1;
  font-style: italic;
}

.swap-meta-row {
  color: #94a3b8;
}

.swap-lease-banner {
  border: 1px solid rgba(148, 163, 184, 0.2);
}

.swap-lease-leader {
  background: rgba(16, 185, 129, 0.12);
  color: #a7f3d0;
}

.swap-lease-locked {
  background: rgba(245, 158, 11, 0.14);
  color: #fde68a;
}

.swap-lease-expired {
  background: rgba(239, 68, 68, 0.16);
  color: #fecaca;
}
</style>
