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
  type MailboxNotificationPolicy,
  type NotificationPolicyAuthContext,
} from './notification-policy'

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

  test('reads and writes mailbox notification policy over authenticated HTTP', async () => {
    const auth: NotificationPolicyAuthContext = {
      address: '0x10239e8fbfd030da11df8f452984ebfb894d0dc3',
      publicKeyHex: `02${'11'.repeat(32)}`,
      signDigest: async (digest) => {
        expect(digest).toHaveLength(32)
        return 'aa'.repeat(64)
      },
    }

    const headers = await buildNotificationPolicyAuthHeaders(
      'GET',
      auth,
      1700000000000,
    )
    expect(headers['x-cashweb-auth-pubkey']).toBe(`02${'11'.repeat(32)}`)
    expect(headers['x-cashweb-auth-timestamp']).toBe('1700000000000')
    expect(headers['x-cashweb-auth-signature']).toBe('aa'.repeat(64))

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

    const calls: Array<{ url: string; init?: RequestInit }> = []
    const mockFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
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
    expect(calls[0].url).toBe(
      'https://relay.frank.test/message/monad/mailbox/0x10239e8fbfd030da11df8f452984ebfb894d0dc3/notification-policy',
    )
    expect(calls[0].init?.method).toBe('PUT')

    const fetched = await getMailboxNotificationPolicy(
      'https://relay.frank.test/',
      auth,
      mockFetch,
    )
    expect(fetched).toEqual(storedPolicy)
    expect(calls[1].init?.method).toBe('GET')
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

