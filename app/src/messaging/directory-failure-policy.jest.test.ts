import {
  openDirectory,
  OpenDirectoryError,
} from '@frank/cashweb/relay/open-directory'
import { testAccount } from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import { recordWalletFailure } from '@frank/wallet/wallet-failure'
import { isNoResponseError } from '../stores/chats-self-notes'
import { decideOutgoingRetry } from './outgoing-retry-policy'

const context = {
  ownDigest: undefined,
  sendAttempt: 1,
  maxSendAttempts: 3,
  allCallsUnattempted: true,
  isCurrent: () => true,
}
const self = testAccount(22)
const peer = testAccount(23)
const media = 'application/vnd.frank.cbor'

it.each([
  ['network', true],
  ['deadline', true],
  ['stream-read', true],
  ['429', true],
  ['502', true],
  ['503', true],
  ['504', true],
  ['401', false],
  ['403', false],
  ['wrong-content', false],
  ['wrong-evidence', false],
  ['redirect', false],
  ['overflow', false],
  ['empty-body', false],
  ['invalid-reader', false],
  ['invalid-entry', false],
] as const)(
  'classifies actual directory %s response without broad unreachable retry',
  async (mode, retry) => {
    if (mode === 'deadline')
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    const fetch = jest.fn(async (url: string) => {
      if (mode === 'network') throw new TypeError('fetch failed')
      if (mode === 'deadline') return new Promise<Response>(() => undefined)
      const status = /^\d+$/.test(mode) ? Number(mode) : 200
      const response = new Response(
        mode === 'empty-body'
          ? null
          : mode === 'stream-read'
          ? new ReadableStream({
              start(controller) {
                controller.error(new Error('connection lost while reading'))
              },
            })
          : new Uint8Array(mode === 'overflow' ? 262145 : 1),
        {
          status,
          headers: {
            'content-type': mode === 'wrong-content' ? 'text/html' : media,
            'x-frank-directory-evidence':
              mode === 'wrong-evidence' ? 'historical' : 'fresh-current',
          },
        },
      )
      if (mode === 'invalid-reader')
        Object.defineProperty(response, 'body', {
          value: {
            getReader() {
              throw new Error('invalid reader')
            },
          },
        })
      Object.defineProperty(response, 'url', {
        value: mode === 'redirect' ? url + '/elsewhere' : url,
      })
      return response
    })
    const directory = openDirectory({
      network: 'monad-testnet',
      relayBaseUrl: 'https://relay.invalid',
      nowNs: () => 1800000000000000000n,
      fetch,
      self: {
        subject: self.subject,
        signRevisionZero: () => {
          throw new Error('must not sign')
        },
        signNextRevision: () => {
          throw new Error('must not sign')
        },
      },
      openStore: async () => {
        throw new Error('must not admit')
      },
      discardUnenrolled: async () => 'absent',
      checkpoints: { load: () => null, save: () => undefined },
      pins: { load: () => null, save: () => undefined },
    })
    try {
      const attempt = directory
        .peerCurrent({ address: peer.address })
        .catch((error: unknown) => error)
      if (mode === 'deadline') {
        while (fetch.mock.calls.length === 0) await Promise.resolve()
        await jest.advanceTimersByTimeAsync(30000)
      }
      const error = await attempt
      expect(error).toBeInstanceOf(OpenDirectoryError)
      expect((error as OpenDirectoryError).code).toBe(
        mode === 'invalid-entry' ? 'invalid' : 'unreachable',
      )
      expect((error as OpenDirectoryError).retry).toBe(
        retry
          ? 'transient'
          : mode === 'invalid-entry'
          ? undefined
          : 'forbidden',
      )
      expect(isNoResponseError(error)).toBe(retry)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(decideOutgoingRetry(error, context)).toEqual(
        retry ? { kind: 'retry-transport', delayMs: 500 } : { kind: 'fail' },
      )
      recordWalletFailure(error, {
        observationUnavailable: true,
        transientTransport: true,
      })
      expect(decideOutgoingRetry(error, context)).toEqual(
        retry ? { kind: 'retry-transport', delayMs: 500 } : { kind: 'fail' },
      )
    } finally {
      await directory.close()
      jest.useRealTimers()
    }
  },
)
