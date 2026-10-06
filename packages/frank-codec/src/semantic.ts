// Stage 9: semantic checks that need no cryptography (README section 5, S3-S10, T3a.5).
import { FrankCodecError } from './errors'
import { utf8Encode } from './utf8'
import { isCompressedPoint } from './point'
import { contentHash } from './hash'
import { MAX_DIRECTORY_VALIDITY_NS } from './constants'
import type {
  AccountRef,
  DirectoryStatement,
  FinalPayload,
  KeyTransitionStatement,
  ParsedFrame,
  Timestamp,
  ForumCursor,
  ForumTopicPage,
  ForumDiscoveryPage,
} from './types'

const semantic = (message: string, location = 'root'): FrankCodecError =>
  new FrankCodecError('semantic', '9', message, location)

/** S1a: unsigned byte-wise lexicographic comparison; a shorter equal prefix sorts first. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

function cmpNum(a: number | bigint, b: number | bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** S2: account references are ordered by (key_type, key_bytes). */
export function compareAccounts(a: AccountRef, b: AccountRef): number {
  return cmpNum(a.keyType, b.keyType) || compareBytes(a.keyBytes, b.keyBytes)
}

export function accountsEqual(a: AccountRef, b: AccountRef): boolean {
  return compareAccounts(a, b) === 0
}

function compareTimestamps(a: Timestamp, b: Timestamp): number {
  return cmpNum(a.seconds, b.seconds) || cmpNum(a.nanoseconds, b.nanoseconds)
}

function checkForumPage(
  page: ForumTopicPage<ParsedFrame> | ForumDiscoveryPage,
): void {
  const rows = page.type === 13 ? page.rows : page.entries
  if (!rows.length && page.nextCursor)
    throw semantic('empty page has continuation')
  const bind = (cursor: ForumCursor) => {
    if (
      cursor.family !== page.type ||
      cursor.network !== page.network ||
      cursor.revision !== page.revision ||
      compareBytes(cursor.epoch, page.epoch)
    )
      throw semantic('cursor page binding')
    if (
      cursor.family === 13 &&
      page.type === 13 &&
      (cursor.topic !== page.topic ||
        compareTimestamps(cursor.since, page.since))
    )
      throw semantic('cursor query binding')
  }
  if (page.requestCursor) bind(page.requestCursor)
  if (page.nextCursor) bind(page.nextCursor)
  if (
    page.requestCursor &&
    page.nextCursor &&
    page.requestCursor.incarnation !== page.nextCursor.incarnation
  )
    throw semantic('cursor incarnation changed')
  if (page.type === 13) {
    let previous =
      page.requestCursor?.family === 13 ? page.requestCursor.last : undefined
    const hashes: Uint8Array[] = []
    for (const row of page.rows) {
      const view = row.typed
      if (view?.type !== 12 || view.postFrame.typed?.type !== 9)
        throw semantic('required Forum view')
      if (
        view.network !== page.network ||
        view.postFrame.typed.topic !== page.topic ||
        view.revision !== page.revision ||
        compareBytes(view.epoch, page.epoch)
      )
        throw semantic('Forum row binding')
      const current = {
        timestamp: view.firstVisible,
        hash: contentHash(view.postFrame),
      }
      if (compareTimestamps(current.timestamp, page.since) < 0)
        throw semantic('Forum row before inclusive since')
      if (
        previous &&
        (compareTimestamps(previous.timestamp, current.timestamp) ||
          compareBytes(previous.hash, current.hash)) >= 0
      )
        throw semantic('Forum rows not strictly ordered')
      if (hashes.some(hash => compareBytes(hash, current.hash) === 0))
        throw semantic('duplicate Forum post')
      hashes.push(current.hash)
      previous = current
    }
    if (
      page.nextCursor?.family === 13 &&
      (!previous ||
        compareTimestamps(page.nextCursor.last.timestamp, previous.timestamp) ||
        compareBytes(page.nextCursor.last.hash, previous.hash))
    )
      throw semantic('continuation is not last Forum row')
  } else {
    let previous =
      page.requestCursor?.family === 14 ? page.requestCursor.last : undefined
    for (const row of page.entries) {
      if (
        previous !== undefined &&
        compareBytes(utf8Encode(previous), utf8Encode(row.topic)) >= 0
      )
        throw semantic('discovery rows not strictly ordered')
      previous = row.topic
    }
    if (page.nextCursor?.family === 14 && page.nextCursor.last !== previous)
      throw semantic('continuation is not last discovery row')
  }
}

