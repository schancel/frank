import { createMessageItemRegistry } from '@frank/cashweb/message-items/registry'
import { standaloneItemBudget } from '@frank/codec'
import {
  WEBRTC_CALL_PLUGIN_ID,
  WEBRTC_CALL_SCHEMA_VERSION,
  WEBRTC_DATA_CHANNEL_LABEL,
  buildRtcConfiguration,
  buildSFrameHeader,
  computeCallTranscriptBindingHash,
  createWebRtcCallPlugin,
  decodeDataChannelMessage,
  decodeWebRtcCallPayload,
  deriveSFrameEpochKey,
  encodeDataChannelMessage,
  encodeWebRtcCallPayload,
  evaluateWakeupCallInvite,
  extractSdpDtlsFingerprintSha256,
  extractWebRtcCallPayload,
  filterCandidateForIcePolicy,
  foldWebRtcCallState,
  generateCallId,
  initWebRtcCallPlugin,
  issueTurnRestCredentials,
  normalizeDtlsFingerprintSha256,
  parseWebRtcCallApplicationItem,
  resolveGlareWinner,
  sanitizeSdpForIcePolicy,
  toWebRtcCallApplicationItem,
  validateWebRtcCallPayload,
  verifyRemoteSdpFingerprint,
  verifySFrameEpochTransition,
  verifyTurnRestCredentials,
  type WebRtcCallPayload,
} from './index'

const CALLER_FP =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const CALLEE_FP =
  '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'
const ATTACKER_FP =
  'FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00'

function makeSampleSdp(
  fingerprint: string,
  options?: {
    hostIp?: string
    srflxIp?: string
    relayIp?: string
    multiMediaFingerprint?: string
    algo?: string
  },
): string {
  const algo = options?.algo ?? 'sha-256'
  const hostIp = options?.hostIp ?? '192.168.1.42'
  const srflxIp = options?.srflxIp ?? '203.0.113.15'
  const relayIp = options?.relayIp ?? '198.51.100.77'

  const lines = [
    'v=0',
    `o=- 4611731400430051336 2 IN IP4 ${hostIp}`,
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    `c=IN IP4 ${srflxIp}`,
    `a=rtcp:9 IN IP4 ${hostIp}`,
    `a=fingerprint:${algo} ${fingerprint}`,
    'a=setup:actpass',
    `a=candidate:1 1 UDP 2122252543 ${hostIp} 54321 typ host`,
    `a=candidate:2 1 UDP 1686052607 ${srflxIp} 54322 typ srflx raddr ${hostIp} rport 54321`,
    `a=candidate:3 1 UDP 41885439 ${relayIp} 61000 typ relay raddr ${srflxIp} rport 54322`,
  ]

  if (options?.multiMediaFingerprint !== undefined) {
    lines.push(
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      `c=IN IP6 2001:db8::1`,
      `a=fingerprint:${algo} ${options.multiMediaFingerprint}`,
    )
  }

  return lines.join('\r\n')
}

