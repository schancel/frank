/**
 * Canonical (#780) transport for the blackjack dealer: the same wallet-owned canonical direct
 * message client the app uses (`@frank/wallet/chain/monad-canonical-dm`), plus the two small
 * durable records the dealer itself must own:
 *
 *  - an **outbox**: every reply the dealer decides to send is saved first, then delivered in
 *    order through exactly one sealed envelope and one payment set. A crash or an unknown relay
 *    outcome re-sends the same journaled bytes; it never seals or pays a second time.
 *  - **actor bindings**: which directory-admitted subject opened a game. In canonical mode the
 *    authenticated sender (identity point P) is not the account that pays the wager (the typed
 *    wallet's EVM account), so "who may act" and "who is paid" are two addresses. The game
 *    record's `playerAddress` stays the verified wager sender (the payout address, unchanged);
 *    this binding is who may hit, stand or double.
 *
 * Nothing here encodes wire bytes, seals, signs or holds keys. No legacy envelope is ever built.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import { computeAddress } from 'ethers'
import level, { LevelDB } from 'level'

import type { MessageItem } from '@frank/cashweb/types/messages'
import type {
  DirectMessageClient,
  DirectMessageReceived,
  WalletHandle,
} from '@frank/wallet/chain/active-chain'
import type { CanonicalDirectory } from '@frank/wallet/chain/monad-canonical-dm'
import type { Current } from '@frank/directory-admission'

/** Open (not yet delivered or dead) replies the outbox will hold before refusing new ones. */
export const BLACKJACK_OUTBOX_MAX_OPEN = 1024
/** Serialized size bound of one saved reply's items. A type-18 frame is at most 4096 bytes. */
export const BLACKJACK_OUTBOX_MAX_ITEM_BYTES = 16 * 1024
const MAX_KEY_BYTES = 256

/**
 * `queued`    saved; no send was started, or one failed before any payment record existed.
 * `sending`   a send was started and this process has not yet learned its outcome. Only a
 *             process death leaves a row here.
 * `attempt`   the wallet journaled exactly one payment set for this row (`digest`). Only those
 *             bytes are ever sent for it again.
 * `delivered` the relay committed it. Final.
 * `dead`      the relay ended that payment set. Final: never re-sealed or re-paid.
 */
export type BlackjackOutboxPhase =
  | 'queued'
  | 'sending'
  | 'attempt'
  | 'delivered'
  | 'dead'

export interface BlackjackOutboxRow {
  seq: number
  /** Caller-chosen idempotency key: one reply per key, ever. */
  key: string
  /** The recipient's identity address (derived from its installed subject). */
  recipient: string
  /** Dropped once the row is final. */
  items?: MessageItem[]
  phase: BlackjackOutboxPhase
  /** Bare-hex payload digest of the one payment set, once it exists. */
  digest?: string
}

export interface BlackjackActorBinding {
  /** Lowercase identity address of the directory-admitted subject that placed the bet. */
  actor: string
  /** The wager this binding was made for; a binding never authorizes another game record. */
  wagerTxHash: string
}

const ROW_PREFIX = 'row:'
const KEY_PREFIX = 'key:'
const ACTOR_PREFIX = 'actor:'
const rowKey = (seq: number) => ROW_PREFIX + seq.toString().padStart(12, '0')

function validRow(value: unknown): value is BlackjackOutboxRow {
  const row = value as BlackjackOutboxRow
  const final = row?.phase === 'delivered' || row?.phase === 'dead'
  return (
    !!row &&
    typeof row === 'object' &&
    Number.isSafeInteger(row.seq) &&
    row.seq >= 0 &&
    typeof row.key === 'string' &&
    typeof row.recipient === 'string' &&
    /^0x[0-9a-f]{40}$/.test(row.recipient) &&
    ['queued', 'sending', 'attempt', 'delivered', 'dead'].includes(row.phase) &&
    (final || Array.isArray(row.items)) &&
    (row.digest === undefined || /^[0-9a-f]{64}$/.test(row.digest)) &&
    // A payment set is what makes a row an attempt, delivered or dead.
    (row.digest !== undefined) ===
      (row.phase === 'attempt' || row.phase === 'delivered' || final)
  )
}

