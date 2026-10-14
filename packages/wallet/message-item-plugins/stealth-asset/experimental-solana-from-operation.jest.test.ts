import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type {
  SolanaPaymentAsset,
  SolanaPaymentMemberContext,
  SolanaPaymentOperation,
  SolanaSignedPayment,
} from '../../solana-contact-payments/types'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import {
  encodeCanonical,
  encodeFrame,
  experimentalSolanaStealthTranscript,
  projectExperimentalSolanaStealthTransfer,
  fromHex,
  isStealthAssetMessageItemFrame,
  standaloneItemBudget,
  toHex,
  validateFrame,
  type Encodable,
} from '@frank/codec'
import { createDefaultMessageItemRegistry } from '../default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../registry'
import { decodeItemFrames, encodeItemFrames } from '../wire'
import { experimentalSolanaRecipientAssetPaymentsFromOperation as project } from './experimental-solana-from-operation'

// Exact public originals from the ac0 owner actual WASM + IndexedDB browser proof,
// frank-solana-owner-browser-lyT42R/owner-signed-members.json. No secrets or live funds.
const manifest: {
  chainIdentifier: string
  asset: SolanaPaymentAsset
  context: SolanaPaymentMemberContext
  original: SolanaSignedPayment
}[] = [
  {
    chainIdentifier: 'solana-devnet',
    asset: {
      kind: 'native',
    },
    context: {
      cryptoOperationId32:
        'bc931fcac496239f93c1c57f6414669ec2ce1fbefe61d6aa2e509dc2837b1053',
      derivationContext32:
        '82b8688252c8cc56e02e045acac7496732b17d5f9a49310877ced87e87885230',
      memberIndex: 0,
    },
    original: {
      memberIndex: 0,
      sourceOwner: '5GCuAz7iHUdQbsRaToAhggZ3jZsKUJrEqkQYfQo5gEn2',
      signature:
        'WDpPGRv3TsVJSwYJ3iekpGHfzEsrhSVkY52bjzcHeJWxbbQ5bPt83pVCDveeQZSjS84oY8dn7uqFiDJzANZxq4f',
      transaction:
        'ARky9fnZfvkvk0EHpmqrZToyc2AMPkUOOrbPzUUc1iDjI+D0GQboqCuOrmgPbMwWDxOPj0P4096e0iAEgHcz6gyAAQACBD9T6ifpm+aeNIPugX+D3w7ER5AGhOFDAuwg4PM2OZffvrZwtneTOm1QrFz0CJkoh+khSnjJNPfwq6Vg1mdZBRoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVKU1qZKSEGTSTocWDaOHx8NbXdvJK7geQfqEBBBUSNypOsFwUYcHHWe4PH/w7+gQjo7EUwV113JoeTM9vavnwCAgIAAQwCAAAAEwAAAAAAAAADAG1mcmFuazpzb2xhbmEtY3VzdG9keS1wcmltYXJ5OmV4cGVyaW1lbnRhbC12MTowNmI2NmY4ZmMzNzkyMDY0MzAzNWEzODYzZTI4MzgyYTUyNGM0MWIzNGYwOTEzMmZmOGQ3ODVlZTU5OTM4NzhhAA==',
      blockhash: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
      lastValidBlockHeight: 200,
      sourceAddresses: ['5GCuAz7iHUdQbsRaToAhggZ3jZsKUJrEqkQYfQo5gEn2'],
      destination: {
        recipientPoint: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
        ephemeralPoint: 'GNkJPq9QAkdb1nyrEYcnEoh3QNgmMNUsvF337KgfSf7S',
        destinationOwner: 'DqTpCF5ArS8MRdf8qLHYRsWfqqcU92UDcUXMAQMrWpAV',
      },
      amount: '19',
      feeLamports: '1',
      rentLamports: '0',
    },
  },
  {
    chainIdentifier: 'solana-devnet',
    asset: {
      kind: 'native',
    },
    context: {
      cryptoOperationId32:
        'c0371d920ef8b5a7902167ed98a7a7be96b6d9510b3d85e24b5b5301742ba7b9',
      derivationContext32:
        '7071557baba8a432cd947c47880852d8977a3a3d944fc23e3659bad832a5f886',
      memberIndex: 1,
    },
    original: {
      memberIndex: 1,
      sourceOwner: '7dh3V6RMnrM2r4qYqYzJrb7RgGR6nRVTJCXddLJMFp1w',
      signature:
        '23UJU15vqfxn14R2W9Pw6uhqCt6yk1j9LyCFqrNTbetxMY9eEscjtZqVPi3Rv9CBPN2Qyosbe6bdPgwz1thmHtHu',
      transaction:
        'ATQlzAH0Zt/Jjdvm3KfsplXSGR/V0w+7MEPOvKq2moIp6TDVDOuYfF2Dz8Xer5GLjePHCYZw7I5vJb9p7xcERACAAQACBGKMTqiw5gQBoS4YpX/0DU6PkvEeJ0yfQzShW271TEGi/NAjZ7GxGFEu+6mPGNlIEVp9DmDCeVTlcIPpHy4iPh0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVKU1qZKSEGTSTocWDaOHx8NbXdvJK7geQfqEBBBUSNypOsFwUYcHHWe4PH/w7+gQjo7EUwV113JoeTM9vavnwCAgIAAQwCAAAAEAAAAAAAAAADAG1mcmFuazpzb2xhbmEtY3VzdG9keS1wcmltYXJ5OmV4cGVyaW1lbnRhbC12MTphZGVmZjFjNjgzODAxZTk4ZTU5ZWU1YmVmNzVkYzcxYzg2ZDcwY2U2NTcxNzA3YjMxZmE1MDU4MmZiYTYzYWNmAA==',
      blockhash: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
      lastValidBlockHeight: 200,
      sourceAddresses: ['7dh3V6RMnrM2r4qYqYzJrb7RgGR6nRVTJCXddLJMFp1w'],
      destination: {
        recipientPoint: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
        ephemeralPoint: '3MrbqJbbasNVycNCPxviTsRVp6yz3aNtoUaH6RRm3WXw',
        destinationOwner: 'J1spU7Wku2utedZGbdEtMCnF5Crf8qD912garikAYszc',
      },
      amount: '16',
      feeLamports: '1',
      rentLamports: '0',
    },
  },
  {
    chainIdentifier: 'solana-devnet',
    asset: {
      kind: 'spl',
      mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
      program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 6,
    },
    context: {
      cryptoOperationId32:
        '1010a8561677c142a1ef6a84fd114b82e02c76fdbb6e737d29e26d77586b9844',
      derivationContext32:
        '76baa4432b058733a7d2d3bccea4907466b3b4c3a62ce20821d0efe0d89b6dd6',
      memberIndex: 0,
    },
    original: {
      memberIndex: 0,
      sourceOwner: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
      signature:
        '3Q4jz4NAZvqZfPvj9UoVb3Q1wXCgtVZmQYgFVgcfpBskSHM9r2hTgeweiwNAHW846y3EmbN8gwEjwKtRxauy2Mhy',
      transaction:
        'AXfsh9N2BSQHkO32Wo+ke4T9pl6pj/Y4BOS9zTJ0heSdvps4PIMZW/5zPr2INYr17DzcsLgIDtbSDNVnAK1leACAAQAGCYqI4910CfGV/VLbLTy6XXLKZwm/HZQSG/N0iAG0D29cGOKDRGh3R2dch07ycMAn8y2OHbhXG+fMkmqY3+Ct1vSL0TW/VY36tLAqBrlB0Ep2XTWP2qEvywjTABi5KIiHZ5rrN+G09YtY/zby/OyDqYAI6xZ1+QDTpquQivi42FCHBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKkFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjX5wsU4vEfkq+lzDJU6Iz0HYmNOLBpsLWhIjB0yfU7oQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WcqTrBcFGHBx1nuDx/8O/oEI6OxFMFdddyaHkzPb2r58AwgGAAIGAwcEAQEEBAEDAgAKDBQAAAAAAAAABgUAbWZyYW5rOnNvbGFuYS1jdXN0b2R5LXByaW1hcnk6ZXhwZXJpbWVudGFsLXYxOmU2NmIyMzcwNDYwMGNhNGE0MWRlNjgwYWU4NjU3Y2ViOGNjNTgxYzYzMzg4NDNhODFlN2QyZWM3MTBiMWVmODcA',
      blockhash: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
      lastValidBlockHeight: 200,
      sourceAddresses: [
        '2g97bmBwm9FGKcLAAs12RysMYWEQqhjCRXDJ12Hbo2hq',
        'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
      ],
      destination: {
        recipientPoint: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
        ephemeralPoint: 'H948ir2XeAwkTaK4cTR1EmNBqP3PbhmdYzkPHfhJQ1ti',
        destinationOwner: '9Wa35WgngoExwg5dFqbRcKC1i2kfaBx8RKtUkV476f6F',
      },
      amount: '20',
      feeLamports: '5',
      rentLamports: '10',
    },
  },
  {
    chainIdentifier: 'solana-devnet',
    asset: {
      kind: 'spl',
      mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
      program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 6,
    },
    context: {
      cryptoOperationId32:
        '6e527563b48114270b36382c23322c8e88a3ba6569c1ab34d3dccaed5e9f44dc',
      derivationContext32:
        '2a58824841e8f68e5d9dbd811fce76e77a53bb6340d53b8799d7e3fbe7e4f005',
      memberIndex: 0,
    },
    original: {
      memberIndex: 0,
      sourceOwner: '9Wa35WgngoExwg5dFqbRcKC1i2kfaBx8RKtUkV476f6F',
      signature:
        '5SKdMYZvFrsvgg2i6qPi1WfMZAzasanK1QxxVZnfacZoBYS3f7PoMLwVkQ27icTt3QSRcLbXhvEGFQnoLGnSz8d6',
      transaction:
        'Ad3nbB9j7aAxXSpO5QNX1XIoWsFsns+sf6SBx3sU41ECKB1oKnotEPyINAUVjvPiLBrA22IwP+OMTuunhZ+W7AGAAQAGCX5wsU4vEfkq+lzDJU6Iz0HYmNOLBpsLWhIjB0yfU7oQi9E1v1WN+rSwKga5QdBKdl01j9qhL8sI0wAYuSiIh2eOcwNuuGRGLK+ixYX7LQqY5MgKgPIE9f470gvec9ITjZrrN+G09YtY/zby/OyDqYAI6xZ1+QDTpquQivi42FCHBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKkFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjWbmo/4NPQZxh2fzZ2wtLUFWyCaluDXmjDIUwRW4OnqhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WcqTrBcFGHBx1nuDx/8O/oEI6OxFMFdddyaHkzPb2r58AwgGAAIGAwcEAQEEBAEDAgAKDA8AAAAAAAAABgUAbWZyYW5rOnNvbGFuYS1jdXN0b2R5LXByaW1hcnk6ZXhwZXJpbWVudGFsLXYxOmI3NTk4NWUxNWEzMWNhMTQyYzVjYTJlMjhkNjlhOTA2MDM5ZWRmZjQ1YmNhNWY4ZmQyYTQ2NmVjOWM3MGJhNjUA',
      blockhash: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
      lastValidBlockHeight: 200,
      sourceAddresses: [
        'AQnhPTJvTobjchPFFeaDiEAB4HibzEgmzPMq3HZCum2n',
        '9Wa35WgngoExwg5dFqbRcKC1i2kfaBx8RKtUkV476f6F',
      ],
      destination: {
        recipientPoint: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
        ephemeralPoint: '2E9ehbHxv2JNEJs8vt6EG29vC1ZJRAyRgevAzA16Gapz',
        destinationOwner: '7vgZmGWinwr33yPoMZtx3fyVyESiE9Vbrz2GRZekrwep',
      },
      amount: '15',
      feeLamports: '1',
      rentLamports: '10',
    },
  },
]

