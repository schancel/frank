/** Browser DNS-over-HTTPS discovery. DNS selects a relay; signed directory admission
 * remains responsible for accepting an account's identity. Nothing here is persisted. */
export const DEFAULT_DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
] as const

export interface DiscoveredRelay {
  endpoint: string
  priority: number
  weight: number
}
type Answer = { relays: DiscoveredRelay[]; ttl: number }
const MAX_BYTES = 16_384
const MAX_RECORDS = 64

function hostname(input: string): string {
  const value = input.toLowerCase().replace(/\.$/, '')
  if (
    value.length > 253 ||
    /^[0-9.]+$/.test(value) ||
    !value.includes('.') ||
    !value
      .split('.')
      .every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error('Invalid domain name')
  return value
}

export function splitDomainHandle(input: string): {
  username: string
  domain: string
} {
  const parts = input.trim().split('@')
  if (parts.length !== 2 || !parts[0] || /\s/.test(parts[0]))
    throw new Error('Invalid account handle')
  return { username: parts[0].toLowerCase(), domain: hostname(parts[1]) }
}

function query(name: string): Uint8Array {
  const labels = name.split('.')
  // ID zero is recommended for DoH (HTTP supplies request/response correlation).
  return Uint8Array.from([
    0,
    0,
    1,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    ...labels.flatMap(label => [
      label.length,
      ...Array.from(label, c => c.charCodeAt(0)),
    ]),
    0,
    0,
    33,
    0,
    1,
  ])
}

/** Minimal bounded DNS wire reader; compression pointers may never cycle or escape the body. */
function decode(bytes: Uint8Array, question: string): Answer {
  if (bytes.length < 12 || bytes.length > MAX_BYTES)
    throw new Error('Invalid DNS response size')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number) => view.getUint16(at)
  const flags = u16(2)
  const code = flags & 15
  if (
    u16(0) !== 0 ||
    !(flags & 0x8000) ||
    flags & 0x7a00 ||
    ![0, 3].includes(code) ||
    u16(4) !== 1
  )
    throw new Error('DNS query failed')
  function name(at: number): { value: string; end: number } {
    const seen = new Set<number>()
    const labels: string[] = []
    let end: number | undefined
    let size = 0
    for (;;) {
      if (at >= bytes.length || seen.has(at))
        throw new Error('Invalid DNS name')
      seen.add(at)
      const length = bytes[at++]
      if (length === 0)
        return { value: labels.join('.').toLowerCase(), end: end ?? at }
      if ((length & 0xc0) === 0xc0) {
        if (at >= bytes.length) throw new Error('Invalid DNS pointer')
        const pointer = ((length & 63) << 8) | bytes[at++]
        if (pointer >= at - 2) throw new Error('Invalid DNS pointer')
        end ??= at
        at = pointer
      } else {
        if (
          length > 63 ||
          at + length > bytes.length ||
          (size += length + 1) > 254
        )
          throw new Error('Invalid DNS label')
        labels.push(String.fromCharCode(...bytes.slice(at, at + length)))
        at += length
      }
    }
  }
  const q = name(12)
  if (q.value !== question || u16(q.end) !== 33 || u16(q.end + 2) !== 1)
    throw new Error('DNS question mismatch')
  let at = q.end + 4
  const answers = u16(6)
  const count = answers + u16(8) + u16(10)
  if (count > MAX_RECORDS) throw new Error('Too many DNS records')
  const relays: DiscoveredRelay[] = []
  let ttl = 300
  let unavailable = false
  for (let i = 0; i < count; i++) {
    const owner = name(at)
    at = owner.end
    const type = u16(at),
      cls = u16(at + 2),
      lifetime = view.getUint32(at + 4),
      length = u16(at + 8)
    at += 10
    const end = at + length
    if (end > bytes.length) throw new Error('Truncated DNS record')
    if (i < answers && type === 33 && cls === 1) {
      if (owner.value !== question || length < 7)
        throw new Error('Unexpected SRV record')
      const target = name(at + 6)
      if (target.end !== end) throw new Error('Invalid SRV target')
      ttl = Math.min(ttl, lifetime)
      if (!target.value) unavailable = true
      else {
        if (u16(at + 4) !== 443)
          throw new Error('Frank relay must use HTTPS port 443')
        relays.push({
          endpoint: `https://${hostname(target.value)}`,
          priority: u16(at),
          weight: u16(at + 2),
        })
      }
    } else if (i < answers) {
      // No alias chasing: unexpected answers must never become email fallback.
      throw new Error('Unexpected DNS answer')
    }
    at = end
  }
  if (
    at !== bytes.length ||
    (code === 3 && answers !== 0) ||
    (unavailable && relays.length)
  )
    throw new Error('Inconsistent DNS response')
  return { relays, ttl: relays.length || unavailable ? ttl : 0 }
}

