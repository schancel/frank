<template>
  <div class="mp-card q-pa-sm" data-testid="mental-poker-card">
    <div class="row items-center justify-between q-mb-xs">
      <div class="row items-center q-gutter-xs">
        <q-icon name="style" size="18px" color="amber-8" />
        <span class="text-weight-bold text-caption">{{ uiLabels.title }}</span>
      </div>
      <q-badge
        :color="streetBadgeColor"
        text-color="white"
        class="text-caption"
        data-testid="mp-street-badge"
      >
        {{ streetLabel }}
      </q-badge>
    </div>

    <div
      class="mp-deck-status text-caption q-mb-sm"
      data-testid="mp-deck-status"
    >
      {{ deckStatusText }}
    </div>

    <div class="mp-pot-row row items-center justify-between text-caption q-mb-sm">
      <span data-testid="mp-stake-label">{{ stakeDisplay }}</span>
      <span class="text-weight-bold" data-testid="mp-pot-label">{{ potDisplay }}</span>
    </div>

    <div class="mp-section q-mb-sm" data-testid="mp-viewer-hole-section">
      <BlackjackCards
        v-if="viewerHoleCards.length > 0"
        :label="uiLabels.yourHoleCards"
        :sentence="uiLabels.yourHoleCards"
        :cards="viewerHoleCards"
        :hidden-count="0"
      />
      <BlackjackCards
        v-else
        :label="uiLabels.yourHoleCards"
        :sentence="uiLabels.yourHoleCards"
        :cards="[]"
        :hidden-count="2"
      />
    </div>

    <div class="mp-section q-mb-sm" data-testid="mp-community-section">
      <BlackjackCards
        :label="uiLabels.communityBoard"
        :sentence="uiLabels.communityBoard"
        :cards="communityCards"
        :hidden-count="hiddenCommunityCount"
      />
    </div>

    <div class="mp-section q-mb-sm" data-testid="mp-opponent-hole-section">
      <div class="row items-center justify-between q-mb-xs">
        <span
          v-if="opponentHoleCards.length === 0"
          class="text-caption mp-hidden-placeholder"
          data-testid="mp-opponent-hidden"
        >
          {{ hiddenOpponentMask }}
        </span>
      </div>
      <BlackjackCards
        v-if="opponentHoleCards.length > 0"
        :label="uiLabels.opponentHoleCards"
        :sentence="uiLabels.opponentHoleCards"
        :cards="opponentHoleCards"
        :hidden-count="0"
      />
      <BlackjackCards
        v-else
        :label="uiLabels.opponentHoleCards"
        :sentence="uiLabels.opponentHoleCards"
        :cards="[]"
        :hidden-count="2"
      />
    </div>

    <div
      v-if="handResultText"
      class="mp-result text-caption text-weight-bold q-mb-sm"
      data-testid="mp-result-banner"
    >
      {{ handResultText }}
    </div>

    <div
      class="mp-verification row items-center q-gutter-xs q-mb-sm"
      data-testid="mp-verification-badge"
    >
      <q-badge
        :color="verificationBadgeColor"
        text-color="white"
      >
        {{ verificationBadgeText }}
      </q-badge>
    </div>

    <div
      v-if="showActionBar"
      class="row items-center q-gutter-xs q-mt-xs"
      data-testid="mp-actions"
    >
      <q-btn
        v-if="canAcceptAndShuffle"
        dense
        unelevated
        color="primary"
        size="sm"
        data-testid="mp-accept-btn"
        :label="uiLabels.acceptAndShuffle"
        @click="onAcceptAndShuffle"
      />
      <q-btn
        v-if="canCheck"
        dense
        unelevated
        color="secondary"
        size="sm"
        data-testid="mp-check-btn"
        :label="uiLabels.check"
        @click="onCheck"
      />
      <q-btn
        v-if="canCall"
        dense
        unelevated
        color="primary"
        size="sm"
        data-testid="mp-call-btn"
        :label="callButtonLabel"
        @click="onCall"
      />
      <q-btn
        v-if="canFold"
        dense
        outline
        color="negative"
        size="sm"
        data-testid="mp-fold-btn"
        :label="uiLabels.fold"
        @click="onFold"
      />
      <q-btn
        v-if="canRevealAndPay"
        dense
        unelevated
        color="positive"
        size="sm"
        data-testid="mp-settle-btn"
        :label="uiLabels.revealAndPay"
        @click="onRevealAndPay"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import {
  extractMentalPokerPayload,
  foldMentalPokerState,
  type FoldedMentalPokerState,
  type MentalPokerPayload,
  type MentalPokerRole,
} from '@frank/wallet/message-item-plugins/mental-poker'