function operation(rows = manifest.slice(0, 2)): SolanaPaymentOperation {
  const amount = rows.reduce(
    (sum, row) => sum + BigInt(row.original.amount),
    0n,
  )
  return {
    intent: {
      operationId: '00000000-0000-0000-0000-000000000001',
      chainIdentifier: rows[0].chainIdentifier,
      recipientSpendPoint: rows[0].original.destination.recipientPoint,
      asset: structuredClone(rows[0].asset),
      amount: amount.toString(),
      maxFeeLamports: rows
        .reduce((sum, row) => sum + BigInt(row.original.feeLamports), 0n)
        .toString(),
      maxRentLamports: rows
        .reduce((sum, row) => sum + BigInt(row.original.rentLamports), 0n)
        .toString(),
      maxNativeDebitLamports: rows
        .reduce(
          (sum, row) =>
            sum +
            BigInt(row.original.feeLamports) +
            BigInt(row.original.rentLamports) +
            (row.asset.kind === 'native' ? BigInt(row.original.amount) : 0n),
          0n,
        )
        .toString(),
      allowDestinationAtaCreation: rows[0].asset.kind === 'spl',
    },
    contexts: rows.map(row => structuredClone(row.context)),
    members: rows.map(row => ({
      amount: row.original.amount,
      destination: structuredClone(row.original.destination),
      sourceAddresses: [...row.original.sourceAddresses],
      createDestinationAta: row.original.rentLamports !== '0',
      rentLamports: row.original.rentLamports,
      maxFeeLamports: row.original.feeLamports,
      maxRentLamports: row.original.rentLamports,
      maxNativeDebitLamports: (
        BigInt(row.original.feeLamports) +
        BigInt(row.original.rentLamports) +
        (row.asset.kind === 'native' ? BigInt(row.original.amount) : 0n)
      ).toString(),
      review: {
        sourceAddresses: [...row.original.sourceAddresses],
        blockhash: row.original.blockhash,
        lastValidBlockHeight: row.original.lastValidBlockHeight,
        message: Buffer.from(
          VersionedTransaction.deserialize(
            Buffer.from(row.original.transaction, 'base64'),
          ).message.serialize(),
        ).toString('base64'),
        feeLamports: row.original.feeLamports,
        rentLamports: row.original.rentLamports,
      },
    })),
    signed: rows.map(row => structuredClone(row.original)),
    sourceAddresses: rows.flatMap(row => row.original.sourceAddresses),
    phase: 'signed',
    outcomes: {},
  }
}
const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)
function children(frames: Uint8Array[]) {
  const result = validateFrame(
    encodeFrame(
      { typeId: 20, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, frames],
      ]),
    ),
  )
  if (result.kind !== 'parsed' || result.typed?.type !== 20)
    throw new Error('expected revision')
  return result.typed.items
}
const pub = (value: string) => new PublicKey(value).toBytes()