/** Requires `items` ascending under `cmp`; `strict` also rejects equal neighbours. */
function requireOrdered<T>(
  items: readonly T[],
  cmp: (a: T, b: T) => number,
  what: string,
  location: string,
  strict: boolean,
): void {
  for (let i = 1; i < items.length; i++) {
    const c = cmp(items[i - 1], items[i])
    if (c > 0 || (strict && c === 0)) {
      throw semantic(
        `${what} not in ascending${
          strict ? ' unique' : ''
        } order at index ${i}`,
        location,
      )
    }
  }
}

function requireUnique(
  keys: readonly Uint8Array[],
  what: string,
  location: string,
): void {
  const seen = new Set<string>()
  for (const k of keys) {
    let s = ''
    for (let i = 0; i < k.length; i++)
      s += (k[i] < 16 ? '0' : '') + k[i].toString(16)
    if (seen.has(s)) throw semantic(`duplicate ${what}`, location)
    seen.add(s)
  }
}

function typedOf<T extends FinalPayload['type']>(
  f: ParsedFrame,
  type: T,
): Extract<FinalPayload, { type: T }> {
  const t = f.typed
  if (!t || t.type !== type)
    throw new Error(`internal: expected an opened type-${type} frame`)
  return t as Extract<FinalPayload, { type: T }>
}

/**
 * Runs the stage 9 checks of one frame after its children have finished. `prior` is the
 * context's prior statement (type 2 only); `undefined` means the caller supplied none.
 */
