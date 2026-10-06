/** Pure canonical DM preparation/opening. Admission and payment verification remain caller-owned. */
import {
  beginDirectMessageValidation,
  cborMap,
  compareAccounts,
  compareBytes,
  defaultContext,
  encodeDirectMessageCryptoContext,
  encodeFrame,
  messageContentDigest,
  parseFrame,
  recipientPayloadDigest,
  verifyPreviewDirectoryEvidence,
  type AccountRef,
  type ChildFrame,
  type Encodable,
  type PreviewDirectoryEvidence,
  type Timestamp,
} from '@frank/codec'
import type { SuiteResult } from '@frank/crypto-box'
import type { Current, HistoricalEvidence } from '@frank/directory-admission'
import {
  createCanonicalStampProof,
  verifyCanonicalStampProof,
} from './canonical-dm-stamp'

/** Public scoped capability implemented by wallet material; no wallet runtime dependency. */
export interface DirectMessageRoles {
  readonly auth: {
    readonly role: 'auth'
    readonly purpose: 'identity-authentication'
    readonly compressedPoint: Uint8Array
  }
  readonly message: {
    readonly role: 'message'
    readonly purpose: 'messaging-encryption'
    readonly compressedPoint: Uint8Array
    readonly generation: number
  }
  readonly stamp: {
    readonly role: 'stamp'
    readonly purpose: 'evm-wallet'
    readonly compressedPoint: Uint8Array
    readonly generation: number
  }
  sealMessage(input: {
    recipientPublicKey: Uint8Array
    plaintext: Uint8Array
    context: Uint8Array
  }): SuiteResult<Uint8Array>
  openMessage(input: {
    envelope: Uint8Array
    senderPublicKey: Uint8Array
    context: Uint8Array
  }): SuiteResult<Uint8Array>
  openOwnMessage?(input: {
    envelope: Uint8Array
    recipientPublicKey: Uint8Array
    context: Uint8Array
  }): SuiteResult<Uint8Array>
  openOwnDirectMessage?(input: {
    envelope: Uint8Array
    recipientPublicKey: Uint8Array
    context: Uint8Array
  }): SuiteResult<Uint8Array>
  dispose(): void
}

export class DirectMessageError extends Error {
  constructor(
    readonly code:
      | 'evidence'
      | 'current'
      | 'roles'
      | 'context'
      | 'crypto'
      | 'network'
      | 'digest'
      | 'stamp',
  ) {
    super(`canonical-dm:${code}`)
    this.name = 'DirectMessageError'
  }
}

const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  compareBytes(a, b) === 0
const accountEqual = (a: AccountRef, b: AccountRef): boolean =>
  compareAccounts(a, b) === 0
const copy = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)
const account = (a: AccountRef): Encodable =>
  cborMap([
    [0, a.keyType],
    [1, a.keyBytes],
  ])
const frame = (typeId: number, payload: Encodable, version = 1): Uint8Array =>
  encodeFrame(
    { typeId, schemaVersion: version, minReaderVersion: version },
    payload,
  )

/** Encode text directly as type 17; callers pass exact frames for containers/opaque items. */
export function directMessageText(text: string): Uint8Array {
  const bytes = frame(17, cborMap([[0, text]]))
  parseFrame(bytes)
  return bytes
}

function evidence(
  network: string,
  value: HistoricalEvidence,
): PreviewDirectoryEvidence {
  if (value.kind !== 'historical-evidence')
    throw new DirectMessageError('evidence')
  const parsed = verifyPreviewDirectoryEvidence(
    copy(value.attestation),
    network,
  )
  if (
    !equal(parsed.statementFrame.frame, value.statement) ||
    !equal(parsed.statementHash, value.hash)
  )
    throw new DirectMessageError('evidence')
  return parsed
}

function compareTime(a: Timestamp, b: Timestamp): number {
  return a.seconds < b.seconds
    ? -1
    : a.seconds > b.seconds
    ? 1
    : a.nanoseconds - b.nanoseconds
}

