/**
 * The open account directory, client side.
 *
 * Every account signs its own entry: "this address lives on this relay, and these are its message
 * and stamp keys". Nobody approves it. Relays store entries and replicate them to each other, so a
 * sender only needs the recipient's address.
 *
 * What is trusted here is only arithmetic:
 *  - an entry is accepted for an address only when the key that signed it hashes to that address;
 *  - the first entry chain seen for an address is pinned by its revision-zero hash, and one
 *    admission store per account refuses a rollback or a second, conflicting chain afterwards;
 *  - an entry past its signed expiry is not used.
 * A relay can withhold an entry. It cannot substitute a key.
 *
 * Storage, the clock and signing are injected, so the browser app and the Node bots share this.
 */
import { keccak_256 } from '@noble/hashes/sha3'
import {
  fromHex,
  toHex,
  uncompressedPubkey,
  verifyPreviewDirectoryEvidence,
  type RelayBinding,
  type Timestamp,
} from '@frank/codec'
import type {
  Anchor,
  Candidate,
  Checkpoint,
  Current,
  DirectoryStore,
  HistoricalEvidence,
  OpenMode,
} from '@frank/directory-admission'
import type { DirectoryFetch, DirectoryResponse } from './directory-client'
import { isLoopbackHostname } from './directory-client'
import { matchesRelayOrigin } from './canonical-dm-transport'

const MEDIA = 'application/vnd.frank.cbor'
const FRAME_LIMIT = 262_144
const INFO_LIMIT = 4_096
const REQUEST_DEADLINE_MS = 30_000
/** A peer's admitted entry is reused this long before the relay is asked again. */
const PEER_REFRESH_MS = 30_000
/** Longest chain walked back to revision zero or to a known revision. */
const MAX_CHAIN = 64
/** How many "no entry" answers are remembered at once. */
const MAX_MISSING = 1024
const SECOND = 1_000_000_000n
const DAY = 86_400n * SECOND
/** New entries are valid this long (the codec cap is 366 days). */
export const ENTRY_VALIDITY_NS = 365n * DAY
/** An entry is renewed once less than this remains (or half its life, if that is shorter). */
export const RENEW_BEFORE_NS = 30n * DAY
/** Issue time is set this far in the past so a slightly slow clock elsewhere still accepts it. */
const ISSUE_BACKDATE_NS = 600n * SECOND
const RENEW_RETRY_MS = 600_000
/** A relay must describe a binding that lasts at least this long, or nothing is signed for it. */
export const MIN_BINDING_LIFE_NS = 30n * DAY
/** At most one renewal or move is signed per this period, whatever the relay says or how often
 * the entry is read. A chain holds 4096 statements; this makes that many days. */
export const RESIGN_INTERVAL_NS = DAY
/** How long the relay's answer about forwarding is reused. */
const FORWARDING_REFRESH_MS = 60_000

export type OpenDirectoryErrorCode =
  /** The relay (and its peers) hold no entry for this address. */
  | 'not-published'
  /** The relay could not be reached, or answered with something other than an entry. */
  | 'unreachable'
  /** The entry is malformed, wrongly signed, or signed by a key that is not this address. */
  | 'invalid'
  /** The entry's signed validity has ended (or has not started by this device's clock). */
  | 'expired'
  /** The relay served an older entry than one already accepted for this address. */
  | 'rollback'
  /** Two conflicting entry chains exist for this address. */
  | 'fork'
  /** The relay refused to store this account's entry. */
  | 'rejected'
  /** `/relay/v1/info` is missing or malformed, is for another network, names another host than
   * the configured relay, offers a binding shorter than 30 days, or keeps changing. */
  | 'relay-info'
  /** Local directory storage failed. */
  | 'storage'
  /** The account's history is longer than this client reads on first contact. */
  | 'history-too-long'
  /** This device's clock is behind an entry's issue time, or went backwards. */
  | 'clock'
  /** This account's own entry has not been published yet. */
  | 'unpublished'

const MESSAGES: Record<OpenDirectoryErrorCode, string> = {
  'not-published': 'This address has not published a directory entry.',
  'unreachable': 'The relay could not be reached for a directory entry.',
  'invalid':
    'The directory entry served for this address is not signed by that address.',
  'expired': 'The directory entry for this address has expired.',
  'rollback':
    'The relay served an older directory entry than one already accepted for this address.',
  'fork': 'Two conflicting directory entries exist for this address.',
  'rejected': 'The relay refused to store this account’s directory entry.',
  'relay-info':
    'The relay is misconfigured: it did not describe itself correctly, so nothing was signed for it.',
  'storage': 'Local directory storage is unavailable.',
  'history-too-long':
    'This address has more directory history than can be read at once. Try again later.',
  'clock':
    'This device’s clock looks wrong (it is behind the directory entry, or went backwards). Check the date and time.',
  'unpublished': 'This account’s directory entry has not been published yet.',
}

export class OpenDirectoryError extends Error {
  constructor(
    readonly code: OpenDirectoryErrorCode,
    /** The address the failure is about, when there is one. */
    readonly address?: string,
    readonly status?: number,
  ) {
    super(MESSAGES[code])
    this.name = 'OpenDirectoryError'
  }
}
/** True when the entry itself was refused, as opposed to not being obtainable right now. */
export function isEntryRefusal(error: unknown): boolean {
  return (
    error instanceof OpenDirectoryError &&
    ['invalid', 'expired', 'rollback', 'fork'].includes(error.code)
  )
}

