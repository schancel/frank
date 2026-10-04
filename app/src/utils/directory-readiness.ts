/**
 * Local/demo readiness barrier (#778 "Accepted local/demo bootstrap").
 *
 * The operator installs two public files next to the app, through the same channel that deploys
 * the app itself: a bootstrap policy (before the account exports anything) and the approved bundle
 * (after the operator has checked the UI and bot exports). This module never treats either file,
 * a URL or a self-signature as trust on its own. Messaging is enabled only when:
 *
 *  1. the approved bundle contains this account's own exact signed revision-zero bytes;
 *  2. every participant named in the bundle (both relays and the bot) reports, from its own running
 *     process, exactly the approved public configuration;
 *  3. the browser's own public DirectoryStore admits fresh evidence for both subjects; and
 *  4. a second read of every participant shows the same process epoch, generation and
 *     configuration, with this account's home relay holding the admitted heads.
 *
 * Anything missing, stale, expired or different leaves the result pending. This is a point-in-time
 * check, not a cross-process transaction: every send still obtains fresh Current values.
 */
import { computeAddress } from 'ethers'
import { fromHex, toHex, type RelayBinding, type Timestamp } from '@frank/codec'
import type {
  Checkpoint,
  Current,
  DirectoryStore,
  OpenMode,
  Anchor,
} from '@frank/directory-admission'
import {
  createDirectoryClient,
  type DirectoryFetch,
} from '@frank/cashweb/relay/directory-client'
import type { CanonicalDirectory } from '@frank/wallet/chain/monad-chain'
import type { NativeWalletHandle } from '@frank/wallet/chain'
import type { PublicRevisionZeroExport } from '@frank/wallet/monad-wallet-handle'
import {
  configurationMatches,
  parseApprovedPolicy,
  parseBootstrapPolicy,
  prepareExplicitPublicExport,
  type ApprovedPolicy,
  type BootstrapPolicy,
  type HomeTuple,
  type InstallationSnapshot,
  type Participant,
  type Subject,
} from './directory-provisioning'

export type ReadinessReason =
  | 'account-unavailable'
  | 'policy-missing'
  | 'policy-invalid'
  | 'policy-expired'
  | 'relay-not-in-policy'
  | 'bundle-missing'
  | 'bundle-invalid'
  | 'bundle-foreign-policy'
  | 'bundle-not-this-account'
  | 'forwarding-unavailable'
  | 'participant-unavailable'
  | 'participant-mismatch'
  | 'enrollment-required'
  | 'admission-failed'
  | 'changed-during-check'
  | 'account-changed'
export type ParticipantStatus =
  | 'unchecked'
  | 'matched'
  | 'unavailable'
  | 'mismatch'
export type ParticipantStatuses = Record<
  Participant['processId'],
  ParticipantStatus
>

/** Public export handed to the operator. Public bytes and points only. */
export interface PublicExportFile {
  version: 1
  kind: 'public-revision-zero-export'
  bootstrapPolicyIdentity: string
  networkTag: 'MONT' | 'MON1'
  network: string
  chainId: string
  subjectP: string
  authAddress: string
  messagePoint: string
  stampPoint: string
  revisionZeroT1: string
  statement: string
  attestation: string
  homeProcessId: 'relay-a' | 'relay-b'
}

