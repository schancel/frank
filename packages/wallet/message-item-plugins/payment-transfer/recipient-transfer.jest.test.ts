import type { RecipientPaymentTransfer } from '@frank/cashweb/types/messages'
import { encodePaymentTransfer } from '@frank/codec'
import {
  decodeRecipientPaymentTransfer,
  encodeRecipientPaymentTransfer,
} from './recipient-transfer'

const sample: RecipientPaymentTransfer = {
  chainIdentifier: 'monad-testnet',
  txId: 'ab'.repeat(32),
  destination: 'cd'.repeat(20),
  amountAtomic:
    '1234567890123456789012345678901234567890123456789012345678901234',
  asset: { kind: 'token', identifier: 'ef'.repeat(20) },
  stealthMetadata: {
    keyType: 1,
    ephemeralPubKey: `02${'11'.repeat(32)}`,
    viewTag: 12,
  },
  commitment: '22'.repeat(32),
  rawTx: 'aabb',
}

it('round trips a 64-digit DECIMAL amount, token, key and signed bytes exactly', () => {
  expect(
    decodeRecipientPaymentTransfer(encodeRecipientPaymentTransfer(sample))
  ).toEqual(sample)
})

it.each([
  '1',
  '9007199254740993',
  '18446744073709551615',
  '18446744073709551616',
  ((1n << 256n) - 1n).toString(),
])(
  'retains exact native atomic units %s across uint64/256-bit encodings',
  (amountAtomic) => {
    const transfer = {
      ...sample,
      amountAtomic,
      asset: { kind: 'native' as const },
    }
    expect(
      decodeRecipientPaymentTransfer(encodeRecipientPaymentTransfer(transfer))
    ).toEqual(transfer)
  }
)

it.each(['0', '-1', '1.5', '01', '1e18', (1n << 256n).toString()])(
  'rejects invalid or oversized amounts %s',
  (amountAtomic) => {
    expect(() =>
      encodeRecipientPaymentTransfer({ ...sample, amountAtomic })
    ).toThrow()
  }
)

it.each(['monad', 'MONT', 'eip155:10143', 'ecash-testnet', 'unknown-chain'])(
  'rejects a noncanonical or unknown internal chain %s',
  (chainIdentifier) => {
    expect(() =>
      encodeRecipientPaymentTransfer({ ...sample, chainIdentifier })
    ).toThrow()
  }
)

it.each([
  ['xec-testnet', 'XECT'],
  ['btc-testnet', 'BTCT'],
  ['bch-mainnet', 'BCH1'],
])('preserves native UTXO output identity for %s', (chainIdentifier) => {
  const transfer = {
    ...sample,
    chainIdentifier,
    vout: 7,
    asset: { kind: 'native' as const },
  }
  expect(
    decodeRecipientPaymentTransfer(encodeRecipientPaymentTransfer(transfer))
  ).toEqual(transfer)
})

it('preserves SPL mint bytes without claiming token-program identity', () => {
  const transfer: RecipientPaymentTransfer = {
    ...sample,
    chainIdentifier: 'solana-devnet',
    txId: 'ab'.repeat(64),
    destination: 'cd'.repeat(32),
    asset: { kind: 'token', identifier: 'ef'.repeat(32) },
    stealthMetadata: {
      keyType: 2,
      ephemeralPubKey: '11'.repeat(32),
      viewTag: '0c',
    },
  }
  expect(
    decodeRecipientPaymentTransfer(encodeRecipientPaymentTransfer(transfer))
  ).toEqual(transfer)
})

it('rejects token bytes on Bitcoin-family chains and wrong EVM token lengths', () => {
  expect(() =>
    encodeRecipientPaymentTransfer({
      ...sample,
      chainIdentifier: 'xec-testnet',
    })
  ).toThrow('Unsupported Bitcoin-family token')
  expect(() =>
    encodeRecipientPaymentTransfer({
      ...sample,
      asset: { kind: 'token', identifier: 'aa' },
    })
  ).toThrow('token identifier length')
})

it('rejects unknown networks, missing metadata and incompatible keys on input', () => {
  const record = {
    networkTag: 'MONT',
    txId: sample.txId,
    destination: sample.destination,
    value: 1n,
    stealthMetadata: sample.stealthMetadata,
  }
  expect(() =>
    decodeRecipientPaymentTransfer(
      encodePaymentTransfer({ ...record, networkTag: 'NOPE' })
    )
  ).toThrow('Unsupported payment network')
  expect(() =>
    decodeRecipientPaymentTransfer(
      encodePaymentTransfer({ ...record, stealthMetadata: undefined })
    )
  ).toThrow('stealth key')
  expect(() =>
    decodeRecipientPaymentTransfer(
      encodePaymentTransfer({
        ...record,
        stealthMetadata: { keyType: 2, ephemeralPubKey: 'aa'.repeat(32) },
      })
    )
  ).toThrow('stealth key')
  expect(() => decodeRecipientPaymentTransfer(new Uint8Array([0]))).toThrow()
})

it('returns a recipient claim without outgoing wallet-sync mutation fields', () => {
  const recipient = decodeRecipientPaymentTransfer(
    encodeRecipientPaymentTransfer(sample)
  )
  expect(Object.keys(recipient)).not.toEqual(
    expect.arrayContaining([
      'type',
      'direction',
      'spentInputs',
      'createdOutputs',
    ])
  )
  expect(recipient).not.toHaveProperty('type')
  expect(recipient).not.toHaveProperty('direction')
})

it('rejects unknown asset discriminants instead of defaulting to native', () => {
  expect(() =>
    encodeRecipientPaymentTransfer({
      ...sample,
      asset: { kind: 'unknown' },
    } as unknown as RecipientPaymentTransfer)
  ).toThrow('Unsupported recipient payment asset')
})
