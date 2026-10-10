import { createServer } from 'net'

import { resolveDemoConfig } from './demo-config'
import { checkPrerequisites, main } from './demo'

const REAL_ENV = {
  MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc.example.invalid/v2/dummy-key',
  E2E_DEMO_MAIN_WALLET_JSON: 'wallet.json',
}

describe('demo launcher', () => {
  let errors: string[]
  beforeEach(() => {
    errors = []
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '))
    })
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it('prints one clear line per missing setting and exits 1, with no stack trace', async () => {
    const code = await main([], {
      FRANK_DEMO_ENV_FILE: '/nonexistent/dummy.env',
      PATH: process.env.PATH,
    })
    expect(code).toBe(1)
    const out = errors.join('\n')
    expect(out).toContain('Frank demo cannot start:')
    expect(out).toMatch(/MONAD_TESTNET_HTTP_RPC_URL is required/)
    expect(out).toMatch(/E2E_DEMO_MAIN_WALLET_JSON is required/)
    expect(out).not.toMatch(/\n\s+at /)
  })

  it('refuses an argument it does not know (there is one mode: Monad testnet)', async () => {
    const code = await main(['--some-other-chain'], { FRANK_DEMO_ENV_FILE: '/nonexistent/dummy.env' })
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/unknown argument\(s\): --some-other-chain/)
  })

  it('a missing funding wallet file is one clear line', async () => {
    const config = resolveDemoConfig({ env: REAL_ENV, envFile: {}, home: '/home/dummy', cwd: '/work' })
    const problems = await checkPrerequisites(config)
    expect(problems).toContain('E2E_DEMO_MAIN_WALLET_JSON does not exist: /work/wallet.json')
  })

  it('a bad env file is reported by line number without echoing its content', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const dir = mkdtempSync(join(tmpdir(), 'demo-env-'))
    try {
      writeFileSync(
        join(dir, 'dummy.env'),
        'FRANK_NETWORK_TAG=MONT\nthis line has sekret-token-9 in it\n',
      )
      const code = await main([], { FRANK_DEMO_ENV_FILE: join(dir, 'dummy.env') })
      expect(code).toBe(1)
      expect(errors.join('\n')).toContain('line 2 is not KEY=value')
      expect(errors.join('\n')).not.toContain('sekret-token-9')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a busy port and a missing prebuilt relay, each on its own line', async () => {
    const server = createServer()
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const busy = (server.address() as { port: number }).port
    try {
      const config = resolveDemoConfig({
        env: { ...REAL_ENV, FRANK_DEMO_RELAY_PORT: String(busy), CASHWEBD_BIN: '/nonexistent/cashwebd-exe' },
        envFile: {},
        home: '/home/dummy',
        cwd: '/work',
      })
      const problems = await checkPrerequisites(config)
      expect(problems.some(p => p.startsWith('CASHWEBD_BIN does not exist'))).toBe(true)
      expect(problems.some(p => p.includes(`port ${busy} is in use`))).toBe(true)
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('without CASHWEBD_BIN it says how to get a relay when cargo is missing', async () => {
    const config = resolveDemoConfig({
      env: REAL_ENV,
      envFile: {},
      home: '/home/dummy',
      cwd: '/work',
    })
    const savedPath = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      const problems = await checkPrerequisites(config)
      expect(
        problems.some(p => p.includes('`cargo` was not found') && p.includes('CASHWEBD_BIN')),
      ).toBe(true)
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('distinct directory HTTPS route transport', () => {
  it('uses exact installed TLS material, preserves bytes/CORS and survives the old probe socket budget', async () => {
    const { createServer: httpServer } = await import('node:http')
    const { request: tlsRequest } = await import('node:https')
    const { checkServerIdentity } = await import('node:tls')
    const { X509Certificate, createHash } = await import('node:crypto')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { initBundle, startFixture, checkNode } = await import('./directory-trust/index')
    const { startDirectoryRouteTransport } = await import('./demo')
    const root = mkdtempSync(join(tmpdir(), 'directory-front-'))
    const available = createServer()
    await new Promise<void>(resolve => available.listen(0, '127.0.0.1', resolve))
    const port = (available.address() as { port: number }).port
    await new Promise<void>(resolve => available.close(() => resolve()))
    const p = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const bundle = initBundle({ mode: 'synthetic-demo', runDir: join(root, 'directory-trust-front'), nowNs: 1700000100000000000n, trustInputs: { network: 'monad-testnet', subject: p, rev0T1: '11'.repeat(32), relayId: '00'.repeat(16), relayIdentity: { keyType: 1, point: p }, endpoint: `https://127.0.0.1:${port}`, bindingExpiryNs: 1700000600000000000n } })
    const backend = httpServer((req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT', 'Access-Control-Expose-Headers': 'x-frank-directory-evidence' }); res.end(); return }
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/vnd.frank.cbor', 'x-frank-directory-evidence': 'fresh-current' }); res.end(Buffer.from([0, 1, 255])) }, 3200)
    })
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
    let front: Awaited<ReturnType<typeof startDirectoryRouteTransport>> | undefined
    try {
      const fixture = await startFixture(bundle, 1700000100000000000n)
      await checkNode(bundle, 1700000100000000000n)
      await expect(startDirectoryRouteTransport({ bundle, nowNs: 1700000100000000000n, backendUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}` })).rejects.toThrow()
      await fixture.stop()
      front = await startDirectoryRouteTransport({ bundle, nowNs: 1700000100000000000n, backendUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}` })
      expect(front.endpoint).toBe(bundle.trustInputs.endpoint)
      const request = (method: string, ca = bundle.tls.caPem) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
        const req = tlsRequest(`${front!.endpoint}/directory/v1/monad-testnet/${p}/head`, { method, ca, rejectUnauthorized: true, checkServerIdentity: (host, peer) => {
          const error = checkServerIdentity(host, peer); if (error) return error
          const leaf = new X509Certificate(peer.raw)
          if (createHash('sha256').update(leaf.raw).digest('hex') !== bundle.tls.leafSha256) return new Error('pin')
        } }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) })) })
        req.once('error', reject); req.end()
      })
      const result = await request('GET')
      expect(result.status).toBe(200); expect(result.bytes).toEqual(Buffer.from([0, 1, 255])); expect(result.headers['x-frank-directory-evidence']).toBe('fresh-current')
      const cors = await request('OPTIONS'); expect(cors.status).toBe(204); expect(cors.headers['access-control-allow-origin']).toBe('*')
      await expect(request('GET', '')).rejects.toThrow()
    } finally { await front?.stop(); await new Promise<void>(resolve => backend.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
  }, 15000)
})