import {
  buildMentalPokerAccept,
  buildMentalPokerCall,
  buildMentalPokerCheck,
  buildMentalPokerFold,
  buildMentalPokerSettle,
  foldMentalPokerHandForChat,
  getOrCreateMentalPokerSecrets,
  type P2pMentalPokerChatMessage,
} from '../../../utils/p2p-mental-poker'
import BlackjackCards from './BlackjackCards.vue'

const props = defineProps<{
  item?: ApplicationMessageItem | MentalPokerPayload
  payload?: MentalPokerPayload
  state?: FoldedMentalPokerState | null
  messages?: readonly P2pMentalPokerChatMessage[]
  outbound?: boolean
  ownAddress?: string
  peerAddress?: string
  privateKeyHex?: string
}>()

const emit = defineEmits<{
  (e: 'accept', step: ReturnType<typeof buildMentalPokerAccept>): void
  (e: 'check', step: ReturnType<typeof buildMentalPokerCheck>): void
  (e: 'call', step: ReturnType<typeof buildMentalPokerCall>): void
  (e: 'fold', step: ReturnType<typeof buildMentalPokerFold>): void
  (e: 'settle', step: ReturnType<typeof buildMentalPokerSettle>): void
  (
    e: 'action',
    payload: {
      type: 'accept' | 'check' | 'call' | 'fold' | 'settle'
      item: ApplicationMessageItem
      amountWei?: bigint
    },
  ): void
}>()

const uiLabels = {
  title: "Heads-Up Mental Poker (1:1 Hold'em)",
  yourHoleCards: 'Your Private Hole Cards',
  communityBoard: 'Community Cards (Flop / Turn / River)',
  opponentHoleCards: 'Opponent Hole Cards',
  acceptAndShuffle: 'Accept & Shuffle',
  check: 'Check',
  call: 'Call',
  fold: 'Fold',
  revealAndPay: 'Reveal & Pay',
  deckLocked: '52 cards double-locked on secp256k1',
  deckShuffling: '52 cards commutative-encrypted on secp256k1',
  verifiedBadge: 'Provably Fair • 52 cards double-locked on secp256k1',
  cheatingBadge: 'Cryptographic Key Mismatch Detected',
}

const hiddenOpponentMask = computed(() => "['??', '??']")

const resolvedPayload = computed<MentalPokerPayload | null>(() => {
  if (props.payload) return props.payload
  if (props.item) return extractMentalPokerPayload(props.item)
  return null
})

const foldedState = computed<FoldedMentalPokerState | null>(() => {
  if (props.state) return props.state
  const current = resolvedPayload.value
  if (!current) return null

  if (props.messages && props.messages.length > 0) {
    const fromHistory = foldMentalPokerHandForChat(
      props.messages,
      current.handId,
      props.ownAddress,
      props.peerAddress,
      props.privateKeyHex,
    )
    if (fromHistory) return fromHistory
  }

  const viewerRole: MentalPokerRole =
    current.actor ??
    (props.outbound === false ? 'accepter' : 'challenger')
  const secrets = getOrCreateMentalPokerSecrets(
    current.handId,
    viewerRole,
    props.ownAddress,
    props.peerAddress,
    props.privateKeyHex,
  )
  return foldMentalPokerState(
    [{ payload: current, outbound: props.outbound }],
    viewerRole,
    secrets,
  )
})