it.each(['signed', 'exposed', 'settled'] as const)(
  'preserves all actual owner original bytes and per-member bindings in phase %s',
  phase => {
    for (const rows of [
      manifest.slice(0, 2),
      manifest.slice(2, 3),
      manifest.slice(3, 4),
    ]) {
      const input = operation(rows)
      input.phase = phase
      if (phase !== 'signed') input.payloadDigest = 'ab'.repeat(32)
      if (phase === 'settled')
        input.outcomes = Object.fromEntries(
          input.signed.map(original => [original.signature, 'confirmed']),
        )
      const before = structuredClone(input)
      const items = project(input, 'experimental claim')
      expect(Object.isFrozen(items)).toBe(true)
      const frames = encodeItemFrames(registry, [...items])
      const received = decodeItemFrames(
        registry,
        children(frames),
        standaloneItemBudget(),
      )
      expect(received).toEqual(items)
      expect(registry.tallyValue(received)).toBe(0)
      const parsed = validateFrame(frames[0])
      if (parsed.kind !== 'parsed' || !isStealthAssetMessageItemFrame(parsed))
        throw new Error('expected type19 schema2')
      expect([
        parsed.typeId,
        parsed.schemaVersion,
        parsed.minReaderVersion,
      ]).toEqual([19, 2, 2])
      for (const [index, entry] of parsed.typed.transfers.entries()) {
        const row = rows[index]
        const expectedAsset =
          row.asset.kind === 'native'
            ? [0]
            : [1, pub(row.asset.mint), pub(row.asset.program)]
        const q = encodeCanonical([
          'frank:solana-stealth:edwards-add:v1',
          row.chainIdentifier,
          expectedAsset,
          pub(row.original.destination.recipientPoint),
          pub(row.original.destination.ephemeralPoint),
          fromHex(row.context.cryptoOperationId32),
          row.context.memberIndex,
          fromHex(row.context.derivationContext32),
          BigInt(row.original.amount),
        ])
        expect(experimentalSolanaStealthTranscript(entry)).toEqual(q)
        expect(entry.transfer.rawTx).toEqual(
          Uint8Array.from(Buffer.from(row.original.transaction, 'base64')),
        )
        expect(items[0].transfers[index].rawTx).toBe(
          Buffer.from(row.original.transaction, 'base64').toString('hex'),
        )
        expect(items[0].transfers[index].destination).toBe(
          toHex(pub(row.original.destination.destinationOwner)),
        )
        expect(entry.derivationScheme).toBe(2) // Remains unknown/unallocated data, never execution authority.
        expect(entry.recipientSpendKey.keyBytes).toEqual(
          pub(input.intent.recipientSpendPoint),
        )
      }
      expect(
        items
          .flatMap(item => item.transfers)
          .reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n),
      ).toBe(BigInt(input.intent.amount))
      expect(input).toEqual(before)
    }
  },
)

