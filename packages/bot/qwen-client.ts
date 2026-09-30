/**
 * Minimal client for Qwen 3.8 Max's OpenAI-compatible chat-completions endpoint (Alibaba Cloud
 * Model Studio), for ticket #9's headless bot demo.
 *
 * **Must pass `stream: true` and `enable_thinking: true`** -- confirmed live (this ticket's own
 * scoping): a plain, non-streaming request to this endpoint is rejected, but a streaming request
 * with `enable_thinking: true` returns a real SSE stream of `data: {...}` chunks (both
 * `reasoning_content` and `content` delta fields) ending in the literal line `data: [DONE]`. No
 * `openai` (or any other LLM SDK) dependency exists in this app already, so this hand-parses the
 * SSE stream itself via axios' Node `responseType: 'stream'` rather than adding one.
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

  constructor(options: QwenClientOptions) {
    this.apiKey = options.apiKey
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.model = options.model ?? 'qwen3.8-max'
  }

  /** Sends `messages` as one chat-completions turn and resolves once the stream ends, having
   * concatenated every `content`/`reasoning_content` delta chunk (see this file's header). */
  async chat(messages: QwenChatMessage[]): Promise<QwenChatResult> {
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
        enable_thinking: true,
      },
      responseType: 'stream',
    })

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
