/** Ordinary public configuration only: no installation or Current authority. */
import { encodeCanonical, fromHex, toHex, uncompressedPubkey, verifyPreviewDirectoryEvidence, type Encodable, type Timestamp } from '@frank/codec'
import { sha256 } from '@frank/crypto-box'
import { parseCanonicalJSON } from '@frank/cashweb/relay/canonical-dm-transport'
import { prepareMonadRevisionZeroExport } from '@frank/wallet/chain/monad-chain'
import type { PublicRevisionZeroExport, PublicRevisionZeroInput } from '@frank/wallet/monad-wallet-handle'
import type { NativeWalletHandle } from '@frank/wallet/chain'

export const PROVISIONING_BODY_LIMIT = 8_388_608
const U64 = (1n << 64n) - 1n
const MAX_NS = ((1n << 63n) - 1n) * 1_000_000_000n + 999_999_999n
const invalid = (): never => { throw new Error('Invalid public directory provisioning value') }
export interface Participant { processId: 'relay-a' | 'relay-b' | 'bot'; origin: string; trustReference: string }
export interface HomeTuple { id: string; endpoint: string; key: string; expiryNs: string }
export interface BootstrapPolicy {
  version: 1; kind: 'directory-bootstrap-process-policy'; networkTag: 'MONT' | 'MON1'; network: string; chainId: string
  participants: Participant[]; relayTuples: (HomeTuple & { processId: 'relay-a' | 'relay-b' })[]
  exportValidity: { issuedAtNs: string; expiresAtNs: string }; policyIdentity: string
}
export interface Subject {
  role: 'ui' | 'bot'; network: string; subjectP: string; revisionZeroT1: string
  statement: string; attestation: string; homeProcessId: 'relay-a' | 'relay-b'; relay: HomeTuple
}
export interface ApprovedPolicy {
  version: 1; kind: 'operator-approved-directory-bundle'; bootstrapPolicyIdentity: string
  participants: Participant[]; subjects: Subject[]; bundleIdentity: string; expectedConfigurationIdentity: string
}
export interface ConfigurationRecord {
  network: string; subjectP: string; revisionZeroT1: string; manifestIdentity: string
  relayId: string; relayIdentity: string; endpoint: string; bindingExpiryNs: string
}
export interface ConfigurationProjection {
  version: 1; kind: 'published-directory-configuration'; principals: ConfigurationRecord[]
}
export interface InstallationState {
  network: string; subjectP: string; enrollment: 'unenrolled' | 'enrolled'
  historicalHead: string | null; historicalRevision: string | null
  messageGeneration: string | null; stampGeneration: string | null; forked: boolean; unavailable: boolean
}
export interface InstallationSnapshot {
  version: 1; kind: 'published-directory-installation'; runtimeEpoch: string; generation: string
  configuration: ConfigurationProjection; publicConfigurationIdentity: string; sampledAtNs: string
  classification: 'historical-installation-snapshot'; states: InstallationState[]
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) invalid()
  return record
}
function text(value: unknown, max: number, ascii = false): string {
  if (typeof value !== 'string' || !value.length || value.length > max || new TextEncoder().encode(value).length > max || (ascii && /[^\x20-\x7e]/.test(value))) invalid()
  return value
}
function hex(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) invalid()
  return value
}
function point(value: unknown): string { const p = hex(value, 33); uncompressedPubkey(fromHex(p)); return p }
function decimal(value: unknown, max = U64): string {
  if (typeof value !== 'string' || value.length > 39 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > max) invalid()
  return value
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid()
  return value as T
}
function exact(value: unknown, expected: unknown): void { if (value !== expected) invalid() }
function array(value: unknown, max: number, min = 1): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid()
  return value
}
function endpoint(value: unknown, originOnly = false): string {
  const s = text(value, 2048)
  const u = new URL(s)
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || (originOnly ? u.origin !== s : u.origin !== s && u.origin + '/' !== s)) invalid()
  return s
}
function participants(value: unknown): Participant[] {
  const out = array(value, 3, 3).map(v => {
    const r = object(v, ['processId', 'origin', 'trustReference'])
    return { processId: choice(r.processId, ['relay-a', 'relay-b', 'bot'] as const), origin: endpoint(r.origin, true), trustReference: text(r.trustReference, 128, true) }
  })
  if (new Set(out.map(p => p.processId)).size !== 3) invalid()
  return out
}
function tuple(value: unknown, process = false): HomeTuple & { processId?: 'relay-a' | 'relay-b' } {
  const r = object(value, ['id', 'endpoint', 'key', 'expiryNs', ...(process ? ['processId'] : [])])
  return { id: hex(r.id, 16), endpoint: endpoint(r.endpoint), key: point(r.key), expiryNs: decimal(r.expiryNs, MAX_NS), ...(process ? { processId: choice(r.processId, ['relay-a', 'relay-b'] as const) } : {}) }
}
export function parseBootstrapPolicy(bytes: Uint8Array): BootstrapPolicy { return bootstrapPolicy(parseCanonicalJSON(bytes, PROVISIONING_BODY_LIMIT)) }
function bootstrapPolicy(value: unknown): BootstrapPolicy {
  const r = object(value, ['version', 'kind', 'networkTag', 'network', 'chainId', 'participants', 'relayTuples', 'exportValidity', 'policyIdentity'])
  exact(r.version, 1); exact(r.kind, 'directory-bootstrap-process-policy')
  const ps = participants(r.participants)
  const ts = array(r.relayTuples, 2, 2).map(v => tuple(v, true) as HomeTuple & { processId: 'relay-a' | 'relay-b' })
  if (new Set(ts.map(t => t.processId)).size !== 2 || ts.some(t => new URL(t.endpoint).origin !== ps.find(p => p.processId === t.processId)?.origin)) invalid()
  const validity = object(r.exportValidity, ['issuedAtNs', 'expiresAtNs'])
  const issuedAtNs = decimal(validity.issuedAtNs, MAX_NS), expiresAtNs = decimal(validity.expiresAtNs, MAX_NS)
  if (BigInt(expiresAtNs) <= BigInt(issuedAtNs) || BigInt(expiresAtNs) - BigInt(issuedAtNs) > 3_600_000_000_000n) invalid()
  return { version: 1, kind: 'directory-bootstrap-process-policy', networkTag: choice(r.networkTag, ['MONT', 'MON1'] as const), network: text(r.network, 64, true), chainId: decimal(r.chainId), participants: ps, relayTuples: ts, exportValidity: { issuedAtNs, expiresAtNs }, policyIdentity: hex(r.policyIdentity, 32) }
}
function decodeBase64(value: string): Uint8Array { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) }
function base64(value: unknown): string {
  const s = text(value, 349526, true)
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) invalid()
  const decoded = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  if (decoded.length > 262144 || btoa(decoded).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== s) invalid()
  return s
}
function ordered(records: readonly { network: string; subjectP: string }[]): void {
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1], b = records[i]
    if (a.network > b.network || (a.network === b.network && a.subjectP >= b.subjectP)) invalid()
  }
}
export function parseApprovedPolicy(bytes: Uint8Array): ApprovedPolicy {
  const r = object(parseCanonicalJSON(bytes, PROVISIONING_BODY_LIMIT), ['version', 'kind', 'bootstrapPolicyIdentity', 'participants', 'subjects', 'bundleIdentity', 'expectedConfigurationIdentity'])
  exact(r.version, 1); exact(r.kind, 'operator-approved-directory-bundle')
  const ps = participants(r.participants)
  const subjects = array(r.subjects, 2, 2).map(v => {
    const s = object(v, ['role', 'network', 'subjectP', 'revisionZeroT1', 'statement', 'attestation', 'homeProcessId', 'relay'])
    const homeProcessId = choice(s.homeProcessId, ['relay-a', 'relay-b'] as const), relay = tuple(s.relay)
    if (new URL(relay.endpoint).origin !== ps.find(p => p.processId === homeProcessId)?.origin) invalid()
    return { role: choice(s.role, ['ui', 'bot'] as const), network: text(s.network, 64, true), subjectP: point(s.subjectP), revisionZeroT1: hex(s.revisionZeroT1, 32), statement: base64(s.statement), attestation: base64(s.attestation), homeProcessId, relay }
  })
  for (const subject of subjects) {
    const statement = decodeBase64(subject.statement)
    const evidence = verifyPreviewDirectoryEvidence(decodeBase64(subject.attestation), subject.network)
    const d = evidence.statement
    if (evidence.statementFrame.schemaVersion !== 4 || evidence.statementFrame.minReaderVersion !== 4 || evidence.attestationFrame.schemaVersion !== 1 || evidence.attestationFrame.minReaderVersion !== 1) invalid()
    if (toHex(evidence.statementFrame.frame) !== toHex(statement) || toHex(evidence.statementHash) !== subject.revisionZeroT1 || toHex(d.subject.keyBytes) !== subject.subjectP || d.revision !== 0n || d.preview.predecessor !== null || d.preview.mailboxKeyGeneration !== 0n || d.preview.stampKeyGeneration !== 0n || d.relays.length !== 1) invalid()
    const t = d.relays[0]
    if (toHex(t.relayId) !== subject.relay.id || t.endpoint !== subject.relay.endpoint || t.identity.keyType !== 1 || toHex(t.identity.keyBytes) !== subject.relay.key || t.expiry.seconds * 1_000_000_000n + BigInt(t.expiry.nanoseconds) !== BigInt(subject.relay.expiryNs)) invalid()
  }
  ordered(subjects)
  if (new Set(subjects.map(s => s.role)).size !== 2 || subjects[0].subjectP === subjects[1].subjectP) invalid()
  const result: ApprovedPolicy = { version: 1, kind: 'operator-approved-directory-bundle', bootstrapPolicyIdentity: hex(r.bootstrapPolicyIdentity, 32), participants: ps, subjects, bundleIdentity: hex(r.bundleIdentity, 32), expectedConfigurationIdentity: hex(r.expectedConfigurationIdentity, 32) }
  if (bundleIdentity(result) !== result.bundleIdentity || configurationIdentity(expectedConfiguration(result)) !== result.expectedConfigurationIdentity) invalid()
  // Frames remain literal public candidates. Parsing ordinary policy grants no signature/admission authority.
  return result
}
/** Accepted ordinary comparator (#778 comment 5980071479), no FRNK authority.
 * Bundle map 0=version,1=kind,2=bootstrap identity bytes,3=participants,4=subjects.
 * Participant map 0=id,1=origin,2=trust reference; sorted ASCII processId bytes.
 * Subject map 0=role,1=network,2=P bytes,3=T1 bytes,4=original statement bytes,
 * 5=original attestation bytes,6=home id,7=relay. Sorted ASCII network/P bytes.
 * Relay map 0=id bytes,1=exact endpoint,2=identity bytes,3=decimal expiry text.
 * Bundle is computed first; configuration includes that identity, never itself.
 */
