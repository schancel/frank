/**
 * Browser-to-Browser 1:1 WebRTC Call Session Controller (#464, #465, #466, #468).
 *
 * Manages the full 1:1 WebRTC voice, video, and screen-sharing lifecycle:
 * - Ephemeral per-call DTLS certificate generation (`ECDSA P-256`) and SHA-256 fingerprint extraction
 * - Explicit user-intent gated microphone, camera (`facingMode: 'user' | 'environment'`), and screen capture (`getDisplayMedia`)
 * - Bundled ICE gathering with `relay-only` SDP/candidate sanitization (`sanitizeSdpForIcePolicy`, `filterCandidateForIcePolicy`)
 * - Strict remote DTLS fingerprint verification (`verifyRemoteSdpFingerprint`) before setting remote descriptions or enabling media
 * - Peer-to-peer `RTCDataChannel` (`"frank-call-control-v1"`) for zero-relay mid-call mute, video/screen toggle, SDP renegotiation, and hangup
 * - Deterministic cleanup (`MediaStreamTrack.stop()`, `RTCDataChannel.close()`, `RTCPeerConnection.close()`) on every terminal or error path
 * - Privacy-by-design: never logs SDP, ICE candidates, IP addresses, device labels, or media samples
 */
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  buildRtcConfiguration,
  decodeDataChannelMessage,
  encodeDataChannelMessage,
  extractSdpDtlsFingerprintSha256,
  filterCandidateForIcePolicy,
  generateCallId,
  resolveGlareWinner,
  sanitizeSdpForIcePolicy,
  toWebRtcCallApplicationItem,
  verifyRemoteSdpFingerprint,
  WEBRTC_DATA_CHANNEL_LABEL,
  type RTCIceServer,
  type WebRtcCallPayload,
  type WebRtcDataChannelMessage,
  type WebRtcIceTransportPolicy,
  type WebRtcMediaIntent,
} from '@frank/wallet/message-item-plugins/webrtc-call'

export const WEBRTC_CONTROL_DATA_CHANNEL_LABEL = WEBRTC_DATA_CHANNEL_LABEL
export const DEFAULT_CALL_INVITE_TTL_MS = 120_000
export const DEFAULT_ICE_GATHER_TIMEOUT_MS = 1_500

export type WebRtcCallControllerPhase =
  | 'idle'
  | 'ringing_outgoing'
  | 'ringing_incoming'
  | 'connecting'
  | 'connected'
  | 'ended'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'security_abort'

export type CameraFacingMode = 'user' | 'environment'

export interface MinimalMediaStreamTrack {
  id?: string
  kind: 'audio' | 'video' | string
  enabled: boolean
  readyState?: 'live' | 'ended' | string
  onended?: (() => void) | null
  stop(): void
  addEventListener?: (event: string, listener: () => void) => void
  removeEventListener?: (event: string, listener: () => void) => void
}

export interface MinimalMediaStream {
  id?: string
  getTracks(): MinimalMediaStreamTrack[]
  getAudioTracks(): MinimalMediaStreamTrack[]
  getVideoTracks(): MinimalMediaStreamTrack[]
  addTrack?: (track: MinimalMediaStreamTrack) => void
  removeTrack?: (track: MinimalMediaStreamTrack) => void
}

export interface MinimalRtpSender {
  track: MinimalMediaStreamTrack | null
  replaceTrack(newTrack: MinimalMediaStreamTrack | null): Promise<void>
}

export interface MinimalDataChannel {
  label: string
  readyState: 'connecting' | 'open' | 'closing' | 'closed' | string
  onopen?: (() => void) | null
  onclose?: (() => void) | null
  onerror?: ((err: unknown) => void) | null
  onmessage?: ((event: { data: string }) => void) | null
  send(data: string): void
  close(): void
}

export interface MinimalPeerConnection {
  connectionState?: string
  iceConnectionState?: string
  iceGatheringState?: 'new' | 'gathering' | 'complete' | string
  signalingState?: string
  localDescription?: { type: 'offer' | 'answer' | string; sdp: string } | null
  remoteDescription?: { type: 'offer' | 'answer' | string; sdp: string } | null
  onicecandidate?:
    | ((event: { candidate: { candidate: string } | null }) => void)
    | null
  onicegatheringstatechange?: (() => void) | null
  onconnectionstatechange?: (() => void) | null
  oniceconnectionstatechange?: (() => void) | null
  ontrack?:
    | ((event: {
        track: MinimalMediaStreamTrack
        streams?: readonly MinimalMediaStream[]
      }) => void)
    | null
  ondatachannel?: ((event: { channel: MinimalDataChannel }) => void) | null
  addTrack(
    track: MinimalMediaStreamTrack,
    ...streams: MinimalMediaStream[]
  ): MinimalRtpSender
  removeTrack?: (sender: MinimalRtpSender) => void
  getSenders?(): MinimalRtpSender[]
  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): MinimalDataChannel
  createOffer(): Promise<{ type: 'offer' | string; sdp: string }>
  createAnswer(): Promise<{ type: 'answer' | string; sdp: string }>
  setLocalDescription(desc: {
    type: 'offer' | 'answer' | string
    sdp: string
  }): Promise<void>
  setRemoteDescription(desc: {
    type: 'offer' | 'answer' | string
    sdp: string
  }): Promise<void>
  close(): void
}

export interface MinimalMediaDevices {
  getUserMedia(constraints: {
    audio?:
      | boolean
      | {
          echoCancellation?: boolean
          noiseSuppression?: boolean
          autoGainControl?: boolean
        }
    video?: boolean | { facingMode?: CameraFacingMode }
  }): Promise<MinimalMediaStream>
  getDisplayMedia?(constraints: {
    video: boolean
    audio?: boolean
  }): Promise<MinimalMediaStream>
}

export interface WebRtcCallControllerSnapshot {
  callId: string
  phase: WebRtcCallControllerPhase
  mediaMode: WebRtcMediaIntent
  icePolicy: WebRtcIceTransportPolicy
  localMuted: boolean
  remoteMuted: boolean
  videoEnabled: boolean
  remoteVideoEnabled: boolean
  screenShareEnabled: boolean
  remoteScreenShareEnabled: boolean
  cameraFacingMode: CameraFacingMode
  videoDegradedOrDenied: boolean
  answeredElsewhere: boolean
  dtlsVerified: boolean
  securityViolationReason: string | null
  localFingerprintSha256: string | null
  expectedRemoteFingerprintSha256: string | null
  dataChannelOpen: boolean
  relayMessagesSentCount: number
  dataChannelMessagesSentCount: number
}

export interface WebRtcCallControllerListener {
  onPhaseChange?: (phase: WebRtcCallControllerPhase) => void
  onStateChange?: (snapshot: WebRtcCallControllerSnapshot) => void
  onRemoteStream?: (stream: MinimalMediaStream | null) => void
  onLocalStream?: (stream: MinimalMediaStream | null) => void
  onSecurityViolation?: (reason: string) => void
}