function unexpired(parsed: PreviewDirectoryEvidence, now: Timestamp): void {
  if (
    compareTime(parsed.statement.timestamp, now) > 0 ||
    compareTime(now, parsed.statement.expiry) >= 0
  )
    throw new DirectMessageError('current')
}

/** Cross-check an admitted snapshot; this does not confer admission on decoded data. */
function current(network: string, value: Current): PreviewDirectoryEvidence {
  if (value.kind !== 'current' || value.status.forked)
    throw new DirectMessageError('current')
  const parsed = evidence(network, value.evidence)
  const s = parsed.statement
  if (
    !accountEqual(s.preview.messageDhKey, value.messageKey) ||
    !accountEqual(s.stampKey, value.stampKey) ||
    s.revision !== value.revision ||
    s.preview.mailboxKeyGeneration !== value.generations[0] ||
    s.preview.stampKeyGeneration !== value.generations[1] ||
    value.status.head === null ||
    !equal(value.status.head, parsed.statementHash) ||
    value.status.revision !== value.revision ||
    value.status.generations === null ||
    value.status.generations[0] !== value.generations[0] ||
    value.status.generations[1] !== value.generations[1] ||
    value.status.currentStamp === null ||
    !accountEqual(value.status.currentStamp, value.stampKey) ||
    (value.previousStamp === null
      ? value.status.previousStamp !== null
      : value.status.previousStamp === null ||
        !accountEqual(value.previousStamp, value.status.previousStamp))
  )
    throw new DirectMessageError('current')
  unexpired(parsed, value.status.checkedTime)
  return parsed
}

function localRoles(
  roles: DirectMessageRoles,
  parsed: PreviewDirectoryEvidence,
  preparing: boolean,
): void {
  const s = parsed.statement
  const generation = s.preview.mailboxKeyGeneration
  if (
    roles.auth.role !== 'auth' ||
    roles.auth.purpose !== 'identity-authentication' ||
    roles.message.role !== 'message' ||
    roles.message.purpose !== 'messaging-encryption' ||
    roles.stamp.role !== 'stamp' ||
    roles.stamp.purpose !== 'evm-wallet' ||
    generation > 0x7fffffffn ||
    generation < 0n ||
    !Number.isSafeInteger(roles.message.generation) ||
    BigInt(roles.message.generation) !== generation ||
    !equal(roles.auth.compressedPoint, s.subject.keyBytes) ||
    !equal(roles.message.compressedPoint, s.preview.messageDhKey.keyBytes) ||
    (preparing &&
      (s.preview.stampKeyGeneration > 0x7fffffffn ||
        !Number.isSafeInteger(roles.stamp.generation) ||
        BigInt(roles.stamp.generation) !== s.preview.stampKeyGeneration ||
        !equal(roles.stamp.compressedPoint, s.stampKey.keyBytes)))
  )
    throw new DirectMessageError('roles')
}

function cryptoContext(
  network: string,
  sender: PreviewDirectoryEvidence,
  recipient: PreviewDirectoryEvidence,
  proof: {
    ephemeralPoint: Uint8Array
    sharedPoint: Uint8Array
    dleqProof: Uint8Array
  },
): Uint8Array {
  return encodeDirectMessageCryptoContext({
    network,
    sender: sender.statement.subject,
    recipient: recipient.statement.subject,
    senderDirectoryHash: sender.statementHash,
    recipientDirectoryHash: recipient.statementHash,
    senderMessageKey: sender.statement.preview.messageDhKey,
    recipientMessageKey: recipient.statement.preview.messageDhKey,
    stampKey: recipient.statement.stampKey,
    ...proof,
  })
}

export interface PreparedDirectMessage {
  readonly payload: Uint8Array
  readonly context: Uint8Array
  readonly t3: Uint8Array
  readonly messageId: Uint8Array
  readonly conversationId: Uint8Array
  readonly conversationName?: string
  readonly contentDigest: Uint8Array
  readonly content: Uint8Array
  readonly revision: Uint8Array
  readonly senderT1: Uint8Array
  readonly recipientT1: Uint8Array
}

