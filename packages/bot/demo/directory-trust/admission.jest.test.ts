import { createServer } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SigningKey } from 'ethers'
import {
  contentHash,
  directorySignatureDigest,
  encodeFrame,
  fromHex,
  previewDirectoryContext,
  toHex,
  validateFrame,
} from '@frank/codec'
import type { FrankValue, ParsedFrame } from '@frank/codec'
import type { Candidate, Current } from '@frank/directory-admission'
import {
  initBundle,
  reopenBundle,
  startFixture,
  type TrustBundle,
  type TrustInputs,
} from './index'
import { openDemoNodeAdmission } from './admission'
import {
  admissionContext,
  assertInstalledParticipants,
  candidateSnapshot,
  continuityJSON,
  parseContinuity,
  openDemoBrowserAdmission,
  splitTime,
  trustJSON,
} from './browser-admission'

const filesystem = require('node:fs') as typeof import('node:fs')

const source = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../docs/protocol/cbor/vectors/directory-preview.json',
    ),
    'utf8',
  ),
)
const original = source.records.find(
  (record: { id: string }) => record.id === 'bootstrap',
)
const subject =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const now = 1700000100000000001n
const timestamp = (ns: bigint) =>
  new Map([
    [0n, ns / 1000000000n],
    [1n, ns % 1000000000n],
  ])
function parsed(bytes: Uint8Array): ParsedFrame {
  const frame = validateFrame(bytes, previewDirectoryContext())
  if (frame.kind !== 'parsed')
    throw new Error('Expected parsed synthetic frame')
  return frame
}
function derInteger(hex: string): Buffer {
  let bytes = Buffer.from(hex.slice(2), 'hex')
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1)
  if (bytes[0] & 128) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return Buffer.concat([Buffer.from([2, bytes.length]), bytes])
}
/** Only synthetic test signing. The expected anchor is installed before fixture/network use. */
function signed(
  trust: TrustInputs,
  revision = 0,
  predecessor: Uint8Array | null = null,
  stamp = 3,
  generation = 0,
): Candidate {
  const originalPayload = parsed(fromHex(original.type4_hex)).payload
  if (!(originalPayload instanceof Map))
    throw new Error('Expected directory map')
  const payload = new Map<bigint, FrankValue>(originalPayload)
  payload.set(2n, BigInt(revision))
  payload.set(3n, timestamp(now - 1000000000n))
  payload.set(6n, timestamp(now + 300000000000n))
  payload.set(4n, [
    new Map<bigint, FrankValue>([
      [0n, fromHex(trust.relayId)],
      [1n, trust.endpoint],
      [
        2n,
        new Map<bigint, FrankValue>([
          [0n, 1n],
          [1n, fromHex(trust.relayIdentity.point)],
        ]),
      ],
      [3n, timestamp(trust.bindingExpiryNs)],
    ]),
  ])
  const stampPoint = new SigningKey('0x' + stamp.toString(16).padStart(64, '0'))
    .compressedPublicKey
  payload.set(
    8n,
    new Map<bigint, FrankValue>([
      [0n, 1n],
      [1n, fromHex(stampPoint.slice(2))],
    ]),
  )
  payload.set(12n, BigInt(generation))
  payload.set(13n, predecessor)
  const statement = encodeFrame(
    { typeId: 4, schemaVersion: 4, minReaderVersion: 4 },
    payload,
  )
  const signer = new SigningKey('0x' + '1'.padStart(64, '0'))
  const signature = signer.sign(
    '0x' + toHex(directorySignatureDigest(trust.network, statement)),
  )
  const integers = Buffer.concat([
    derInteger(signature.r),
    derInteger(signature.s),
  ])
  const der = Buffer.concat([Buffer.from([48, integers.length]), integers])
  const attestation = encodeFrame(
    { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
    new Map<bigint, FrankValue>([
      [0n, statement],
      [
        1n,
        [
          new Map<bigint, FrankValue>([
            [0n, 1n],
            [1n, payload.get(1n)!],
            [2n, der],
          ]),
        ],
      ],
    ]),
  )
  return { statement, attestation }
}
const hash = (c: Candidate) => contentHash(parsed(c.statement))
const summary = (current: Current) => ({
  kind: current.kind,
  head: toHex(current.evidence.hash),
  statement: toHex(current.evidence.statement),
  attestation: toHex(current.evidence.attestation),
  message: toHex(current.messageKey.keyBytes),
  stamp: toHex(current.stampKey.keyBytes),
  previous: current.previousStamp
    ? toHex(current.previousStamp.keyBytes)
    : null,
  revision: current.revision.toString(),
  generations: current.generations.map(String),
  accepted: current.status.accepted,
  retained: current.status.retained,
  charged: current.status.chargedBytes,
  checkpoint: JSON.parse(
    continuityJSON(
      {
        manifestIdentity: bundle.manifestIdentity,
        trustInputs: trust,
        witnessHex: bundle.witnessHex!,
      },
      current.status.checkpoint,
    ),
  ).checkpoint,
})
let root: string,
  bundle: TrustBundle,
  trust: TrustInputs,
  bootstrap: Candidate,
  rotation: Candidate
let fixture: Awaited<ReturnType<typeof startFixture>>
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'frank-demo-admission-'))
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  trust = {
    network: 'monad-testnet',
    subject,
    rev0T1: '00'.repeat(32),
    relayId: '000102030405060708090a0b0c0d0e0f',
    relayIdentity: { keyType: 1, point: subject },
    endpoint: `https://127.0.0.1:${port}`,
    bindingExpiryNs: now + 600000000000n,
  }
  bootstrap = signed(trust)
  trust.rev0T1 = toHex(hash(bootstrap))
  rotation = signed(trust, 1, hash(bootstrap), 5, 1)
  bundle = initBundle({
    mode: 'synthetic-demo',
    runDir: join(root, 'directory-trust-run'),
    trustInputs: trust,
    nowNs: now,
    witnessHex: toHex(bootstrap.attestation),
  })
  fixture = await startFixture(bundle, now)
}, 15000)
afterEach(async () => {
  jest.restoreAllMocks()
  await fixture?.stop()
  rmSync(root, { recursive: true, force: true })
})
const options = (mode: 'new' | 'reopen' = 'new') => ({
  bundle,
  installed: trust,
  location: join(root, 'admission.level'),
  continuityFile: join(root, 'continuity.json'),
  mode,
  nowNs: now,
})

