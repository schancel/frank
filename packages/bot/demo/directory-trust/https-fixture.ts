import { randomBytes, X509Certificate } from 'node:crypto'
import { Agent, createServer, get } from 'node:https'
import type { Socket } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import type { BundleRef, TrustBundle } from './provision'
import {
  endpoint,
  listenerMaterial,
  paths,
  reopenBundle,
  sha256,
  spki,
  trustJSON,
} from './provision'

export function announcement(bundle: TrustBundle): string {
  return JSON.stringify({
    kind: 'synthetic-directory-evidence',
    trustInputs: trustJSON(bundle.trustInputs),
    witnessHex: bundle.witnessHex ?? null,
  })
}
export function proofMarker(bundle: TrustBundle): string {
  return sha256(announcement(bundle))
}
/** Internal page renderer, also used by the certificate-reissue transport regression. */
export function proofPage(bundle: TrustBundle, nonce: string): string {
  const origin = bundle.trustInputs.endpoint
  const evidence = announcement(bundle)
  // URL serialization omits explicit port 443; the supplied tuple remains exact.
  const pageUrl = new URL(origin + paths.proof).href
  const evidenceUrl = new URL(origin + paths.evidence).href
  const script = `(async()=>{try{if(location.href!==${JSON.stringify(
    pageUrl,
  )})throw Error();const r=await fetch(${JSON.stringify(
    evidenceUrl,
  )},{redirect:'error',credentials:'omit',cache:'no-store'});if(r.status!==200||r.url!==${JSON.stringify(
    evidenceUrl,
  )}||await r.text()!==${JSON.stringify(
    evidence,
  )})throw Error();document.getElementById('result').textContent=${JSON.stringify(
    proofMarker(bundle),
  )}}catch{document.getElementById('result').textContent='failed'}})()`
  return `<!doctype html><title>Synthetic transport only</title><pre id="result">pending</pre><script nonce="${nonce}">${script}</script>`
}

export async function startFixture(
  ref: BundleRef,
  nowNs: bigint,
): Promise<{ stop: () => Promise<void> }> {
  const { bundle, key, cert, release } = listenerMaterial(ref, nowNs)
  const origin = bundle.trustInputs.endpoint
  const sockets = new Set<Socket>()
  const nonce = randomBytes(16).toString('base64')
  const evidence = announcement(bundle)
  const server = createServer({ key, cert }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'close')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src ${origin}${paths.evidence}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    )
    if (req.method !== 'GET' || req.headers.host !== new URL(origin).host) {
      res.writeHead(400)
      res.end()
      return
    }
    if (req.url === paths.health) {
      res.setHeader('Content-Type', 'application/json')
      res.end('{"kind":"synthetic-fixture-health"}')
      return
    }
    if (req.url === paths.evidence) {
      res.setHeader('Content-Type', 'application/json')
      res.end(evidence)
      return
    }
    if (req.url === paths.proof) {
      res.setHeader('Content-Type', 'text/html')
      res.end(proofPage(bundle, nonce))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.headersTimeout = 3000
  server.requestTimeout = 3000
  server.setTimeout(3000, socket => socket.destroy())
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  let closing: Promise<void> | undefined
  const stop = () =>
    (closing ??= new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => {
        release()
        resolve()
      })
    }))
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(
        Number(origin.slice(origin.lastIndexOf(':') + 1)),
        '127.0.0.1',
        () => {
          server.removeListener('error', reject)
          resolve()
        },
      )
    })
    return { stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/** Strict CA + normal hostname/expiry + exact DER/SPKI, on a new TLS session each call. */
export async function checkNode(
  ref: BundleRef,
  nowNs: bigint,
  url?: string,
): Promise<{ kind: 'synthetic-node-transport-proof'; node: string }> {
  const bundle = reopenBundle(ref, nowNs)
  const expected = bundle.trustInputs.endpoint + paths.evidence
  if (url !== undefined && url !== expected)
    throw new Error('Exact fixture evidence endpoint required')
  endpoint(bundle.trustInputs.endpoint)
  const agent = new Agent({
    ca: bundle.tls.caPem,
    rejectUnauthorized: true,
    keepAlive: false,
    maxCachedSessions: 0,
  })
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = get(
        expected,
        {
          agent,
          checkServerIdentity: (host, peer) => {
            const error = checkServerIdentity(host, peer)
            if (error) return error
            const cert = new X509Certificate(peer.raw)
            if (
              sha256(cert.raw) !== bundle.tls.leafSha256 ||
              spki(cert) !== bundle.tls.leafSpkiSha256
            )
              return new Error('Exact fixture certificate pin mismatch')
            return undefined
          },
        },
        response => {
          if (response.statusCode !== 200 || response.headers.location) {
            response.destroy()
            reject(new Error('Fixture response status or redirect rejected'))
            return
          }
          const chunks: Buffer[] = []
          let length = 0
          response.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > 600000) {
              response.destroy(new Error('Fixture response too large'))
              return
            }
            chunks.push(chunk)
          })
          response.on('error', reject)
          response.on('end', () => resolve(Buffer.concat(chunks).toString()))
        },
      )
      const timer = setTimeout(
        () => request.destroy(new Error('Fixture request timed out')),
        5000,
      )
      request.once('close', () => clearTimeout(timer))
      request.once('error', reject)
    })
    if (body !== announcement(bundle))
      throw new Error('Fixture authenticated tuple/evidence mismatch')
    return { kind: 'synthetic-node-transport-proof', node: process.version }
  } finally {
    agent.destroy()
  }
}
