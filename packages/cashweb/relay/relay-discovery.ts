/** Public /peers origins are untrusted hints, not group capabilities or authenticated routing. */
export interface RelayDiscoveryOptions {
  baseUrl: string
  fetch: typeof fetch
  signal?: AbortSignal
  maxBytes?: number
  maxRelays?: number
  timeoutMs?: number
  /** Disposable loopback fixtures only; production discovery requires HTTPS public hints. */
  allowLoopbackHttp?: boolean
}

function loopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/** Canonical bare origin. This validates syntax, not DNS resolution or relay identity. */
export function relayDiscoveryOrigin(
  value: string,
  allowLoopbackHttp = false,
): string {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        allowLoopbackHttp &&
        url.protocol === 'http:' &&
        loopback(url.hostname)
      ))
  )
    throw new Error('Invalid relay origin')
  return url.origin
}

function publicHint(origin: string, allowLoopbackHttp: boolean): boolean {
  const url = new URL(origin)
  if (allowLoopbackHttp && loopback(url.hostname)) return true
  const host = url.hostname.toLowerCase()
  if (
    loopback(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.')
  )
    return false
  const ipv4 = host.split('.').map(Number)
  if (ipv4.length === 4 && ipv4.every(Number.isInteger)) {
    const [a, b] = ipv4
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    )
      return false
  }
  return url.protocol === 'https:'
}

export async function discoverRelayOrigins(
  options: RelayDiscoveryOptions,
): Promise<string[]> {
  const maxBytes = options.maxBytes ?? 65536
  const maxRelays = options.maxRelays ?? 64
  const timeoutMs = options.timeoutMs ?? 5000
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1048576 ||
    !Number.isSafeInteger(maxRelays) ||
    maxRelays < 1 ||
    maxRelays > 256 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    throw new Error('Invalid relay discovery bounds')
  const base = relayDiscoveryOrigin(options.baseUrl, options.allowLoopbackHttp)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let rejectCancelled!: (error: Error) => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject
  })
  controller.signal.addEventListener(
    'abort',
    () => rejectCancelled(new Error('Relay discovery cancelled or timed out')),
    { once: true },
  )
  const timer = setTimeout(cancel, timeoutMs)
  try {
    if (options.signal?.aborted) controller.abort()
    const request = async () => {
      if (controller.signal.aborted)
        throw new Error('Relay discovery cancelled')
      const response = await options.fetch(`${base}/peers`, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok || (response.url && response.url !== `${base}/peers`))
        throw new Error('Relay discovery request failed')
      const length = response.headers.get('content-length')
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes))
        throw new Error('Relay discovery response is too large')
      if (!response.body) throw new Error('Missing relay discovery response')
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maxBytes)
          throw new Error('Relay discovery response is too large')
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      const payload: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      )
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('relays' in payload) ||
        !Array.isArray(payload.relays) ||
        payload.relays.length > maxRelays ||
        payload.relays.some(value => typeof value !== 'string')
      )
        throw new Error('Invalid relay discovery response')
      const origins = new Set<string>()
      for (const hint of payload.relays) {
        try {
          const origin = relayDiscoveryOrigin(hint, options.allowLoopbackHttp)
          if (publicHint(origin, options.allowLoopbackHttp ?? false))
            origins.add(origin)
        } catch {
          /* Invalid external hints are never offered. */
        }
      }
      return [...origins]
    }
    return await Promise.race([request(), cancelled])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    controller.abort()
    void reader?.cancel().catch(() => undefined)
  }
}
