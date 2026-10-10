import { createServer, get, type Server } from 'node:https'
import { createServer as netServer } from 'node:net'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkBrowser,
  checkNode,
  initBundle,
  startFixture,
  type TrustBundle,
  type TrustInputs,
} from './index'
import { announcement, proofPage } from './https-fixture'
import { openssl, paths } from './provision'
import { probeChromium } from './check-browser'

const now = 1000000000000000001n
const p = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
let root: string
let bundle: TrustBundle
let stop: (() => Promise<void>) | undefined
async function freePort(): Promise<number> {
  const server = netServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'directory-trust-tls-tests-'))
  const trustInputs: TrustInputs = {
    network: 'monad-testnet',
    subject: p,
    rev0T1: '21729c888b5da6caeaf90dde5eb2c37e9c2da392e609908d75afba75b72f3a3e',
    relayId: '00'.repeat(16),
    relayIdentity: { keyType: 1, point: p },
    endpoint: `https://127.0.0.1:${await freePort()}`,
    bindingExpiryNs: now + 10000n,
  }
  bundle = initBundle({
    mode: 'synthetic-demo',
    runDir: join(root, 'directory-trust-run'),
    trustInputs,
    nowNs: now,
  })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

async function serve(
  key: Buffer,
  cert: Buffer,
  body = announcement(bundle),
  redirect = false,
): Promise<Server> {
  const server = createServer({ key, cert }, (_, res) => {
    if (redirect)
      res.writeHead(302, {
        Location: bundle.trustInputs.endpoint + paths.evidence,
      })
    res.end(body)
  })
  await new Promise<void>(resolve =>
    server.listen(
      Number(new URL(bundle.trustInputs.endpoint).port),
      '127.0.0.1',
      resolve,
    ),
  )
  stop = () => new Promise<void>(resolve => server.close(() => resolve()))
  return server
}
const key = () => readFileSync(join(bundle.runDir, 'leaf.key'))
const cert = () => readFileSync(join(bundle.runDir, 'leaf.pem'))
function observeProofRequests(server: Server): () => number {
  let requests = 0
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    requests++
    res.setHeader(
      'Content-Type',
      req.url === paths.proof ? 'text/html' : 'application/json',
    )
    res.end(
      req.url === paths.proof
        ? proofPage(bundle, 'test-only')
        : announcement(bundle),
    )
  })
  return () => requests
}
function recert(kind: 'same-key' | 'wrong-key' | 'wrong-san' | 'expired'): {
  key: Buffer
  cert: Buffer
} {
  const privatePath =
    kind === 'wrong-key'
      ? join(root, 'other.key')
      : join(bundle.runDir, 'leaf.key')
  if (kind === 'wrong-key') writeFileSync(privatePath, '', { mode: 0o600 })
  openssl(
    [
      'req',
      '-new',
      ...(kind === 'wrong-key'
        ? ['-newkey', 'rsa:2048', '-nodes', '-keyout', privatePath]
        : ['-key', privatePath]),
      '-out',
      join(root, 'other.csr'),
      '-subj',
      '/CN=Test replacement',
    ],
    root,
  )
  writeFileSync(
    join(root, 'ext'),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${
      kind === 'wrong-san' ? '127.0.0.2' : '127.0.0.1'
    }\n`,
    { mode: 0o600 },
  )
  if (kind === 'expired') {
    // `openssl ca` rather than `x509 -not_before/-not_after`: those two options need
    // OpenSSL 3.4, and the hosted runner (and LibreSSL) has an older one. `ca` has always
    // been able to set both dates.
    writeFileSync(join(root, 'index.txt'), '', { mode: 0o600 })
    writeFileSync(
      join(root, 'ca.cnf'),
      '[ca]\ndefault_ca=test_ca\n[test_ca]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ndefault_md=sha256\npolicy=any\nunique_subject=no\n[any]\ncommonName=supplied\n',
      { mode: 0o600 },
    )
    writeFileSync(join(root, 'serial'), '02\n', { mode: 0o600 })
    openssl(
      [
        'ca',
        '-batch',
        '-notext',
        '-config',
        join(root, 'ca.cnf'),
        '-cert',
        join(bundle.runDir, 'ca.pem'),
        '-keyfile',
        join(bundle.runDir, 'ca.key'),
        '-in',
        join(root, 'other.csr'),
        '-out',
        join(root, 'other.pem'),
        '-startdate',
        '20200101000000Z',
        '-enddate',
        '20200102000000Z',
        '-extfile',
        join(root, 'ext'),
      ],
      root,
    )
  } else
    openssl(
      [
        'x509',
        '-req',
        '-in',
        join(root, 'other.csr'),
        '-CA',
        join(bundle.runDir, 'ca.pem'),
        '-CAkey',
        join(bundle.runDir, 'ca.key'),
        '-set_serial',
        '2',
        '-out',
        join(root, 'other.pem'),
        '-days',
        '1',
        '-extfile',
        join(root, 'ext'),
      ],
      root,
    )
  return {
    key: readFileSync(privatePath),
    cert: readFileSync(join(root, 'other.pem')),
  }
}
test('real strict Node TLS succeeds and repeated probes use independent connections', async () => {
  const fixture = await startFixture(bundle, now)
  stop = fixture.stop
  await expect(checkNode(bundle, now)).resolves.toMatchObject({
    kind: 'synthetic-node-transport-proof',
  })
  await expect(checkNode(bundle, now + 1n)).resolves.toMatchObject({
    node: process.version,
  })
  await expect(
    checkNode(bundle, now + 1n, bundle.trustInputs.endpoint + '/wrong'),
  ).rejects.toThrow('Exact fixture')
})
test('fixture exposes only the fixed synthetic GET paths and exact Host', async () => {
  stop = (await startFixture(bundle, now)).stop
  const request = (path: string, method = 'GET', host?: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      get(
        bundle.trustInputs.endpoint + path,
        {
          agent: false,
          ca: bundle.tls.caPem,
          method,
          ...(host ? { headers: { Host: host } } : {}),
        },
        response => {
          response.resume()
          response.once('end', () => resolve(response.statusCode))
        },
      ).once('error', reject)
    })
  await expect(request(paths.health)).resolves.toBe(200)
  await expect(request('/directory')).resolves.toBe(404)
  await expect(request(paths.evidence + '?extra')).resolves.toBe(404)
  await expect(request(paths.evidence, 'POST')).resolves.toBe(400)
  await expect(request(paths.evidence, 'GET', '127.0.0.1:1')).resolves.toBe(400)
})
test.each(['same-key', 'wrong-key', 'wrong-san', 'expired'] as const)(
  'rejects real %s certificate with normal chain checks and independent pins',
  async kind => {
    const replacement = recert(kind)
    await serve(replacement.key, replacement.cert)
    await expect(checkNode(bundle, now)).rejects.toThrow(
      kind === 'wrong-san'
        ? /altname|IP|Hostname/
        : kind === 'expired'
        ? /expired/
        : /pin mismatch/,
    )
  },
)
test('unrelated self-signed/other CA certificate fails before response authority', async () => {
  const other = initBundle({
    mode: 'synthetic-demo',
    runDir: join(root, 'directory-trust-other'),
    trustInputs: bundle.trustInputs,
    nowNs: now,
  })
  await serve(
    readFileSync(join(other.runDir, 'leaf.key')),
    readFileSync(join(other.runDir, 'leaf.pem')),
  )
  await expect(checkNode(bundle, now)).rejects.toThrow(
    /certificate|issuer|signature/,
  )
})
test('matching TLS certificate cannot authenticate a different relay tuple', async () => {
  const wrong = JSON.parse(announcement(bundle))
  wrong.trustInputs.relayId = 'ff'.repeat(16)
  await serve(key(), cert(), JSON.stringify(wrong))
  await expect(checkNode(bundle, now)).rejects.toThrow(
    'tuple/evidence mismatch',
  )
  await expect(checkBrowser(bundle, now, '/missing/browser')).rejects.toThrow(
    'tuple/evidence mismatch',
  )
})
test('rejects redirects without following them', async () => {
  await serve(key(), cert(), '', true)
  await expect(checkNode(bundle, now)).rejects.toThrow('redirect rejected')
})
test('missing Chromium is actionable failure, never a successful proof', async () => {
  stop = (await startFixture(bundle, now)).stop
  await expect(checkBrowser(bundle, now, '/missing/chromium')).rejects.toThrow(
    'browser not verified',
  )
})

// Opt in explicitly when holding the shared actual-browser gate lease.
const browserTest = process.env.DIRECTORY_TRUST_CHROMIUM ? test : test.skip
browserTest(
  'actual fresh Chromium success, no/wrong leaf pin negatives, profile cleanup and limited flags',
  async () => {
    stop = (await startFixture(bundle, now)).stop
    const executable = process.env.DIRECTORY_TRUST_CHROMIUM!
    const result = await checkBrowser(bundle, now, executable)
    expect(result.kind).toBe('synthetic-chromium-spki-transport-proof')
    expect(result.limitation).toContain('not general PKI')
    await stop()
    const requestCount = observeProofRequests(await serve(key(), cert()))
    const proof = await probeChromium(
      bundle,
      executable,
      bundle.tls.leafSpkiSha256,
    )
    expect(existsSync(proof.profile)).toBe(false)
    expect(() => process.kill(-proof.pid, 0)).toThrow()
    expect(proof.args).toContain(
      `--ignore-certificate-errors-spki-list=${bundle.tls.leafSpkiSha256}`,
    )
    expect(proof.args).not.toContain('--ignore-certificate-errors')
    const successfulRequests = requestCount()
    expect(successfulRequests).toBeGreaterThanOrEqual(2)
    // Require certificate-network-error evidence as well as zero HTTP requests;
    // a timeout by itself cannot establish the negative certificate proof.
    await expect(probeChromium(bundle, executable, null)).rejects.toThrow(
      /Chromium rejected certificate \(net_error -20[0-9]\)/,
    )
    expect(requestCount()).toBe(successfulRequests)
    await expect(
      probeChromium(bundle, executable, Buffer.alloc(32).toString('base64')),
    ).rejects.toThrow(/Chromium rejected certificate \(net_error -20[0-9]\)/)
    expect(requestCount()).toBe(successfulRequests)
    await expect(
      probeChromium(
        {
          ...bundle,
          trustInputs: { ...bundle.trustInputs, relayId: 'ff'.repeat(16) },
        },
        executable,
        bundle.tls.leafSpkiSha256,
      ),
    ).rejects.toThrow('did not prove')
    await expect(
      probeChromium(
        {
          ...bundle,
          trustInputs: {
            ...bundle.trustInputs,
            endpoint: `https://127.0.0.1:${await freePort()}`,
          },
        },
        executable,
        bundle.tls.leafSpkiSha256,
      ),
    ).rejects.toThrow(/did not prove|timed out/)
    console.log(
      JSON.stringify({
        node: result.node,
        chromium: result.chromium,
        openssl: openssl(['version'], root),
        browser: result.kind,
        profileRemoved: true,
      }),
    )
  },
  180000,
)
browserTest(
  'actual Chromium rejects unrelated self-signed leaf; Node preflight rejects a same-key reissue',
  async () => {
    const executable = process.env.DIRECTORY_TRUST_CHROMIUM!
    writeFileSync(join(root, 'self.key'), '', { mode: 0o600 })
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'self.key',
        '-out',
        'self.pem',
        '-days',
        '1',
        '-subj',
        '/CN=Unrelated synthetic leaf',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      root,
    )
    const unrelated = await serve(
      readFileSync(join(root, 'self.key')),
      readFileSync(join(root, 'self.pem')),
    )
    const requestCount = observeProofRequests(unrelated)
    await expect(
      probeChromium(bundle, executable, bundle.tls.leafSpkiSha256),
    ).rejects.toThrow(/Chromium rejected certificate \(net_error -20[0-9]\)/)
    expect(requestCount()).toBe(0)
    await expect(checkBrowser(bundle, now, executable)).rejects.toThrow(
      /certificate|issuer|signature/,
    )
    await stop?.()
    stop = undefined
    const replacement = recert('same-key')
    const server = await serve(replacement.key, replacement.cert)
    observeProofRequests(server)
    await expect(checkBrowser(bundle, now, executable)).rejects.toThrow(
      'pin mismatch',
    )
    // Deliberately bypass preflight only in this internal regression: Chromium's
    // SPKI flag cannot distinguish this same-key reissue, so the public API must.
    await expect(
      probeChromium(bundle, executable, bundle.tls.leafSpkiSha256),
    ).resolves.toBeDefined()
  },
  60000,
)
