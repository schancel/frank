import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import {
  DEFAULT_PAIRING_TTL_MS,
  DEVICE_PAIRING_DATA_CHANNEL_LABEL,
  DEVICE_PAIRING_PROTOCOL_VERSION,
  DevicePairingHandshakeMachine,
  DeviceSyncBundle,
  createDevicePairingSession,
  decryptDeviceSyncBundle,
  deriveDevicePairingKeys,
  encryptDeviceSyncBundle,
  formatDevicePairingUri,
  isDevicePairingUri,
  normalizeDtlsFingerprintSha256,
  parseDevicePairingUri,
  zeroizePairingKeys,
} from './index'

const INITIATOR_DTLS_FP =
  'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01'
const RESPONDER_DTLS_FP =
  '02:13:24:35:46:57:68:79:8A:9B:AC:BD:CE:DF:E0:F1:12:23:34:45:56:67:78:89:9A:AB:BC:CD:DE:EF:F0:10'
const MITM_DTLS_FP =
  '99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA'

const SAMPLE_SYNC_BUNDLE: DeviceSyncBundle = {
  schemaVersion: 1,
  exportedAtMs: 1_760_000_050_000,
  sourceDeviceId: 'desktop-mac-01',
  accountAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  mnemonicOrSeedHex:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  contacts: [
    {
      address: '0x1111111111111111111111111111111111111111',
      name: 'Alice',
      username: 'alice',
      bio: 'Frank researcher',
    },
    {
      address: '0x2222222222222222222222222222222222222222',
      name: 'Bob',
    },
  ],
  conversations: [
    {
      id: 'conv-alice-1',
      address: '0x1111111111111111111111111111111111111111',
      name: 'Alice',
      topic: 'general',
      updatedAt: 1_760_000_040_000,
    },
  ],
  syncJournalCursorHex: '000000000000002a',
}