export interface ReadinessSession {
  state: { status: string; revision: number; account: unknown }
  getWallet(): Promise<NativeWalletHandle>
}
export interface ReadinessDeps {
  session: ReadinessSession
  /** The relay this app build submits to and reads its mailbox from. */
  relayBaseUrl: string
  /** Device clock in Unix nanoseconds. The relays keep their own operator-supplied clock. */
  nowNs(): bigint
  /** Operator-installed public file served with the app; `null` when it is not installed. */
  loadDeployed(
    name: 'bootstrap-policy.json' | 'approved-bundle.json',
    signal: AbortSignal,
  ): Promise<Uint8Array | null>
  fetchSnapshot(
    participant: Participant,
    manifest: string,
    signal: AbortSignal,
  ): Promise<InstallationSnapshot>
  openStore(options: {
    name: string
    anchor: Anchor
    mode: OpenMode
  }): Promise<DirectoryStore>
  /** Whole external checkpoints, kept outside the admission database. */
  checkpoints: {
    load(key: string): Checkpoint | null
    save(key: string, checkpoint: Checkpoint): void
  }
  directoryFetch: DirectoryFetch
  /**
   * Remove a store database that exists but holds no admitted record, so a failed first
   * enrollment can be retried. A database with any record must be reported `retained`.
   */
  discardUnenrolled(name: string): Promise<'absent' | 'discarded' | 'retained'>
  /** This device's own previously derived public export, per account and policy. */
  exports: {
    load(key: string): string | null
    save(key: string, value: string): void
  }
}

export interface DirectoryActivation {
  wallet: NativeWalletHandle
  directory: CanonicalDirectory
  revision: number
  account: unknown
  /** Identity address of the installed bot: the only peer this installation can message. */
  peerAddress: string
  /** Compressed signing key of that bot, from the approved bundle and admitted evidence. */
  peerSubject: string
  close(): Promise<void>
}
export type ReadinessResult =
  | {
      status: 'pending'
      reason: ReadinessReason
      participants: ParticipantStatuses
    }
  | {
      status: 'ready'
      participants: ParticipantStatuses
      activation: DirectoryActivation
    }

const PEER_REFRESH_MS = 30_000
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
const fromBase64url = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c =>
    c.charCodeAt(0),
  )
const timestamp = (ns: bigint): Timestamp => ({
  seconds: ns / 1_000_000_000n,
  nanoseconds: Number(ns % 1_000_000_000n),
})
const binding = (tuple: HomeTuple): RelayBinding => ({
  relayId: fromHex(tuple.id),
  endpoint: tuple.endpoint,
  identity: { keyType: 1, keyBytes: fromHex(tuple.key) },
  expiry: timestamp(BigInt(tuple.expiryNs)),
  unknownFields: new Map(),
})
const origin = (url: string): string | undefined => {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
const unchecked = (): ParticipantStatuses => ({
  'relay-a': 'unchecked',
  'relay-b': 'unchecked',
  'bot': 'unchecked',
})

/** The home relay is the one this app build is configured to use; no other choice is offered. */
function homeProcess(
  policy: BootstrapPolicy,
  relayBaseUrl: string,
): 'relay-a' | 'relay-b' | undefined {
  const wanted = origin(relayBaseUrl)
  return policy.relayTuples.find(
    tuple => wanted !== undefined && origin(tuple.endpoint) === wanted,
  )?.processId
}

export function publicExportFile(
  policy: BootstrapPolicy,
  exported: PublicRevisionZeroExport,
  homeProcessId: 'relay-a' | 'relay-b',
): PublicExportFile {
  return {
    version: 1,
    kind: 'public-revision-zero-export',
    bootstrapPolicyIdentity: policy.policyIdentity,
    networkTag: exported.networkTag,
    network: exported.network,
    chainId: exported.chainId.toString(),
    subjectP: toHex(exported.auth.compressedPoint),
    authAddress: exported.authAddress,
    messagePoint: toHex(exported.message.compressedPoint),
    stampPoint: toHex(exported.stamp.compressedPoint),
    revisionZeroT1: toHex(exported.t1),
    statement: base64url(exported.statement),
    attestation: base64url(exported.attestation),
    homeProcessId,
  }
}

type Loaded =
  | { ok: false; reason: ReadinessReason }
  | {
      ok: true
      policy: BootstrapPolicy
      home: 'relay-a' | 'relay-b'
      file: PublicExportFile
      exportKey: string
    }

const EXPORT_FIELDS = [
  'version',
  'kind',
  'bootstrapPolicyIdentity',
  'networkTag',
  'network',
  'chainId',
  'subjectP',
  'authAddress',
  'messagePoint',
  'stampPoint',
  'revisionZeroT1',
  'statement',
  'attestation',
  'homeProcessId',
] as const
function savedExport(text: string | null): PublicExportFile | undefined {
  if (text === null) return undefined
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (
      Object.keys(value).length !== EXPORT_FIELDS.length ||
      EXPORT_FIELDS.some(field =>
        field === 'version'
          ? value[field] !== 1
          : typeof value[field] !== 'string',
      ) ||
      value.kind !== 'public-revision-zero-export'
    )
      return undefined
    return value as unknown as PublicExportFile
  } catch {
    return undefined
  }
}
const accountIdOf = (account: unknown): string | undefined =>
  (account as { receipt?: { context?: { accountId?: unknown } } } | null)
    ?.receipt?.context?.accountId as string | undefined