export function checkSemantics(
  typed: FinalPayload,
  prior: DirectoryStatement<ParsedFrame> | null | undefined,
): void {
  const P = 'root/payload'
  switch (typed.type) {
    case 18: {
      if (typed.schema === 3) {
        if (typed.action === 'challenge' || typed.action === 'accept') {
          const max = typed.maxBetWei.reduce(
            (n, b) => (n << 8n) | BigInt(b),
            0n,
          )
          if (max < 1n || max > 10n ** 40n - 1n)
            throw semantic('blackjack max bet range')
        }
        break
      }
      if (typed.schema === 2) {
        const hand =
          'playerCards' in typed
            ? typed.playerCards
            : 'dealerCards' in typed
            ? typed.dealerCards
            : undefined
        if (hand && new Set(hand).size !== hand.length)
          throw semantic('blackjack hand contains duplicate cards')
        if (
          typed.action === 'deal' &&
          typed.playerCards.includes(typed.dealerUpCard)
        )
          throw semantic('deal up-card duplicates a player card')
        if (typed.action === 'challenge' || typed.action === 'accept') {
          const max = typed.maxBetWei.reduce(
            (n, b) => (n << 8n) | BigInt(b),
            0n,
          )
          if (max < 1n || max > 10n ** 40n - 1n)
            throw semantic('blackjack max bet range')
        }
        break
      }
      if ((typed.gameId === 'welcome') !== (typed.action === 'welcome'))
        throw semantic('welcome gameId is reserved iff action is welcome')
      const cards =
        'playerCards' in typed
          ? typed.playerCards
          : 'dealerCards' in typed
          ? typed.dealerCards
          : undefined
      if (cards && new Set(cards).size !== cards.length)
        throw semantic('blackjack hand contains duplicate cards')
      if (
        typed.action === 'deal' &&
        typed.playerCards.includes(typed.dealerUpCard)
      )
        throw semantic('deal up-card duplicates a player card')
      if (typed.action === 'welcome') {
        const quantity = (bytes: Uint8Array) =>
          bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n)
        const min = quantity(typed.minWagerWei),
          max = quantity(typed.maxWagerWei)
        const limit = 10n ** 40n - 1n
        if (
          min < 1n ||
          max < 1n ||
          min > max ||
          max > limit ||
          (typed.feeHintWei !== undefined && quantity(typed.feeHintWei) > limit)
        )
          throw semantic('blackjack welcome quantity range/order')
      }
      break
    }
    case 1: {
      const child = typedOf(typed.payloadFrame, 5)
      const pays = typed.payments
      requireOrdered(
        pays,
        (a, b) =>
          cmpNum(a.childIndex, b.childIndex) ||
          compareBytes(a.transactionId, b.transactionId),
        'payment members',
        `${P}.4`,
        false,
      )
      const seenIdx = new Set<number>()
      for (const p of pays) {
        if (seenIdx.has(p.childIndex))
          throw semantic('duplicate child index', `${P}.4`)
        seenIdx.add(p.childIndex)
      }
      requireUnique(
        pays.map(p => {
          if (p.vout === undefined) return p.transactionId
          const out = new Uint8Array(p.transactionId.length + 4)
          out.set(p.transactionId, 0)
          const dv = new DataView(
            out.buffer,
            out.byteOffset + p.transactionId.length,
            4,
          )
          dv.setUint32(0, p.vout, false)
          return out
        }),
        'transaction id',
        `${P}.4`,
      )
      if (typed.network !== child.network) {
        throw semantic(
          'delivery network differs from the type-5 network (S8)',
          `${P}.0`,
        )
      }
      // The destination is the stamp key P' and is deliberately not compared with the type-5
      // recipient (S8): the routing identity and the payment key are independent.
      if (typed.destination.keyType !== 1) {
        throw semantic('destination account must be key type 1 (S9)', `${P}.1`)
      }
      requireUnique(
        pays.map(p => p.address),
        'payment address',
        `${P}.4`,
      )
      pays.forEach((p, i) => {
        if (p.childIndex !== i) {
          throw semantic(
            'child indices must be exactly contiguous 0..n-1 (T3a.5)',
            `${P}.4[${i}]`,
          )
        }
      })
      return
    }
    case 2: {
      const st = typedOf(typed.statementFrame, 4)
      requireOrdered(
        typed.signatures,
        (a, b) =>
          cmpNum(a.algorithm, b.algorithm) ||
          compareAccounts(a.signer, b.signer),
        'signatures',
        `${P}.1`,
        true,
      )
      if (!typed.signatures.some(s => accountsEqual(s.signer, st.subject))) {
        throw semantic(
          'no signature entry is signed by the statement subject',
          `${P}.1`,
        )
      }
      if (st.preview) {
        if (
          typed.signatures.length !== 1 ||
          typed.signatures[0].algorithm !== 1
        )
          throw semantic(
            'directory preview requires exactly one algorithm-1 subject signature',
            `${P}.1`,
          )
        return
      }
      if (prior === undefined)
        throw new Error('internal: type-2 semantics need the prior slot')
      checkDirectoryUpdate(st, prior)
      return
    }
    case 3: {
      requireOrdered(
        typed.facts,
        (a, b) =>
          compareTimestamps(a.timestamp, b.timestamp) ||
          compareBytes(a.factId, b.factId),
        'journal facts',
        `${P}.4`,
        false,
      )
      requireUnique(
        typed.facts.map(f => f.factId),
        'fact_id',
        `${P}.4`,
      )
      if (typed.sections) {
        requireOrdered(
          typed.sections,
          (a, b) =>
            cmpNum(a.sectionType, b.sectionType) ||
            cmpNum(a.sectionSchemaVersion, b.sectionSchemaVersion),
          'opaque sections',
          `${P}.5`,
          false,
        )
        const seen = new Set<number>()
        for (const s of typed.sections) {
          if (seen.has(s.sectionType))
            throw semantic('duplicate section_type', `${P}.5`)
          seen.add(s.sectionType)
        }
      }
      return
    }
    case 12: {
      if (
        typed.postFrame.typed?.type !== 9 ||
        typed.network !== typed.postFrame.typed.network
      )
        throw semantic('Forum view network differs from post')
      return
    }
    case 13:
    case 14:
      checkForumPage(typed)
      return
    case 15: {
      const sub = typed.submittedFrame.typed
      if (
        !sub ||
        (sub.type !== 10 && sub.type !== 11) ||
        sub.network !== typed.network
      )
        throw semantic('status submission network')
      const target =
        sub.type === 10 ? contentHash(sub.postFrame) : sub.targetHash
      if (compareBytes(target, typed.targetHash))
        throw semantic('status target differs from submitted operation')
      return
    }
    case 10: {
      const child = typedOf(typed.postFrame, 9)
      if (typed.network !== child.network) {
        throw semantic(
          'submission network differs from the type-9 network (S11)',
          `${P}.0`,
        )
      }
      return
    }
    case 4: {
      if (typed.preview) checkPreviewStatement(typed)
      requireOrdered(
        typed.relays,
        (a, b) =>
          compareBytes(a.relayId, b.relayId) ||
          // Endpoints are validated ASCII, so code-unit order equals UTF-8 byte order (S4).
          (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0),
        'relay bindings',
        `${P}.4`,
        false,
      )
      requireUnique(
        typed.relays.map(r => r.relayId),
        'relay_id',
        `${P}.4`,
      )
      // S10a.1: the stamp key is key type 1. Whether it is a curve point is not a statement
      // check (a bad point makes every delivery to it fail at T3a.6, stage 10).
      if (typed.stampKey && typed.stampKey.keyType !== 1) {
        throw semantic('stamp key must be key type 1 (S10a.1)', `${P}.8`)
      }
      if (typed.keyTransitions) {
        const stmts = typed.keyTransitions.map(t =>
          typedOf(t.statementFrame, 7),
        )
        requireOrdered(
          stmts,
          (a, b) =>
            cmpNum(a.revision, b.revision) ||
            compareAccounts(a.newKey, b.newKey),
          'key transitions',
          `${P}.5`,
          true,
        )
        // Two transitions with the same revision are invalid rather than tie-broken (S5).
        for (let i = 1; i < stmts.length; i++) {
          if (stmts[i - 1].revision === stmts[i].revision) {
            throw semantic(
              'two key transitions share a revision (S5)',
              `${P}.5`,
            )
          }
        }
      }
      if (typed.recoveryAuthorities) {
        requireOrdered(
          typed.recoveryAuthorities,
          compareAccounts,
          'recovery authorities',
          `${P}.7`,
          true,
        )
      }
      if (typed.profileEntries) {
        typed.profileEntries.forEach((entry, i) => {
          const headers = entry.headers.map(h => utf8Encode(h.name))
          requireOrdered(
            headers,
            compareBytes,
            'profile-entry headers',
            `${P}.9[${i}].1`,
            true,
          )
        })
      }
      if (typed.spendKeys) {
        requireOrdered(
          typed.spendKeys,
          compareAccounts,
          'spend keys',
          `${P}.14`,
          true,
        )
      }
      return
    }
    default:
  }
}

