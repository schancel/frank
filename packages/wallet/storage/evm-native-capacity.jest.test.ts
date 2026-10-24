import { Transaction, Wallet } from 'ethers'
import {
  EvmNativeOperationJournal,
  type EvmNativePlan,
} from './evm-native-operation-journal'

const wallet = new Wallet('0x' + '41'.repeat(32))
const address = wallet.address.toLowerCase()
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'capacity-🧭',
}

function plan(
  kind: EvmNativePlan['kind'],
  members = 1,
  dataBytes = 0,
): EvmNativePlan {
  return {
    kind,
    recipient: address,
    intendedValueWei: String(1000 * members),
    members: Array.from({ length: members }, (_, index) => ({
      source: {
        kind: 'main',
        address:
          members === 1
            ? address
            : '0x' + (index + 1).toString(16).padStart(40, '0'),
      },
      dependencies: [],
      unsignedTransaction: Transaction.from({
        type: 0,
        chainId: 10143,
        nonce: 0,
        to: address,
        value: 1000n,
        gasLimit: 21000n,
        gasPrice: 1n,
        data: '0x' + 'ff'.repeat(dataBytes),
      }).unsignedSerialized,
      ...(kind === 'transaction-set'
        ? {
            transactionSet: {
              role: 'payment' as const,
              logicalIndex: index,
              intendedValueWei: '1000',
              balanceBeforeWei: '22000',
              balanceAfterWei: '0',
            },
          }
        : {}),
    })),
  }
}

it('preserves the established UTF-8 capacity envelope for every operation kind and large payloads', async () => {
  const cases = [
    ['native', plan('native')],
    ['many-native', plan('native', 64)],
    ['legacy', plan('legacy')],
    ['transaction-set', plan('transaction-set')],
    ['contract', plan('contract', 1, 1)],
    ['large-contract', plan('contract', 1, 65400)],
    ...[0, 2000, 4000].map((padding) => {
      const input = plan('contract', 1, 64)
      input.record = {
        kind: 'swap',
        venueId: 'test',
        account: address,
        assetIn: { symbol: 'A', address: null, decimals: 18 },
        amountIn: '1000',
        assetOut: { symbol: 'B', address: null, decimals: 18 },
        quotedAmountOut: '900',
        minimumAmountOut: '800',
        interfaceFeeAmount: '0',
        networkFeeWei: '21000',
        route: { name: '🧭 café 中文\n"', padding: 'x'.repeat(padding) },
      }
      return ['record-' + padding, input] as const
    }),
  ] as const
  const capacities: Record<string, number> = {}
  for (const [name, input] of cases) {
    const journal = new EvmNativeOperationJournal({
      binding,
      testOnlyEphemeral: true,
    })
    await journal.Open()
    try {
      const before = JSON.stringify(input)
      const row = await journal.prepare(input)
      expect(JSON.stringify(input)).toBe(before)
      capacities[name] = row.reservedBytes
      if (row.members.length === 1) {
        const raw = await wallet.signTransaction(
          Transaction.from(row.members[0]!.unsignedTransaction),
        )
        const signed = await journal.checkpointSigned(row.operationId, 0, raw)
        expect(signed.reservedBytes).toBe(row.reservedBytes)
        expect(Buffer.byteLength(JSON.stringify(signed))).toBeLessThanOrEqual(
          row.reservedBytes,
        )
        expect(
          journal.get(row.operationId).members[0]!.signed!.rawTransaction,
        ).toBe(raw)
      }
    } finally {
      await journal.Close()
    }
  }
  // Captured from the prior persisted-envelope implementation; this is a format invariant.
  expect(capacities).toEqual({
    contract: 1634,
    'large-contract': 263248,
    legacy: 1628,
    'many-native': 83154,
    native: 1628,
    'record-0': 2270,
    'record-2000': 4270,
    'record-4000': 6270,
    'transaction-set': 1789,
  })
})