/** Each byte property is copy-owned, including repeated reads of the same result. */
function ownedBytes<T extends Record<string, Uint8Array>>(
  values: T,
): Readonly<T> {
  const result = {} as T
  for (const key of Object.keys(values)) {
    const saved = copy(values[key])
    Object.defineProperty(result, key, {
      enumerable: true,
      get: () => copy(saved),
    })
  }
  return Object.freeze(result)
}

/** Obtain fresh Current snapshots for every call. Failure closes the supplied role session. */
export function prepareDirectMessage(input: {
  network: string
  senderCurrent: Current
  recipientCurrent: Current
  messageId: Uint8Array
  conversationId?: Uint8Array
  conversationName?: string
  items: readonly Uint8Array[]
  roles: DirectMessageRoles
}): PreparedDirectMessage {
  input = { ...input }
  let plaintext: Uint8Array | undefined
  try {
    const sender = current(input.network, input.senderCurrent)
    const recipient = current(input.network, input.recipientCurrent)
    localRoles(input.roles, sender, true)
    const messageId = copy(input.messageId)
    const conversationId = input.conversationId
      ? copy(input.conversationId)
      : copy(messageId)
    const revision = frame(
      8,
      cborMap([
        [0, 'frank'],
        [1, input.items.map(copy)],
      ]),
    )
    const contentDigest = messageContentDigest(revision)
    const contentEntries: [number, Encodable][] = [
      [0, input.network],
      [1, messageId],
      [2, revision],
      [3, contentDigest],
      [4, conversationId],
    ]
    if (input.conversationName !== undefined) {
      contentEntries.push([5, input.conversationName])
    }
    plaintext = frame(6, cborMap(contentEntries))
    // Reject invalid authoring before invoking the capability or consuming entropy.
    parseFrame(plaintext)
    const proof = createCanonicalStampProof({
      network: input.network,
      stampKey: recipient.statement.stampKey,
    })
    const context = cryptoContext(input.network, sender, recipient, proof)
    const borrowed = copy(plaintext)
    let sealed: SuiteResult<Uint8Array>
    try {
      sealed = input.roles.sealMessage({
        recipientPublicKey: copy(
          recipient.statement.preview.messageDhKey.keyBytes,
        ),
        plaintext: borrowed,
        context: copy(context),
      })
    } finally {
      borrowed.fill(0)
    }
    if (!sealed.ok) throw new DirectMessageError('crypto')
    const payload = frame(
      5,
      cborMap([
        [0, input.network],
        [1, account(sender.statement.subject)],
        [2, account(recipient.statement.subject)],
        [3, 1],
        [4, copy(sealed.value)],
        [5, proof.ephemeralPoint],
        [6, proof.sharedPoint],
        [7, proof.dleqProof],
      ]),
      2,
    )
    // Production writer is subject to the same aggregate/depth budget across encryption.
    beginDirectMessageValidation(
      payload,
      defaultContext(),
    ).completeAuthenticatedContent(plaintext)
    const bytes = ownedBytes({
      payload,
      context,
      t3: recipientPayloadDigest(input.network, payload),
      messageId,
      conversationId,
      contentDigest,
      content: plaintext,
      revision,
      senderT1: sender.statementHash,
      recipientT1: recipient.statementHash,
    })
    const result = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(bytes),
    ) as PreparedDirectMessage
    if (input.conversationName !== undefined) {
      Object.defineProperty(result, 'conversationName', {
        enumerable: true,
        value: input.conversationName,
      })
    }
    return Object.freeze(result)
  } catch (error) {
    input.roles.dispose()
    throw error
  } finally {
    plaintext?.fill(0)
  }
}

