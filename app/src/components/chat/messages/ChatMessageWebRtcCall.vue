<template>
  <div
    class="webrtc-call-card q-pa-sm rounded-borders"
    :class="{
      'webrtc-call-card--expanded': isStageExpanded && showVideoViewport,
      'webrtc-call-card--compact': !isPrimaryCallCard,
    }"
    data-testid="webrtc-call-card"
  >
    <div class="webrtc-call-header row items-center justify-between q-mb-xs">
      <div class="row items-center q-gutter-xs">
        <div class="webrtc-call-icon-badge row items-center justify-center">
          <q-icon :name="headerIconName" size="16px" :color="headerIconColor" />
        </div>
        <span class="text-weight-bold text-caption webrtc-call-title" data-testid="webrtc-call-title">
          {{ uiLabels.title }}
        </span>
      </div>
      <div class="row items-center q-gutter-xs">
        <q-badge
          :color="privacyBadgeColor"
          text-color="white"
          class="webrtc-pill-badge text-caption"
          data-testid="webrtc-privacy-badge"
        >
          {{ privacyBadgeText }}
        </q-badge>
        <q-badge
          color="blue-grey-8"
          text-color="white"
          class="webrtc-pill-badge text-caption"
          data-testid="webrtc-media-badge"
        >
          {{ mediaBadgeText }}
        </q-badge>
        <q-badge
          :color="statusBadgeColor"
          text-color="white"
          class="webrtc-pill-badge text-caption"
          data-testid="webrtc-status-badge"
        >
          {{ statusBadgeText }}
        </q-badge>
        <q-btn
          v-if="showVideoViewport"
          dense
          round
          flat
          size="sm"
          class="webrtc-expand-header-btn"
          :icon="isStageExpanded ? 'close_fullscreen' : 'open_in_full'"
          data-testid="webrtc-toggle-expand"
          :aria-label="expandStageLabel"
          @click="onToggleExpandStage"
        />
      </div>
    </div>

    <div
      v-if="isSecurityAbort"
      role="alert"
      class="webrtc-meta-banner webrtc-meta-banner--danger text-caption text-weight-bold q-mb-xs"
      data-testid="webrtc-security-alert"
    >
      <q-icon name="gpp_bad" size="14px" class="q-mr-xs" />
      <span>{{ uiLabels.dtlsMismatch }}</span>
    </div>

    <div
      v-else-if="isDtlsVerified && isPrimaryCallCard"
      class="webrtc-meta-row row items-center justify-between text-caption q-mb-xs"
    >
      <div class="webrtc-dtls-pill row items-center no-wrap" data-testid="webrtc-dtls-badge">
        <q-icon name="verified_user" size="13px" class="q-mr-xs" />
        <span>{{ uiLabels.dtlsVerified }}</span>
      </div>
      <div
        v-if="isConnectedOrConnecting"
        class="webrtc-peer-audio-pill row items-center no-wrap"
        data-testid="webrtc-peer-mute-badge"
      >
        <q-icon :name="isRemoteMuted ? 'mic_off' : 'graphic_eq'" size="13px" class="q-mr-xs" />
        <span>{{ peerMuteStatusText }}</span>
      </div>
    </div>

    <div
      v-else-if="isDtlsVerified"
      class="webrtc-dtls-pill row items-center no-wrap text-caption q-mb-xs"
      data-testid="webrtc-dtls-badge"
    >
      <q-icon name="verified_user" size="13px" class="q-mr-xs" />
      <span>{{ uiLabels.dtlsVerified }}</span>
    </div>

    <div
      v-else-if="isConnectedOrConnecting"
      class="row items-center justify-between text-caption q-mb-xs"
      data-testid="webrtc-peer-mute-badge"
    >
      <span>{{ peerMuteStatusText }}</span>
    </div>

    <div
      v-if="isAnsweredElsewhere"
      class="text-caption text-grey-4 q-mb-xs"
      data-testid="webrtc-answered-elsewhere"
    >
      {{ uiLabels.answeredElsewhereNotice }}
    </div>

    <div
      v-if="isVideoDegradedOrDenied"
      class="text-caption text-warning q-mb-xs"
      data-testid="webrtc-audio-fallback-notice"
    >
      {{ uiLabels.audioOnlyFallback }}
    </div>

    <audio
      ref="remoteAudioEl"
      data-testid="webrtc-remote-audio"
      autoplay
      playsinline
      style="display: none"
    />

    <div
      v-if="showVideoViewport"
      class="webrtc-video-viewport q-mb-sm"
      :class="{ 'webrtc-video-viewport--expanded': isStageExpanded }"
      data-testid="webrtc-video-viewport"
    >
      <div
        class="webrtc-video-slot"
        :class="effectiveLocalPrimary ? 'webrtc-video-slot--primary' : 'webrtc-video-slot--pip'"
        @click.stop="onLocalVideoSlotClick"
      >
        <video
          ref="localVideoEl"
          class="webrtc-video-element"
          :class="{ 'webrtc-video-element--mirrored': !isScreenShareEnabled }"
          data-testid="webrtc-local-video"
          :aria-label="uiLabels.localVideo"
          muted
          playsinline
          autoplay
        />
        <div class="webrtc-video-chip">
          {{ uiLabels.youBadge }}
        </div>
      </div>

      <div
        class="webrtc-video-slot"
        :class="effectiveLocalPrimary ? 'webrtc-video-slot--pip' : 'webrtc-video-slot--primary'"
        @click.stop="onRemoteVideoSlotClick"
      >
        <video
          ref="remoteVideoEl"
          class="webrtc-video-element"
          data-testid="webrtc-remote-video"
          :aria-label="uiLabels.remoteVideo"
          muted
          playsinline
          autoplay
        />
        <div class="webrtc-video-stage-hint">
          <q-icon :name="isStageExpanded ? 'close_fullscreen' : 'open_in_full'" size="14px" />
          <span>{{ expandStageHintText }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="canAnswerIncoming"
      class="webrtc-control-dock row items-center justify-center q-gutter-sm q-mt-xs"
      data-testid="webrtc-incoming-actions"
    >
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn webrtc-dock-btn--answer"
        icon="call"
        data-testid="webrtc-answer-audio"
        :label="uiLabels.answerAudio"
        :aria-label="uiLabels.answerAudio"
        @click="onAnswerAudio"
      />
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn webrtc-dock-btn--active"
        icon="videocam"
        data-testid="webrtc-answer-video"
        :label="uiLabels.answerVideo"
        :aria-label="uiLabels.answerVideo"
        @click="onAnswerVideo"
      />
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn webrtc-dock-btn--hangup"
        icon="call_end"
        data-testid="webrtc-reject"
        :label="uiLabels.decline"
        :aria-label="uiLabels.decline"
        @click="onReject"
      />
    </div>

    <div
      v-else-if="canCancelOutgoing"
      class="webrtc-control-dock row items-center justify-center q-gutter-sm q-mt-xs"
      data-testid="webrtc-outgoing-actions"
    >
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn webrtc-dock-btn--hangup"
        icon="call_end"
        data-testid="webrtc-cancel"
        :label="uiLabels.cancel"
        :aria-label="uiLabels.cancel"
        @click="onCancel"
      />
    </div>

    <div
      v-else-if="isConnectedOrConnecting"
      class="webrtc-control-dock row items-center justify-center q-gutter-xs q-mt-xs"
      data-testid="webrtc-active-controls"
    >
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn"
        :class="isLocalMuted ? 'webrtc-dock-btn--muted' : 'webrtc-dock-btn--glass'"
        :icon="isLocalMuted ? 'mic_off' : 'mic'"
        data-testid="webrtc-toggle-mute"
        :label="muteButtonLabel"
        :aria-label="muteButtonLabel"
        @click="onToggleMute"
      />
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn"
        :class="isLocalVideoEnabled ? 'webrtc-dock-btn--active' : 'webrtc-dock-btn--glass'"
        :icon="isLocalVideoEnabled ? 'videocam' : 'videocam_off'"
        data-testid="webrtc-toggle-video"
        :label="videoButtonLabel"
        :aria-label="videoButtonLabel"
        @click="onToggleVideo"
      />
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn webrtc-dock-btn--glass"
        icon="cameraswitch"
        data-testid="webrtc-switch-camera"
        :label="uiLabels.switchCamera"
        :aria-label="uiLabels.switchCamera"
        @click="onSwitchCamera"
      />
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn"
        :class="isScreenShareEnabled ? 'webrtc-dock-btn--screen' : 'webrtc-dock-btn--glass'"
        :icon="isScreenShareEnabled ? 'stop_screen_share' : 'screen_share'"
        data-testid="webrtc-toggle-screen"
        :label="screenShareButtonLabel"
        :aria-label="screenShareButtonLabel"
        @click="onToggleScreenShare"
      />
      <q-btn
        unelevated
        no-caps
        class="webrtc-dock-btn webrtc-dock-btn--hangup"
        icon="call_end"
        data-testid="webrtc-hangup"
        :label="uiLabels.hangup"
        :aria-label="uiLabels.hangup"
        @click="onHangup"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  extractWebRtcCallPayload,
  foldWebRtcCallState,
  type FoldedWebRtcCallState,
  type WebRtcCallEnvelope,
  type WebRtcCallPayload,
  type WebRtcIceTransportPolicy,
  type WebRtcMediaIntent,
} from '@frank/wallet/message-item-plugins/webrtc-call'
import { useChatStore } from '../../../stores/chats'
import {
  WebRtcCallSessionController,
  getCallSessionController,
  getOrCreateCallSessionController,
  type CameraFacingMode,
  type MinimalMediaStream,
  type WebRtcCallControllerPhase,
  type WebRtcCallControllerSnapshot,
} from '../../../utils/webrtc-call-controller'

