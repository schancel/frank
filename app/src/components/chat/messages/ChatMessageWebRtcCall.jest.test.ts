/**
 * @jest-environment jsdom
 */
import { describe, expect, it, jest } from '@jest/globals'
import { mount } from '@vue/test-utils'
import {
  extractWebRtcCallPayload,
  WEBRTC_CALL_PLUGIN_ID,
  WEBRTC_DATA_CHANNEL_LABEL,
  type WebRtcCallPayload,
} from '@frank/wallet/message-item-plugins/webrtc-call'
import {
  WebRtcCallSessionController,
  registerCallSessionController,
  unregisterCallSessionController,
  type MinimalDataChannel,
  type MinimalMediaDevices,
  type MinimalMediaStream,
  type MinimalMediaStreamTrack,
  type MinimalPeerConnection,
  type MinimalRtpSender,
} from '../../../utils/webrtc-call-controller'
import { applicationRenderer } from '../../../utils/application-renderers'
import ChatMessageWebRtcCall from './ChatMessageWebRtcCall.vue'

interface MockTrack extends MinimalMediaStreamTrack {
  stoppedCount: number
}

function createMockTrack(kind: 'audio' | 'video'): MockTrack {
  const listeners = new Set<() => void>()
  const track: MockTrack = {
    id: `${kind}_${Math.random().toString(36).slice(2, 9)}`,
    kind,
    enabled: true,
    readyState: 'live',
    stoppedCount: 0,
    onended: null,
    stop() {
      track.stoppedCount += 1
      track.readyState = 'ended'
    },
    addEventListener(event: string, listener: () => void) {
      if (event === 'ended') {
        listeners.add(listener)
      }
    },
    removeEventListener(event: string, listener: () => void) {
      if (event === 'ended') {
        listeners.delete(listener)
      }
    },
  }
  return track
}

function createMockStream(tracks: MockTrack[]): MinimalMediaStream {
  const current = [...tracks]
  return {
    id: `stream_${Math.random().toString(36).slice(2, 9)}`,
    getTracks: () => [...current],
    getAudioTracks: () => current.filter(t => t.kind === 'audio'),
    getVideoTracks: () => current.filter(t => t.kind === 'video'),
    addTrack(t: MinimalMediaStreamTrack) {
      if (!current.includes(t as MockTrack)) {
        current.push(t as MockTrack)
      }
    },
    removeTrack(t: MinimalMediaStreamTrack) {
      const idx = current.indexOf(t as MockTrack)
      if (idx !== -1) {
        current.splice(idx, 1)
      }
    },
  }
}

interface LinkedPeerHarness {
  callerConfig: RTCConfiguration | null
  calleeConfig: RTCConfiguration | null
  callerPc: MinimalPeerConnection & { closed: boolean }
  calleePc: MinimalPeerConnection & { closed: boolean }
  callerTracks: MockTrack[]
  calleeTracks: MockTrack[]
  callerMediaDevices: MinimalMediaDevices & {
    getUserMediaCalls: Array<Record<string, unknown>>
    getDisplayMediaCalls: number
  }
  calleeMediaDevices: MinimalMediaDevices & {
    getUserMediaCalls: Array<Record<string, unknown>>
    getDisplayMediaCalls: number
  }
  connectPeersAndOpenDataChannel(): void
  failIceConnection(): void
}

const CALLER_FP =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const CALLEE_FP =
  '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'
const ATTACKER_FP =
  'FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF'

