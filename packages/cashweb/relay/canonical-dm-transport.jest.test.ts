import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cborMap,
  encodeCanonical,
  encodeFrame,
  fromHex,
  validateFrame,
  defaultContext,
} from '@frank/codec'
import {
  CANONICAL_DM_MAX_BYTES,
  CanonicalTransportError,
  decodeCanonicalAcceptedStatus,
  decodeCanonicalTransactions,
  equalCanonicalRequests,
  freezeCanonicalRequest,
  parseCanonicalJSON,
  parseCanonicalMultipart,
  readCanonicalResponse,
  restoreCanonicalRequest,
  submitCanonicalRequest,
  type CanonicalExactParts,
  type CanonicalFetch,
  type CanonicalStreamResponse,
} from './canonical-dm-transport'

/** Offline EIP1559 signed chain10143 nonce0 value1 POND/v1/T4 transaction, private key1.
 * No chain fixture or receipt authority: retained identity/framing is what these tests verify. */
const RAW =
  '02f88982279f80010282c350942adf2cb0d2a8f42fd83e2c32912654a8ac76a45501a5504f4e44019d15a0c9d45c50955cc400ff9e8f42bf59caa0514058abad8fe9a678afb0f057c001a02d18d2d071778208389595d3110fe779a78cef3d25b7ebdd163df663167466f0a01e371c5d156bb5e4009df9006e84035e8e83c1200196da0cd3441a85e6d0a468'
