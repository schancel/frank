import { includedNativeTransfer } from '../../../test/jest/utils/native-operation'
import type { NativeWalletHandle } from '@frank/wallet/chain'
import type {
  EvmNativeOperationStatus,
  NotedSendStatus,
} from '@frank/wallet/chain'
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
        noted: [],
        contactPayments: [],
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

  const sent = (
    txHash: string,
    over: Partial<NotedSendStatus> = {},
  ): NotedSendStatus => ({
    txHash,
    from: '0x' + '01'.repeat(20),
    nonce: 0,
    to: '0x' + '02'.repeat(20),
    valueWei: '10',
    call: false,
    purpose: 'transfer',
    noteIndex: 0,
    notedAtMs: 1000,
    state: 'included',
    inclusion: {
      status: 'success',
      blockNumber: 7,
      blockHash: '0x' + '0b'.repeat(32),
      blockTimeMs: 5000,
      feeWei: '1',
    },
    ...over,
  })
  const operation = (over: Partial<EvmNativeOperationStatus>) =>
    ({
      operationId: 'op',
      chainIdentifier: 'monad-regtest',
      kind: 'transaction-set',
      recipient: '0x' + '02'.repeat(20),
      purpose: 'transfer',
      intendedValueWei: '10',
      payment: 'pending',
      members: [],
      observedFeeWei: '0',
      feeCoverage: 'unknown',
      sharing: 'not-shared',
      ...over,
    } as EvmNativeOperationStatus)

  it("shows another device's sends once per message and purpose, dated by their block, and this device's own once", () => {
    const own = '0x' + 'aa'.repeat(32)
    const groups = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        operations: [
          operation({
            operationId: 'mine',
            payment: 'included',
            members: [
              {
                role: 'payment',
                transactionHash: own,
                state: 'included-success',
              },
            ],
          }),
        ],
        received: [],
        // This device's own send, read back from its own note: shown once, from the journal.
        noted: [
          sent(own),
          // One message's stamp, paid from two coins: one row.
          sent('0x' + 'b1'.repeat(32), {
            purpose: 'stamp',
            noteDigest: 'm1',
            noteIndex: 1,
            to: '0x' + '05'.repeat(20),
            valueWei: '20',
          }),
          sent('0x' + 'b0'.repeat(32), {
            purpose: 'stamp',
            noteDigest: 'm1',
            noteIndex: 0,
            to: '0x' + '04'.repeat(20),
            valueWei: '30',
            inclusion: {
              status: 'success',
              blockNumber: 8,
              blockHash: '0x' + '0c'.repeat(32),
              blockTimeMs: 6000,
              feeWei: '1',
            },
          }),
          // The same message's payment to the contact: its own row.
          sent('0x' + 'c0'.repeat(32), {
            purpose: 'contact-payment',
            noteDigest: 'm1',
            noteIndex: 2,
            valueWei: '500',
          }),
          // Not in a block yet.
          sent('0x' + 'd0'.repeat(32), {
            state: 'pending',
            inclusion: undefined,
            notedAtMs: 9000,
          }),
        ],
        contactPayments: [],
        blockTimes: new Map(),
      },
    })
    const rows = groups.flatMap(group => group.rows)
    expect(rows.filter(row => row.kind === 'native')).toHaveLength(1)
    const noted = rows.flatMap(row => (row.kind === 'noted' ? [row] : []))
    expect(
      noted.map(row => [
        row.purpose,
        row.valueWei,
        row.recipient,
        row.state,
        row.timeMs,
      ]),
    ).toEqual([
      ['transfer', '10', '0x' + '02'.repeat(20), 'pending', 9000],
      ['stamp', '50', '0x' + '04'.repeat(20), 'included', 6000],
      ['contact-payment', '500', '0x' + '02'.repeat(20), 'included', 5000],
    ])
    expect(groups[0]!.id).toBe('pending')
    expect(groups[0]!.rows.map(row => row.kind)).toEqual(['noted'])
  })

  it('shows the coins one message paid as one payment', () => {
    const coin = (address: string, receivedAmountWei: bigint) => ({
      address,
      origin: 'stamp' as const,
      status: 'received' as const,
      amountWei: 0n,
      receivedAmountWei,
      claimedAmountWei: receivedAmountWei,
      spendable: false,
      payloadDigest: 'feed',
      discoveredAtMs: 10,
    })
    const groups = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        operations: [],
        received: [
          coin('0x' + '0a'.repeat(20), 2142n),
          coin('0x' + '0b'.repeat(20), 2858n),
        ],
        noted: [],
        contactPayments: [],
        blockTimes: new Map(),
      },
    })
    const rows = groups.flatMap(group => group.rows)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind === 'received' && row.payment.receivedAmountWei).toBe(5000n)
    expect(row.kind === 'received' && row.payments).toHaveLength(2)
  })

  it("reads a contact payment that ended without paying as the chat's card does", () => {
    const messageId = '0123456789abcdef0123456789abcdef'
    const groups = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        operations: [
          operation({
            purpose: 'contact-payment',
            messageId,
            payment: 'unknown',
          }),
        ],
        received: [],
        noted: [],
        contactPayments: [
          {
            messageId: '01234567-89ab-cdef-0123-456789abcdef',
            state: 'failed',
          },
        ],
        blockTimes: new Map(),
      },
    })
    const row = groups.flatMap(group => group.rows)[0]!
    expect(row.kind === 'native' && row.contactOutcome).toBe('failed')
    expect(groups.map(group => group.id)).toEqual(['activity'])
  })
})
