import {
  extractWebRtcCallPayload,
  verifyRemoteSdpFingerprint,
  type WebRtcCallAction,
  type WebRtcCallPayload,
  type WebRtcIceTransportPolicy,
  type WebRtcMediaIntent,
} from './schema'
import {
  filterCandidateForIcePolicy,
  sanitizeSdpForIcePolicy,
} from './turn-policy'

export type WebRtcCallPhase =
  | 'ringing_outgoing'
  | 'ringing_incoming'
  | 'connected'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'ended'
  | 'failed'

export interface FoldedWebRtcCallState {
  callId: string
  phase: WebRtcCallPhase
  callerAddress: string
  calleeAddress: string
  isOutgoing: boolean
  mediaIntent: WebRtcMediaIntent
  icePolicy: WebRtcIceTransportPolicy
  expiresAtMs: number
  offerSdp: string | null
  answerSdp: string | null
  offerFingerprintSha256: string | null
  answerFingerprintSha256: string | null
  acceptedByDeviceId: string | null
  answeredElsewhere: boolean
  candidates: string[]
  terminationReason: string | null
  securityError: string | null
}

export interface SignalingMessageEnvelope {
  outbound?: boolean
  senderAddress?: string
  recipientAddress?: string
  status?: string
  items?: readonly unknown[]
}

export interface FoldWebRtcCallOptions {
  localAddress?: string
  peerAddress?: string
  localDeviceId?: string
  nowMs?: number
}

interface ExtractedCallEvent {
  payload: WebRtcCallPayload
  outbound?: boolean
  senderAddress?: string
  recipientAddress?: string
  messageIndex: number
}

const ACTION_PRIORITY: Record<WebRtcCallAction, number> = {
  invite: 0,
  ice_batch: 1,
  cancel: 2,
  reject: 3,
  accept: 4,
  hangup: 5,
}

const TERMINAL_PHASES = new Set<WebRtcCallPhase>([
  'rejected',
  'cancelled',
  'expired',
  'ended',
  'failed',
])

function normalizeAddress(addr: string | undefined): string {
  return (addr ?? '').trim().toLowerCase()
}

function isTerminalPhase(phase: WebRtcCallPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

function redactIfTerminal(
  state: FoldedWebRtcCallState,
): FoldedWebRtcCallState {
  if (isTerminalPhase(state.phase)) {
    state.offerSdp = null
    state.answerSdp = null
    state.candidates = []
  }
  return state
}

function appendFilteredCandidates(
  target: string[],
  seen: Set<string>,
  incoming: readonly string[] | undefined,
  policy: WebRtcIceTransportPolicy,
): void {
  if (!incoming || incoming.length === 0) return
  for (const raw of incoming) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (
      policy !== 'direct-preferred' &&
      !filterCandidateForIcePolicy(trimmed, policy)
    ) {
      continue
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      target.push(trimmed)
    }
  }
}

function resolveEffectiveIcePolicy(
  current: WebRtcIceTransportPolicy,
  incoming?: WebRtcIceTransportPolicy,
): WebRtcIceTransportPolicy {
  if (!incoming) return current
  if (current === 'relay-only' || incoming === 'relay-only') {
    return 'relay-only'
  }
  if (current === 'direct-only' || incoming === 'direct-only') {
    return 'direct-only'
  }
  return 'direct-preferred'
}

/**
 * Deterministically folds an ordered or out-of-order sequence of chat messages into
 * the converged `FoldedWebRtcCallState` for `callId`.
 *
 * Security & convergence guarantees:
 * 1. Deduplicates retransmitted signaling messages by `(callId, sequence, action, senderDeviceId)`.
 * 2. Reorders out-of-order signaling messages by `(sequence, actionPriority, messageIndex)`.
 * 3. Verifies SDP `a=fingerprint:sha-256` against the Frank-authenticated `dtlsFingerprintSha256`
 *    on both `invite` and `accept`, failing closed (`phase: 'failed'`, `securityError`) on mismatch.
 * 4. Rejects unauthorized sender injection (third-party addresses, caller accepting own invite,
 *    callee cancelling caller's invite) with `phase: 'failed'` and `securityError`.
 * 5. Enforces multi-device convergence (`acceptedByDeviceId`, `answeredElsewhere`) when another
 *    device sharing the callee account accepts an incoming call.
 * 6. Redacts `offerSdp`, `answerSdp`, and `candidates` once the call enters any terminal phase
 *    (`rejected`, `cancelled`, `expired`, `ended`, `failed`).
 */
