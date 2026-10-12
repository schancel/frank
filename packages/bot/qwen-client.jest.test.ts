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
  new QwenClient({
    apiKey: 'dummy-key',
    endpoint: 'http://model.invalid/v1/',
    ...extra,
  })
const messages = [{ role: 'user' as const, content: 'hi' }]
const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

beforeEach(() => mockAxios.mockReset())

it('concatenates the streamed answer, with thinking off unless asked for', async () => {
  mockAxios.mockImplementation(async () => {
    const stream = new PassThrough()
    stream.end(sse('Hel') + sse('lo') + 'data: [DONE]\n\n')
    return { data: stream }
  })
  expect(await client({ timeoutMs: 1000 }).chat(messages)).toEqual({
    content: 'Hello',
    reasoning: '',
  })
  const request = mockAxios.mock.calls[0][0]
  expect(request.url).toBe('http://model.invalid/v1/chat/completions')
  expect(request.data).toMatchObject({
    stream: true,
    enable_thinking: false,
    messages,
  })
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
  await expect(client({ timeoutMs: 50 }).chat(messages)).rejects.toThrow(
    /timed out/,
  )
  expect(stream.destroyed).toBe(true)
})

it('is aborted by the caller, at once, also when already aborted', async () => {
  const stream = new PassThrough()
  mockAxios.mockImplementation(async () => ({ data: stream }))
  const controller = new AbortController()
  const pending = client({ timeoutMs: 60_000 }).chat(messages, {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 10)
  await expect(pending).rejects.toThrow('Qwen model call aborted')
  expect(stream.destroyed).toBe(true)
  await expect(
    client({ timeoutMs: 60_000 }).chat(messages, { signal: controller.signal }),
  ).rejects.toThrow('Qwen model call aborted')
})

it('passes on an HTTP failure as it is', async () => {
  mockAxios.mockRejectedValue(new Error('Request failed with status code 500'))
  await expect(client({ timeoutMs: 1000 }).chat(messages)).rejects.toThrow(
    /status code 500/,
  )
})

const completion = (content: string, id = 'answer-1', index = 0) =>
  `data: ${JSON.stringify({
    id,
    choices: [{ index, delta: { content } }],
  })}\n\n`
const done = 'data: [DONE]\n\n'
const respond = (bytes: Buffer[]) => {
  mockAxios.mockImplementationOnce(async () => {
    const stream = new PassThrough()
    for (const bytesChunk of bytes) stream.write(bytesChunk)
    stream.end()
    return { data: stream }
  })
}

it('preserves unicode and SSE frames split at every byte boundary', async () => {
  const wire = Buffer.from(
    ': comment\r\n\r\n' + completion('Hello 👋 Shammah!') + done,
  )
  respond([...wire].map((byte) => Buffer.from([byte])))
  expect(await client().chat(messages)).toEqual({
    content: 'Hello 👋 Shammah!',
    reasoning: '',
  })
})

it('joins multiline SSE data and keeps reasoning out of the answer', async () => {
  respond([
    Buffer.from(
      'data: {"choices": [\r\ndata: {"delta":{"reasoning_content":"private","content":"Answer"}}]}\r\n\r\n' +
        done,
    ),
  ])
  expect(await client().chat(messages)).toEqual({
    content: 'Answer',
    reasoning: 'private',
  })
})

it.each([
  [
    'a graceful but premature EOF',
    completion('Hey Shamm'),
    /before completion/,
  ],
  [
    'an unfinished final frame',
    completion('Hey Shamm') + 'data: [DONE]\n',
    /before completion/,
  ],
  [
    'an invalid choices structure',
    completion('Hey Shamm') + 'data: {"choices":"wrong"}\n\n' + done,
    /invalid choices/,
  ],
  [
    'a malformed event',
    completion('Hey Shamm') + 'data: {bad}\n\n' + done,
    /invalid JSON/,
  ],
  [
    'a different completion restarted in the stream',
    completion('Hey Shamm') + completion('Hey Shammah!', 'answer-2') + done,
    /changed completion ID/,
  ],
  [
    'an upstream error after partial content',
    completion('Hey Shamm') +
      'data: {"error":{"message":"private provider body"}}\n\n' +
      done,
    /provider error/,
  ],
  [
    'a token-limited answer',
    completion('Hey Shamm') +
      'data: {"choices":[{"finish_reason":"length","delta":{}}]}\n\n' +
      done,
    /complete text answer/,
  ],
  [
    'content after a stop',
    completion('Hey Shamm') +
      'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n' +
      completion('Hey Shammah!') +
      done,
    /after the answer finished/,
  ],
])(
  'rejects %s instead of publishing partial or combined text',
  async (_label, wire, error) => {
    respond([Buffer.from(wire)])
    await expect(client().chat(messages)).rejects.toThrow(error)
  },
)

it('selects choice zero by index and accepts a trailing usage event', async () => {
  respond([
    Buffer.from(
      completion('Wrong', 'answer-1', 1) +
        completion('Right') +
        'data: {"choices":[],"usage":{"total_tokens":10}}\n\n' +
        done,
    ),
  ])
  expect((await client().chat(messages)).content).toBe('Right')
})

it('does not carry a failed call prefix into a later call', async () => {
  const sameClient = client()
  respond([Buffer.from(completion('Hey Shamm'))])
  await expect(sameClient.chat(messages)).rejects.toThrow(/before completion/)
  respond([Buffer.from(completion('Hey Shammah!') + done)])
  expect((await sameClient.chat(messages)).content).toBe('Hey Shammah!')
})
