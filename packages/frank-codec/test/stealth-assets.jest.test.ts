import {
  cborMap,
  decodeCanonical,
  defaultContext,
  encodeFrame,
  encodeStealthAssetMessageItem,
  encodeStealthMessageItem,
  fromHex,
  isStealthAssetMessageItemFrame,
  isStealthMessageItemFrame,
  parseFrame,
  projectStealthAssetMessageItem,
  projectStealthMessageItem,
  toHex,
} from '../src'
import type { CanonicalStealthAssetMessageItem } from '../src'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { stealthAssetCorpus } from '../fixtures/stealth-assets'

const corpusPath = resolve(
  __dirname,
  '../../..',
  'docs/protocol/cbor/vectors/stealth-assets.json',
)
if (process.env.FRANK_UPDATE_STEALTH_ASSET_VECTORS === '1')
  writeFileSync(
    corpusPath,
    JSON.stringify(stealthAssetCorpus(), null, 2) + '\n',
  )

const recipient = fromHex(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
)
const ephemeral = fromHex(
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
)
const entry = (): CanonicalStealthAssetMessageItem['transfers'][number] => ({
  transfer: {
    networkTag: 'monad-testnet',
    txId: 'ab'.repeat(32),
    destination: 'cd'.repeat(20),
    value: 2n ** 200n + 7n,
    token: 'ef'.repeat(20),
    stealthMetadata: { keyType: 1, ephemeralPubKey: ephemeral },
    rawTx: '010203',
  },
  derivationScheme: 1,
  recipientSpendKey: { keyType: 1, keyBytes: recipient },
})

function payloadOf(bytes: Uint8Array): Map<bigint, unknown> {
  const envelope = decodeCanonical(bytes.subarray(9)) as Map<bigint, unknown>
  return decodeCanonical(envelope.get(3n) as Uint8Array) as Map<bigint, unknown>
}

