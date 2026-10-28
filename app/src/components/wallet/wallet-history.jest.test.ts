import { includedNativeTransfer } from '../../../test/jest/utils/native-operation'
import type { NativeWalletHandle } from '@frank/wallet/chain'
import {
  classifyEvmOperation,
  notedSendPurpose,
  type EvmNativeOperationStatus,
  type NotedSendStatus,
} from '@frank/wallet/chain'
import type { EvmExternalDeposit } from '@frank/wallet/chain'
import {
  buildWalletHistoryGroups,
  loadWalletHistory,
  readWalletDeposits,
  mergedCoins,
  type WalletHistoryRow,
} from './wallet-history'

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
        stampStages: [],
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

  it('shows a background merge of coins as one row, "Merged N coins", with its fee, on this device and on another', () => {
    const target = '0x' + '0e'.repeat(20)
    const id = 'consolidate-' + 'ab'.repeat(16)
    const preparation = `evm-transaction-set:${id}`
    const moves = [1, 2, 3].map(n => ({
      role: 'payment' as const,
      account: '0x' + n.toString(16).padStart(2, '0').repeat(20),
      nonce: 0,
      transactionHash: '0x' + n.toString(16).padStart(2, '0').repeat(32),
      state: 'included-success' as const,
      feeWei: '21',
    }))
    const native = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        stampStages: [],
        operations: [
          operation({
            operationId: 'merge',
            purpose: classifyEvmOperation(preparation).purpose,
            recipient: target,
            intendedValueWei: '300',
            payment: 'included',
            members: moves,
          }),
        ],
        received: [],
        noted: [],
        contactPayments: [],
        blockTimes: new Map(),
      },
    }).flatMap(group => group.rows)
    expect(native).toHaveLength(1)
    expect(native[0]!.kind === 'native' && native[0]!.operation.purpose).toBe(
      'consolidation',
    )
    expect(mergedCoins(native[0]!)).toBe(3)
    expect(native[0]!.kind === 'native' && native[0]!.feeWei).toBe('63')
    // Another device reads the same moves from the notes: all to an account of its own, yet one
    // row, not hidden as a move between its accounts.
    const notes = moves.map((move, index) => {
      const facts = { operation: { id: preparation } }
      return sent(move.transactionHash, {
        from: move.account,
        to: target,
        valueWei: '100',
        noteIndex: index,
        ...facts,
        purpose: notedSendPurpose(facts),
        toOwnAccount: true,
        inclusion: {
          status: 'success',
          blockNumber: 9,
          blockHash: '0x' + '0d'.repeat(32),
          blockTimeMs: 9000,
          feeWei: '21',
        },
      })
    })
    const noted = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        stampStages: [],
        operations: [],
        received: [],
        noted: notes,
        contactPayments: [],
        blockTimes: new Map(),
      },
    }).flatMap(group => group.rows)
    expect(noted).toHaveLength(1)
    expect(noted[0]!.kind === 'noted' && noted[0]!.purpose).toBe(
      'consolidation',
    )
    expect(mergedCoins(noted[0]!)).toBe(3)
    expect(noted[0]!.kind === 'noted' && noted[0]!.feeWei).toBe('63')
    // Any other move between the wallet's own accounts is still no row of its own.
    const plain = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        stampStages: [],
        operations: [],
        received: [],
        noted: [sent('0x' + '77'.repeat(32), { toOwnAccount: true })],
        contactPayments: [],
        blockTimes: new Map(),
      },
    }).flatMap(group => group.rows)
    expect(plain).toHaveLength(0)
  })

  it("shows another device's sends once per message, dated by their payment's block, and this device's own once", () => {
    const own = '0x' + 'aa'.repeat(32)
    const groups = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        stampStages: [],
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
            message: { digest: 'm1', item: false },
            noteIndex: 1,
            to: '0x' + '05'.repeat(20),
            valueWei: '20',
          }),
          sent('0x' + 'b0'.repeat(32), {
            purpose: 'stamp',
            message: { digest: 'm1', item: false },
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
          // The same message's payment to the contact: the same row, its stamp a figure of it.
          sent('0x' + 'c0'.repeat(32), {
            purpose: 'contact-payment',
            message: { digest: 'm1', item: true },
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
        row.stampWei,
        row.recipient,
        row.state,
        row.timeMs,
      ]),
    ).toEqual([
      ['transfer', '10', '0', '0x' + '02'.repeat(20), 'pending', 9000],
      [
        'contact-payment',
        '500',
        '50',
        '0x' + '02'.repeat(20),
        'included',
        5000,
      ],
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
        stampStages: [],
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
        stampStages: [],
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

  it('shows one send as one row with the same label, amount and fee on the device that sent it and on another device', () => {
    const MESSAGE = '0123456789abcdef0123456789abcdef'
    const OTHER = 'fedcba9876543210fedcba9876543210'
    const chatPayment = `evm-transaction-set:stealth-${'ab'.repeat(32)}`
    const groupWrite = `evm-transaction-set:group-write-${'cd'.repeat(32)}`
    const contact = '0x' + '0c'.repeat(20)
    const stampTo = '0x' + '0d'.repeat(20)
    const dead = '0x000000000000000000000000000000000000dead'
    const change = '0x' + '0e'.repeat(20)
    const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0')
    const block = {
      blockNumber: 9,
      blockHash: '0x' + '09'.repeat(32),
    }
    /** One transaction of an operation, as the sending device's journal and the chain show it. */
    interface Tx {
      n: number
      account: string
      nonce: number
      to: string
      valueWei: string
      role: 'payment' | 'change'
      operation: { id: string; stage?: string }
      own?: boolean
    }
    const txs: Tx[] = [
      // A payment in a chat, from three coins, with its change and its message's stamp
      // appended as a stage of two coins.
      ...[1, 2, 3].map(
        (n): Tx => ({
          n,
          account: '0x' + n.toString(16).padStart(40, '0'),
          nonce: 0,
          to: contact,
          valueWei: String(n * 100),
          role: 'payment',
          operation: { id: chatPayment },
        }),
      ),
      {
        n: 4,
        account: '0x' + '04'.repeat(20),
        nonce: 0,
        to: change,
        valueWei: '7',
        role: 'change',
        operation: { id: chatPayment },
        own: true,
      },
      ...[5, 6].map(
        (n): Tx => ({
          n,
          account: '0x' + n.toString(16).padStart(40, '0'),
          nonce: 1,
          to: stampTo,
          valueWei: '25',
          role: 'payment',
          operation: { id: chatPayment, stage: `stamp-${MESSAGE}` },
        }),
      ),
      // Creating a group: its write's payment to the burn address.
      {
        n: 7,
        account: '0x' + '07'.repeat(20),
        nonce: 0,
        to: dead,
        valueWei: '1',
        role: 'payment',
        operation: { id: groupWrite },
      },
      // Another message's stamp, which won the race for its coin over the other device.
      {
        n: 8,
        account: '0x' + '08'.repeat(20),
        nonce: 3,
        to: '0x' + '0f'.repeat(20),
        valueWei: '50',
        role: 'payment',
        operation: { id: `evm-transaction-set:stamp-${OTHER}` },
      },
    ]
    // The stamp appended to the chat payment landed a block later than the payment.
    const later = { blockNumber: 10, blockHash: '0x' + '0a'.repeat(32) }
    const blockOf = (tx: Tx) => (tx.operation.stage ? later : block)
    const member = (tx: Tx) => ({
      role: tx.role,
      account: tx.account,
      nonce: tx.nonce,
      ...(tx.operation.stage ? { stageId: tx.operation.stage } : {}),
      transactionHash: hash(tx.n),
      state: 'included-success' as const,
      ...blockOf(tx),
      feeWei: '3',
    })
    const of = (id: string, stage?: string) =>
      txs.filter(tx => tx.operation.id === id && tx.operation.stage === stage)
    // The sending device: its journal's operations, as `loadWalletHistory` summarizes them.
    const sender: EvmNativeOperationStatus[] = [
      operation({
        operationId: 'evm-native-v1:01',
        purpose: 'contact-payment',
        recipient: contact,
        intendedValueWei: '600',
        payment: 'included',
        members: [
          ...of(chatPayment),
          ...of(chatPayment, `stamp-${MESSAGE}`),
        ].map(member),
      }),
      operation({
        operationId: 'evm-native-v1:02',
        purpose: 'group-write',
        recipient: dead,
        intendedValueWei: '1',
        payment: 'included',
        members: of(groupWrite).map(member),
      }),
      operation({
        operationId: 'evm-native-v1:03',
        purpose: 'stamp',
        messageId: OTHER,
        recipient: '0x' + '0f'.repeat(20),
        intendedValueWei: '50',
        payment: 'included',
        members: of(`evm-transaction-set:stamp-${OTHER}`).map(member),
      }),
    ]
    // The other device: the same transactions, read from the notes each one's journal member
    // sent; and its own attempt at the second stamp, whose nonce the sender's took.
    const noted = txs.map(tx => {
      const facts = { operation: tx.operation }
      return sent(hash(tx.n), {
        from: tx.account,
        nonce: tx.nonce,
        to: tx.to,
        valueWei: tx.valueWei,
        ...facts,
        purpose: notedSendPurpose(facts),
        inclusion: {
          status: 'success',
          ...blockOf(tx),
          blockTimeMs: tx.operation.stage ? 7000 : 5000,
          feeWei: '3',
        },
        ...(tx.own ? { toOwnAccount: true } : {}),
      })
    })
    const lost = operation({
      operationId: 'evm-native-v1:01',
      purpose: 'stamp',
      messageId: OTHER,
      recipient: '0x' + '0f'.repeat(20),
      intendedValueWei: '50',
      payment: 'superseded',
      members: [
        {
          role: 'payment',
          account: '0x' + '08'.repeat(20),
          nonce: 3,
          transactionHash: hash(99),
          state: 'superseded',
        },
      ],
    })
    // Its message's stamp, appended to the chat payment's transaction set as a stage.
    const senderStages = [
      {
        of: 'evm-native-v1:01',
        stamp: operation({
          operationId: `evm-native-v1:01:stamp-${MESSAGE}`,
          purpose: 'stamp',
          messageId: MESSAGE,
          recipient: stampTo,
          intendedValueWei: '50',
          payment: 'included',
          members: of(chatPayment, `stamp-${MESSAGE}`).map(member),
        }),
      },
    ]
    const lines = (
      operations: EvmNativeOperationStatus[],
      notes: NotedSendStatus[],
      stampStages: typeof senderStages = [],
    ) =>
      buildWalletHistoryGroups({
        chainIdentifier: 'monad-regtest',
        swaps: [],
        load: {
          status: 'available',
          stampStages,
          operations,
          received: [],
          noted: notes,
          contactPayments: [],
          blockTimes: new Map([
            [block.blockHash, 5000],
            [later.blockHash, 7000],
          ]),
        },
      })
        .flatMap(group => group.rows)
        .flatMap((row: WalletHistoryRow) =>
          row.kind === 'native'
            ? [
                [
                  row.operation.purpose,
                  row.operation.intendedValueWei,
                  row.stampWei,
                  row.feeWei,
                  row.operation.recipient,
                  row.operation.payment,
                  row.timeMs,
                ],
              ]
            : row.kind === 'noted'
            ? [
                [
                  row.purpose,
                  row.valueWei,
                  row.stampWei,
                  row.feeWei,
                  row.recipient,
                  row.state,
                  row.timeMs,
                ],
              ]
            : [],
        )
        .sort((a, b) => String(a).localeCompare(String(b)))
    const onSender = lines(sender, [], senderStages)
    // The chat payment and its message's stamp are one row: the amount paid to the contact,
    // the stamp as its own figure, the fee of every transaction (with the change's).
    expect(onSender).toEqual([
      ['contact-payment', '600', '50', '18', contact, 'included', 5000],
      ['group-write', '1', '0', '3', dead, 'included', 5000],
      ['stamp', '50', '0', '3', '0x' + '0f'.repeat(20), 'included', 5000],
    ])
    // One row per send, the same label, amount and fee; the attempt that lost the race and
    // never landed is no row.
    expect(lines([lost], noted)).toEqual(onSender)
  })

  it('shows Send to Contact and its stamp as one row, the same on the device that sent it and on another, however the notes name its transactions', () => {
    const MESSAGE = '00112233445566778899aabbccddeeff'
    const id = `evm-transaction-set:contact-${MESSAGE}`
    const stage = `stamp-${MESSAGE}`
    const contact = '0x' + '0c'.repeat(20)
    const stampTo = '0x' + '0d'.repeat(20)
    const own = '0x' + '0e'.repeat(20)
    const block = { blockNumber: 9, blockHash: '0x' + '09'.repeat(32) }
    const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0')
    // Gathering the coins into the paying account, the payment, its change, and the message's
    // stamp appended as a stage of two coins.
    const txs = [
      { n: 1, role: 'funding' as const, to: own, valueWei: '300', own: true },
      { n: 2, role: 'payment' as const, to: contact, valueWei: '500' },
      { n: 3, role: 'change' as const, to: own, valueWei: '7', own: true },
      { n: 4, role: 'payment' as const, to: stampTo, valueWei: '25', stage },
      { n: 5, role: 'payment' as const, to: stampTo, valueWei: '25', stage },
    ]
    const member = (tx: (typeof txs)[number]) => ({
      role: tx.role,
      account: '0x' + tx.n.toString(16).padStart(40, '0'),
      nonce: 0,
      ...(tx.stage ? { stageId: tx.stage } : {}),
      transactionHash: hash(tx.n),
      state: 'included-success' as const,
      ...block,
      feeWei: '2',
    })
    const payment = operation({
      operationId: 'evm-native-v1:05',
      purpose: 'contact-payment',
      messageId: MESSAGE,
      recipient: contact,
      intendedValueWei: '500',
      payment: 'included',
      members: txs.map(member),
    })
    const stamp = operation({
      operationId: `evm-native-v1:05:${stage}`,
      purpose: 'stamp',
      messageId: MESSAGE,
      recipient: stampTo,
      intendedValueWei: '50',
      payment: 'included',
      members: txs.filter(tx => tx.stage).map(member),
    })
    // Another device: each transaction's own note names its operation; the message's note to
    // self (before its spends had a note of their own) named the message too.
    const noted = (withMessage: boolean) =>
      txs.map(tx => {
        const facts = {
          operation: { id, ...(tx.stage ? { stage: tx.stage } : {}) },
          ...(withMessage
            ? {
                message: {
                  digest: 'dd',
                  messageId: MESSAGE,
                  item: tx.n === 2,
                },
              }
            : {}),
        }
        return sent(hash(tx.n), {
          from: '0x' + tx.n.toString(16).padStart(40, '0'),
          to: tx.to,
          valueWei: tx.valueWei,
          ...facts,
          purpose: notedSendPurpose(facts),
          inclusion: {
            status: 'success',
            ...block,
            blockTimeMs: 5000,
            feeWei: '2',
          },
          ...(tx.own ? { toOwnAccount: true } : {}),
        })
      })
    const rows = (
      operations: EvmNativeOperationStatus[],
      notes: NotedSendStatus[],
      stampStages: { of: string; stamp: EvmNativeOperationStatus }[] = [],
    ) =>
      buildWalletHistoryGroups({
        chainIdentifier: 'monad-regtest',
        swaps: [],
        load: {
          status: 'available',
          stampStages,
          operations,
          received: [],
          noted: notes,
          contactPayments: [],
          blockTimes: new Map([[block.blockHash, 5000]]),
        },
      })
        .flatMap(group => group.rows)
        .flatMap(row =>
          row.kind === 'native'
            ? [
                [
                  row.operation.purpose,
                  row.operation.intendedValueWei,
                  row.stampWei,
                  row.feeWei,
                  row.operation.recipient,
                  row.timeMs,
                ],
              ]
            : row.kind === 'noted'
            ? [
                [
                  row.purpose,
                  row.valueWei,
                  row.stampWei,
                  row.feeWei,
                  row.recipient,
                  row.timeMs,
                ],
              ]
            : [],
        )
    // 0.5 to the contact, the stamp 0.05 apart from it, the fee of all five transactions.
    const expected = [['contact-payment', '500', '50', '10', contact, 5000]]
    expect(rows([payment], [], [{ of: payment.operationId, stamp }])).toEqual(
      expected,
    )
    expect(rows([], noted(true))).toEqual(expected)
    expect(rows([], noted(false))).toEqual(expected)
    // The stamp paid again in an operation of its own (its first coin taken) is still the
    // message's stamp, in the same row.
    const repaid = operation({
      ...stamp,
      operationId: 'evm-native-v1:06',
    })
    expect(rows([payment, repaid], [])).toEqual(expected)
  })
})

describe('deposits from outside Frank', () => {
  const deposit = (
    txHash: string,
    blockTimeMs: number,
    chainIdentifier = 'monad-regtest',
  ): EvmExternalDeposit => ({
    id: `${txHash}:native`,
    chainIdentifier,
    txHash,
    to: '0x' + '01'.repeat(20),
    from: '0x' + '09'.repeat(20),
    asset: { kind: 'native' },
    amount: '20000000000000000000',
    blockNumber: 7,
    blockHash: '0x' + 'ab'.repeat(32),
    blockTimeMs,
  })

  it('loads what the scan found on this network, and reads the chain only when asked', async () => {
    const refreshExternalDeposits = jest.fn(async () => undefined)
    const wallet = {
      family: 'evm',
      chainIdentifier: 'monad-regtest',
      getNativeOperations: () => [],
      refreshExternalDeposits,
      getExternalDeposits: () => [
        deposit('0x' + 'a1'.repeat(32), 1000),
        deposit('0x' + 'a2'.repeat(32), 2000, 'monad-testnet'),
      ],
    } as unknown as NativeWalletHandle
    const load = await loadWalletHistory(wallet, 'monad-regtest')
    expect(refreshExternalDeposits).not.toHaveBeenCalled()
    expect(
      load.status === 'available' && load.deposits?.map(row => row.txHash),
    ).toEqual(['0x' + 'a1'.repeat(32)])
    expect(load.status === 'available' && load.depositsUnread).toBe(false)
    expect(await readWalletDeposits(wallet, 'monad-regtest')).toBe(true)
    expect(refreshExternalDeposits).toHaveBeenCalledTimes(1)
    // A node that does not answer: History says so, and keeps what was found.
    refreshExternalDeposits.mockRejectedValueOnce(new Error('node down'))
    expect(await readWalletDeposits(wallet, 'monad-regtest')).toBe(false)
    const unread = await loadWalletHistory(wallet, 'monad-regtest', {
      depositsUnread: true,
    })
    expect(unread.status === 'available' && unread.depositsUnread).toBe(true)
    expect(unread.status === 'available' && unread.deposits).toHaveLength(1)
    // Another network's wallet is never read for this one.
    expect(await readWalletDeposits(wallet, 'monad-testnet')).toBe(true)
    expect(refreshExternalDeposits).toHaveBeenCalledTimes(2)
  })

  it('shows each deposit once, dated by its block, and not a transfer a send or a received coin already shows', () => {
    const outside = deposit('0x' + 'c1'.repeat(32), 5000)
    const alsoNoted = deposit('0x' + 'c2'.repeat(32), 6000)
    const alsoCoin = deposit('0x' + 'c3'.repeat(32), 7000)
    const groups = buildWalletHistoryGroups({
      chainIdentifier: 'monad-regtest',
      swaps: [],
      load: {
        status: 'available',
        operations: [],
        stampStages: [],
        received: [
          {
            address: '0x' + '05'.repeat(20),
            origin: 'stealth',
            status: 'received',
            amountWei: 1n,
            receivedAmountWei: 1n,
            claimedAmountWei: 1n,
            settledTransactions: ['c3'.repeat(32)],
            spendable: true,
            discoveredAtMs: 100,
          },
        ],
        noted: [
          {
            txHash: alsoNoted.txHash,
            from: '0x' + '01'.repeat(20),
            nonce: 0,
            to: '0x' + '01'.repeat(20),
            valueWei: '1',
            call: false,
            purpose: 'transfer',
            noteIndex: 0,
            notedAtMs: 1,
            state: 'included',
          } as NotedSendStatus,
        ],
        contactPayments: [],
        blockTimes: new Map(),
        deposits: [outside, alsoNoted, alsoCoin, outside],
      },
    })
    const rows = groups.flatMap(group => group.rows)
    const deposits = rows.flatMap(row => (row.kind === 'deposit' ? [row] : []))
    expect(deposits.map(row => [row.id, row.timeMs])).toEqual([
      [`deposit:${outside.id}`, 5000],
    ])
    // Read from a block: finished, not pending.
    expect(
      groups.find(group => group.id === 'pending')?.rows ?? [],
    ).not.toContainEqual(expect.objectContaining({ kind: 'deposit' }))
  })
})

it('deduplicates a stamp recovery by its actual receipt without claiming the original was settled', () => {
  const txHash = '0x' + 'ac'.repeat(32)
  const receipt = { chainIdentifier: 'monad-testnet', txHash, from: '0x' + '01'.repeat(20), to: '0x' + '02'.repeat(20), amount: '30', blockNumber: 2, blockHash: '0x' + '03'.repeat(32), blockTimeMs: 2000 }
  const groups = buildWalletHistoryGroups({ chainIdentifier: 'monad-testnet', swaps: [], load: {
    status: 'available', operations: [], stampStages: [], noted: [], contactPayments: [], blockTimes: new Map(),
    received: [{ address: receipt.to, origin: 'stamp', status: 'received', amountWei: 30n, receivedAmountWei: 30n,
      claimedAmountWei: 100n, partial: true, spendable: true, discoveredAtMs: 1, transactions: ['ab'.repeat(32)],
      nativeStampRecovery: { chainIdentifier: 'monad-testnet', originalTransactionHash: '0x' + 'ab'.repeat(32),
        supersededAt: { blockNumber: 1, blockHash: receipt.blockHash }, receipts: [receipt] } }],
    deposits: [{ ...receipt, id: `${txHash}:native`, asset: { kind: 'native' } }],
  } })
  const rows = groups.flatMap(group => group.rows)
  expect(rows.filter(row => row.kind === 'deposit')).toEqual([])
  expect(rows.filter(row => row.kind === 'received')).toHaveLength(1)
  const row = rows.find(row => row.kind === 'received')!
  expect(row.kind === 'received' && row.payment.settledTransactions).toBeUndefined()
  expect(row.kind === 'received' && row.payment.receivedAmountWei).toBe(30n)
})