test.each([
  'level-child',
  'level-root',
  'continuity-child',
  'continuity-root',
  'aliased-parent',
] as const)(
  'immutable bundle rejects writable %s targets before creating any admission artifacts',
  async kind => {
    const installedFiles = filesystem.readdirSync(bundle.runDir).sort()
    const inside = join(bundle.runDir, 'consumer-state')
    const input = options()
    if (kind === 'level-child') input.location = inside
    if (kind === 'level-root') input.location = bundle.runDir
    if (kind === 'continuity-child') input.continuityFile = inside
    if (kind === 'continuity-root') input.continuityFile = bundle.runDir
    if (kind === 'aliased-parent') {
      const alias = join(root, 'bundle-alias')
      filesystem.symlinkSync(bundle.runDir, alias, 'dir')
      input.continuityFile = join(alias, 'consumer-state')
    }
    const rejected = await openDemoNodeAdmission(input).then(
      async store => {
        await store.close()
        return null
      },
      error => error,
    )
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected.message).toContain('immutable trust bundle')
    expect(filesystem.readdirSync(bundle.runDir).sort()).toEqual(installedFiles)
    expect(existsSync(inside)).toBe(false)
    expect(existsSync(options().location)).toBe(false)
    expect(existsSync(options().continuityFile)).toBe(false)
    expect(reopenBundle(bundle, now).manifestIdentity).toBe(
      bundle.manifestIdentity,
    )
    const valid = await openDemoNodeAdmission(options())
    await valid.enroll([bootstrap], now)
    await valid.close()
    const reopened = await openDemoNodeAdmission(options('reopen'))
    try {
      expect((await reopened.current(now)).evidence.hash).toEqual(
        hash(bootstrap),
      )
    } finally {
      await reopened.close()
    }
    expect(reopenBundle(bundle, now).manifestIdentity).toBe(
      bundle.manifestIdentity,
    )
  },
)

