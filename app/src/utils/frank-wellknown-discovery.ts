import type { DiscoveredRelay } from './frank-domain-discovery'

/** An HTTP 200 document is a positive advertisement even when its contents are invalid.
 * Do not turn that failure into an email suggestion after an empty SRV lookup. */
export class WellKnownDiscoveryError extends Error {
  constructor(readonly advertised: boolean) {
    super('The domain’s Frank discovery document could not be verified.')
  }
}

export async function discoverWellKnown(
  domain: string,
  request: typeof fetch = globalThis.fetch,
): Promise<{ relays: DiscoveredRelay[]; ttl: number } | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 5000)
  let advertised = false
  try {
    const response = await request(
      `https://${domain}/.well-known/frank-relay`,
      {
        headers: { Accept: 'application/json' },
        signal: abort.signal,
        credentials: 'omit',
        redirect: 'error',
      },
    )
    if (response.status === 404 || response.status === 410) return null
    advertised = response.status === 200
    if (
      !advertised ||
      response.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      throw new Error('Missing discovery document')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty discovery document')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '',
      size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if ((size += chunk.value.length) > 4096)
          throw new Error('Discovery document too large')
        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      await reader.cancel()
    }
    const document: unknown = JSON.parse(text + decoder.decode())
    if (!document || typeof document !== 'object')
      throw new Error('Invalid discovery document')
    const value = document as { version?: unknown; relays?: unknown }
    if (
      value.version !== 1 ||
      !Array.isArray(value.relays) ||
      !value.relays.length ||
      value.relays.length > 8
    )
      throw new Error('Invalid discovery document')
    const seen = new Set<string>()
    const relays = value.relays.map((item: unknown): DiscoveredRelay => {
      if (!item || typeof item !== 'object') throw new Error('Invalid relay')
      const relay = item as { endpoint?: unknown; priority?: unknown }
      if (
        typeof relay.endpoint !== 'string' ||
        typeof relay.priority !== 'number' ||
        !Number.isInteger(relay.priority) ||
        relay.priority < 0 ||
        relay.priority > 65535
      )
        throw new Error('Invalid relay')
      const url = new URL(relay.endpoint)
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.origin !== relay.endpoint ||
        url.username ||
        url.password ||
        !url.hostname.includes('.') ||
        /^[0-9.]+$/.test(url.hostname) ||
        !url.hostname
          .split('.')
          .every(label =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
          ) ||
        seen.has(relay.endpoint)
      )
        throw new Error('Invalid relay origin')
      seen.add(relay.endpoint)
      return { endpoint: relay.endpoint, priority: relay.priority, weight: 0 }
    })
    const cache = response.headers.get('cache-control') ?? ''
    const age = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(cache)
    const ttl = /\b(?:no-store|no-cache|private)\b/i.test(cache)
      ? 0
      : Math.min(300, Number(age?.[1] ?? 0))
    return { relays: relays.sort((a, b) => a.priority - b.priority), ttl }
  } catch (error) {
    if (error instanceof WellKnownDiscoveryError) throw error
    throw new WellKnownDiscoveryError(advertised)
  } finally {
    clearTimeout(timer)
  }
}
