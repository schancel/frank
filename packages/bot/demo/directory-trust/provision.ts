import { spawnSync } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  ECDH,
  X509Certificate,
} from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { verifyPreviewDirectoryEvidence } from '@frank/codec'

export interface TrustInputs {
  network: string
  subject: string
  rev0T1: string
  relayId: string
  relayIdentity: { keyType: 1; point: string }
  endpoint: string
  bindingExpiryNs: bigint
}
export interface BundleRef {
  runDir: string
  manifestIdentity: string
}
export interface TrustBundle extends BundleRef {
  kind: 'synthetic-directory-trust-inputs'
  trustInputs: TrustInputs
  witnessHex?: string
  tls: { caPem: string; leafSha256: string; leafSpkiSha256: string }
}
interface Manifest {
  format: 'frank-synthetic-directory-trust-v1'
  runDir: string
  trust: Omit<TrustInputs, 'bindingExpiryNs'> & { bindingExpiryNs: string }
  initialNowNs: string
  witnessHex?: string
  files: Record<string, string>
  leafSha256: string
  leafSpkiSha256: string
}
const tlsFiles = ['ca.key', 'ca.pem', 'leaf.key', 'leaf.pem']
const files = ['manifest.json', 'clock', ...tlsFiles]
const scratch = ['leaf.csr', 'extensions.cnf']
export const paths = {
  health: '/fixture/health',
  evidence: '/fixture/evidence',
  proof: '/fixture/proof',
} as const
export const sha256 = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
export const spki = (cert: X509Certificate) =>
  createHash('sha256')
    .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64')

