<template>
  <div class="webrtc-call-card q-pa-sm rounded-borders" data-testid="webrtc-call-card">
    <div class="row items-center justify-between q-mb-xs">
      <div class="row items-center q-gutter-xs">
        <q-icon :name="headerIconName" size="18px" :color="headerIconColor" />
        <span class="text-weight-bold text-caption" data-testid="webrtc-call-title">
          {{ uiLabels.title }}
        </span>
      </div>
      <div class="row items-center q-gutter-xs">
        <q-badge
          :color="privacyBadgeColor"
          text-color="white"
          class="text-caption"
          data-testid="webrtc-privacy-badge"
        >
          {{ privacyBadgeText }}
        </q-badge>
        <q-badge
          color="blue-grey-7"
          text-color="white"
          class="text-caption"
          data-testid="webrtc-media-badge"
        >
          {{ mediaBadgeText }}
        </q-badge>
        <q-badge
          :color="statusBadgeColor"
          text-color="white"
          class="text-caption"
          data-testid="webrtc-status-badge"
        >
          {{ statusBadgeText }}
        </q-badge>
      </div>
    </div>

    <div
      v-if="isSecurityAbort"
      role="alert"
      class="text-caption text-negative text-weight-bold q-mb-xs"
      data-testid="webrtc-security-alert"
    >
      {{ uiLabels.dtlsMismatch }}
    </div>

    <div
      v-else-if="isDtlsVerified"
      class="text-caption text-positive q-mb-xs"
      data-testid="webrtc-dtls-badge"
    >
      {{ uiLabels.dtlsVerified }}
    </div>

    <div
      v-if="isAnsweredElsewhere"
      class="text-caption text-grey-5 q-mb-xs"
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

    <div
      v-if="isConnectedOrConnecting"
      class="row items-center justify-between text-caption q-mb-xs"
      data-testid="webrtc-peer-mute-badge"
    >
      <span>{{ peerMuteStatusText }}</span>
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
      class="webrtc-video-viewport row q-col-gutter-xs q-mb-sm"
      data-testid="webrtc-video-viewport"
    >
      <div class="col-6">
        <video
          ref="localVideoEl"
          class="webrtc-video-element"
          data-testid="webrtc-local-video"
          :aria-label="uiLabels.localVideo"
          muted
          playsinline
          autoplay
        />
      </div>
      <div class="col-6">
        <video
          ref="remoteVideoEl"
          class="webrtc-video-element"
          data-testid="webrtc-remote-video"
          :aria-label="uiLabels.remoteVideo"
          muted
          playsinline
          autoplay
        />
      </div>
    </div>

    <div
      v-if="canAnswerIncoming"
      class="row items-center q-gutter-xs q-mt-xs"
      data-testid="webrtc-incoming-actions"
    >
      <q-btn
        dense
        unelevated
        color="positive"
        size="sm"
        icon="call"
        data-testid="webrtc-answer-audio"
        :label="uiLabels.answerAudio"
        :aria-label="uiLabels.answerAudio"
        @click="onAnswerAudio"
      />
      <q-btn
        dense
        unelevated
        color="primary"
        size="sm"
        icon="videocam"
        data-testid="webrtc-answer-video"
        :label="uiLabels.answerVideo"
        :aria-label="uiLabels.answerVideo"
        @click="onAnswerVideo"
      />
      <q-btn
        dense
        outline
        color="negative"
        size="sm"
        icon="call_end"
        data-testid="webrtc-reject"
        :label="uiLabels.decline"
        :aria-label="uiLabels.decline"
        @click="onReject"
      />
    </div>

    <div
      v-else-if="canCancelOutgoing"
      class="row items-center q-gutter-xs q-mt-xs"
      data-testid="webrtc-outgoing-actions"
    >
      <q-btn
        dense
        outline
        color="negative"
        size="sm"
        icon="call_end"
        data-testid="webrtc-cancel"
        :label="uiLabels.cancel"
        :aria-label="uiLabels.cancel"
        @click="onCancel"
      />
    </div>

    <div
      v-else-if="isConnectedOrConnecting"
      class="row items-center q-gutter-xs q-mt-xs"
      data-testid="webrtc-active-controls"
    >
      <q-btn
        dense
        unelevated
        :color="isLocalMuted ? 'warning' : 'secondary'"
        size="sm"
        :icon="isLocalMuted ? 'mic_off' : 'mic'"
        data-testid="webrtc-toggle-mute"
        :label="muteButtonLabel"
        :aria-label="muteButtonLabel"
        @click="onToggleMute"
      />
      <q-btn
        dense
        unelevated
        :color="isLocalVideoEnabled ? 'primary' : 'secondary'"
        size="sm"
        :icon="isLocalVideoEnabled ? 'videocam' : 'videocam_off'"
        data-testid="webrtc-toggle-video"
        :label="videoButtonLabel"
        :aria-label="videoButtonLabel"
        @click="onToggleVideo"
      />
      <q-btn
        dense
        flat
        color="secondary"
        size="sm"
        icon="cameraswitch"
        data-testid="webrtc-switch-camera"
        :label="uiLabels.switchCamera"
        :aria-label="uiLabels.switchCamera"
        @click="onSwitchCamera"
      />
      <q-btn
        dense
        unelevated
        :color="isScreenShareEnabled ? 'accent' : 'secondary'"
        size="sm"
        :icon="isScreenShareEnabled ? 'stop_screen_share' : 'screen_share'"
        data-testid="webrtc-toggle-screen"
        :label="screenShareButtonLabel"
        :aria-label="screenShareButtonLabel"
        @click="onToggleScreenShare"
      />
      <q-btn
        dense
        unelevated
        color="negative"
        size="sm"
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
}

const localVideoEl = ref<HTMLVideoElement | null>(null)
const remoteVideoEl = ref<HTMLVideoElement | null>(null)
const remoteAudioEl = ref<HTMLAudioElement | null>(null)
const snapshotVersion = ref(0)

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
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(20, 28, 40, 0.55);
  min-width: 240px;
}

.webrtc-video-viewport {
  background: rgba(0, 0, 0, 0.45);
  border-radius: 8px;
  padding: 4px;
}

.webrtc-video-element {
  width: 100%;
  max-height: 180px;
  border-radius: 6px;
  background: #000;
  object-fit: cover;
}
</style>
