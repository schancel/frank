/** @jest-environment jsdom */
import { enableAutoUnmount, shallowMount } from '@vue/test-utils'
import type {
  EvmNativeOperationStatus,
  NotedSendStatus,
} from '@frank/wallet/chain'
import {
  buildWalletHistoryGroups,
  type WalletHistoryLoad,
  type WalletHistoryRow,
} from './wallet-history'
import History from './WalletHistory.vue'

enableAutoUnmount(afterEach)

type Load = Extract<WalletHistoryLoad, { status: 'available' }>
type Member = EvmNativeOperationStatus['members'][number]
const hash = (digit: string) => '0x' + digit.repeat(64)
const primaryHash = hash('a')
const blockHash = hash('b')
const recipient = '0x' + '12'.repeat(20)

function member(over: Partial<Member> = {}): Member {
  return {
    role: 'payment',
    account: '0x' + '34'.repeat(20),
    nonce: 0,
    transactionHash: primaryHash,
    submitted: true,
    state: 'included-success',
    blockNumber: 30,
    blockHash,
    feeWei: '6426000000000000',
    ...over,
  }
}

function operation(
  members: readonly Member[] = [member()],
): EvmNativeOperationStatus {
  return {
    operationId: 'return',
    chainIdentifier: 'monad-regtest',
    kind: 'transaction-set',
    recipient,
    purpose: 'transfer',
    intendedValueWei: '243574000000000000',
    payment: 'included',
    members,
    observedFeeWei: '6426000000000000',
    feeCoverage: 'complete',
    sharing: 'shared',
  }
}

const canonicalInclusion: NonNullable<NotedSendStatus['inclusion']> = {
  status: 'success',
  blockNumber: 30,
  blockHash,
  blockTimeMs: 3000,
  feeWei: '6426000000000000',
}

function note(over: Partial<NotedSendStatus> = {}): NotedSendStatus {
  return {
    txHash: primaryHash,
    from: member().account,
    nonce: 0,
    to: recipient,
    valueWei: '243574000000000000',
    call: false,
    purpose: 'transfer',
    operation: { id: 'evm-transaction-set:legacy-return' },
    noteIndex: 0,
    notedAtMs: 9000,
    state: 'included',
    inclusion: { ...canonicalInclusion },
    ...over,
  }
}

function load(over: Partial<Load> = {}): Load {
  return {
    status: 'available',
    operations: [operation()],
    stampStages: [],
    noted: [note()],
    received: [1000, 2000].map((discoveredAtMs, index) => ({
      address: 'received-' + index,
      origin: 'stealth',
      status: 'received',
      amountWei: 1n,
      claimedAmountWei: 1n,
      receivedAmountWei: 1n,
      spendable: false,
      discoveredAtMs,
    })),
    contactPayments: [],
    blockTimes: new Map(),
    ...over,
  }
}

const groups = (input: Load) =>
  buildWalletHistoryGroups({
    chainIdentifier: 'monad-regtest',
    load: input,
    swaps: [],
  })
const rows = (input: Load): WalletHistoryRow[] =>
  groups(input).flatMap(group => group.rows)
function native(input: Load) {
  const row = rows(input).find(row => row.kind === 'native')
  if (!row || row.kind !== 'native')
    throw new Error('Expected the native financial owner')
  return row
}