test('browser public transport accepts serialized default port without changing the signed tuple', async () => {
  const explicit = { ...trust, endpoint: 'https://127.0.0.1:443' }
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://127.0.0.1' },
  })
  const response = new Response(
    JSON.stringify({
      kind: 'synthetic-directory-evidence',
      trustInputs: trustJSON(explicit),
      witnessHex: bundle.witnessHex,
    }),
  )
  Object.defineProperty(response, 'url', {
    value: 'https://127.0.0.1/fixture/evidence',
  })
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response)
  const savedNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  )
  const lockRequest = jest.fn(
    (
      name: string,
      options: { mode: LockMode },
      callback: (lock: Lock) => Promise<void>,
    ) => callback({ name, mode: options.mode }),
  )
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: lockRequest } },
  })
  try {
    // This light boundary test deliberately has no IndexedDB. Reaching the
    // public store's unavailable result proves transport normalization only;
    // real admitted/restarted Chromium proof is separately lease-gated.
    await expect(
      openDemoBrowserAdmission({
        name: 'explicit-443',
        installation: {
          manifestIdentity: bundle.manifestIdentity,
          trustInputs: explicit,
          witnessHex: bundle.witnessHex!,
        },
        nowNs: now,
        mode: { kind: 'new' },
        saveContinuity: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(fetcher).toHaveBeenCalledWith(
      'https://127.0.0.1:443/fixture/evidence',
      expect.any(Object),
    )
    expect(explicit.endpoint).toBe('https://127.0.0.1:443')
    expect(lockRequest).toHaveBeenCalledWith(
      'frank-demo-directory-continuity-owner:v1',
      { mode: 'exclusive', ifAvailable: true },
      expect.any(Function),
    )
    await expect(lockRequest.mock.results[0].value).resolves.toBeUndefined()
  } finally {
    if (savedLocation)
      Object.defineProperty(globalThis, 'location', savedLocation)
    else Reflect.deleteProperty(globalThis, 'location')
    if (savedNavigator)
      Object.defineProperty(globalThis, 'navigator', savedNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})

test.each(['missing', 'occupied'] as const)(
  'browser ownership fails closed when %s, before transport or opening a store',
  async state => {
    const savedNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      'navigator',
    )
    const request = jest.fn(
      (
        _name: string,
        _options: unknown,
        callback: (lock: null) => Promise<void>,
      ) => callback(null),
    )
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: state === 'missing' ? {} : { locks: { request } },
    })
    const fetcher = jest.spyOn(globalThis, 'fetch')
    try {
      await expect(
        openDemoBrowserAdmission({
          name: 'other-namespace',
          installation: {
            manifestIdentity: bundle.manifestIdentity,
            trustInputs: trust,
            witnessHex: bundle.witnessHex!,
          },
          nowNs: now,
          mode: { kind: 'new' },
          saveContinuity: async () => {},
        }),
      ).rejects.toThrow('Exclusive demo continuity ownership unavailable')
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      if (savedNavigator)
        Object.defineProperty(globalThis, 'navigator', savedNavigator)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  },
)

test('real TLS/public Node admission persists exact roles, counters and external continuity across reopen', async () => {
  let store = await openDemoNodeAdmission(options())
  const installation = {
    manifestIdentity: bundle.manifestIdentity,
    trustInputs: trust,
    witnessHex: bundle.witnessHex!,
  }
  try {
    const first = await store.enroll([bootstrap], now)
    expect(first.kind).toBe('current')
    expect(first.messageKey.keyBytes).not.toEqual(first.stampKey.keyBytes)
    const next = await store.advance([rotation], now)
    expect(next.previousStamp).toEqual(first.stampKey)
    expect(next.generations).toEqual([0n, 1n])
    const text = readFileSync(options().continuityFile, 'utf8')
    expect(parseContinuity(text, installation)).toEqual(next.status.checkpoint)
    expect(continuityJSON(installation, next.status.checkpoint)).toBe(text)
    const expected = summary(next)
    await store.close()
    store = await openDemoNodeAdmission(options('reopen'))
    expect(summary(await store.current(now))).toEqual(expected)
    expect((await store.historicalEvidence(hash(bootstrap)))?.kind).toBe(
      'historical-evidence',
    )
  } finally {
    await store.close()
  }
})
test('new invocation owns byte views before asynchronous transport; whole-batch bounds do not truncate', async () => {
  const store = await openDemoNodeAdmission(options())
  try {
    const supplied = {
      statement: new Uint8Array(
        new SharedArrayBuffer(bootstrap.statement.length),
      ),
      attestation: new Uint8Array(
        new SharedArrayBuffer(bootstrap.attestation.length),
      ),
    }
    supplied.statement.set(bootstrap.statement)
    supplied.attestation.set(bootstrap.attestation)
    const pending = store.enroll([supplied], now)
    supplied.statement.fill(0)
    supplied.attestation.fill(0)
    expect((await pending).evidence.hash).toEqual(hash(bootstrap))
    expect(() => store.advance(new Array(4097).fill(rotation), now)).toThrow(
      'batch limit',
    )
    expect(() =>
      candidateSnapshot([
        { statement: new Uint8Array(262145), attestation: new Uint8Array() },
      ]),
    ).toThrow('frame limit')
    expect((await store.status())?.accepted).toBe(1)
  } finally {
    await store.close()
  }
})
test('missing/mismatched installed inputs and incomplete participant configuration never activate', async () => {
  for (const installed of [
    undefined,
    { ...trust, subject: '00'.repeat(33) },
    { ...trust, rev0T1: 'ff'.repeat(32) },
    { ...trust, relayId: 'ff'.repeat(16) },
    { ...trust, endpoint: 'https://127.0.0.1:1' },
    { ...trust, network: 'other-network' },
  ])
    await expect(
      openDemoNodeAdmission({
        ...options(),
        installed: installed as TrustInputs,
      }),
    ).rejects.toThrow()
  expect(existsSync(options().location)).toBe(false)
  expect(() =>
    assertInstalledParticipants(trust, {
      'relay-a': trust,
      'relay-b': null,
      'bot': trust,
    }),
  ).toThrow('pending')
  expect(() =>
    assertInstalledParticipants(trust, {
      'relay-a': trust,
      'relay-b': trust,
      'bot': { ...trust, rev0T1: 'ff'.repeat(32) },
    }),
  ).toThrow('mismatched')
  expect(() =>
    assertInstalledParticipants(trust, {
      'relay-a': trust,
      'relay-b': trust,
      'bot': trust,
    }),
  ).not.toThrow()
})
test('explicit missing/corrupt reopen cannot rebootstrap or replace neighboring state', async () => {
  writeFileSync(join(root, 'neighbor'), 'untouched')
  await expect(openDemoNodeAdmission(options('reopen'))).rejects.toThrow()
  const store = await openDemoNodeAdmission(options())
  await store.enroll([bootstrap], now)
  await store.close()
  await expect(openDemoNodeAdmission(options())).rejects.toThrow(
    'Existing continuity',
  )
  writeFileSync(options().continuityFile, '{')
  await expect(openDemoNodeAdmission(options('reopen'))).rejects.toThrow()
  expect(readFileSync(join(root, 'neighbor'), 'utf8')).toBe('untouched')
})
test('stale clock rejects with no usable result and no head advancement', async () => {
  const store = await openDemoNodeAdmission(options())
  try {
    await store.enroll([bootstrap], now)
    await expect(store.current(now - 1n)).rejects.toThrow('rollback')
    expect((await store.status())?.accepted).toBe(1)
    expect(() => splitTime(-1n)).toThrow()
    expect(() => admissionContext(trust, 1n << 100n)).toThrow()
  } finally {
    await store.close()
  }
})

test('retained external continuity cannot reopen a missing or corrupt dedicated store', async () => {
  const store = await openDemoNodeAdmission(options())
  await store.enroll([bootstrap], now)
  await store.close()
  filesystem.renameSync(options().location, join(root, 'saved-admission.level'))
  await expect(openDemoNodeAdmission(options('reopen'))).rejects.toThrow()
  expect(existsSync(options().location)).toBe(false)
  filesystem.renameSync(join(root, 'saved-admission.level'), options().location)
  writeFileSync(join(options().location, 'CURRENT'), 'not-a-manifest\n')
  await expect(openDemoNodeAdmission(options('reopen'))).rejects.toThrow()
  expect(
    JSON.parse(readFileSync(options().continuityFile, 'utf8')).checkpoint.kind,
  ).toBe('CommittedPrefix')
})

test('manifest substitution and mismatched supplied witness fail before a usable result', async () => {
  await expect(
    openDemoNodeAdmission({
      ...options(),
      bundle: { ...bundle, manifestIdentity: '00'.repeat(32) },
    }),
  ).rejects.toThrow()
  expect(existsSync(options().location)).toBe(false)
  const store = await openDemoNodeAdmission(options())
  try {
    await expect(store.enroll([rotation], now)).rejects.toThrow(
      'enrollment witness',
    )
    expect(await store.status()).toBeNull()
    expect(existsSync(options().continuityFile)).toBe(false)
  } finally {
    await store.close()
  }
})

test('failed prospective save exposes no enrolled head and never retries as a new user', async () => {
  const store = await openDemoNodeAdmission(options())
  try {
    // A competing public continuity file cannot be overwritten by enrollment.
    writeFileSync(options().continuityFile, 'reserved', { flag: 'wx' })
    await expect(store.enroll([bootstrap], now)).rejects.toThrow('EEXIST')
    expect(await store.status()).toBeNull()
    await expect(store.enroll([bootstrap], now)).rejects.toThrow(
      'explicitly reopen',
    )
  } finally {
    await store.close()
  }
  await expect(openDemoNodeAdmission(options('reopen'))).rejects.toThrow()
})
test('lost checkpoint acknowledgement exposes no result; last prospective prefix reopens committed descendant', async () => {
  let store = await openDemoNodeAdmission(options())
  try {
    const rename = filesystem.renameSync
    jest
      .spyOn(filesystem, 'renameSync')
      .mockImplementation((source, target) => {
        if (target === join(realpathSync(root), 'continuity.json'))
          throw new Error('checkpoint-ack-failed')
        rename(source, target)
      })
    await expect(store.enroll([bootstrap, rotation], now)).rejects.toThrow(
      'checkpoint-ack-failed',
    )
    expect((await store.status())?.accepted).toBe(2)
    expect(
      JSON.parse(readFileSync(options().continuityFile, 'utf8')).checkpoint
        .kind,
    ).toBe('ProspectiveEnrollment')
    await expect(store.current(now)).rejects.toThrow('explicitly reopen')
    await store.close()
    jest.restoreAllMocks()
    store = await openDemoNodeAdmission(options('reopen'))
    expect((await store.current(now)).evidence.hash).toEqual(hash(rotation))
  } finally {
    await store.close()
  }
})
test('authenticated fork persists quarantine and its external checkpoint without a fresh head', async () => {
  let store = await openDemoNodeAdmission(options())
  try {
    await store.enroll([bootstrap, rotation], now)
    const competing = signed(trust, 1, hash(bootstrap), 6, 1)
    await expect(store.advance([competing], now)).rejects.toMatchObject({
      code: 'fork',
    })
    expect((await store.status())?.forked).toBe(true)
    expect(
      JSON.parse(readFileSync(options().continuityFile, 'utf8')).checkpoint
        .forked,
    ).toBe(true)
    await store.close()
    store = await openDemoNodeAdmission(options('reopen'))
    await expect(store.current(now)).rejects.toMatchObject({ code: 'fork' })
    expect(
      (await store.conflictEvidence()).every(
        row => row.kind === 'historical-evidence',
      ),
    ).toBe(true)
  } finally {
    await store.close()
  }
})
test('historical expired witness accepted by provisioning is never relabeled a fresh admission', async () => {
  await fixture.stop()
  const later = now + 4000000000000n
  trust = {
    ...trust,
    rev0T1: toHex(contentHash(parsed(fromHex(original.type4_hex)))),
    bindingExpiryNs: later + 600000000000n,
  }
  bundle = initBundle({
    mode: 'synthetic-demo',
    runDir: join(root, 'directory-trust-historical'),
    trustInputs: trust,
    nowNs: later,
    witnessHex: original.type2_hex,
  })
  fixture = await startFixture(bundle, later)
  const store = await openDemoNodeAdmission({ ...options(), nowNs: later })
  try {
    await expect(
      store.enroll(
        [
          {
            statement: fromHex(original.type4_hex),
            attestation: fromHex(original.type2_hex),
          },
        ],
        later,
      ),
    ).rejects.toMatchObject({ code: 'validity' })
    expect(await store.status()).toBeNull()
  } finally {
    await store.close()
  }
})

function child(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 20000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(command, args, {
      cwd: resolvePath(),
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    let force: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      processChild.kill('SIGTERM')
      force = setTimeout(() => processChild.kill('SIGKILL'), 20000)
    }, timeoutMs)
    processChild.stdout.on('data', bytes => {
      output += bytes
      if (output.length > 100000) processChild.kill('SIGKILL')
    })
    processChild.stderr.on('data', bytes => {
      output += bytes
      if (output.length > 100000) processChild.kill('SIGKILL')
    })
    processChild.once('error', error => {
      clearTimeout(timer)
      clearTimeout(force)
      reject(error)
    })
    processChild.once('exit', code => {
      clearTimeout(timer)
      clearTimeout(force)
      if (timedOut) reject(new Error('Owned demo child timed out'))
      else if (code === 0) resolve(output)
      else reject(new Error(`Owned child exit ${code}: ${output}`))
    })
  })
}
const resolvePath = () => resolve(__dirname, '../..')
test('oversized public configuration rejects before admission or browser launch', async () => {
  const input = join(root, 'oversized-public.json')
  writeFileSync(input, Buffer.alloc(1048577, 32))
  await expect(
    child(
      process.execPath,
      ['--import', 'tsx', 'demo/demo.ts', '--directory-admission', input],
      { TSX_TSCONFIG_PATH: join(resolvePath(), 'tsconfig.json') },
    ),
  ).rejects.toThrow('Bounded public directory configuration')
  await expect(
    child(process.execPath, [
      join(__dirname, 'check-admission-browser.cjs'),
      input,
      '/nonexistent-owned-chromium',
    ]),
  ).rejects.toThrow('Bounded scenario')
  // Model a regular file growing after the initial metadata check. The fd read,
  // not that earlier size, must enforce the public input budget.
  const { main } = require('../demo') as {
    main(argv: string[], env: Record<string, string>): Promise<number>
  }
  const stat = filesystem.statSync
  jest.spyOn(filesystem, 'statSync').mockImplementation(((
    file: import('node:fs').PathLike,
    options?: unknown,
  ) => {
    const result = stat(file, options as any)
    return file === input
      ? new Proxy(result, {
          get: (target, key) => (key === 'size' ? 0 : Reflect.get(target, key)),
        })
      : result
  }) as typeof stat)
  await expect(main(['--directory-admission', input], {})).rejects.toThrow(
    'Bounded public directory configuration',
  )
  expect(existsSync(options().location)).toBe(false)
  expect(existsSync(options().continuityFile)).toBe(false)
})
test('exact demo source opt-in and independent process reopen preserve public identity without starting the normal stack', async () => {
  await fixture.stop()
  const configFile = join(root, 'public-config.json')
  const installed = trustJSON(trust)
  const config = {
    mode: 'synthetic-directory-admission',
    intent: 'new',
    nowNs: now.toString(),
    bundle: {
      runDir: bundle.runDir,
      manifestIdentity: bundle.manifestIdentity,
    },
    installed,
    participants: {
      'relay-a': installed,
      'relay-b': installed,
      'bot': installed,
    },
    location: options().location,
    continuityFile: options().continuityFile,
    statementHex: toHex(bootstrap.statement),
  }
  writeFileSync(join(root, 'neighbor'), 'unchanged')
  writeFileSync(configFile, JSON.stringify(config))
  const args = [
    '--import',
    'tsx',
    'demo/demo.ts',
    '--directory-admission',
    configFile,
  ]
  const env = { TSX_TSCONFIG_PATH: join(resolvePath(), 'tsconfig.json') }
  const first = await child(process.execPath, args, env)
  writeFileSync(configFile, JSON.stringify({ ...config, intent: 'reopen' }))
  const restarted = await child(process.execPath, args, env)
  const report = (output: string) =>
    JSON.parse(
      output
        .trim()
        .split('\n')
        .find(line =>
          line.startsWith('{"kind":"demo-directory-point-in-time"'),
        )!,
    )
  expect(report(first)).toEqual(report(restarted))
  expect(report(first)).toMatchObject({
    head: trust.rev0T1,
    runtimeRoutesChanged: false,
    topicWire: 'protobuf',
  })
  expect(existsSync(join(bundle.runDir, '.listener'))).toBe(false)
  expect(readFileSync(join(root, 'neighbor'), 'utf8')).toBe('unchanged')
}, 25000)

