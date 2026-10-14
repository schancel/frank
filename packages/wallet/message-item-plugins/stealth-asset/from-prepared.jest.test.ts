import { standaloneItemBudget, validateFrame } from '@frank/codec'
import type { PreparedStealthPayment } from '../../stealth-payment'
import { createDefaultMessageItemRegistry } from '../default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../registry'
import { decodeItemFrames, encodeItemFrames } from '../wire'
import { recipientAssetPaymentFromPrepared } from './from-prepared'

const originalRecipient = Uint8Array.from([3, ...new Array(32).fill(7)])
const ephemeral = Uint8Array.from([2, ...new Array(32).fill(8)])
const maxQuantity = (1n << 256n) - 1n
function prepared(): PreparedStealthPayment {
  return {
    operationId: 'operation',
    chainIdentifier: 'monad-testnet',
    asset: { kind: 'erc20', contractAddress: `0X${'AB'.repeat(20)}` },
    amountAtomic: maxQuantity,
    recipientAddress:
      'public family address is not the published spend identity',
    recipientDestination: new Uint8Array(20).fill(9),
    recipientSpendPublicKey: originalRecipient,
    ephemeralPublicKey: ephemeral,
    members: [
      {
        rawTransaction: '0X0102AB',
        txHash: `0x${'CD'.repeat(32)}`,
        recipientAmountAtomic: maxQuantity - 1n,
      },
      {
        rawTransaction: '0304ef',
        txHash: 'ef'.repeat(32),
        recipientAmountAtomic: 1n,
      },
    ],
  }
}
const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)
function roundTrip(item: ReturnType<typeof recipientAssetPaymentFromPrepared>) {
  const frames = encodeItemFrames(registry, [item])
  const children = frames.map(bytes => {
    const parsed = validateFrame(bytes)
    if (parsed.kind !== 'parsed') throw new Error('Expected parsed child')
    expect([parsed.typeId, parsed.schemaVersion]).toEqual([24, 2])
    return parsed
  })
  expect(decodeItemFrames(registry, children, standaloneItemBudget())).toEqual([
    item,
  ])
  return item
}

it('projects independent signed members with exact uint256 sum and original recipient binding through the composed codec', () => {
  const item = roundTrip(
    recipientAssetPaymentFromPrepared(
      prepared(),
      'fees and stamp are separate',
    ),
  )
  expect(item.memo).toBe('fees and stamp are separate')
  expect(item.transfers.map(t => t.amountAtomic)).toEqual([
    (maxQuantity - 1n).toString(),
    '1',
  ])
  expect(item.transfers.map(t => t.rawTx)).toEqual(['0102ab', '0304ef'])
  expect(item.transfers[0]).toMatchObject({
    chainIdentifier: 'monad-testnet',
    txId: 'cd'.repeat(32),
    destination: '09'.repeat(20),
    asset: { kind: 'token', identifier: 'ab'.repeat(20) },
    derivationScheme: 1,
    recipientSpendKey: { keyType: 1, publicKey: `03${'07'.repeat(32)}` },
    stealthMetadata: { keyType: 1, ephemeralPubKey: `02${'08'.repeat(32)}` },
  })
  expect(registry.tallyValue([item])).toBe(0)
  expect(item).not.toHaveProperty('operationId')
  expect(item).not.toHaveProperty('recipientAddress')
})

it.each(['btc-testnet', 'bch-testnet', 'xec-testnet'])(
  'preserves %s locking script and output indices for native members',
  chainIdentifier => {
    const p: PreparedStealthPayment = {
      ...prepared(),
      chainIdentifier,
      asset: { kind: 'native' },
      amountAtomic: 3n,
      recipientDestination: Uint8Array.from([
        0x76,
        0xa9,
        0x14,
        ...new Array(20).fill(5),
        0x88,
        0xac,
      ]),
      members: prepared().members.map((member, i) => ({
        ...member,
        recipientAmountAtomic: BigInt(i + 1),
        vout: i,
      })),
    }
    const item = roundTrip(recipientAssetPaymentFromPrepared(p))
    expect(item.transfers.map(t => t.vout)).toEqual([0, 1])
    expect(item.transfers[0].destination).toBe(`76a914${'05'.repeat(20)}88ac`)
    expect(item.transfers[0].asset).toEqual({ kind: 'native' })
    expect(item).not.toHaveProperty('memo')
  },
)

it('projects native EVM payment without token metadata', () => {
  const item = roundTrip(
    recipientAssetPaymentFromPrepared({
      ...prepared(),
      asset: { kind: 'native' },
    }),
  )
  expect(
    item.transfers.every(
      t => t.asset.kind === 'native' && !('tokenProgram' in t),
    ),
  ).toBe(true)
})

it('rejects mismatched manifests, nonpositive members and quantities outside uint256', () => {
  const p = prepared()
  for (const invalid of [
    { ...p, amountAtomic: maxQuantity - 1n },
    { ...p, amountAtomic: 0n },
    { ...p, amountAtomic: 1n << 256n },
    { ...p, members: [{ ...p.members[0], recipientAmountAtomic: 0n }] },
    { ...p, members: [{ ...p.members[0], recipientAmountAtomic: -1n }] },
    { ...p, members: [{ ...p.members[0], recipientAmountAtomic: 1n << 256n }] },
    { ...p, members: [] },
    { ...p, members: new Array(17).fill(p.members[0]) },
  ])
    expect(() => recipientAssetPaymentFromPrepared(invalid)).toThrow()
})

it('rejects aliases, unknown chains, incompatible assets and invalid public destinations/keys', () => {
  const p = prepared()
  for (const invalid of [
    { ...p, chainIdentifier: 'ecash-testnet' },
    { ...p, chainIdentifier: 'evm' },
    { ...p, chainIdentifier: 'solana-devnet' },
    { ...p, chainIdentifier: 'xec-testnet' },
    {
      ...p,
      asset: { kind: 'erc20' as const, contractAddress: 'ab'.repeat(19) },
    },
    { ...p, recipientDestination: new Uint8Array(21) },
    { ...p, recipientSpendPublicKey: new Uint8Array(33).fill(4) },
    { ...p, ephemeralPublicKey: new Uint8Array(32) },
  ])
    expect(() => recipientAssetPaymentFromPrepared(invalid)).toThrow()
})

it('rejects missing or malformed signed bytes, hashes and family-incompatible output indices', () => {
  const p = prepared()
  for (const member of [
    { ...p.members[0], rawTransaction: '' },
    { ...p.members[0], rawTransaction: '0xabc' },
    { ...p.members[0], rawTransaction: '0x010x02' },
    { ...p.members[0], rawTransaction: ' 0102' },
    { ...p.members[0], txHash: '0x' },
    { ...p.members[0], txHash: 'ab'.repeat(31) },
    { ...p.members[0], vout: 0 },
  ])
    expect(() =>
      recipientAssetPaymentFromPrepared({ ...p, members: [member] }),
    ).toThrow()
  for (const vout of [undefined, -1, 0.5, 0x100000000]) {
    expect(() =>
      recipientAssetPaymentFromPrepared({
        ...p,
        chainIdentifier: 'btc-testnet',
        asset: { kind: 'native' },
        members: [{ ...p.members[0], vout }],
      }),
    ).toThrow()
  }
})

it('captures public bytes as immutable values and leaves prepared operation material unchanged', () => {
  const p = prepared()
  const snapshot = structuredClone(p)
  const item = recipientAssetPaymentFromPrepared(p)
  expect(p).toEqual(snapshot)
  p.recipientDestination.fill(1)
  expect(item.transfers[0].destination).toBe('09'.repeat(20))
})