const props = withDefaults(
  defineProps<{
    item?: ApplicationMessageItem | WebRtcCallPayload
    payload?: WebRtcCallPayload
    state?: FoldedWebRtcCallState | null
    controller?: WebRtcCallSessionController | null
    messages?: readonly WebRtcCallEnvelope[]
    outbound?: boolean
    address?: string
    conversationId?: string
    deliveryStatus?: string
    senderAddress?: string
    localDeviceId?: string
    nowMs?: number
    cleanupOnUnmount?: boolean
  }>(),
  {
    cleanupOnUnmount: true,
  },
)

const emit = defineEmits<{
  (
    e: 'sendFollowUp',
    payload: { items: ApplicationMessageItem[]; stampValueWei?: bigint },
  ): void
  (e: 'answer', payload: { item: ApplicationMessageItem; withVideo: boolean }): void
  (e: 'reject', payload: { item: ApplicationMessageItem }): void
  (e: 'cancel', payload: { item: ApplicationMessageItem }): void
  (
    e: 'hangup',
    payload: {
      sentViaDataChannel: boolean
      item: ApplicationMessageItem | null
    },
  ): void
  (e: 'muteChange', muted: boolean): void
  (e: 'videoChange', enabled: boolean): void
  (e: 'screenShareChange', enabled: boolean): void
  (e: 'cameraSwitch', facingMode: CameraFacingMode): void
}>()

