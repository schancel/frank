/**
 * Minimal client for Qwen 3.8 Max's OpenAI-compatible chat-completions endpoint (Alibaba Cloud
 * Model Studio), for ticket #9's headless bot demo.
 *
 * **Must pass `stream: true`** -- confirmed live (this ticket's own scoping): a plain,
 * non-streaming request to this endpoint is rejected, but a streaming request returns a real SSE
 * stream of `data: {...}` chunks (`content` and, with thinking on, `reasoning_content` delta
 * fields) ending in the literal line `data: [DONE]`. No `openai` (or any other LLM SDK)
 * dependency exists in this app already, so this hand-parses the SSE stream itself via axios'
 * Node `responseType: 'stream'` rather than adding one.
 *
 * One call has one time limit for the whole answer, connection and stream together, and can be
 * aborted by the caller. `enable_thinking` is sent as configured (off unless asked for): with it
 * on the model streams its reasoning before the answer, which is most of the wait.
 */
import axios from 'axios'

export interface QwenChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface QwenChatResult {
  /** The concatenated `choices[0].delta.content` across every chunk -- the actual reply text. */
  content: string
  /** The concatenated `choices[0].delta.reasoning_content` across every chunk -- Qwen's visible
   * chain-of-thought for this turn (surfaced for logging/write-up purposes only; never sent back
   * over Frank as part of the reply itself). */
  reasoning: string
}

export interface QwenClientOptions {
  apiKey: string
  /** e.g. `https://ws-es6ci524uikv1nzf.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` (no
   * trailing slash; `/chat/completions` is appended). */
  endpoint: string
  model?: string
  /** Limit for one whole call, in milliseconds. Unset: no limit. */
  timeoutMs?: number
  /** Sent as `enable_thinking`. Default off. */
  thinking?: boolean
}

interface QwenStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
    }
  }>
}

export class QwenClient {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly thinking: boolean

  constructor(options: QwenClientOptions) {
    this.apiKey = options.apiKey
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.model = options.model ?? 'qwen3.8-max'
    this.timeoutMs = options.timeoutMs ?? 0
    this.thinking = options.thinking ?? false
  }

  /** Sends `messages` as one chat-completions turn and resolves once the stream ends, having
   * concatenated every `content`/`reasoning_content` delta chunk (see this file's header).
   * Rejects when the whole call has taken `timeoutMs`, or when `signal` aborts; either way the
   * request and its stream are torn down, so nothing is left waiting. */
  async chat(
    messages: QwenChatMessage[],
    options: { signal?: AbortSignal } = {},
  ): Promise<QwenChatResult> {
    const controller = new AbortController()
    let stream: (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | undefined
    let end: (error: Error) => void = () => undefined
    const ended = new Promise<never>((_, reject) => {
      end = error => {
        reject(error)
        controller.abort()
        stream?.destroy?.(error)
      }
    })
    ended.catch(() => undefined)
    const timer =
      this.timeoutMs > 0
        ? setTimeout(
            () => end(new Error(`Qwen model call timed out after ${this.timeoutMs} ms`)),
            this.timeoutMs,
          )
        : undefined
    const aborted = () => end(new Error('Qwen model call aborted'))
    if (options.signal?.aborted) aborted()
    else options.signal?.addEventListener('abort', aborted, { once: true })
    try {
      return await Promise.race([
        ended,
        this.stream(messages, controller.signal, opened => {
          stream = opened
          // The limit passed while the response was arriving: nothing reads this stream.
          if (controller.signal.aborted) stream.destroy?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', aborted)
    }
  }

  private async stream(
    messages: QwenChatMessage[],
    signal: AbortSignal,
    opened: (stream: NodeJS.ReadableStream) => void,
  ): Promise<QwenChatResult> {
    const response = await axios({
      method: 'post',
      url: `${this.endpoint}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        model: this.model,
        messages,
        stream: true,
        enable_thinking: this.thinking,
      },
      responseType: 'stream',
      signal,
    })
    opened(response.data as NodeJS.ReadableStream)

    return new Promise<QwenChatResult>((resolve, reject) => {
      let buffer = ''
      let content = ''
      let reasoning = ''
      let settled = false

      const stream = response.data as NodeJS.ReadableStream

      const handleLine = (rawLine: string) => {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) return
        const data = line.slice('data:'.length).trim()
        if (data === '' || data === '[DONE]') return
        let parsed: QwenStreamChunk
        try {
          parsed = JSON.parse(data)
        } catch {
          // A malformed/partial SSE data line shouldn't happen on a well-formed stream, but one
          // bad chunk shouldn't sink an otherwise-successful response either.
          return
        }
        const delta = parsed.choices?.[0]?.delta
        if (delta?.content) content += delta.content
        if (delta?.reasoning_content) reasoning += delta.reasoning_content
      }

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          handleLine(buffer.slice(0, newlineIndex))
          buffer = buffer.slice(newlineIndex + 1)
          newlineIndex = buffer.indexOf('\n')
        }
      })
      stream.on('end', () => {
        if (settled) return
        settled = true
        if (buffer.trim().length > 0) handleLine(buffer)
        resolve({ content, reasoning })
      })
      stream.on('error', (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      })
    })
  }
}
