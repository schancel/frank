// Stage 9: semantic checks that need no cryptography (README section 5, S3-S10, T3a.5).
import { DEFAULT_FEATURE_CODEC_MAP } from './blackjack-schema'
import { FrankCodecError } from './errors'
import { utf8Encode } from './utf8'
import { isCompressedPoint } from './point'
import { contentHash } from './hash'
import {
  DIRECTORY_ATTESTATION,
  DIRECTORY_STATEMENT,
  DIRECT_MESSAGE_DELIVERY,
  ENCRYPTED_MESSAGE_CONTENT,
  FORWARDING_DELIVERY_ENVELOPE,
  KEY_TYPE,
  MAILBOX_CHECKPOINT,
  MAX_DIRECTORY_VALIDITY_NS,
  PROFILE_ENTRY,
  SIGNATURE_ALGORITHM,
  TOKEN_TRANSFER,
  TOPIC_POST_SUBMISSION,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_DIRECTORY_STATEMENT,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_VIEW,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
  TYPE_KEY_TRANSITION_STATEMENT,
  TYPE_MAILBOX_CHECKPOINT,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
} from './constants'
import { CANONICAL_USERNAME_REGEX } from './registration'
import { at, atItem, type FeatureCodecDescriptor } from './schema-primitives'
import {
  ACCOUNT_TYPE_BOT,
  ACCOUNT_TYPE_SERVICE,
  type AccountRef,
  type DirectoryStatement,
  type FinalPayload,
  type KeyTransitionStatement,
  type ParsedFrame,
  type Timestamp,
  type ForumCursor,
  type ForumTopicPage,
  type ForumDiscoveryPage,
  type TokenTransfer,
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
  const rows = page.type === TYPE_FORUM_TOPIC_PAGE ? page.rows : page.entries
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
      cursor.family === TYPE_FORUM_TOPIC_PAGE &&
      page.type === TYPE_FORUM_TOPIC_PAGE &&
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
  if (page.type === TYPE_FORUM_TOPIC_PAGE) {
    let previous =
      page.requestCursor?.family === TYPE_FORUM_TOPIC_PAGE
        ? page.requestCursor.last
        : undefined
    const hashes: Uint8Array[] = []
    for (const row of page.rows) {
      const view = row.typed
      if (
        view?.type !== TYPE_FORUM_VIEW ||
        view.postFrame.typed?.type !== TYPE_TOPIC_POST
      )
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
      page.nextCursor?.family === TYPE_FORUM_TOPIC_PAGE &&
      (!previous ||
        compareTimestamps(page.nextCursor.last.timestamp, previous.timestamp) ||
        compareBytes(page.nextCursor.last.hash, previous.hash))
    )
      throw semantic('continuation is not last Forum row')
  } else {
    let previous =
      page.requestCursor?.family === TYPE_FORUM_DISCOVERY_PAGE
        ? page.requestCursor.last
        : undefined
    for (const row of page.entries) {
      if (
        previous !== undefined &&
        compareBytes(utf8Encode(previous), utf8Encode(row.topic)) >= 0
      )
        throw semantic('discovery rows not strictly ordered')
      previous = row.topic
    }
    if (
      page.nextCursor?.family === TYPE_FORUM_DISCOVERY_PAGE &&
      page.nextCursor.last !== previous
    )
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
export function checkTokenTransferSemantics(
  transfer: TokenTransfer,
  path = at('root/payload', ENCRYPTED_MESSAGE_CONTENT.tokenTransfer),
): void {
  const K = TOKEN_TRANSFER
  if (transfer.amount <= 0n) {
    throw semantic('token transfer amount must be positive', at(path, K.amount))
  }
  if (
    !Number.isSafeInteger(transfer.decimals) ||
    transfer.decimals < 0 ||
    transfer.decimals > 255
  ) {
    throw semantic(
      'token transfer decimals must be in 0..255',
      at(path, K.decimals),
    )
  }
  if (transfer.chainNamespace.trim().length === 0) {
    throw semantic(
      'token transfer chain namespace cannot be empty',
      at(path, K.chainNamespace),
    )
  }
  if (transfer.contractAddress.trim().length === 0) {
    throw semantic(
      'token transfer contract address cannot be empty',
      at(path, K.contractAddress),
    )
  }
  if (transfer.symbol.trim().length === 0) {
    throw semantic('token transfer symbol cannot be empty', at(path, K.symbol))
  }
  if (
    transfer.rawTxOrPermit !== undefined &&
    transfer.rawTxOrPermit.length === 0
  ) {
    throw semantic(
      'token transfer rawTxOrPermit cannot be empty',
      at(path, K.rawTxOrPermit),
    )
  }
}

export function checkSemantics(
  typed: FinalPayload,
  prior: DirectoryStatement<ParsedFrame> | null | undefined,
  featureCodecs: ReadonlyMap<
    number,
    FeatureCodecDescriptor
  > = DEFAULT_FEATURE_CODEC_MAP,
): void {
  const feature = featureCodecs.get(typed.type)
  if (feature) {
    feature.checkSemantics?.(typed as never)
    return
  }
  const P = 'root/payload'
  switch (typed.type) {
    case TYPE_ENCRYPTED_MESSAGE_CONTENT: {
      if (typed.tokenTransfer) {
        checkTokenTransferSemantics(
          typed.tokenTransfer,
          at(P, ENCRYPTED_MESSAGE_CONTENT.tokenTransfer),
        )
      }
      return
    }
    case TYPE_FORWARDING_DELIVERY_ENVELOPE: {
      const K = FORWARDING_DELIVERY_ENVELOPE
      const child = typedOf(typed.payloadFrame, TYPE_DIRECT_MESSAGE_DELIVERY)
      const pays = typed.payments
      requireOrdered(
        pays,
        (a, b) =>
          cmpNum(a.childIndex, b.childIndex) ||
          compareBytes(a.transactionId, b.transactionId),
        'payment members',
        at(P, K.payments),
        false,
      )
      const seenIdx = new Set<number>()
      for (const p of pays) {
        if (seenIdx.has(p.childIndex))
          throw semantic('duplicate child index', at(P, K.payments))
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
        at(P, K.payments),
      )
      if (typed.network !== child.network) {
        throw semantic(
          'forwarding network differs from the type-1 network',
          at(P, K.network),
        )
      }
      if (typed.destination.keyType !== KEY_TYPE.secp256k1) {
        throw semantic(
          'destination account must be key type 1',
          at(P, K.destination),
        )
      }
      requireUnique(
        pays.map(p => p.address),
        'payment address',
        at(P, K.payments),
      )
      pays.forEach((p, i) => {
        if (p.childIndex !== i) {
          throw semantic(
            'child indices must be exactly contiguous 0..n-1 (T3a.5)',
            `${at(P, K.payments)}[${i}]`,
          )
        }
      })
      return
    }
    case TYPE_DIRECT_MESSAGE_DELIVERY: {
      const K = DIRECT_MESSAGE_DELIVERY
      const child = typedOf(
        typed.payloadFrame,
        TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
      )
      const pays = typed.payments
      requireOrdered(
        pays,
        (a, b) =>
          cmpNum(a.childIndex, b.childIndex) ||
          compareBytes(a.transactionId, b.transactionId),
        'payment members',
        at(P, K.payments),
        false,
      )
      const seenIdx = new Set<number>()
      for (const p of pays) {
        if (seenIdx.has(p.childIndex))
          throw semantic('duplicate child index', at(P, K.payments))
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
        at(P, K.payments),
      )
      if (typed.network !== child.network) {
        throw semantic(
          'delivery network differs from the type-5 network (S8)',
          at(P, K.network),
        )
      }
      // The destination is the stamp key P' and is deliberately not compared with the type-5
      // recipient (S8): the routing identity and the payment key are independent.
      if (typed.destination.keyType !== KEY_TYPE.secp256k1) {
        throw semantic(
          'destination account must be key type 1 (S9)',
          at(P, K.destination),
        )
      }
      if (
        (typed.recipient !== undefined && typed.dleqProof === undefined) ||
        (typed.recipient === undefined && typed.dleqProof !== undefined)
      ) {
        throw semantic(
          'recipient and DLEQ proof must both be present if either is present',
          P,
        )
      }
      if (
        typed.recipient !== undefined &&
        typed.recipient.keyType !== KEY_TYPE.secp256k1
      ) {
        throw semantic(
          'recipient account must be key type 1',
          at(P, K.recipient),
        )
      }
      requireUnique(
        pays.map(p => p.address),
        'payment address',
        at(P, K.payments),
      )
      pays.forEach((p, i) => {
        if (p.childIndex !== i) {
          throw semantic(
            'child indices must be exactly contiguous 0..n-1 (T3a.5)',
            `${at(P, K.payments)}[${i}]`,
          )
        }
      })
      return
    }
    case TYPE_DIRECTORY_ATTESTATION: {
      const K = DIRECTORY_ATTESTATION
      const st = typedOf(typed.statementFrame, TYPE_DIRECTORY_STATEMENT)
      requireOrdered(
        typed.signatures,
        (a, b) =>
          cmpNum(a.algorithm, b.algorithm) ||
          compareAccounts(a.signer, b.signer),
        'signatures',
        at(P, K.signatures),
        true,
      )
      if (!typed.signatures.some(s => accountsEqual(s.signer, st.subject))) {
        throw semantic(
          'no signature entry is signed by the statement subject',
          at(P, K.signatures),
        )
      }
      if (st.preview) {
        if (
          typed.signatures.length !== 1 ||
          typed.signatures[0].algorithm !==
            SIGNATURE_ALGORITHM.secp256k1EcdsaDer
        )
          throw semantic(
            'directory preview requires exactly one algorithm-1 subject signature',
            at(P, K.signatures),
          )
        return
      }
      if (prior === undefined)
        throw new Error('internal: type-2 semantics need the prior slot')
      checkDirectoryUpdate(st, prior)
      return
    }
    case TYPE_MAILBOX_CHECKPOINT: {
      const K = MAILBOX_CHECKPOINT
      requireOrdered(
        typed.facts,
        (a, b) =>
          compareTimestamps(a.timestamp, b.timestamp) ||
          compareBytes(a.factId, b.factId),
        'journal facts',
        at(P, K.facts),
        false,
      )
      requireUnique(
        typed.facts.map(f => f.factId),
        'fact_id',
        at(P, K.facts),
      )
      if (typed.sections) {
        requireOrdered(
          typed.sections,
          (a, b) =>
            cmpNum(a.sectionType, b.sectionType) ||
            cmpNum(a.sectionSchemaVersion, b.sectionSchemaVersion),
          'opaque sections',
          at(P, K.sections),
          false,
        )
        const seen = new Set<number>()
        for (const s of typed.sections) {
          if (seen.has(s.sectionType))
            throw semantic('duplicate section_type', at(P, K.sections))
          seen.add(s.sectionType)
        }
      }
      return
    }
    case TYPE_FORUM_VIEW: {
      if (
        typed.postFrame.typed?.type !== TYPE_TOPIC_POST ||
        typed.network !== typed.postFrame.typed.network
      )
        throw semantic('Forum view network differs from post')
      return
    }
    case TYPE_FORUM_TOPIC_PAGE:
    case TYPE_FORUM_DISCOVERY_PAGE:
      checkForumPage(typed)
      return
    case TYPE_FORUM_OPERATION_STATUS: {
      const sub = typed.submittedFrame.typed
      if (
        !sub ||
        (sub.type !== TYPE_TOPIC_POST_SUBMISSION &&
          sub.type !== TYPE_TOPIC_VOTE_SUBMISSION) ||
        sub.network !== typed.network
      )
        throw semantic('status submission network')
      const target =
        sub.type === TYPE_TOPIC_POST_SUBMISSION
          ? contentHash(sub.postFrame)
          : sub.targetHash
      if (compareBytes(target, typed.targetHash))
        throw semantic('status target differs from submitted operation')
      return
    }
    case TYPE_TOPIC_POST_SUBMISSION: {
      const child = typedOf(typed.postFrame, TYPE_TOPIC_POST)
      if (typed.network !== child.network) {
        throw semantic(
          'submission network differs from the type-9 network (S11)',
          at(P, TOPIC_POST_SUBMISSION.network),
        )
      }
      return
    }
    case TYPE_DIRECTORY_STATEMENT: {
      const K = DIRECTORY_STATEMENT
      if (typed.preview) checkPreviewStatement(typed)
      requireOrdered(
        typed.relays,
        (a, b) =>
          compareBytes(a.relayId, b.relayId) ||
          // Endpoints are validated ASCII, so code-unit order equals UTF-8 byte order (S4).
          (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0),
        'relay bindings',
        at(P, K.relays),
        false,
      )
      requireUnique(
        typed.relays.map(r => r.relayId),
        'relay_id',
        at(P, K.relays),
      )
      // S10a.1: the stamp key is key type 1. Whether it is a curve point is not a statement
      // check (a bad point makes every delivery to it fail at T3a.6, stage 10).
      if (typed.stampKey && typed.stampKey.keyType !== KEY_TYPE.secp256k1) {
        throw semantic(
          'stamp key must be key type 1 (S10a.1)',
          at(P, K.stampKey),
        )
      }
      if (typed.keyTransitions) {
        const stmts = typed.keyTransitions.map(t =>
          typedOf(t.statementFrame, TYPE_KEY_TRANSITION_STATEMENT),
        )
        requireOrdered(
          stmts,
          (a, b) =>
            cmpNum(a.revision, b.revision) ||
            compareAccounts(a.newKey, b.newKey),
          'key transitions',
          at(P, K.keyTransitions),
          true,
        )
        // Two transitions with the same revision are invalid rather than tie-broken (S5).
        for (let i = 1; i < stmts.length; i++) {
          if (stmts[i - 1].revision === stmts[i].revision) {
            throw semantic(
              'two key transitions share a revision (S5)',
              at(P, K.keyTransitions),
            )
          }
        }
      }
      if (typed.recoveryAuthorities) {
        requireOrdered(
          typed.recoveryAuthorities,
          compareAccounts,
          'recovery authorities',
          at(P, K.recoveryAuthorities),
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
            at(atItem(P, K.profileEntries, i), PROFILE_ENTRY.headers),
            true,
          )
        })
      }
      if (typed.canonicalUsername !== undefined) {
        if (!CANONICAL_USERNAME_REGEX.test(typed.canonicalUsername)) {
          throw semantic(
            'canonical username must match ^[a-z0-9][a-z0-9_-]{2,31}$',
            at(P, K.username),
          )
        }
      }
      if (typed.spendKeys) {
        requireOrdered(
          typed.spendKeys,
          compareAccounts,
          'spend keys',
          at(P, K.username),
          true,
        )
      }
      if (
        typed.botRole !== undefined &&
        typed.accountType !== ACCOUNT_TYPE_BOT &&
        typed.accountType !== ACCOUNT_TYPE_SERVICE
      ) {
        throw semantic(
          'bot-role requires account-type to be bot (1) or service (2)',
          at(P, K.botRole),
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
  if (
    keys.some(
      k => k.keyType !== KEY_TYPE.secp256k1 || !isCompressedPoint(k.keyBytes),
    )
  )
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
    relay.identity.keyType !== KEY_TYPE.secp256k1 ||
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
  const P = at('root/payload', DIRECTORY_ATTESTATION.statementFrame)
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
  const ts: KeyTransitionStatement = typedOf(
    t.statementFrame,
    TYPE_KEY_TRANSITION_STATEMENT,
  )
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
