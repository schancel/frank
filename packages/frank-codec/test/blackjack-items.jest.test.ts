import { readFileSync } from 'fs'
import { join } from 'path'
import {
  beginDirectMessageValidation,
  defaultContext,
  encodeBlackjackItem,
  FrankCodecError,
  fromHex,
  parseFrame,
  projectBlackjackItem,
  type BlackjackItem,
  type Encodable,
  type ParsedFrame,
  type ValidationContext,
} from '../src'
import { typescriptBlackjackOriginFrames } from '../fixtures/blackjack-items'
import {
  M,
  NET,
  T3C,
  acct1,
  bytesOf,
  containerItem,
  deliveryPayload,
  fr,
  rev8Frame,
  textItem,
} from '../fixtures/builders'
import {
  deriveDeck,
  sha256Hex,
} from '../../wallet/message-item-plugins/blackjack/deck'

interface FrameCase {
  id: string
  frameHex: string
  context: string
  operation: ValidationContext['operation']
  frozen?: boolean
  expected: {
    result: string
    stage?: string
    category?: string
    reason?: string
  }
  application?: BlackjackItem
}
interface WriterCase {
  id: string
  field: string
  input: unknown
  expected: { result: string; projected?: string }
}
const load = (path: string) =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../docs/protocol/', path), 'utf8'),
  )
const corpus = load('cbor/vectors/blackjack-items.json') as {
  frames: FrameCase[]
  writerInputs: WriterCase[]
  contexts: Record<string, Partial<ValidationContext>>
  transcript: {
    serverSeed: string
    clientSeed: string
    commitmentHex: string
    wrongBinarySeedCommitmentHex: string
    deck: number[]
  }
}
const proposal = load('proposals/blackjack-items/vectors.json') as typeof corpus
function parsed(bytes: Uint8Array, ctx = defaultContext()): ParsedFrame {
  const result = parseFrame(bytes, ctx)
  if (result.kind !== 'parsed') throw Error('not parsed')
  return result
}
function outcome(run: () => unknown) {
  try {
    run()
    return 'parsed'
  } catch (e) {
    if (!(e instanceof FrankCodecError)) throw e
    return `${e.category}@${e.stage}`
  }
}
const raw = (id: string) => {
  const record = corpus.frames.find(f => f.id === id)
  if (!record) throw Error(`missing fixture ${id}`)
  return fromHex(record.frameHex)
}
const mapOf = (id: string) =>
  new Map(parsed(raw(id)).payload as Map<bigint, Encodable>)
const stand = () =>
  encodeBlackjackItem({
    type: 'blackjack-move',
    gameId: 'bj-test',
    action: 'stand',
  })