describe('webrtc-call-v1 plugin & protocol suite (#462-#469)', () => {
  describe('#462 Wire Schema, CBOR Codec & DTLS Fingerprint Binding', () => {
    it('exports expected constants and generates valid callIds', () => {
      expect(WEBRTC_CALL_PLUGIN_ID).toBe('webrtc-call-v1')
      expect(WEBRTC_CALL_SCHEMA_VERSION).toBe(1)
      expect(WEBRTC_DATA_CHANNEL_LABEL).toBe('frank-call-control-v1')

      const id = generateCallId()
      expect(id).toMatch(/^[a-zA-Z0-9_-]{16,64}$/)
    })

    it('validates and roundtrips invite and accept payloads through canonical CBOR and MessageItemRegistry', () => {
      const callId = 'call_0123456789abcdef0123'
      const offerSdp = makeSampleSdp(CALLER_FP)

      const invitePayload: WebRtcCallPayload = {
        schemaVersion: 1,
        callId,
        action: 'invite',
        sequence: 0,
        senderDeviceId: 'alice-laptop-1',
        mediaIntent: 'video',
        icePolicy: 'direct-preferred',
        sdp: offerSdp,
        dtlsFingerprintSha256: CALLER_FP.toLowerCase(),
        candidates: [
          'candidate:1 1 UDP 2122252543 192.168.1.42 54321 typ host',
        ],
        expiresAtMs: 1700000060000,
      }

      const validated = validateWebRtcCallPayload(invitePayload)
      expect(validated.dtlsFingerprintSha256).toBe(CALLER_FP)

      const encoded = encodeWebRtcCallPayload(validated)
      const decoded = decodeWebRtcCallPayload(encoded)
      expect(decoded).toEqual(validated)

      const appItem = toWebRtcCallApplicationItem(invitePayload)
      expect(appItem.type).toBe('application')
      expect(appItem.itemType).toBe(WEBRTC_CALL_PLUGIN_ID)
      expect(parseWebRtcCallApplicationItem(appItem)).toEqual(validated)
      expect(extractWebRtcCallPayload(appItem)).toEqual(validated)

      const registry = createMessageItemRegistry()
      initWebRtcCallPlugin(registry)
      expect(registry.has(WEBRTC_CALL_PLUGIN_ID)).toBe(true)
      expect(registry.previewText(appItem)).toContain('Video call invitation')

      const wireItem = registry.encodeItem(appItem)
      const roundtripped = registry.decodeItem(
        wireItem.type,
        wireItem.bytes,
        { budget: standaloneItemBudget() },
      )
      expect(roundtripped).toEqual({
        kind: 'item',
        item: appItem,
      })
    })

    it('rejects malformed payloads, unknown properties, and missing required fields', () => {
      expect(() =>
        validateWebRtcCallPayload({
          schemaVersion: 1,
          callId: 'short',
          action: 'invite',
          sequence: 0,
          senderDeviceId: 'dev-1',
        }),
      ).toThrow(/callId/)

      expect(() =>
        validateWebRtcCallPayload({
          schemaVersion: 1,
          callId: 'call_0123456789abcdef0123',
          action: 'invite',
          sequence: 0,
          senderDeviceId: 'dev-1',
          // missing sdp, dtlsFingerprintSha256, expiresAtMs
        }),
      ).toThrow(/sdp/)

      expect(() =>
        validateWebRtcCallPayload({
          schemaVersion: 1,
          callId: 'call_0123456789abcdef0123',
          action: 'accept',
          sequence: 1,
          senderDeviceId: 'dev-2',
          sdp: makeSampleSdp(CALLEE_FP),
          // missing dtlsFingerprintSha256
        }),
      ).toThrow(/dtlsFingerprintSha256/)

      expect(() =>
        validateWebRtcCallPayload({
          schemaVersion: 1,
          callId: 'call_0123456789abcdef0123',
          action: 'hangup',
          sequence: -1,
          senderDeviceId: 'dev-1',
        }),
      ).toThrow(/sequence/)

      expect(() =>
        validateWebRtcCallPayload({
          schemaVersion: 1,
          callId: 'call_0123456789abcdef0123',
          action: 'hangup',
          sequence: 1,
          senderDeviceId: 'dev-1',
          unexpectedField: true,
        }),
      ).toThrow(/Unexpected/)
    })

    it('normalizes SHA-256 DTLS fingerprints and rejects weak or mismatched multi-m-line SDPs', () => {
      const hex64 = CALLER_FP.replace(/:/g, '').toLowerCase()
      expect(normalizeDtlsFingerprintSha256(hex64)).toBe(CALLER_FP)
      expect(normalizeDtlsFingerprintSha256(`sha-256 ${CALLER_FP.toLowerCase()}`)).toBe(
        CALLER_FP,
      )

      expect(() =>
        normalizeDtlsFingerprintSha256(
          'sha-1 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
        ),
      ).toThrow(/sha-256/)
      expect(() => normalizeDtlsFingerprintSha256('AA:BB:CC')).toThrow()

      const validMultiMediaSdp = makeSampleSdp(CALLER_FP, {
        multiMediaFingerprint: CALLER_FP,
      })
      expect(extractSdpDtlsFingerprintSha256(validMultiMediaSdp)).toBe(CALLER_FP)
      expect(verifyRemoteSdpFingerprint(validMultiMediaSdp, CALLER_FP)).toBe(true)
      expect(verifyRemoteSdpFingerprint(validMultiMediaSdp, ATTACKER_FP)).toBe(
        false,
      )

      // Mismatched fingerprint in second m= section must be rejected
      const mismatchedMultiMediaSdp = makeSampleSdp(CALLER_FP, {
        multiMediaFingerprint: ATTACKER_FP,
      })
      expect(extractSdpDtlsFingerprintSha256(mismatchedMultiMediaSdp)).toBeNull()
      expect(
        verifyRemoteSdpFingerprint(mismatchedMultiMediaSdp, CALLER_FP),
      ).toBe(false)

      // Weak sha-1 fingerprint in SDP must be rejected
      const sha1Sdp = makeSampleSdp(CALLER_FP, { algo: 'sha-1' })
      expect(extractSdpDtlsFingerprintSha256(sha1Sdp)).toBeNull()
    })

    it('computes deterministic transcript binding hashes and resolves glare symmetrically', () => {
      const h1 = computeCallTranscriptBindingHash({
        callId: 'call_0123456789abcdef0123',
        callerAddress: '0xAlice',
        calleeAddress: '0xBob',
        offerFingerprintSha256: CALLER_FP,
        answerFingerprintSha256: CALLEE_FP,
        mediaIntent: 'audio',
        expiresAtMs: 1700000060000,
      })
      const h2 = computeCallTranscriptBindingHash({
        callId: 'call_0123456789abcdef0123',
        callerAddress: '0xalice',
        calleeAddress: '0xbob',
        offerFingerprintSha256: CALLER_FP.toLowerCase(),
        answerFingerprintSha256: CALLEE_FP.toLowerCase(),
        mediaIntent: 'audio',
        expiresAtMs: 1700000060000,
      })
      expect(h1).toBe(h2)
      expect(h1).toMatch(/^[0-9a-f]{64}$/)

      const offerA = { callerAddress: '0x1111', callId: 'call_aaaaaaaaaaaa0001' }
      const offerB = { callerAddress: '0x2222', callId: 'call_bbbbbbbbbbbb0002' }
      expect(resolveGlareWinner(offerA, offerB)).toBe('A')
      expect(resolveGlareWinner(offerB, offerA)).toBe('B')
    })
  })

  describe('#463 Multi-Device Call Signaling State Machine & Aggressive SDP/ICE Redaction', () => {
    const callId = 'call_state_machine_000001'
    const offerSdp = makeSampleSdp(CALLER_FP)
    const answerSdp = makeSampleSdp(CALLEE_FP)

    it('folds out-of-order and duplicate signaling messages into connected and ended states', () => {
      const inviteItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'invite',
        sequence: 0,
        senderDeviceId: 'caller-dev-1',
        mediaIntent: 'audio',
        icePolicy: 'direct-preferred',
        sdp: offerSdp,
        dtlsFingerprintSha256: CALLER_FP,
        expiresAtMs: 1700000060000,
      })
      const iceBatchItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'ice_batch',
        sequence: 1,
        senderDeviceId: 'caller-dev-1',
        candidates: [
          'candidate:99 1 UDP 2122252543 192.168.1.42 55000 typ host',
        ],
      })
      const acceptItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'accept',
        sequence: 2,
        senderDeviceId: 'callee-phone',
        sdp: answerSdp,
        dtlsFingerprintSha256: CALLEE_FP,
      })

      // Feed out-of-order (accept, then ice_batch, then invite, plus duplicate accept)
      const messages = [
        { outbound: true, senderAddress: '0xBob', items: [acceptItem] },
        { outbound: false, senderAddress: '0xAlice', items: [iceBatchItem] },
        { outbound: false, senderAddress: '0xAlice', items: [inviteItem] },
        { outbound: true, senderAddress: '0xBob', items: [acceptItem] },
      ]

      const connectedOnPhone = foldWebRtcCallState(messages, callId, {
        localAddress: '0xBob',
        peerAddress: '0xAlice',
        localDeviceId: 'callee-phone',
        nowMs: 1700000010000,
      })

      expect(connectedOnPhone).not.toBeNull()
      expect(connectedOnPhone!.phase).toBe('connected')
      expect(connectedOnPhone!.acceptedByDeviceId).toBe('callee-phone')
      expect(connectedOnPhone!.answeredElsewhere).toBe(false)
      expect(connectedOnPhone!.offerSdp).toContain(CALLER_FP)
      expect(connectedOnPhone!.answerSdp).toContain(CALLEE_FP)
      expect(connectedOnPhone!.candidates).toHaveLength(1)

      // On Bob's tablet (different localDeviceId), answeredElsewhere must be true
      const connectedOnTablet = foldWebRtcCallState(messages, callId, {
        localAddress: '0xBob',
        peerAddress: '0xAlice',
        localDeviceId: 'callee-tablet',
        nowMs: 1700000010000,
      })
      expect(connectedOnTablet!.phase).toBe('connected')
      expect(connectedOnTablet!.answeredElsewhere).toBe(true)

      // Now hangup -> terminal state must redact offerSdp, answerSdp, and candidates
      const hangupItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'hangup',
        sequence: 3,
        senderDeviceId: 'callee-phone',
        reason: 'completed',
      })
      const endedState = foldWebRtcCallState(
        [
          ...messages,
          { outbound: true, senderAddress: '0xBob', items: [hangupItem] },
        ],
        callId,
        {
          localAddress: '0xBob',
          peerAddress: '0xAlice',
          localDeviceId: 'callee-phone',
        },
      )
      expect(endedState!.phase).toBe('ended')
      expect(endedState!.terminationReason).toBe('completed')
      expect(endedState!.offerSdp).toBeNull()
      expect(endedState!.answerSdp).toBeNull()
      expect(endedState!.candidates).toEqual([])
    })

    it('resolves cancel vs accept race deterministically and redacts SDP on cancel/reject/expired', () => {
      const inviteItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'invite',
        sequence: 0,
        senderDeviceId: 'caller-dev-1',
        mediaIntent: 'audio',
        sdp: offerSdp,
        dtlsFingerprintSha256: CALLER_FP,
        expiresAtMs: 1700000060000,
      })
      const cancelItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'cancel',
        sequence: 1,
        senderDeviceId: 'caller-dev-1',
        reason: 'caller_hung_up',
      })
      const acceptItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'accept',
        sequence: 1,
        senderDeviceId: 'callee-dev-1',
        sdp: answerSdp,
        dtlsFingerprintSha256: CALLEE_FP,
      })

      const cancelledState = foldWebRtcCallState(
        [
          { outbound: false, senderAddress: '0xAlice', items: [inviteItem] },
          { outbound: true, senderAddress: '0xBob', items: [acceptItem] },
          { outbound: false, senderAddress: '0xAlice', items: [cancelItem] },
        ],
        callId,
        { localAddress: '0xBob', peerAddress: '0xAlice' },
      )
      expect(cancelledState!.phase).toBe('cancelled')
      expect(cancelledState!.offerSdp).toBeNull()
      expect(cancelledState!.answerSdp).toBeNull()

      // Ringing expiry when nowMs >= expiresAtMs
      const expiredState = foldWebRtcCallState(
        [{ outbound: false, senderAddress: '0xAlice', items: [inviteItem] }],
        callId,
        {
          localAddress: '0xBob',
          peerAddress: '0xAlice',
          nowMs: 1700000060000,
        },
      )
      expect(expiredState!.phase).toBe('expired')
      expect(expiredState!.offerSdp).toBeNull()
    })

    it('fails closed on SDP fingerprint mismatch or unauthorized third-party signaling injection', () => {
      const tamperedInvite = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'invite',
        sequence: 0,
        senderDeviceId: 'caller-dev-1',
        mediaIntent: 'audio',
        sdp: makeSampleSdp(ATTACKER_FP),
        dtlsFingerprintSha256: CALLER_FP,
        expiresAtMs: 1700000060000,
      })

      const failedInviteState = foldWebRtcCallState(
        [{ outbound: false, senderAddress: '0xAlice', items: [tamperedInvite] }],
        callId,
      )
      expect(failedInviteState!.phase).toBe('failed')
      expect(failedInviteState!.securityError).toMatch(/fingerprint/i)
      expect(failedInviteState!.offerSdp).toBeNull()

      // Unauthorized third-party injection (Mallory tries to inject accept or candidates)
      const validInvite = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'invite',
        sequence: 0,
        senderDeviceId: 'caller-dev-1',
        mediaIntent: 'audio',
        sdp: offerSdp,
        dtlsFingerprintSha256: CALLER_FP,
        expiresAtMs: 1700000060000,
      })
      const malloryAccept = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'accept',
        sequence: 1,
        senderDeviceId: 'mallory-dev',
        sdp: makeSampleSdp(ATTACKER_FP),
        dtlsFingerprintSha256: ATTACKER_FP,
      })

      const injectedState = foldWebRtcCallState(
        [
          { outbound: false, senderAddress: '0xAlice', items: [validInvite] },
          { outbound: false, senderAddress: '0xMallory', items: [malloryAccept] },
        ],
        callId,
        { localAddress: '0xBob', peerAddress: '0xAlice' },
      )
      expect(injectedState!.phase).toBe('failed')
      expect(injectedState!.securityError).toMatch(/Unauthorized sender/i)
    })
  })

  describe('#464 & #466 P2P RTCDataChannel Control & Mid-Call Renegotiation', () => {
    it('encodes and decodes mute_state, renegotiate_offer/answer, hangup, and ping/pong', () => {
      const muteRaw = encodeDataChannelMessage({
        type: 'mute_state',
        muted: true,
        videoEnabled: false,
        screenSharing: true,
        seq: 1,
      })
      expect(decodeDataChannelMessage(muteRaw, CALLER_FP)).toEqual({
        type: 'mute_state',
        muted: true,
        videoEnabled: false,
        screenSharing: true,
        seq: 1,
      })

      const renegOfferRaw = encodeDataChannelMessage({
        type: 'renegotiate_offer',
        mediaIntent: 'screen',
        sdp: makeSampleSdp(CALLER_FP),
        dtlsFingerprintSha256: CALLER_FP,
        seq: 2,
      })
      const decodedReneg = decodeDataChannelMessage(renegOfferRaw, CALLER_FP)
      expect(decodedReneg.type).toBe('renegotiate_offer')

      // Reject mid-call renegotiation attempting to swap the peer's DTLS fingerprint
      expect(() =>
        decodeDataChannelMessage(renegOfferRaw, ATTACKER_FP),
      ).toThrow(/DTLS fingerprint/i)
    })
  })

  describe('#465 STUN/TURN Policy, relay-only IP Stripping & Ephemeral TURN REST Credentials', () => {
    it('strips host and srflx candidates and masks IP4/IP6 addresses in relay-only mode', () => {
      const rawSdp = makeSampleSdp(CALLER_FP, {
        hostIp: '192.168.10.25',
        srflxIp: '203.0.113.88',
        relayIp: '198.51.100.99',
        multiMediaFingerprint: CALLER_FP,
      })

      const sanitized = sanitizeSdpForIcePolicy(rawSdp, 'relay-only')
      expect(sanitized).not.toContain('192.168.10.25')
      expect(sanitized).not.toContain('203.0.113.88')
      expect(sanitized).not.toContain('2001:db8::1')
      expect(sanitized).not.toContain('typ host')
      expect(sanitized).not.toContain('typ srflx')
      expect(sanitized).not.toContain('raddr')
      expect(sanitized).toContain('c=IN IP4 0.0.0.0')
      expect(sanitized).toContain('198.51.100.99')
      expect(sanitized).toContain('typ relay')

      expect(
        filterCandidateForIcePolicy(
          'candidate:1 1 UDP 2122252543 192.168.1.42 54321 typ host',
          'relay-only',
        ),
      ).toBe(false)
      expect(
        filterCandidateForIcePolicy(
          'candidate:3 1 UDP 41885439 198.51.100.77 61000 typ relay',
          'relay-only',
        ),
      ).toBe(true)
      expect(
        filterCandidateForIcePolicy(
          'candidate:3 1 UDP 41885439 198.51.100.77 61000 typ relay',
          'direct-only',
        ),
      ).toBe(false)
    })

    it('builds RTCConfiguration and fails closed if relay-only is requested without TURN servers', () => {
      expect(() =>
        buildRtcConfiguration({
          policy: 'relay-only',
          stunUrls: ['stun:stun.frank.example:3478'],
          turnServers: [],
        }),
      ).toThrow(/requires at least one configured TURN server/)

      const relayConfig = buildRtcConfiguration({
        policy: 'relay-only',
        stunUrls: ['stun:stun.frank.example:3478'],
        turnServers: [
          {
            urls: 'turns:turn.frank.example:5349',
            username: 'u',
            credential: 'p',
          },
        ],
      })
      expect(relayConfig.iceTransportPolicy).toBe('relay')
      expect(relayConfig.iceServers).toHaveLength(1)
      expect(relayConfig.iceServers[0]!.urls).toBe(
        'turns:turn.frank.example:5349',
      )
    })

    it('issues and verifies short-lived coturn HMAC-SHA1 TURN REST credentials', () => {
      const secret = 'super-secret-coturn-shared-key-2026'
      const issued = issueTurnRestCredentials({
        sharedSecret: secret,
        accountAddress: '0xAliceAccount',
        callId: 'call_turn_test_0001',
        nowSeconds: 1700000000,
        ttlSeconds: 300,
      })

      expect(issued.username).toBe(
        '1700000300:0xAliceAccount:call_turn_test_0001',
      )
      expect(issued.expiresAtSeconds).toBe(1700000300)

      expect(
        verifyTurnRestCredentials({
          sharedSecret: secret,
          username: issued.username,
          credential: issued.credential,
          expectedAccountAddress: '0xAliceAccount',
          nowSeconds: 1700000100,
        }),
      ).toEqual({ valid: true })

      // Expired check
      expect(
        verifyTurnRestCredentials({
          sharedSecret: secret,
          username: issued.username,
          credential: issued.credential,
          nowSeconds: 1700000301,
        }),
      ).toEqual({ valid: false, reason: 'expired' })

      // Tampered signature check
      expect(
        verifyTurnRestCredentials({
          sharedSecret: secret,
          username: issued.username,
          credential: 'wrong-credential',
          nowSeconds: 1700000100,
        }),
      ).toEqual({ valid: false, reason: 'invalid_signature' })
    })
  })

  describe('#467 Suspended PWA / Mobile Wakeup Convergence', () => {
    const callId = 'call_wakeup_convergence_01'
    const inviteItem = toWebRtcCallApplicationItem({
      schemaVersion: 1,
      callId,
      action: 'invite',
      sequence: 0,
      senderDeviceId: 'caller-dev-1',
      mediaIntent: 'audio',
      sdp: makeSampleSdp(CALLER_FP),
      dtlsFingerprintSha256: CALLER_FP,
      expiresAtMs: 1700000060000,
    })

    it('rings only when folded state is ringing_incoming and suppresses ghost rings on cancel/expiry/answeredElsewhere/duplicate', () => {
      const processedWakeupIds = new Set<string>()

      const ringingRes = evaluateWakeupCallInvite({
        messages: [
          { outbound: false, senderAddress: '0xAlice', items: [inviteItem] },
        ],
        callId,
        localDeviceId: 'bob-mobile',
        nowMs: 1700000010000,
        processedWakeupIds,
        wakeupId: 'push-1',
      })
      expect(ringingRes.shouldRing).toBe(true)
      expect(ringingRes.reason).toBe('ringing_incoming')

      // Duplicate push wakeup ID must not ring again
      const dupRes = evaluateWakeupCallInvite({
        messages: [
          { outbound: false, senderAddress: '0xAlice', items: [inviteItem] },
        ],
        callId,
        localDeviceId: 'bob-mobile',
        nowMs: 1700000011000,
        processedWakeupIds,
        wakeupId: 'push-1',
      })
      expect(dupRes.shouldRing).toBe(false)
      expect(dupRes.reason).toBe('duplicate_wakeup')

      // Caller cancelled before mobile finished waking up
      const cancelItem = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'cancel',
        sequence: 1,
        senderDeviceId: 'caller-dev-1',
      })
      const cancelledWakeup = evaluateWakeupCallInvite({
        messages: [
          { outbound: false, senderAddress: '0xAlice', items: [inviteItem] },
          { outbound: false, senderAddress: '0xAlice', items: [cancelItem] },
        ],
        callId,
        localDeviceId: 'bob-mobile',
        nowMs: 1700000012000,
      })
      expect(cancelledWakeup.shouldRing).toBe(false)
      expect(cancelledWakeup.reason).toBe('cancelled_by_caller')

      // Answered on desktop before mobile woke up
      const acceptOnDesktop = toWebRtcCallApplicationItem({
        schemaVersion: 1,
        callId,
        action: 'accept',
        sequence: 1,
        senderDeviceId: 'bob-desktop',
        sdp: makeSampleSdp(CALLEE_FP),
        dtlsFingerprintSha256: CALLEE_FP,
      })
      const answeredElsewhereWakeup = evaluateWakeupCallInvite({
        messages: [
          { outbound: false, senderAddress: '0xAlice', items: [inviteItem] },
          { outbound: true, senderAddress: '0xBob', items: [acceptOnDesktop] },
        ],
        callId,
        localDeviceId: 'bob-mobile',
        nowMs: 1700000012000,
      })
      expect(answeredElsewhereWakeup.shouldRing).toBe(false)
      expect(answeredElsewhereWakeup.reason).toBe('answered_elsewhere')
    })
  })

  describe('#469 SFrame E2EE Group Call Key Derivation & Epoch Transitions', () => {
    it('derives distinct per-sender/per-epoch SFrame keys, builds AAD headers, and enforces epoch rotation', () => {
      const secret0 = 'group-shared-secret-epoch-0-bytes'
      const secret1 = 'group-shared-secret-epoch-1-bytes'

      const aliceEpoch0 = deriveSFrameEpochKey({
        callId: 'call_group_sframe_0001',
        epoch: 0,
        senderAddress: '0xAlice',
        senderDeviceId: 'alice-dev-1',
        groupSharedSecret: secret0,
      })
      const bobEpoch0 = deriveSFrameEpochKey({
        callId: 'call_group_sframe_0001',
        epoch: 0,
        senderAddress: '0xBob',
        senderDeviceId: 'bob-dev-1',
        groupSharedSecret: secret0,
      })
      const aliceEpoch1 = deriveSFrameEpochKey({
        callId: 'call_group_sframe_0001',
        epoch: 1,
        senderAddress: '0xAlice',
        senderDeviceId: 'alice-dev-1',
        groupSharedSecret: secret1,
      })

      expect(aliceEpoch0.baseKey).toHaveLength(32)
      expect(aliceEpoch0.salt).toHaveLength(12)
      expect(aliceEpoch0.keyHex).not.toBe(bobEpoch0.keyHex)
      expect(aliceEpoch0.keyHex).not.toBe(aliceEpoch1.keyHex)
      expect(aliceEpoch0.keyId).not.toBe(bobEpoch0.keyId)

      const frameHeader = buildSFrameHeader({
        callId: 'call_group_sframe_0001',
        epoch: 1,
        keyId: aliceEpoch1.keyId,
        frameCounter: 42n,
        mediaType: 'video',
        ssrc: 123456,
        salt: aliceEpoch1.salt,
      })
      expect(frameHeader.headerBytes).toHaveLength(19)
      expect(frameHeader.nonce).toHaveLength(12)
      expect(frameHeader.aadBytes.byteLength).toBeGreaterThan(19)

      // Valid epoch transition
      expect(
        verifySFrameEpochTransition({
          currentEpoch: 0,
          nextEpoch: 1,
          reason: 'member_joined',
          previousEpochSecret: secret0,
          nextEpochSecret: secret1,
        }),
      ).toEqual({ valid: true })

      // Rollback rejected
      expect(
        verifySFrameEpochTransition({
          currentEpoch: 2,
          nextEpoch: 1,
          reason: 'key_rotation',
        }),
      ).toEqual({ valid: false, reason: 'epoch_rollback_detected' })

      // Unrotated secret on member_left rejected
      expect(
        verifySFrameEpochTransition({
          currentEpoch: 1,
          nextEpoch: 2,
          reason: 'member_left',
          previousEpochSecret: secret1,
          nextEpochSecret: secret1,
        }),
      ).toEqual({ valid: false, reason: 'epoch_secret_not_rotated' })
    })
  })
})
