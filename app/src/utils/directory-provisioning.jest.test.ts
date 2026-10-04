/** @jest-environment node */
import {
  parseBootstrapPolicy, parseApprovedPolicy, parseInstallationSnapshot, configurationIdentity, bundleIdentity, expectedConfiguration,
  fetchInstallationSnapshot, configurationMatches, prepareExplicitPublicExport,
  PROVISIONING_BODY_LIMIT, type BootstrapPolicy, type InstallationSnapshot, type ApprovedPolicy,
} from './directory-provisioning'
import { createMonadWalletMaterial } from '@frank/wallet/monad-wallet-material'
import rootsVector from '../../../packages/domain-roots/vectors/domain-roots-v1.json'
import { toHex } from '@frank/codec'
import { prepareMonadRevisionZeroExport } from '@frank/wallet/chain/monad-chain'
jest.mock('@frank/wallet/chain/monad-chain', () => ({ prepareMonadRevisionZeroExport: jest.fn() }))
const point = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const hash = 'ab'.repeat(32)
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
function bootstrap(): BootstrapPolicy {
  return { version: 1, kind: 'directory-bootstrap-process-policy', networkTag: 'MONT', network: 'monad-testnet', chainId: '10143',
    participants: ['relay-a', 'relay-b', 'bot'].map(processId => ({ processId: processId as 'relay-a' | 'relay-b' | 'bot', origin: `https://${processId}.example`, trustReference: `${processId}-installed-test-trust` })),
    relayTuples: ['relay-a', 'relay-b'].map(processId => ({ processId: processId as 'relay-a' | 'relay-b', id: (processId === 'relay-a' ? '01' : '02').repeat(16), endpoint: `https://${processId}.example`, key: point, expiryNs: '3600000000001' })),
    exportValidity: { issuedAtNs: '1', expiresAtNs: '3600000000001' }, policyIdentity: hash }
}
function snapshot(): InstallationSnapshot {
  const configuration = { version: 1 as const, kind: 'published-directory-configuration' as const, principals: [{ network: 'monad-testnet', subjectP: point, revisionZeroT1: hash, manifestIdentity: hash, relayId: '01'.repeat(16), relayIdentity: point, endpoint: 'https://relay-a.example', bindingExpiryNs: '3600000000001' }] }
  return { version: 1, kind: 'published-directory-installation', runtimeEpoch: '03'.repeat(16), generation: '18446744073709551615', configuration, publicConfigurationIdentity: configurationIdentity(configuration), sampledAtNs: '123', classification: 'historical-installation-snapshot', states: [{ network: 'monad-testnet', subjectP: point, enrollment: 'unenrolled', historicalHead: null, historicalRevision: null, messageGeneration: null, stampGeneration: null, forked: false, unavailable: false }] }
}
function reply(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return { status: 200, ok: true, redirected: false, url: `https://relay-a.example/directory-installation/${hash}`, body: stream, headers: new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }) } as Response
}
const participant = () => bootstrap().participants[0]
test('bootstrap has no UI identity or installed bundle assertion and preserves exact tuple bytes', () => {
  expect(parseBootstrapPolicy(bytes(bootstrap()))).toEqual(bootstrap())
  for (const key of ['subjectP', 'revisionZeroT1', 'bundleIdentity', 'ready']) expect(() => parseBootstrapPolicy(bytes({ ...bootstrap(), [key]: hash }))).toThrow()
})
test.each([
  (p: BootstrapPolicy) => { p.relayTuples[0].id = '01'.repeat(32) },
  (p: BootstrapPolicy) => { p.participants[0].origin = 'http://relay-a.example' },
  (p: BootstrapPolicy) => { p.relayTuples[0].endpoint = 'https://wrong.example' },
  (p: BootstrapPolicy) => { p.participants[0].trustReference = 'x'.repeat(129) },
  (p: BootstrapPolicy) => { p.relayTuples[0].endpoint = 'https://' + 'x'.repeat(2048) },
  (p: BootstrapPolicy) => { p.chainId = '01' },
  (p: BootstrapPolicy) => { p.exportValidity.expiresAtNs = '3600000000002' },
])('rejects malformed closed bootstrap input %#', change => { const p = bootstrap(); change(p); expect(() => parseBootstrapPolicy(bytes(p))).toThrow() })
test('rejects escaped duplicate keys before ordinary policy shape checking', () => {
  const json = JSON.stringify(bootstrap()).replace('"version":1', '"version":1,"\\u0076ersion":1')
  expect(() => parseBootstrapPolicy(new TextEncoder().encode(json))).toThrow()
})
test('immutable actual configuration comparison excludes lifecycle observations', () => {
  const s = snapshot()
  expect(parseInstallationSnapshot(bytes(s))).toEqual(s)
  const another = { ...s, runtimeEpoch: '04'.repeat(16), generation: '0', sampledAtNs: '456' }
  expect(parseInstallationSnapshot(bytes(another)).publicConfigurationIdentity).toBe(s.publicConfigurationIdentity)
  const changed = snapshot(); changed.configuration.principals[0].endpoint = 'https://other.example'
  expect(() => parseInstallationSnapshot(bytes(changed))).toThrow()
})
test.each([
  (s: any) => { s.runtimeEpoch = '00'.repeat(32) },
  (s: any) => { s.publicConfigurationIdentity = '00'.repeat(16) },
  (s: any) => { s.generation = '18446744073709551616' },
  (s: any) => { s.states[0].enrollment = ['unenrolled'] },
  (s: any) => { s.states[0].historicalHead = hash },
  (s: any) => { s.states[0].enrollment = 'enrolled' },
  (s: any) => { s.states.push(s.states[0]) },
  (s: any) => { s.configuration.principals[0].endpoint = 'https://' + 'a'.repeat(2048) },
  (s: any) => { s.ready = true },
])('rejects invalid status dimensions/scalar/closed shape %#', change => { const s = snapshot(); change(s); expect(() => parseInstallationSnapshot(bytes(s))).toThrow() })
test('manifest echo alone cannot match a different actual installation', () => {
  const s = snapshot()
  const other = { ...s.configuration.principals[0], relayIdentity: '03' + point.slice(2) }
  const approved = { bundleIdentity: hash, expectedConfigurationIdentity: s.publicConfigurationIdentity, subjects: [{ network: other.network, subjectP: other.subjectP, revisionZeroT1: other.revisionZeroT1, relay: { id: other.relayId, key: other.relayIdentity, endpoint: other.endpoint, expiryNs: other.bindingExpiryNs } }] } as any
  expect(configurationMatches(s, approved)).toBe(false)
})
test('streams real JSON response with literal origin and exact body length', async () => {
  const body = bytes(snapshot())
  const request = jest.fn(async () => reply(new ReadableStream({ start(c) { c.enqueue(body.slice(0, 17)); c.enqueue(body.slice(17)); c.close() } }), { 'content-length': String(body.length) }))
  const result = await fetchInstallationSnapshot(participant(), hash, new AbortController().signal, request as typeof fetch)
  expect(result.states[0].enrollment).toBe('unenrolled')
  expect(request.mock.calls).toHaveLength(1)
})
test('over-cap stream is cancelled before retaining the offending chunk', async () => {
  const cancel = jest.fn()
  const request = async () => reply(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(PROVISIONING_BODY_LIMIT + 1)) }, cancel }))
  await expect(fetchInstallationSnapshot(participant(), hash, new AbortController().signal, request as typeof fetch)).rejects.toThrow()
  expect(cancel).toHaveBeenCalledTimes(1)
})
test('abort cancels a stalled reader without waiting for more network bytes', async () => {
  const cancel = jest.fn(), controller = new AbortController()
  const request = async () => reply(new ReadableStream({ cancel }))
  const operation = fetchInstallationSnapshot(participant(), hash, controller.signal, request as typeof fetch)
  await Promise.resolve(); controller.abort()
  await expect(operation).rejects.toThrow()
  expect(cancel).toHaveBeenCalled()
})
test.each([{ 'content-type': 'application/json, application/json' }, { 'content-encoding': 'gzip' }, { 'content-length': '8388609' }, { 'x-extra': 'x'.repeat(4097) }])('rejects response authority/budget headers %j', async headers => {
  const request = async () => reply(new ReadableStream({ start(c) { c.close() } }), headers)
  await expect(fetchInstallationSnapshot(participant(), hash, new AbortController().signal, request as typeof fetch)).rejects.toThrow()
})
test('actual public wallet producer is not called after account replacement during wallet acquisition', async () => {
  const state = { status: 'ready', revision: 1, account: {} }
  const session = { state, getWallet: async () => { state.revision++; return {} as any } }
  await expect(prepareExplicitPublicExport(session, bootstrap(), '1', 'A')).rejects.toThrow()
  expect(prepareMonadRevisionZeroExport).not.toHaveBeenCalled()
})