function createLinkedPeerHarness(options?: {
  callerCandidates?: string[]
  calleeCandidates?: string[]
  denyCallerCamera?: boolean
  denyCallerScreen?: boolean
  denyCallerMic?: boolean
}): LinkedPeerHarness {
  let callerDataChannel: (MinimalDataChannel & { closed: boolean }) | null =
    null
  let calleeDataChannel: (MinimalDataChannel & { closed: boolean }) | null =
    null
  const callerSenders: MinimalRtpSender[] = []
  const calleeSenders: MinimalRtpSender[] = []
  const callerTracks: MockTrack[] = []
  const calleeTracks: MockTrack[] = []

  const createPc = (
    role: 'caller' | 'callee',
    fingerprint: string,
    candidates: string[],
  ): MinimalPeerConnection & { closed: boolean } => {
    const senders = role === 'caller' ? callerSenders : calleeSenders
    const pc: MinimalPeerConnection & { closed: boolean } = {
      connectionState: 'new',
      iceConnectionState: 'new',
      iceGatheringState: 'new',
      signalingState: 'stable',
      localDescription: null,
      remoteDescription: null,
      closed: false,
      onicecandidate: null,
      onicegatheringstatechange: null,
      onconnectionstatechange: null,
      oniceconnectionstatechange: null,
      ontrack: null,
      ondatachannel: null,
      addTrack(track: MinimalMediaStreamTrack) {
        const sender: MinimalRtpSender = {
          track,
          async replaceTrack(nextTrack: MinimalMediaStreamTrack | null) {
            sender.track = nextTrack
          },
        }
        senders.push(sender)
        return sender
      },
      getSenders: () => [...senders],
      createDataChannel(label: string) {
        const ch: MinimalDataChannel & { closed: boolean } = {
          label,
          readyState: 'connecting',
          closed: false,
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          send(data: string) {
            if (calleeDataChannel && calleeDataChannel.readyState === 'open') {
              calleeDataChannel.onmessage?.({ data })
            }
          },
          close() {
            ch.closed = true
            ch.readyState = 'closed'
            ch.onclose?.()
          },
        }
        callerDataChannel = ch
        return ch
      },
      async createOffer() {
        return {
          type: 'offer',
          sdp: [
            'v=0',
            'o=- 1 1 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            `a=fingerprint:sha-256 ${fingerprint}`,
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          ].join('\r\n'),
        }
      },
      async createAnswer() {
        return {
          type: 'answer',
          sdp: [
            'v=0',
            'o=- 2 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            `a=fingerprint:sha-256 ${fingerprint}`,
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          ].join('\r\n'),
        }
      },
      async setLocalDescription(desc) {
        pc.localDescription = desc
        queueMicrotask(() => {
          for (const c of candidates) {
            pc.onicecandidate?.({ candidate: { candidate: c } })
          }
          pc.iceGatheringState = 'complete'
          pc.onicecandidate?.({ candidate: null })
          pc.onicegatheringstatechange?.()
        })
      },
      async setRemoteDescription(desc) {
        pc.remoteDescription = desc
      },
      close() {
        pc.closed = true
        pc.connectionState = 'closed'
        pc.iceConnectionState = 'closed'
      },
    }
    return pc
  }

  const defaultCandidates = [
    'candidate:1 1 UDP 2122252543 192.168.1.50 54321 typ host',
    'candidate:2 1 UDP 1686052607 203.0.113.9 54322 typ srflx raddr 192.168.1.50 rport 54321',
    'candidate:3 1 UDP 41885439 198.51.100.20 59000 typ relay raddr 203.0.113.9 rport 54322',
  ]

  const callerPc = createPc(
    'caller',
    CALLER_FP,
    options?.callerCandidates ?? defaultCandidates,
  )
  const calleePc = createPc(
    'callee',
    CALLEE_FP,
    options?.calleeCandidates ?? defaultCandidates,
  )

  const createMediaDevices = (
    role: 'caller' | 'callee',
  ): MinimalMediaDevices & {
    getUserMediaCalls: Array<Record<string, unknown>>
    getDisplayMediaCalls: number
  } => {
    const trackStore = role === 'caller' ? callerTracks : calleeTracks
    const devices: MinimalMediaDevices & {
      getUserMediaCalls: Array<Record<string, unknown>>
      getDisplayMediaCalls: number
    } = {
      getUserMediaCalls: [],
      getDisplayMediaCalls: 0,
      async getUserMedia(constraints) {
        devices.getUserMediaCalls.push(
          constraints as unknown as Record<string, unknown>,
        )
        if (role === 'caller' && options?.denyCallerMic && constraints.audio) {
          throw new Error('NotAllowedError: Microphone permission denied')
        }
        if (
          role === 'caller' &&
          options?.denyCallerCamera &&
          constraints.video
        ) {
          throw new Error('NotAllowedError: Camera permission denied')
        }
        const tracks: MockTrack[] = []
        if (constraints.audio) {
          const t = createMockTrack('audio')
          trackStore.push(t)
          tracks.push(t)
        }
        if (constraints.video) {
          const t = createMockTrack('video')
          trackStore.push(t)
          tracks.push(t)
        }
        return createMockStream(tracks)
      },
      async getDisplayMedia() {
        devices.getDisplayMediaCalls += 1
        if (role === 'caller' && options?.denyCallerScreen) {
          throw new Error('NotAllowedError: Screen share permission denied')
        }
        const screenTrack = createMockTrack('video')
        trackStore.push(screenTrack)
        return createMockStream([screenTrack])
      },
    }
    return devices
  }

  const harness: LinkedPeerHarness = {
    callerConfig: null,
    calleeConfig: null,
    callerPc,
    calleePc,
    callerTracks,
    calleeTracks,
    callerMediaDevices: createMediaDevices('caller'),
    calleeMediaDevices: createMediaDevices('callee'),
    connectPeersAndOpenDataChannel() {
      const remoteCh: MinimalDataChannel & { closed: boolean } = {
        label: WEBRTC_DATA_CHANNEL_LABEL,
        readyState: 'open',
        closed: false,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        send(data: string) {
          if (callerDataChannel && callerDataChannel.readyState === 'open') {
            callerDataChannel.onmessage?.({ data })
          }
        },
        close() {
          remoteCh.closed = true
          remoteCh.readyState = 'closed'
          remoteCh.onclose?.()
        },
      }
      calleeDataChannel = remoteCh
      calleePc.ondatachannel?.({ channel: remoteCh })

      if (callerDataChannel) {
        callerDataChannel.readyState = 'open'
        callerDataChannel.onopen?.()
      }
      remoteCh.onopen?.()

      callerPc.connectionState = 'connected'
      callerPc.iceConnectionState = 'connected'
      callerPc.onconnectionstatechange?.()

      calleePc.connectionState = 'connected'
      calleePc.iceConnectionState = 'connected'
      calleePc.onconnectionstatechange?.()

      for (const s of callerSenders) {
        if (s.track) {
          const remoteTrack = createMockTrack(
            s.track.kind as 'audio' | 'video',
          )
          calleeTracks.push(remoteTrack)
          calleePc.ontrack?.({
            track: remoteTrack,
            streams: [createMockStream([remoteTrack])],
          })
        }
      }
      for (const s of calleeSenders) {
        if (s.track) {
          const remoteTrack = createMockTrack(
            s.track.kind as 'audio' | 'video',
          )
          callerTracks.push(remoteTrack)
          callerPc.ontrack?.({
            track: remoteTrack,
            streams: [createMockStream([remoteTrack])],
          })
        }
      }
    },
    failIceConnection() {
      callerPc.connectionState = 'failed'
      callerPc.iceConnectionState = 'failed'
      callerPc.oniceconnectionstatechange?.()
      calleePc.connectionState = 'failed'
      calleePc.iceConnectionState = 'failed'
      calleePc.oniceconnectionstatechange?.()
    },
  }

  return harness
}