const uiLabels = {
  title: 'WebRTC Call',
  status: {
    idle: 'Ready',
    ringing_outgoing: 'Calling…',
    ringing_incoming: 'Ringing',
    connecting: 'Connecting…',
    connected: 'In Call',
    ended: 'Ended',
    rejected: 'Declined',
    cancelled: 'Cancelled',
    expired: 'Missed / Expired',
    security_abort: 'Security Abort',
    answered_elsewhere: 'Answered Elsewhere',
  },
  mediaMode: {
    audio: 'Audio Call',
    video: 'Video Call',
    screen: 'Screen Share',
  },
  privacy: {
    default: 'Direct P2P',
    relayOnly: 'Relay-Only IP Hidden',
  },
  answerAudio: 'Answer Audio',
  answerVideo: 'Answer Video',
  decline: 'Decline',
  cancel: 'Cancel Call',
  mute: 'Mute',
  unmute: 'Unmute',
  cameraOn: 'Camera On',
  cameraOff: 'Camera Off',
  switchCamera: 'Switch Camera',
  shareScreen: 'Share Screen',
  stopScreen: 'Stop Sharing',
  hangup: 'Hang Up',
  localVideo: 'Local video preview',
  remoteVideo: 'Remote peer video',
  dtlsVerified: 'DTLS-SRTP Fingerprint Verified',
  dtlsMismatch: 'DTLS Fingerprint Verification Failed — Call Aborted',
  answeredElsewhereNotice: 'Answered on another device',
  peerMuted: 'Peer muted',
  peerUnmuted: 'Peer audio active',
  audioOnlyFallback: 'Audio preserved (camera/screen unavailable)',
  youBadge: 'You',
  expandStage: 'Expand call to full view',
  collapseStage: 'Minimize call to chat card',
  clickToExpandHint: 'Click video to expand',
  clickToMinimizeHint: 'Click video to minimize',
}

const localVideoEl = ref<HTMLVideoElement | null>(null)
const remoteVideoEl = ref<HTMLVideoElement | null>(null)
const remoteAudioEl = ref<HTMLAudioElement | null>(null)
const snapshotVersion = ref(0)
const isStageExpanded = ref(false)
const isLocalPrimary = ref(false)

const resolvedPayload = computed<WebRtcCallPayload | null>(() => {
  if (props.payload) return props.payload
  if (props.item) return extractWebRtcCallPayload(props.item)
  return null
})