/** Stateless preview checks only. History, relay trust and clock admission are not inferred. */
function checkPreviewStatement(st: DirectoryStatement<ParsedFrame>): void {
  const { preview: roles, stampKey, expiry } = st
  if (!roles || !stampKey || !expiry)
    throw semantic('directory preview requires role fields and expiry')
  const keys = [st.subject, stampKey, roles.messageDhKey]
  if (keys.some(k => k.keyType !== 1 || !isCompressedPoint(k.keyBytes)))
    throw semantic(
      'directory preview requires valid compressed type-1 role points',
    )
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      if (
        compareBytes(
          keys[i].keyBytes.subarray(1),
          keys[j].keyBytes.subarray(1),
        ) === 0
      )
        throw semantic(
          'directory preview roles must differ, including point negation',
        )
  if (st.relays.length !== 1)
    throw semantic('directory preview requires exactly one relay')
  const relay = st.relays[0]
  const isLoopback =
    relay.endpoint.startsWith('http://127.0.0.1') ||
    relay.endpoint.startsWith('http://localhost')
  if (
    (!isLoopback && !relay.endpoint.startsWith('https:')) ||
    relay.identity.keyType !== 1 ||
    !isCompressedPoint(relay.identity.keyBytes)
  )
    throw semantic(
      'directory preview requires HTTPS and a valid type-1 relay point',
    )
  const nanos = (t: Timestamp) =>
    t.seconds * 1_000_000_000n + BigInt(t.nanoseconds)
  const duration = nanos(expiry) - nanos(st.timestamp)
  if (
    duration <= 0n ||
    duration > MAX_DIRECTORY_VALIDITY_NS ||
    nanos(relay.expiry) < nanos(expiry)
  )
    throw semantic(
      'directory preview validity must be positive, at most 366 days and covered by relay expiry',
    )
  if (st.revision === 0n) {
    if (
      roles.predecessor !== null ||
      roles.mailboxKeyGeneration !== 0n ||
      roles.stampKeyGeneration !== 0n
    )
      throw semantic(
        'directory preview bootstrap requires null predecessor and zero generations',
      )
  } else if (
    roles.predecessor === null ||
    roles.mailboxKeyGeneration > st.revision ||
    roles.stampKeyGeneration > st.revision
  ) {
    throw semantic(
      'directory preview successor requires predecessor and generations bounded by revision',
    )
  }
}