/** Durable outbox rows and actor bindings. Every write is synced before it is visible. */
export class BlackjackCanonicalStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private readonly rows = new Map<number, BlackjackOutboxRow>()
  private readonly keys = new Map<string, number>()
  private readonly actors = new Map<string, BlackjackActorBinding>()
  private nextSeq = 0

  constructor(location: string) {
    this.dbLocation = join(location, 'blackjack-canonical-state')
  }

  private get db(): LevelDB {
    if (!this.openedDb) throw new Error('No db opened')
    return this.openedDb
  }

  private async synced(
    operations: { type: 'put'; key: string; value: string }[],
  ): Promise<void> {
    // level@7 has an atomic batch at runtime, but its legacy type alias omits it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.db as any).batch(operations, { sync: true })
  }

  async Open(): Promise<void> {
    mkdirSync(this.dbLocation, { recursive: true })
    this.openedDb = level(this.dbLocation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key.startsWith(ROW_PREFIX)) {
        const row: unknown = JSON.parse(value)
        // A row this code cannot account for is never guessed at: refuse to run on it.
        if (!validRow(row) || rowKey(row.seq) !== key)
          throw new Error(`blackjack outbox row ${key} is not valid`)
        this.rows.set(row.seq, row)
        this.keys.set(row.key, row.seq)
        this.nextSeq = Math.max(this.nextSeq, row.seq + 1)
      } else if (key.startsWith(ACTOR_PREFIX)) {
        const binding = JSON.parse(value) as BlackjackActorBinding
        if (
          typeof binding?.actor !== 'string' ||
          typeof binding.wagerTxHash !== 'string'
        )
          throw new Error(`blackjack actor binding ${key} is not valid`)
        this.actors.set(key.slice(ACTOR_PREFIX.length), binding)
      }
    }
  }

  async Close(): Promise<void> {
    await this.db.close()
  }

  /** Every row, oldest first. */
  all(): BlackjackOutboxRow[] {
    return [...this.rows.values()].sort((a, b) => a.seq - b.seq)
  }

  open(): BlackjackOutboxRow[] {
    return this.all().filter(
      row => row.phase !== 'delivered' && row.phase !== 'dead',
    )
  }

  has(key: string): boolean {
    return this.keys.has(key)
  }

  /** Saves one reply. `'duplicate'` when the key already has a row (nothing is changed). */
  async enqueue(
    key: string,
    recipient: string,
    items: MessageItem[],
  ): Promise<'saved' | 'duplicate'> {
    if (this.keys.has(key)) return 'duplicate'
    if (key.length === 0 || Buffer.byteLength(key) > MAX_KEY_BYTES)
      throw new Error('blackjack outbox key is empty or too long')
    const to = recipient.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(to))
      throw new Error('blackjack outbox recipient is not an address')
    if (
      items.length === 0 ||
      Buffer.byteLength(JSON.stringify(items)) > BLACKJACK_OUTBOX_MAX_ITEM_BYTES
    )
      throw new Error('blackjack outbox reply is empty or too large')
    if (this.open().length >= BLACKJACK_OUTBOX_MAX_OPEN)
      throw new Error('blackjack outbox is full; nothing was saved')
    const row: BlackjackOutboxRow = {
      seq: this.nextSeq,
      key,
      recipient: to,
      items: JSON.parse(JSON.stringify(items)),
      phase: 'queued',
    }
    await this.synced([
      { type: 'put', key: rowKey(row.seq), value: JSON.stringify(row) },
    ])
    this.rows.set(row.seq, row)
    this.keys.set(key, row.seq)
    this.nextSeq = row.seq + 1
    return 'saved'
  }

  /** The only way a row changes. Transitions never go backwards from a payment set. */
  async advance(
    seq: number,
    phase: BlackjackOutboxPhase,
    digest?: string,
  ): Promise<BlackjackOutboxRow> {
    const current = this.rows.get(seq)
    if (!current) throw new Error('unknown blackjack outbox row')
    const allowed: Record<BlackjackOutboxPhase, BlackjackOutboxPhase[]> = {
      queued: ['sending'],
      sending: ['queued', 'attempt'],
      attempt: ['delivered', 'dead'],
      delivered: [],
      dead: [],
    }
    if (!allowed[current.phase].includes(phase))
      throw new Error(
        `blackjack outbox row cannot go from ${current.phase} to ${phase}`,
      )
    const nextDigest = current.digest ?? digest
    if (current.digest !== undefined && digest !== undefined) {
      if (current.digest !== digest)
        throw new Error('blackjack outbox row already has another payment set')
    }
    const final = phase === 'delivered' || phase === 'dead'
    const next: BlackjackOutboxRow = {
      seq,
      key: current.key,
      recipient: current.recipient,
      ...(final ? {} : { items: current.items }),
      phase,
      ...(phase === 'queued' || phase === 'sending'
        ? {}
        : { digest: nextDigest }),
    }
    if (!validRow(next))
      throw new Error('blackjack outbox transition is not valid')
    await this.synced([
      { type: 'put', key: rowKey(seq), value: JSON.stringify(next) },
    ])
    this.rows.set(seq, next)
    return next
  }

  digests(): string[] {
    return this.all().flatMap(row => (row.digest ? [row.digest] : []))
  }

  actor(gameId: string): BlackjackActorBinding | undefined {
    return this.actors.get(gameId)
  }

  async bindActor(
    gameId: string,
    binding: BlackjackActorBinding,
  ): Promise<void> {
    await this.synced([
      {
        type: 'put',
        key: ACTOR_PREFIX + gameId,
        value: JSON.stringify(binding),
      },
    ])
    this.actors.set(gameId, { ...binding })
  }
}

