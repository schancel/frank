import { FetchRequest } from 'ethers'
import { makeRelayGetUrl, MonadJsonRpcProvider } from './evm-provider'
import { describeWalletFailure, recordWalletFailure } from './wallet-failure'

const bearer = 'synthetic-capability-that-must-not-escape'
const url = `https://relay.invalid/chain-rpc/cap/${bearer}/rpc`

async function publicRejection(response: () => Response | Promise<Response>, sanitized: boolean) {
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
  const connection = new FetchRequest(url)
  connection.retryFunc = async () => false
  connection.getUrlFunc = makeRelayGetUrl(4, sanitized)!
  const provider = new MonadJsonRpcProvider(connection, 10143, { batchStallTime: 0 })
  try {
    let error: unknown
    let rejected = false
    try { await provider.send('eth_blockNumber', []) } catch (caught) { error = caught; rejected = true }
    expect(rejected).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    return error
  } finally {
    provider.destroy()
    fetch.mockRestore()
  }
}

describe.each([false, true])('public provider bounded response rejection (sanitized=%s)', sanitized => {
  it.each(['declared-size', 'streamed-size', 'missing-stream'] as const)(
    '%s remains nontransient after observation, without exposing bearer details', async kind => {
      const error = await publicRejection(() => {
        if (kind === 'declared-size')
          return new Response('ok', { headers: { 'content-length': '5' } })
        if (kind === 'streamed-size') return new Response(new Uint8Array(5))
        return new Response(null)
      }, sanitized)
      expect(describeWalletFailure(error)).toMatchObject({
        retry: 'forbidden', retryVetoes: ['nontransient-transport'],
      })
      recordWalletFailure(error, { observationUnavailable: true, transientTransport: true })
      expect(describeWalletFailure(error).retry).toBe('forbidden')
      expect(describeWalletFailure(error).cause).toBe(error)
      expect(String(error)).not.toContain(bearer)
      expect(JSON.stringify(error)).not.toContain(bearer)
      if (sanitized) {
        expect(String(error)).toContain('relay RPC transport failed')
        expect(String(error)).not.toMatch(/too large|streaming unavailable/)
        expect((error as { cause?: unknown }).cause).toBeUndefined()
      }
    },
  )
})

it('keeps genuine sanitized fetch failure transient without retaining the raw bearer-bearing cause', async () => {
  const original = new TypeError(`fetch failed at ${url}`)
  const error = await publicRejection(() => { throw original }, true)
  expect(error).not.toBe(original) // Existing transport sanitization is retained.
  expect(describeWalletFailure(error).retry).toBe('transient')
  expect(describeWalletFailure(error).cause).toBe(error)
  expect(String(error)).not.toContain(bearer)
  expect((error as { cause?: unknown }).cause).toBeUndefined()
})

it('keeps a genuine sanitized HTTP 429 transient with one request', async () => {
  const error = await publicRejection(() => new Response('{}', { status: 429 }), true)
  expect(describeWalletFailure(error)).toMatchObject({ retry: 'transient', retryVetoes: [] })
})

describe.each([false, true])('public provider overflow cleanup rejection (sanitized=%s)', sanitized => {
  it.each(['object', 'primitive'] as const)('retains %s rejection semantics and known refusal', async kind => {
    const original = kind === 'object' ? new Error(`cleanup failed at ${url}`) : `cleanup failed at ${url}`
    const cancel = jest.fn(async () => { throw original })
    const error = await publicRejection(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)) },
      cancel,
    })), sanitized)
    expect(cancel).toHaveBeenCalledTimes(1)
    if (!sanitized) expect(error).toBe(original)
    if (sanitized || kind === 'object') {
      expect(describeWalletFailure(error).retry).toBe('forbidden')
      recordWalletFailure(error, { observationUnavailable: true, transientTransport: true })
      expect(describeWalletFailure(error).retry).toBe('forbidden')
    } else {
      expect(describeWalletFailure(error).retry).toBe('unknown')
    }
    if (sanitized) {
      expect(String(error)).not.toContain(bearer)
      expect(JSON.stringify(error)).not.toContain(bearer)
      expect(describeWalletFailure(error).cause).toBe(error)
      expect((error as { cause?: unknown }).cause).toBeUndefined()
    }
  })
})