/** What the wallet is asked to sign. The caller adds its own network descriptor. */
export interface EntrySigningInput {
  issuedAt: Timestamp
  expiresAt: Timestamp
  now: Timestamp
  relay: RelayBinding
}
type MaybePromise<T> = T | Promise<T>
export interface OpenDirectoryDeps {
  /** Canonical network of every entry, e.g. `monad-testnet`. */
  network: string
  /** The relay this client is configured to use. Entries are published to and read from it. */
  relayBaseUrl: string
  /** Device clock in Unix nanoseconds. */
  nowNs(): bigint
  fetch: DirectoryFetch
  openStore(options: {
    name: string
    anchor: Anchor
    mode: OpenMode
  }): Promise<DirectoryStore>
  /**
   * Remove a store completely (used when an own account's store is corrupted or in an
   * irrecoverable fork against the authoritative chain).
   */
  discardStore?(name: string): Promise<void>
  /**
   * Remove a store that exists but never admitted anything (a first attempt that failed), so it
   * can be tried again. A store holding any admitted record must be reported `retained`.
   */
  discardUnenrolled(name: string): Promise<'absent' | 'discarded' | 'retained'>
  /** Whole checkpoints, kept outside the admission store. */
  checkpoints: {
    load(name: string): MaybePromise<Checkpoint | null>
    save(name: string, checkpoint: Checkpoint): MaybePromise<void>
  }
  /** First-contact pins: `network:address` -> revision-zero hash (hex). */
  pins: {
    load(key: string): MaybePromise<string | null>
    save(key: string, revisionZero: string): MaybePromise<void>
  }
  self: {
    /** This account's compressed signing key, 66 hex characters. */
    subject: string
    /** Returns the signed attestation frame of revision zero. */
    signRevisionZero(input: EntrySigningInput): MaybePromise<Uint8Array>
    /** Returns the signed attestation frame of the next revision (same keys). */
    signNextRevision(
      input: EntrySigningInput & { revision: bigint; predecessor: Uint8Array },
    ): MaybePromise<Uint8Array>
  }
}

export interface DirectoryEntry {
  /** Compressed signing key, hex. It hashes to `address`. */
  subject: string
  /** Lower-case 0x address. */
  address: string
  /** Relay the entry says this account lives on. */
  endpoint: string
  current: Current
}
export interface OpenDirectory {
  readonly network: string
  /** The configured relay origin with a trailing slash; the mailbox and submissions use it. */
  readonly homeEndpoint: string
  /**
   * Whether an endpoint belongs to this relay (either exact origin match, or through loopback / tunnel proxying).
   */
  isHomeRelay?(endpoint: string): boolean | Promise<boolean>
  /**
   * Make sure this account has a current entry on the configured relay: adopt the one the relay
   * already has, publish revision zero when it has none, and renew or move it when needed.
   */
  publish(): Promise<DirectoryEntry>
  selfCurrent(): Promise<Current>
  /** `undefined` when the address or key has no published entry. Throws when one is refused. */
  peerCurrent(
    peer: { address: string } | { subject: string },
  ): Promise<DirectoryEntry | undefined>
  /**
   * Looks up historical directory evidence for a subject by statement hash.
   */
  peerHistorical?(
    peer: { subject: string; statementHash: string },
  ): Promise<HistoricalEvidence | undefined>
  /**
   * Whether the configured relay says it delivers to accounts that live on other relays
   * (`forwarding: true` in `/relay/v1/info`). Absent or unreadable counts as no.
   */
  forwarding(): Promise<boolean>
  /** Like `peerCurrent({ address })` but an unpublished address is a typed error. */
  lookup(address: string): Promise<DirectoryEntry>
  close(): Promise<void>
}

interface Evidence {
  subject: string
  revision: bigint
  hash: Uint8Array
  predecessor: Uint8Array | null
  issued: Timestamp
  expiry: Timestamp
  relay: RelayBinding
  candidate: Candidate
}
interface Handle {
  subject: string
  address: string
  name: string
  store: DirectoryStore
  head: Evidence | undefined
  refreshedAt: number
}

const nanos = (t: Timestamp): bigint =>
  t.seconds * SECOND + BigInt(t.nanoseconds)
const timestamp = (ns: bigint): Timestamp => ({
  seconds: ns / SECOND,
  nanoseconds: Number(ns % SECOND),
})
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** The 0x address (lower case) of a compressed secp256k1 key, or `undefined` if it is no key. */
export function directoryAddress(subject: string): string | undefined {
  if (!/^(02|03)[0-9a-f]{64}$/.test(subject)) return undefined
  try {
    return (
      '0x' +
      toHex(keccak_256(uncompressedPubkey(fromHex(subject)).subarray(1))).slice(
        24,
      )
    )
  } catch {
    return undefined
  }
}