export function bundleIdentity(policy: ApprovedPolicy): string {
  const map = (values: Encodable[]): Encodable => new Map(values.map((value, i) => [i, value]))
  const ps = [...policy.participants].sort((a, b) => a.processId < b.processId ? -1 : a.processId > b.processId ? 1 : 0).map(p => map([p.processId, p.origin, p.trustReference]))
  const ss = policy.subjects.map(s => map([s.role, s.network, fromHex(s.subjectP), fromHex(s.revisionZeroT1), decodeBase64(s.statement), decodeBase64(s.attestation), s.homeProcessId, map([fromHex(s.relay.id), s.relay.endpoint, fromHex(s.relay.key), s.relay.expiryNs])]))
  return toHex(sha256(encodeCanonical(map([1, 'operator-approved-directory-bundle', fromHex(policy.bootstrapPolicyIdentity), ps, ss]))))
}
function configuration(value: unknown): ConfigurationProjection {
  const r = object(value, ['version', 'kind', 'principals'])
  exact(r.version, 1); exact(r.kind, 'published-directory-configuration')
  const principals = array(r.principals, 1024).map(v => {
    const p = object(v, ['network', 'subjectP', 'revisionZeroT1', 'manifestIdentity', 'relayId', 'relayIdentity', 'endpoint', 'bindingExpiryNs'])
    return { network: text(p.network, 64, true), subjectP: point(p.subjectP), revisionZeroT1: hex(p.revisionZeroT1, 32), manifestIdentity: hex(p.manifestIdentity, 32), relayId: hex(p.relayId, 16), relayIdentity: point(p.relayIdentity), endpoint: endpoint(p.endpoint), bindingExpiryNs: decimal(p.bindingExpiryNs, MAX_NS) }
  })
  ordered(principals)
  return { version: 1, kind: 'published-directory-configuration', principals }
}
export function expectedConfiguration(policy: ApprovedPolicy): ConfigurationProjection {
  return { version: 1, kind: 'published-directory-configuration', principals: policy.subjects.map(s => ({ network: s.network, subjectP: s.subjectP, revisionZeroT1: s.revisionZeroT1, manifestIdentity: policy.bundleIdentity, relayId: s.relay.id, relayIdentity: s.relay.key, endpoint: s.relay.endpoint, bindingExpiryNs: s.relay.expiryNs })) }
}
/** Configuration map 0=version,1=kind,2=all actual sorted principal records.
 * Principal map 0=network,1=P bytes,2=rev0 T1 bytes,3=manifest bytes,
 * 4=relay id bytes,5=relay identity bytes,6=exact endpoint,7=expiry decimal text.
 * Immutable fields only: epoch/generation/enrollment/head are excluded.
 */