/**
 * Load the operator policy and this account's exact public export.
 *
 * `sign` is true only for an explicit user action: the export is then derived from the live
 * wallet, which signs the revision-zero statement. Otherwise only the export this device saved
 * after an earlier explicit check is used, and nothing is signed.
 */
async function loadOwnExport(
  deps: ReadinessDeps,
  signal: AbortSignal,
  sign: boolean,
): Promise<Loaded> {
  const accountId = accountIdOf(deps.session.state.account)
  if (deps.session.state.status !== 'ready' || typeof accountId !== 'string')
    return { ok: false, reason: 'account-unavailable' }
  let bytes: Uint8Array | null
  try {
    bytes = await deps.loadDeployed('bootstrap-policy.json', signal)
  } catch {
    bytes = null
  }
  if (!bytes) return { ok: false, reason: 'policy-missing' }
  let policy: BootstrapPolicy
  try {
    policy = parseBootstrapPolicy(bytes)
  } catch {
    return { ok: false, reason: 'policy-invalid' }
  }
  const now = deps.nowNs()
  if (
    now < BigInt(policy.exportValidity.issuedAtNs) ||
    now >= BigInt(policy.exportValidity.expiresAtNs)
  )
    return { ok: false, reason: 'policy-expired' }
  const home = homeProcess(policy, deps.relayBaseUrl)
  if (!home) return { ok: false, reason: 'relay-not-in-policy' }
  const exportKey = `${accountId}:${policy.policyIdentity}`
  if (!sign) {
    const file = savedExport(deps.exports.load(exportKey))
    if (
      !file ||
      file.bootstrapPolicyIdentity !== policy.policyIdentity ||
      file.homeProcessId !== home
    )
      return { ok: false, reason: 'enrollment-required' }
    return { ok: true, policy, home, file, exportKey }
  }
  try {
    const exported = await prepareExplicitPublicExport(
      deps.session,
      policy,
      now.toString(),
      home === 'relay-a' ? 'A' : 'B',
    )
    return {
      ok: true,
      policy,
      home,
      file: publicExportFile(policy, exported, home),
      exportKey,
    }
  } catch {
    return { ok: false, reason: 'account-unavailable' }
  }
}

/** Explicit user action: this account's public export for the operator. */
export async function preparePublicExport(
  deps: ReadinessDeps,
  signal: AbortSignal,
): Promise<
  { ok: true; file: PublicExportFile } | { ok: false; reason: ReadinessReason }
> {
  const loaded = await loadOwnExport(deps, signal, true)
  return loaded.ok ? { ok: true, file: loaded.file } : loaded
}

const storeName = (subject: Subject) =>
  `frank-directory:${subject.network}:${subject.subjectP}:${subject.revisionZeroT1}`