it('preserves the original set when settled outcomes include a failed member', () => {
  const input = operation()
  const expected = project(input)
  input.phase = 'settled'
  input.payloadDigest = 'ab'.repeat(32)
  input.outcomes = {
    [input.signed[0].signature]: 'failed',
    [input.signed[1].signature]: 'confirmed',
  }
  expect(project(input)).toEqual(expected)
  expect(registry.tallyValue([...project(input)])).toBe(0)
})

// Larger sets are structural grouping fixtures, not owner-validated cryptographic operations.
function structuralSet(count: number): SolanaPaymentOperation {
  const source = manifest[0]
  const rows = Array.from({ length: count }, (_, index) => {
    const row = structuredClone(source)
    row.context = {
      cryptoOperationId32: index.toString(16).padStart(64, '0'),
      derivationContext32: (1000 + index).toString(16).padStart(64, '0'),
      memberIndex: index,
    }
    row.original.memberIndex = index
    const raw = Buffer.from(row.original.transaction, 'base64')
    raw[1] = index
    row.original.signature = getBase58Decoder().decode(raw.subarray(1, 65))
    row.original.transaction = raw.toString('base64')
    row.original.sourceAddresses = [
      new PublicKey(new Uint8Array(32).fill(index + 1)).toBase58(),
    ]
    return row
  })
  return operation(rows)
}