function mountCallCard(props: Record<string, unknown>) {
  return mount(ChatMessageWebRtcCall, {
    props,
    global: {
      stubs: {
        'q-icon': { template: '<i />' },
        'q-badge': {
          template: '<span :data-testid="$attrs[\'data-testid\']"><slot /></span>',
        },
        'q-btn': {
          props: ['label', 'ariaLabel', 'icon'],
          emits: ['click'],
          template:
            '<button :data-testid="$attrs[\'data-testid\']" :aria-label="ariaLabel" @click="$emit(\'click\')">{{ label }}</button>',
        },
      },
    },
  })
}

describe('ChatMessageWebRtcCall & WebRtcCallSessionController (#464, #466, #468)', () => {
  it('registers ChatMessageWebRtcCall in applicationRenderer for WEBRTC_CALL_PLUGIN_ID', () => {
    expect(applicationRenderer(WEBRTC_CALL_PLUGIN_ID)).toBe(
      ChatMessageWebRtcCall,
    )
  })

  describe('#464 — Browser-to-Browser 1:1 WebRTC Voice Calls & Zero-Relay DataChannel Controls', () => {
    it('completes a full 1:1 voice call (invite -> accept -> connected -> P2P mute/unmute -> P2P hangup) with zero extra relay messages', async () => {
      const harness = createLinkedPeerHarness()
      const generateCertSpy = jest.fn(async () => ({ id: 'ephemeral-cert' }))

      const caller = new WebRtcCallSessionController({
        callId: 'call_voice_464_001',
        senderDeviceId: 'caller_dev_1',
        localPeerId: '0xaaaa',
        remotePeerId: '0xbbbb',
        gatherTimeoutMs: 10,
        peerConnectionFactory: cfg => {
          harness.callerConfig = cfg
          return harness.callerPc
        },
        mediaDevices: harness.callerMediaDevices,
        generateCertificate: generateCertSpy,
      })

      const callee = new WebRtcCallSessionController({
        callId: 'call_voice_464_001',
        senderDeviceId: 'callee_dev_1',
        localPeerId: '0xbbbb',
        remotePeerId: '0xaaaa',
        gatherTimeoutMs: 10,
        peerConnectionFactory: cfg => {
          harness.calleeConfig = cfg
          return harness.calleePc
        },
        mediaDevices: harness.calleeMediaDevices,
        generateCertificate: generateCertSpy,
      })

      // 1. Caller starts outgoing audio call
      const { payload: invitePayload, item: inviteItem } =
        await caller.startOutgoingCall({ withVideo: false })
      expect(invitePayload.action).toBe('invite')
      expect(invitePayload.mediaIntent).toBe('audio')
      expect(invitePayload.dtlsFingerprintSha256).toBe(CALLER_FP)
      expect(caller.getSnapshot().phase).toBe('ringing_outgoing')
      expect(caller.getSnapshot().relayMessagesSentCount).toBe(1)
      expect(generateCertSpy).toHaveBeenCalledWith({
        name: 'ECDSA',
        namedCurve: 'P-256',
      })

      // 2. Callee receives incoming invite: NO microphone or camera capture before user clicks Answer
      const ringingRes = callee.receiveIncomingInvite(invitePayload, '0xaaaa')
      expect(ringingRes.acceptedForRinging).toBe(true)
      expect(callee.getSnapshot().phase).toBe('ringing_incoming')
      expect(harness.calleeMediaDevices.getUserMediaCalls).toHaveLength(0)

      // Mount Callee UI card and click "Answer Audio"
      const calleeWrapper = mountCallCard({
        item: inviteItem,
        controller: callee,
        outbound: false,
      })
      expect(
        calleeWrapper.find('[data-testid="webrtc-status-badge"]').text(),
      ).toBe('Ringing')
      expect(
        calleeWrapper.find('[data-testid="webrtc-answer-audio"]').exists(),
      ).toBe(true)

      await calleeWrapper
        .find('[data-testid="webrtc-answer-audio"]')
        .trigger('click')
      await new Promise(resolve => setTimeout(resolve, 25))

      const emittedFollowUps = calleeWrapper.emitted('sendFollowUp')
      expect(emittedFollowUps).toBeDefined()
      expect(emittedFollowUps).toHaveLength(1)
      const acceptItem = (
        emittedFollowUps?.[0]?.[0] as { items: Array<unknown> }
      ).items[0]
      const acceptPayload = extractWebRtcCallPayload(acceptItem)
      expect(acceptPayload?.action).toBe('accept')
      expect(acceptPayload?.dtlsFingerprintSha256).toBe(CALLEE_FP)
      expect(harness.calleeMediaDevices.getUserMediaCalls).toHaveLength(1)

      // 3. Caller processes callee's accept and peers connect over DTLS-SRTP + P2P DataChannel
      const acceptedOk = await caller.handleIncomingAccept(
        acceptPayload as WebRtcCallPayload,
      )
      expect(acceptedOk).toBe(true)
      harness.connectPeersAndOpenDataChannel()

      expect(caller.getSnapshot().phase).toBe('connected')
      expect(callee.getSnapshot().phase).toBe('connected')
      expect(caller.getSnapshot().dtlsVerified).toBe(true)
      expect(callee.getSnapshot().dtlsVerified).toBe(true)
      expect(caller.getSnapshot().dataChannelOpen).toBe(true)
      expect(callee.getSnapshot().dataChannelOpen).toBe(true)

      // 4. Caller toggles Mute & Unmute over the P2P DataChannel (zero extra relay messages)
      const callerWrapper = mountCallCard({
        item: inviteItem,
        controller: caller,
        outbound: true,
      })
      await callerWrapper
        .find('[data-testid="webrtc-toggle-mute"]')
        .trigger('click')
      expect(caller.getSnapshot().localMuted).toBe(true)
      expect(harness.callerTracks[0]?.enabled).toBe(false)
      expect(callee.getSnapshot().remoteMuted).toBe(true)

      await callerWrapper
        .find('[data-testid="webrtc-toggle-mute"]')
        .trigger('click')
      expect(caller.getSnapshot().localMuted).toBe(false)
      expect(harness.callerTracks[0]?.enabled).toBe(true)
      expect(callee.getSnapshot().remoteMuted).toBe(false)

      // 5. Caller clicks Hang Up -> sent over P2P DataChannel with zero extra relay messages
      await callerWrapper
        .find('[data-testid="webrtc-hangup"]')
        .trigger('click')
      expect(caller.getSnapshot().phase).toBe('ended')
      expect(callee.getSnapshot().phase).toBe('ended')

      // Only 1 relay message sent by caller (invite) and 1 by callee (accept)!
      expect(caller.getSnapshot().relayMessagesSentCount).toBe(1)
      expect(callee.getSnapshot().relayMessagesSentCount).toBe(1)
      expect(callerWrapper.emitted('sendFollowUp')).toBeUndefined()

      // Every track and PeerConnection is deterministically stopped/closed
      for (const t of harness.callerTracks) {
        expect(t.stoppedCount).toBeGreaterThan(0)
      }
      for (const t of harness.calleeTracks) {
        expect(t.stoppedCount).toBeGreaterThan(0)
      }
      expect(harness.callerPc.closed).toBe(true)
      expect(harness.calleePc.closed).toBe(true)
    })
  })

  describe('#466 — 1:1 WebRTC Video, Camera Switching, Screen Sharing & Audio-Priority Fallback', () => {
    it('toggles camera video, switches front/rear camera facingMode, and starts/stops screen share over P2P DataChannel', async () => {
      const harness = createLinkedPeerHarness()

      const caller = new WebRtcCallSessionController({
        callId: 'call_video_466_001',
        senderDeviceId: 'caller_dev_1',
        localPeerId: '0xaaaa',
        remotePeerId: '0xbbbb',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })

      const callee = new WebRtcCallSessionController({
        callId: 'call_video_466_001',
        senderDeviceId: 'callee_dev_1',
        localPeerId: '0xbbbb',
        remotePeerId: '0xaaaa',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.calleePc,
        mediaDevices: harness.calleeMediaDevices,
      })

      const { payload: invite } = await caller.startOutgoingCall({
        withVideo: false,
      })
      callee.receiveIncomingInvite(invite, '0xaaaa')
      const { payload: accept } = await callee.acceptIncomingCall({
        withVideo: false,
      })
      await caller.handleIncomingAccept(accept)
      harness.connectPeersAndOpenDataChannel()

      const callerWrapper = mountCallCard({
        payload: invite,
        controller: caller,
        outbound: true,
      })

      // 1. Enable camera video mid-call
      await callerWrapper
        .find('[data-testid="webrtc-toggle-video"]')
        .trigger('click')
      await new Promise(resolve => setTimeout(resolve, 15))

      expect(caller.getSnapshot().videoEnabled).toBe(true)
      expect(caller.getSnapshot().mediaMode).toBe('video')
      expect(callee.getSnapshot().remoteVideoEnabled).toBe(true)
      expect(
        callerWrapper.find('[data-testid="webrtc-local-video"]').exists(),
      ).toBe(true)
      expect(
        callerWrapper.find('[data-testid="webrtc-remote-video"]').exists(),
      ).toBe(true)

      // 2. Switch camera facingMode ('user' -> 'environment')
      expect(caller.getSnapshot().cameraFacingMode).toBe('user')
      await callerWrapper
        .find('[data-testid="webrtc-switch-camera"]')
        .trigger('click')
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(caller.getSnapshot().cameraFacingMode).toBe('environment')
      expect(
        harness.callerMediaDevices.getUserMediaCalls[
          harness.callerMediaDevices.getUserMediaCalls.length - 1
        ],
      ).toEqual({
        video: { facingMode: 'environment' },
      })

      // 3. Start screen sharing (`getDisplayMedia`) and auto-stop when native browser "Stop sharing" fires `onended`
      await callerWrapper
        .find('[data-testid="webrtc-toggle-screen"]')
        .trigger('click')
      await new Promise(resolve => setTimeout(resolve, 15))

      expect(harness.callerMediaDevices.getDisplayMediaCalls).toBe(1)
      expect(caller.getSnapshot().screenShareEnabled).toBe(true)
      expect(caller.getSnapshot().mediaMode).toBe('screen')
      expect(callee.getSnapshot().remoteScreenShareEnabled).toBe(true)

      // Simulate user clicking browser native "Stop sharing" button on the screen track
      const screenTrack =
        harness.callerTracks[harness.callerTracks.length - 1]
      screenTrack?.onended?.()
      await new Promise(resolve => setTimeout(resolve, 15))

      expect(caller.getSnapshot().screenShareEnabled).toBe(false)
      expect(screenTrack?.stoppedCount).toBeGreaterThan(0)
      // Zero extra Frank relay messages used for any mid-call video/camera/screen transitions!
      expect(caller.getSnapshot().relayMessagesSentCount).toBe(1)
    })

    it('preserves active audio call when camera or screen-share permission is denied or bandwidth degrades', async () => {
      const harness = createLinkedPeerHarness({
        denyCallerCamera: true,
        denyCallerScreen: true,
      })

      const caller = new WebRtcCallSessionController({
        callId: 'call_fallback_466_002',
        senderDeviceId: 'caller_dev_1',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })
      const callee = new WebRtcCallSessionController({
        callId: 'call_fallback_466_002',
        senderDeviceId: 'callee_dev_1',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.calleePc,
        mediaDevices: harness.calleeMediaDevices,
      })

      // Starting with video=true falls back gracefully to audio-only when camera is denied
      const { payload: invite } = await caller.startOutgoingCall({
        withVideo: true,
      })
      expect(invite.mediaIntent).toBe('audio')
      expect(caller.getSnapshot().videoDegradedOrDenied).toBe(true)

      callee.receiveIncomingInvite(invite)
      const { payload: accept } = await callee.acceptIncomingCall()
      await caller.handleIncomingAccept(accept)
      harness.connectPeersAndOpenDataChannel()

      expect(caller.getSnapshot().phase).toBe('connected')

      // Mid-call camera & screen share denial keeps audio call connected
      const enabledVideo = await caller.setVideoEnabled(true)
      expect(enabledVideo).toBe(false)
      expect(caller.getSnapshot().phase).toBe('connected')
      expect(caller.getSnapshot().videoDegradedOrDenied).toBe(true)

      const enabledScreen = await caller.setScreenShareEnabled(true)
      expect(enabledScreen).toBe(false)
      expect(caller.getSnapshot().phase).toBe('connected')

      const wrapper = mountCallCard({
        payload: invite,
        controller: caller,
        outbound: true,
      })
      expect(
        wrapper.find('[data-testid="webrtc-audio-fallback-notice"]').exists(),
      ).toBe(true)
    })
  })

  describe('#468 — Authentication, NAT Traversal Privacy, Glare/Multi-Device & Cleanup Verification Matrix', () => {
    it('aborts immediately on DTLS fingerprint mismatch in accept SDP or DataChannel renegotiation without enabling media', async () => {
      const harness = createLinkedPeerHarness()
      const violations: string[] = []

      const caller = new WebRtcCallSessionController({
        callId: 'call_mitm_468_001',
        senderDeviceId: 'caller_dev_1',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
        onSecurityViolation: reason => violations.push(reason),
      })

      const { payload: invite } = await caller.startOutgoingCall()

      // Relay/MITM attacker substitutes the SDP fingerprint in `accept` while keeping the header fingerprint
      const tamperedAccept: WebRtcCallPayload = {
        schemaVersion: 1,
        callId: invite.callId,
        action: 'accept',
        sequence: 1,
        senderDeviceId: 'callee_dev_1',
        sdp: [
          'v=0',
          'o=- 2 2 IN IP4 127.0.0.1',
          's=-',
          't=0 0',
          `a=fingerprint:sha-256 ${ATTACKER_FP}`,
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        ].join('\r\n'),
        dtlsFingerprintSha256: CALLEE_FP,
      }

      const accepted = await caller.handleIncomingAccept(tamperedAccept)
      expect(accepted).toBe(false)
      expect(caller.getSnapshot().phase).toBe('security_abort')
      expect(caller.getSnapshot().dtlsVerified).toBe(false)
      expect(violations).toContain('dtls-fingerprint-mismatch')
      expect(harness.callerPc.closed).toBe(true)
      for (const track of harness.callerTracks) {
        expect(track.stoppedCount).toBeGreaterThan(0)
      }

      const wrapper = mountCallCard({
        payload: invite,
        controller: caller,
        outbound: true,
      })
      expect(
        wrapper.find('[data-testid="webrtc-security-alert"]').exists(),
      ).toBe(true)
      expect(
        wrapper.find('[data-testid="webrtc-status-badge"]').text(),
      ).toBe('Security Abort')
    })

    it('aborts if a mid-call DataChannel renegotiate_offer contains a mismatched DTLS fingerprint', async () => {
      const harness = createLinkedPeerHarness()
      const caller = new WebRtcCallSessionController({
        callId: 'call_dc_mitm_468',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })
      const callee = new WebRtcCallSessionController({
        callId: 'call_dc_mitm_468',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.calleePc,
        mediaDevices: harness.calleeMediaDevices,
      })

      const { payload: invite } = await caller.startOutgoingCall()
      callee.receiveIncomingInvite(invite)
      const { payload: accept } = await callee.acceptIncomingCall()
      await caller.handleIncomingAccept(accept)
      harness.connectPeersAndOpenDataChannel()

      // Inject a renegotiate_offer over the DataChannel with an attacker fingerprint
      const ch = caller.getControlDataChannel()
      ch?. send(
        JSON.stringify({
          type: 'renegotiate_offer',
          mediaIntent: 'video',
          sdp: `v=0\r\na=fingerprint:sha-256 ${ATTACKER_FP}\r\n`,
          dtlsFingerprintSha256: ATTACKER_FP,
          seq: 99,
        }),
      )
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(callee.getSnapshot().phase).toBe('security_abort')
      expect(harness.calleePc.closed).toBe(true)
    })

    it('enforces relay-only IP privacy mode: sets iceTransportPolicy="relay" and strips all host/srflx candidates from SDP', async () => {
      const harness = createLinkedPeerHarness()
      const caller = new WebRtcCallSessionController({
        callId: 'call_relay_468_002',
        icePolicy: 'relay-only',
        gatherTimeoutMs: 10,
        peerConnectionFactory: cfg => {
          harness.callerConfig = cfg
          return harness.callerPc
        },
        mediaDevices: harness.callerMediaDevices,
      })

      const { payload: invite } = await caller.startOutgoingCall({
        icePolicy: 'relay-only',
      })

      expect(harness.callerConfig?.iceTransportPolicy).toBe('relay')
      expect(invite.icePolicy).toBe('relay-only')
      expect(invite.sdp).toContain('typ relay')
      expect(invite.sdp).not.toContain('typ host')
      expect(invite.sdp).not.toContain('typ srflx')
      expect(invite.sdp).not.toContain('192.168.1.50')

      const wrapper = mountCallCard({
        payload: invite,
        controller: caller,
        outbound: true,
      })
      expect(
        wrapper.find('[data-testid="webrtc-privacy-badge"]').text(),
      ).toBe('Relay-Only IP Hidden')
    })

    it('resolves simultaneous outgoing invite glare deterministically and stops ringing on multi-device acceptance', async () => {
      const harness = createLinkedPeerHarness()
      const peerA = new WebRtcCallSessionController({
        callId: 'call_glare_a_0001',
        senderDeviceId: 'dev_a1',
        localPeerId: '0x1111',
        remotePeerId: '0x9999',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })
      const peerB = new WebRtcCallSessionController({
        callId: 'call_glare_b_0001',
        senderDeviceId: 'dev_b1',
        localPeerId: '0x9999',
        remotePeerId: '0x1111',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.calleePc,
        mediaDevices: harness.calleeMediaDevices,
      })

      const { payload: inviteA } = await peerA.startOutgoingCall()
      const { payload: inviteB } = await peerB.startOutgoingCall()

      // Both peers receive the other's invite while in `ringing_outgoing`
      const resA = peerA.receiveIncomingInvite(inviteB, '0x9999')
      const resB = peerB.receiveIncomingInvite(inviteA, '0x1111')

      // Lexicographically '0x1111:call_glare_a_0001' < '0x9999:call_glare_b_0001' -> peerA wins and stays ringing_outgoing; peerB switches to ringing_incoming
      expect(resA.reason).toBe('glare_won_keep_outgoing')
      expect(peerA.getSnapshot().phase).toBe('ringing_outgoing')
      expect(resB.reason).toBe('glare_lost_switched_to_incoming')
      expect(peerB.getSnapshot().phase).toBe('ringing_incoming')
      expect(peerB.getSnapshot().callId).toBe('call_glare_a_0001')

      // Multi-device convergence: another device of peerB (`dev_b2`) accepts `call_glare_a_0001`
      await peerB.handleSignalingPayload(
        {
          schemaVersion: 1,
          callId: 'call_glare_a_0001',
          action: 'accept',
          sequence: 1,
          senderDeviceId: 'dev_b2',
          sdp: `v=0\r\na=fingerprint:sha-256 ${CALLEE_FP}\r\n`,
          dtlsFingerprintSha256: CALLEE_FP,
        },
        { outbound: true },
      )
      expect(peerB.getSnapshot().answeredElsewhere).toBe(true)
      expect(peerB.getSnapshot().phase).toBe('ended')

      const wrapperB = mountCallCard({
        payload: inviteA,
        controller: peerB,
        outbound: false,
      })
      expect(
        wrapperB.find('[data-testid="webrtc-answered-elsewhere"]').exists(),
      ).toBe(true)
      expect(
        wrapperB.find('[data-testid="webrtc-answer-audio"]').exists(),
      ).toBe(false)
    })

    it('rejects expired invites, ignores cross-call injection, and releases all tracks/connections on ICE failure or component unmount', async () => {
      const harness = createLinkedPeerHarness()
      const now = 1_700_000_000_000

      const controller = new WebRtcCallSessionController({
        callId: 'call_cleanup_468_01',
        nowMs: () => now,
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })

      // Expired invite is rejected without starting media
      const expiredRes = controller.receiveIncomingInvite({
        schemaVersion: 1,
        callId: 'call_expired_0001',
        action: 'invite',
        sequence: 0,
        senderDeviceId: 'remote_dev',
        sdp: `v=0\r\na=fingerprint:sha-256 ${CALLER_FP}\r\n`,
        dtlsFingerprintSha256: CALLER_FP,
        expiresAtMs: now - 1_000,
      })
      expect(expiredRes.acceptedForRinging).toBe(false)
      expect(expiredRes.reason).toBe('invite_expired')
      expect(controller.getSnapshot().phase).toBe('expired')

      // Active call ignores cross-call accept/hangup injection and cleans up on unmount
      const activeController = new WebRtcCallSessionController({
        callId: 'call_active_468_01',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })
      const { payload: invite } = await activeController.startOutgoingCall()
      const crossCallAccept = await activeController.handleIncomingAccept({
        schemaVersion: 1,
        callId: 'call_different_id_01',
        action: 'accept',
        sequence: 1,
        senderDeviceId: 'attacker_dev',
        sdp: `v=0\r\na=fingerprint:sha-256 ${CALLEE_FP}\r\n`,
        dtlsFingerprintSha256: CALLEE_FP,
      })
      expect(crossCallAccept).toBe(false)
      expect(activeController.getSnapshot().phase).toBe('ringing_outgoing')

      const wrapper = mountCallCard({
        payload: invite,
        controller: activeController,
        outbound: true,
      })
      wrapper.unmount()

      for (const track of harness.callerTracks) {
        expect(track.stoppedCount).toBeGreaterThan(0)
      }
      expect(harness.callerPc.closed).toBe(true)
    })

    it('shows outgoing local video preview during ringing_outgoing and survives optimistic message re-keying without stopping camera tracks', async () => {
      const harness = createLinkedPeerHarness()
      const caller = new WebRtcCallSessionController({
        callId: 'call_rekey_preview_01',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })
      const callee = new WebRtcCallSessionController({
        callId: 'call_rekey_preview_01',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.calleePc,
        mediaDevices: harness.calleeMediaDevices,
      })

      const { payload: invite } = await caller.startOutgoingCall({
        withVideo: true,
      })
      registerCallSessionController(invite.callId, caller)

      // Optimistic message bubble mounts (without explicit :controller prop, using shared registry)
      const optimisticWrapper = mountCallCard({
        payload: invite,
        outbound: true,
      })
      expect(
        optimisticWrapper.find('[data-testid="webrtc-local-video"]').exists(),
      ).toBe(true)

      // Optimistic bubble unmounts when re-keyed to committed payloadDigest ~1.5s later
      optimisticWrapper.unmount()
      for (const track of harness.callerTracks) {
        expect(track.stoppedCount).toBe(0)
      }
      expect(harness.callerPc.closed).toBe(false)

      // Callee answers and committed caller bubble mounts with [invite, accept] messages
      callee.receiveIncomingInvite(invite)
      const { payload: accept } = await callee.acceptIncomingCall({
        withVideo: true,
      })

      const committedWrapper = mountCallCard({
        payload: invite,
        outbound: true,
        messages: [
          { payload: invite, outbound: true },
          { payload: accept, outbound: false },
        ],
      })
      await new Promise(resolve => setTimeout(resolve, 10))
      harness.connectPeersAndOpenDataChannel()
      await committedWrapper.vm.$nextTick()

      expect(caller.getSnapshot().phase).toBe('connected')
      expect(
        committedWrapper.find('[data-testid="webrtc-status-badge"]').text(),
      ).toBe('In Call')

      committedWrapper.unmount()
      caller.cleanup()
      unregisterCallSessionController(invite.callId, caller)
    })

    it('renders Ringing with Answer Audio, Answer Video, and Decline buttons on an incoming invite bubble mounted without an explicit controller prop', async () => {
      const harness = createLinkedPeerHarness()
      const caller = new WebRtcCallSessionController({
        callId: 'call_incoming_ui_001',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })
      const { item: inviteItem, payload: invitePayload } =
        await caller.startOutgoingCall({ withVideo: false })

      const incomingWrapper = mountCallCard({
        item: inviteItem,
        outbound: false,
        address: '0xbbbb',
        senderAddress: '0xaaaa',
      })

      expect(
        incomingWrapper.find('[data-testid="webrtc-status-badge"]').text(),
      ).toBe('Ringing')
      expect(
        incomingWrapper.find('[data-testid="webrtc-answer-audio"]').exists(),
      ).toBe(true)
      expect(
        incomingWrapper.find('[data-testid="webrtc-answer-video"]').exists(),
      ).toBe(true)
      expect(
        incomingWrapper.find('[data-testid="webrtc-reject"]').exists(),
      ).toBe(true)

      // Clicking Decline emits reject follow-up and transitions to Declined
      await incomingWrapper
        .find('[data-testid="webrtc-reject"]')
        .trigger('click')
      await incomingWrapper.vm.$nextTick()

      expect(
        incomingWrapper.find('[data-testid="webrtc-status-badge"]').text(),
      ).toBe('Declined')
      expect(
        incomingWrapper.find('[data-testid="webrtc-answer-audio"]').exists(),
      ).toBe(false)

      incomingWrapper.unmount()
      caller.cleanup()
      unregisterCallSessionController(invitePayload.callId)
    })

    it('expands into full-stage theater view when clicking the primary video or expand button and swaps primary/PiP on PiP click', async () => {
      const harness = createLinkedPeerHarness()
      const caller = new WebRtcCallSessionController({
        callId: 'call_stage_expand_01',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.callerPc,
        mediaDevices: harness.callerMediaDevices,
      })
      const callee = new WebRtcCallSessionController({
        callId: 'call_stage_expand_01',
        gatherTimeoutMs: 5,
        peerConnectionFactory: () => harness.calleePc,
        mediaDevices: harness.calleeMediaDevices,
      })

      const { payload: invite } = await caller.startOutgoingCall({
        withVideo: true,
      })
      callee.receiveIncomingInvite(invite)
      const { payload: accept } = await callee.acceptIncomingCall({
        withVideo: true,
      })
      await caller.handleIncomingAccept(accept)
      harness.connectPeersAndOpenDataChannel()

      // Simulate a 325px left sidebar (.frank-main-drawer) in the layout
      const fakeDrawer = document.createElement('div')
      fakeDrawer.className = 'frank-main-drawer'
      fakeDrawer.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 325,
          bottom: 800,
          width: 325,
          height: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect)
      document.body.appendChild(fakeDrawer)

      const wrapper = mountCallCard({
        payload: invite,
        controller: caller,
        outbound: true,
      })
      await wrapper.vm.$nextTick()

      const card = wrapper.find('[data-testid="webrtc-call-card"]')
      expect(card.classes()).not.toContain('webrtc-call-card--expanded')

      // Clicking the remote (primary) video expands the call into chat-pane theater view,
      // leaving the 325px sidebar + 12px margin uncovered (left: 337px)
      await wrapper.find('[data-testid="webrtc-remote-video"]').trigger('click')
      await wrapper.vm.$nextTick()
      expect(card.classes()).toContain('webrtc-call-card--expanded')
      expect((card.element as HTMLElement).style.left).toBe('337px')

      // Clicking the PiP (local) video swaps local to primary stage
      const localSlot = wrapper
        .find('[data-testid="webrtc-local-video"]')
        .element.parentElement!
      expect(localSlot.classList.contains('webrtc-video-slot--pip')).toBe(true)
      await wrapper.find('[data-testid="webrtc-local-video"]').trigger('click')
      await wrapper.vm.$nextTick()
      expect(localSlot.classList.contains('webrtc-video-slot--primary')).toBe(
        true,
      )

      // Clicking the expand/minimize header toggle collapses back to inline card
      await wrapper
        .find('[data-testid="webrtc-toggle-expand"]')
        .trigger('click')
      await wrapper.vm.$nextTick()
      expect(card.classes()).not.toContain('webrtc-call-card--expanded')

      document.body.removeChild(fakeDrawer)
      wrapper.unmount()
      callee.cleanup()
    })
  })
})