describe('active blackjack public facade and immutable shared corpus', () => {
  it('preserves all90 proposal frames and79 writer records without relabelling their origins', () => {
    expect(corpus.frames.slice(0, 90)).toEqual(proposal.frames)
    expect(corpus.writerInputs).toEqual(proposal.writerInputs)
    expect(proposal.frames.filter(f => f.frozen)).toHaveLength(9)
    for (const generated of typescriptBlackjackOriginFrames())
      expect(corpus.frames.find(f => f.id === generated.id)).toEqual(generated)
  })
  it.each(corpus.frames)(
    '$id: exact frame, typed projection or retained bytes, stage/category',
    f => {
      const bytes = fromHex(f.frameHex)
      const context = defaultContext({
        ...corpus.contexts[f.context],
        operation: f.operation,
      })
      if (f.expected.result === 'reject') {
        expect(outcome(() => parseFrame(bytes, context))).toBe(
          `${f.expected.category}@${f.expected.stage}`,
        )
        return
      }
      const result = parseFrame(bytes, context)
      expect(result.frame).toEqual(bytes)
      if (f.expected.result === 'retain') {
        expect(result.kind).toBe('retained')
        if (result.kind === 'retained')
          expect(result.reason).toBe(f.expected.reason)
      } else if (f.application) {
        if (result.kind !== 'parsed') throw Error('not typed')
        expect(projectBlackjackItem(result)).toEqual({
          frame: bytes,
          item: f.application,
        })
        const encoded = encodeBlackjackItem(f.application)
        expect(projectBlackjackItem(parsed(encoded)).item).toEqual(
          f.application,
        )
        if (result.schemaVersion === 1) expect(encoded).toEqual(bytes)
      }
    },
  )
  it.each(corpus.writerInputs)(
    '$id: actual writer grammar before conversion',
    f => {
      let input: Record<string, unknown> = {
        type: 'blackjack-move',
        gameId: 'bj-writer',
      }
      if (f.field === 'wagerTxHash') input.action = 'bet'
      else if (f.field === 'doubleWagerTxHash') input.action = 'double'
      else if (f.field === 'serverSeedHash')
        input = {
          ...input,
          action: 'deal',
          playerCards: [0, 1],
          dealerUpCard: 2,
        }
      else
        input = {
          type: 'blackjack-move',
          action: 'welcome',
          gameId: 'welcome',
          minWagerWei: '1',
          maxWagerWei: '9'.repeat(40),
        }
      input[f.field] = f.input
      const run = () => encodeBlackjackItem(input as unknown as BlackjackItem)
      if (f.expected.result === 'reject') expect(run).toThrow()
      else {
        const projected = projectBlackjackItem(parsed(run()))
          .item as unknown as Record<string, unknown>
        expect(projected[f.field]).toBe(f.expected.projected)
      }
    },
  )
  it('preserves actual fairness seed text and the unchanged deck helper transcript', () => {
    const t = corpus.transcript
    const item = projectBlackjackItem(parsed(raw('reveal'))).item
    if (item.action !== 'reveal') throw Error('reveal')
    expect(item.serverSeed).toBe(t.serverSeed)
    expect(sha256Hex(item.serverSeed)).toBe(t.commitmentHex)
    expect(sha256Hex(item.serverSeed)).not.toBe(t.wrongBinarySeedCommitmentHex)
    expect(deriveDeck(item.serverSeed, t.clientSeed, 0)).toEqual(t.deck)
  })
})