it.each([
  [1, [1]],
  [16, [16]],
  [17, [16, 1]],
  [64, [16, 16, 16, 16]],
])(
  'groups %s originals under the unchanged per-item wire bound',
  (count, lengths) => {
    const input = structuralSet(count as number)
    const items = project(input)
    expect(items.map(item => item.transfers.length)).toEqual(lengths)
    const frames = encodeItemFrames(registry, [...items])
    expect(
      decodeItemFrames(registry, children(frames), standaloneItemBudget()),
    ).toEqual(items)
    for (const frame of frames) {
      const parsed = validateFrame(frame)
      if (parsed.kind !== 'parsed' || !isStealthAssetMessageItemFrame(parsed))
        throw new Error('expected recipient frame')
      for (const entry of parsed.typed.transfers)
        expect(
          experimentalSolanaStealthTranscript(entry).length,
        ).toBeGreaterThan(0)
    }
  },
)

const malformed: Array<[string, (op: SolanaPaymentOperation) => void]> = [
  [
    'quoted',
    op => {
      op.phase = 'quoted'
    },
  ],
  [
    'reserved',
    op => {
      op.phase = 'reserved'
    },
  ],
  [
    'empty set',
    op => {
      op.signed = []
      op.members = []
      op.contexts = []
    },
  ],
  [
    'missing original',
    op => {
      op.signed.pop()
    },
  ],
  [
    'missing context',
    op => {
      op.contexts.pop()
    },
  ],
  [
    'wrong signed index',
    op => {
      op.signed[1].memberIndex = 0
    },
  ],
  [
    'wrong context index',
    op => {
      op.contexts[1].memberIndex = 0
    },
  ],
  [
    'short crypto id',
    op => {
      op.contexts[0].cryptoOperationId32 = '00'
    },
  ],
  [
    'uppercase context',
    op => {
      op.contexts[0].derivationContext32 = 'AB'.repeat(32)
    },
  ],
  [
    'circular context',
    op => {
      op.contexts[0].derivationContext32 = op.contexts[0].cryptoOperationId32
    },
  ],
  [
    'sum mismatch',
    op => {
      op.intent.amount = '36'
    },
  ],
  [
    'zero member',
    op => {
      op.members[0].amount = '0'
      op.signed[0].amount = '0'
    },
  ],
  [
    'noncanonical amount',
    op => {
      op.members[0].amount = '019'
    },
  ],
  [
    'uint64 overflow',
    op => {
      op.intent.amount = '18446744073709551616'
    },
  ],
  [
    'original amount mismatch',
    op => {
      op.signed[0].amount = '18'
    },
  ],
  [
    'foreign chain',
    op => {
      op.intent.chainIdentifier = 'ethereum-sepolia'
    },
  ],
  [
    'alias chain',
    op => {
      op.intent.chainIdentifier = 'solana'
    },
  ],
  [
    'missing destination',
    op => {
      delete op.members[0].destination
    },
  ],
  [
    'foreign recipient',
    op => {
      op.intent.recipientSpendPoint =
        manifest[2].original.destination.recipientPoint
    },
  ],
  [
    'changed R',
    op => {
      op.signed[0].destination.ephemeralPoint =
        manifest[1].original.destination.ephemeralPoint
    },
  ],
  [
    'changed P',
    op => {
      op.signed[0].destination.destinationOwner =
        manifest[1].original.destination.destinationOwner
    },
  ],
  [
    'changed member sources',
    op => {
      op.members[0].sourceAddresses = []
    },
  ],
  [
    'changed aggregate sources',
    op => {
      op.sourceAddresses.pop()
    },
  ],
  [
    'short signature',
    op => {
      op.signed[0].signature = '1'.repeat(32)
    },
  ],
  [
    'signature differs from raw',
    op => {
      op.signed[0].signature = op.signed[1].signature
    },
  ],
  [
    'noncanonical base64',
    op => {
      op.signed[0].transaction += '\n'
    },
  ],
  [
    'empty raw',
    op => {
      op.signed[0].transaction = ''
    },
  ],
  [
    'oversized raw',
    op => {
      op.signed[0].transaction = Buffer.alloc(16385).toString('base64')
    },
  ],
]
it.each(malformed)('rejects malformed original set: %s', (_name, mutate) => {
  const input = operation()
  mutate(input)
  expect(() => project(input)).toThrow()
})

