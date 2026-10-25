import { includedNativeTransfer } from '../../../test/jest/utils/native-operation'
import type { NativeWalletHandle } from '@frank/wallet/chain'
import { buildWalletHistoryGroups, loadWalletHistory } from './wallet-history'

describe('loadWalletHistory', () => {
  it('reads active and every page of completed history, once each, without effects', async () => {
    const fixture = await includedNativeTransfer()
    try {
      const [row] = fixture.journal.list()
      const later = { ...row!, operationId: 'evm-native-v1:00000000000000ff' }
      const pages = [
        { operations: [row!], next: row!.operationId },
        { operations: [later] },
      ]
      const getNativeOperationHistory = jest.fn(
        async ({ after }: { after?: string }) => pages[after ? 1 : 0]!,
      )
      const wallet = {
        family: 'evm',
        chainIdentifier: 'monad-testnet',
        // The same operation still active and already archived is one row.
        getNativeOperations: () => [row!],
        getNativeOperationHistory,
        readBlockTimes: async () => {
          throw new Error('node down')
        },
      } as unknown as NativeWalletHandle
      const load = await loadWalletHistory(wallet, 'monad-testnet')
      expect(load.status).toBe('available')
      if (load.status !== 'available') return
      expect(load.operations.map(op => op.operationId)).toEqual([
        row!.operationId,
        later.operationId,
      ])
      expect(getNativeOperationHistory).toHaveBeenNthCalledWith(2, {
        after: row!.operationId,
        limit: 100,
      })
      // An unreadable block leaves the send undated, not the history unavailable.
      expect(load.blockTimes.size).toBe(0)
      expect(load.received).toEqual([])
    } finally {
      await fixture.close()
    }
  })

  it('never shows another network or family as this network history', async () => {
    const evm = {
      family: 'evm',
      chainIdentifier: 'monad-regtest',
      getNativeOperations: () => [],
    } as unknown as NativeWalletHandle
    expect(await loadWalletHistory(evm, 'monad-testnet')).toEqual({
      status: 'unavailable',
    })
    expect(
      await loadWalletHistory(
        { family: 'solana', chainIdentifier: 'solana-devnet' } as never,
        'solana-devnet',
      ),
    ).toEqual({ status: 'unsupported' })
  })
})

describe('buildWalletHistoryGroups', () => {
  it('pins pending received payments and orders the rest newest first', () => {
    const payment = (
      address: string,
      status: 'pending' | 'received',
      at: number,
    ) => ({
      address,
      origin: 'stealth' as const,
      status,
      amountWei: 1n,
      claimedAmountWei: 1n,
      spendable: false,
      discoveredAtMs: at,
    })
    const groups = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        operations: [],
        blockTimes: new Map(),
        received: [
          payment('a', 'received', 1),
          payment('b', 'pending', 5),
          payment('c', 'received', 3),
        ],
      },
    })
    expect(groups.map(g => [g.id, g.rows.map(r => r.id)])).toEqual([
      ['pending', ['received:b']],
      ['activity', ['received:c', 'received:a']],
    ])
  })
})