describe('closed shapes and independently reachable boundaries', () => {
  it('rejects every missing required key and every forbidden allocated key in each shape', () => {
    for (const f of proposal.frames.filter(f => f.frozen)) {
      const value = mapOf(f.id)
      for (const key of value.keys()) {
        // Removing a hit response hand yields the distinct valid request; welcome optionals
        // are genuinely optional, not required fields.
        if (
          (f.id === 'hit-response' && key === 5n) ||
          (f.id === 'welcome' && (key === 12n || key === 13n))
        )
          continue
        const missing = new Map(value)
        missing.delete(key)
        expect(outcome(() => parseFrame(fr(18, missing)))).toBe('schema@8.2')
      }
      for (let key = 2n; key <= 14n; key++) {
        if (value.has(key) || (f.id === 'hit-request' && key === 5n)) continue
        const extra = new Map(value)
        extra.set(key, 0)
        expect(outcome(() => parseFrame(fr(18, extra)))).toBe('schema@8.2')
      }
    }
  })
  it('checks every present field kind and closed host writer keys without coercion', () => {
    const common = { type: 'blackjack-move', gameId: 'game' } as const
    // @ts-expect-error request and response fields are mutually exclusive in the public union
    const mixed: BlackjackItem = {
      ...common,
      action: 'double',
      doubleWagerTxHash: '0x' + 'a'.repeat(64),
      playerCards: [0, 1, 2],
    }
    // @ts-expect-error a double must contain one of the two forms
    const empty: BlackjackItem = { ...common, action: 'double' }
    expect(() => encodeBlackjackItem(mixed)).toThrow()
    expect(() => encodeBlackjackItem(empty)).toThrow()
    for (const f of proposal.frames.filter(f => f.frozen)) {
      const value = mapOf(f.id)
      for (const key of value.keys())
        for (const bad of [null, true] as const) {
          const changed = new Map(value)
          changed.set(key, bad)
          expect(outcome(() => parseFrame(fr(18, changed)))).toBe('schema@8.2')
        }
      const input = f.application
      if (!input) throw Error(`missing application ${f.id}`)
      expect(() =>
        encodeBlackjackItem({ ...input, hidden: 1 } as BlackjackItem),
      ).toThrow()
    }
    for (const gameId of ['', 'x'.repeat(129), '\ud800'])
      expect(() =>
        encodeBlackjackItem({
          type: 'blackjack-move',
          action: 'stand',
          gameId,
        }),
      ).toThrow()
    expect(() =>
      encodeBlackjackItem({
        type: 'blackjack-move',
        action: 'welcome',
        gameId: 'welcome',
        minWagerWei: '1',
        maxWagerWei: '2',
        rules: undefined,
      }),
    ).toThrow()
  })
  it('keeps card/hash/gameId/seed/rules bounds at their intended stage', () => {
    for (const [id, key, badValues] of [
      ['deal', 4, [new Uint8Array(31), new Uint8Array(33)]],
      ['deal', 5, [[], [0], [0, 1, 2], [-1, 1], [0, 52]]],
      [
        'hit-response',
        5,
        [[0, 1], Array.from({ length: 53 }, (_, i) => i % 52)],
      ],
      [
        'double-response',
        5,
        [
          [0, 1],
          [0, 1, 2, 3],
        ],
      ],
      ['reveal', 7, [[0], Array.from({ length: 53 }, (_, i) => i % 52)]],
      [
        'reveal',
        8,
        ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(63) + '\n'],
      ],
      ['welcome', 13, ['x'.repeat(401), '🎴'.repeat(201)]],
    ] as [string, number, Encodable[]][]) {
      for (const bad of badValues) {
        const changed = mapOf(id)
        changed.set(BigInt(key), bad)
        expect(outcome(() => parseFrame(fr(18, changed)))).toBe('schema@8.2')
      }
    }
  })
  it('isolates root AND nested4096 cap before otherwise-closed-map rejection', () => {
    for (const size of [4096, 4097]) {
      let bytes = new Uint8Array()
      for (let n = size - 100; n < size; n++) {
        bytes = fr(
          18,
          M([
            [0, 'x'],
            [1, 3],
            [14, new Uint8Array(n)],
          ]),
        )
        if (bytes.length === size) break
      }
      expect(bytes.length).toBe(size)
      const expected = size === 4096 ? 'schema@8.2' : 'resource@8.1'
      expect(outcome(() => parseFrame(bytes))).toBe(expected)
      expect(outcome(() => parseFrame(containerItem([bytes])))).toBe(expected)
      expect(outcome(() => parseFrame(rev8Frame([bytes])))).toBe(expected)
    }
  })
  it('retains old-reader bytes/order without global-version inference or assigned-nonitem admission', () => {
    const old = defaultContext({
      readerVersion: 99,
      supportedSchemas: [
        { typeId: 16, schemaVersion: 1 },
        { typeId: 17, schemaVersion: 1 },
      ],
    })
    const welcome = raw('welcome'),
      text = textItem('last')
    const p = parsed(containerItem([welcome, text]), old)
    if (p.typed?.type !== 16) throw Error('container')
    expect(p.typed.items.map(c => c.kind)).toEqual(['retained', 'parsed'])
    expect(p.typed.items.map(c => c.frame)).toEqual([welcome, text])
    expect(outcome(() => parseFrame(welcome, old))).toBe('unsupported@7')
    expect(
      parseFrame(welcome, { ...old, opaqueRetentionAllowed: true }).kind,
    ).toBe('retained')
    for (let typeId = 1; typeId <= 15; typeId++)
      expect(
        outcome(() => parseFrame(containerItem([fr(typeId, M([]))]))),
      ).toBe('semantic@8.4')
    const badRequired = fr(
      6,
      M([
        [0, NET],
        [1, bytesOf(16, 1)],
        [2, welcome],
        [3, bytesOf(32, 2)],
      ]),
    )
    expect(outcome(() => parseFrame(badRequired))).toBe('semantic@8.4')
  })
  it('shares total256 item slots and nested depth, rather than resetting per blackjack item', () => {
    const group = containerItem(Array.from({ length: 127 }, stand))
    expect(outcome(() => parseFrame(rev8Frame([group, group])))).toBe('parsed')
    expect(outcome(() => parseFrame(rev8Frame([group, group, stand()])))).toBe(
      'resource@8.4',
    )
    let at = stand()
    for (let i = 0; i < 10; i++) at = containerItem([at])
    expect(outcome(() => parseFrame(at))).toBe('parsed')
    expect(outcome(() => parseFrame(containerItem([at])))).toBe('resource@7')
  })
  it('continues type18 through the public opaque DM session with inherited depth and terminal ownership', () => {
    const payload = fr(
      5,
      M([
        [0, NET],
        [1, acct1(9)],
        [2, acct1(3)],
        [3, 1],
        [4, Uint8Array.of(0xa0)],
        [5, T3C.ephemeral],
        [6, T3C.shared],
        [7, T3C.proof],
      ]),
      2,
      2,
    )
    const root = fr(1, deliveryPayload({ payloadFrame: payload }))
    const content = (item: Uint8Array) =>
      fr(
        6,
        M([
          [0, NET],
          [1, bytesOf(16, 1)],
          [2, rev8Frame([item])],
          [3, bytesOf(32, 2)],
        ]),
      )
    let item = stand()
    for (let i = 0; i < 7; i++) item = containerItem([item])
    const session = beginDirectMessageValidation(root, defaultContext())
    session.payload.frame.fill(0)
    expect(
      session.completeAuthenticatedContent(content(item)).content.typeId,
    ).toBe(6)
    expect(() => session.completeAuthenticatedContent(content(item))).toThrow()
    item = containerItem([item])
    expect(outcome(() => parseFrame(content(item)))).toBe('parsed')
    expect(
      outcome(() =>
        beginDirectMessageValidation(
          root,
          defaultContext(),
        ).completeAuthenticatedContent(content(item)),
      ),
    ).toBe('resource@7')
    const aborted = beginDirectMessageValidation(root, defaultContext())
    aborted.abort()
    expect(() =>
      aborted.completeAuthenticatedContent(content(stand())),
    ).toThrow()
  })
})

