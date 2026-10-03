import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import * as filesystem from 'node:fs'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
  splitTime,
  trustJSON,
} from './browser-admission'

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

test('failed prospective save exposes no enrolled head and never retries as a new user', async () => {
  const store = await openDemoNodeAdmission(options())
  try {
    jest.spyOn(filesystem, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('checkpoint-save-failed')
    })
    await expect(store.enroll([bootstrap], now)).rejects.toThrow(
      'checkpoint-save-failed',
    )
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
    jest.spyOn(filesystem, 'renameSync').mockImplementationOnce(() => {
      throw new Error('checkpoint-ack-failed')
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(command, args, {
      cwd: resolvePath(),
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      processChild.kill('SIGKILL')
      reject(new Error('Owned demo child timed out'))
    }, 20000)
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
      reject(error)
    })
    processChild.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`Owned child exit ${code}: ${output}`))
    })
  })
}
const resolvePath = () => resolve(__dirname, '../..')
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
browserTest(
  'real controlled-origin Chromium matches Node exact admission and survives browser restart',
  async () => {
    const store = await openDemoNodeAdmission(options())
    let expected
    try {
      expected = summary(await store.enroll([bootstrap, rotation], now))
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
        candidates: [bootstrap, rotation].map(c => ({
          statement: toHex(c.statement),
          attestation: toHex(c.attestation),
        })),
        expected,
      }),
    )
    const output = await child(process.execPath, [
      join(__dirname, 'check-admission-browser.cjs'),
      scenario,
      process.env.DIRECTORY_ADMISSION_CHROMIUM!,
    ])
    expect(output).toContain('"ok":true')
    expect(output).toContain('"restart":true')
  },
  30000,
)