const conversationMessages = computed<readonly WebRtcCallEnvelope[]>(() => {
  if (props.messages && props.messages.length > 0) {
    return props.messages
  }
  try {
    const store = useChatStore() as unknown as {
      activeConversation?: { messages?: readonly WebRtcCallEnvelope[] } | null
      conversations?: Record<
        string,
        { messages?: readonly WebRtcCallEnvelope[] } | undefined
      >
    }
    const activeMsgs = store?.activeConversation?.messages
    if (activeMsgs && activeMsgs.length > 0) {
      return activeMsgs
    }
    const convId = props.conversationId || props.address
    if (convId && store?.conversations) {
      const direct = store.conversations[convId]?.messages
      if (direct && direct.length > 0) return direct
      const bySuffix = Object.entries(store.conversations).find(([k]) =>
        k.toLowerCase().endsWith(convId.toLowerCase()),
      )?.[1]?.messages
      if (bySuffix && bySuffix.length > 0) return bySuffix
    }
  } catch {
    // Pinia store not active in isolated unit test
  }
  return []
})

const isPrimaryCallCard = computed<boolean>(() => {
  if (props.controller !== undefined || props.state !== undefined) return true
  return !resolvedPayload.value || resolvedPayload.value.action === 'invite'
})

const foldedState = computed<FoldedWebRtcCallState | null>(() => {
  if (props.state) return props.state
  const current = resolvedPayload.value
  if (!current) return null
  const effectiveNowMs = props.nowMs ?? Date.now()

  if (conversationMessages.value.length > 0) {
    const fromConversation = foldWebRtcCallState(
      conversationMessages.value,
      current.callId,
      {
        localDeviceId: props.localDeviceId,
        nowMs: effectiveNowMs,
      },
    )
    if (fromConversation) return fromConversation
  }

  return foldWebRtcCallState(
    [
      {
        payload: current,
        outbound: Boolean(props.outbound),
        senderAddress: props.senderAddress,
      },
    ],
    current.callId,
    {
      localDeviceId: props.localDeviceId,
      nowMs: effectiveNowMs,
    },
  )
})

const activeController = computed<WebRtcCallSessionController | null>(() => {
  void snapshotVersion.value
  if (props.controller !== undefined) {
    return props.controller
  }
  const current = resolvedPayload.value
  const callId = current?.callId ?? props.state?.callId
  if (!callId) return null
  const existing = getCallSessionController(callId)
  if (existing) return existing
  if (
    current?.action === 'invite' &&
    !props.outbound &&
    (!foldedState.value || foldedState.value.phase === 'ringing_incoming')
  ) {
    return getOrCreateCallSessionController(callId, {
      localPeerId: props.address,
      remotePeerId: props.senderAddress,
      invite: current,
      outbound: false,
      senderDeviceId: props.localDeviceId,
      ...(props.nowMs !== undefined ? { nowMs: () => props.nowMs! } : {}),
    })
  }
  return null
})

function ensureActiveController(): WebRtcCallSessionController | null {
  if (props.controller !== undefined) {
    return props.controller
  }
  const current = resolvedPayload.value
  const callId = current?.callId ?? props.state?.callId
  if (!callId) return null
  const invite =
    foldedState.value?.invite ??
    (current?.action === 'invite' ? current : undefined)
  return getOrCreateCallSessionController(callId, {
    localPeerId: props.outbound ? props.senderAddress : props.address,
    remotePeerId: props.outbound ? props.address : props.senderAddress,
    invite,
    outbound: props.outbound,
    senderDeviceId: props.localDeviceId,
    ...(props.nowMs !== undefined ? { nowMs: () => props.nowMs! } : {}),
  })
}

const controllerSnapshot = ref<WebRtcCallControllerSnapshot | null>(
  activeController.value ? activeController.value.getSnapshot() : null,
)

function syncControllerSnapshot(
  ctrl: WebRtcCallSessionController | null = activeController.value,
): void {
  snapshotVersion.value += 1
  if (ctrl) {
    controllerSnapshot.value = ctrl.getSnapshot()
    attachStreamsToVideoElements(
      ctrl.getLocalStream(),
      ctrl.getRemoteStream(),
    )
  }
}

function attachStreamsToVideoElements(
  localStream: MinimalMediaStream | null,
  remoteStream: MinimalMediaStream | null,
): void {
  if (!isPrimaryCallCard.value) return
  if (localVideoEl.value && 'srcObject' in localVideoEl.value) {
    try {
      const el = localVideoEl.value as unknown as {
        srcObject: unknown
        play?: () => Promise<void>
      }
      if (el.srcObject !== localStream) {
        el.srcObject = localStream
      }
      if (localStream) {
        void el.play?.().catch(() => {})
      }
    } catch {
      // Ignore JSDOM srcObject assignment limitations
    }
  }
  if (remoteVideoEl.value && 'srcObject' in remoteVideoEl.value) {
    try {
      const el = remoteVideoEl.value as unknown as {
        srcObject: unknown
        play?: () => Promise<void>
      }
      if (el.srcObject !== remoteStream) {
        el.srcObject = remoteStream
      }
      if (remoteStream) {
        void el.play?.().catch(() => {})
      }
    } catch {
      // Ignore JSDOM srcObject assignment limitations
    }
  }
  if (remoteAudioEl.value && 'srcObject' in remoteAudioEl.value) {
    try {
      const el = remoteAudioEl.value as unknown as {
        srcObject: unknown
        play?: () => Promise<void>
      }
      if (el.srcObject !== remoteStream) {
        el.srcObject = remoteStream
      }
      if (remoteStream) {
        void el.play?.().catch(() => {})
      }
    } catch {
      // Ignore JSDOM srcObject assignment limitations
    }
  }
}