const HASH = '813129d69040c1f275a87a80d85d214d02f3b94649a584999ef662c3d39199f4'
export function canonicalTransportFixture(): CanonicalExactParts {
  const wire = JSON.parse(
    readFileSync(
      join(__dirname, '../../../docs/protocol/cbor/vectors/dm-runtime.json'),
      'utf8',
    ),
  ).canonical_facade_final_http_case.wire
  const parsed = validateFrame(fromHex(wire.delivery), defaultContext())
  if (parsed.kind !== 'parsed' || !(parsed.payload instanceof Map))
    throw new Error('Fixture frame')
  const value = new Uint8Array(32)
  value[31] = 1
  const payload = new Map(parsed.payload)
  payload.set(4n, [
    cborMap([
      [0, 0],
      [1, fromHex(HASH)],
      [2, value],
      [3, fromHex(wire.destination)],
      [4, fromHex(wire.t4)],
    ]),
  ])
  return {
    delivery: encodeFrame(
      { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
      payload,
    ),
    context: fromHex(wire.context),
    transactions: [fromHex(RAW)],
  }
}
const text = (s: string) => new TextEncoder().encode(s)
export function canonicalTestResponse(
  url: string,
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
  chunkSize = 31,
): CanonicalStreamResponse {
  let at = 0
  return {
    url,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          at >= bytes.length
            ? { done: true }
            : { done: false, value: bytes.slice(at, (at += chunkSize)) },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  }
}
const request = () =>
  freezeCanonicalRequest(canonicalTransportFixture(), 'frank-fixture-777')
const statusBytes = (
  r: ReturnType<typeof request>,
  overrides: Record<string, unknown> = {},
) =>
  text(
    JSON.stringify({
      version: 1,
      phase: 'retained',
      identity: r.identity,
      ...overrides,
    }),
  )

describe('canonical exact request', () => {
  test('copy owns complete body and all parts across mutation and reopen', () => {
    const parts = canonicalTransportFixture(),
      frozen = freezeCanonicalRequest(parts, 'frank-fixture-777')
    const body = frozen.body,
      member = frozen.parts.transactions[0]
    body.fill(0)
    member.fill(0)
    parts.delivery.fill(0)
    parts.context.fill(0)
    parts.transactions[0].fill(0)
    const restored = restoreCanonicalRequest({
      body: frozen.body,
      contentType: frozen.contentType,
    })
    expect(equalCanonicalRequests(restored, frozen)).toBe(true)
    expect(restored.identity.transaction_hashes).toEqual(['0x' + HASH])
    expect(Buffer.from(restored.body).toString()).toContain(
      'Content-Disposition: form-data; name="delivery"\r\nContent-Type: application/vnd.frank.cbor\r\n',
    )
  })
  test('full comparator detects parts mismatch despite identical body/descriptor', () => {
    const frozen = request(),
      parts = frozen.parts
    parts.transactions[0][0] ^= 1
    expect(equalCanonicalRequests(frozen, { ...frozen, parts })).toBe(false)
    expect(
      equalCanonicalRequests(
        frozen,
        freezeCanonicalRequest(canonicalTransportFixture(), 'other-boundary'),
      ),
    ).toBe(false)
  })
  test('same exact frozen body is explicitly sent to two installed relays', async () => {
    const frozen = request(),
      seen: Uint8Array[] = []
    const fetch: CanonicalFetch = async (url, input) => {
      expect(input.redirect).toBe('error')
      expect(input.credentials).toBe('omit')
      expect(input.headers['Content-Type']).toBe(frozen.contentType)
      seen.push(input.body!)
      return canonicalTestResponse(url, 202, statusBytes(frozen), {
        'content-type': 'application/json',
      })
    }
    for (const installedRelayOrigin of [
      'https://one.example',
      'https://two.example',
    ])
      expect(
        (
          await submitCanonicalRequest({
            installedRelayOrigin,
            request: frozen,
            fetch,
          })
        ).phase,
      ).toBe('retained')
    expect(seen).toEqual([frozen.body, frozen.body])
  })
  test('changed raw member and context are rejected before network', async () => {
    const parts = canonicalTransportFixture()
    parts.transactions[0][4] ^= 1
    expect(() => freezeCanonicalRequest(parts)).toThrow(/order\/hash/)
    const frozen = request(),
      altered = frozen.parts
    altered.context[10] ^= 1
    const fetch = jest.fn()
    await expect(
      submitCanonicalRequest({
        installedRelayOrigin: 'https://one.example',
        request: { ...frozen, parts: altered },
        fetch,
      }),
    ).rejects.toThrow(/descriptor/)
    expect(fetch).not.toHaveBeenCalled()
  })
  test.each(['preamble', 'trailing', 'duplicate'])(
    'restore rejects %s multipart bytes',
    kind => {
      const frozen = request(),
        body = frozen.body
      const changed =
        kind === 'preamble'
          ? Buffer.concat([text('x'), body])
          : kind === 'trailing'
          ? Buffer.concat([body, text('x')])
          : text(
              Buffer.from(body)
                .toString()
                .replace('name="context"', 'name="delivery"'),
            )
      expect(() =>
        restoreCanonicalRequest({
          body: changed,
          contentType: frozen.contentType,
        }),
      ).toThrow()
    },
  )
  test('minimal raw array limits are checked before raw copies', () => {
    for (const bytes of [
      new Uint8Array([0x98, 65]),
      new Uint8Array([0x81, 0x5a, 0, 2, 0, 1]),
      new Uint8Array([0x81, 0x58, 1, 0]),
      new Uint8Array([0x81, 0x41, 0, 0]),
    ])
      expect(() => decodeCanonicalTransactions(bytes)).toThrow()
    expect(() =>
      restoreCanonicalRequest({
        body: new Uint8Array(CANONICAL_DM_MAX_BYTES + 1),
        contentType: request().contentType,
      }),
    ).toThrow(/limit/)
  })
  test('oversized context rejects before any ownership copy of body or context', () => {
    const delivery = canonicalTransportFixture().delivery
    const largeContext = new Uint8Array(7 * 1024 * 1024)
    const rawArray = encodeCanonical(canonicalTransportFixture().transactions)
    const body = new Uint8Array(
      Buffer.concat([
        text(
          '--bounded\r\nContent-Disposition: form-data; name="delivery"\r\nContent-Type: application/vnd.frank.cbor\r\n\r\n',
        ),
        delivery,
        text(
          '\r\n--bounded\r\nContent-Disposition: form-data; name="context"\r\nContent-Type: application/cbor\r\n\r\n',
        ),
        largeContext,
        text(
          '\r\n--bounded\r\nContent-Disposition: form-data; name="transactions"\r\nContent-Type: application/cbor\r\n\r\n',
        ),
        rawArray,
        text('\r\n--bounded--\r\n'),
      ]),
    )
    const original = Uint8Array.from
    let largeCopies = 0
    const spy = jest.spyOn(Uint8Array, 'from').mockImplementation(((
      source: ArrayLike<number>,
    ) => {
      if (source.length > 4096) largeCopies++
      return original.call(Uint8Array, source)
    }) as typeof Uint8Array.from)
    try {
      expect(() =>
        restoreCanonicalRequest({
          body,
          contentType: 'multipart/form-data; boundary=bounded',
        }),
      ).toThrow(/Canonical part limits/)
      expect(largeCopies).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
  test('empty exact closed multipart is allowed, extras and oversized headers fail', () => {
    expect(
      parseCanonicalMultipart(
        text('--page--\r\n'),
        'multipart/mixed; boundary=page',
        'multipart/mixed',
        100,
      ),
    ).toEqual([])
    expect(() =>
      parseCanonicalMultipart(
        text('--page\r\n' + 'a'.repeat(4097) + '\r\n\r\nx\r\n--page--\r\n'),
        'multipart/mixed; boundary=page',
        'multipart/mixed',
        100,
      ),
    ).toThrow(/header limit/)
  })
})
describe('canonical acceptance stays uncertain unless exact', () => {
  test.each([
    [200, { phase: 'retained' }],
    [202, { phase: 'delivered', mailbox_committed_at_ms: 1 }],
    [200, { phase: 'dead', reason: 'new-authority' }],
    [200, { phase: 'delivered', mailbox_committed_at_ms: -1 }],
    [202, { extra: 1 }],
    [409, {}],
    [503, {}],
  ])('rejects mismatched status/phase %s %j', (status, overrides) => {
    const frozen = request()
    expect(() =>
      decodeCanonicalAcceptedStatus(
        status,
        'application/json',
        statusBytes(frozen, overrides),
        frozen,
      ),
    ).toThrow(CanonicalTransportError)
  })
  test('strict complete echoes and duplicate escaped keys', () => {
    const frozen = request(),
      identity = { ...frozen.identity, recipient_t1: '00'.repeat(32) }
    expect(() =>
      decodeCanonicalAcceptedStatus(
        202,
        'application/json',
        statusBytes(frozen, { identity }),
        frozen,
      ),
    ).toThrow(/Unmatched/)
    expect(() =>
      parseCanonicalJSON(text('{"version":1,"\\u0076ersion":1}')),
    ).toThrow(/Duplicate/)
    expect(() =>
      parseCanonicalJSON(text('{"timestamp":9007199254740992}')),
    ).toThrow(/Unsafe/)
    expect(
      decodeCanonicalAcceptedStatus(
        200,
        'application/json',
        statusBytes(frozen, { phase: 'dead', reason: 'expired' }),
        frozen,
      ).phase,
    ).toBe('dead')
    expect(
      decodeCanonicalAcceptedStatus(
        200,
        'application/json',
        statusBytes(frozen, {
          phase: 'delivered',
          mailbox_committed_at_ms: 42,
        }),
        frozen,
      ).phase,
    ).toBe('delivered')
  })
  test('redirect and network loss remain uncertain with no automatic PUT retry', async () => {
    const frozen = request(),
      fetch = jest.fn(async () => {
        throw new Error('lost')
      })
    await expect(
      submitCanonicalRequest({
        installedRelayOrigin: 'https://one.example',
        request: frozen,
        fetch,
      }),
    ).rejects.toMatchObject({ disposition: 'uncertain' })
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(
      submitCanonicalRequest({
        installedRelayOrigin: 'https://one.example',
        request: frozen,
        fetch: async () =>
          canonicalTestResponse(
            'https://other.example/message/monad/cbor',
            202,
            statusBytes(frozen),
          ),
      }),
    ).rejects.toMatchObject({ disposition: 'uncertain' })
  })
})
describe('bounded streamed responses', () => {
  test('actual byte cap applies without Content-Length and reader is cancelled', async () => {
    const response = canonicalTestResponse(
        'https://one.example',
        200,
        new Uint8Array(11),
        {},
        3,
      ),
      reader = response.body!.getReader()
    const cancel = jest.fn(reader.cancel)
    const wrapped = {
      ...response,
      body: { getReader: () => ({ ...reader, cancel }) },
    }
    await expect(
      readCanonicalResponse(wrapped, 10, new AbortController().signal),
    ).rejects.toThrow(/byte limit/)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  test('declared limit, empty-chunk floods and never resolving read are bounded', async () => {
    await expect(
      readCanonicalResponse(
        canonicalTestResponse('', 200, new Uint8Array(), {
          'content-length': '11',
        }),
        10,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Declared/)
    const reader = {
      read: async () => ({ done: false, value: new Uint8Array() }),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    }
    await expect(
      readCanonicalResponse(
        {
          status: 200,
          url: '',
          headers: { get: () => null },
          body: { getReader: () => reader },
        },
        10,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/chunk limit/)
    const controller = new AbortController()
    const pending = readCanonicalResponse(
      {
        status: 200,
        url: '',
        headers: { get: () => null },
        body: {
          getReader: () => ({
            ...reader,
            read: () => new Promise(() => undefined),
          }),
        },
      },
      10,
      controller.signal,
    )
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
  })
  test('preaborted submission does not invoke fetch', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = jest.fn()
    await expect(
      submitCanonicalRequest({
        installedRelayOrigin: 'https://one.example',
        request: request(),
        fetch,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ disposition: 'uncertain' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