it('rejects duplicate original signatures/bytes and excessive member cardinality', () => {
  const input = operation()
  input.signed[1].transaction = input.signed[0].transaction
  input.signed[1].signature = input.signed[0].signature
  expect(() => project(input)).toThrow('Duplicate signed original')
  expect(() => project(structuralSet(65))).toThrow('cardinality')
})

it('rejects unsupported SPL metadata and keeps decimals outside Q', () => {
  const input = operation(manifest.slice(2, 3))
  if (input.intent.asset.kind !== 'spl') throw new Error('SPL fixture required')
  const original = structuredClone(input)
  input.intent.asset.program = manifest[0].original.sourceOwner
  expect(() => project(input)).toThrow('classic SPL')
  input.intent.asset = { ...original.intent.asset } as SolanaPaymentAsset
  if (input.intent.asset.kind !== 'spl') throw new Error('SPL fixture required')
  input.intent.asset.decimals = 256
  expect(() => project(input)).toThrow('classic SPL')
  input.intent.asset.decimals = 9
  expect(project(input)).toEqual(project(original))
})

it('uses existing byte-based memo validation and copies public values', () => {
  const input = operation()
  const items = project(input, 'é'.repeat(512))
  expect(items[0].memo).toHaveLength(512)
  expect(() => project(input, 'é'.repeat(513))).toThrow()
  const preserved = structuredClone(items)
  input.signed[0].transaction = ''
  const destination = input.members[0].destination
  if (!destination) throw new Error('fixture destination missing')
  destination.destinationOwner = ''
  input.contexts[0].cryptoOperationId32 = ''
  expect(items).toEqual(preserved)
})

