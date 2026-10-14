import { createPinia, setActivePinia } from 'pinia'
import {
  acknowledgeServiceWorkerWakeupHandled,
  ensureBrowserPushSubscription,
  extractBlindPushSubscription,
  setCachedBlindPushSubscription,
  syncRelayNotificationPolicy,
} from './webpush-sync'
import {
  derivePeerWakeupCapability,
  type NotificationPolicyAuthContext,
} from '@frank/cashweb/relay/notification-policy'
import { getOutboundWakeupTokenForRecipient } from '@frank/cashweb/relay/canonical-dm-transport'
import { decodeCanonical } from '@frank/codec'
import { contactCardCodec } from '@frank/wallet/message-item-plugins/contact-card/codec'
import { useContactStore } from '../stores/contacts'

const ALICE_SECRET =
  '0x1111111111111111111111111111111111111111111111111111111111111111'
const ALICE_ADDR = '0x1111111111111111111111111111111111111111'
const BOB_ADDR = '0x2222222222222222222222222222222222222222'
const SAMPLE_VAPID_PUBKEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'

const mockAuthContext: NotificationPolicyAuthContext = {
  address: ALICE_ADDR,
  publicKeyHex: `02${'11'.repeat(32)}`,
  signDigest: () => new Uint8Array(64).fill(0x5a),
}

describe('webpush-sync end-to-end subscription, capability exchange & revocation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setCachedBlindPushSubscription(null)
    ;(globalThis as Record<string, unknown>).Notification = {
      permission: 'granted',
    }
  })

  afterEach(() => {
    setCachedBlindPushSubscription(null)
  })

  it('extracts BlindPushSubscription from toJSON() and getKey() ArrayBuffers', () => {
    const fromJson = extractBlindPushSubscription({
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
        keys: {
          p256dh: 'p256dh-key-1',
          auth: 'auth-key-1',
        },
      }),
    })
    expect(fromJson).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
      p256dh: 'p256dh-key-1',
      auth: 'auth-key-1',
    })

    const p256dhBytes = new Uint8Array([1, 2, 3, 4])
    const authBytes = new Uint8Array([5, 6, 7, 8])
    const fromGetKey = extractBlindPushSubscription({
      endpoint: 'https://web.push.apple.com/sub-2',
      getKey: (name: 'p256dh' | 'auth') =>
        name === 'p256dh' ? p256dhBytes.buffer : authBytes.buffer,
    })
    expect(fromGetKey).toEqual({
      endpoint: 'https://web.push.apple.com/sub-2',
      p256dh: 'AQIDBA',
      auth: 'BQYHCA',
    })
  })

  it('subscribes via PushManager using relay /push/vapid-public-key', async () => {
    const subscribeCalls: Array<{
      userVisibleOnly: boolean
      applicationServerKey: Uint8Array
    }> = []

    const fakeReg = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async (opts: {
          userVisibleOnly: boolean
          applicationServerKey: Uint8Array
        }) => {
          subscribeCalls.push(opts)
          return {
            endpoint: 'https://fcm.googleapis.com/fcm/send/live-sub',
            keys: {
              p256dh: 'live-p256dh',
              auth: 'live-auth',
            },
          }
        },
      },
    }

    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toBe('https://relay.example/push/vapid-public-key')
      return new Response(
        JSON.stringify({ vapid_public_key: SAMPLE_VAPID_PUBKEY }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const sub = await ensureBrowserPushSubscription({
      relayBaseUrl: 'https://relay.example',
      fetchImpl: fetchMock,
      serviceWorkerRegistration: fakeReg,
    })

    expect(sub).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/live-sub',
      p256dh: 'live-p256dh',
      auth: 'live-auth',
    })
    expect(subscribeCalls).toHaveLength(1)
    expect(subscribeCalls[0].userVisibleOnly).toBe(true)
    expect(subscribeCalls[0].applicationServerKey).toHaveLength(65)
    expect(subscribeCalls[0].applicationServerKey[0]).toBe(0x04)
  })

  it('syncs contact wakeup token hashes to relay and revokes them on mute or delete', async () => {
    const contacts = useContactStore()
    contacts.addContact({
      address: BOB_ADDR,
      contact: {
        notify: true,
        profile: {
          name: 'Bob',
          bio: '',
          avatar: '',
          pubKey: null,
        },
      },
    })

    const putBodies: Array<Record<string, unknown>> = []
    const fetchMock = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const parsed = JSON.parse(String(init?.body ?? '{}'))
      putBodies.push(parsed)
      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const bobCap = derivePeerWakeupCapability(ALICE_SECRET, BOB_ADDR)

    // 1. Active unmuted contact -> tokenHashHex included in policy
    const activePolicy = await syncRelayNotificationPolicy({
      relayBaseUrl: 'https://relay.example',
      authContext: mockAuthContext,
      walletSecretHex: ALICE_SECRET,
      avuThreshold: 0.05,
      allowContactBypass: true,
      pushSubscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
        p256dh: 'p256dh-1',
        auth: 'auth-1',
      },
      fetchImpl: fetchMock,
    })
    expect(activePolicy?.contact_wakeup_tokens).toEqual([bobCap.tokenHashHex])
    expect(activePolicy?.push_subscriptions).toHaveLength(1)

    // 2. Mute Bob -> tokenHashHex immediately removed from policy
    contacts.setNotify({ address: BOB_ADDR, value: false })
    const mutedPolicy = await syncRelayNotificationPolicy({
      relayBaseUrl: 'https://relay.example',
      authContext: mockAuthContext,
      walletSecretHex: ALICE_SECRET,
      avuThreshold: 0.05,
      allowContactBypass: true,
      pushSubscription: null,
      subscribeIfGranted: false,
      fetchImpl: fetchMock,
    })
    expect(mutedPolicy?.contact_wakeup_tokens).toEqual([])
  })

  it('roundtrips wakeupTokenHex in ContactCardItem codec and wires outbound wakeup token provider', () => {
    const cap = derivePeerWakeupCapability(ALICE_SECRET, BOB_ADDR)
    const item = {
      type: 'contact-card' as const,
      uid: 'frank-wakeup-capability',
      fullName: 'Wakeup Capability',
      frankAddress: ALICE_ADDR,
      wakeupTokenHex: cap.preimageHex,
    }
    const encoded = contactCardCodec.encode(item)
    const decoded = contactCardCodec.decode(encoded, {
      budget: {
        decodeCbor: (bytes: Uint8Array) => decodeCanonical(bytes),
      },
    } as any)
    expect(decoded.wakeupTokenHex).toBe(cap.preimageHex)
    expect(decoded.uid).toBe('frank-wakeup-capability')

    const contacts = useContactStore()
    contacts.setOutboundWakeupToken({
      address: BOB_ADDR,
      token: cap.preimageHex,
    })
    expect(contacts.getOutboundWakeupToken(BOB_ADDR)).toBe(cap.preimageHex)
    expect(getOutboundWakeupTokenForRecipient(BOB_ADDR)).toBe(cap.preimageHex)
  })

  it('posts FRANK_BLIND_WAKEUP_HANDLED to active ServiceWorker controller', () => {
    const posted: unknown[] = []
    const origNav = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          controller: {
            postMessage: (msg: unknown) => posted.push(msg),
          },
        },
      },
    })
    try {
      acknowledgeServiceWorkerWakeupHandled()
      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatchObject({
        type: 'FRANK_BLIND_WAKEUP_HANDLED',
      })
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: origNav,
      })
    }
  })
})