function sameParticipants(a: Participant[], b: Participant[]): boolean {
  const key = (p: Participant) =>
    `${p.processId}\n${p.origin}\n${p.trustReference}`
  const left = a.map(key).sort(),
    right = b.map(key).sort()
  return left.length === right.length && left.every((v, i) => v === right[i])
}

/**
 * Run the whole barrier once. `allowEnrollment` is true only for the explicit Settings action.
 * Automatic checks (app start) sign nothing: they use the export this device saved earlier, reopen
 * stores that already hold admitted state, and never enroll or repair.
 */
export async function checkDirectoryReadiness(
  deps: ReadinessDeps,
  options: { allowEnrollment: boolean; signal: AbortSignal },
): Promise<ReadinessResult> {
  const participants = unchecked()
  const pending = (reason: ReadinessReason): ReadinessResult => ({
    status: 'pending',
    reason,
    participants,
  })
  const { signal } = options
  const revision = deps.session.state.revision,
    account = deps.session.state.account
  const sameAccount = () =>
    deps.session.state.status === 'ready' &&
    deps.session.state.revision === revision &&
    deps.session.state.account === account
  const own = await loadOwnExport(deps, signal, options.allowEnrollment)
  if (!own.ok) return pending(own.reason)

  let bundleBytes: Uint8Array | null
  try {
    bundleBytes = await deps.loadDeployed('approved-bundle.json', signal)
  } catch {
    bundleBytes = null
  }
  if (!bundleBytes) return pending('bundle-missing')
  let approved: ApprovedPolicy
  try {
    approved = parseApprovedPolicy(bundleBytes)
  } catch {
    return pending('bundle-invalid')
  }
  if (
    approved.bootstrapPolicyIdentity !== own.policy.policyIdentity ||
    !sameParticipants(approved.participants, own.policy.participants)
  )
    return pending('bundle-foreign-policy')
  const ui = approved.subjects.find(subject => subject.role === 'ui')!,
    bot = approved.subjects.find(subject => subject.role === 'bot')!
  // The approved bundle must carry this account's own exact bytes, not merely its key or T1.
  if (
    ui.subjectP !== own.file.subjectP ||
    ui.network !== own.file.network ||
    ui.revisionZeroT1 !== own.file.revisionZeroT1 ||
    ui.statement !== own.file.statement ||
    ui.attestation !== own.file.attestation ||
    ui.homeProcessId !== own.home
  )
    return pending('bundle-not-this-account')
  // Both subjects must be homed where this app submits: relay forwarding (#779) does not exist.
  if (
    bot.network !== ui.network ||
    origin(bot.relay.endpoint) !== origin(ui.relay.endpoint) ||
    origin(ui.relay.endpoint) !== origin(deps.relayBaseUrl)
  )
    return pending('forwarding-unavailable')
  // Saved only once the operator approved exactly these bytes; later starts reuse it unsigned.
  if (options.allowEnrollment)
    deps.exports.save(own.exportKey, JSON.stringify(own.file))

  const readAll = async (): Promise<
    Map<Participant['processId'], InstallationSnapshot> | undefined
  > => {
    const snapshots = new Map<Participant['processId'], InstallationSnapshot>()
    await Promise.all(
      approved.participants.map(async participant => {
        try {
          const snapshot = await deps.fetchSnapshot(
            participant,
            approved.bundleIdentity,
            signal,
          )
          if (
            !configurationMatches(snapshot, approved) ||
            snapshot.states.some(state => state.forked || state.unavailable)
          ) {
            participants[participant.processId] = 'mismatch'
            return
          }
          snapshots.set(participant.processId, snapshot)
          participants[participant.processId] = 'matched'
        } catch {
          participants[participant.processId] = 'unavailable'
        }
      }),
    )
    return snapshots.size === approved.participants.length
      ? snapshots
      : undefined
  }
  const first = await readAll()
  if (!first)
    return pending(
      Object.values(participants).includes('mismatch')
        ? 'participant-mismatch'
        : 'participant-unavailable',
    )
  if (!sameAccount()) return pending('account-changed')

  // Independent browser admission. Status JSON above never substitutes for this.
  const opened: DirectoryStore[] = []
  const closeAll = async () => {
    for (const store of opened.splice(0))
      await store.close().catch(() => undefined)
  }
  const admit = async (subject: Subject, attestation?: Uint8Array) => {
    const key = storeName(subject)
    const saved = deps.checkpoints.load(key)
    const committed = saved?.kind === 'CommittedPrefix'
    if (!committed && !options.allowEnrollment) return 'enrollment-required'
    let checkpoint = saved
    if (!committed) {
      // No acknowledged admission was ever saved for this store. A database left behind by a
      // failed first enrollment holds no record and is removed so enrollment can run again. A
      // database that holds records is admitted state: it is kept, and it can be reopened only
      // with its saved checkpoint, never replaced by a fresh enrollment.
      const found = await deps.discardUnenrolled(key)
      if (found !== 'retained') checkpoint = null
      else if (!saved)
        throw new Error('Admitted directory store has no saved checkpoint')
    }
    const tuple = binding(subject.relay)
    if (!checkpoint && !attestation) {
      // A peer that has not published yet must not leave an empty store behind: without a saved
      // checkpoint that store could never be reopened, and it is never silently recreated.
      const head = `${new URL(subject.relay.endpoint).origin}/directory/v1/${
        subject.network
      }/${subject.subjectP}/head`
      const controller = new AbortController()
      const probe = await deps.directoryFetch(head, {
        method: 'GET',
        headers: { Accept: 'application/vnd.frank.cbor' },
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      })
      const published = probe.status === 200 && probe.url === head
      controller.abort()
      await probe.body
        ?.getReader()
        .cancel()
        .catch(() => undefined)
      if (!published) throw new Error('Peer directory record is not published')
    }
    const store = await deps.openStore({
      name: key,
      anchor: {
        network: subject.network,
        subject: { keyType: 1, keyBytes: fromHex(subject.subjectP) },
        revisionZero: fromHex(subject.revisionZeroT1),
      },
      mode: checkpoint ? { kind: 'reopen', checkpoint } : { kind: 'new' },
    })
    opened.push(store)
    const context = () => ({ now: timestamp(deps.nowNs()), relay: tuple })
    const client = createDirectoryClient({
      network: subject.network,
      subject: subject.subjectP,
      endpoint: subject.relay.endpoint,
      store,
      context,
      saveCheckpoint: async saved => deps.checkpoints.save(key, saved),
      fetch: deps.directoryFetch,
    })
    // Own subject: publish the exact retained attestation (idempotent at the relay). A peer is
    // only ever read; its owner publishes it.
    const admitted =
      attestation && !(await store.status())
        ? await client.put(await client.preparePut(attestation))
        : await client.current()
    return { store, client, context, current: admitted.current }
  }
  let self: Exclude<Awaited<ReturnType<typeof admit>>, string>,
    peer: Exclude<Awaited<ReturnType<typeof admit>>, string>
  try {
    const a = await admit(ui, fromBase64url(own.file.attestation))
    const b = typeof a === 'string' ? a : await admit(bot)
    if (typeof a === 'string' || typeof b === 'string') {
      await closeAll()
      return pending('enrollment-required')
    }
    self = a
    peer = b
  } catch {
    await closeAll()
    return pending('admission-failed')
  }

  const second = await readAll()
  const homeState = (subject: Subject) =>
    second
      ?.get(ui.homeProcessId)
      ?.states.find(
        state =>
          state.network === subject.network &&
          state.subjectP === subject.subjectP,
      )
  if (
    !second ||
    approved.participants.some(participant => {
      const before = first.get(participant.processId)!,
        after = second.get(participant.processId)!
      return (
        before.runtimeEpoch !== after.runtimeEpoch ||
        before.generation !== after.generation ||
        before.publicConfigurationIdentity !== after.publicConfigurationIdentity
      )
    }) ||
    homeState(ui)?.historicalHead !== toHex(self.current.evidence.hash) ||
    homeState(bot)?.historicalHead !== toHex(peer.current.evidence.hash)
  ) {
    await closeAll()
    return pending(second ? 'changed-during-check' : 'participant-unavailable')
  }
  let wallet: NativeWalletHandle
  try {
    wallet = await deps.session.getWallet()
  } catch {
    await closeAll()
    return pending('account-unavailable')
  }
  // The export may have been loaded from storage rather than derived: it must be this wallet's.
  if (
    (
      wallet as unknown as { identity?: { address?: { raw?: string } } }
    ).identity?.address?.raw?.toLowerCase() !==
    computeAddress('0x' + ui.subjectP).toLowerCase()
  ) {
    await closeAll()
    return pending('bundle-not-this-account')
  }
  if (!sameAccount()) {
    await closeAll()
    return pending('account-changed')
  }

  let peerCurrent = peer.current,
    peerRefreshed = Date.now()
  const peerAddress = computeAddress('0x' + bot.subjectP).toLowerCase()
  const directory: CanonicalDirectory = {
    network: ui.network,
    homeEndpoint: ui.relay.endpoint,
    selfCurrent: () => self.store.current(self.context()),
    async peerCurrent(wanted) {
      if (
        'subject' in wanted
          ? wanted.subject !== bot.subjectP
          : wanted.address.toLowerCase() !== peerAddress
      )
        return undefined
      let current: Current
      if (Date.now() - peerRefreshed >= PEER_REFRESH_MS) {
        current = (await peer.client.current()).current
        peerRefreshed = Date.now()
      } else current = await peer.store.current(peer.context())
      peerCurrent = current
      return {
        subject: bot.subjectP,
        endpoint: bot.relay.endpoint,
        current: peerCurrent,
      }
    },
  }
  return {
    status: 'ready',
    participants,
    activation: {
      wallet,
      directory,
      revision,
      account,
      peerAddress: computeAddress('0x' + bot.subjectP),
      peerSubject: bot.subjectP,
      close: closeAll,
    },
  }
}