test('explicit action passes actual acquired handle and exact tuple/nanosecond inputs to W', async () => {
  const wallet = {} as any, output = { kind: 'public-revision-zero-preparation' }
  ;(prepareMonadRevisionZeroExport as jest.Mock).mockReturnValueOnce(output)
  const session = { state: { status: 'ready', revision: 1, account: {} }, getWallet: async () => wallet }
  expect(await prepareExplicitPublicExport(session, bootstrap(), '1', 'A')).toBe(output)
  expect(prepareMonadRevisionZeroExport).toHaveBeenLastCalledWith(wallet, expect.objectContaining({ networkTag: 'MONT', chainId: 10143n, issuedAt: { seconds: 0n, nanoseconds: 1 }, now: { seconds: 0n, nanoseconds: 1 }, subjectBinding: 'A', relayA: expect.objectContaining({ origin: 'https://relay-a.example', tuple: expect.objectContaining({ endpoint: 'https://relay-a.example', relayId: new Uint8Array(16).fill(1), identity: { keyType: 1, keyBytes: Uint8Array.from(Buffer.from(point, 'hex')) } }) }) }))
})

test('pins the ordinary configuration comparator to an independently encoded fixed vector', () => {
  expect(snapshot().publicConfigurationIdentity).toBe('a12f0f1af2d041e203afdddb61f53721a2f7a7d6c744ea7a84037416595069d4')
})