describe('device-pairing (#1704)', () => {
  describe('QR URI schema & session creation', () => {
    it('creates a pairing session and round-trips the frank://pair QR URI', () => {
      const nowMs = 1_760_000_000_000
      const { session, qrUri } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-mac-01',
        dtlsFingerprintSha256: `sha-256 ${INITIATOR_DTLS_FP.toLowerCase()}`,
        nowMs,
        relayUrl: 'wss://relay.frank.cash/signal',
      })

      expect(DEVICE_PAIRING_PROTOCOL_VERSION).toBe(1)
      expect(DEVICE_PAIRING_DATA_CHANNEL_LABEL).toBe('frank-device-pair-v1')
      expect(session.expiresAtMs).toBe(nowMs + DEFAULT_PAIRING_TTL_MS)
      expect(session.sessionId).toMatch(/^[0-9a-f]{32}$/)
      expect(session.ephemeralPubKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/)
      expect(session.dtlsFingerprintSha256).toBe(INITIATOR_DTLS_FP)
      expect(isDevicePairingUri(qrUri)).toBe(true)

      const parsed = parseDevicePairingUri(qrUri, { nowMs: nowMs + 10_000 })
      expect(parsed).toEqual({
        version: 1,
        sessionId: session.sessionId,
        initiatorDeviceId: 'desktop-mac-01',
        initiatorEphemeralPubKeyHex: session.ephemeralPubKeyHex,
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        expiresAtMs: nowMs + DEFAULT_PAIRING_TTL_MS,
        relayUrl: 'wss://relay.frank.cash/signal',
      })
    })

    it('rejects expired pairing QR URIs when nowMs >= expiresAtMs', () => {
      const nowMs = 1_760_000_000_000
      const { qrUri } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-mac-01',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs,
        ttlMs: 60_000,
      })

      expect(parseDevicePairingUri(qrUri, { nowMs: nowMs + 59_999 })).not.toBeNull()
      expect(parseDevicePairingUri(qrUri, { nowMs: nowMs + 60_000 })).toBeNull()
      expect(parseDevicePairingUri(qrUri, { nowMs: nowMs + 120_000 })).toBeNull()
    })

    it('rejects malformed URIs, weak/invalid DTLS fingerprints, and invalid curve points', () => {
      expect(normalizeDtlsFingerprintSha256('sha-1 AA:BB:CC')).toBeNull()
      expect(normalizeDtlsFingerprintSha256('md5 AA:BB:CC')).toBeNull()
      expect(
        normalizeDtlsFingerprintSha256(Array(32).fill('00').join(':')),
      ).toBeNull()
      expect(
        normalizeDtlsFingerprintSha256(Array(32).fill('FF').join(':')),
      ).toBeNull()

      expect(parseDevicePairingUri('https://frank.cash/pair?v=1')).toBeNull()
      expect(parseDevicePairingUri('frank://pair?v=2')).toBeNull()

      const { session } = createDevicePairingSession({
        initiatorDeviceId: 'dev-1',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs: 1_760_000_000_000,
      })

      // Invalid session ID
      const badSid = formatDevicePairingUri(session.payload).replace(
        `sid=${session.sessionId}`,
        'sid=1234',
      )
      expect(parseDevicePairingUri(badSid)).toBeNull()

      // Invalid secp256k1 point (prefix 04 or off-curve)
      const badPub = formatDevicePairingUri(session.payload).replace(
        `pub=${session.ephemeralPubKeyHex}`,
        `pub=02${'0'.repeat(64)}`,
      )
      expect(parseDevicePairingUri(badPub)).toBeNull()

      // Weak fingerprint
      const badFp = formatDevicePairingUri(session.payload).replace(
        encodeURIComponent(INITIATOR_DTLS_FP),
        'AA%3ABB%3ACC',
      )
      expect(parseDevicePairingUri(badFp)).toBeNull()

      // Unsafe relay URL scheme
      const badRelay = `${formatDevicePairingUri(session.payload)}&relay=javascript:alert(1)`
      expect(parseDevicePairingUri(badRelay)).toBeNull()
    })
  })

  describe('ECDH + HKDF mutual key derivation & MITM detection', () => {
    it('derives identical encryptionKey, transcriptHashHex, sasDigits, and sasWords on initiator and responder', () => {
      const { session } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-1',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs: 1_760_000_000_000,
      })

      const responderPrivKey = secp256k1.utils.randomPrivateKey()
      const responderPubKeyHex = bytesToHex(
        secp256k1.getPublicKey(responderPrivKey, true),
      )

      const initiatorKeys = deriveDevicePairingKeys({
        localEphemeralPrivKey: session.ephemeralPrivKey,
        remoteEphemeralPubKeyHex: responderPubKeyHex,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
      })

      const responderKeys = deriveDevicePairingKeys({
        localEphemeralPrivKey: responderPrivKey,
        remoteEphemeralPubKeyHex: session.ephemeralPubKeyHex,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
      })

      expect(initiatorKeys.encryptionKey).toHaveLength(32)
      expect(Buffer.from(initiatorKeys.encryptionKey)).toEqual(
        Buffer.from(responderKeys.encryptionKey),
      )
      expect(initiatorKeys.transcriptHashHex).toBe(
        responderKeys.transcriptHashHex,
      )
      expect(initiatorKeys.sasDigits).toMatch(/^\d{6}$/)
      expect(initiatorKeys.sasDigits).toBe(responderKeys.sasDigits)
      expect(initiatorKeys.sasWords).toHaveLength(4)
      expect(initiatorKeys.sasWords).toEqual(responderKeys.sasWords)
    })

    it('detects MITM substitution of either WebRTC DTLS fingerprint or ephemeral public key', () => {
      const { session } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-1',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs: 1_760_000_000_000,
      })

      const responderPrivKey = secp256k1.utils.randomPrivateKey()
      const responderPubKeyHex = bytesToHex(
        secp256k1.getPublicKey(responderPrivKey, true),
      )

      const mitmPrivKey = secp256k1.utils.randomPrivateKey()
      const mitmPubKeyHex = bytesToHex(
        secp256k1.getPublicKey(mitmPrivKey, true),
      )

      const honestInitiatorKeys = deriveDevicePairingKeys({
        localEphemeralPrivKey: session.ephemeralPrivKey,
        remoteEphemeralPubKeyHex: responderPubKeyHex,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
      })

      // Case 1: Active network/signaling MITM substitutes responder DTLS certificate fingerprint
      const mitmDtlsResponderKeys = deriveDevicePairingKeys({
        localEphemeralPrivKey: responderPrivKey,
        remoteEphemeralPubKeyHex: session.ephemeralPubKeyHex,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: MITM_DTLS_FP,
      })

      expect(mitmDtlsResponderKeys.sasDigits).not.toBe(
        honestInitiatorKeys.sasDigits,
      )
      expect(mitmDtlsResponderKeys.sasWords).not.toEqual(
        honestInitiatorKeys.sasWords,
      )
      expect(Buffer.from(mitmDtlsResponderKeys.encryptionKey)).not.toEqual(
        Buffer.from(honestInitiatorKeys.encryptionKey),
      )

      const encrypted = encryptDeviceSyncBundle(
        SAMPLE_SYNC_BUNDLE,
        honestInitiatorKeys.encryptionKey,
        session.sessionId,
      )
      expect(() =>
        decryptDeviceSyncBundle(
          encrypted,
          mitmDtlsResponderKeys.encryptionKey,
          session.sessionId,
        ),
      ).toThrow('DeviceSyncBundle AEAD authentication failed')

      // Case 2: Active MITM substitutes ephemeral public key
      const mitmEcdhInitiatorKeys = deriveDevicePairingKeys({
        localEphemeralPrivKey: session.ephemeralPrivKey,
        remoteEphemeralPubKeyHex: mitmPubKeyHex,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
      })
      const mitmEcdhResponderKeys = deriveDevicePairingKeys({
        localEphemeralPrivKey: responderPrivKey,
        remoteEphemeralPubKeyHex: mitmPubKeyHex,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
      })

      expect(mitmEcdhInitiatorKeys.sasDigits).not.toBe(
        mitmEcdhResponderKeys.sasDigits,
      )
      expect(mitmEcdhInitiatorKeys.sasWords).not.toEqual(
        mitmEcdhResponderKeys.sasWords,
      )
    })

    it('rejects public key reflection attacks where remoteEphemeralPubKeyHex equals local public key', () => {
      const { session } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-1',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs: 1_760_000_000_000,
      })

      expect(() =>
        deriveDevicePairingKeys({
          localEphemeralPrivKey: session.ephemeralPrivKey,
          remoteEphemeralPubKeyHex: session.ephemeralPubKeyHex,
          sessionId: session.sessionId,
          initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
          responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
        }),
      ).toThrow(/reflection/i)
    })
  })

  describe('DeviceSyncBundle E2EE encryption & decryption', () => {
    it('encrypts and decrypts a full DeviceSyncBundle preserving contacts, conversations, and seed', () => {
      const { session } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-mac-01',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs: 1_760_000_000_000,
      })
      const responderPriv = secp256k1.utils.randomPrivateKey()
      const responderPub = bytesToHex(secp256k1.getPublicKey(responderPriv, true))

      const keys = deriveDevicePairingKeys({
        localEphemeralPrivKey: session.ephemeralPrivKey,
        remoteEphemeralPubKeyHex: responderPub,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
      })

      const encrypted = encryptDeviceSyncBundle(
        SAMPLE_SYNC_BUNDLE,
        keys.encryptionKey,
        session.sessionId,
      )
      expect(encrypted.ciphertextBase64).not.toContain(
        SAMPLE_SYNC_BUNDLE.mnemonicOrSeedHex,
      )
      expect(encrypted.bundleDigestHex).toMatch(/^[0-9a-f]{64}$/)

      const decrypted = decryptDeviceSyncBundle(
        encrypted,
        keys.encryptionKey,
        session.sessionId,
      )
      expect(decrypted).toEqual(SAMPLE_SYNC_BUNDLE)
    })

    it('rejects ciphertext tampering, wrong sessionId AAD, or zeroized keys', () => {
      const { session } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-mac-01',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs: 1_760_000_000_000,
      })
      const responderPriv = secp256k1.utils.randomPrivateKey()
      const responderPub = bytesToHex(secp256k1.getPublicKey(responderPriv, true))
      const keys = deriveDevicePairingKeys({
        localEphemeralPrivKey: session.ephemeralPrivKey,
        remoteEphemeralPubKeyHex: responderPub,
        sessionId: session.sessionId,
        initiatorDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
      })

      const encrypted = encryptDeviceSyncBundle(
        SAMPLE_SYNC_BUNDLE,
        keys.encryptionKey,
        session.sessionId,
      )

      // Wrong sessionId AAD
      const otherSessionId = 'f'.repeat(32)
      expect(() =>
        decryptDeviceSyncBundle(encrypted, keys.encryptionKey, otherSessionId),
      ).toThrow('DeviceSyncBundle AEAD authentication failed')

      // Flip a bit in ciphertext
      const rawCipher = Buffer.from(encrypted.ciphertextBase64, 'base64')
      rawCipher[0] ^= 0xff
      expect(() =>
        decryptDeviceSyncBundle(
          {
            ...encrypted,
            ciphertextBase64: rawCipher.toString('base64'),
          },
          keys.encryptionKey,
          session.sessionId,
        ),
      ).toThrow('DeviceSyncBundle AEAD authentication failed')

      // Zeroized key rejection
      zeroizePairingKeys(keys)
      expect(keys.encryptionKey.every((b) => b === 0)).toBe(true)
      expect(() =>
        encryptDeviceSyncBundle(
          SAMPLE_SYNC_BUNDLE,
          keys.encryptionKey,
          session.sessionId,
        ),
      ).toThrow(/zeroized/i)
    })
  })

  describe('DevicePairingHandshakeMachine 3-step DataChannel flow & key zeroization', () => {
    it('completes the 3-step handshake (responder_hello -> SAS confirm -> sync_bundle -> sync_ack) and zeroizes secrets', () => {
      const nowMs = 1_760_000_000_000
      const { session, qrUri } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-mac-01',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs,
      })

      const initiatorMachine = DevicePairingHandshakeMachine.createInitiator(session)
      expect(initiatorMachine.phase).toBe('awaiting_responder_hello')

      const qrPayload = parseDevicePairingUri(qrUri, { nowMs: nowMs + 1_000 })!
      const responderMachine = DevicePairingHandshakeMachine.createResponder({
        qrPayload,
        responderDeviceId: 'mobile-ios-02',
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
        observedInitiatorSdpDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs: nowMs + 1_000,
      })
      expect(responderMachine.phase).toBe('awaiting_sas_confirmation')

      // Step 1: Responder sends responder_hello over RTCDataChannel
      const helloMsg = responderMachine.createResponderHello()
      const initiatorDerived = initiatorMachine.handleResponderHello(
        helloMsg,
        RESPONDER_DTLS_FP,
        nowMs + 2_000,
      )
      expect(initiatorMachine.phase).toBe('awaiting_sas_confirmation')
      expect(initiatorMachine.sasDigits).toBe(responderMachine.sasDigits)
      expect(initiatorMachine.sasWords).toEqual(responderMachine.sasWords)

      // Step 2: Both user devices confirm matching SAS; initiator sends encrypted sync_bundle
      responderMachine.confirmSasOnResponder(nowMs + 3_000)
      expect(responderMachine.phase).toBe('awaiting_sync_bundle')

      const syncBundleMsg = initiatorMachine.confirmSasAndSendBundle(
        SAMPLE_SYNC_BUNDLE,
        nowMs + 3_500,
      )
      expect(initiatorMachine.phase).toBe('awaiting_sync_ack')

      // Step 3: Responder decrypts sync_bundle, zeroizes keys, and sends sync_ack
      const { bundle, ackMessage } = responderMachine.handleSyncBundle(
        syncBundleMsg,
        nowMs + 4_000,
      )
      expect(bundle).toEqual(SAMPLE_SYNC_BUNDLE)
      expect(responderMachine.phase).toBe('completed')

      // Initiator processes sync_ack, completes, and zeroizes keys
      initiatorMachine.handleSyncAck(ackMessage, nowMs + 4_500)
      expect(initiatorMachine.phase).toBe('completed')
      expect(session.ephemeralPrivKey.every((b) => b === 0)).toBe(true)
      expect(initiatorDerived.encryptionKey.every((b) => b === 0)).toBe(true)
    })

    it('fails closed and zeroizes keys on DTLS SDP fingerprint mismatch or timeout', () => {
      const nowMs = 1_760_000_000_000
      const { session, qrUri } = createDevicePairingSession({
        initiatorDeviceId: 'desktop-mac-01',
        dtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs,
      })
      const qrPayload = parseDevicePairingUri(qrUri, { nowMs })!

      // Responder sees wrong DTLS fingerprint in initiator SDP
      expect(() =>
        DevicePairingHandshakeMachine.createResponder({
          qrPayload,
          responderDeviceId: 'mobile-ios-02',
          responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
          observedInitiatorSdpDtlsFingerprintSha256: MITM_DTLS_FP,
          nowMs,
        }),
      ).toThrow(/DTLS fingerprint mismatch/i)

      // Initiator sees wrong DTLS fingerprint in responder SDP
      const initiatorMachine = DevicePairingHandshakeMachine.createInitiator(session)
      const responderMachine = DevicePairingHandshakeMachine.createResponder({
        qrPayload,
        responderDeviceId: 'mobile-ios-02',
        responderDtlsFingerprintSha256: RESPONDER_DTLS_FP,
        observedInitiatorSdpDtlsFingerprintSha256: INITIATOR_DTLS_FP,
        nowMs,
      })

      expect(() =>
        initiatorMachine.handleResponderHello(
          responderMachine.createResponderHello(),
          MITM_DTLS_FP,
          nowMs + 1_000,
        ),
      ).toThrow(/DTLS fingerprint mismatch/i)
      expect(initiatorMachine.phase).toBe('failed')
      expect(session.ephemeralPrivKey.every((b) => b === 0)).toBe(true)

      // Responder timeout enforcement
      expect(() =>
        responderMachine.confirmSasOnResponder(nowMs + DEFAULT_PAIRING_TTL_MS + 1),
      ).toThrow(/expired/i)
      expect(responderMachine.phase).toBe('expired')
    })
  })
})
