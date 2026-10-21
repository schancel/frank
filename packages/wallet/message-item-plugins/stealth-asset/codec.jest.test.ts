import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import {
  encodeFrame,
  encodePluginMessageItem,
  encodeStealthMessageItem,
  standaloneItemBudget,
  validateFrame,
  type Encodable,
} from '@frank/codec'
import { createDefaultMessageItemRegistry } from '../default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/cashweb/message-items/registry'
import { decodeItemFrames, encodeItemFrames } from '../wire'
import {
  decodeRecipientAssetPaymentItem,
  encodeRecipientAssetPaymentItem,
} from './codec'

const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable
)
const sample: RecipientAssetPaymentItem = {
  type: 'stealth-asset',
  memo: 'recipient amount excludes stamp and fees',
  transfers: [
    {
      chainIdentifier: 'monad-testnet',
      txId: 'ab'.repeat(32),
      destination: 'cd'.repeat(20),
      amountAtomic:
        '1234567890123456789012345678901234567890123456789012345678901234',
      asset: { kind: 'token', identifier: 'ef'.repeat(20) },
      stealthMetadata: {
        keyType: 1,
        ephemeralPubKey: `02${'11'.repeat(32)}`,
        viewTag: 7,
      },
      rawTx: '010203',
      commitment: '22'.repeat(32),
      derivationScheme: 1,
      recipientSpendKey: { keyType: 1, publicKey: `03${'33'.repeat(32)}` },
    },
  ],
}

function children(frames: Uint8Array[]) {
  const revision = validateFrame(
    encodeFrame(
      { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, frames],
      ])
    )
  )
  if (revision.kind !== 'parsed' || revision.typed?.type !== 8)
    throw new Error('Expected revision')
  return revision.typed.items
}

it('round trips exact recipient amounts through composed dedicated-frame messaging', () => {
  const frames = encodeItemFrames(registry, [sample])
  const parsed = validateFrame(frames[0])
  expect(
    parsed.kind === 'parsed' && [parsed.typeId, parsed.schemaVersion]
  ).toEqual([19, 2])
  expect(
    decodeItemFrames(registry, children(frames), standaloneItemBudget())
  ).toEqual([sample])
  expect(registry.tallyValue([sample])).toBe(0)
})

it('keeps legacy native and schema-2 payments distinct in one revision', () => {
  const native = encodeStealthMessageItem({
    type: 'stealth',
    networkTag: 'MONT',
    keyType: 1,
    ephemeralPubKey: `02${'11'.repeat(32)}`,
    transactions: ['010203'],
    amount: 7n,
  })
  const items = decodeItemFrames(
    registry,
    children([native, encodeRecipientAssetPaymentItem(sample)]),
    standaloneItemBudget()
  )
  expect(items.map((item) => item.type)).toEqual(['stealth', 'stealth-asset'])
})

it('preserves unknown positive schemes, SPL program and context without invoking capabilities', async () => {
  const item: RecipientAssetPaymentItem = {
    ...sample,
    transfers: [
      {
        ...sample.transfers[0],
        chainIdentifier: 'solana-devnet',
        txId: 'ab'.repeat(64),
        destination: 'cd'.repeat(32),
        asset: { kind: 'token', identifier: 'ef'.repeat(32) },
        derivationScheme: 4294967295,
        stealthMetadata: {
          keyType: 2,
          ephemeralPubKey: '11'.repeat(32),
          viewTag: '0c',
        },
        recipientSpendKey: { keyType: 2, publicKey: '33'.repeat(32) },
        tokenProgram: '44'.repeat(32),
        derivationContext: '010203',
      },
    ],
  }
  // The installed placeholder capabilities throw if called. Pure decoding and hydration work.
  const received = decodeItemFrames(
    registry,
    children(encodeItemFrames(registry, [item])),
    standaloneItemBudget()
  )
  expect(received).toEqual([item])
  expect(
    await registry
      .get('stealth-asset')!
      .hydrate(received[0] as never, {} as never)
  ).toEqual(item)
})

it('preserves UTXO output identity and exact native amount', () => {
  const item: RecipientAssetPaymentItem = {
    ...sample,
    transfers: [
      {
        ...sample.transfers[0],
        chainIdentifier: 'xec-testnet',
        asset: { kind: 'native' },
        vout: 9,
        amountAtomic: '9007199254740993',
      },
    ],
  }
  expect(
    decodeItemFrames(
      registry,
      children(encodeItemFrames(registry, [item])),
      standaloneItemBudget()
    )
  ).toEqual([item])
})

it('uses already validated children without reopening frames or resetting a budget', () => {
  const parsed = validateFrame(encodeRecipientAssetPaymentItem(sample))
  if (parsed.kind !== 'parsed') throw new Error('Expected parsed frame')
  const budget = {
    openFrame: jest.fn(() => {
      throw new Error('must not reopen')
    }),
    decodeCbor: jest.fn(() => {
      throw new Error('must not reparse')
    }),
  }
  expect(
    decodeRecipientAssetPaymentItem(parsed.frame, { frame: parsed, budget })
  ).toEqual(sample)
  expect(budget.openFrame).not.toHaveBeenCalled()
  expect(budget.decodeCbor).not.toHaveBeenCalled()
})

it('rejects a schema-2 item hidden in generic type 27', () => {
  const wrapped = encodePluginMessageItem({
    itemType: 'stealth-asset',
    data: encodeRecipientAssetPaymentItem(sample),
  })
  expect(
    decodeItemFrames(registry, children([wrapped]), standaloneItemBudget())[0]
  ).toMatchObject({
    type: 'unsupported',
    reason: 'malformed',
    itemType: 'stealth-asset',
  })
})

it.each(['ecash-testnet', 'MONT', 'unknown-chain'])(
  'rejects noncanonical chain %s before sending',
  (chainIdentifier) => {
    expect(() =>
      encodeItemFrames(registry, [
        { ...sample, transfers: [{ ...sample.transfers[0], chainIdentifier }] },
      ])
    ).toThrow()
  }
)

it('rejects zero schemes and malformed exact amounts', () => {
  expect(() =>
    encodeRecipientAssetPaymentItem({
      ...sample,
      transfers: [{ ...sample.transfers[0], derivationScheme: 0 }],
    })
  ).toThrow()
  expect(() =>
    encodeRecipientAssetPaymentItem({
      ...sample,
      transfers: [{ ...sample.transfers[0], amountAtomic: '01' }],
    })
  ).toThrow()
})

it('round trips allocated key type 3 under an unknown scheme without claiming execution', async () => {
  const item: RecipientAssetPaymentItem = {
    ...sample,
    transfers: [
      {
        ...sample.transfers[0],
        derivationScheme: 4294967295,
        recipientSpendKey: { keyType: 3, publicKey: '33'.repeat(32) },
        stealthMetadata: { keyType: 3, ephemeralPubKey: '11'.repeat(32) },
      },
    ],
  }
  const frames = encodeItemFrames(registry, [item])
  const received = decodeItemFrames(
    registry,
    children(frames),
    standaloneItemBudget()
  )
  expect(received).toEqual([item])
  expect(
    await registry
      .get('stealth-asset')!
      .hydrate(received[0] as never, {} as never)
  ).toEqual(item)
  expect(() =>
    encodeRecipientAssetPaymentItem({
      ...item,
      transfers: [{ ...item.transfers[0], derivationScheme: 1 }],
    })
  ).toThrow('requires secp keys')
})