export function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,28})$/.test(value))
    throw new Error('Expected canonical unsigned nanosecond decimal string')
  return BigInt(value)
}
export function endpoint(value: unknown): URL {
  if (
    typeof value !== 'string' ||
    !/^https:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(value)
  )
    throw new Error('Endpoint must be exact https://127.0.0.1:<explicit-port>')
  const port = Number(value.slice(value.lastIndexOf(':') + 1))
  if (port > 65535) throw new Error('Invalid endpoint port')
  return new URL(value)
}
function hex(value: unknown, size: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value)
  )
    throw new Error('Invalid canonical public hex input')
}
function point(value: unknown): asserts value is string {
  hex(value, 33)
  if (!/^(02|03)/.test(value))
    throw new Error('Expected compressed key-type-1 point')
  try {
    ECDH.convertKey(Buffer.from(value, 'hex'), 'secp256k1')
  } catch {
    throw new Error('Invalid key-type-1 point')
  }
}
export function validateTrust(
  trust: TrustInputs,
  nowNs: bigint,
  witnessHex?: string,
): void {
  if (
    !trust ||
    typeof trust.network !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trust.network)
  )
    throw new Error('Explicit canonical network required')
  point(trust.subject)
  hex(trust.rev0T1, 32)
  hex(trust.relayId, 16)
  if (trust.relayIdentity?.keyType !== 1)
    throw new Error('Explicit key-type-1 relay identity required')
  point(trust.relayIdentity.point)
  endpoint(trust.endpoint)
  if (
    typeof nowNs !== 'bigint' ||
    nowNs < 0n ||
    typeof trust.bindingExpiryNs !== 'bigint' ||
    trust.bindingExpiryNs <= nowNs
  )
    throw new Error('Explicit bigint clock and unexpired binding required')
  decimal(nowNs.toString())
  decimal(trust.bindingExpiryNs.toString())
  if (witnessHex !== undefined) {
    if (
      typeof witnessHex !== 'string' ||
      witnessHex.length > 524288 ||
      !/^(?:[0-9a-f]{2})+$/.test(witnessHex)
    )
      throw new Error('Invalid bounded witness hex')
    const evidence = verifyPreviewDirectoryEvidence(
      Buffer.from(witnessHex, 'hex'),
      trust.network,
    )
    const s = evidence.statement
    if (
      Buffer.from(evidence.statementHash).toString('hex') !== trust.rev0T1 ||
      Buffer.from(s.subject.keyBytes).toString('hex') !== trust.subject ||
      s.subject.keyType !== 1 ||
      s.revision !== 0n ||
      s.preview.mailboxKeyGeneration !== 0n ||
      s.preview.stampKeyGeneration !== 0n ||
      s.preview.predecessor !== null
    )
      throw new Error(
        'Witness differs from independently supplied revision-zero anchor',
      )
  }
}
export function trustJSON(trust: TrustInputs): Manifest['trust'] {
  return {
    network: trust.network,
    subject: trust.subject,
    rev0T1: trust.rev0T1,
    relayId: trust.relayId,
    relayIdentity: { keyType: 1, point: trust.relayIdentity.point },
    endpoint: trust.endpoint,
    bindingExpiryNs: trust.bindingExpiryNs.toString(),
  }
}
export function parseTrust(value: unknown): TrustInputs {
  if (!value || typeof value !== 'object')
    throw new Error('Explicit trust object required')
  const t = value as Manifest['trust']
  return { ...t, bindingExpiryNs: decimal(t.bindingExpiryNs) }
}
function location(input: string): string {
  if (
    typeof input !== 'string' ||
    !isAbsolute(input) ||
    basename(input).length < 3
  )
    throw new Error('Explicit absolute run directory required')
  const path = resolve(input)
  const parent = realpathSync(dirname(path))
  const result = join(parent, basename(path))
  if (
    !basename(path).startsWith('directory-trust-') ||
    result === homedir() ||
    result.split('/').includes('.frank-demo')
  )
    throw new Error(
      'Run directory must be a dedicated directory-trust-* child, outside normal demo state',
    )
  return result
}
function regular(path: string): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new Error('Unsafe fixture file type or permissions')
  if (stat.size > 600000) throw new Error('Oversized fixture file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}
function directory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Unsafe fixture directory')
  const allowed = new Set([...files, '.operation', '.listener'])
  if (readdirSync(path).some(name => !allowed.has(name)))
    throw new Error('Unrelated or incomplete fixture contents')
}
function exclusive<T>(path: string, action: () => T): T {
  const lock = join(path, '.operation')
  const fd = openSync(lock, 'wx', 0o600)
  try {
    return action()
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}
export function openssl(args: string[], cwd: string): string {
  const result = spawnSync('openssl', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0)
    throw new Error(
      'OpenSSL failed; installed openssl with req/x509 support is required',
    )
  return result.stdout.trim()
}
export function initBundle(options: {
  mode: 'synthetic-demo'
  runDir: string
  trustInputs: TrustInputs
  nowNs: bigint
  witnessHex?: string
}): TrustBundle {
  if (options.mode !== 'synthetic-demo')
    throw new Error('Explicit synthetic-demo mode required')
  validateTrust(options.trustInputs, options.nowNs, options.witnessHex)
  const runDir = location(options.runDir)
  openssl(['version'], dirname(runDir))
  mkdirSync(runDir, { mode: 0o700 }) // Existing directories, even empty ones, are never reset.
  try {
    // Precreate private outputs so OpenSSL cannot create a world-readable key.
    for (const name of [...tlsFiles, ...scratch])
      writeFileSync(join(runDir, name), '', { flag: 'wx', mode: 0o600 })
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-days',
        '2',
        '-subj',
        '/CN=Disposable directory fixture CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
      ],
      runDir,
    )
    openssl(
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'leaf.key',
        '-out',
        'leaf.csr',
        '-subj',
        '/CN=Disposable loopback fixture',
      ],
      runDir,
    )
    writeFileSync(
      join(runDir, 'extensions.cnf'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
      { mode: 0o600 },
    )
    openssl(
      [
        'x509',
        '-req',
        '-in',
        'leaf.csr',
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-set_serial',
        '1',
        '-out',
        'leaf.pem',
        '-days',
        '1',
        '-extfile',
        'extensions.cnf',
      ],
      runDir,
    )
    for (const name of scratch) unlinkSync(join(runDir, name))
    const cert = new X509Certificate(regular(join(runDir, 'leaf.pem')))
    const manifest: Manifest = {
      format: 'frank-synthetic-directory-trust-v1',
      runDir,
      trust: trustJSON(options.trustInputs),
      initialNowNs: options.nowNs.toString(),
      ...(options.witnessHex === undefined
        ? {}
        : { witnessHex: options.witnessHex }),
      files: Object.fromEntries(
        tlsFiles.map(name => [name, sha256(regular(join(runDir, name)))]),
      ),
      leafSha256: sha256(cert.raw),
      leafSpkiSha256: spki(cert),
    }
    const bytes = JSON.stringify(manifest) + '\n'
    writeFileSync(join(runDir, 'clock'), options.nowNs.toString(), {
      flag: 'wx',
      mode: 0o600,
    })
    writeFileSync(join(runDir, 'manifest.json'), bytes, {
      flag: 'wx',
      mode: 0o600,
    })
    return reopenBundle(
      { runDir, manifestIdentity: sha256(bytes) },
      options.nowNs,
    )
  } catch (error) {
    // Only the exact files we created; never recursive deletion on a caller path.
    for (const name of [...files, ...scratch])
      if (existsSync(join(runDir, name))) unlinkSync(join(runDir, name))
    rmdirSync(runDir)
    throw error
  }
}
function readBundle(
  ref: BundleRef,
  nowNs: bigint,
  update: boolean,
): TrustBundle {
  const runDir = location(ref.runDir)
  directory(runDir)
  hex(ref.manifestIdentity, 32)
  const bytes = regular(join(runDir, 'manifest.json'))
  if (sha256(bytes) !== ref.manifestIdentity)
    throw new Error('Manifest identity mismatch')
  const m = JSON.parse(bytes.toString()) as Manifest
  if (
    m.format !== 'frank-synthetic-directory-trust-v1' ||
    m.runDir !== runDir ||
    Object.keys(m.files).sort().join() !== [...tlsFiles].sort().join()
  )
    throw new Error('Invalid fixture manifest')
  const trustInputs = parseTrust(m.trust)
  validateTrust(trustInputs, nowNs, m.witnessHex)
  const last = decimal(regular(join(runDir, 'clock')).toString())
  if (last < decimal(m.initialNowNs) || nowNs < last)
    throw new Error('Directory clock rollback')
  for (const name of tlsFiles)
    if (sha256(regular(join(runDir, name))) !== m.files[name])
      throw new Error('TLS file identity mismatch')
  const caPem = regular(join(runDir, 'ca.pem')).toString()
  const ca = new X509Certificate(caPem)
  const cert = new X509Certificate(regular(join(runDir, 'leaf.pem')))
  if (
    !ca.ca ||
    !cert.verify(ca.publicKey) ||
    sha256(cert.raw) !== m.leafSha256 ||
    spki(cert) !== m.leafSpkiSha256
  )
    throw new Error('TLS certificate mismatch')
  for (const name of ['ca', 'leaf']) {
    const key = createPublicKey(
      createPrivateKey(regular(join(runDir, `${name}.key`))),
    ).export({ type: 'spki', format: 'der' })
    const expected = (name === 'ca' ? ca : cert).publicKey.export({
      type: 'spki',
      format: 'der',
    })
    if (!key.equals(expected)) throw new Error('TLS key mismatch')
  }
  if (update && nowNs > last) {
    // An interrupted write leaves a detectable incomplete bundle, never fresh trust.
    writeFileSync(join(runDir, 'clock.next'), nowNs.toString(), {
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(join(runDir, 'clock.next'), join(runDir, 'clock'))
  }
  return {
    kind: 'synthetic-directory-trust-inputs',
    runDir,
    manifestIdentity: ref.manifestIdentity,
    trustInputs,
    ...(m.witnessHex === undefined ? {} : { witnessHex: m.witnessHex }),
    tls: { caPem, leafSha256: m.leafSha256, leafSpkiSha256: m.leafSpkiSha256 },
  }
}
export function reopenBundle(ref: BundleRef, nowNs: bigint): TrustBundle {
  const runDir = location(ref.runDir)
  directory(runDir)
  return exclusive(runDir, () => readBundle(ref, nowNs, true))
}
export function disposeBundle(ref: BundleRef, nowNs: bigint): void {
  const runDir = location(ref.runDir)
  directory(runDir)
  exclusive(runDir, () => {
    if (existsSync(join(runDir, '.listener')))
      throw new Error('Stop the owned listener before disposal')
    readBundle(ref, nowNs, false)
    for (const name of files) unlinkSync(join(runDir, name))
  })
  rmdirSync(runDir)
}
/** Private to the fixture listener; keys are never part of the public facade result. */
export function listenerMaterial(ref: BundleRef, nowNs: bigint) {
  const runDir = location(ref.runDir)
  directory(runDir)
  // Disposal uses this same critical section. Keep validated state protected
  // until the listener reservation exists and all TLS material has been read.
  return exclusive(runDir, () => {
    const bundle = readBundle(ref, nowNs, true)
    const lock = join(runDir, '.listener')
    const fd = openSync(lock, 'wx', 0o600)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        closeSync(fd)
        unlinkSync(lock)
      }
    }
    try {
      return {
        bundle,
        key: regular(join(runDir, 'leaf.key')),
        cert: regular(join(runDir, 'leaf.pem')),
        release,
      }
    } catch (e) {
      release()
      throw e
    }
  })
}
