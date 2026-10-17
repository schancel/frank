import {
  foldWebRtcCallState,
  type FoldedWebRtcCallState,
  type SignalingMessageEnvelope,
} from './state-machine'

export interface EvaluateWakeupCallInviteParams {
  messages: readonly SignalingMessageEnvelope[]
  callId: string
  localDeviceId: string
  nowMs: number
  processedWakeupIds?: Set<string>
  wakeupId?: string
  localAddress?: string
  peerAddress?: string
}

export interface WakeupCallEvaluationResult {
  shouldRing: boolean
  state: FoldedWebRtcCallState | null
  reason: string
}

/**
 * Evaluates a suspended PWA / mobile push-wakeup hint by first folding the caught-up
 * relay message batch for `callId` before deciding whether to ring or display incoming UI.
 *
 * Guarantees:
 * - Never rings blindly on a wakeup hint without verifying the folded message log.
 * - Deduplicates repeated wakeup deliveries via `processedWakeupIds` + `wakeupId`.
 * - Suppresses ghost ringing when the call was already cancelled, rejected, expired,
 *   ended, failed, or answered on another device (`answeredElsewhere`).
 */
export function evaluateWakeupCallInvite(
  params: EvaluateWakeupCallInviteParams,
): WakeupCallEvaluationResult {
  const {
    messages,
    callId,
    localDeviceId,
    nowMs,
    processedWakeupIds,
    wakeupId,
    localAddress,
    peerAddress,
  } = params

  const state = foldWebRtcCallState(messages, callId, {
    localDeviceId,
    nowMs,
    localAddress,
    peerAddress,
  })

  if (wakeupId && processedWakeupIds) {
    if (processedWakeupIds.has(wakeupId)) {
      return {
        shouldRing: false,
        state,
        reason: 'duplicate_wakeup',
      }
    }
    processedWakeupIds.add(wakeupId)
  }

  if (!state) {
    return {
      shouldRing: false,
      state: null,
      reason: 'call_not_found',
    }
  }

  if (state.phase === 'failed') {
    return {
      shouldRing: false,
      state,
      reason: 'security_error',
    }
  }

  if (state.phase === 'cancelled') {
    return {
      shouldRing: false,
      state,
      reason: 'cancelled_by_caller',
    }
  }

  if (state.phase === 'rejected') {
    return {
      shouldRing: false,
      state,
      reason: 'already_rejected',
    }
  }

  if (state.phase === 'expired') {
    return {
      shouldRing: false,
      state,
      reason: 'invite_expired',
    }
  }

  if (state.phase === 'ended') {
    return {
      shouldRing: false,
      state,
      reason: 'call_ended',
    }
  }

  if (state.answeredElsewhere) {
    return {
      shouldRing: false,
      state,
      reason: 'answered_elsewhere',
    }
  }

  if (state.phase === 'connected') {
    return {
      shouldRing: false,
      state,
      reason: 'already_connected',
    }
  }

  if (state.isOutgoing) {
    return {
      shouldRing: false,
      state,
      reason: 'outgoing_call',
    }
  }

  return {
    shouldRing: state.phase === 'ringing_incoming',
    state,
    reason: 'ringing_incoming',
  }
}
