/** Exact directory HTTP evidence over an independently authenticated, installed HTTPS channel.
 * Storage and continuity are injected public facades; this client never selects a backend.
 */
import {
  contentHash,
  previewDirectoryContext,
  toHex,
  validateFrame,
} from '@frank/codec'
import type { ParsedFrame } from '@frank/codec'
import type {
  Candidate,
  Checkpoint,
  Context,
  Current,
  DirectoryStore,
} from '@frank/directory-admission'
const MEDIA = 'application/vnd.frank.cbor'
const LIMIT = 262144
export interface DirectoryResponse {
  status: number
  url: string
  headers: { get(name: string): string | null }
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<void>
    }
  } | null
}
export type DirectoryFetch = (
  url: string,
  init: {
    method: 'GET' | 'PUT'
    headers: Record<string, string>
    body?: Uint8Array
    redirect: 'error'
    credentials: 'omit'
    signal: unknown
  },
) => Promise<DirectoryResponse>
export interface DirectoryClientOptions {
  network: string
  subject: string
  /** Exact independently authenticated installed relay origin, never derived from a response. */
  endpoint: string
  store: DirectoryStore
  context(): Context
  /** Caller owns durable external continuity, including prospective enrollment. */
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>
  fetch: DirectoryFetch
}
export interface DirectoryAttempt {
  readonly network: string
  readonly subject: string
  readonly t1: string
  readonly bytes: Uint8Array
  readonly priorCheckpoint: Checkpoint | null
}
export class DirectoryClientError extends Error {
  constructor(
    readonly disposition: 'not-started' | 'outcome-unknown' | 'rejected',
    readonly status?: number,
  ) {
    super(`Directory request ${disposition}`)
  }
}
function frame(bytes: Uint8Array): ParsedFrame {
  const result = validateFrame(bytes, previewDirectoryContext())
  if (result.kind !== 'parsed')
    throw new Error('Exact directory frame required')
  return result
}
function candidate(bytes: Uint8Array): Candidate {
  if (bytes.length > LIMIT) throw new Error('Directory frame bound')
  const parsed = frame(bytes)
  if (parsed.typeId !== 2 || !(parsed.payload instanceof Map))
    throw new Error('Directory attestation required')
  const statement = parsed.payload.get(0n)
  if (!(statement instanceof Uint8Array))
    throw new Error('Exact embedded statement required')
  const child = frame(statement)
  if (child.typeId !== 4 || child.schemaVersion !== 4)
    throw new Error('Directory schema 4 required')
  return { statement: statement.slice(), attestation: bytes.slice() }
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
function snapshot<T>(value: T): T {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as T
  if (value instanceof Map)
    return new Map([...value].map(([key, item]) => [key, snapshot(item)])) as T
  if (Array.isArray(value)) return value.map(snapshot) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, snapshot(item)]),
    ) as T
  return value
}
export function createDirectoryClient(options: DirectoryClientOptions) {
  let unavailable = false
  const persist = async (checkpoint: Checkpoint) => {
    try {
      await options.saveCheckpoint(snapshot(checkpoint))
    } catch (error) {
      unavailable = true
      throw error
    }
  }
  const network = options.network,
    subject = options.subject,
    endpoint = options.endpoint
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(network) ||
    !/^(02|03)[0-9a-f]{64}$/.test(subject)
  )
    throw new Error('Exact directory identity required')
  const origin = new URL(endpoint)
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  )
    throw new Error('Installed HTTPS origin required')
  const base = origin.origin + `/directory/v1/${network}/${subject}`
  const context = () => {
    const ctx = snapshot(options.context())
    if (!ctx.now || !ctx.relay || ctx.relay.endpoint !== endpoint)
      throw new Error('Fresh installed directory context required')
    return ctx
  }
  async function request(
    path: string,
    method: 'GET' | 'PUT',
    bytes?: Uint8Array,
  ) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Directory transport deadline'))
      }, 65000)
    })
    let reader:
      | ReturnType<NonNullable<DirectoryResponse['body']>['getReader']>
      | undefined
    try {
      const response = await Promise.race([
        options.fetch(base + path, {
          method,
          headers: { 'Content-Type': MEDIA, 'Accept': MEDIA },
          body: bytes,
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        }),
        deadline,
      ])
      if (response.url !== base + path)
        throw new Error('Directory response origin/path mismatch')
      if (response.status !== 200) {
        // A disconnect or 503 after PUT cannot establish that native work never started.
        throw new DirectoryClientError(
          response.headers.get('x-frank-directory-disposition') ===
          'not-started'
            ? 'not-started'
            : response.status === 503
            ? 'outcome-unknown'
            : 'rejected',
          response.status,
        )
      }
      if (
        response.headers.get('content-type') !== MEDIA ||
        response.headers.get('x-frank-directory-evidence') !==
          (path === '/head' ? 'fresh-current' : 'historical') ||
        !response.body
      )
        throw new Error('Exact directory response required')
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline])
        if (done) break
        if (!value || length + value.length > LIMIT)
          throw new Error('Directory response bound')
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
    } catch (error) {
      if (error instanceof DirectoryClientError) throw error
      throw new DirectoryClientError(
        method === 'PUT' ? 'outcome-unknown' : 'rejected',
      )
    } finally {
      clearTimeout(timer!)
      void reader?.cancel().catch(() => undefined)
    }
  }
  async function admit(
    bytes: Uint8Array,
    prefix: readonly Candidate[] = [],
  ): Promise<{
    kind: 'fresh-current'
    current: Current
    frame: Uint8Array
    t1: string
  }> {
    if (unavailable)
      throw new Error(
        'Directory continuity unavailable; verified reopen required',
      )
    const head = candidate(bytes),
      chain = [...prefix.map(snapshot), head]
    const ctx = context(),
      status = await options.store.status()
    if (!status) {
      await persist(
        await options.store.checkpointForEnrollment(chain[0], ctx.now!),
      )
      await options.store.enroll(chain, ctx)
    } else {
      const hash = contentHash(frame(head.statement))
      const retained =
        prefix.length === 0
          ? await options.store.historicalEvidence(hash)
          : null
      if (
        retained &&
        same(retained.statement, head.statement) &&
        same(retained.attestation, head.attestation)
      )
        await options.store.current(ctx)
      else {
        try {
          await options.store.advance(chain, ctx)
        } catch (error) {
          if ((error as { code?: string }).code === 'fork') {
            const fork = await options.store.status()
            if (fork) await persist(fork.checkpoint)
          }
          throw error
        }
      }
    }
    const current = await options.store.current(context())
    await persist(current.status.checkpoint)
    return {
      kind: 'fresh-current',
      current,
      frame: current.evidence.attestation.slice(),
      t1: toHex(current.evidence.hash),
    }
  }
  return {
    async current(prefix: readonly Candidate[] = []) {
      return admit(await request('/head', 'GET'), prefix)
    },
    async preparePut(bytes: Uint8Array): Promise<DirectoryAttempt> {
      const c = candidate(bytes),
        prior = await options.store.status()
      return {
        network,
        subject,
        t1: toHex(contentHash(frame(c.statement))),
        bytes: bytes.slice(),
        priorCheckpoint: prior ? snapshot(prior.checkpoint) : null,
      }
    },
    async put(attempt: DirectoryAttempt, prefix: readonly Candidate[] = []) {
      if (
        attempt.network !== network ||
        attempt.subject !== subject ||
        toHex(contentHash(frame(candidate(attempt.bytes).statement))) !==
          attempt.t1
      )
        throw new Error('Exact retained directory attempt required')
      return admit(await request('/head', 'PUT', attempt.bytes.slice()), prefix)
    },
    async historical(t1: string) {
      if (!/^[0-9a-f]{64}$/.test(t1)) throw new Error('Exact T1 required')
      const bytes = await request('/statements/' + t1, 'GET'),
        c = candidate(bytes),
        hash = contentHash(frame(c.statement))
      if (toHex(hash) !== t1) throw new Error('Historical T1 mismatch')
      const retained = await options.store.historicalEvidence(hash)
      if (
        !retained ||
        !same(retained.statement, c.statement) ||
        !same(retained.attestation, c.attestation)
      )
        throw new Error('Historical chain is not independently admitted')
      return { kind: 'historical' as const, frame: bytes.slice(), t1 }
    },
    /** No automatic retry: first authenticate a supplied catch-up chain/current, then exact history. */
    async resolve(
      attempt: DirectoryAttempt,
      prefix: readonly Candidate[] = [],
    ) {
      const current = await this.current(prefix)
      const historical = await this.historical(attempt.t1)
      if (!same(historical.frame, attempt.bytes))
        throw new Error('Exact attempt evidence mismatch')
      return { current, historical }
    },
  }
}
