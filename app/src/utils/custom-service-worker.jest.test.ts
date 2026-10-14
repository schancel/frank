import {
  BLIND_WAKEUP_MESSAGE_TYPE,
  BLIND_WAKEUP_NOTIFICATION_BODY,
  BLIND_WAKEUP_NOTIFICATION_TAG,
  BLIND_WAKEUP_NOTIFICATION_TITLE,
  handleBlindPushWakeup,
  parseBlindPushPayload,
  type SwScopeLike,
} from '../../src-pwa/custom-service-worker'

describe('custom-service-worker blind WebPush wakeup (#384, #1574)', () => {
  it('accepts content-free {"type":"sync"} or empty push payloads and rejects unknown shapes', () => {
    expect(parseBlindPushPayload('{"type":"sync"}')).toEqual({ type: 'sync' })
    expect(parseBlindPushPayload('{"type":"sync","sender":"0x123"}')).toEqual({
      type: 'sync',
    })
    expect(parseBlindPushPayload('')).toEqual({ type: 'sync' })
    expect(parseBlindPushPayload(null)).toEqual({ type: 'sync' })
    expect(parseBlindPushPayload('{"type":"plaintext"}')).toBeNull()
    expect(parseBlindPushPayload('not-json')).toBeNull()
  })

  it('wakes visible client windows via postMessage without showing a redundant OS notification', async () => {
    const posted: unknown[] = []
    const showNotification = jest.fn(async () => undefined)
    const sw: SwScopeLike = {
      clients: {
        matchAll: async () => [
          {
            focused: true,
            visibilityState: 'visible',
            postMessage: msg => posted.push(msg),
          },
        ],
      },
      registration: {
        showNotification,
      },
    }

    const result = await handleBlindPushWakeup(
      sw,
      '{"type":"sync"}',
      1700000000000,
    )
    expect(result).toEqual({ syncedClients: 1, showedNotification: false })
    expect(posted).toEqual([
      {
        type: BLIND_WAKEUP_MESSAGE_TYPE,
        payload: { type: 'sync' },
        timestampMs: 1700000000000,
      },
    ])
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('shows a privacy-preserving generic notification when no client window is focused or visible', async () => {
    const showNotification = jest.fn(async () => undefined)
    const sw: SwScopeLike = {
      clients: {
        matchAll: async () => [],
      },
      registration: {
        showNotification,
      },
    }

    const result = await handleBlindPushWakeup(
      sw,
      '{"type":"sync"}',
      1700000000000,
    )
    expect(result).toEqual({ syncedClients: 0, showedNotification: true })
    expect(showNotification).toHaveBeenCalledWith(
      BLIND_WAKEUP_NOTIFICATION_TITLE,
      {
        body: BLIND_WAKEUP_NOTIFICATION_BODY,
        tag: BLIND_WAKEUP_NOTIFICATION_TAG,
        renotify: false,
        data: { type: 'sync', timestampMs: 1700000000000 },
      },
    )
  })

  it('suppresses the fallback generic notification when a backgrounded client handles and decrypts the wakeup within the grace window', async () => {
    const showNotification = jest.fn(async () => undefined)
    let clientAcked = false
    const sw: SwScopeLike = {
      clients: {
        matchAll: async () => [
          {
            focused: false,
            visibilityState: 'hidden',
            postMessage: () => {
              clientAcked = true
            },
          },
        ],
      },
      registration: {
        showNotification,
      },
    }

    const result = await handleBlindPushWakeup(
      sw,
      '{"type":"sync"}',
      1700000000000,
      {
        dedupGraceMs: 10,
        wasHandledByClient: () => clientAcked,
      },
    )
    expect(result).toEqual({ syncedClients: 1, showedNotification: false })
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('shows the notification when the browser window is unfocused in the background (focused: false, visibilityState: visible) and does not acknowledge within the grace window', async () => {
    const posted: unknown[] = []
    const showNotification = jest.fn(async () => undefined)
    const sw: SwScopeLike = {
      clients: {
        matchAll: async () => [
          {
            focused: false,
            visibilityState: 'visible',
            postMessage: msg => posted.push(msg),
          },
        ],
      },
      registration: {
        showNotification,
      },
    }

    const result = await handleBlindPushWakeup(
      sw,
      '{"type":"sync"}',
      1700000000000,
      {
        dedupGraceMs: 10,
        wasHandledByClient: () => false,
      },
    )
    expect(result).toEqual({ syncedClients: 1, showedNotification: true })
    expect(posted).toHaveLength(1)
    expect(showNotification).toHaveBeenCalledWith(
      BLIND_WAKEUP_NOTIFICATION_TITLE,
      {
        body: BLIND_WAKEUP_NOTIFICATION_BODY,
        tag: BLIND_WAKEUP_NOTIFICATION_TAG,
        renotify: false,
        data: { type: 'sync', timestampMs: 1700000000000 },
      },
    )
  })
})