export interface WebRtcCallControllerOptions
  extends WebRtcCallControllerListener {
  callId?: string
  senderDeviceId?: string
  localPeerId?: string
  remotePeerId?: string
  icePolicy?: WebRtcIceTransportPolicy
  stunUrls?: string[]
  turnServers?: RTCIceServer[]
  gatherTimeoutMs?: number
  inviteTtlMs?: number
  nowMs?: () => number
  peerConnectionFactory?: (
    config: RTCConfiguration & { certificates?: unknown[] },
  ) => MinimalPeerConnection
  mediaDevices?: MinimalMediaDevices
  generateCertificate?: (
    keygenAlgorithm: Record<string, unknown>,
  ) => Promise<unknown>
}

export type WebRtcCallSessionControllerOptions = WebRtcCallControllerOptions

const DEFAULT_FALLBACK_TURN_SERVERS: RTCIceServer[] = [
  {
    urls: 'turn:turn.frank.local:3478',
    username: 'ephemeral',
    credential: 'ephemeral',
  },
]

function generateEphemeralFingerprintSha256(): string {
  const bytes = new Uint8Array(32)
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 37 + 11) & 0xff
    }
  }
  return Array.from(bytes, b =>
    b.toString(16).padStart(2, '0').toUpperCase(),
  ).join(':')
}

function ensureSdpHasFingerprint(
  sdp: string,
  fallbackFingerprint: string,
): { sdp: string; fingerprint: string } {
  const existing = extractSdpDtlsFingerprintSha256(sdp)
  if (existing) {
    return { sdp, fingerprint: existing }
  }
  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n'
  const trimmed = sdp.replace(/(\r?\n)+$/, '')
  const nextSdp = `${trimmed}${lineEnding}a=fingerprint:sha-256 ${fallbackFingerprint}${lineEnding}`
  return { sdp: nextSdp, fingerprint: fallbackFingerprint }
}

function createSyntheticMediaStream(
  initialTracks: MinimalMediaStreamTrack[] = [],
): MinimalMediaStream {
  const tracks = [...initialTracks]
  return {
    id: `stream_${Math.random().toString(36).slice(2, 10)}`,
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    addTrack(track: MinimalMediaStreamTrack) {
      if (!tracks.includes(track)) {
        tracks.push(track)
      }
    },
    removeTrack(track: MinimalMediaStreamTrack) {
      const idx = tracks.indexOf(track)
      if (idx !== -1) {
        tracks.splice(idx, 1)
      }
    },
  }
}

export class WebRtcCallSessionController {
  private callId: string
  private readonly senderDeviceId: string
  private readonly localPeerId: string
  private readonly remotePeerId: string
  private icePolicy: WebRtcIceTransportPolicy
  private readonly stunUrls: string[]
  private readonly turnServers: RTCIceServer[]
  private readonly gatherTimeoutMs: number
  private readonly inviteTtlMs: number
  private readonly nowMs: () => number
  private readonly peerConnectionFactory: (
    config: RTCConfiguration & { certificates?: unknown[] },
  ) => MinimalPeerConnection
  private readonly mediaDevices: MinimalMediaDevices
  private readonly generateCertificateFn?: (
    keygenAlgorithm: Record<string, unknown>,
  ) => Promise<unknown>
  private readonly onPhaseChange?: (phase: WebRtcCallControllerPhase) => void
  private readonly onStateChange?: (
    snapshot: WebRtcCallControllerSnapshot,
  ) => void
  private readonly onRemoteStream?: (stream: MinimalMediaStream | null) => void
  private readonly onLocalStream?: (stream: MinimalMediaStream | null) => void
  private readonly onSecurityViolation?: (reason: string) => void

  private phase: WebRtcCallControllerPhase = 'idle'
  private mediaMode: WebRtcMediaIntent = 'audio'
  private localMuted = false
  private remoteMuted = false
  private videoEnabled = false
  private remoteVideoEnabled = false
  private screenShareEnabled = false
  private remoteScreenShareEnabled = false
  private cameraFacingMode: CameraFacingMode = 'user'
  private videoDegradedOrDenied = false
  private answeredElsewhere = false
  private dtlsVerified = false
  private securityViolationReason: string | null = null
  private localFingerprintSha256: string | null = null
  private expectedRemoteFingerprintSha256: string | null = null
  private pendingIncomingInvite: WebRtcCallPayload | null = null

  private pc: MinimalPeerConnection | null = null
  private controlChannel: MinimalDataChannel | null = null
  private localStream: MinimalMediaStream | null = null
  private remoteStream: MinimalMediaStream | null = null
  private screenTrack: MinimalMediaStreamTrack | null = null
  private videoSender: MinimalRtpSender | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private signalingSequence = 0
  private dataChannelSeq = 0
  private relayMessagesSentCount = 0
  private dataChannelMessagesSentCount = 0
  private readonly listeners = new Set<WebRtcCallControllerListener>()
  private readonly processedSignalingKeys = new Set<string>()

  constructor(options: WebRtcCallControllerOptions = {}) {
    this.callId = options.callId ?? generateCallId()
    this.senderDeviceId = options.senderDeviceId ?? 'dev_browser_1'
    this.localPeerId = options.localPeerId ?? '0xlocal'
    this.remotePeerId = options.remotePeerId ?? '0xremote'
    this.icePolicy = options.icePolicy ?? 'direct-preferred'
    this.stunUrls = options.stunUrls ?? ['stun:stun.l.google.com:19302']
    this.turnServers =
      options.turnServers ??
      (this.icePolicy === 'relay-only' ? DEFAULT_FALLBACK_TURN_SERVERS : [])
    this.gatherTimeoutMs =
      options.gatherTimeoutMs ?? DEFAULT_ICE_GATHER_TIMEOUT_MS
    this.inviteTtlMs = options.inviteTtlMs ?? DEFAULT_CALL_INVITE_TTL_MS
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.peerConnectionFactory =
      options.peerConnectionFactory ??
      (config => {
        const Ctor = (
          globalThis as unknown as {
            RTCPeerConnection?: new (
              cfg?: RTCConfiguration,
            ) => MinimalPeerConnection
          }
        ).RTCPeerConnection
        if (!Ctor) {
          throw new Error('RTCPeerConnection is not available in this browser')
        }
        return new Ctor(config)
      })
    this.mediaDevices =
      options.mediaDevices ??
      ((
        globalThis.navigator as unknown as {
          mediaDevices?: MinimalMediaDevices
        }
      )?.mediaDevices as MinimalMediaDevices)
    this.generateCertificateFn =
      options.generateCertificate ??
      (typeof (
        globalThis as unknown as {
          RTCPeerConnection?: {
            generateCertificate?: (
              alg: Record<string, unknown>,
            ) => Promise<unknown>
          }
        }
      ).RTCPeerConnection?.generateCertificate === 'function'
        ? alg =>
            (
              globalThis as unknown as {
                RTCPeerConnection: {
                  generateCertificate: (
                    a: Record<string, unknown>,
                  ) => Promise<unknown>
                }
              }
            ).RTCPeerConnection.generateCertificate(alg)
        : undefined)
    this.onPhaseChange = options.onPhaseChange
    this.onStateChange = options.onStateChange
    this.onRemoteStream = options.onRemoteStream
    this.onLocalStream = options.onLocalStream
    this.onSecurityViolation = options.onSecurityViolation
  }

