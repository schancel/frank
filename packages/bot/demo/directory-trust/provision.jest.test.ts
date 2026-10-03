import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import {
  disposeBundle,
  initBundle,
  parseTrust,
  reopenBundle,
  type TrustInputs,
} from './index'
import { decimal, endpoint } from './provision'

const subject =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const anchor =
  '21729c888b5da6caeaf90dde5eb2c37e9c2da392e609908d75afba75b72f3a3e'
const corpus = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../docs/protocol/cbor/vectors/directory-preview.json',
    ),
    'utf8',
  ),
)
const witness = corpus.records.find((r: { id: string }) => r.id === 'bootstrap')
  .type2_hex as string
const nowNs = 9007199254740993000n // Explicit synthetic test clock, beyond safe JS integer.
let parent: string
let runDir: string
let trustInputs: TrustInputs
beforeEach(async () => {
  parent = mkdtempSync(join(tmpdir(), 'directory-trust-tests-'))
  runDir = join(parent, 'directory-trust-run')
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  trustInputs = {
    network: 'monad-testnet',
    subject,
    rev0T1: anchor,
    relayId: '000102030405060708090a0b0c0d0e0f',
    relayIdentity: { keyType: 1, point: subject },
    endpoint: `https://127.0.0.1:${port}`,
    bindingExpiryNs: nowNs + 1000n,
  }
})
afterEach(() => rmSync(parent, { recursive: true, force: true }))
const init = (extra: Record<string, unknown> = {}) =>
  initBundle({
    mode: 'synthetic-demo',
    runDir,
    trustInputs,
    nowNs,
    witnessHex: witness,
    ...extra,
  })

test('public facade returns only explicit inputs and signed historical evidence, with private files permissioned', () => {
  const bundle = init()
  expect(Object.keys(bundle).sort()).toEqual([
    'kind',
    'manifestIdentity',
    'runDir',
    'tls',
    'trustInputs',
    'witnessHex',
  ])
  expect(bundle.trustInputs).toEqual(trustInputs)
  expect(bundle.witnessHex).toBe(witness)
  expect(
    JSON.stringify(bundle, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  ).not.toContain('PRIVATE KEY')
  expect(statSync(bundle.runDir).mode & 0o777).toBe(0o700)
  expect(statSync(join(bundle.runDir, 'leaf.key')).mode & 0o777).toBe(0o600)
  const original = readFileSync(join(bundle.runDir, 'manifest.json'))
  const cert = readFileSync(join(bundle.runDir, 'leaf.pem'))
  expect(reopenBundle(bundle, nowNs + 1n)).toEqual(bundle)
  expect(readFileSync(join(bundle.runDir, 'manifest.json'))).toEqual(original)
  expect(readFileSync(join(bundle.runDir, 'leaf.pem'))).toEqual(cert)
  expect(() => reopenBundle(bundle, nowNs)).toThrow('rollback')
  disposeBundle(bundle, nowNs + 1n)
  expect(existsSync(runDir)).toBe(false)
})
test.each([
  ['mode', { mode: undefined }],
  ['missing clock', { nowNs: undefined }],
  ['number clock', { nowNs: 1 }],
  ['expired binding', { nowNs: nowNs + 1000n }],
  ['negative clock', { nowNs: -1n }],
])('rejects %s before creating state', (_, extra) => {
  expect(() => init(extra)).toThrow()
  expect(existsSync(runDir)).toBe(false)
})
test.each([
  'network',
  'subject',
  'rev0T1',
  'relayId',
  'relayIdentity',
  'endpoint',
  'bindingExpiryNs',
])('requires explicit %s', field => {
  const input = { ...trustInputs }
  delete (input as unknown as Record<string, unknown>)[field]
  expect(() => init({ trustInputs: input })).toThrow()
  expect(existsSync(runDir)).toBe(false)
})
test.each([
  { subject: '02' + 'ff'.repeat(32) },
  { rev0T1: '00'.repeat(32) },
  { network: 'MONT' },
  { relayId: '00' },
  { relayIdentity: { keyType: 2, point: subject } },
])('rejects malformed or independently mismatched trust %j', changes => {
  expect(() => init({ trustInputs: { ...trustInputs, ...changes } })).toThrow()
  expect(existsSync(runDir)).toBe(false)
})
test('rejects valid signed non-rev0 witness and damaged signature', () => {
  expect(() =>
    init({
      witnessHex: corpus.records.find((r: { id: string }) => r.id === 'renew')
        .type2_hex,
    }),
  ).toThrow()
  expect(() => init({ witnessHex: witness.slice(0, -2) + '00' })).toThrow()
})
test('witness is optional and never fills missing caller anchor', () => {
  const bundle = init({ witnessHex: undefined })
  expect(bundle.witnessHex).toBeUndefined()
  expect(bundle.trustInputs.rev0T1).toBe(anchor)
})
test.each([
  'http://127.0.0.1:1234',
  'https://localhost:1234',
  'https://127.1:1234',
  'https://127.0.0.1',
  'https://127.0.0.1:01234',
  'https://127.0.0.1:65536',
  'https://127.0.0.1:1234/',
  'https://user@127.0.0.1:1234',
  'https://127.0.0.1:1234?x',
  'https://127.0.0.1:1234#x',
  'https://127.0.0.1:1234/fixture/evidence',
])('rejects endpoint normalization/discovery %s', value =>
  expect(() => endpoint(value)).toThrow(),
)
test.each([undefined, 1, '01', '-1', '1e9', '1.0', '+1', ''])(
  'rejects noncanonical JSON clock %p',
  value => expect(() => decimal(value)).toThrow(),
)
test('JSON boundaries preserve bigint exactly', () => {
  expect(
    parseTrust({ ...trustInputs, bindingExpiryNs: (nowNs + 1000n).toString() })
      .bindingExpiryNs,
  ).toBe(nowNs + 1000n)
  expect(decimal(nowNs.toString())).toBe(nowNs)
})
test('reopen fails on wrong identity, missing/corrupt files and expired binding without repair', () => {
  const bundle = init()
  expect(() => init()).toThrow()
  expect(() =>
    reopenBundle({ ...bundle, manifestIdentity: '00'.repeat(32) }, nowNs),
  ).toThrow('identity')
  expect(() => reopenBundle(bundle, nowNs + 1000n)).toThrow('unexpired')
  writeFileSync(join(runDir, 'leaf.pem'), 'corrupt')
  expect(() => reopenBundle(bundle, nowNs)).toThrow('TLS file identity')
  rmSync(join(runDir, 'manifest.json'))
  expect(() => reopenBundle(bundle, nowNs)).toThrow()
  expect(existsSync(join(runDir, 'manifest.json'))).toBe(false)
})