const browserTest = process.env.DIRECTORY_ADMISSION_CHROMIUM ? test : test.skip
const rustTest = process.env.DIRECTORY_ADMISSION_RUST_PROBE ? test : test.skip
rustTest(
  'real Rust TLS/public admission agrees exactly with Node and preserves restart/quarantine',
  async () => {
    const store = await openDemoNodeAdmission(options())
    let expected
    try {
      expected = summary(await store.enroll([bootstrap, rotation], now))
    } finally {
      await store.close()
    }
    const scenarioFile = join(root, 'rust-scenario.json')
    const config = {
      bundle: { ...bundle, trustInputs: trustJSON(trust) },
      manifestIdentity: bundle.manifestIdentity,
      installed: trustJSON(trust),
      nowNs: now.toString(),
      location: join(root, 'rust-admission'),
      continuityFile: join(root, 'rust-continuity.json'),
      mode: 'new',
      candidates: [bootstrap, rotation].map(c => ({
        statement: toHex(c.statement),
        attestation: toHex(c.attestation),
      })),
    }
    const probe = async (input: typeof config) => {
      writeFileSync(scenarioFile, JSON.stringify(input))
      return JSON.parse(
        await child(process.env.DIRECTORY_ADMISSION_RUST_PROBE!, [
          scenarioFile,
        ]),
      )
    }
    const immutableFiles = filesystem.readdirSync(bundle.runDir).sort()
    for (const target of [bundle.runDir, join(bundle.runDir, 'rust-state')]) {
      await expect(probe({ ...config, location: target })).rejects.toThrow(
        'bundle-path',
      )
      await expect(
        probe({ ...config, continuityFile: target }),
      ).rejects.toThrow('bundle-path')
    }
    const alias = join(root, 'rust-bundle-alias')
    filesystem.symlinkSync(bundle.runDir, alias, 'dir')
    await expect(
      probe({ ...config, continuityFile: join(alias, 'state') }),
    ).rejects.toThrow('bundle-path')
    expect(filesystem.readdirSync(bundle.runDir).sort()).toEqual(immutableFiles)
    expect(existsSync(config.location)).toBe(false)
    expect(existsSync(config.continuityFile)).toBe(false)
    expect(reopenBundle(bundle, now).manifestIdentity).toBe(
      bundle.manifestIdentity,
    )
    expect(await probe(config)).toEqual(expected)
    const reopen = { ...config, mode: 'reopen', candidates: [] }
    expect(await probe(reopen)).toEqual(expected)
    await expect(
      probe({ ...reopen, nowNs: (now - 1n).toString() }),
    ).rejects.toThrow()
    await expect(
      probe({ ...reopen, location: join(root, 'absent-rust') }),
    ).rejects.toThrow('unavailable')
    await expect(
      probe({ ...reopen, continuityFile: join(root, 'absent-continuity') }),
    ).rejects.toThrow('unavailable')
    await expect(
      probe({
        ...reopen,
        bundle: {
          ...config.bundle,
          tls: { ...bundle.tls, leafSha256: '00'.repeat(32) },
        },
      }),
    ).rejects.toThrow('tls-pin')
    await expect(
      probe({
        ...reopen,
        installed: { ...config.installed, network: 'monad-mainnet' },
      }),
    ).rejects.toThrow('trust')
    const conflict = signed(trust, 1, hash(bootstrap), 6, 1)
    await expect(
      probe({
        ...reopen,
        candidates: [
          {
            statement: toHex(conflict.statement),
            attestation: toHex(conflict.attestation),
          },
        ],
      }),
    ).rejects.toThrow('fork')
    expect(
      JSON.parse(readFileSync(config.continuityFile, 'utf8')).checkpoint.forked,
    ).toBe(true)
    await expect(probe(reopen)).rejects.toThrow('fork')
    writeFileSync(config.continuityFile, '{')
    await expect(probe(reopen)).rejects.toThrow('continuity')
  },
  60000,
)