type CanonicalMessages = Pick<
  DirectMessageClient,
  'send' | 'reconcileAttempts' | 'unattributedAttempts'
>

/**
 * Delivers saved replies in order, one at a time. For every row at most one sealed envelope and
 * one payment set ever exist:
 *
 *  - `send` is called for a row only while no payment set is recorded for it and the wallet
 *    reports no payment set this outbox cannot account for;
 *  - the digest is saved (synced) inside the wallet's own durable-intent callback, before the
 *    relay is contacted;
 *  - afterwards only `reconcileAttempts` runs for it, which re-sends the same journaled bytes
 *    and never builds or signs a payment.
 *
 * `drive` never throws; a row it cannot finish now is retried on a later call.
 */
export class BlackjackCanonicalOutbox {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly reported = new Set<string>()

  constructor(
    private readonly options: {
      store: BlackjackCanonicalStore
      messages: CanonicalMessages
      wallet: WalletHandle
      stampValueWei: bigint
      label?: string
    },
  ) {}

  private note(row: BlackjackOutboxRow, reason: string): void {
    // Fixed reason words and the row key only; no message content or error text.
    const key = `${row.seq}:${reason}`
    if (this.reported.has(key)) return
    this.reported.add(key)
    console.warn(
      `[${this.options.label ?? 'blackjack-bot'}] reply ${
        row.key
      } waiting: ${reason}`,
    )
  }

  enqueue(
    key: string,
    recipient: string,
    items: MessageItem[],
  ): Promise<'saved' | 'duplicate'> {
    return this.options.store.enqueue(key, recipient, items)
  }

  /** Returns how many rows became delivered in this pass. */
  drive(): Promise<number> {
    const next = this.queue.then(() => this.pass())
    this.queue = next.catch(() => undefined)
    return next.catch(() => 0)
  }

