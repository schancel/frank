/**
 * The model client against a stubbed HTTP call: no network. What matters to a user waiting for
 * a reply: a call that stalls is ended at the time limit, and a caller can abort it.
 */
import { PassThrough } from 'stream'
import axios from 'axios'
import { QwenClient } from './qwen-client'

jest.mock('axios', () => jest.fn())
const mockAxios = axios as unknown as jest.Mock

const client = (extra: { timeoutMs?: number; thinking?: boolean } = {}) =>
  new QwenClient({ apiKey: 'dummy-key', endpoint: 'http://model.invalid/v1/', ...extra })
const messages = [{ role: 'user' as const, content: 'hi' }]
const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`

beforeEach(() => mockAxios.mockReset())

it('concatenates the streamed answer, with thinking off unless asked for', async () => {
  mockAxios.mockImplementation(async () => {
    const stream = new PassThrough()
    stream.end(sse('Hel') + sse('lo') + 'data: [DONE]\n')
    return { data: stream }
  })
  expect(await client({ timeoutMs: 1000 }).chat(messages)).toEqual({
    content: 'Hello',
    reasoning: '',
  })
  const request = mockAxios.mock.calls[0][0]
  expect(request.url).toBe('http://model.invalid/v1/chat/completions')
  expect(request.data).toMatchObject({ stream: true, enable_thinking: false, messages })
  await client({ thinking: true }).chat(messages)
  expect(mockAxios.mock.calls[1][0].data.enable_thinking).toBe(true)
})

// On 05c93db0 the request had no time limit: both of these waited for ever.
it('ends a call that never gets a response at the time limit, and aborts the request', async () => {
  mockAxios.mockImplementation(() => new Promise(() => undefined))
  const started = Date.now()
  await expect(client({ timeoutMs: 50 }).chat(messages)).rejects.toThrow(
    'Qwen model call timed out after 50 ms',
  )
  expect(Date.now() - started).toBeLessThan(1000)
  expect(mockAxios.mock.calls[0][0].signal.aborted).toBe(true)
})

it('ends a call whose stream stalls part way at the time limit, and closes the stream', async () => {
  const stream = new PassThrough()
  mockAxios.mockImplementation(async () => {
    stream.write(sse('The ans'))
    return { data: stream }
  })
  await expect(client({ timeoutMs: 50 }).chat(messages)).rejects.toThrow(/timed out/)
  expect(stream.destroyed).toBe(true)
})

it('is aborted by the caller, at once, also when already aborted', async () => {
  const stream = new PassThrough()
  mockAxios.mockImplementation(async () => ({ data: stream }))
  const controller = new AbortController()
  const pending = client({ timeoutMs: 60_000 }).chat(messages, { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await expect(pending).rejects.toThrow('Qwen model call aborted')
  expect(stream.destroyed).toBe(true)
  await expect(
    client({ timeoutMs: 60_000 }).chat(messages, { signal: controller.signal }),
  ).rejects.toThrow('Qwen model call aborted')
})

it('passes on an HTTP failure as it is', async () => {
  mockAxios.mockRejectedValue(new Error('Request failed with status code 500'))
  await expect(client({ timeoutMs: 1000 }).chat(messages)).rejects.toThrow(/status code 500/)
})
