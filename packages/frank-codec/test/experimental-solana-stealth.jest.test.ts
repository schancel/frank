import fs from 'fs'
import path from 'path'
import {
  decodeExperimentalSolanaStealthContext,
  encodeExperimentalSolanaStealthContext,
  experimentalSolanaStealthTranscript,
  projectExperimentalSolanaStealthTransfer,
} from '../src'
import {
  experimentalEntry,
  experimentalSolanaStealthCorpus,
  FROZEN_NATIVE_Q,
} from '../fixtures/experimental-solana-stealth'
import {
  encodeStealthAssetMessageItem,
  projectStealthAssetMessageItem,
} from '../src/stealth-assets'
import { parseFrame } from '../src/validate'
import { fromHex, toHex } from '../src/hash'
import type { StealthAssetTransfer } from '../src/types'

const vectorPath = path.join(
  __dirname,
  '../fixtures/experimental-solana-stealth-vectors.json',
)
if (process.env.FRANK_EMIT_EXPERIMENTAL_SOLANA_VECTORS === '1')
  fs.writeFileSync(
    vectorPath,
    JSON.stringify(experimentalSolanaStealthCorpus(), null, 2) + '\n',
  )

it('agrees with frozen native Q and generated shared vectors', () => {
  expect(toHex(experimentalSolanaStealthTranscript(experimentalEntry()))).toBe(
    FROZEN_NATIVE_Q,
  )
  expect(JSON.parse(fs.readFileSync(vectorPath, 'utf8'))).toEqual(
    experimentalSolanaStealthCorpus(),
  )
})

it.each([false, true])(
  'round trips the existing generic codec with opaque scheme2; SPL=%s',
  spl => {
    const source = experimentalEntry(spl)
    const result = parseFrame(
      encodeStealthAssetMessageItem({ transfers: [source] }),
    )
    if (result.kind !== 'parsed') throw new Error('expected parsed frame')
    const item = projectStealthAssetMessageItem(result)
    expect(item.transfers[0]).toMatchObject(source)
    const projected = projectExperimentalSolanaStealthTransfer(
      item.transfers[0],
    )
    expect(projected.recipientAmount).toBe(spl ? 18446744073709551615n : 1n)
    expect(projected.memberIndex).toBe(spl ? 4294967295 : 0)
    expect(projected.asset.kind).toBe(spl ? 'spl' : 'native')
    expect(projected.recipient).toEqual(source.recipientSpendKey.keyBytes)
    expect(projected.recipientDestination).toEqual(source.transfer.destination)
    expect(projected.rawSignedTransaction).toEqual(source.transfer.rawTx)
  },
)

it.each(experimentalSolanaStealthCorpus().invalid_contexts)(
  'rejects malformed context $id',
  item => {
    expect(() =>
      decodeExperimentalSolanaStealthContext(fromHex(item.context_hex)),
    ).toThrow()
  },
)

it.each([-1, 0.5, NaN, Infinity, 4294967296])(
  'rejects writer index %s',
  memberIndex => {
    expect(() =>
      encodeExperimentalSolanaStealthContext({
        cryptoOperationId: new Uint8Array(32),
        memberIndex,
        derivationContext: new Uint8Array(32),
      }),
    ).toThrow()
  },
)