interface SavedCheckpoint {
  kind: Checkpoint['kind']
  identity: string
  anchor: string
  head: string | null
  accepted: number
  retained: number
  evidenceDigest: string
  checkedTime: { seconds: string; nanoseconds: number }
  forked: boolean
}
/** Whole-checkpoint serialization for storage outside the admission database. */
export function serializeCheckpoint(checkpoint: Checkpoint): string {
  const saved: SavedCheckpoint = {
    kind: checkpoint.kind,
    identity: toHex(checkpoint.identity),
    anchor: toHex(checkpoint.anchor),
    head: checkpoint.head ? toHex(checkpoint.head) : null,
    accepted: checkpoint.accepted,
    retained: checkpoint.retained,
    evidenceDigest: toHex(checkpoint.evidenceDigest),
    checkedTime: {
      seconds: checkpoint.checkedTime.seconds.toString(),
      nanoseconds: checkpoint.checkedTime.nanoseconds,
    },
    forked: checkpoint.forked,
  }
  return JSON.stringify(saved)
}
export function parseCheckpoint(text: string): Checkpoint {
  const saved = JSON.parse(text) as SavedCheckpoint
  return {
    kind: saved.kind,
    identity: fromHex(saved.identity),
    anchor: fromHex(saved.anchor),
    head: saved.head === null ? null : fromHex(saved.head),
    accepted: saved.accepted,
    retained: saved.retained,
    evidenceDigest: fromHex(saved.evidenceDigest),
    checkedTime: {
      seconds: BigInt(saved.checkedTime.seconds),
      nanoseconds: saved.checkedTime.nanoseconds,
    },
    forked: saved.forked,
  }
}