  public subscribe(listener: WebRtcCallControllerListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public getSnapshot(): WebRtcCallControllerSnapshot {
    return {
      callId: this.callId,
      phase: this.phase,
      mediaMode: this.mediaMode,
      icePolicy: this.icePolicy,
      localMuted: this.localMuted,
      remoteMuted: this.remoteMuted,
      videoEnabled: this.videoEnabled,
      remoteVideoEnabled: this.remoteVideoEnabled,
      screenShareEnabled: this.screenShareEnabled,
      remoteScreenShareEnabled: this.remoteScreenShareEnabled,
      cameraFacingMode: this.cameraFacingMode,
      videoDegradedOrDenied: this.videoDegradedOrDenied,
      answeredElsewhere: this.answeredElsewhere,
      dtlsVerified: this.dtlsVerified,
      securityViolationReason: this.securityViolationReason,
      localFingerprintSha256: this.localFingerprintSha256,
      expectedRemoteFingerprintSha256: this.expectedRemoteFingerprintSha256,
      dataChannelOpen: this.controlChannel?.readyState === 'open',
      relayMessagesSentCount: this.relayMessagesSentCount,
      dataChannelMessagesSentCount: this.dataChannelMessagesSentCount,
    }
  }

  public getLocalStream(): MinimalMediaStream | null {
    return this.localStream
  }

  public getRemoteStream(): MinimalMediaStream | null {
    return this.remoteStream
  }

  public getPeerConnection(): MinimalPeerConnection | null {
    return this.pc
  }

  public getControlDataChannel(): MinimalDataChannel | null {
    return this.controlChannel
  }

  public getLocalPeerId(): string {
    return this.localPeerId
  }

  public getRemotePeerId(): string {
    return this.remotePeerId
  }

  private nextSignalingSequence(): number {
    const seq = this.signalingSequence
    this.signalingSequence += 1
    return seq
  }

  private nextDataChannelSeq(): number {
    this.dataChannelSeq += 1
    return this.dataChannelSeq
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  private scheduleExpiryTimer(expiresAtMs?: number): void {
    this.clearExpiryTimer()
    if (expiresAtMs === undefined) return
    const delayMs = expiresAtMs - this.nowMs()
    if (delayMs <= 0 || delayMs > 3_600_000) return
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      if (
        this.phase === 'ringing_outgoing' ||
        this.phase === 'ringing_incoming'
      ) {
        this.cleanup()
        this.setPhase('expired')
      }
    }, delayMs)
    ;(this.expiryTimer as unknown as { unref?: () => void })?.unref?.()
  }

  private setPhase(next: WebRtcCallControllerPhase): void {
    if (next !== 'ringing_outgoing' && next !== 'ringing_incoming') {
      this.clearExpiryTimer()
    }
    const changed = this.phase !== next
    this.phase = next
    if (changed) {
      this.onPhaseChange?.(next)
      for (const listener of this.listeners) {
        listener.onPhaseChange?.(next)
      }
    }
    this.emitState()
  }

  private emitState(): void {
    const snap = this.getSnapshot()
    this.onStateChange?.(snap)
    for (const listener of this.listeners) {
      listener.onStateChange?.(snap)
    }
    notifyActiveCallRegistryListeners()
  }

  private notifyLocalStream(stream: MinimalMediaStream | null): void {
    this.onLocalStream?.(stream)
    for (const listener of this.listeners) {
      listener.onLocalStream?.(stream)
    }
  }

  private notifyRemoteStream(stream: MinimalMediaStream | null): void {
    this.onRemoteStream?.(stream)
    for (const listener of this.listeners) {
      listener.onRemoteStream?.(stream)
    }
  }

  private notifySecurityViolation(reason: string): void {
    this.onSecurityViolation?.(reason)
    for (const listener of this.listeners) {
      listener.onSecurityViolation?.(reason)
    }
  }

  private async createConfiguredPeerConnection(): Promise<MinimalPeerConnection> {
    const turnServersToUse =
      this.turnServers.length > 0
        ? this.turnServers
        : this.icePolicy === 'relay-only'
        ? DEFAULT_FALLBACK_TURN_SERVERS
        : []
    const rtcConfig = buildRtcConfiguration({
      policy: this.icePolicy,
      stunUrls: this.stunUrls,
      turnServers: turnServersToUse,
    })

    let certificates: unknown[] | undefined
    if (this.generateCertificateFn) {
      try {
        const cert = await this.generateCertificateFn({
          name: 'ECDSA',
          namedCurve: 'P-256',
        })
        if (cert) {
          certificates = [cert]
        }
      } catch {
        // Browser or test environment does not support certificate generation; continue with default
      }
    }

    const pc = this.peerConnectionFactory({
      ...rtcConfig,
      ...(certificates ? { certificates } : {}),
    })

    pc.ontrack = event => {
      if (this.phase === 'security_abort' || !this.dtlsVerified) {
        event.track.stop()
        return
      }
      const stream =
        event.streams?.[0] ??
        this.remoteStream ??
        createSyntheticMediaStream([event.track])
      if (!event.streams?.[0] && stream.addTrack) {
        stream.addTrack(event.track)
      }
      this.remoteStream = stream
      if (event.track.kind === 'video') {
        this.remoteVideoEnabled = true
      }
      this.notifyRemoteStream(this.remoteStream)
      this.emitState()
    }

    const handleConnChange = () => {
      if (!this.pc) return
      const state = this.pc.connectionState ?? this.pc.iceConnectionState
      if (state === 'connected' || state === 'completed') {
        if (this.phase === 'security_abort' || !this.dtlsVerified) {
          this.abortOnSecurityViolation('unverified-dtls-connection')
          return
        }
        this.setPhase('connected')
      } else if (state === 'failed' || state === 'closed') {
        if (
          this.phase !== 'security_abort' &&
          this.phase !== 'ended' &&
          this.phase !== 'rejected' &&
          this.phase !== 'cancelled'
        ) {
          this.cleanup()
          this.setPhase('ended')
        }
      }
    }

    pc.onconnectionstatechange = handleConnChange
    pc.oniceconnectionstatechange = handleConnChange

    pc.ondatachannel = event => {
      if (event.channel.label === WEBRTC_CONTROL_DATA_CHANNEL_LABEL) {
        this.attachControlDataChannel(event.channel)
      }
    }

    this.pc = pc
    return pc
  }