it.each(['containers', 'items'] as const)(
  'type18 continuation shares aggregate-only %s counters',
  kind => {
    const grouped = (count: number): Encodable[] => {
      const groups: Encodable[] = []
      for (let i = 0; i < count; i += 4096)
        groups.push(
          Array.from({ length: Math.min(4096, count - i) }, () =>
            kind === 'containers' ? [] : 0,
          ),
        )
      return groups
    }
    const payload = fr(
      5,
      M([
        [0, NET],
        [1, acct1(9)],
        [2, acct1(3)],
        [3, 1],
        [4, Uint8Array.of(0xa0)],
        [5, T3C.ephemeral],
        [6, T3C.shared],
        [7, T3C.proof],
      ]),
      2,
      2,
    )
    const fields = deliveryPayload({ payloadFrame: payload })
    fields.set(99, grouped(kind === 'containers' ? 8000 : 60000))
    const root = fr(1, fields, 2, 1)
    const content = fr(
      6,
      M([
        [0, NET],
        [1, bytesOf(16, 1)],
        [2, rev8Frame([stand()])],
        [3, bytesOf(32, 2)],
        [99, grouped(kind === 'containers' ? 9000 : 75000)],
      ]),
      2,
      1,
    )
    expect(outcome(() => parseFrame(root))).toBe('parsed')
    expect(outcome(() => parseFrame(content))).toBe('parsed')
    expect(
      outcome(() =>
        beginDirectMessageValidation(
          root,
          defaultContext(),
        ).completeAuthenticatedContent(content),
      ),
    ).toBe('resource@7')
  },
)