let unsubscribeController: (() => void) | null = null

watch(
  activeController,
  nextCtrl => {
    unsubscribeController?.()
    unsubscribeController = null
    controllerSnapshot.value = nextCtrl ? nextCtrl.getSnapshot() : null
    if (nextCtrl) {
      attachStreamsToVideoElements(
        nextCtrl.getLocalStream(),
        nextCtrl.getRemoteStream(),
      )
      unsubscribeController = nextCtrl.subscribe({
        onStateChange: snap => {
          snapshotVersion.value += 1
          controllerSnapshot.value = snap
          attachStreamsToVideoElements(
            nextCtrl.getLocalStream(),
            nextCtrl.getRemoteStream(),
          )
        },
        onLocalStream: stream => {
          snapshotVersion.value += 1
          attachStreamsToVideoElements(stream, nextCtrl.getRemoteStream())
        },
        onRemoteStream: stream => {
          snapshotVersion.value += 1
          attachStreamsToVideoElements(nextCtrl.getLocalStream(), stream)
        },
      })
    }
  },
  { immediate: true },
)

watch(
  [conversationMessages, activeController, resolvedPayload],
  ([msgs, ctrl, currentPayload]) => {
    const targetCallId =
      currentPayload?.callId ?? props.state?.callId ?? ctrl?.getSnapshot().callId
    if (!targetCallId) return
    const targetCtrl = ctrl ?? getCallSessionController(targetCallId)
    if (!targetCtrl) return

    if (currentPayload && currentPayload.action !== 'invite') {
      void targetCtrl.handleSignalingPayload(currentPayload, {
        outbound: Boolean(props.outbound),
      })
    }

    for (const env of msgs) {
      const p =
        env.payload ??
        extractWebRtcCallPayload(env) ??
        (Array.isArray((env as { items?: unknown[] }).items)
          ? (env as { items: unknown[] }).items
              .map(it => extractWebRtcCallPayload(it))
              .find((x): x is WebRtcCallPayload => x !== null) ?? null
          : null)
      if (p && p.callId === targetCallId && p.action !== 'invite') {
        void targetCtrl.handleSignalingPayload(p, {
          outbound: Boolean(env.outbound),
        })
      }
    }
  },
  { immediate: true, deep: true },
)

const effectivePhase = computed<WebRtcCallControllerPhase>(() => {
  void snapshotVersion.value
  const current = resolvedPayload.value
  if (!isPrimaryCallCard.value && current) {
    switch (current.action) {
      case 'cancel':
        return 'cancelled'
      case 'reject':
        return 'rejected'
      case 'hangup':
        return 'ended'
      case 'accept': {
        const snap = activeController.value
          ? activeController.value.getSnapshot()
          : controllerSnapshot.value
        if (snap && snap.phase !== 'idle') return snap.phase
        return 'connected'
      }
      case 'ice_batch':
        return 'connecting'
    }
  }
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  if (snap && snap.phase !== 'idle') {
    return snap.phase
  }
  const folded = foldedState.value
  if (!folded) return 'idle'
  if (folded.phase === 'failed') {
    const reason = (folded.failureReason ?? folded.securityError ?? '').toLowerCase()
    return reason.includes('fingerprint') ? 'security_abort' : 'ended'
  }
  return folded.phase
})

const effectiveMediaMode = computed<WebRtcMediaIntent>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  if (snap && snap.phase !== 'idle') {
    return snap.mediaMode
  }
  return (
    foldedState.value?.mediaIntent ??
    resolvedPayload.value?.mediaIntent ??
    'audio'
  )
})

const effectiveIcePolicy = computed<WebRtcIceTransportPolicy>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  if (snap) {
    return snap.icePolicy
  }
  return (
    foldedState.value?.icePolicy ??
    resolvedPayload.value?.icePolicy ??
    'direct-preferred'
  )
})

const isAnsweredElsewhere = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  if (snap?.answeredElsewhere) return true
  return Boolean(foldedState.value?.answeredElsewhere)
})

const isSecurityAbort = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  if (snap?.phase === 'security_abort' || snap?.securityViolationReason) {
    return true
  }
  const reason = (
    foldedState.value?.failureReason ??
    foldedState.value?.securityError ??
    ''
  ).toLowerCase()
  return Boolean(foldedState.value?.phase === 'failed' && reason.includes('fingerprint'))
})