export function foldWebRtcCallState(
  messages: readonly SignalingMessageEnvelope[],
  callId: string,
  options?: FoldWebRtcCallOptions,
): FoldedWebRtcCallState | null {
  if (!Array.isArray(messages) || !callId) {
    return null
  }

  const events: ExtractedCallEvent[] = []

  messages.forEach((msg, messageIndex) => {
    if (!msg || typeof msg !== 'object') return
    const items = Array.isArray(msg.items) ? msg.items : [msg]
    for (const item of items) {
      const payload = extractWebRtcCallPayload(item)
      if (!payload || payload.callId !== callId) continue
      events.push({
        payload,
        outbound: msg.outbound,
        senderAddress: msg.senderAddress,
        recipientAddress: msg.recipientAddress,
        messageIndex,
      })
    }
  })

  if (events.length === 0) {
    return null
  }

  events.sort((a, b) => {
    if (a.payload.sequence !== b.payload.sequence) {
      return a.payload.sequence - b.payload.sequence
    }
    const prioA = ACTION_PRIORITY[a.payload.action]
    const prioB = ACTION_PRIORITY[b.payload.action]
    if (prioA !== prioB) {
      return prioA - prioB
    }
    return a.messageIndex - b.messageIndex
  })

  const inviteEvent = events.find(e => e.payload.action === 'invite')
  if (!inviteEvent) {
    return redactIfTerminal({
      callId,
      phase: 'failed',
      callerAddress: options?.peerAddress ?? 'unknown',
      calleeAddress: options?.localAddress ?? 'unknown',
      isOutgoing: false,
      mediaIntent: 'audio',
      icePolicy: 'direct-preferred',
      expiresAtMs: 0,
      offerSdp: null,
      answerSdp: null,
      offerFingerprintSha256: null,
      answerFingerprintSha256: null,
      acceptedByDeviceId: null,
      answeredElsewhere: false,
      candidates: [],
      terminationReason: 'security_error',
      securityError:
        'Received call signaling messages without an authenticated invite',
    })
  }

  const invite = inviteEvent.payload
  const localAddrNorm = normalizeAddress(options?.localAddress)
  const inviteSenderNorm = normalizeAddress(inviteEvent.senderAddress)

  const isOutgoing =
    inviteEvent.outbound !== undefined
      ? Boolean(inviteEvent.outbound)
      : Boolean(localAddrNorm && inviteSenderNorm === localAddrNorm)

  const callerAddress =
    inviteEvent.senderAddress?.trim() ||
    (isOutgoing
      ? options?.localAddress?.trim() ?? 'local'
      : options?.peerAddress?.trim() ?? 'peer')

  let calleeAddress =
    inviteEvent.recipientAddress?.trim() ||
    (isOutgoing
      ? options?.peerAddress?.trim() ?? ''
      : options?.localAddress?.trim() ?? '')

  if (!calleeAddress) {
    const oppositeEvent = events.find(e => {
      if (
        inviteEvent.outbound !== undefined &&
        e.outbound !== undefined &&
        e.outbound !== inviteEvent.outbound &&
        e.senderAddress?.trim()
      ) {
        return true
      }
      if (
        (e.payload.action === 'accept' || e.payload.action === 'reject') &&
        e.senderAddress?.trim() &&
        normalizeAddress(e.senderAddress) !== normalizeAddress(callerAddress)
      ) {
        return true
      }
      return false
    })
    calleeAddress =
      oppositeEvent?.senderAddress?.trim() || (isOutgoing ? 'peer' : 'local')
  }

  const callerNorm = normalizeAddress(callerAddress)
  const calleeNorm = normalizeAddress(calleeAddress)

  let icePolicy: WebRtcIceTransportPolicy =
    invite.icePolicy ?? 'direct-preferred'
  const mediaIntent: WebRtcMediaIntent = invite.mediaIntent ?? 'audio'
  const expiresAtMs = invite.expiresAtMs ?? 0

  const state: FoldedWebRtcCallState = {
    callId,
    phase: isOutgoing ? 'ringing_outgoing' : 'ringing_incoming',
    callerAddress,
    calleeAddress,
    isOutgoing,
    mediaIntent,
    icePolicy,
    expiresAtMs,
    offerSdp: invite.sdp
      ? sanitizeSdpForIcePolicy(invite.sdp, icePolicy)
      : null,
    answerSdp: null,
    offerFingerprintSha256: invite.dtlsFingerprintSha256 ?? null,
    answerFingerprintSha256: null,
    acceptedByDeviceId: null,
    answeredElsewhere: false,
    candidates: [],
    terminationReason: null,
    securityError: null,
  }

  if (
    !invite.sdp ||
    !invite.dtlsFingerprintSha256 ||
    !verifyRemoteSdpFingerprint(invite.sdp, invite.dtlsFingerprintSha256)
  ) {
    state.phase = 'failed'
    state.terminationReason = 'security_error'
    state.securityError =
      'Invite SDP DTLS fingerprint does not match authenticated dtlsFingerprintSha256'
    return redactIfTerminal(state)
  }

  const candidateSet = new Set<string>()
  appendFilteredCandidates(
    state.candidates,
    candidateSet,
    invite.candidates,
    state.icePolicy,
  )

  const seenDedupKeys = new Set<string>()
  seenDedupKeys.add(
    `${invite.action}:${invite.sequence}:${invite.senderDeviceId}`,
  )

  function isFromCaller(ev: ExtractedCallEvent): boolean {
    if (
      inviteEvent!.outbound !== undefined &&
      ev.outbound !== undefined
    ) {
      return ev.outbound === inviteEvent!.outbound
    }
    const senderNorm = normalizeAddress(ev.senderAddress)
    if (senderNorm && callerNorm) {
      return senderNorm === callerNorm
    }
    return ev.payload.senderDeviceId === invite.senderDeviceId
  }

  function isFromCallee(ev: ExtractedCallEvent): boolean {
    if (
      inviteEvent!.outbound !== undefined &&
      ev.outbound !== undefined
    ) {
      return ev.outbound !== inviteEvent!.outbound
    }
    const senderNorm = normalizeAddress(ev.senderAddress)
    if (senderNorm && calleeNorm && calleeNorm !== callerNorm) {
      return senderNorm === calleeNorm
    }
    if (senderNorm && callerNorm) {
      return senderNorm !== callerNorm
    }
    return ev.payload.senderDeviceId !== invite.senderDeviceId
  }

  function isAuthorizedParticipant(ev: ExtractedCallEvent): boolean {
    const senderNorm = normalizeAddress(ev.senderAddress)
    if (!senderNorm) return true
    if (
      callerNorm &&
      calleeNorm &&
      callerNorm !== 'local' &&
      callerNorm !== 'peer' &&
      calleeNorm !== 'local' &&
      calleeNorm !== 'peer'
    ) {
      return senderNorm === callerNorm || senderNorm === calleeNorm
    }
    if (callerNorm && callerNorm !== 'local' && callerNorm !== 'peer') {
      if (
        inviteEvent!.outbound !== undefined &&
        ev.outbound !== undefined &&
        ev.outbound === inviteEvent!.outbound
      ) {
        return senderNorm === callerNorm
      }
    }
    return true
  }

  for (const ev of events) {
    if (ev === inviteEvent) continue
    const p = ev.payload

    if (p.action === 'invite') {
      const sameInvite =
        isFromCaller(ev) &&
        p.dtlsFingerprintSha256 === invite.dtlsFingerprintSha256 &&
        p.sdp === invite.sdp
      if (sameInvite) {
        continue
      }
      state.phase = 'failed'
      state.terminationReason = 'security_error'
      state.securityError = 'Conflicting duplicate invite for existing callId'
      return redactIfTerminal(state)
    }

    const dedupKey = `${p.action}:${p.sequence}:${p.senderDeviceId}`
    if (seenDedupKeys.has(dedupKey)) {
      continue
    }
    seenDedupKeys.add(dedupKey)

    if (!isAuthorizedParticipant(ev)) {
      state.phase = 'failed'
      state.terminationReason = 'security_error'
      state.securityError = `Unauthorized sender '${
        ev.senderAddress ?? 'unknown'
      }' for call ${callId}`
      return redactIfTerminal(state)
    }

    switch (p.action) {
      case 'ice_batch': {
        if (!isTerminalPhase(state.phase)) {
          appendFilteredCandidates(
            state.candidates,
            candidateSet,
            p.candidates,
            state.icePolicy,
          )
        }
        break
      }

      case 'cancel': {
        if (!isFromCaller(ev)) {
          state.phase = 'failed'
          state.terminationReason = 'security_error'
          state.securityError = 'Only the caller may cancel an outgoing call'
          return redactIfTerminal(state)
        }
        if (
          state.phase === 'ringing_outgoing' ||
          state.phase === 'ringing_incoming'
        ) {
          state.phase = 'cancelled'
          state.terminationReason = p.reason ?? 'cancelled'
        }
        break
      }

      case 'reject': {
        if (!isFromCallee(ev)) {
          state.phase = 'failed'
          state.terminationReason = 'security_error'
          state.securityError = 'Caller cannot reject their own call invite'
          return redactIfTerminal(state)
        }
        if (
          state.phase === 'ringing_outgoing' ||
          state.phase === 'ringing_incoming'
        ) {
          state.phase = 'rejected'
          state.terminationReason = p.reason ?? 'rejected'
        }
        break
      }

      case 'accept': {
        if (!isFromCallee(ev)) {
          state.phase = 'failed'
          state.terminationReason = 'security_error'
          state.securityError = 'Caller cannot accept their own call invite'
          return redactIfTerminal(state)
        }
        if (
          !p.sdp ||
          !p.dtlsFingerprintSha256 ||
          !verifyRemoteSdpFingerprint(p.sdp, p.dtlsFingerprintSha256)
        ) {
          state.phase = 'failed'
          state.terminationReason = 'security_error'
          state.securityError =
            'Accept SDP DTLS fingerprint does not match authenticated dtlsFingerprintSha256'
          return redactIfTerminal(state)
        }

        if (
          state.phase === 'ringing_outgoing' ||
          state.phase === 'ringing_incoming'
        ) {
          icePolicy = resolveEffectiveIcePolicy(state.icePolicy, p.icePolicy)
          state.icePolicy = icePolicy
          if (state.offerSdp) {
            state.offerSdp = sanitizeSdpForIcePolicy(state.offerSdp, icePolicy)
          }
          state.answerSdp = sanitizeSdpForIcePolicy(p.sdp, icePolicy)
          state.answerFingerprintSha256 = p.dtlsFingerprintSha256
          state.acceptedByDeviceId = p.senderDeviceId
          state.phase = 'connected'
          if (icePolicy !== 'direct-preferred') {
            state.candidates = state.candidates.filter(c =>
              filterCandidateForIcePolicy(c, icePolicy),
            )
          }
          appendFilteredCandidates(
            state.candidates,
            candidateSet,
            p.candidates,
            icePolicy,
          )
        } else if (state.phase === 'connected') {
          if (
            state.acceptedByDeviceId &&
            state.acceptedByDeviceId !== p.senderDeviceId
          ) {
            // Another callee device already accepted; keep the winning device's session.
            break
          }
        }
        break
      }

      case 'hangup': {
        if (
          state.phase === 'connected' ||
          state.phase === 'ringing_outgoing' ||
          state.phase === 'ringing_incoming'
        ) {
          state.phase = 'ended'
          state.terminationReason = p.reason ?? 'hangup'
        }
        break
      }
    }
  }

  if (
    !state.isOutgoing &&
    state.acceptedByDeviceId !== null &&
    options?.localDeviceId !== undefined &&
    options.localDeviceId.trim().length > 0 &&
    state.acceptedByDeviceId !== options.localDeviceId.trim()
  ) {
    state.answeredElsewhere = true
  }

  if (
    options?.nowMs !== undefined &&
    state.expiresAtMs > 0 &&
    options.nowMs >= state.expiresAtMs &&
    (state.phase === 'ringing_outgoing' || state.phase === 'ringing_incoming')
  ) {
    state.phase = 'expired'
    state.terminationReason = 'expired'
  }

  return redactIfTerminal(state)
}