interface OpenInput {
  network: string
  payload: Uint8Array
  context: Uint8Array
  roles: DirectMessageRoles
}
export type OpenDirectMessageInput = OpenInput &
  (
    | {
        mode?: 'receive'
        senderCurrent: Current
        senderEvidence?: HistoricalEvidence
        recipientCurrent: Current
        recipientEvidence?: HistoricalEvidence
      }
    | {
        mode: 'archive'
        senderEvidence: HistoricalEvidence
        recipientEvidence: HistoricalEvidence
      }
  )

export interface OpenedDirectMessage extends PreparedDirectMessage {
  /** Neither variant grants mailbox admission, delivery status, or stamp credit. */
  readonly mode: 'receive' | 'archive' | 'send'
  /** Exact retained item frames, with semantic projections only after complete validation. */
  readonly items: readonly ChildFrame[]
}

export type OpenOwnDirectMessageInput = OpenInput &
  (
    | {
        mode?: 'send'
        senderCurrent: Current
        recipientCurrent: Current
        senderEvidence?: HistoricalEvidence
        recipientEvidence?: HistoricalEvidence
      }
    | {
        mode: 'archive'
        senderEvidence: HistoricalEvidence
        recipientEvidence: HistoricalEvidence
      }
  )

/** Opens an exact attempt; never re-seals ciphertext or upgrades historical evidence to Current. */
export function openDirectMessage(
  input: OpenDirectMessageInput,
): OpenedDirectMessage {
  input = { ...input }
  let session: ReturnType<typeof beginDirectMessageValidation> | undefined
  let plaintext: Uint8Array | undefined
  try {
    const payload = copy(input.payload)
    const suppliedContext = copy(input.context)
    const root = parseFrame(payload)
    if (root.kind !== 'parsed' || root.typeId !== 5)
      throw new DirectMessageError('context')
    session = beginDirectMessageValidation(payload, defaultContext())
    if (session.payload.typeId !== 5) throw new DirectMessageError('context')
    const encrypted = session.payload.typed
    if (encrypted?.type !== 5 || encrypted.schemaVersion !== 2)
      throw new DirectMessageError('context')
    const mode = input.mode ?? 'receive'
    let sender: PreviewDirectoryEvidence
    let recipient: PreviewDirectoryEvidence
    let senderHead: PreviewDirectoryEvidence | undefined
    let recipientHead: PreviewDirectoryEvidence | undefined
    if (input.mode === 'archive') {
      sender = evidence(input.network, input.senderEvidence)
      recipient = evidence(input.network, input.recipientEvidence)
    } else {
      senderHead = current(input.network, input.senderCurrent)
      sender =
        input.senderEvidence === undefined
          ? senderHead
          : evidence(input.network, input.senderEvidence)
      recipientHead = current(input.network, input.recipientCurrent)
      recipient =
        input.recipientEvidence === undefined
          ? recipientHead
          : evidence(input.network, input.recipientEvidence)
      if (
        !accountEqual(
          sender.statement.subject,
          senderHead.statement.subject,
        ) ||
        !accountEqual(
          sender.statement.preview.messageDhKey,
          senderHead.statement.preview.messageDhKey,
        )
      )
        throw new DirectMessageError('current')
      if (
        !accountEqual(
          recipient.statement.subject,
          recipientHead.statement.subject,
        ) ||
        !accountEqual(
          recipient.statement.preview.messageDhKey,
          recipientHead.statement.preview.messageDhKey,
        )
      )
        throw new DirectMessageError('current')
      unexpired(recipient, input.recipientCurrent.status.checkedTime)
    }
    if (
      encrypted.network !== input.network ||
      !accountEqual(encrypted.sender, sender.statement.subject) ||
      !accountEqual(encrypted.recipient, recipient.statement.subject)
    )
      throw new DirectMessageError('context')
    localRoles(input.roles, recipientHead ?? recipient, false)
    const context = cryptoContext(input.network, sender, recipient, encrypted)
    if (!equal(context, suppliedContext))
      throw new DirectMessageError('context')
    // Stage 10.4: current/immediately previous stamp, with no revision/time grace cutoff.
    if (
      input.mode === 'receive' &&
      !accountEqual(
        recipient.statement.stampKey,
        input.recipientCurrent.stampKey,
      ) &&
      (input.recipientCurrent.previousStamp === null ||
        !accountEqual(
          recipient.statement.stampKey,
          input.recipientCurrent.previousStamp,
        ))
    )
      throw new DirectMessageError('stamp')
    const opened = input.roles.openMessage({
      envelope: copy(encrypted.cryptoBoxEnvelope),
      senderPublicKey: copy(sender.statement.preview.messageDhKey.keyBytes),
      context: copy(context),
    })
    if (!opened.ok) throw new DirectMessageError('crypto')
    plaintext = copy(opened.value)
    opened.value.fill(0)
    const continuation = session
    session = undefined
    const completed = continuation.completeAuthenticatedContent(plaintext)
    const content = completed.content.typed
    if (content?.type !== 6 || content.revisionFrame.typed?.type !== 8)
      throw new DirectMessageError('context')
    if (content.network !== encrypted.network)
      throw new DirectMessageError('network')
    if (
      !equal(
        content.contentDigest,
        messageContentDigest(content.revisionFrame.frame),
      )
    )
      throw new DirectMessageError('digest')
    verifyCanonicalStampProof({
      network: input.network,
      stampKey: recipient.statement.stampKey,
      ephemeralPoint: encrypted.ephemeralPoint,
      sharedPoint: encrypted.sharedPoint,
      dleqProof: encrypted.dleqProof,
    })
    const bytes = ownedBytes({
      payload,
      context,
      t3: recipientPayloadDigest(input.network, payload),
      messageId: content.messageId,
      conversationId: content.conversationId,
      contentDigest: content.contentDigest,
      senderT1: sender.statementHash,
      recipientT1: recipient.statementHash,
      content: completed.content.frame,
      revision: content.revisionFrame.frame,
    })
    const result = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(bytes),
    ) as OpenedDirectMessage
    Object.defineProperties(result, {
      mode: { enumerable: true, value: input.mode },
      conversationName: { enumerable: true, value: content.conversationName },
      // Parse a copy of the already validated revision only to return fresh owned projections.
      // Acceptance above uses the one-shot aggregate continuation, never this independent parse.
      items: {
        enumerable: true,
        get: () => {
          const revision = parseFrame(bytes.revision)
          if (revision.kind !== 'parsed' || revision.typed?.type !== 8)
            throw new DirectMessageError('context')
          return revision.typed.items
        },
      },
    })
    return Object.freeze(result)
  } catch (error) {
    session?.abort()
    input.roles.dispose()
    throw error
  } finally {
    plaintext?.fill(0)
  }
}

