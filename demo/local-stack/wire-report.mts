/**
 * Summarize the canonical message exchanges captured by the HTTPS fronts (logs/wire.jsonl):
 * every canonical PUT and every non-empty inbox GET, part by part, with each Frank frame's header
 * fields and the exact bytes in hex. Public ciphertext and public context only; nothing is opened.
 *
 *   npx tsx --tsconfig packages/bot/tsconfig.json demo/local-stack/wire-report.mts [wire.jsonl] > report.txt
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { decodeCanonical, parseFrame } from '@frank/codec'

const file = process.argv[2] ?? `${process.env.FRANK_STACK_DIR ?? '/private/tmp/frank-stack'}/logs/wire.jsonl`
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
type Part = { head: string; type: string; body: Buffer }
function split(body: Buffer, contentType: string): Part[] {
  const boundary = /boundary=([^;\s]+)/.exec(contentType)?.[1]
  if (!boundary) return []
  const mark = Buffer.from('--' + boundary)
  const parts: Part[] = []
  let at = body.indexOf(mark)
  while (at >= 0) {
    const next = body.indexOf(mark, at + mark.length)
    if (next < 0) break
    let seg = body.subarray(at + mark.length, next)
    if (seg.subarray(0, 2).toString() === '\r\n') seg = seg.subarray(2)
    const cut = seg.indexOf('\r\n\r\n')
    const head = seg.subarray(0, cut).toString('latin1')
    let data = seg.subarray(cut + 4)
    if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2)
    parts.push({ head: head.replace(/\r\n/g, ' | '), type: /content-type:\s*([^|]+)/i.exec(head.replace(/\r\n/g, '|'))?.[1].trim() ?? '', body: data })
    at = next
  }
  return parts
}
function describe(part: Part, indent: string): void {
  console.log(`${indent}part [${part.head}] ${part.body.length} bytes sha256 ${sha(part.body)}`)
  if (part.type.startsWith('multipart/')) return split(part.body, part.type).forEach(inner => describe(inner, indent + '  '))
  if (part.type === 'application/vnd.frank.cbor') {
    try {
      const frame = parseFrame(part.body) as unknown as Record<string, unknown>
      const fields = Object.fromEntries(Object.entries(frame).filter(([, v]) => typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string').map(([k, v]) => [k, String(v)]))
      console.log(`${indent}  Frank frame ${JSON.stringify(fields)}`)
    } catch (error) {
      console.log(`${indent}  Frank frame not parsed by the plain frame parser: ${(error as Error).message}`)
    }
  } else if (part.type === 'application/cbor') {
    try {
      const value = decodeCanonical(part.body)
      const label = value instanceof Map ? `map(${value.size}) first=${JSON.stringify(typeof value.get(0) === 'string' ? value.get(0) : undefined)}` : Array.isArray(value) ? `array(${value.length})` : typeof value
      console.log(`${indent}  canonical CBOR ${label}`)
    } catch (error) {
      console.log(`${indent}  CBOR not canonical: ${(error as Error).message}`)
    }
  }
  console.log(`${indent}  hex ${part.body.toString('hex')}`)
}
for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const row = JSON.parse(line)
  const path = String(row.path)
  if (row.method === 'PUT' && path.startsWith('/message/monad/cbor')) {
    const body = Buffer.from(row.requestBase64, 'base64')
    console.log(`\n== ${row.t} ${row.front} PUT ${path} -> ${row.status}; request ${body.length} bytes (${row.requestHeaders['content-type']})`)
    split(body, row.requestHeaders['content-type']).forEach(part => describe(part, '  '))
    console.log(`  response (${row.responseHeaders['content-type']}): ${Buffer.from(row.responseBase64, 'base64').toString('utf8')}`)
  }
  if (row.method === 'GET' && path.includes('/message/monad/cbor/inbox/') && row.status === 200) {
    const body = Buffer.from(row.responseBase64 ?? '', 'base64')
    const parts = split(body, row.responseHeaders['content-type'] ?? '')
    if (!parts.length) continue
    console.log(`\n== ${row.t} ${row.front} GET ${path} -> 200; response ${body.length} bytes (${row.responseHeaders['content-type']})`)
    parts.forEach(part => describe(part, '  '))
  }
}