describe('recipient asset payment type 19 schema 2', () => {
  test('generated shared corpus matches its source generator', () => {
    expect(JSON.parse(readFileSync(corpusPath, 'utf8'))).toEqual(
      stealthAssetCorpus(),
    )
  })
  test('round trips exact token amount and evidence without becoming a native schema-1 item', () => {
    const bytes = encodeStealthAssetMessageItem({
      transfers: [entry()],
      memo: 'payment',
    })
    const parsed = parseFrame(bytes)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.minReaderVersion).toBe(2)
    expect(isStealthAssetMessageItemFrame(parsed)).toBe(true)
    expect(isStealthMessageItemFrame(parsed)).toBe(false)
    expect(() => projectStealthMessageItem(parsed)).toThrow()
    const item = projectStealthAssetMessageItem(parsed)
    expect(item.transfers[0].transfer.value).toEqual(
      fromHex((2n ** 200n + 7n).toString(16).padStart(64, '0')),
    )
    expect(toHex(item.transfers[0].transfer.token!)).toBe('ef'.repeat(20))
    expect(toHex(item.transfers[0].transfer.rawTx!)).toBe('010203')
    expect(item.transfers[0].recipientSpendKey.keyBytes).toEqual(recipient)
    expect(item.memo).toBe('payment')
  })

  test('native uint64 and output index remain exact', () => {
    const transfer = entry()
    delete transfer.transfer.token
    transfer.transfer.value = 18446744073709551615n
    transfer.transfer.vout = 4294967295
    const parsed = parseFrame(
      encodeStealthAssetMessageItem({ transfers: [transfer] }),
    )
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(
      projectStealthAssetMessageItem(parsed).transfers[0].transfer.value,
    ).toBe(18446744073709551615n)
    expect(
      projectStealthAssetMessageItem(parsed).transfers[0].transfer.vout,
    ).toBe(4294967295)
  })

  test('schema-1 financial recovery still parses with its original projection', () => {
    const parsed = parseFrame(
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'btc-testnet',
        keyType: 1,
        ephemeralPubKey: toHex(ephemeral),
        transactions: ['0102'],
        amount: 1n,
      }),
    )
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(isStealthMessageItemFrame(parsed)).toBe(true)
    expect(isStealthAssetMessageItemFrame(parsed)).toBe(false)
    expect(projectStealthMessageItem(parsed).amount).toBe(1)
  })

  test('reader with only schema-1 support rejects, and old payload shape cannot interpret the payment as native', () => {
    const bytes = encodeStealthAssetMessageItem({ transfers: [entry()] })
    const ctx = defaultContext({ readerVersion: 4 })
    ctx.supportedSchemas = ctx.supportedSchemas.map(schema =>
      schema.typeId === 19 ? { typeId: 19, schemaVersion: 1 } : schema,
    )
    expect(() => parseFrame(bytes, ctx)).toThrow()
    const payload = payloadOf(bytes)
    // Even an older implementation without the new per-type guard cannot parse field 0 as
    // its required native network string. No token field is silently ignored as native.
    expect(Array.isArray(payload.get(0n))).toBe(true)
    const oldShape = cborMap([
      [0, []],
      [
        1,
        cborMap([
          [0, 1],
          [1, ephemeral],
        ]),
      ],
      [2, [new Uint8Array([1])]],
      [3, 1n],
    ])
    expect(() =>
      parseFrame(
        encodeFrame(
          { typeId: 19, schemaVersion: 1, minReaderVersion: 1 },
          oldShape,
        ),
      ),
    ).toThrow()
  })

  test('unknown positive derivation scheme retains its exact descriptor without allocating a signer', () => {
    const transfer = entry()
    transfer.derivationScheme = 4294967295
    transfer.tokenProgram = new Uint8Array(32).fill(4)
    transfer.derivationContext = new Uint8Array([1, 2, 3])
    const parsed = parseFrame(
      encodeStealthAssetMessageItem({ transfers: [transfer] }),
    )
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = projectStealthAssetMessageItem(parsed).transfers[0]
    expect(result.derivationScheme).toBe(4294967295)
    expect(result.tokenProgram).toEqual(transfer.tokenProgram)
    expect(result.derivationContext).toEqual(transfer.derivationContext)
  })

  test.each([
    'zero',
    'missing metadata',
    'key mismatch',
    'program without token',
    'known scheme context',
    'zero scheme',
  ])('rejects malformed %s', condition => {
    const transfer = entry()
    if (condition === 'zero') transfer.transfer.value = 0n
    if (condition === 'missing metadata')
      delete transfer.transfer.stealthMetadata
    if (condition === 'key mismatch')
      transfer.recipientSpendKey = { keyType: 2, keyBytes: new Uint8Array(32) }
    if (condition === 'program without token') {
      delete transfer.transfer.token
      transfer.derivationScheme = 2
      transfer.tokenProgram = new Uint8Array(32)
    }
    if (condition === 'known scheme context')
      transfer.derivationContext = new Uint8Array([1])
    if (condition === 'zero scheme') transfer.derivationScheme = 0
    expect(() =>
      encodeStealthAssetMessageItem({ transfers: [transfer] }),
    ).toThrow()
  })

  test('enforces transfer and context bounds and schema min-reader', () => {
    expect(() => encodeStealthAssetMessageItem({ transfers: [] })).toThrow()
    expect(() =>
      encodeStealthAssetMessageItem({
        transfers: Array.from({ length: 17 }, entry),
      }),
    ).toThrow()
    const transfer = entry()
    transfer.derivationScheme = 2
    transfer.derivationContext = new Uint8Array(1025)
    expect(() =>
      encodeStealthAssetMessageItem({ transfers: [transfer] }),
    ).toThrow()
    const good = encodeStealthAssetMessageItem({ transfers: [entry()] })
    const payload = payloadOf(good)
    expect(() =>
      parseFrame(
        encodeFrame(
          { typeId: 19, schemaVersion: 2, minReaderVersion: 1 },
          {
            bytes: (
              decodeCanonical(good.subarray(9)) as Map<bigint, Uint8Array>
            ).get(3n)!,
          },
        ),
      ),
    ).toThrow()
    expect(payload.has(0n)).toBe(true)
  })
})