  private async pass(): Promise<number> {
    const { store, messages, wallet, stampValueWei } = this.options
    let delivered = 0
    for (;;) {
      let row = store.open()[0]
      if (!row) return delivered
      if (row.phase === 'sending') {
        // The process died inside a send. The wallet says whether a payment set exists that no
        // row accounts for; if so it is this row's (the outbox is strictly serial).
        let orphans: string[]
        try {
          orphans = await messages.unattributedAttempts({
            wallet,
            knownDigests: store.digests(),
          })
        } catch {
          this.note(row, 'wallet-correlation-held')
          return delivered
        }
        if (orphans.length > 1) {
          this.note(row, 'unaccounted-payment-sets')
          return delivered
        }
        row =
          orphans.length === 1
            ? await store.advance(row.seq, 'attempt', orphans[0])
            : await store.advance(row.seq, 'queued')
      }
      if (row.phase === 'attempt') {
        let status: string | undefined
        try {
          status = (
            await messages.reconcileAttempts({
              wallet,
              payloadDigests: [row.digest!],
            })
          )[row.digest!]
        } catch {
          this.note(row, 'wallet-correlation-held')
          return delivered
        }
        if (status === 'delivered') {
          await store.advance(row.seq, 'delivered')
          delivered++
          continue
        }
        if (status === 'dead') {
          await store.advance(row.seq, 'dead')
          console.error(
            `[${this.options.label ?? 'blackjack-bot'}] reply ${
              row.key
            } can never be delivered (payment set ${
              row.digest
            } ended by the relay); it is NOT re-sent`,
          )
          continue
        }
        // Live, or not known to the wallet: never a reason to pay again.
        this.note(
          row,
          status === 'live' ? 'delivery-pending' : 'attempt-unknown',
        )
        return delivered
      }
      // Queued: no payment set exists for this row.
      const seq = row.seq
      await store.advance(seq, 'sending')
      try {
        const sent = await messages.send({
          wallet,
          recipient: { raw: row.recipient },
          items: row.items!,
          stampValue: stampValueWei,
          // Awaited by the wallet inside its durable-intent step, before any relay request.
          onAttemptCreated: async digest => {
            await store.advance(seq, 'attempt', digest)
          },
        })
        if (store.all().find(r => r.seq === seq)!.phase !== 'attempt')
          await store.advance(seq, 'attempt', sent.payloadDigest)
        await store.advance(seq, 'delivered', sent.payloadDigest)
        delivered++
      } catch {
        const after = store.all().find(r => r.seq === seq)!
        if (after.phase === 'sending') {
          // The wallet never reported a durable payment set for this call.
          await store.advance(seq, 'queued')
          this.note(after, 'send-not-started')
        } else this.note(after, 'delivery-pending')
        return delivered
      }
    }
  }
}

/** What the bot needs from its installed directory (`QwenInstalledDirectory` satisfies it). */
export interface InstalledDirectoryView {
  readonly network: string
  readonly homeEndpoint: string
  selfCurrent(): Promise<Current>
  peerCurrent(subject: string, refresh?: boolean): Promise<Current | undefined>
}

/** An installed `ui` subject whose directory entry cannot be read right now. Not a reason to
 * drop its mail: the inbox read fails and is retried, and nothing is sent or paid. */
export class InstalledPeerUnavailableError extends Error {
  constructor() {
    super('An installed peer has no readable directory entry right now')
    this.name = 'InstalledPeerUnavailableError'
  }
}

/**
 * The wallet client's directory view over the bot's installed directory. A peer is one of the
 * operator-installed `ui` subjects and nobody else. An uninstalled sender is reported as unknown
 * (its mail can never be opened); an installed one that is momentarily unreadable throws.
 */
export function canonicalDirectoryFor(params: {
  installed: InstalledDirectoryView
  /** Compressed identity points (lowercase hex) of the installed `ui` subjects. */
  peerSubjects: readonly string[]
  fetch?: CanonicalDirectory['fetch']
}): CanonicalDirectory {
  const { installed } = params
  const byAddress = new Map(
    params.peerSubjects.map(subject => [
      computeAddress('0x' + subject).toLowerCase(),
      subject,
    ]),
  )
  return {
    network: installed.network,
    homeEndpoint: installed.homeEndpoint,
    selfCurrent: () => installed.selfCurrent(),
    async peerCurrent(peer) {
      const subject =
        'subject' in peer
          ? params.peerSubjects.find(s => s === peer.subject)
          : byAddress.get(peer.address.toLowerCase())
      if (!subject) return undefined
      const current = await installed.peerCurrent(subject)
      if (!current) throw new InstalledPeerUnavailableError()
      // Same-relay only: the installed directory already refused any other home.
      return { subject, endpoint: installed.homeEndpoint, current }
    },
    ...(params.fetch ? { fetch: params.fetch } : {}),
  }
}

/** One authenticated canonical inbox message in the shape the dealer's poll loop consumes. */
export interface CanonicalBlackjackInbound {
  timestamp: number
  message: { payloadHash: Uint8Array }
  received: DirectMessageReceived
}

export function canonicalInbound(
  received: DirectMessageReceived[],
): CanonicalBlackjackInbound[] {
  return received.map(message => ({
    timestamp: message.receivedTime,
    message: {
      payloadHash: new Uint8Array(Buffer.from(message.payloadDigest, 'hex')),
    },
    received: message,
  }))
}