describe('retained canonical native History dates', () => {
  it('dates and orders the native return like its noted view after historical block reads are unavailable', () => {
    const input = load()
    const own = rows(input)
    const other = rows(load({ operations: [] }))
    expect(own.map(row => [row.kind, row.timeMs])).toEqual([
      ['native', 3000],
      ['received', 2000],
      ['received', 1000],
    ])
    expect(other.map(row => [row.kind, row.timeMs])).toEqual([
      ['noted', 3000],
      ['received', 2000],
      ['received', 1000],
    ])
    expect(own[0]?.id).not.toBe(other[0]?.id)
    expect(own.filter(row => row.kind === 'noted')).toEqual([])
  })

  it('keeps the current block-time map authoritative', () => {
    expect(
      native(load({ blockTimes: new Map([[blockHash, 4000]]) })).timeMs,
    ).toBe(4000)
  })

  it.each([
    ['transaction hash', () => note({ txHash: hash('c') })],
    [
      'block hash',
      () =>
        note({ inclusion: { ...canonicalInclusion, blockHash: hash('c') } }),
    ],
    [
      'block height',
      () => note({ inclusion: { ...canonicalInclusion, blockNumber: 31 } }),
    ],
    [
      'inclusion outcome',
      () =>
        note({
          state: 'reverted',
          inclusion: { ...canonicalInclusion, status: 'revert' },
        }),
    ],
    ['pending note', () => note({ state: 'pending' })],
    ['unknown note', () => note({ state: 'unknown' })],
    [
      'inconsistent note outcome',
      () => note({ inclusion: { ...canonicalInclusion, status: 'revert' } }),
    ],
  ] as const)(
    'rejects mismatched or unconfirmed %s evidence',
    (_name, changed) => {
      expect(native(load({ noted: [changed()] })).timeMs).toBeUndefined()
    },
  )

  it.each([0, -1, NaN, Infinity, -Infinity])(
    'rejects retained timestamp %s',
    blockTimeMs => {
      expect(
        native(
          load({
            noted: [
              note({ inclusion: { ...canonicalInclusion, blockTimeMs } }),
            ],
          }),
        ).timeMs,
      ).toBeUndefined()
    },
  )

  it('requires a confirmed native member with matching success/revert status', () => {
    for (const state of ['pending', 'unknown'] as const)
      expect(
        native(load({ operations: [operation([member({ state })])] })).timeMs,
      ).toBeUndefined()
    expect(
      native(
        load({
          operations: [operation([member({ state: 'included-revert' })])],
        }),
      ).timeMs,
    ).toBeUndefined()
    const reverted = operation([member({ state: 'included-revert' })])
    expect(
      native(
        load({
          operations: [{ ...reverted, payment: 'reverted' }],
          noted: [
            note({
              state: 'reverted',
              inclusion: { ...canonicalInclusion, status: 'revert' },
            }),
          ],
        }),
      ).timeMs,
    ).toBe(3000)
  })

  it('uses only primary payments, ignoring newer funding, change and appended stamp evidence', () => {
    const extra = [
      member({ role: 'funding', transactionHash: hash('c') }),
      member({ role: 'change', transactionHash: hash('d') }),
      member({ stageId: 'stamp-newer', transactionHash: hash('e') }),
    ]
    expect(
      native(
        load({
          operations: [operation([member(), ...extra])],
          noted: [
            note(),
            ...extra.map(m =>
              note({
                txHash:
                  m.transactionHash ??
                  (() => {
                    throw new Error('Fixture member requires transaction hash')
                  })(),
                inclusion: { ...canonicalInclusion, blockTimeMs: 8000 },
              }),
            ),
          ],
        }),
      ).timeMs,
    ).toBe(3000)
    expect(
      native(load({ operations: [operation(extra)], noted: [note()] })).timeMs,
    ).toBeUndefined()
  })

  it('uses the latest recipient inclusion across multipart payments and still dates standalone stamps', () => {
    const second = member({
      transactionHash: hash('c'),
      blockNumber: 31,
      blockHash: hash('d'),
    })
    expect(
      native(
        load({
          operations: [operation([member(), second])],
          noted: [
            note(),
            note({
              txHash: hash('c'),
              inclusion: {
                ...canonicalInclusion,
                blockNumber: 31,
                blockHash: hash('d'),
                blockTimeMs: 5000,
              },
            }),
          ],
        }),
      ).timeMs,
    ).toBe(5000)
    expect(
      native(
        load({
          operations: [
            {
              ...operation([member({ stageId: 'stamp-only' })]),
              purpose: 'stamp',
            },
          ],
        }),
      ).timeMs,
    ).toBe(3000)
  })

  it('keeps truly unknown native dates last and never uses the existing foreign-note activity fallback', () => {
    const noCanonicalTime = note({
      inclusion: { ...canonicalInclusion, blockTimeMs: undefined },
    })
    const input = load({ noted: [noCanonicalTime] })
    expect(rows(input).map(row => [row.kind, row.timeMs])).toEqual([
      ['received', 2000],
      ['received', 1000],
      ['native', undefined],
    ])
    expect(native(load({ noted: [] })).timeMs).toBeUndefined()
    const foreign = rows(
      load({ operations: [], noted: [noCanonicalTime] }),
    ).find(row => row.kind === 'noted')
    expect(foreign?.timeMs).toBe(9000)
  })

  it('preserves financial ownership, amounts, fees, status, inputs and deterministic deduplication', () => {
    const input = load()
    const snapshot = () =>
      JSON.stringify(input, (_key, value) =>
        typeof value === 'bigint'
          ? value.toString()
          : value instanceof Map
          ? [...value]
          : value,
      )
    const before = snapshot()
    const baseline = native({ ...input, noted: [] })
    const recovered = native(input)
    expect({ ...recovered, timeMs: undefined }).toEqual(baseline)
    expect(recovered.operation).toBe(input.operations[0])
    expect(recovered.operation.intendedValueWei).toBe('243574000000000000')
    expect(recovered.feeWei).toBe('6426000000000000')
    expect(rows(input)).toHaveLength(3)
    expect(groups(input)).toEqual(groups(input))
    expect(snapshot()).toBe(before)
  })
})

function render(input: Load) {
  return shallowMount(History, {
    props: {
      chainIdentifier: 'monad-regtest',
      groups: groups(input),
      inspectionStatus: 'available',
      nativeUnit: 'MONR',
      nativeAmount: value => value,
      networkName: () => 'Monad Regtest',
      transactionExplorerLink: () => undefined,
      formatSwapTime: time => String(time),
    },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: Object.fromEntries(
        [
          'QCardSection',
          'QList',
          'QItemLabel',
          'QItem',
          'QItemSection',
          'QIcon',
          'QBadge',
          'AddressText',
        ].map(name => [name, { template: '<div><slot /></div>' }]),
      ),
    },
  })
}

it('renders the recovered native date and omits a genuinely unknown native date', () => {
  const recovered = render(load()).get('[data-activity-id="native:return"]')
  expect(
    recovered
      .get('[data-testid="wallet-activity-date"]')
      .attributes('datetime'),
  ).toBe(new Date(3000).toISOString())
  const unknown = render(load({ noted: [] })).get(
    '[data-activity-id="native:return"]',
  )
  expect(unknown.find('[data-testid="wallet-activity-date"]').exists()).toBe(
    false,
  )
})