/** Configure trusted resolvers at composition time, never from recipient input. */
export function createFrankDomainDiscovery(
  options: {
    endpoints?: readonly string[]
    fetch?: typeof fetch
    now?: () => number
    random?: () => number
  } = {},
) {
  const endpoints = options.endpoints ?? DEFAULT_DOH_ENDPOINTS
  if (!endpoints.length || endpoints.length > 4)
    throw new Error('Configure 1–4 DoH endpoints')
  for (const endpoint of endpoints) {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('DoH requires a trusted HTTPS endpoint')
  }
  const cache = new Map<string, { answer: Answer; until: number }>()
  const now = options.now ?? Date.now
  return async (domain: string): Promise<DiscoveredRelay[]> => {
    const canonical = hostname(domain)
    const existing = cache.get(canonical)
    let answer =
      existing && existing.until > now() ? existing.answer : undefined
    if (!answer) {
      const question = `_frank._tcp.${canonical}`
      if (question.length > 253)
        throw new Error('Domain name is too long for service discovery')
      const wire = query(question)
      const encoded = btoa(String.fromCharCode(...wire))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      for (const endpoint of endpoints) {
        const abort = new AbortController()
        const timeout = setTimeout(() => abort.abort(), 5000)
        try {
          const url = new URL(endpoint)
          url.searchParams.set('dns', encoded)
          const response = await (options.fetch ?? globalThis.fetch)(
            url.toString(),
            {
              headers: { Accept: 'application/dns-message' },
              signal: abort.signal,
              credentials: 'omit',
              redirect: 'error',
            },
          )
          if (
            !response.ok ||
            response.headers.get('content-type')?.split(';')[0] !==
              'application/dns-message'
          )
            throw new Error('DoH request failed')
          const reader = response.body?.getReader()
          if (!reader) throw new Error('Missing DNS response')
          const chunks: Uint8Array[] = []
          let length = 0
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              length += next.value.length
              if (length > MAX_BYTES) throw new Error('DNS response too large')
              chunks.push(next.value)
            }
          } finally {
            await reader.cancel()
          }
          const body = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) {
            body.set(chunk, offset)
            offset += chunk.length
          }
          answer = decode(body, question)
          break
        } catch {
          /* Try the next configured resolver; never turn failure into absence. */
        } finally {
          clearTimeout(timeout)
        }
      }
      if (!answer)
        throw new Error(
          'Domain discovery failed. Check your connection and try again.',
        )
      if (cache.size >= 128) cache.delete(cache.keys().next().value!)
      cache.set(canonical, { answer, until: now() + answer.ttl * 1000 })
    }
    // RFC 2782: lowest priority first, weighted selection within each priority group.
    const remaining = [...answer.relays]
    const ordered: DiscoveredRelay[] = []
    while (remaining.length) {
      const priority = Math.min(...remaining.map(r => r.priority))
      const group = remaining
        .filter(r => r.priority === priority)
        .sort((a, b) => a.weight - b.weight)
      let pick = Math.floor(
        (options.random ?? Math.random)() *
          (group.reduce((sum, r) => sum + r.weight, 0) + 1),
      )
      const selected =
        group.find(r => (pick -= r.weight) <= 0) ?? group[group.length - 1]
      ordered.push(selected)
      remaining.splice(remaining.indexOf(selected), 1)
    }
    return ordered
  }
}

export const discoverFrankDomain = createFrankDomainDiscovery()