const isDtlsVerified = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  return Boolean(snap?.dtlsVerified && !isSecurityAbort.value)
})

const isVideoDegradedOrDenied = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  return Boolean(snap?.videoDegradedOrDenied)
})

const isLocalMuted = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  return Boolean(snap?.localMuted)
})

const isRemoteMuted = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  return Boolean(snap?.remoteMuted)
})

const isLocalVideoEnabled = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  return Boolean(snap?.videoEnabled)
})

const isScreenShareEnabled = computed<boolean>(() => {
  void snapshotVersion.value
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  return Boolean(snap?.screenShareEnabled)
})

const isConnectedOrConnecting = computed<boolean>(() => {
  if (!isPrimaryCallCard.value) return false
  const phase = effectivePhase.value
  return phase === 'connected' || phase === 'connecting'
})

const showVideoViewport = computed<boolean>(() => {
  void snapshotVersion.value
  if (!isPrimaryCallCard.value) return false
  const snap = activeController.value
    ? activeController.value.getSnapshot()
    : controllerSnapshot.value
  const phase = effectivePhase.value
  if (
    phase !== 'connected' &&
    phase !== 'connecting' &&
    phase !== 'ringing_outgoing'
  ) {
    return false
  }
  return Boolean(
    effectiveMediaMode.value === 'video' ||
      effectiveMediaMode.value === 'screen' ||
      snap?.videoEnabled ||
      snap?.remoteVideoEnabled ||
      snap?.screenShareEnabled ||
      snap?.remoteScreenShareEnabled,
  )
})

watch(
  [showVideoViewport, localVideoEl, remoteVideoEl, remoteAudioEl],
  () => {
    const ctrl = activeController.value
    if (ctrl) {
      attachStreamsToVideoElements(
        ctrl.getLocalStream(),
        ctrl.getRemoteStream(),
      )
    }
  },
  { flush: 'post' },
)

const canAnswerIncoming = computed<boolean>(() => {
  if (!isPrimaryCallCard.value) return false
  return (
    effectivePhase.value === 'ringing_incoming' && !isAnsweredElsewhere.value
  )
})

const canCancelOutgoing = computed<boolean>(() => {
  if (!isPrimaryCallCard.value) return false
  return effectivePhase.value === 'ringing_outgoing'
})

const headerIconName = computed<string>(() => {
  if (isSecurityAbort.value) return 'gpp_bad'
  if (effectiveMediaMode.value === 'screen') return 'screen_share'
  if (effectiveMediaMode.value === 'video') return 'videocam'
  return 'call'
})

const headerIconColor = computed<string>(() => {
  if (isSecurityAbort.value) return 'negative'
  if (effectivePhase.value === 'connected') return 'positive'
  return 'primary'
})

const statusBadgeColor = computed<string>(() => {
  if (isSecurityAbort.value) return 'negative'
  if (isAnsweredElsewhere.value) return 'blue-grey-6'
  switch (effectivePhase.value) {
    case 'connected':
      return 'positive'
    case 'connecting':
    case 'ringing_incoming':
    case 'ringing_outgoing':
      return 'amber-8'
    case 'rejected':
    case 'cancelled':
    case 'expired':
      return 'grey-7'
    case 'ended':
    default:
      return 'blue-grey-7'
  }
})

const statusBadgeText = computed<string>(() => {
  if (isSecurityAbort.value) return uiLabels.status.security_abort
  if (isAnsweredElsewhere.value) return uiLabels.status.answered_elsewhere
  return uiLabels.status[effectivePhase.value] ?? uiLabels.status.ended
})

const mediaBadgeText = computed<string>(() => {
  return (
    uiLabels.mediaMode[effectiveMediaMode.value] ?? uiLabels.mediaMode.audio
  )
})

const privacyBadgeColor = computed<string>(() => {
  return effectiveIcePolicy.value === 'relay-only' ? 'deep-purple-6' : 'teal-7'
})

const privacyBadgeText = computed<string>(() => {
  return effectiveIcePolicy.value === 'relay-only'
    ? uiLabels.privacy.relayOnly
    : uiLabels.privacy.default
})

const peerMuteStatusText = computed<string>(() => {
  return isRemoteMuted.value ? uiLabels.peerMuted : uiLabels.peerUnmuted
})

const muteButtonLabel = computed<string>(() => {
  return isLocalMuted.value ? uiLabels.unmute : uiLabels.mute
})

const videoButtonLabel = computed<string>(() => {
  return isLocalVideoEnabled.value ? uiLabels.cameraOff : uiLabels.cameraOn
})