const invalid: Array<[string, (entry: StealthAssetTransfer) => void]> = [
  [
    'scheme1',
    e => {
      e.derivationScheme = 1
    },
  ],
  [
    'unknown scheme3',
    e => {
      e.derivationScheme = 3
    },
  ],
  [
    'recipient secp',
    e => {
      e.recipientSpendKey.keyType = 1
    },
  ],
  [
    'ephemeral secp',
    e => {
      e.transfer.stealthMetadata!.ephemeralPubKey.keyType = 1
    },
  ],
  [
    'missing metadata',
    e => {
      delete e.transfer.stealthMetadata
    },
  ],
  [
    'short recipient',
    e => {
      e.recipientSpendKey.keyBytes = new Uint8Array(31)
    },
  ],
  [
    'short ephemeral',
    e => {
      e.transfer.stealthMetadata!.ephemeralPubKey.keyBytes = new Uint8Array(31)
    },
  ],
  [
    'alias',
    e => {
      e.transfer.networkTag = 'solana'
    },
  ],
  [
    'different family',
    e => {
      e.transfer.networkTag = 'btc-testnet'
    },
  ],
  [
    'zero',
    e => {
      e.transfer.value = 0n
    },
  ],
  [
    'uint64 overflow',
    e => {
      e.transfer.value = 1n << 64n
    },
  ],
  [
    'quantity256',
    e => {
      e.transfer.value = new Uint8Array(32).fill(1)
    },
  ],
  [
    'vout',
    e => {
      e.transfer.vout = 0
    },
  ],
  [
    'destination length',
    e => {
      e.transfer.destination = new Uint8Array(31)
    },
  ],
  [
    'signature length',
    e => {
      e.transfer.txId = new Uint8Array(32)
    },
  ],
  [
    'missing signed bytes',
    e => {
      delete e.transfer.rawTx
    },
  ],
  [
    'empty signed bytes',
    e => {
      e.transfer.rawTx = new Uint8Array()
    },
  ],
  [
    'oversized signed bytes',
    e => {
      e.transfer.rawTx = new Uint8Array(16385)
    },
  ],
  [
    'missing context',
    e => {
      delete e.derivationContext
    },
  ],
  [
    'native program',
    e => {
      e.tokenProgram = new Uint8Array(32)
    },
  ],
  [
    'SPL missing program',
    e => {
      e.transfer.token = new Uint8Array(32)
    },
  ],
  [
    'SPL alternate program',
    e => {
      e.transfer.token = new Uint8Array(32)
      e.tokenProgram = new Uint8Array(32)
    },
  ],
  [
    'SPL short mint',
    e => {
      const spl = experimentalEntry(true)
      Object.assign(e, spl)
      e.transfer.token = new Uint8Array(31)
    },
  ],
]
it.each(invalid)('rejects experimental projection: %s', (_name, mutate) => {
  const entry = experimentalEntry()
  mutate(entry)
  expect(() => projectExperimentalSolanaStealthTransfer(entry)).toThrow()
})

it.each([2, 3])(
  'keeps scheme %s opaque in generic readers despite experimental restrictions',
  scheme => {
    const entry = experimentalEntry()
    entry.derivationScheme = scheme
    entry.derivationContext = new Uint8Array([255])
    const result = parseFrame(
      encodeStealthAssetMessageItem({ transfers: [entry] }),
    )
    if (result.kind !== 'parsed') throw new Error('expected parsed frame')
    expect(
      projectStealthAssetMessageItem(result).transfers[0].derivationContext,
    ).toEqual(new Uint8Array([255]))
  },
)

it('copies every projected public byte field and binds all frozen Q inputs', () => {
  const entry = experimentalEntry(true)
  const projected = projectExperimentalSolanaStealthTransfer(entry)
  const originalQ = toHex(experimentalSolanaStealthTranscript(entry))
  entry.recipientSpendKey.keyBytes.fill(8)
  entry.transfer.destination.fill(8)
  entry.transfer.rawTx!.fill(8)
  entry.transfer.token!.fill(8)
  entry.tokenProgram!.fill(8)
  entry.derivationContext!.fill(8)
  expect(projected.recipient).not.toEqual(entry.recipientSpendKey.keyBytes)
  expect(projected.recipientDestination).not.toEqual(entry.transfer.destination)
  expect(projected.rawSignedTransaction).not.toEqual(entry.transfer.rawTx)
  if (projected.asset.kind !== 'spl') throw new Error('expected SPL')
  expect(projected.asset.mint).not.toEqual(entry.transfer.token)
  for (const field of [
    'cryptoOperationId',
    'memberIndex',
    'derivationContext',
  ] as const) {
    const changed = experimentalEntry(true)
    const context = decodeExperimentalSolanaStealthContext(
      changed.derivationContext!,
    )
    if (field === 'memberIndex') context[field]--
    else context[field][0]++
    changed.derivationContext = encodeExperimentalSolanaStealthContext(context)
    expect(toHex(experimentalSolanaStealthTranscript(changed))).not.toBe(
      originalQ,
    )
  }
})