const formatWei = (wei: bigint): string => {
  try {
    return `${activeChain.toDisplayAmount(wei)} ${activeChain.unit}`
  } catch {
    return `${wei.toString()} wei`
  }
}

const stakeDisplay = computed(() => {
  const s = foldedState.value
  if (!s) return ''
  return `Stake: ${formatWei(s.stakeWei)}`
})

const potDisplay = computed(() => {
  const s = foldedState.value
  if (!s) return ''
  return `Pot: ${formatWei(s.potWei)}`
})

const streetLabel = computed(() => {
  const s = foldedState.value
  if (!s) return 'Locking Deck'
  if (s.cheatingDetected) return 'Invalid Proof'
  if (s.settled) return 'Settled'
  switch (s.street) {
    case 'locking':
      return 'Shuffle & Lock'
    case 'preflop':
      return 'Pre-Flop'
    case 'flop':
      return 'Flop'
    case 'turn':
      return 'Turn'
    case 'river':
      return 'River'
    case 'showdown':
      return 'Showdown'
    case 'complete':
      return 'Complete'
  }
})

const streetBadgeColor = computed(() => {
  const s = foldedState.value
  if (!s) return 'grey-7'
  if (s.cheatingDetected) return 'negative'
  if (s.street === 'showdown' || s.settled) return 'positive'
  return 'deep-purple-6'
})

const deckStatusText = computed(() => {
  const s = foldedState.value
  if (!s) return uiLabels.deckShuffling
  return uiLabels.deckLocked
})

const viewerHoleCards = computed<number[]>(
  () => foldedState.value?.viewerHoleCards ?? [],
)

const opponentHoleCards = computed<number[]>(
  () => foldedState.value?.opponentHoleCards ?? [],
)

const communityCards = computed<number[]>(
  () => foldedState.value?.communityCards ?? [],
)

const hiddenCommunityCount = computed(() =>
  Math.max(0, 5 - communityCards.value.length),
)

const verificationBadgeColor = computed(() => {
  const s = foldedState.value
  if (s?.cheatingDetected) return 'negative'
  if (s?.deckVerified) return 'positive'
  return 'blue-grey-6'
})

const verificationBadgeText = computed(() => {
  const s = foldedState.value
  if (s?.cheatingDetected) {
    return s.cheatingReason
      ? `${uiLabels.cheatingBadge}: ${s.cheatingReason}`
      : uiLabels.cheatingBadge
  }
  return uiLabels.verifiedBadge
})

const handResultText = computed(() => {
  const s = foldedState.value
  if (!s) return ''
  if (s.cheatingDetected) {
    return s.cheatingReason ?? uiLabels.cheatingBadge
  }
  if (s.foldedBy) {
    const won = s.winner === s.viewerRole
    return won ? 'Opponent folded — You win the pot!' : 'You folded.'
  }
  if (s.street === 'showdown' || s.winner) {
    const evalSummary =
      s.challengerEvaluation && s.accepterEvaluation
        ? ` (${s.challengerEvaluation.description} vs ${s.accepterEvaluation.description})`
        : ''
    if (s.winner === 'split') {
      return `Showdown Split Pot!${evalSummary}`
    }
    if (s.winner === s.viewerRole) {
      return `You win at Showdown!${evalSummary}`
    }
    if (s.winner) {
      return `Opponent wins at Showdown.${evalSummary}`
    }
  }
  return ''
})

const isActiveBettingStreet = computed(() => {
  const s = foldedState.value
  if (!s || s.cheatingDetected || s.settled || s.foldedBy) return false
  return (
    s.street === 'preflop' ||
    s.street === 'flop' ||
    s.street === 'turn' ||
    s.street === 'river'
  )
})

const isViewerTurn = computed(() => {
  const s = foldedState.value
  if (!s) return false
  return s.turnRole === s.viewerRole && s.pendingViewerKeyRevealIndices.length === 0
})