const screenShareButtonLabel = computed<string>(() => {
  return isScreenShareEnabled.value
    ? uiLabels.stopScreen
    : uiLabels.shareScreen
})

const effectiveLocalPrimary = computed<boolean>(() => {
  if (effectivePhase.value === 'ringing_outgoing') return true
  return isLocalPrimary.value
})

const expandStageLabel = computed<string>(() => {
  return isStageExpanded.value ? uiLabels.collapseStage : uiLabels.expandStage
})

const expandStageHintText = computed<string>(() => {
  return isStageExpanded.value
    ? uiLabels.clickToMinimizeHint
    : uiLabels.clickToExpandHint
})

function onToggleExpandStage(): void {
  isStageExpanded.value = !isStageExpanded.value
}

function onLocalVideoSlotClick(): void {
  if (effectiveLocalPrimary.value) {
    isStageExpanded.value = !isStageExpanded.value
  } else {
    isLocalPrimary.value = true
  }
}

function onRemoteVideoSlotClick(): void {
  if (!effectiveLocalPrimary.value) {
    isStageExpanded.value = !isStageExpanded.value
  } else {
    isLocalPrimary.value = false
  }
}

watch(showVideoViewport, visible => {
  if (!visible) {
    isStageExpanded.value = false
  }
})

async function onAnswerAudio(): Promise<void> {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const invite =
    foldedState.value?.invite ??
    (resolvedPayload.value?.action === 'invite'
      ? resolvedPayload.value
      : undefined)
  const { item } = await ctrl.acceptIncomingCall({
    withVideo: false,
    invite,
  })
  syncControllerSnapshot(ctrl)
  emit('answer', { item, withVideo: false })
  emit('sendFollowUp', { items: [item] })
}

async function onAnswerVideo(): Promise<void> {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const invite =
    foldedState.value?.invite ??
    (resolvedPayload.value?.action === 'invite'
      ? resolvedPayload.value
      : undefined)
  const { item } = await ctrl.acceptIncomingCall({
    withVideo: true,
    invite,
  })
  syncControllerSnapshot(ctrl)
  emit('answer', { item, withVideo: true })
  emit('sendFollowUp', { items: [item] })
}

function onReject(): void {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const { item } = ctrl.rejectIncomingCall()
  syncControllerSnapshot(ctrl)
  emit('reject', { item })
  emit('sendFollowUp', { items: [item] })
}

function onCancel(): void {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const { item } = ctrl.cancelOutgoingCall()
  syncControllerSnapshot(ctrl)
  emit('cancel', { item })
  emit('sendFollowUp', { items: [item] })
}

function onToggleMute(): void {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const muted = ctrl.toggleMute()
  syncControllerSnapshot(ctrl)
  emit('muteChange', muted)
}

async function onToggleVideo(): Promise<void> {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const next = !ctrl.getSnapshot().videoEnabled
  const enabled = await ctrl.setVideoEnabled(next)
  syncControllerSnapshot(ctrl)
  emit('videoChange', enabled)
}

async function onSwitchCamera(): Promise<void> {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const mode = await ctrl.switchCameraFacingMode()
  syncControllerSnapshot(ctrl)
  emit('cameraSwitch', mode)
}

async function onToggleScreenShare(): Promise<void> {
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const next = !ctrl.getSnapshot().screenShareEnabled
  const enabled = await ctrl.setScreenShareEnabled(next)
  syncControllerSnapshot(ctrl)
  emit('screenShareChange', enabled)
}

function onHangup(): void {
  isStageExpanded.value = false
  const ctrl = ensureActiveController()
  if (!ctrl) return
  const res = ctrl.hangup()
  syncControllerSnapshot(ctrl)
  emit('hangup', {
    sentViaDataChannel: res.sentViaDataChannel,
    item: res.followUpItem,
  })
  if (res.followUpItem) {
    emit('sendFollowUp', { items: [res.followUpItem] })
  }
}

onBeforeUnmount(() => {
  unsubscribeController?.()
  unsubscribeController = null
  if (
    props.cleanupOnUnmount !== false &&
    props.controller !== undefined &&
    activeController.value
  ) {
    activeController.value.cleanup()
  }
})
</script>