export function configurationIdentity(value: ConfigurationProjection): string {
  const checked = configuration(value)
  const records: Encodable[] = checked.principals.map(p => new Map<number, Encodable>([
    [0, p.network], [1, fromHex(p.subjectP)], [2, fromHex(p.revisionZeroT1)], [3, fromHex(p.manifestIdentity)], [4, fromHex(p.relayId)], [5, fromHex(p.relayIdentity)], [6, p.endpoint], [7, p.bindingExpiryNs],
  ]))
  return toHex(sha256(encodeCanonical(new Map<number, Encodable>([[0, 1], [1, 'published-directory-configuration'], [2, records]]))))
}
export function parseInstallationSnapshot(bytes: Uint8Array): InstallationSnapshot {
  const r = object(parseCanonicalJSON(bytes, PROVISIONING_BODY_LIMIT), ['version', 'kind', 'runtimeEpoch', 'generation', 'configuration', 'publicConfigurationIdentity', 'sampledAtNs', 'classification', 'states'])
  exact(r.version, 1); exact(r.kind, 'published-directory-installation'); exact(r.classification, 'historical-installation-snapshot')
  const c = configuration(r.configuration)
  const states = array(r.states, 1024).map((v, i) => {
    const s = object(v, ['network', 'subjectP', 'enrollment', 'historicalHead', 'historicalRevision', 'messageGeneration', 'stampGeneration', 'forked', 'unavailable'])
    const enrollment = choice(s.enrollment, ['unenrolled', 'enrolled'] as const)
    const nullable = (value: unknown, hash = false): string | null => { if (enrollment === 'unenrolled') { exact(value, null); return null }; return hash ? hex(value, 32) : decimal(value) }
    if (typeof s.forked !== 'boolean' || typeof s.unavailable !== 'boolean') invalid()
    const network = text(s.network, 64, true), subjectP = point(s.subjectP)
    if (network !== c.principals[i]?.network || subjectP !== c.principals[i]?.subjectP) invalid()
    return { network, subjectP, enrollment, historicalHead: nullable(s.historicalHead, true), historicalRevision: nullable(s.historicalRevision), messageGeneration: nullable(s.messageGeneration), stampGeneration: nullable(s.stampGeneration), forked: s.forked as boolean, unavailable: s.unavailable as boolean }
  })
  if (states.length !== c.principals.length) invalid()
  const identity = hex(r.publicConfigurationIdentity, 32)
  if (configurationIdentity(c) !== identity) invalid()
  return { version: 1, kind: 'published-directory-installation', runtimeEpoch: hex(r.runtimeEpoch, 16), generation: decimal(r.generation), configuration: c, publicConfigurationIdentity: identity, sampledAtNs: decimal(r.sampledAtNs, MAX_NS), classification: 'historical-installation-snapshot', states }
}
export function configurationMatches(snapshot: InstallationSnapshot, approved: ApprovedPolicy): boolean {
  // No readiness implication: historical state cannot substitute for actual browser Current.
  return snapshot.publicConfigurationIdentity === approved.expectedConfigurationIdentity && configurationIdentity(snapshot.configuration) === configurationIdentity(expectedConfiguration(approved))
}
export async function fetchInstallationSnapshot(participant: Participant, manifest: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<InstallationSnapshot> {
  const origin = endpoint(participant.origin, true), identity = hex(manifest, 32)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const controller = new AbortController()
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let chunks: Uint8Array[] = []
  try {
    const url = `${origin}/directory-installation/${identity}`
    const response = await request(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal })
    if (signal.aborted || response.redirected || response.url !== url || !response.ok || response.status !== 200) invalid()
    let headerBytes = 0, headerCount = 0
    response.headers.forEach((value, name) => {
      const size = new TextEncoder().encode(value).length
      if (name.length > 128 || size > 4096 || ++headerCount > 64) invalid()
      headerBytes += name.length + size + 4
      if (headerBytes > 16384) invalid()
    })
    if (response.headers.get('content-type') !== 'application/json' || response.headers.get('cache-control') !== 'no-store') invalid()
    const encoding = response.headers.get('content-encoding')
    if (encoding !== null && encoding !== 'identity') invalid()
    const length = response.headers.get('content-length')
    if (length !== null && (decimal(length) !== length || BigInt(length) > BigInt(PROVISIONING_BODY_LIMIT))) invalid()
    if (!response.body) invalid()
    reader = response.body.getReader()
    let total = 0
    for (;;) {
      const part = await reader.read()
      if (signal.aborted) invalid()
      if (part.done) break
      if (part.value.length > PROVISIONING_BODY_LIMIT - total) invalid()
      total += part.value.length
      chunks.push(Uint8Array.from(part.value))
    }
    if (length !== null && BigInt(length) !== BigInt(total)) invalid()
    const bytes = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
    return parseInstallationSnapshot(bytes)
  } finally {
    controller.abort()
    await reader?.cancel().catch(() => undefined)
    reader?.releaseLock()
    for (const chunk of chunks) chunk.fill(0)
    chunks = []
    signal.removeEventListener('abort', abort)
  }
}
function timestamp(ns: string): Timestamp { const n = BigInt(decimal(ns, MAX_NS)); return { seconds: n / 1_000_000_000n, nanoseconds: Number(n % 1_000_000_000n) } }
/** Caller must establish authenticated policy provenance independently; this cannot confer it. */
export async function prepareExplicitPublicExport(session: { state: { status: string; revision: number; account: unknown }; getWallet(): Promise<NativeWalletHandle> }, policy: BootstrapPolicy, nowNs: string, home: 'A' | 'B'): Promise<PublicRevisionZeroExport> {
  const checked = bootstrapPolicy(policy)
  const revision = session.state.revision, account = session.state.account
  if (session.state.status !== 'ready' || !account) invalid()
  const now = timestamp(nowNs)
  if (BigInt(nowNs) < BigInt(checked.exportValidity.issuedAtNs) || BigInt(nowNs) >= BigInt(checked.exportValidity.expiresAtNs)) invalid()
  const wallet = await session.getWallet()
  if (session.state.revision !== revision || session.state.account !== account || session.state.status !== 'ready') invalid()
  const process = (id: 'relay-a' | 'relay-b') => {
    const t = checked.relayTuples.find(t => t.processId === id)!
    return { processId: id, origin: checked.participants.find(p => p.processId === id)!.origin, tuple: { relayId: fromHex(t.id), endpoint: t.endpoint, identity: { keyType: 1, keyBytes: fromHex(t.key) }, expiry: timestamp(t.expiryNs), unknownFields: new Map() } }
  }
  const input: PublicRevisionZeroInput = { networkTag: checked.networkTag, network: checked.network, chainId: BigInt(checked.chainId), issuedAt: timestamp(checked.exportValidity.issuedAtNs), expiresAt: timestamp(checked.exportValidity.expiresAtNs), now, relayA: process('relay-a'), relayB: process('relay-b'), subjectBinding: home }
  const result = prepareMonadRevisionZeroExport(wallet, input)
  if (session.state.revision !== revision || session.state.account !== account || session.state.status !== 'ready') invalid()
  return result
}