// Signed offline codec candidates only; these never substitute for real enrollment/Current.
function approvedCandidates(): ApprovedPolicy {
  const policy = bootstrap()
  const subjects = [0, 1].map(index => {
    const outputs = rootsVector.vectors[index].outputs
    const root = <P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption'>(purpose: P) => ({ registry: 'frank-domain-roots-v1' as const, purpose, bytes: Uint8Array.from(Buffer.from(outputs[purpose], 'hex')) })
    const material = createMonadWalletMaterial({ evm: root('evm-wallet'), authentication: root('identity-authentication'), messaging: root('messaging-encryption') })
    try {
      const process = (i: number) => ({ processId: policy.relayTuples[i].processId, origin: policy.participants[i].origin, tuple: { relayId: new Uint8Array(16).fill(i + 1), endpoint: policy.relayTuples[i].endpoint, identity: { keyType: 1, keyBytes: Uint8Array.from(Buffer.from(point, 'hex')) }, expiry: { seconds: 3600n, nanoseconds: 1 }, unknownFields: new Map() } })
      const result = material.canonicalRoles!.prepareRevisionZero({ networkTag: 'MONT', network: 'monad-testnet', chainId: 10143n, issuedAt: { seconds: 0n, nanoseconds: 1 }, expiresAt: { seconds: 3600n, nanoseconds: 1 }, now: { seconds: 0n, nanoseconds: 1 }, relayA: process(0), relayB: process(1), subjectBinding: index === 0 ? 'A' : 'B' })
      const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url')
      const { processId: _process, ...relay } = policy.relayTuples[index]
      return { role: index === 0 ? 'ui' as const : 'bot' as const, network: 'monad-testnet', subjectP: toHex(result.auth.compressedPoint), revisionZeroT1: toHex(result.t1), statement: b64(result.statement), attestation: b64(result.attestation), homeProcessId: index === 0 ? 'relay-a' as const : 'relay-b' as const, relay }
    } finally { material.dispose() }
  }).sort((a, b) => a.subjectP < b.subjectP ? -1 : 1)
  const approved: ApprovedPolicy = { version: 1, kind: 'operator-approved-directory-bundle', bootstrapPolicyIdentity: hash, participants: policy.participants, subjects, bundleIdentity: hash, expectedConfigurationIdentity: hash }
  approved.bundleIdentity = bundleIdentity(approved)
  approved.expectedConfigurationIdentity = configurationIdentity(expectedConfiguration(approved))
  return approved
}
test('approved public bundle retains independently signed exact original frames without becoming Current', () => {
  const approved = approvedCandidates()
  expect(parseApprovedPolicy(bytes(approved))).toEqual(approved)
  expect((parseApprovedPolicy(bytes(approved)) as any).kind).not.toBe('current')
  const changed = { ...approved, bundleIdentity: 'cd'.repeat(32) }
  expect(() => parseApprovedPolicy(bytes(changed))).toThrow()
  approved.subjects[0].statement = approved.subjects[1].statement
  expect(() => parseApprovedPolicy(bytes(approved))).toThrow()
})