  private attachControlDataChannel(channel: MinimalDataChannel): void {
    this.controlChannel = channel
    channel.onopen = () => {
      if (
        this.phase === 'connecting' ||
        this.phase === 'ringing_outgoing' ||
        this.phase === 'ringing_incoming'
      ) {
        if (this.dtlsVerified) {
          this.setPhase('connected')
        }
      } else {
        this.emitState()
      }
    }
    channel.onclose = () => {
      if (this.phase === 'connected') {
        this.cleanup()
        this.setPhase('ended')
        return
      }
      this.emitState()
    }
    channel.onmessage = event => {
      void this.handleControlDataChannelMessage(event.data)
    }
  }

  private sendControlMessage(msg: WebRtcDataChannelMessage): boolean {
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      return false
    }
    const encoded = encodeDataChannelMessage(msg)
    this.controlChannel.send(encoded)
    this.dataChannelMessagesSentCount += 1
    this.emitState()
    return true
  }

  private async handleControlDataChannelMessage(raw: string): Promise<void> {
    if (!this.expectedRemoteFingerprintSha256) {
      return
    }

    let parsed: WebRtcDataChannelMessage
    try {
      parsed = decodeDataChannelMessage(
        raw,
        this.expectedRemoteFingerprintSha256,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('fingerprint')) {
        this.abortOnSecurityViolation('dtls-fingerprint-mismatch')
      }
      return
    }

    switch (parsed.type) {
      case 'mute_state':
        this.remoteMuted = parsed.muted
        this.remoteVideoEnabled = parsed.videoEnabled
        this.remoteScreenShareEnabled = parsed.screenSharing
        if (parsed.screenSharing) {
          this.mediaMode = 'screen'
        } else if (parsed.videoEnabled || this.videoEnabled) {
          this.mediaMode = 'video'
        } else {
          this.mediaMode = 'audio'
        }
        this.emitState()
        break

      case 'renegotiate_offer': {
        if (!this.pc) {
          return
        }
        await this.pc.setRemoteDescription({
          type: 'offer',
          sdp: parsed.sdp,
        })
        const answer = await this.pc.createAnswer()
        const ensured = ensureSdpHasFingerprint(
          answer.sdp,
          this.localFingerprintSha256 ?? generateEphemeralFingerprintSha256(),
        )
        await this.pc.setLocalDescription({
          type: 'answer',
          sdp: ensured.sdp,
        })
        const sanitizedAnswer = sanitizeSdpForIcePolicy(
          ensured.sdp,
          this.icePolicy,
        )
        this.mediaMode = parsed.mediaIntent
        if (parsed.mediaIntent === 'screen') {
          this.remoteScreenShareEnabled = true
        } else if (parsed.mediaIntent === 'video') {
          this.remoteVideoEnabled = true
          this.remoteScreenShareEnabled = false
        }
        this.sendControlMessage({
          type: 'renegotiate_answer',
          sdp: sanitizedAnswer,
          dtlsFingerprintSha256: ensured.fingerprint,
          seq: this.nextDataChannelSeq(),
        })
        this.emitState()
        break
      }

      case 'renegotiate_answer': {
        if (!this.pc) {
          return
        }
        await this.pc.setRemoteDescription({
          type: 'answer',
          sdp: parsed.sdp,
        })
        this.emitState()
        break
      }

      case 'hangup':
        this.cleanup()
        this.setPhase('ended')
        break

      case 'ping':
        this.sendControlMessage({
          type: 'pong',
          timestampMs: parsed.timestampMs,
        })
        break

      case 'pong':
        break
    }
  }

  private async gatherBundledSdp(
    pc: MinimalPeerConnection,
    descType: 'offer' | 'answer',
    initialSdp: string,
  ): Promise<{
    sdp: string
    fingerprintSha256: string
    candidates: string[]
  }> {
    const collectedCandidates: string[] = []
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }

      const timer = setTimeout(finish, this.gatherTimeoutMs)

      const prevOnCandidate = pc.onicecandidate
      pc.onicecandidate = event => {
        prevOnCandidate?.(event)
        if (!event.candidate) {
          finish()
          return
        }
        const candStr = event.candidate.candidate
        if (candStr && filterCandidateForIcePolicy(candStr, this.icePolicy)) {
          collectedCandidates.push(
            candStr.startsWith('a=') ? candStr : `a=${candStr}`,
          )
        }
      }

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          finish()
        }
      }

      pc.setLocalDescription({
        type: descType,
        sdp: initialSdp,
      })
        .then(() => {
          if (
            pc.iceGatheringState === 'complete' ||
            this.gatherTimeoutMs <= 0
          ) {
            finish()
          }
        })
        .catch(err => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err)
          }
        })
    })

    let combinedSdp = pc.localDescription?.sdp || initialSdp
    // In real browsers, `pc.localDescription.sdp` already embeds gathered candidates into their
    // respective `m=` media sections; appending audio/video candidates at the end of a multi-m-line
    // SDP places them under `m=application` with a mismatched `ice-ufrag`. Only append synthetic
    // candidates when `localDescription.sdp` has not inlined any `a=candidate:` lines (e.g. test mocks).
    if (!/^a=candidate:/m.test(combinedSdp)) {
      const lineEnding = combinedSdp.includes('\r\n') ? '\r\n' : '\n'
      for (const cand of collectedCandidates) {
        if (!combinedSdp.includes(cand)) {
          combinedSdp = `${combinedSdp.replace(/(\r?\n)+$/, '')}${lineEnding}${cand}${lineEnding}`
        }
      }
    }

    const ensured = ensureSdpHasFingerprint(
      combinedSdp,
      this.localFingerprintSha256 ?? generateEphemeralFingerprintSha256(),
    )
    this.localFingerprintSha256 = ensured.fingerprint
    const sanitized = sanitizeSdpForIcePolicy(ensured.sdp, this.icePolicy)
    return {
      sdp: sanitized,
      fingerprintSha256: ensured.fingerprint,
      candidates: collectedCandidates,
    }
  }

  private async acquireInitialMedia(params: {
    withVideo: boolean
  }): Promise<MinimalMediaStream> {
    if (
      !this.mediaDevices ||
      typeof this.mediaDevices.getUserMedia !== 'function'
    ) {
      throw new Error('MediaDevices.getUserMedia is not available')
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }

    if (params.withVideo) {
      try {
        const stream = await this.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: { facingMode: this.cameraFacingMode },
        })
        this.videoEnabled = stream.getVideoTracks().length > 0
        this.mediaMode = this.videoEnabled ? 'video' : 'audio'
        this.attachTrackEndListeners(stream)
        return stream
      } catch {
        // Camera permission denied or unavailable: fall back to audio-only without failing the call
        this.videoDegradedOrDenied = true
        this.videoEnabled = false
        this.mediaMode = 'audio'
      }
    }

    const audioStream = await this.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    })
    this.attachTrackEndListeners(audioStream)
    return audioStream
  }

  private attachTrackEndListeners(stream: MinimalMediaStream): void {
    for (const track of stream.getTracks()) {
      const prevEnded = track.onended
      track.onended = () => {
        prevEnded?.()
        if (track.kind === 'audio' && this.phase === 'connected') {
          // Microphone hardware unplugged mid-call: clean up deterministically
          this.cleanup()
          this.setPhase('ended')
        }
      }
    }
  }

  /**
   * Starts an outgoing 1:1 WebRTC call on explicit user click.
   * Requests microphone (and optional camera), generates an ephemeral DTLS identity,
   * bundles and sanitizes ICE candidates according to `icePolicy`, and returns the
   * `invite` payload + application message item for Frank DM delivery.
   */
  public async startOutgoingCall(options?: {
    withVideo?: boolean
    icePolicy?: WebRtcIceTransportPolicy
  }): Promise<{
    payload: WebRtcCallPayload
    item: ApplicationMessageItem
  }> {
    if (options?.icePolicy) {
      this.icePolicy = options.icePolicy
    }
    const withVideo = Boolean(options?.withVideo)
    this.mediaMode = withVideo ? 'video' : 'audio'

    try {
      const stream = await this.acquireInitialMedia({ withVideo })
      this.localStream = stream
      this.notifyLocalStream(stream)

      const pc = await this.createConfiguredPeerConnection()
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream)
        if (track.kind === 'video') {
          this.videoSender = sender
        }
      }

      const channel = pc.createDataChannel(WEBRTC_CONTROL_DATA_CHANNEL_LABEL, {
        ordered: true,
      })
      this.attachControlDataChannel(channel)

      const rawOffer = await pc.createOffer()
      const ensured = ensureSdpHasFingerprint(
        rawOffer.sdp,
        generateEphemeralFingerprintSha256(),
      )
      this.localFingerprintSha256 = ensured.fingerprint

      const bundled = await this.gatherBundledSdp(pc, 'offer', ensured.sdp)
      const now = this.nowMs()
      const payload: WebRtcCallPayload = {
        schemaVersion: 1,
        callId: this.callId,
        action: 'invite',
        sequence: this.nextSignalingSequence(),
        senderDeviceId: this.senderDeviceId,
        mediaIntent: this.mediaMode,
        icePolicy: this.icePolicy,
        sdp: bundled.sdp,
        dtlsFingerprintSha256: bundled.fingerprintSha256,
        ...(bundled.candidates.length > 0
          ? { candidates: bundled.candidates }
          : {}),
        expiresAtMs: now + this.inviteTtlMs,
      }
      this.relayMessagesSentCount += 1
      this.setPhase('ringing_outgoing')
      this.scheduleExpiryTimer(payload.expiresAtMs)
      return {
        payload,
        item: toWebRtcCallApplicationItem(payload),
      }
    } catch (err) {
      this.cleanup()
      this.setPhase('ended')
      throw err
    }
  }

  /**
   * Registers an incoming `invite` payload without activating microphone/camera hardware
   * or starting ICE candidate transmission until the user explicitly accepts.
   */
  public receiveIncomingInvite(
    invite: WebRtcCallPayload,
    remoteCallerAddress?: string,
  ): {
    acceptedForRinging: boolean
    reason?: string
  } {
    if (invite.action !== 'invite') {
      return { acceptedForRinging: false, reason: 'not_an_invite' }
    }

    const now = this.nowMs()
    if (invite.expiresAtMs !== undefined && invite.expiresAtMs <= now) {
      this.callId = invite.callId
      this.setPhase('expired')
      return { acceptedForRinging: false, reason: 'invite_expired' }
    }

    if (
      !invite.sdp ||
      !invite.dtlsFingerprintSha256 ||
      !verifyRemoteSdpFingerprint(invite.sdp, invite.dtlsFingerprintSha256)
    ) {
      this.callId = invite.callId
      this.abortOnSecurityViolation('dtls-fingerprint-mismatch')
      return {
        acceptedForRinging: false,
        reason: 'dtls-fingerprint-mismatch',
      }
    }

    if (this.phase === 'ringing_outgoing' && invite.callId !== this.callId) {
      return this.resolveSimultaneousGlare(invite, remoteCallerAddress)
    }

    if (this.phase !== 'idle' && invite.callId !== this.callId) {
      // Ignore cross-call injection while another call is active
      return { acceptedForRinging: false, reason: 'cross_call_ignored' }
    }

    this.callId = invite.callId
    this.mediaMode = invite.mediaIntent ?? 'audio'
    this.icePolicy = invite.icePolicy ?? this.icePolicy
    this.expectedRemoteFingerprintSha256 =
      invite.dtlsFingerprintSha256 ?? null
    this.pendingIncomingInvite = invite
    this.setPhase('ringing_incoming')
    this.scheduleExpiryTimer(invite.expiresAtMs)
    return { acceptedForRinging: true }
  }

  /**
   * Deterministic glare resolution when both peers send `invite` simultaneously.
   * Uses `resolveGlareWinner` over `(callerAddress, callId)`.
   * If local wins (`'A'`), keeps the outgoing offer; if remote wins (`'B'`), cleans up
   * the outgoing PeerConnection and transitions to `ringing_incoming` for the winning invite.
   */
  public resolveSimultaneousGlare(
    invite: WebRtcCallPayload,
    remoteCallerAddress?: string,
  ): {
    acceptedForRinging: boolean
    reason: 'glare_won_keep_outgoing' | 'glare_lost_switched_to_incoming'
  } {
    const winner = resolveGlareWinner(
      { callerAddress: this.localPeerId, callId: this.callId },
      {
        callerAddress: remoteCallerAddress ?? this.remotePeerId,
        callId: invite.callId,
      },
    )
    if (winner === 'A') {
      return {
        acceptedForRinging: false,
        reason: 'glare_won_keep_outgoing',
      }
    }
    this.cleanup()
    this.callId = invite.callId
    this.mediaMode = invite.mediaIntent ?? 'audio'
    this.icePolicy = invite.icePolicy ?? this.icePolicy
    this.expectedRemoteFingerprintSha256 =
      invite.dtlsFingerprintSha256 ?? null
    this.pendingIncomingInvite = invite
    this.setPhase('ringing_incoming')
    this.scheduleExpiryTimer(invite.expiresAtMs)
    return {
      acceptedForRinging: true,
      reason: 'glare_lost_switched_to_incoming',
    }
  }

  /**
   * Accepts a ringing incoming call on explicit user click ("Answer Audio" or "Answer Video").
   * Verifies the remote offer's DTLS fingerprint against the Frank-authenticated `invite` before
   * applying the remote SDP or enabling media.
   */
  public async acceptIncomingCall(options?: {
    withVideo?: boolean
    invite?: WebRtcCallPayload
  }): Promise<{
    payload: WebRtcCallPayload
    item: ApplicationMessageItem
  }> {
    const invite = options?.invite ?? this.pendingIncomingInvite
    if (!invite || invite.action !== 'invite') {
      throw new Error('No pending incoming call invite to accept')
    }

    if (invite.callId !== this.callId && this.phase !== 'idle') {
      throw new Error('Cross-call invite mismatch')
    }

    const now = this.nowMs()
    if (invite.expiresAtMs !== undefined && invite.expiresAtMs <= now) {
      this.cleanup()
      this.setPhase('expired')
      throw new Error('Cannot accept expired call invite')
    }

    this.callId = invite.callId
    this.expectedRemoteFingerprintSha256 =
      invite.dtlsFingerprintSha256 ?? null

    if (
      !invite.sdp ||
      !this.expectedRemoteFingerprintSha256 ||
      !verifyRemoteSdpFingerprint(
        invite.sdp,
        this.expectedRemoteFingerprintSha256,
      )
    ) {
      this.abortOnSecurityViolation('dtls-fingerprint-mismatch')
      throw new Error('Remote DTLS fingerprint verification failed')
    }
    this.dtlsVerified = true

    const withVideo =
      options?.withVideo ?? invite.mediaIntent === 'video'

    try {
      const stream = await this.acquireInitialMedia({ withVideo })
      this.localStream = stream
      this.notifyLocalStream(stream)

      const pc = await this.createConfiguredPeerConnection()
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream)
        if (track.kind === 'video') {
          this.videoSender = sender
        }
      }

      await pc.setRemoteDescription({
        type: 'offer',
        sdp: invite.sdp,
      })

      const rawAnswer = await pc.createAnswer()
      const ensured = ensureSdpHasFingerprint(
        rawAnswer.sdp,
        generateEphemeralFingerprintSha256(),
      )
      this.localFingerprintSha256 = ensured.fingerprint

      const bundled = await this.gatherBundledSdp(pc, 'answer', ensured.sdp)
      const payload: WebRtcCallPayload = {
        schemaVersion: 1,
        callId: this.callId,
        action: 'accept',
        sequence: this.nextSignalingSequence(),
        senderDeviceId: this.senderDeviceId,
        mediaIntent: this.mediaMode,
        icePolicy: this.icePolicy,
        sdp: bundled.sdp,
        dtlsFingerprintSha256: bundled.fingerprintSha256,
        ...(bundled.candidates.length > 0
          ? { candidates: bundled.candidates }
          : {}),
      }
      this.relayMessagesSentCount += 1
      this.setPhase('connecting')
      if (
        pc.connectionState === 'connected' ||
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed' ||
        this.controlChannel?.readyState === 'open'
      ) {
        this.setPhase('connected')
      }
      return {
        payload,
        item: toWebRtcCallApplicationItem(payload),
      }
    } catch (err) {
      this.cleanup()
      if ((this.phase as string) !== 'security_abort') {
        this.setPhase('ended')
      }
      throw err
    }
  }

  /**
   * Handles the callee's `accept` payload on the caller side.
   * Strictly verifies the remote SDP answer's `a=fingerprint:sha-256` against the
   * `dtlsFingerprintSha256` bound in the authenticated `accept` payload before applying it.
   */
  public async handleIncomingAccept(
    acceptPayload: WebRtcCallPayload,
  ): Promise<boolean> {
    if (acceptPayload.action !== 'accept') {
      return false
    }
    if (acceptPayload.callId !== this.callId) {
      // Reject cross-call injection without disturbing the active call
      return false
    }
    if (this.phase !== 'ringing_outgoing' || !this.pc) {
      return false
    }

    this.expectedRemoteFingerprintSha256 =
      acceptPayload.dtlsFingerprintSha256 ?? null
    if (
      !acceptPayload.sdp ||
      !this.expectedRemoteFingerprintSha256 ||
      !verifyRemoteSdpFingerprint(
        acceptPayload.sdp,
        this.expectedRemoteFingerprintSha256,
      )
    ) {
      this.abortOnSecurityViolation('dtls-fingerprint-mismatch')
      return false
    }

    this.dtlsVerified = true
    if (acceptPayload.mediaIntent === 'video') {
      this.remoteVideoEnabled = true
    }
    this.setPhase('connecting')
    await this.pc.setRemoteDescription({
      type: 'answer',
      sdp: acceptPayload.sdp,
    })
    if (
      this.pc.connectionState === 'connected' ||
      this.pc.iceConnectionState === 'connected' ||
      this.pc.iceConnectionState === 'completed' ||
      this.controlChannel?.readyState === 'open'
    ) {
      this.setPhase('connected')
    }
    return true
  }

  /**
   * Handles incoming or multi-device outbound signaling events (`accept`, `reject`, `cancel`, `hangup`, `ice_batch`).
   */
  public async handleSignalingPayload(
    payload: WebRtcCallPayload,
    options?: { outbound?: boolean },
  ): Promise<void> {
    if (payload.callId !== this.callId) {
      if (payload.action === 'invite' && this.phase === 'ringing_outgoing') {
        this.resolveSimultaneousGlare(payload)
      }
      return
    }

    const isOutbound = Boolean(options?.outbound)
    const sigKey = `${payload.action}:${payload.sequence}:${payload.senderDeviceId}:${isOutbound ? 'out' : 'in'}`
    if (this.processedSignalingKeys.has(sigKey)) {
      return
    }
    this.processedSignalingKeys.add(sigKey)

    if (
      this.phase === 'ringing_incoming' &&
      (payload.action === 'accept' || payload.action === 'reject') &&
      (isOutbound || payload.senderDeviceId !== this.senderDeviceId)
    ) {
      // Multi-device convergence: another device of this user answered or declined the call
      this.answeredElsewhere = true
      this.cleanup()
      this.setPhase(payload.action === 'reject' ? 'rejected' : 'ended')
      return
    }

    switch (payload.action) {
      case 'accept':
        if (!isOutbound) {
          await this.handleIncomingAccept(payload)
        }
        break
      case 'reject':
        this.cleanup()
        this.setPhase('rejected')
        break
      case 'cancel':
        this.cleanup()
        this.setPhase('cancelled')
        break
      case 'hangup':
        this.cleanup()
        this.setPhase('ended')
        break
      case 'ice_batch':
        break
    }
  }

  private sendMuteAndMediaStateOverDataChannel(): void {
    this.sendControlMessage({
      type: 'mute_state',
      muted: this.localMuted,
      videoEnabled: this.videoEnabled,
      screenSharing: this.screenShareEnabled,
      seq: this.nextDataChannelSeq(),
    })
  }

  /**
   * Toggles local microphone mute state.
   * Updates `MediaStreamTrack.enabled` and sends mute state over the P2P `RTCDataChannel`
   * without sending any extra Frank relay messages.
   */
  public toggleMute(): boolean {
    return this.setMuted(!this.localMuted)
  }

  public setMuted(muted: boolean): boolean {
    this.localMuted = Boolean(muted)
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !this.localMuted
      }
    }
    this.sendMuteAndMediaStateOverDataChannel()
    this.emitState()
    return this.localMuted
  }

  /**
   * Enables or disables local camera video mid-call (#466).
   * Communicates state and renegotiation directly over the P2P `RTCDataChannel`.
   * If camera permission is denied, preserves the active audio call!
   */
  public async setVideoEnabled(enabled: boolean): Promise<boolean> {
    if (!enabled) {
      if (this.localStream) {
        for (const track of this.localStream.getVideoTracks()) {
          track.stop()
          this.localStream.removeTrack?.(track)
        }
      }
      if (this.videoSender && !this.screenShareEnabled) {
        await this.videoSender.replaceTrack(null)
      }
      this.videoEnabled = false
      this.mediaMode = this.screenShareEnabled ? 'screen' : 'audio'
      this.sendMuteAndMediaStateOverDataChannel()
      this.emitState()
      return false
    }

    try {
      const videoStream = await this.mediaDevices.getUserMedia({
        video: { facingMode: this.cameraFacingMode },
      })
      const videoTrack = videoStream.getVideoTracks()[0]
      if (!videoTrack) {
        this.videoDegradedOrDenied = true
        this.emitState()
        return false
      }

      if (this.localStream) {
        for (const oldTrack of this.localStream.getVideoTracks()) {
          oldTrack.stop()
          this.localStream.removeTrack?.(oldTrack)
        }
        this.localStream.addTrack?.(videoTrack)
      } else {
        this.localStream = videoStream
      }
      this.notifyLocalStream(this.localStream)

      if (this.pc) {
        if (this.videoSender) {
          await this.videoSender.replaceTrack(videoTrack)
        } else {
          this.videoSender = this.pc.addTrack(videoTrack, this.localStream)
        }
      }

      this.videoEnabled = true
      this.videoDegradedOrDenied = false
      this.mediaMode = this.screenShareEnabled ? 'screen' : 'video'

      this.sendMuteAndMediaStateOverDataChannel()
      await this.renegotiateOverDataChannelIfOpen()
      this.emitState()
      return true
    } catch {
      // Preserve audio call when camera permission is denied or device is missing
      this.videoDegradedOrDenied = true
      this.videoEnabled = false
      this.emitState()
      return false
    }
  }

  /**
   * Switches between front (`'user'`) and rear (`'environment'`) camera mid-call (#466).
   */
  public async switchCameraFacingMode(): Promise<CameraFacingMode> {
    const nextMode: CameraFacingMode =
      this.cameraFacingMode === 'user' ? 'environment' : 'user'
    this.cameraFacingMode = nextMode
    if (this.videoEnabled) {
      await this.setVideoEnabled(true)
    } else {
      this.emitState()
    }
    return this.cameraFacingMode
  }

  /**
   * Starts or stops desktop/window screen sharing (`getDisplayMedia`) mid-call (#466).
   * Automatically stops screen sharing when the user clicks the browser's native
   * "Stop sharing" button (`track.onended`).
   */
  public async setScreenShareEnabled(enabled: boolean): Promise<boolean> {
    if (!enabled) {
      if (this.screenTrack) {
        const trackToStop = this.screenTrack
        this.screenTrack = null
        trackToStop.onended = null
        trackToStop.stop()
      }
      const cameraTrack = this.localStream?.getVideoTracks()[0] ?? null
      if (this.videoSender) {
        await this.videoSender.replaceTrack(
          this.videoEnabled ? cameraTrack : null,
        )
      }
      this.screenShareEnabled = false
      this.mediaMode = this.videoEnabled ? 'video' : 'audio'
      this.sendMuteAndMediaStateOverDataChannel()
      this.emitState()
      return false
    }

    if (
      !this.mediaDevices ||
      typeof this.mediaDevices.getDisplayMedia !== 'function'
    ) {
      this.videoDegradedOrDenied = true
      this.emitState()
      return false
    }

    try {
      const displayStream = await this.mediaDevices.getDisplayMedia({
        video: true,
      })
      const displayTrack = displayStream.getVideoTracks()[0]
      if (!displayTrack) {
        this.videoDegradedOrDenied = true
        this.emitState()
        return false
      }

      if (this.screenTrack) {
        this.screenTrack.stop()
      }
      this.screenTrack = displayTrack

      const handleScreenEnded = () => {
        if (this.screenShareEnabled) {
          void this.setScreenShareEnabled(false)
        }
      }
      displayTrack.onended = handleScreenEnded
      displayTrack.addEventListener?.('ended', handleScreenEnded)

      if (this.pc) {
        if (this.videoSender) {
          await this.videoSender.replaceTrack(displayTrack)
        } else {
          this.videoSender = this.pc.addTrack(displayTrack, displayStream)
        }
      }

      this.screenShareEnabled = true
      this.videoDegradedOrDenied = false
      this.mediaMode = 'screen'
      this.sendMuteAndMediaStateOverDataChannel()
      await this.renegotiateOverDataChannelIfOpen()
      this.emitState()
      return true
    } catch {
      // Preserve audio call when screen-share permission is denied or cancelled
      this.videoDegradedOrDenied = true
      this.screenShareEnabled = false
      this.emitState()
      return false
    }
  }

  /**
   * Automatically degrades/disables video & screen share when bandwidth collapses
   * so audio remains prioritized (#466).
   */
  public async degradeVideoForAudioPriority(): Promise<void> {
    if (this.screenShareEnabled) {
      await this.setScreenShareEnabled(false)
    }
    if (this.videoEnabled) {
      await this.setVideoEnabled(false)
    }
    this.videoDegradedOrDenied = true
    this.mediaMode = 'audio'
    this.emitState()
  }

  private async renegotiateOverDataChannelIfOpen(): Promise<void> {
    if (
      !this.pc ||
      !this.controlChannel ||
      this.controlChannel.readyState !== 'open'
    ) {
      return
    }
    const offer = await this.pc.createOffer()
    const ensured = ensureSdpHasFingerprint(
      offer.sdp,
      this.localFingerprintSha256 ?? generateEphemeralFingerprintSha256(),
    )
    this.localFingerprintSha256 = ensured.fingerprint
    await this.pc.setLocalDescription({
      type: 'offer',
      sdp: ensured.sdp,
    })
    const sanitized = sanitizeSdpForIcePolicy(ensured.sdp, this.icePolicy)
    this.sendControlMessage({
      type: 'renegotiate_offer',
      mediaIntent: this.mediaMode,
      sdp: sanitized,
      dtlsFingerprintSha256: ensured.fingerprint,
      seq: this.nextDataChannelSeq(),
    })
  }

  /**
   * Declines an incoming ringing call before media or ICE is ever started.
   */
  public rejectIncomingCall(reason = 'declined'): {
    payload: WebRtcCallPayload
    item: ApplicationMessageItem
  } {
    const payload: WebRtcCallPayload = {
      schemaVersion: 1,
      callId: this.callId,
      action: 'reject',
      sequence: this.nextSignalingSequence(),
      senderDeviceId: this.senderDeviceId,
      reason,
    }
    this.relayMessagesSentCount += 1
    this.cleanup()
    this.setPhase('rejected')
    return {
      payload,
      item: toWebRtcCallApplicationItem(payload),
    }
  }

  /**
   * Cancels an outgoing ringing call before the peer answers.
   */
  public cancelOutgoingCall(reason = 'cancelled'): {
    payload: WebRtcCallPayload
    item: ApplicationMessageItem
  } {
    const payload: WebRtcCallPayload = {
      schemaVersion: 1,
      callId: this.callId,
      action: 'cancel',
      sequence: this.nextSignalingSequence(),
      senderDeviceId: this.senderDeviceId,
      reason,
    }
    this.relayMessagesSentCount += 1
    this.cleanup()
    this.setPhase('cancelled')
    return {
      payload,
      item: toWebRtcCallApplicationItem(payload),
    }
  }

  /**
   * Hangs up an active call.
   * When the P2P `RTCDataChannel` is open, sends `hangup` directly peer-to-peer with ZERO
   * Frank relay messages (`followUpItem: null`). Only falls back to a Frank DM item if
   * the P2P DataChannel is not yet open.
   */
  public hangup(reason = 'completed'): {
    sentViaDataChannel: boolean
    followUpPayload: WebRtcCallPayload | null
    followUpItem: ApplicationMessageItem | null
  } {
    const sentViaDataChannel = this.sendControlMessage({
      type: 'hangup',
      reason,
      seq: this.nextDataChannelSeq(),
    })
    this.cleanup()
    this.setPhase('ended')

    if (sentViaDataChannel) {
      return {
        sentViaDataChannel: true,
        followUpPayload: null,
        followUpItem: null,
      }
    }

    const payload: WebRtcCallPayload = {
      schemaVersion: 1,
      callId: this.callId,
      action: 'hangup',
      sequence: this.nextSignalingSequence(),
      senderDeviceId: this.senderDeviceId,
      reason,
    }
    this.relayMessagesSentCount += 1
    return {
      sentViaDataChannel: false,
      followUpPayload: payload,
      followUpItem: toWebRtcCallApplicationItem(payload),
    }
  }

  /**
   * Immediately aborts the call on a security violation (e.g. DTLS fingerprint mismatch),
   * stopping all tracks and closing the PeerConnection before any media can flow.
   */
  public abortOnSecurityViolation(reason: string): void {
    this.securityViolationReason = reason
    this.dtlsVerified = false
    this.cleanup()
    this.setPhase('security_abort')
    this.notifySecurityViolation(reason)
  }

  /**
   * Deterministically stops all local and remote `MediaStreamTrack`s, closes the
   * `RTCDataChannel` and `RTCPeerConnection`, and releases all references.
   */
  public cleanup(): void {
    this.clearExpiryTimer()
    if (this.screenTrack) {
      try {
        this.screenTrack.onended = null
        this.screenTrack.stop()
      } catch {
        // Ignore already-stopped track errors
      }
      this.screenTrack = null
    }

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.onended = null
          track.stop()
        } catch {
          // Ignore already-stopped track errors
        }
      }
      this.localStream = null
      this.notifyLocalStream(null)
    }

    if (this.remoteStream) {
      for (const track of this.remoteStream.getTracks()) {
        try {
          track.onended = null
          track.stop()
        } catch {
          // Ignore already-stopped track errors
        }
      }
      this.remoteStream = null
      this.notifyRemoteStream(null)
    }

    this.videoSender = null
    this.videoEnabled = false
    this.screenShareEnabled = false
    this.remoteVideoEnabled = false
    this.remoteScreenShareEnabled = false

    if (this.controlChannel) {
      const ch = this.controlChannel
      this.controlChannel = null
      try {
        ch.onopen = null
        ch.onclose = null
        ch.onerror = null
        ch.onmessage = null
        ch.close()
      } catch {
        // Ignore close errors
      }
    }

    if (this.pc) {
      const pc = this.pc
      this.pc = null
      try {
        pc.onicecandidate = null
        pc.onicegatheringstatechange = null
        pc.onconnectionstatechange = null
        pc.oniceconnectionstatechange = null
        pc.ontrack = null
        pc.ondatachannel = null
        pc.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

const activeCallControllers = new Map<string, WebRtcCallSessionController>()
const activeCallRegistryListeners = new Set<() => void>()

function notifyActiveCallRegistryListeners(): void {
  for (const listener of activeCallRegistryListeners) {
    try {
      listener()
    } catch {
      // Ignore listener errors
    }
  }
}

export function subscribeActiveCallControllers(
  listener: () => void,
): () => void {
  activeCallRegistryListeners.add(listener)
  return () => {
    activeCallRegistryListeners.delete(listener)
  }
}

export function getActiveCallSessionControllers(): WebRtcCallSessionController[] {
  const result: WebRtcCallSessionController[] = []
  for (const ctrl of activeCallControllers.values()) {
    const phase = ctrl.getSnapshot().phase
    if (
      phase === 'ringing_outgoing' ||
      phase === 'ringing_incoming' ||
      phase === 'connecting' ||
      phase === 'connected'
    ) {
      result.push(ctrl)
    }
  }
  return result
}

export function registerCallSessionController(
  callId: string,
  controller: WebRtcCallSessionController,
): void {
  if (!callId) return
  activeCallControllers.set(callId, controller)
  notifyActiveCallRegistryListeners()
}

export function unregisterCallSessionController(
  callId: string,
  controller?: WebRtcCallSessionController,
): void {
  if (!callId) return
  if (!controller || activeCallControllers.get(callId) === controller) {
    activeCallControllers.delete(callId)
    notifyActiveCallRegistryListeners()
  }
}

export function getCallSessionController(
  callId: string,
): WebRtcCallSessionController | null {
  return activeCallControllers.get(callId) ?? null
}

export function getOrCreateCallSessionController(
  callId: string,
  options?: WebRtcCallSessionControllerOptions & {
    invite?: WebRtcCallPayload
    outbound?: boolean
  },
): WebRtcCallSessionController {
  const existing = activeCallControllers.get(callId)
  if (existing) return existing
  const created = new WebRtcCallSessionController({
    ...options,
    callId,
  })
  if (options?.invite && options.invite.action === 'invite' && !options.outbound) {
    created.receiveIncomingInvite(options.invite, options.remotePeerId)
  }
  activeCallControllers.set(callId, created)
  notifyActiveCallRegistryListeners()
  return created
}