test('actual packaged WASM accepts each independently projected public native/SPL descriptor and rejects a changed amount', () => {
  const inputs = [
    manifest.slice(0, 2),
    manifest.slice(2, 3),
    manifest.slice(3, 4),
  ].flatMap(rows => {
    const frames = encodeItemFrames(registry, [...project(operation(rows))])
    const parsed = validateFrame(frames[0])
    if (parsed.kind !== 'parsed' || !isStealthAssetMessageItemFrame(parsed))
      throw new Error('expected dedicated recipient frame')
    return parsed.typed.transfers.map((transfer, index) => {
      const row = rows[index]
      const entry = projectExperimentalSolanaStealthTransfer(transfer)
      expect(entry.rawSignedTransaction).toEqual(
        Uint8Array.from(Buffer.from(row.original.transaction, 'base64')),
      )
      return {
        descriptor: {
          chainIdentifier: entry.chainIdentifier,
          asset:
            entry.asset.kind === 'native'
              ? { kind: 'native' }
              : {
                  kind: 'spl',
                  mint: [...entry.asset.mint],
                  tokenProgram: [...entry.asset.tokenProgram],
                },
          recipient: [...entry.recipient],
          ephemeral: [...entry.ephemeral],
          operationId: [...entry.cryptoOperationId],
          memberIndex: entry.memberIndex,
          messageContext: [...entry.derivationContext],
          recipientAmount: entry.recipientAmount.toString(),
        },
        publicKey: [...entry.recipientDestination],
      }
    })
  })
  const script = `
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {openExperimentalRecipientCustody} from './packages/wallet/solana-crypto-backend/runtime.mjs';
    let input=''; for await(const chunk of process.stdin) input+=chunk;
    const cases=JSON.parse(input), wasm=await readFile('./packages/wallet/solana-crypto-backend/generated/backend_bg.wasm');
    globalThis.fetch=()=>{throw Error('Unexpected network')};
    const handles=[];
    try {
      for(const seedByte of [2,3,4]) handles.push(await openExperimentalRecipientCustody({accountId:new Uint8Array(32).fill(seedByte),chainIdentifier:'solana-devnet',seed:new Uint8Array(32).fill(seedByte),wasm}));
      for(const received of cases) {
        const owner=handles.find(handle=>Buffer.from(handle.primaryPublicKey()).equals(Buffer.from(received.descriptor.recipient)));
        assert(owner,'public synthetic recipient fixture must match');
        assert.deepEqual([...owner.validateReceivedDescriptor(received)],received.publicKey);
        const altered=structuredClone(received);
        altered.descriptor.recipientAmount=(BigInt(altered.descriptor.recipientAmount)+1n).toString();
        assert.throws(()=>owner.validateReceivedDescriptor(altered));
      }
      console.log('packaged WASM public native/SPL descriptor interoperability PASS');
    } finally {for(const handle of handles) handle.close()}
  `
  expect(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: resolve(__dirname, '../../../..'),
      input: JSON.stringify(inputs),
      encoding: 'utf8',
      timeout: 30000,
    }),
  ).toContain('interoperability PASS')
}, 35000)
