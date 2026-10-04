import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type { Current, DirectoryStore } from '@frank/directory-admission'
import {
  parseFrame,
  messageContentDigest,
  fromHex,
  toHex,
  verifyPreviewDirectoryEvidence,
  cborMap,
  encodeFrame,
} from '@frank/codec'
import { open, seal } from '@frank/crypto-box'
import directoryVectors from '../../../docs/protocol/proposals/suite1-directory/vectors.json'
import corpus from '../../../docs/protocol/cbor/vectors/dm-runtime.json'
import {
  prepareDirectMessage,
  openDirectMessage,
  directMessageText,
  DirectMessageRoles,
} from './canonical-dm'
let location: string
let store: DirectoryStore
let current: Current
const v = corpus.runtime_case
beforeAll(async () => {
  location = await mkdtemp(join(tmpdir(), 'canonical-dm-'))
  const statement = fromHex(v.statement),
    attestation = fromHex(v.attestation)
  const parsed = verifyPreviewDirectoryEvidence(attestation, corpus.network)
  store = await openNodeDirectoryStore({
    location: join(location, 'db'),
    anchor: {
      network: corpus.network,
      subject: parsed.statement.subject,
      revisionZero: fromHex(v.t1),
    },
    mode: { kind: 'new' },
  })
  current = await store.enroll([{ statement, attestation }], {
    now: { seconds: 200n, nanoseconds: 0 },
    relay: parsed.statement.relays[0],
  })
})
afterAll(async () => {
  await store?.close()
  await rm(location, { recursive: true, force: true })
})
function roles(
  snapshot = current,
  network = corpus.network,
): DirectMessageRoles {
  return {
    auth: {
      role: 'auth',
      purpose: 'identity-authentication',
      compressedPoint: verifyPreviewDirectoryEvidence(
        snapshot.evidence.attestation,
        network,
      ).statement.subject.keyBytes,
    },
    message: {
      role: 'message',
      purpose: 'messaging-encryption',
      compressedPoint: snapshot.messageKey.keyBytes,
      generation: 0,
    },
    stamp: {
      role: 'stamp',
      purpose: 'evm-wallet',
      compressedPoint: snapshot.stampKey.keyBytes,
      generation: 0,
    },
    sealMessage: input =>
      seal({
        ...input,
        suiteId: 1,
        senderPrivateKey: fromHex(v.message_secret_test_only),
        senderPublicKey: snapshot.messageKey.keyBytes,
      }),
    openMessage: input =>
      open({
        ...input,
        recipientPrivateKey: fromHex(v.message_secret_test_only),
      }),
    dispose: jest.fn(),
  }
}
const receive = (role = roles()) => ({
  network: corpus.network,
  payload: fromHex(v.payload),
  context: fromHex(v.context),
  roles: role,
  mode: 'receive' as const,
  senderCurrent: current,
  recipientCurrent: current,
})
test('public admitted evidence opens independent exact content/context and owns bytes', () => {
  const result = openDirectMessage(receive())
  expect(toHex(result.content)).toBe(v.content)
  expect(toHex(result.context)).toBe(v.context)
  expect(toHex(result.t3)).toBe(v.t3)
  result.content.fill(0)
  result.items[0].frame.fill(0)
  expect(toHex(result.content)).toBe(v.content)
  expect(result.items[0].frame.some(x => x !== 0)).toBe(true)
})
test('actual suite1 roundtrip retains exact text and opaque items despite callback mutation', () => {
  const opaque = encodeFrame(
    { typeId: 60000, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([[0, 'opaque']]),
  )
  const text = directMessageText('hello'),
    role = roles(),
    operation = role.sealMessage
  role.sealMessage = input => {
    const result = operation(input)
    input.plaintext.fill(0)
    input.context.fill(0)
    return result
  }
  const prepared = prepareDirectMessage({
    network: corpus.network,
    senderCurrent: current,
    recipientCurrent: current,
    messageId: new Uint8Array(16).fill(7),
    items: [text, opaque],
    roles: role,
  })
  const result = openDirectMessage({
    ...receive(),
    payload: prepared.payload,
    context: prepared.context,
  })
  expect(toHex(result.items[0].frame)).toBe(toHex(text))
  expect(toHex(result.items[1].frame)).toBe(toHex(opaque))
  expect(toHex(result.messageId)).toBe('07'.repeat(16))
})
test.each(['context', 'ciphertext', 'T1', 'message', 'status'])(
  'rejects changed %s and disposes',
  change => {
    const role = roles(),
      input = receive(role)
    if (change === 'context') input.context[10] ^= 1
    if (change === 'ciphertext') input.payload[250] ^= 1
    if (change === 'T1')
      input.senderCurrent = {
        ...current,
        evidence: { ...current.evidence, hash: new Uint8Array(32) },
      }
    if (change === 'message')
      input.recipientCurrent = {
        ...current,
        messageKey: { keyType: 1, keyBytes: role.stamp.compressedPoint },
      }
    if (change === 'status')
      input.recipientCurrent = {
        ...current,
        status: { ...current.status, revision: 99n },
      }
    expect(() => openDirectMessage(input)).toThrow()
    expect(role.dispose).toHaveBeenCalledTimes(1)
  },
)
test('authentication failure preserves crypto error and closes capability', () => {
  const role = roles()
  role.openMessage = () => ({ ok: false, error: { code: 'envelope' } })
  expect(() => openDirectMessage(receive(role))).toThrow('canonical-dm:crypto')
  expect(role.dispose).toHaveBeenCalledTimes(1)
})
test('authenticated malformed plaintext rejects without semantic result', () => {
  const role = roles()
  role.sealMessage = input =>
    seal({
      ...input,
      suiteId: 1,
      senderPrivateKey: fromHex(v.message_secret_test_only),
      senderPublicKey: current.messageKey.keyBytes,
      plaintext: new Uint8Array([1, 2, 3]),
    })
  const prepared = prepareDirectMessage({
    network: corpus.network,
    senderCurrent: current,
    recipientCurrent: current,
    messageId: new Uint8Array(16),
    items: [directMessageText('valid authoring')],
    roles: role,
  })
  const recipient = roles()
  expect(() =>
    openDirectMessage({
      ...receive(recipient),
      payload: prepared.payload,
      context: prepared.context,
    }),
  ).toThrow()
  expect(recipient.dispose).toHaveBeenCalledTimes(1)
})
test('type1 delivery cannot be accepted as type5 facade input', () => {
  const role = roles()
  expect(() =>
    openDirectMessage({ ...receive(role), payload: fromHex(v.delivery) }),
  ).toThrow('canonical-dm:context')
  expect(role.dispose).toHaveBeenCalledTimes(1)
})
test('explicit historical opening returns archive classification only', async () => {
  const historical = await store.historicalEvidence(fromHex(v.t1))
  if (!historical) throw new Error('missing retained evidence')
  const result = openDirectMessage({
    network: corpus.network,
    payload: fromHex(v.payload),
    context: fromHex(v.context),
    roles: roles(),
    mode: 'archive',
    senderEvidence: historical,
    recipientEvidence: historical,
  })
  expect(result.mode).toBe('archive')
  expect(toHex(result.content)).toBe(v.content)
})
test('unsupported local generation rejects before seal effects', () => {
  const role = roles()
  Object.defineProperty(role, 'message', {
    value: { ...role.message, generation: 2147483648 },
  })
  role.sealMessage = jest.fn(role.sealMessage)
  expect(() =>
    prepareDirectMessage({
      network: corpus.network,
      senderCurrent: current,
      recipientCurrent: current,
      messageId: new Uint8Array(16),
      items: [directMessageText('text')],
      roles: role,
    }),
  ).toThrow('canonical-dm:roles')
  expect(role.sealMessage).not.toHaveBeenCalled()
  expect(role.dispose).toHaveBeenCalledTimes(1)
})
test.each(['deep', 'items'])(
  'actual authenticated %s content preserves encrypted graph limits',
  kind => {
    const f = (typeId: number, payload: Parameters<typeof encodeFrame>[1]) =>
      encodeFrame({ typeId, schemaVersion: 1, minReaderVersion: 1 }, payload)
    let item = directMessageText('leaf')
    let items: Uint8Array[]
    if (kind === 'deep') {
      for (let i = 0; i < 9; i++) item = f(9, cborMap([[0, [item]]]))
      items = [item]
    } else {
      const group = f(
        9,
        cborMap([[0, Array.from({ length: 127 }, () => item)]]),
      )
      items = [group, group, item]
    }
    const revision = f(
      8,
      cborMap([
        [0, 'frank'],
        [1, items],
      ]),
    )
    const content = f(
      6,
      cborMap([
        [0, corpus.network],
        [1, new Uint8Array(16)],
        [2, revision],
        [3, messageContentDigest(revision)],
      ]),
    )
    const sender = roles()
    sender.sealMessage = input =>
      seal({
        ...input,
        suiteId: 1,
        senderPrivateKey: fromHex(v.message_secret_test_only),
        senderPublicKey: current.messageKey.keyBytes,
        plaintext: content,
      })
    const prepared = prepareDirectMessage({
      network: corpus.network,
      senderCurrent: current,
      recipientCurrent: current,
      messageId: new Uint8Array(16),
      items: [directMessageText('valid')],
      roles: sender,
    })
    const recipient = roles()
    expect(() =>
      openDirectMessage({
        ...receive(recipient),
        payload: prepared.payload,
        context: prepared.context,
      }),
    ).toThrow()
    expect(recipient.dispose).toHaveBeenCalledTimes(1)
  },
)
test.each([
  'sender-P',
  'recipient-P',
  'proof',
  'ephemeral',
  'shared',
  'suite',
  'schema',
  'min-reader',
])('exact payload rejects substituted %s', change => {
  const parsed = parseFrame(fromHex(v.payload))
  if (
    parsed.kind !== 'parsed' ||
    parsed.typed?.type !== 5 ||
    parsed.typed.schemaVersion !== 2
  )
    throw new Error('fixture')
  const t = parsed.typed
  const a = (key: Uint8Array) =>
    cborMap([
      [0, 1],
      [1, key],
    ])
  const proof = new Uint8Array(t.dleqProof)
  if (change === 'proof') proof[0] ^= 1
  const payload = encodeFrame(
    {
      typeId: 5,
      schemaVersion: change === 'schema' ? 1 : 2,
      minReaderVersion: change === 'min-reader' || change === 'schema' ? 1 : 2,
    },
    cborMap([
      [0, corpus.network],
      [
        1,
        a(
          change === 'sender-P'
            ? current.messageKey.keyBytes
            : t.sender.keyBytes,
        ),
      ],
      [
        2,
        a(
          change === 'recipient-P'
            ? current.messageKey.keyBytes
            : t.recipient.keyBytes,
        ),
      ],
      [3, change === 'suite' ? 2 : 1],
      [4, t.cryptoBoxEnvelope],
      [
        5,
        change === 'ephemeral' ? current.messageKey.keyBytes : t.ephemeralPoint,
      ],
      [6, change === 'shared' ? current.messageKey.keyBytes : t.sharedPoint],
      [7, proof],
    ]),
  )
  const role = roles()
  expect(() => openDirectMessage({ ...receive(role), payload })).toThrow()
  expect(role.dispose).toHaveBeenCalledTimes(1)
})
test('public admitted history accepts immediately previous stamp then rejects two-old and rotated M', async () => {
  const records = directoryVectors.records
  const candidate = (id: string) => {
    const r = records.find(r => r.id === id)!
    return {
      statement: fromHex(r.type4_hex),
      attestation: fromHex(r.type2_hex),
    }
  }
  const bootstrap = candidate('bootstrap')
  const network = 'monad-testnet'
  const p = verifyPreviewDirectoryEvidence(bootstrap.attestation, network)
  const db = await openNodeDirectoryStore({
    location: join(location, 'history'),
    anchor: {
      network,
      subject: p.statement.subject,
      revisionZero: p.statementHash,
    },
    mode: { kind: 'new' },
  })
  const ctx = {
    now: { seconds: 1700001000n, nanoseconds: 0 },
    relay: p.statement.relays[0],
  }
  try {
    const original = await db.enroll([bootstrap], ctx)
    const old = await db.historicalEvidence(p.statementHash)
    if (!old) throw new Error('history')
    const prepared = prepareDirectMessage({
      network,
      senderCurrent: original,
      recipientCurrent: original,
      messageId: new Uint8Array(16),
      items: [directMessageText('history')],
      roles: roles(original, network),
    })
    const rotated = await db.advance(
      [
        candidate('renew'),
        candidate('rotate-stamp'),
        candidate('renew-after-rotation'),
      ],
      ctx,
    )
    const input = {
      network,
      payload: prepared.payload,
      context: prepared.context,
      roles: roles(rotated, network),
      mode: 'receive' as const,
      senderCurrent: original,
      recipientCurrent: rotated,
      recipientEvidence: old,
    }
    expect(openDirectMessage(input).items).toHaveLength(1)
    const twice = await db.advance([candidate('rotate-stamp-again')], ctx)
    expect(() =>
      openDirectMessage({
        ...input,
        roles: roles(twice, network),
        recipientCurrent: twice,
      }),
    ).toThrow('canonical-dm:stamp')
    const moved = await db.advance([candidate('rotate-message')], ctx)
    expect(() =>
      openDirectMessage({
        ...input,
        roles: roles(moved, network),
        recipientCurrent: moved,
      }),
    ).toThrow('canonical-dm:current')
  } finally {
    await db.close()
  }
})
test('authenticated aggregate containers retain original ciphertext graph budget', () => {
  const nested = [
    Array.from({ length: 4096 }, () => []),
    Array.from({ length: 4096 }, () => []),
    Array.from({ length: 4096 }, () => []),
    Array.from({ length: 4082 }, () => []),
  ]
  const text = directMessageText('aggregate')
  const revision = encodeFrame(
    { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [0, 'frank'],
      [1, [text]],
    ]),
  )
  const content = encodeFrame(
    { typeId: 6, schemaVersion: 2, minReaderVersion: 1 },
    cborMap([
      [0, corpus.network],
      [1, new Uint8Array(16)],
      [2, revision],
      [3, messageContentDigest(revision)],
      [99, nested],
    ]),
  )
  expect(parseFrame(content).kind).toBe('parsed')
  const sender = roles()
  sender.sealMessage = input =>
    seal({
      ...input,
      suiteId: 1,
      senderPrivateKey: fromHex(v.message_secret_test_only),
      senderPublicKey: current.messageKey.keyBytes,
      plaintext: content,
    })
  const prepared = prepareDirectMessage({
    network: corpus.network,
    senderCurrent: current,
    recipientCurrent: current,
    messageId: new Uint8Array(16),
    items: [text],
    roles: sender,
  })
  const parsed = parseFrame(prepared.payload)
  if (
    parsed.kind !== 'parsed' ||
    parsed.typed?.type !== 5 ||
    parsed.typed.schemaVersion !== 2
  )
    throw new Error('fixture')
  const t = parsed.typed,
    a = (key: Uint8Array) =>
      cborMap([
        [0, 1],
        [1, key],
      ])
  const payload = encodeFrame(
    { typeId: 5, schemaVersion: 2, minReaderVersion: 2 },
    cborMap([
      [0, corpus.network],
      [1, a(t.sender.keyBytes)],
      [2, a(t.recipient.keyBytes)],
      [3, 1],
      [4, t.cryptoBoxEnvelope],
      [5, t.ephemeralPoint],
      [6, t.sharedPoint],
      [7, t.dleqProof],
    ]),
  )
  expect(parseFrame(payload).kind).toBe('parsed')
  const recipient = roles()
  expect(() =>
    openDirectMessage({
      ...receive(recipient),
      payload,
      context: prepared.context,
    }),
  ).toThrow('resource')
  expect(recipient.dispose).toHaveBeenCalledTimes(1)
})
test('durable distinct-party browser answer opens exact bytes after public Node admission', async () => {
  const answer = corpus.canonical_facade_browser_case
  const e = verifyPreviewDirectoryEvidence(
    fromHex(answer.recipient_attestation),
    answer.network,
  )
  const db = await openNodeDirectoryStore({
    location: join(location, 'browser-answer'),
    anchor: {
      network: answer.network,
      subject: e.statement.subject,
      revisionZero: e.statementHash,
    },
    mode: { kind: 'new' },
  })
  try {
    const recipient = await db.enroll(
      [
        {
          statement: e.statementFrame.frame,
          attestation: e.attestationFrame.frame,
        },
      ],
      { now: { seconds: 200n, nanoseconds: 0 }, relay: e.statement.relays[0] },
    )
    const capability = roles(recipient)
    capability.openMessage = input =>
      open({
        ...input,
        recipientPrivateKey: fromHex(answer.recipient_message_secret_test_only),
      })
    const result = openDirectMessage({
      ...receive(capability),
      payload: fromHex(answer.payload),
      context: fromHex(answer.context),
      recipientCurrent: recipient,
    })
    expect(toHex(result.content)).toBe(answer.content)
    expect(toHex(result.contentDigest)).toBe(answer.content_digest)
    expect(toHex(result.t3)).toBe(answer.t3)
    expect(toHex(result.senderT1)).toBe(answer.sender_t1)
    expect(toHex(result.recipientT1)).toBe(answer.recipient_t1)
    expect(toHex(result.messageId)).toBe(answer.message_id)
  } finally {
    await db.close()
  }
})
test('mismatched typed role purpose fails before capability effects', () => {
  const role = roles()
  Object.defineProperty(role, 'message', {
    value: { ...role.message, purpose: 'identity-authentication' },
  })
  role.sealMessage = jest.fn(role.sealMessage)
  expect(() =>
    prepareDirectMessage({
      network: corpus.network,
      senderCurrent: current,
      recipientCurrent: current,
      messageId: new Uint8Array(16),
      items: [directMessageText('text')],
      roles: role,
    }),
  ).toThrow('canonical-dm:roles')
  expect(role.sealMessage).not.toHaveBeenCalled()
  expect(role.dispose).toHaveBeenCalledTimes(1)
})
test('open callback mutation cannot alter captured authority, context or exact envelope', async () => {
  const fresh = await store.current({
    now: { seconds: 200n, nanoseconds: 0 },
    relay: verifyPreviewDirectoryEvidence(
      current.evidence.attestation,
      corpus.network,
    ).statement.relays[0],
  })
  const role = roles(fresh),
    operation = role.openMessage
  const input = {
    ...receive(role),
    senderCurrent: fresh,
    recipientCurrent: fresh,
  }
  role.openMessage = borrowed => {
    const result = operation(borrowed)
    input.network = 'other'
    input.payload.fill(0)
    input.context.fill(0)
    fresh.evidence.hash.fill(0)
    fresh.messageKey.keyBytes.fill(0)
    fresh.stampKey.keyBytes.fill(0)
    borrowed.envelope.fill(0)
    borrowed.context.fill(0)
    borrowed.senderPublicKey.fill(0)
    return result
  }
  const result = openDirectMessage(input)
  expect(toHex(result.payload)).toBe(v.payload)
  expect(toHex(result.context)).toBe(v.context)
  expect(toHex(result.senderT1)).toBe(v.t1)
  expect(toHex(result.content)).toBe(v.content)
})