/** S10 and T2a prior-authority selection for a type-2 update. */
function checkDirectoryUpdate(
  st: DirectoryStatement<ParsedFrame>,
  prior: DirectoryStatement<ParsedFrame> | null,
): void {
  const P = 'root/payload.0'
  const transitions = st.keyTransitions
  if (prior === null) {
    if (transitions)
      throw semantic(
        'a bootstrap statement must not carry key transitions (S10)',
        P,
      )
    return
  }
  if (st.revision <= prior.revision) {
    throw semantic(
      'statement revision does not exceed the prior revision (S10)',
      P,
    )
  }
  if (st.network !== prior.network) {
    throw semantic('statement network differs from the prior network (S10)', P)
  }
  const changed = !accountsEqual(st.subject, prior.subject)
  // S10a.2: a same-subject statement may not lower schema_version, so a stamp key, once
  // published, cannot be dropped. A new subject starts fresh.
  if (!changed && st.schemaVersion < prior.schemaVersion) {
    throw semantic('a same-subject statement lowers schema_version (S10a.2)', P)
  }
  if (!changed) {
    if (transitions)
      throw semantic('key transitions with an unchanged subject (S10)', P)
    return
  }
  if (!transitions || transitions.length !== 1) {
    throw semantic(
      'a changed subject needs exactly one key transition (S10)',
      P,
    )
  }
  const t = transitions[0]
  const ts: KeyTransitionStatement = typedOf(t.statementFrame, 7)
  if (ts.network !== st.network || ts.network !== prior.network) {
    throw semantic(
      'transition network differs from the statement networks (S10)',
      P,
    )
  }
  if (!accountsEqual(ts.subject, prior.subject)) {
    throw semantic(
      'transition subject differs from the previous subject (S10)',
      P,
    )
  }
  if (ts.revision !== st.revision || ts.revision <= prior.revision) {
    throw semantic('transition revision does not link the statements (S10)', P)
  }
  if (!accountsEqual(ts.newKey, st.subject)) {
    throw semantic('transition new_key differs from the new subject (S10)', P)
  }
  const registered =
    accountsEqual(ts.priorAuthority, prior.subject) ||
    (prior.recoveryAuthorities ?? []).some(a =>
      accountsEqual(a, ts.priorAuthority),
    )
  if (!registered) {
    throw semantic(
      'prior authority is not registered in the last accepted statement (S4a)',
      P,
    )
  }
  if (!accountsEqual(t.signer, ts.priorAuthority)) {
    throw semantic(
      'transition signer differs from the statement prior_authority (T2a)',
      P,
    )
  }
}