/** Opens an exact attempt sent by this account; never re-seals ciphertext. */
export function openOwnDirectMessage(
  input: OpenOwnDirectMessageInput,
): OpenedDirectMessage {
  input = { ...input }
  let session: ReturnType<typeof beginDirectMessageValidation> | undefined
  let plaintext: Uint8Array | undefined
  try {
    const payload = copy(input.payload)
    const suppliedContext = copy(input.context)
    const root = parseFrame(payload)
    if (root.kind !== 'parsed' || root.typeId !== 5)
      throw new DirectMessageError('context')
    session = beginDirectMessageValidation(payload, defaultContext())
    if (session.payload.typeId !== 5) throw new DirectMessageError('context')
    const encrypted = session.payload.typed
    if (encrypted?.type !== 5 || encrypted.schemaVersion !== 2)
      throw new DirectMessageError('context')

    let sender: PreviewDirectoryEvidence
    let recipient: PreviewDirectoryEvidence
    let senderHead: PreviewDirectoryEvidence | undefined
    let recipientHead: PreviewDirectoryEvidence | undefined
    const mode = input.mode ?? 'send'
    if (input.mode === 'archive') {
      sender = evidence(input.network, input.senderEvidence)
      recipient = evidence(input.network, input.recipientEvidence)
    } else {
      senderHead = current(input.network, input.senderCurrent)
      sender =
        input.senderEvidence === undefined
          ? senderHead
          : evidence(input.network, input.senderEvidence)
      recipientHead = current(input.network, input.recipientCurrent)
      recipient =
        input.recipientEvidence !== undefined
          ? evidence(input.network, input.recipientEvidence)
          : recipientHead

      if (
        !accountEqual(
          sender.statement.subject,
          senderHead.statement.subject,
        ) ||
        !accountEqual(
          sender.statement.preview.messageDhKey,
          senderHead.statement.preview.messageDhKey,
        )
      )
        throw new DirectMessageError('current')
      if (
        !accountEqual(
          recipient.statement.subject,
          recipientHead.statement.subject,
        ) ||
        !accountEqual(
          recipient.statement.preview.messageDhKey,
          recipientHead.statement.preview.messageDhKey,
        )
      )
        throw new DirectMessageError('current')
      unexpired(sender, input.senderCurrent.status.checkedTime)
    }

    if (
      encrypted.network !== input.network ||
      !accountEqual(encrypted.sender, sender.statement.subject) ||
      !accountEqual(encrypted.recipient, recipient.statement.subject)
    )
      throw new DirectMessageError('context')

    localRoles(input.roles, senderHead ?? sender, false)
    const context = cryptoContext(input.network, sender, recipient, encrypted)
    if (!equal(context, suppliedContext))
      throw new DirectMessageError('context')

    const openOwn =
      input.roles.openOwnMessage ?? input.roles.openOwnDirectMessage
    if (!openOwn) throw new DirectMessageError('roles')
    const opened = openOwn.call(input.roles, {
      envelope: copy(encrypted.cryptoBoxEnvelope),
      recipientPublicKey: copy(recipient.statement.preview.messageDhKey.keyBytes),
      context: copy(context),
    })
    if (!opened.ok) throw new DirectMessageError('crypto')
    plaintext = copy(opened.value)
    opened.value.fill(0)

    const continuation = session
    session = undefined
    const completed = continuation.completeAuthenticatedContent(plaintext)
    const content = completed.content.typed
    if (content?.type !== 6 || content.revisionFrame.typed?.type !== 8)
      throw new DirectMessageError('context')
    if (content.network !== encrypted.network)
      throw new DirectMessageError('network')
    if (
      !equal(
        content.contentDigest,
        messageContentDigest(content.revisionFrame.frame),
      )
    )
      throw new DirectMessageError('digest')
    verifyCanonicalStampProof({
      network: input.network,
      stampKey: recipient.statement.stampKey,
      ephemeralPoint: encrypted.ephemeralPoint,
      sharedPoint: encrypted.sharedPoint,
      dleqProof: encrypted.dleqProof,
    })
    const bytes = ownedBytes({
      payload,
      context,
      t3: recipientPayloadDigest(input.network, payload),
      messageId: content.messageId,
      conversationId: content.conversationId,
      contentDigest: content.contentDigest,
      senderT1: sender.statementHash,
      recipientT1: recipient.statementHash,
      content: completed.content.frame,
      revision: content.revisionFrame.frame,
    })
    const result = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(bytes),
    ) as OpenedDirectMessage
    Object.defineProperties(result, {
      mode: { enumerable: true, value: mode },
      conversationName: { enumerable: true, value: content.conversationName },
      items: {
        enumerable: true,
        get: () => {
          const revision = parseFrame(bytes.revision)
          if (revision.kind !== 'parsed' || revision.typed?.type !== 8)
            throw new DirectMessageError('context')
          return revision.typed.items
        },
      },
    })
    return Object.freeze(result)
  } catch (error) {
    session?.abort()
    input.roles.dispose()
    throw error
  } finally {
    plaintext?.fill(0)
  }
}