rustTest(
  'real Rust TLS certificate policy rejects wrong CA, SAN, expiry and same-key recertification',
  async () => {
    const nodeStore = await openDemoNodeAdmission(options())
    let expected
    try {
      expected = summary(await nodeStore.enroll([bootstrap], now))
    } finally {
      await nodeStore.close()
    }
    await fixture.stop()
    // These keys belong only to this test server. Never read the #758 fixture's
    // private CA/leaf files or alter its immutable public bundle directory.
    const caKey = join(root, 'test-ca.key'),
      caFile = join(root, 'test-ca.pem')
    const leafKey = join(root, 'test-leaf.key'),
      csr = join(root, 'test-leaf.csr')
    const ext = join(root, 'test-leaf.ext')
    const openssl = (args: string[]) =>
      execFileSync('openssl', args, {
        timeout: 10000,
        stdio: ['ignore', 'ignore', 'pipe'],
        maxBuffer: 65536,
      })
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caFile,
      '-days',
      '1',
      '-subj',
      '/CN=Owned Rust TLS test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ])
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      leafKey,
      '-out',
      csr,
      '-subj',
      '/CN=Owned Rust TLS test leaf',
    ])
    const certificates = new Map<string, Buffer>()
    for (const [index, kind] of [
      'valid',
      'wrong-san',
      'expired',
      'same-key',
    ].entries()) {
      writeFileSync(
        ext,
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${
          kind === 'wrong-san' ? '127.0.0.2' : '127.0.0.1'
        }\n`,
        { mode: 0o600 },
      )
      const file = join(root, `test-${kind}.pem`)
      openssl([
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        caFile,
        '-CAkey',
        caKey,
        '-set_serial',
        String(index + 1),
        '-out',
        file,
        '-extfile',
        ext,
        ...(kind === 'expired'
          ? ['-not_before', '20200101000000Z', '-not_after', '20200102000000Z']
          : ['-days', '1']),
      ])
      certificates.set(kind, readFileSync(file))
    }
    const pins = (pem: Buffer) => {
      const certificate = new X509Certificate(pem)
      return {
        leafSha256: createHash('sha256').update(certificate.raw).digest('hex'),
        leafSpkiSha256: createHash('sha256')
          .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
          .digest('base64'),
      }
    }
    expect(pins(certificates.get('same-key')!).leafSpkiSha256).toBe(
      pins(certificates.get('valid')!).leafSpkiSha256,
    )
    expect(pins(certificates.get('same-key')!).leafSha256).not.toBe(
      pins(certificates.get('valid')!).leafSha256,
    )
    for (const kind of [
      'valid',
      'wrong-ca',
      'wrong-san',
      'expired',
      'same-key',
    ]) {
      const served = certificates.get(kind === 'wrong-ca' ? 'valid' : kind)!
      const pinned = kind === 'same-key' ? certificates.get('valid')! : served
      let requests = 0
      const sockets = new Set<import('node:stream').Duplex>()
      const server = createHttpsServer(
        { key: readFileSync(leafKey), cert: served },
        (request, response) => {
          requests++
          expect(request.method).toBe('GET')
          expect(request.url).toBe('/fixture/evidence')
          const body = JSON.stringify({
            kind: 'synthetic-directory-evidence',
            trustInputs: trustJSON(trust),
            witnessHex: bundle.witnessHex,
          })
          response.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          })
          response.end(body)
        },
      )
      server.on('connection', socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(
          Number(new URL(trust.endpoint).port),
          '127.0.0.1',
          resolve,
        )
      })
      const location = join(root, `native-tls-${kind}`),
        continuityFile = join(root, `native-tls-${kind}.json`)
      try {
        const scenario = join(root, 'native-tls-scenario.json')
        writeFileSync(
          scenario,
          JSON.stringify({
            bundle: {
              ...bundle,
              trustInputs: trustJSON(trust),
              tls: {
                caPem:
                  kind === 'wrong-ca'
                    ? bundle.tls.caPem
                    : readFileSync(caFile, 'utf8'),
                ...pins(pinned),
              },
            },
            manifestIdentity: bundle.manifestIdentity,
            installed: trustJSON(trust),
            nowNs: now.toString(),
            location,
            continuityFile,
            mode: 'new',
            candidates: [
              {
                statement: toHex(bootstrap.statement),
                attestation: toHex(bootstrap.attestation),
              },
            ],
          }),
        )
        const result = child(process.env.DIRECTORY_ADMISSION_RUST_PROBE!, [
          scenario,
        ])
        if (kind === 'valid') {
          expect(JSON.parse(await result)).toEqual(expected)
          expect(requests).toBe(1)
        } else {
          await expect(result).rejects.toThrow(
            kind === 'same-key' ? 'tls-pin' : 'tls',
          )
          expect(requests).toBe(0)
          expect(existsSync(location)).toBe(false)
          expect(existsSync(continuityFile)).toBe(false)
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()))
          for (const socket of sockets) socket.destroy()
        })
      }
    }
    expect(reopenBundle(bundle, now).manifestIdentity).toBe(
      bundle.manifestIdentity,
    )
  },
  90000,
)

browserTest(
  'real controlled-origin Chromium matches Node exact admission and survives browser restart',
  async () => {
    const store = await openDemoNodeAdmission(options())
    let expected
    let expectedFork
    const conflict = signed(trust, 1, hash(bootstrap), 6, 1)
    try {
      expected = summary(await store.enroll([bootstrap, rotation], now))
      await expect(store.advance([conflict], now)).rejects.toMatchObject({
        code: 'fork',
      })
      expectedFork = JSON.parse(
        readFileSync(options().continuityFile, 'utf8'),
      ).checkpoint
    } finally {
      await store.close()
    }
    const scenario = join(root, 'browser-scenario.json')
    writeFileSync(
      scenario,
      JSON.stringify({
        bundle: {
          runDir: bundle.runDir,
          manifestIdentity: bundle.manifestIdentity,
        },
        nowNs: now.toString(),
        installed: trustJSON(trust),
        candidates: [bootstrap, rotation].map(c => ({
          statement: toHex(c.statement),
          attestation: toHex(c.attestation),
        })),
        expected,
        expectedFork,
        conflict: {
          statement: toHex(conflict.statement),
          attestation: toHex(conflict.attestation),
        },
      }),
    )
    const output = await child(
      process.execPath,
      [
        join(__dirname, 'check-admission-browser.cjs'),
        scenario,
        process.env.DIRECTORY_ADMISSION_CHROMIUM!,
      ],
      {},
      120000,
    )
    expect(output).toContain('"ok":true')
    expect(output).toContain('"restart":true')
  },
  145000,
)
