import {
  avuToMicros,
  microsToAvu,
  avuThresholdToMinWei,
  blindWakeupToken,
  blindWakeupTokenDomainSeparated,
  createWakeupCapability,
  derivePeerWakeupTokenPreimage,
  derivePeerWakeupCapability,
  computeActiveContactWakeupTokenHashes,
  urlBase64ToUint8Array,
  fetchRelayVapidPublicKey,
  verifyWakeupCapability,
  shouldTriggerBlindWakeup,
  buildMailboxNotificationPolicy,
  buildNotificationPolicyAuthHeaders,
  getMailboxNotificationPolicy,
  putMailboxNotificationPolicy,
  notificationPolicyAuthPreimage,
  parseNotificationPolicyChallenge,
  NOTIFICATION_POLICY_AUTH_DOMAIN,
  type MailboxNotificationPolicy,
  type NotificationPolicyAuthContext,
  type NotificationPolicyChallenge,
} from './notification-policy'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'

describe('notification-policy (#384, #1574)', () => {
  test('converts AVU threshold to micro-AVU and wei', () => {
    expect(avuToMicros(0)).toBe(0)
    expect(avuToMicros(-5)).toBe(0)
    expect(avuToMicros('0.25')).toBe(250_000)
    expect(avuToMicros(1.5)).toBe(1_500_000)
    expect(microsToAvu(250_000)).toBe(0.25)
    expect(avuThresholdToMinWei(0.25, 1_000_000_000_000_000_000n)).toBe(
      '250000000000000000',
    )
    expect(avuThresholdToMinWei(0)).toBe('0')
  })

  test('generates and verifies blinded contact WakeupCapability tokens', () => {
    const cap = createWakeupCapability(
      'trusted-contact-secret-preimage',
      '0x10239e8FbFD030dA11df8F452984eBfb894D0dc3',
      1700000000000,
    )
    expect(cap.preimageHex).toMatch(/^[0-9a-f]{64}$/)
    expect(cap.tokenHashHex).toMatch(/^[0-9a-f]{64}$/)
    expect(cap.tokenHashHex).toBe(blindWakeupToken(cap.preimageHex))
    expect(cap.contactAddress).toBe(
      '0x10239e8fbfd030da11df8f452984ebfb894d0dc3',
    )

    expect(verifyWakeupCapability(cap.preimageHex, [cap.tokenHashHex])).toBe(
      true,
    )
    expect(
      verifyWakeupCapability(`0x${cap.preimageHex}`, [
        `0x${cap.tokenHashHex.toUpperCase()}`,
      ]),
    ).toBe(true)
    expect(
      verifyWakeupCapability('wrong-preimage-token', [cap.tokenHashHex]),
    ).toBe(false)

    const domainHash = blindWakeupTokenDomainSeparated(cap.preimageHex)
    expect(verifyWakeupCapability(cap.preimageHex, [domainHash])).toBe(true)
  })

  test('evaluates shouldTriggerBlindWakeup for paid stamps, under-threshold stamps, and contact bypass', () => {
    const cap = createWakeupCapability('contact-bypass-secret')
    const policy = buildMailboxNotificationPolicy({
      avuThreshold: 0.25,
      minNotificationValueWei: '1000',
      allowContactBypass: true,
      contactWakeupTokens: [cap.tokenHashHex],
    })

    // Unpaid stranger message -> false
    expect(shouldTriggerBlindWakeup(policy, 0n, 0, null)).toBe(false)
    // Sub-threshold stranger message -> false
    expect(shouldTriggerBlindWakeup(policy, 999n, 100_000, null)).toBe(false)
    // Stamp meets wei threshold -> true
    expect(shouldTriggerBlindWakeup(policy, 1000n, 0, null)).toBe(true)
    // Stamp meets AVU threshold -> true
    expect(shouldTriggerBlindWakeup(policy, 0n, 250_000, null)).toBe(true)
    // Contact wakeup token bypasses 0-value stamp -> true
    expect(shouldTriggerBlindWakeup(policy, 0n, 0, cap.preimageHex)).toBe(true)
    // Wrong wakeup token on 0-value stamp -> false
    expect(shouldTriggerBlindWakeup(policy, 0n, 0, 'invalid-token')).toBe(false)

    // When allow_contact_bypass is false, even valid token requires stamp >= threshold
    const strictPolicy: MailboxNotificationPolicy = {
      ...policy,
      allow_contact_bypass: false,
    }
    expect(shouldTriggerBlindWakeup(strictPolicy, 0n, 0, cap.preimageHex)).toBe(
      false,
    )
    expect(
      shouldTriggerBlindWakeup(strictPolicy, 1000n, 0, cap.preimageHex),
    ).toBe(true)
  })

  test('signs the one relay signing string (shared vector with the relay)', () => {
    // The same vector is asserted by the relay's
    // `notification_policy_signing_string_matches_the_typescript_signer`.
    const challenge: NotificationPolicyChallenge = {
      epoch: '01'.repeat(32),
      nonce: '02'.repeat(32),
      expires_at_ms: 1_700_000_060_000,
      token: '03'.repeat(32),
      signing_domain: NOTIFICATION_POLICY_AUTH_DOMAIN,
      network_tag: Buffer.from('MONT').toString('hex'),
    }
    const preimage = notificationPolicyAuthPreimage(
      challenge,
      'PUT',
      '0x10239E8FBFD030DA11DF8F452984EBFB894D0DC3',
      new TextEncoder().encode('{}'),
    )
    expect(Buffer.from(sha256(preimage)).toString('hex')).toBe(
      'f9fe117f1707923d059de7aa48ae6d0a6332391d5df1b113518a206a09ace464',
    )
  })

  test('reads and writes the policy by answering a single-use relay challenge', async () => {
    const privateKey = new Uint8Array(32).fill(0x42)
    const publicKeyHex = Buffer.from(
      secp256k1.getPublicKey(privateKey, true),
    ).toString('hex')
    const address = '0x10239e8fbfd030da11df8f452984ebfb894d0dc3'
    const auth: NotificationPolicyAuthContext = {
      address,
      publicKeyHex,
      signDigest: (digest) => {
        expect(digest).toHaveLength(32)
        return secp256k1.sign(digest, privateKey).toCompactRawBytes()
      },
    }

    const storedPolicy = buildMailboxNotificationPolicy({
      avuThreshold: 0.5,
      allowContactBypass: true,
      pushSubscriptions: [
        {
          endpoint: 'https://push.example.test/sub/1',
          p256dh: 'p256dh-key',
          auth: 'auth-secret',
        },
      ],
      updatedAtMs: 1700000000000,
    })

    // A stub at the fetch seam that answers like the relay: 401 + a fresh challenge, then
    // checks the signature over that challenge and the exact body, once.
    let issued = 0
    const live = new Map<string, NotificationPolicyChallenge>()
    const accepted: Array<{ method: string; headers: Record<string, string> }> =
      []
    const mockFetch = (async (_url: string, init?: RequestInit) => {
      const method = init?.method as 'GET' | 'PUT'
      const headers = (init?.headers ?? {}) as Record<string, string>
      const nonce = headers['x-frank-mailbox-nonce']
      const challenge = nonce ? live.get(nonce) : undefined
      if (!challenge) {
        issued += 1
        const fresh: NotificationPolicyChallenge = {
          epoch: 'ee'.repeat(32),
          nonce: issued.toString(16).padStart(64, '0'),
          expires_at_ms: Date.now() + 60_000,
          token: 'dd'.repeat(32),
          signing_domain: NOTIFICATION_POLICY_AUTH_DOMAIN,
          network_tag: Buffer.from('MONT').toString('hex'),
        }
        live.set(fresh.nonce, fresh)
        return {
          ok: false,
          status: 401,
          json: async () => ({
            error: 'mailbox_auth_required',
            challenge: fresh,
          }),
        } as Response
      }
      live.delete(nonce)
      const digest = sha256(
        notificationPolicyAuthPreimage(
          challenge,
          method,
          address,
          new TextEncoder().encode(String(init?.body ?? '')),
        ),
      )
      const valid =
        headers['x-frank-mailbox-subject'] === publicKeyHex &&
        secp256k1.verify(
          headers['x-frank-mailbox-signature'],
          digest,
          publicKeyHex,
        )
      if (!valid) {
        return { ok: false, status: 401, json: async () => ({}) } as Response
      }
      accepted.push({ method, headers })
      return {
        ok: true,
        status: 200,
        json: async () => storedPolicy,
      } as Response
    }) as unknown as typeof fetch

    const updated = await putMailboxNotificationPolicy(
      'https://relay.frank.test/',
      storedPolicy,
      auth,
      mockFetch,
    )
    expect(updated).toEqual(storedPolicy)
    const fetched = await getMailboxNotificationPolicy(
      'https://relay.frank.test/',
      auth,
      mockFetch,
    )
    expect(fetched).toEqual(storedPolicy)
    expect(accepted.map((request) => request.method)).toEqual(['PUT', 'GET'])
    // Each request answered its own challenge; no timestamp-only headers remain.
    expect(accepted[0].headers['x-frank-mailbox-nonce']).not.toBe(
      accepted[1].headers['x-frank-mailbox-nonce'],
    )
    for (const { headers } of accepted) {
      expect(
        Object.keys(headers).some((name) => name.startsWith('x-cashweb-auth')),
      ).toBe(false)
    }

    // The signature covers the body: the same headers over another body do not verify.
    const challenge = parseNotificationPolicyChallenge({
      challenge: {
        epoch: 'ee'.repeat(32),
        nonce: 'ab'.repeat(32),
        expires_at_ms: 1,
        token: 'dd'.repeat(32),
        signing_domain: NOTIFICATION_POLICY_AUTH_DOMAIN,
        network_tag: '4d4f4e54',
      },
    })!
    const body = new TextEncoder().encode(JSON.stringify(storedPolicy))
    const headers = await buildNotificationPolicyAuthHeaders(
      'PUT',
      auth,
      challenge,
      body,
    )
    const tampered = sha256(
      notificationPolicyAuthPreimage(
        challenge,
        'PUT',
        address,
        new TextEncoder().encode('{}'),
      ),
    )
    expect(
      secp256k1.verify(
        headers['x-frank-mailbox-signature'],
        tampered,
        publicKeyHex,
      ),
    ).toBe(false)
  })

  test('refuses a challenge under another signing domain', () => {
    expect(() =>
      parseNotificationPolicyChallenge({
        challenge: {
          epoch: 'ee'.repeat(32),
          nonce: 'ab'.repeat(32),
          expires_at_ms: 1,
          token: 'dd'.repeat(32),
          signing_domain: 'frank-notification-policy-auth-v1',
          network_tag: '4d4f4e54',
        },
      }),
    ).toThrow('signing domain')
  })

  test('derives deterministic per-peer wakeup tokens and revokes muted/deleted contacts', () => {
    const walletSecret = '11'.repeat(32)
    const aliceAddr = '0x1111111111111111111111111111111111111111'
    const bobAddr = '0x2222222222222222222222222222222222222222'

    const alicePreimage = derivePeerWakeupTokenPreimage(walletSecret, aliceAddr)
    const bobPreimage = derivePeerWakeupTokenPreimage(walletSecret, bobAddr)
    expect(alicePreimage).toMatch(/^[0-9a-f]{64}$/)
    expect(bobPreimage).toMatch(/^[0-9a-f]{64}$/)
    expect(alicePreimage).not.toBe(bobPreimage)

    const aliceCap = derivePeerWakeupCapability(walletSecret, aliceAddr)
    expect(aliceCap.preimageHex).toBe(alicePreimage)
    expect(aliceCap.tokenHashHex).toBe(blindWakeupToken(alicePreimage))

    // Both Alice and Bob unmuted -> both hashes included
    const bothActive = computeActiveContactWakeupTokenHashes(
      [
        { address: aliceAddr, notify: true },
        { address: bobAddr, notify: true },
      ],
      walletSecret,
    )
    expect(bothActive).toHaveLength(2)
    expect(verifyWakeupCapability(alicePreimage, bothActive)).toBe(true)
    expect(verifyWakeupCapability(bobPreimage, bothActive)).toBe(true)

    // Muting Alice (`notify: false`) immediately revokes Alice's token hash while keeping Bob's
    const aliceMuted = computeActiveContactWakeupTokenHashes(
      [
        { address: aliceAddr, notify: false },
        { address: bobAddr, notify: true },
      ],
      walletSecret,
    )
    expect(aliceMuted).toHaveLength(1)
    expect(verifyWakeupCapability(alicePreimage, aliceMuted)).toBe(false)
    expect(verifyWakeupCapability(bobPreimage, aliceMuted)).toBe(true)
  })

  test('decodes VAPID base64url public keys and fetches from /push/vapid-public-key', async () => {
    const samplePub =
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
    const bytes = urlBase64ToUint8Array(samplePub)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(65)
    expect(bytes[0]).toBe(0x04)

    const mockFetch = (async (url: string) => {
      expect(url).toBe('https://relay.frank.test/push/vapid-public-key')
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ vapid_public_key: samplePub }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const key = await fetchRelayVapidPublicKey(
      'https://relay.frank.test/',
      mockFetch,
    )
    expect(key).toBe(samplePub)
  })
})