<style scoped>
.webrtc-call-card {
  position: relative;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  background: linear-gradient(145deg, #0f172a 0%, #1e293b 100%);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  color: #f8fafc;
  min-width: 280px;
  max-width: 480px;
  padding: 12px !important;
  transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.webrtc-call-card--compact {
  min-width: 220px;
  padding: 8px 12px !important;
  background: rgba(15, 23, 42, 0.85);
}

.webrtc-call-card--expanded {
  position: fixed;
  inset: 16px;
  z-index: 6000;
  max-width: none;
  min-width: 0;
  border-radius: 22px;
  background: linear-gradient(160deg, rgba(10, 15, 28, 0.97) 0%, rgba(17, 24, 39, 0.98) 100%);
  backdrop-filter: blur(24px);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.16);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 16px 20px !important;
}

.webrtc-call-icon-badge {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
}

.webrtc-call-title {
  color: #f8fafc;
  font-size: 0.86rem;
  letter-spacing: 0.01em;
}

.webrtc-pill-badge {
  border-radius: 999px;
  padding: 3px 9px;
  font-weight: 600;
  font-size: 0.7rem;
  letter-spacing: 0.02em;
}

.webrtc-expand-header-btn {
  color: #e2e8f0 !important;
  background: rgba(255, 255, 255, 0.1);
}

.webrtc-expand-header-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.webrtc-meta-row {
  gap: 8px;
}

.webrtc-dtls-pill {
  color: #4ade80;
  font-weight: 600;
  font-size: 0.72rem;
}

.webrtc-peer-audio-pill {
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.71rem;
}

.webrtc-meta-banner--danger {
  background: rgba(239, 68, 68, 0.18);
  border: 1px solid rgba(239, 68, 68, 0.45);
  color: #fca5a5;
  padding: 6px 10px;
  border-radius: 10px;
  display: flex;
  align-items: center;
}

.webrtc-video-viewport {
  position: relative;
  width: 100%;
  height: 250px;
  background: radial-gradient(circle at center, #1e293b 0%, #090d16 100%);
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.6);
}

.webrtc-video-viewport--expanded {
  flex: 1 1 auto;
  height: auto;
  min-height: 320px;
  border-radius: 18px;
}

.webrtc-video-slot {
  overflow: hidden;
  cursor: pointer;
  transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.webrtc-video-slot--primary {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.webrtc-video-slot--pip {
  position: absolute;
  right: 10px;
  bottom: 10px;
  width: 96px;
  height: 128px;
  z-index: 3;
  border-radius: 12px;
  border: 1.5px solid rgba(255, 255, 255, 0.32);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.55);
  background: #0f172a;
}

.webrtc-video-viewport--expanded .webrtc-video-slot--pip {
  right: 18px;
  bottom: 18px;
  width: 168px;
  height: 224px;
  border-radius: 16px;
}

.webrtc-video-slot--pip:hover {
  transform: scale(1.04);
  border-color: rgba(255, 255, 255, 0.65);
}

.webrtc-video-element {
  width: 100%;
  height: 100%;
  display: block;
  background: #090d16;
  object-fit: cover;
}

.webrtc-video-viewport--expanded .webrtc-video-slot--primary .webrtc-video-element {
  object-fit: contain;
}

.webrtc-video-element--mirrored {
  transform: scaleX(-1);
}

.webrtc-video-chip {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.72);
  backdrop-filter: blur(8px);
  color: #f8fafc;
  font-size: 0.65rem;
  font-weight: 600;
  pointer-events: none;
}

.webrtc-video-stage-hint {
  position: absolute;
  left: 10px;
  top: 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.68);
  backdrop-filter: blur(8px);
  color: #e2e8f0;
  font-size: 0.68rem;
  font-weight: 500;
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: none;
}

.webrtc-video-slot--primary:hover .webrtc-video-stage-hint {
  opacity: 1;
}

.webrtc-control-dock {
  background: rgba(15, 23, 42, 0.78);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 6px 10px;
  flex-wrap: wrap;
}

.webrtc-dock-btn {
  border-radius: 999px !important;
  padding: 5px 12px !important;
  font-size: 0.76rem !important;
  font-weight: 600 !important;
  letter-spacing: 0.01em;
  transition: transform 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
}

.webrtc-dock-btn:hover {
  transform: translateY(-1px);
}

.webrtc-dock-btn--glass {
  background: rgba(255, 255, 255, 0.13) !important;
  color: #f8fafc !important;
  border: 1px solid rgba(255, 255, 255, 0.16);
}

.webrtc-dock-btn--glass:hover {
  background: rgba(255, 255, 255, 0.22) !important;
}

.webrtc-dock-btn--active {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
  color: #ffffff !important;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4);
}

.webrtc-dock-btn--screen {
  background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%) !important;
  color: #ffffff !important;
  box-shadow: 0 4px 12px rgba(109, 40, 217, 0.42);
}

.webrtc-dock-btn--muted {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%) !important;
  color: #0f172a !important;
  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.35);
}

.webrtc-dock-btn--answer {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%) !important;
  color: #ffffff !important;
  box-shadow: 0 4px 14px rgba(34, 197, 94, 0.45);
}

.webrtc-dock-btn--hangup {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important;
  color: #ffffff !important;
  box-shadow: 0 4px 14px rgba(239, 68, 68, 0.45);
}
</style>