const canAcceptAndShuffle = computed(() => {
  const s = foldedState.value
  if (!s || s.cheatingDetected) return false
  return (
    s.viewerRole === 'accepter' &&
    s.street === 'locking' &&
    Boolean(s.deckX) &&
    !s.deckY
  )
})

const canCheck = computed(
  () =>
    isActiveBettingStreet.value &&
    isViewerTurn.value &&
    (foldedState.value?.pendingCallWei ?? 0n) === 0n,
)

const canCall = computed(
  () =>
    isActiveBettingStreet.value &&
    isViewerTurn.value &&
    (foldedState.value?.pendingCallWei ?? 0n) > 0n,
)

const canFold = computed(
  () => isActiveBettingStreet.value && isViewerTurn.value,
)

const canRevealAndPay = computed(() => {
  const s = foldedState.value
  if (!s || s.cheatingDetected || s.settled) return false
  return (
    (s.street === 'showdown' || s.street === 'complete') &&
    s.winner !== null &&
    s.winner !== s.viewerRole &&
    s.potWei > 0n
  )
})

const callButtonLabel = computed(() => {
  const pending = foldedState.value?.pendingCallWei ?? 0n
  if (pending > 0n) {
    return `${uiLabels.call} (${formatWei(pending)})`
  }
  return uiLabels.call
})

const showActionBar = computed(
  () =>
    canAcceptAndShuffle.value ||
    canCheck.value ||
    canCall.value ||
    canFold.value ||
    canRevealAndPay.value,
)

function onAcceptAndShuffle(): void {
  const s = foldedState.value
  if (!s || !s.deckX) return
  const step = buildMentalPokerAccept({
    handId: s.handId,
    deckX: s.deckX,
    stakeWei: s.stakeWei,
    own: props.ownAddress,
    peer: props.peerAddress,
    privateKeyHex: props.privateKeyHex,
  })
  emit('accept', step)
  emit('action', {
    type: 'accept',
    item: step.item,
    amountWei: step.stakeWei,
  })
}

function onCheck(): void {
  const s = foldedState.value
  if (!s) return
  const step = buildMentalPokerCheck({
    handId: s.handId,
    role: s.viewerRole,
    own: props.ownAddress,
    peer: props.peerAddress,
    privateKeyHex: props.privateKeyHex,
  })
  emit('check', step)
  emit('action', {
    type: 'check',
    item: step.item,
  })
}

function onCall(): void {
  const s = foldedState.value
  if (!s) return
  const step = buildMentalPokerCall({
    handId: s.handId,
    role: s.viewerRole,
    amountWei: s.pendingCallWei,
    own: props.ownAddress,
    peer: props.peerAddress,
    privateKeyHex: props.privateKeyHex,
  })
  emit('call', step)
  emit('action', {
    type: 'call',
    item: step.item,
    amountWei: s.pendingCallWei,
  })
}

function onFold(): void {
  const s = foldedState.value
  if (!s) return
  const step = buildMentalPokerFold({
    handId: s.handId,
    role: s.viewerRole,
    own: props.ownAddress,
    peer: props.peerAddress,
    privateKeyHex: props.privateKeyHex,
  })
  emit('fold', step)
  emit('action', {
    type: 'fold',
    item: step.item,
  })
}

function onRevealAndPay(): void {
  const s = foldedState.value
  if (!s) return
  const payWei = s.winner === 'split' ? s.potWei / 2n : s.potWei
  const step = buildMentalPokerSettle({
    handId: s.handId,
    role: s.viewerRole,
    amountWei: payWei,
    winnerRole: s.winner ?? undefined,
    own: props.ownAddress,
    peer: props.peerAddress,
    privateKeyHex: props.privateKeyHex,
  })
  emit('settle', step)
  emit('action', {
    type: 'settle',
    item: step.item,
    amountWei: step.amountWei,
  })
}
</script>

<style scoped>
.mp-card {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(20, 28, 40, 0.55);
  min-width: 240px;
}

.mp-deck-status {
  opacity: 0.82;
  font-family: monospace;
}

.mp-hidden-placeholder {
  font-family: monospace;
  opacity: 0.75;
}
</style>