async function readBody(
  response: DirectoryResponse,
  limit: number,
  deadline: Promise<never>,
): Promise<Uint8Array> {
  if (!response.body) throw new Error('empty body')
  const reader = response.body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      if (!value || length + value.length > limit) throw new Error('body bound')
      chunks.push(value.slice())
      length += value.length
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

export function openDirectory(deps: OpenDirectoryDeps): OpenDirectory {
  const { network } = deps
  const selfSubject = deps.self.subject
  const rawAddress = directoryAddress(selfSubject)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(network) || !rawAddress)
    throw new Error('Exact directory identity required')
  const selfAddress: string = rawAddress
  const origin = new URL(deps.relayBaseUrl).origin
  const base = `${origin}/directory/v1/${network}`
  const handles = new Map<string, Handle>()
  const opening = new Map<string, Promise<Handle>>()
  const queues = new Map<string, Promise<unknown>>()
  const subjects = new Map<string, string>()
  const missing = new Map<string, number>()
  let closed = false
  let publishing: Promise<DirectoryEntry> | undefined
  let renewTriedAt = 0
  let published = false
  let forwarding = false
  let forwardingReadAt = 0
  let bindingEndpoint: string | undefined

  const now = () => timestamp(deps.nowNs())
  /** One operation at a time per account, so a store never sees interleaved admissions. */
  const serial = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(task, task)
    const tail: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    // Forget an idle account's queue, so the map holds only accounts with work in flight.
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return run
  }

  async function request(
    url: string,
    method: 'GET' | 'PUT',
    options: { accept: string; limit: number; body?: Uint8Array },
  ): Promise<{
    status: number
    headers: DirectoryResponse['headers']
    body: Uint8Array | undefined
  }> {
    if (closed) throw new OpenDirectoryError('storage')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Directory transport deadline'))
      }, REQUEST_DEADLINE_MS)
    })
    try {
      const response = await Promise.race([
        deps.fetch(url, {
          method,
          headers: options.body
            ? {
                'Content-Type': MEDIA,
                Accept: options.accept,
                'ngrok-skip-browser-warning': '1',
              }
            : { Accept: options.accept, 'ngrok-skip-browser-warning': '1' },
          body: options.body ? Uint8Array.from(options.body) : undefined,
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        }),
        deadline,
      ])
      if (response.url !== url) throw new Error('redirected')
      if (response.status !== 200) {
        void response.body
          ?.getReader()
          .cancel()
          .catch(() => undefined)
        return {
          status: response.status,
          headers: response.headers,
          body: undefined,
        }
      }
      return {
        status: 200,
        headers: response.headers,
        body: await readBody(response, options.limit, deadline),
      }
    } catch {
      throw new OpenDirectoryError('unreachable')
    } finally {
      clearTimeout(timer!)
    }
  }

  /** Signature, structure and network of one entry. Says nothing about freshness or history. */
  function parse(bytes: Uint8Array, address?: string): Evidence {
    if (bytes.length > FRAME_LIMIT)
      throw new OpenDirectoryError('invalid', address)
    try {
      const verified = verifyPreviewDirectoryEvidence(bytes, network)
      const statement = verified.statement
      return {
        subject: toHex(statement.subject.keyBytes),
        revision: statement.revision,
        hash: verified.statementHash,
        predecessor: statement.preview.predecessor,
        issued: statement.timestamp,
        expiry: statement.expiry,
        relay: statement.relays[0],
        candidate: {
          statement: verified.statementFrame.frame.slice(),
          attestation: bytes.slice(),
        },
      }
    } catch {
      throw new OpenDirectoryError('invalid', address)
    }
  }

  /** A 200 directory body, or `undefined` for 404. Anything else is "unreachable". */
  async function getEntry(
    path: string,
    kind: 'fresh-current' | 'historical',
  ): Promise<Uint8Array | undefined> {
    const response = await request(base + path, 'GET', {
      accept: MEDIA,
      limit: FRAME_LIMIT,
    })
    if (response.status === 404) return undefined
    if (
      response.status !== 200 ||
      !response.body ||
      response.headers.get('content-type') !== MEDIA ||
      response.headers.get('x-frank-directory-evidence') !== kind
    )
      throw new OpenDirectoryError('unreachable', undefined, response.status)
    return response.body
  }

  /** Predecessors of `head`, oldest first, back to revision zero or to a revision `known` has. */
  async function chainBefore(
    head: Evidence,
    known: (hash: Uint8Array) => Promise<boolean>,
  ): Promise<Evidence[]> {
    const address = directoryAddress(head.subject)
    const chain: Evidence[] = []
    let cursor = head
    while (cursor.revision > 0n) {
      if (!cursor.predecessor) throw new OpenDirectoryError('invalid', address)
      if (chain.length >= MAX_CHAIN)
        // Not a sign of forgery: nothing is pinned and the address can be tried again.
        throw new OpenDirectoryError('history-too-long', address)
      if (await known(cursor.predecessor)) break
      const bytes = await getEntry(
        `/${head.subject}/statements/${toHex(cursor.predecessor)}`,
        'historical',
      )
      if (!bytes) throw new OpenDirectoryError('unreachable', address, 404)
      const previous = parse(bytes, address)
      if (
        previous.subject !== head.subject ||
        !same(previous.hash, cursor.predecessor) ||
        previous.revision !== cursor.revision - 1n
      )
        throw new OpenDirectoryError('invalid', address)
      chain.unshift(previous)
      cursor = previous
    }
    return chain
  }

  function refusal(error: unknown, address: string): OpenDirectoryError {
    if (error instanceof OpenDirectoryError) return error
    const code = (error as { code?: string } | null)?.code
    switch (code) {
      case 'validity':
        return new OpenDirectoryError('expired', address)
      case 'clock':
        return new OpenDirectoryError('clock', address)
      case 'rollback':
        return new OpenDirectoryError('rollback', address)
      case 'fork':
      case 'anchor':
        return new OpenDirectoryError('fork', address)
      case 'evidence':
      case 'link':
      case 'order':
      case 'generation':
      case 'key-reuse':
      case 'binding':
        return new OpenDirectoryError('invalid', address)
      default:
        return new OpenDirectoryError('storage', address)
    }
  }
  /** After a storage failure the store refuses everything; drop it so the next call reopens. */
  async function drop(handle: Handle): Promise<void> {
    if (handles.get(handle.subject) === handle) handles.delete(handle.subject)
    await handle.store.close().catch(() => undefined)
  }
  const context = (relay: RelayBinding) => ({ now: now(), relay })
  const saveCheckpoint = async (handle: Handle, checkpoint: Checkpoint) => {
    try {
      await deps.checkpoints.save(handle.name, checkpoint)
    } catch {
      await drop(handle)
      throw new OpenDirectoryError('storage', handle.address)
    }
  }

  /** Open (or create) the one store of an account. `revisionZero` is the pinned anchor. */
  async function openHandle(
    subject: string,
    address: string,
    revisionZero: string,
  ): Promise<Handle> {
    const name = `frank-directory:${network}:${subject}:${revisionZero}`
    const anchor = {
      network,
      subject: { keyType: 1, keyBytes: fromHex(subject) },
      revisionZero: fromHex(revisionZero),
    }
    const safeDiscard = async () => {
      try {
        await deps.discardUnenrolled(name)
      } catch {
        // non-fatal
      }
    }
    try {
      let saved: Checkpoint | null = null
      try {
        saved = await deps.checkpoints.load(name)
      } catch {
        saved = null
      }
      let store: DirectoryStore | undefined
      let checkpoint = saved
      if (checkpoint?.kind === 'CommittedPrefix') {
        try {
          store = await deps.openStore({
            name,
            anchor,
            mode: { kind: 'reopen', checkpoint },
          })
        } catch {
          // Reopening with saved checkpoint failed (cache missing, evicted, or corrupted).
          // Discard the broken store and checkpoint, then fall through to mode: 'new'.
          checkpoint = null
          try {
            await deps.checkpoints.save(name, null as any)
          } catch {
            // ignore
          }
        }
      }
      if (!store) {
        // Discard any unenrolled/corrupted store before opening in 'new' mode
        await safeDiscard()
        try {
          store = await deps.openStore({
            name,
            anchor,
            mode: { kind: 'new' },
          })
        } catch {
          // If 'new' failed because a lingering uncheckpointed database was still present, discard again and retry
          await safeDiscard()
          store = await deps.openStore({
            name,
            anchor,
            mode: { kind: 'new' },
          })
        }
      }
      const handle: Handle = {
        subject,
        address,
        name,
        store,
        head: undefined,
        refreshedAt: 0,
      }
      handles.set(subject, handle)
      subjects.set(address, subject)
      return handle
    } catch (error) {
      console.error('[openHandle] error caught for', address, error)
      throw error instanceof OpenDirectoryError
        ? error
        : new OpenDirectoryError('storage', address)
    }
  }
  /** The handle of an account whose entry chain is already pinned on this device, if any. */
  async function pinnedHandle(
    subject: string,
    address: string,
  ): Promise<Handle | undefined> {
    const existing = handles.get(subject)
    if (existing) return existing
    const pending = opening.get(subject)
    if (pending) return pending
    let pinned: string | null
    try {
      pinned = await deps.pins.load(`${network}:${address}`)
    } catch {
      throw new OpenDirectoryError('storage', address)
    }
    if (!pinned || !/^[0-9a-f]{64}$/.test(pinned)) return undefined
    const task = openHandle(subject, address, pinned).finally(() =>
      opening.delete(subject),
    )
    opening.set(subject, task)
    return task
  }
  /** The last admitted entry held by a store, read back without the network. */
  async function retainedHead(handle: Handle): Promise<Evidence | undefined> {
    if (handle.head) return handle.head
    const status = await handle.store.status()
    if (!status?.head) return undefined
    const evidence = await handle.store.historicalEvidence(status.head)
    if (!evidence) return undefined
    handle.head = parse(evidence.attestation, handle.address)
    return handle.head
  }

  /**
   * Admit `bytes` as the head of the account it claims to be. `expected` is what the caller asked
   * the relay for; an entry for any other key is refused before it touches storage.
   */
  function admit(
    bytes: Uint8Array,
    expected: { address?: string; subject?: string },
  ): Promise<{ handle: Handle; current: Current }> {
    const head = parse(bytes, expected.address)
    const address = directoryAddress(head.subject)
    if (
      !address ||
      (expected.subject !== undefined && expected.subject !== head.subject) ||
      (expected.address !== undefined && expected.address !== address)
    )
      // Correctly signed, but by a key that is not the requested address.
      throw new OpenDirectoryError('invalid', expected.address ?? address)
    return serial(head.subject, async () => {
      let handle = await pinnedHandle(head.subject, address)
      let chain: Evidence[] | undefined
      if (!handle) {
        // First contact: pin the chain's own revision zero before anything is stored, so a
        // different chain offered later for the same address is refused.
        chain = [...(await chainBefore(head, async () => false)), head]
        const revisionZero = toHex(chain[0].hash)
        try {
          await deps.pins.save(`${network}:${address}`, revisionZero)
        } catch {
          throw new OpenDirectoryError('storage', address)
        }
        handle = await openHandle(head.subject, address, revisionZero)
      }
      const { store } = handle
      try {
        const status = await store.status()
        if (!status) {
          chain ??= [...(await chainBefore(head, async () => false)), head]
          const first = chain[0].candidate
          const ctx = context(head.relay)
          await saveCheckpoint(
            handle,
            await store.checkpointForEnrollment(first, ctx.now),
          )
          await store.enroll(
            chain.map(e => e.candidate),
            ctx,
          )
        } else if (!status.head || !same(status.head, head.hash)) {
          try {
            await store.advance([head.candidate], context(head.relay))
          } catch (error) {
            if ((error as { code?: string }).code !== 'link') throw error
            // The account advanced more than one revision since it was last read.
            const gap = await chainBefore(
              head,
              async hash => (await store.historicalEvidence(hash)) !== null,
            )
            await store.advance(
              [...gap, head].map(e => e.candidate),
              context(head.relay),
            )
          }
        }
        const current = await store.current(context(head.relay))
        await saveCheckpoint(handle, current.status.checkpoint)
        handle.head = head
        handle.refreshedAt = Date.now()
        return { handle, current }
      } catch (error) {
        const code = (error as { code?: string } | null)?.code
        if (code === 'fork') {
          // Keep the evidence of the fork across restarts.
          const fork = await store.status().catch(() => null)
          if (fork)
            try {
              await deps.checkpoints.save(handle.name, fork.checkpoint)
            } catch {
              // The store itself keeps the fork; the checkpoint is a second copy.
            }
        }
        if (code === 'unavailable' || code === 'continuity' || !code)
          if (!(error instanceof OpenDirectoryError)) await drop(handle)
        // "Not valid" because it was issued after this device's idea of now is a clock problem,
        // not an expired entry.
        if (code === 'validity' && nanos(head.issued) > deps.nowNs())
          throw new OpenDirectoryError('clock', address)
        throw refusal(error, address)
      }
    })
  }

  const entry = (handle: Handle, current: Current): DirectoryEntry => ({
    subject: handle.subject,
    address: handle.address,
    endpoint: handle.head!.relay.endpoint,
    current,
  })

  async function peer(
    wanted: { address: string } | { subject: string },
  ): Promise<DirectoryEntry | undefined> {
    let address: string | undefined, subject: string | undefined
    if ('subject' in wanted) {
      subject = wanted.subject.toLowerCase()
      address = directoryAddress(subject)
      if (!address) throw new OpenDirectoryError('invalid')
    } else {
      address = wanted.address.toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(address))
        throw new OpenDirectoryError('invalid', address)
      subject = subjects.get(address)
    }
    const known = subject === undefined ? undefined : handles.get(subject)
    if (known?.head && Date.now() - known.refreshedAt < PEER_REFRESH_MS) {
      try {
        const handle = known
        return entry(
          handle,
          await serial(handle.subject, () =>
            handle.store.current(context(handle.head!.relay)),
          ),
        )
      } catch {
        // Fall through and ask the relay again.
      }
    }
    const absentAt = missing.get(address)
    if (absentAt !== undefined && Date.now() - absentAt < PEER_REFRESH_MS)
      return undefined
    const bytes = await getEntry(
      subject === undefined ? `/address/${address}` : `/${subject}/head`,
      'fresh-current',
    )
    if (!bytes) {
      // A relay that no longer serves an account we already admitted is withholding, not proof
      // that the account is gone; either way there is nothing current to use.
      // Bounded: the oldest remembered absences are forgotten first.
      if (missing.size >= MAX_MISSING)
        for (const key of [...missing.keys()].slice(0, MAX_MISSING / 2))
          missing.delete(key)
      missing.delete(address)
      missing.set(address, Date.now())
      return undefined
    }
    missing.delete(address)
    const admitted = await admit(
      bytes,
      subject === undefined ? { address } : { subject, address },
    )
    return entry(admitted.handle, admitted.current)
  }

  async function relayBinding(): Promise<RelayBinding> {
    const response = await request(`${origin}/relay/v1/info`, 'GET', {
      accept: 'application/json',
      limit: INFO_LIMIT,
    })
    if (response.status !== 200 || !response.body)
      throw new OpenDirectoryError('unreachable', undefined, response.status)
    try {
      const info = JSON.parse(
        new TextDecoder().decode(response.body),
      ) as Record<string, unknown>
      if (
        info.network !== network ||
        typeof info.relayId !== 'string' ||
        !/^([0-9a-f]{2}){16,64}$/.test(info.relayId) ||
        typeof info.endpoint !== 'string' ||
        // The relay may only describe itself: an entry is never signed for some other host.
        (!['https:', 'http:'].includes(new URL(info.endpoint).protocol) ||
          (new URL(info.endpoint).protocol === 'http:' && !isLoopbackHostname(new URL(info.endpoint).hostname))) ||
        !matchesRelayOrigin(info.endpoint, origin) ||
        typeof info.relayKey !== 'string' ||
        !directoryAddress(info.relayKey) ||
        typeof info.bindingExpiry !== 'string' ||
        !/^[0-9]{1,20}$/.test(info.bindingExpiry) ||
        // A binding about to expire would force a new signed revision again and again.
        BigInt(info.bindingExpiry) < deps.nowNs() + MIN_BINDING_LIFE_NS
      )
        throw new Error('shape')
      forwarding = info.forwarding === true
      forwardingReadAt = Date.now()
      bindingEndpoint = info.endpoint
      return {
        relayId: fromHex(info.relayId),
        endpoint: info.endpoint,
        identity: { keyType: 1, keyBytes: fromHex(info.relayKey) },
        expiry: timestamp(BigInt(info.bindingExpiry)),
        unknownFields: new Map(),
      }
    } catch {
      throw new OpenDirectoryError('relay-info')
    }
  }
  function validity(
    binding: RelayBinding,
    notBefore?: Timestamp,
  ): EntrySigningInput {
    const current = deps.nowNs()
    let issued = current - ISSUE_BACKDATE_NS
    // A later revision may not be issued before the one it follows.
    if (notBefore && issued < nanos(notBefore)) issued = nanos(notBefore)
    const limit = nanos(binding.expiry)
    const expires =
      issued + ENTRY_VALIDITY_NS < limit ? issued + ENTRY_VALIDITY_NS : limit
    // The entry being renewed was issued after this device's idea of now.
    if (issued > current) throw new OpenDirectoryError('clock', selfAddress)
    if (expires <= current + 60n * SECOND)
      throw new OpenDirectoryError('relay-info')
    return {
      issuedAt: timestamp(issued),
      expiresAt: timestamp(expires),
      now: timestamp(current),
      relay: binding,
    }
  }
  const renewalDue = (head: Evidence): boolean => {
    const life = nanos(head.expiry) - nanos(head.issued)
    const threshold = life / 2n < RENEW_BEFORE_NS ? life / 2n : RENEW_BEFORE_NS
    return nanos(head.expiry) - deps.nowNs() < threshold
  }
  const moved = (head: Evidence, binding: RelayBinding): boolean =>
    head.relay.endpoint !== binding.endpoint ||
    !same(head.relay.relayId, binding.relayId) ||
    !same(head.relay.identity.keyBytes, binding.identity.keyBytes)

  async function put(
    attestation: Uint8Array,
  ): Promise<{ status: number; body?: Uint8Array }> {
    const response = await request(`${base}/${selfSubject}/head`, 'PUT', {
      accept: MEDIA,
      limit: FRAME_LIMIT,
      body: attestation,
    })
    return { status: response.status, body: response.body }
  }
  const selfExpected = { subject: selfSubject, address: selfAddress }

  const putFailure = (status: number) =>
    new OpenDirectoryError(
      status >= 500 || status === 429 ? 'unreachable' : 'rejected',
      selfAddress,
      status,
    )
  /** Admit an own entry; an expired one is not an error here, it is renewed by the caller. */
  async function admitOwn(
    bytes: Uint8Array,
  ): Promise<{ handle: Handle; current: Current } | undefined> {
    try {
      return await admit(bytes, selfExpected)
    } catch (error) {
      if (error instanceof OpenDirectoryError && error.code === 'expired')
        return undefined
      if (
        error instanceof OpenDirectoryError &&
        (error.code === 'fork' ||
          error.code === 'invalid' ||
          error.code === 'rollback')
      ) {
        // Self-healing: Local device holds a stale, orphaned, or conflicting pin/store for our own
        // account (e.g. from an earlier session, aborted publish, or testnet wipe). Discard the
        // conflicting store/pin and adopt the server's authoritative entry signed by our own key.
        console.warn(
          `[open-directory] Healing conflicting local pin/store for ${selfAddress} (${error.code}) to adopt authoritative entry`,
        )
        const oldHandle = handles.get(selfSubject)
        if (oldHandle) {
          await drop(oldHandle)
          try {
            await deps.checkpoints.save(oldHandle.name, null as any)
          } catch {
            // ignore
          }
          try {
            if (deps.discardStore) {
              await deps.discardStore(oldHandle.name)
            } else {
              await deps.discardUnenrolled(oldHandle.name)
            }
          } catch {
            // ignore
          }
        }
        let stalePin: string | null = null
        try {
          stalePin = await deps.pins.load(`${network}:${selfAddress}`)
        } catch {
          // ignore
        }
        if (stalePin && /^[0-9a-f]{64}$/.test(stalePin)) {
          const staleName = `frank-directory:${network}:${selfSubject}:${stalePin}`
          try {
            await deps.checkpoints.save(staleName, null as any)
          } catch {
            // ignore
          }
          try {
            if (deps.discardStore) {
              await deps.discardStore(staleName)
            } else {
              await deps.discardUnenrolled(staleName)
            }
          } catch {
            // ignore
          }
        }
        opening.delete(selfSubject)
        handles.delete(selfSubject)
        try {
          await deps.pins.save(`${network}:${selfAddress}`, '')
        } catch {
          // ignore
        }
        try {
          return await admit(bytes, selfExpected)
        } catch (retryError) {
          if (
            retryError instanceof OpenDirectoryError &&
            retryError.code === 'expired'
          )
            return undefined
          throw retryError
        }
      }
      throw error
    }
  }
  // The one signed-but-unconfirmed own statement. It is saved before it is sent and sent again,
  // byte for byte, until the relay accepts it or shows a head that supersedes it. A second
  // statement is never signed for the same revision: two would be a fork that every peer
  // refuses for good.
  const pendingKey = `pending:${network}:${selfAddress}`
  const resignedKey = `resigned:${network}:${selfAddress}`
  async function loadPending(): Promise<Evidence | undefined> {
    let saved: string | null
    try {
      saved = await deps.pins.load(pendingKey)
    } catch {
      return undefined
    }
    if (!saved) return undefined
    let pending: Evidence
    try {
      pending = parse(fromHex(saved), selfAddress)
    } catch {
      await savePending(null).catch(() => undefined)
      return undefined
    }
    if (pending.subject !== selfSubject) {
      await savePending(null).catch(() => undefined)
      return undefined
    }
    return pending
  }
  async function savePending(attestation: Uint8Array | null): Promise<void> {
    try {
      await deps.pins.save(pendingKey, attestation ? toHex(attestation) : '')
    } catch {
      throw new OpenDirectoryError('storage', selfAddress)
    }
  }
  const supersedes = (head: Evidence, pending: Evidence): boolean =>
    same(head.hash, pending.hash) || head.revision >= pending.revision
  type Admitted = { handle: Handle; current: Current } | undefined
  /** Send the saved statement. It stays saved unless the relay took it or moved past it. */
  async function sendPending(
    pending: Evidence,
  ): Promise<{ head: Evidence; admitted: Admitted }> {
    const bytes = pending.candidate.attestation
    const answer = await put(bytes)
    if (answer.status === 200) {
      await savePending(null)
      return { head: pending, admitted: await admitOwn(bytes) }
    }
    if (answer.status === 409) {
      // Another device got there first (or the relay kept ours earlier): adopt what it holds.
      const winner = await getEntry(`/${selfSubject}/head`, 'fresh-current')
      const head = winner && parse(winner, selfAddress)
      if (winner && head && supersedes(head, pending)) {
        await savePending(null)
        return { head, admitted: await admitOwn(winner) }
      }
    }
    throw putFailure(answer.status)
  }
  /** Hand a relay that lacks it the chain this device retains, oldest first. Signs nothing. */
  async function handOver(local: Handle, retained: Evidence): Promise<void> {
    const chain = [retained]
    while (chain[0].predecessor) {
      const evidence = await local.store.historicalEvidence(
        chain[0].predecessor,
      )
      if (!evidence) throw new OpenDirectoryError('storage', selfAddress)
      chain.unshift(parse(evidence.attestation, selfAddress))
    }
    for (const revision of chain) {
      const answer = await put(revision.candidate.attestation)
      if (answer.status !== 200) throw putFailure(answer.status)
    }
  }
  async function publishOnce(reread = true): Promise<DirectoryEntry> {
    const binding = await relayBinding()
    const served = await getEntry(`/${selfSubject}/head`, 'fresh-current')
    const servedHead = served ? parse(served, selfAddress) : undefined
    let pending = await loadPending()
    if (pending && servedHead && supersedes(servedHead, pending)) {
      // The relay did keep it (the answer was lost), or the account has moved past it.
      await savePending(null)
      pending = undefined
    }
    let head: Evidence
    let admitted: Admitted
    if (!pending && served && servedHead) {
      // The relay already has this account (another device, or an earlier session): adopt it
      // instead of signing a second, conflicting revision zero.
      head = servedHead
      admitted = await admitOwn(served)
    } else {
      const local = await pinnedHandle(selfSubject, selfAddress)
      const retained = local && (await retainedHead(local))
      if (!servedHead && local && retained)
        // This device holds the account's chain but the relay does not (a new relay, or one
        // that lost it): hand the same signed revisions over. Nothing new is signed.
        await handOver(local, retained)
      if (pending)
        try {
          ;({ head, admitted } = await sendPending(pending))
        } catch (error) {
          // The saved statement is still not accepted. The entry the relay does hold stays
          // usable meanwhile, unless it names another relay than the configured one.
          const current =
            served && servedHead && !moved(servedHead, binding)
              ? await admitOwn(served)
              : undefined
          if (!current || !servedHead) throw error
          return entry(current.handle, current.current)
        }
      else if (local && retained) {
        head = retained
        admitted = await admitOwn(retained.candidate.attestation)
      } else {
        const attestation = await deps.self.signRevisionZero(validity(binding))
        await savePending(attestation)
        ;({ head, admitted } = await sendPending(
          parse(attestation, selfAddress),
        ))
      }
    }
    if (head.subject !== selfSubject)
      throw new OpenDirectoryError('invalid', selfAddress)
    const relocating = moved(head, binding)
    if (!admitted || relocating || renewalDue(head)) {
      const input = validity(binding, head.issued)
      // Renewing for time only is pointless unless the relay lets the entry live longer.
      if (
        !admitted ||
        relocating ||
        nanos(input.expiresAt) > nanos(head.expiry) + 3600n * SECOND
      ) {
        renewTriedAt = Date.now()
        // Sign only against the head the relay holds right now, never a remembered one: another
        // device of this account may have renewed meanwhile, and two children of one head are a
        // fork. If the head moved, start over from it (once).
        const fresh = await getEntry(`/${selfSubject}/head`, 'fresh-current')
        if (fresh && !same(parse(fresh, selfAddress).hash, head.hash)) {
          if (reread) return publishOnce(false)
          throw new OpenDirectoryError('unreachable', selfAddress)
        }
        const signedAt = deps.nowNs()
        let last = 0n
        try {
          last = BigInt((await deps.pins.load(resignedKey)) || '0')
        } catch {
          last = 0n
        }
        if (
          last > 0n &&
          signedAt >= last &&
          signedAt - last < RESIGN_INTERVAL_NS
        ) {
          // Already signed one renewal or move this period. A relay that keeps changing what it
          // says about itself, or a short-lived entry, cannot make this account sign more.
          if (admitted && !relocating)
            return entry(admitted.handle, admitted.current)
          throw new OpenDirectoryError(
            relocating ? 'relay-info' : 'expired',
            selfAddress,
          )
        }
        try {
          await deps.pins.save(resignedKey, signedAt.toString())
        } catch {
          // Non-fatal
        }
        const attestation = await deps.self.signNextRevision({
          ...input,
          revision: head.revision + 1n,
          predecessor: head.hash,
        })
        await savePending(attestation)
        try {
          ;({ admitted } = await sendPending(parse(attestation, selfAddress)))
        } catch (error) {
          // The signed renewal stays saved and is sent again next time. Until then an entry
          // that is still current stays usable; a move that did not happen is not reported done.
          if (!admitted || relocating) throw error
        }
      }
    }
    if (!admitted) throw new OpenDirectoryError('expired', selfAddress)
    return entry(admitted.handle, admitted.current)
  }
  const publish = (): Promise<DirectoryEntry> =>
    (publishing ??= publishOnce(true)
      .then(entry => {
        published = true
        return entry
      })
      .finally(() => {
        publishing = undefined
      }))

  async function isHomeRelay(endpoint: string): Promise<boolean> {
    try {
      const normEndpoint = endpoint.replace(/\/$/, '')
      const peerOrigin = new URL(normEndpoint).origin
      if (peerOrigin === origin || matchesRelayOrigin(endpoint, origin)) return true
      if (!bindingEndpoint) {
        await relayBinding().catch(() => undefined)
      }
      if (
        bindingEndpoint &&
        (peerOrigin === new URL(bindingEndpoint.replace(/\/$/, '')).origin ||
          matchesRelayOrigin(endpoint, bindingEndpoint))
      )
        return true
      const peerIsLoopback = isLoopbackHostname(new URL(normEndpoint).hostname)
      const originIsLoopback = isLoopbackHostname(new URL(origin).hostname)
      if (peerIsLoopback && originIsLoopback) return true
      if (peerIsLoopback && bindingEndpoint) {
        const bindingIsLoopback = isLoopbackHostname(
          new URL(bindingEndpoint).hostname,
        )
        if (bindingIsLoopback) return true
      }
    } catch {
      return false
    }
    return false
  }

  return {
    network,
    homeEndpoint: origin + '/',
    isHomeRelay,
    publish,
    async selfCurrent() {
      const handle = handles.get(selfSubject)
      if (!handle?.head) {
        if (!published) throw new OpenDirectoryError('unpublished', selfAddress)
        // The store was dropped after a storage failure: reopen it through a normal publish.
        return (await publish()).current
      }
      if (
        renewalDue(handle.head) &&
        Date.now() - renewTriedAt > RENEW_RETRY_MS
      ) {
        renewTriedAt = Date.now()
        // Renewal runs beside normal use; the entry stays usable until it actually expires.
        void publish().catch(() => undefined)
      }
      try {
        return await serial(selfSubject, () =>
          handle.store.current(context(handle.head!.relay)),
        )
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'validity')
          throw refusal(error, selfAddress)
        return (await publish()).current
      }
    },
    peerCurrent: peer,
    async peerHistorical({
      subject,
      statementHash,
    }: {
      subject: string
      statementHash: string
    }): Promise<HistoricalEvidence | undefined> {
      const normHash = statementHash.toLowerCase()
      const hashBytes = fromHex(normHash)
      const handle = handles.get(subject)
      if (handle) {
        try {
          const evidence = await serial(subject, () =>
            handle.store.historicalEvidence(hashBytes),
          )
          if (evidence) return evidence
        } catch {
          // ignore
        }
      }
      try {
        const bytes = await getEntry(
          `/${subject}/statements/${normHash}`,
          'historical',
        )
        if (bytes) {
          const verified = verifyPreviewDirectoryEvidence(bytes, network)
          if (toHex(verified.statementHash).toLowerCase() === normHash) {
            return {
              kind: 'historical-evidence',
              hash: verified.statementHash,
              statement: verified.statementFrame.frame,
              attestation: bytes,
            }
          }
        }
      } catch {
        // ignore
      }
      return undefined
    },
    async forwarding() {
      if (Date.now() - forwardingReadAt > FORWARDING_REFRESH_MS)
        try {
          await relayBinding()
        } catch {
          // Unknown right now: treated as "cannot forward", which only refuses a send.
          forwarding = false
        }
      return forwarding
    },
    async lookup(address) {
      const found = await peer({ address })
      if (!found)
        throw new OpenDirectoryError('not-published', address.toLowerCase())
      return found
    },
    async close() {
      closed = true
      await Promise.allSettled([...opening.values()])
      for (const handle of [...handles.values()]) {
        handles.delete(handle.subject)
        await serial(handle.subject, () => handle.store.close()).catch(
          () => undefined,
        )
      }
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
/** Whole-checkpoint serialization for storage outside the admission store. */
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
