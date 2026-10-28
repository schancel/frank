/** @jest-environment jsdom */
import { enableAutoUnmount, shallowMount } from '@vue/test-utils'
import type { EvmNativeOperationStatus } from '@frank/wallet/chain'
import History from './WalletHistory.vue'
import messages from '../../i18n/en-us'

enableAutoUnmount(afterEach)
const recipient = '0xd4f3463ce84b24d14346e0668ed907e492db965f'
const hashes = ['0x' + 'a'.repeat(64), '0x' + 'b'.repeat(64)]
const operation = (
  payment: EvmNativeOperationStatus['payment'],
): EvmNativeOperationStatus => ({
  operationId: 'evm-native-v1:0000000000000001',
  chainIdentifier: 'monad-testnet',
  kind: 'legacy',
  recipient,
  purpose: 'transfer',
  intendedValueWei: '1000000000000000000',
  payment,
  members: hashes.map((transactionHash, index) => ({
    role: 'payment' as const,
    transactionHash,
    state: index === 0 ? 'included-success' : 'pending',
    ...(index === 0 ? { blockNumber: 123, feeWei: '2100000000000000' } : {}),
  })),
  observedFeeWei: '2100000000000000',
  feeCoverage: 'partial',
  sharing: 'not-shared',
})
function translate(key: string, params: Record<string, unknown> = {}) {
  const text = key
    .split('.')
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown>)?.[part],
      messages,
    )
  return typeof text === 'string'
    ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
    : key
}
function mountHistory(
  payment: EvmNativeOperationStatus['payment'],
  kind: EvmNativeOperationStatus['kind'] = 'legacy',
  purpose: EvmNativeOperationStatus['purpose'] = 'transfer',
) {
  const row = { ...operation(payment), kind, purpose }
  return shallowMount(History, {
    props: {
      chainIdentifier: 'monad-testnet',
      groups: [
        {
          id: 'native',
          label: 'walletHistory.transfers',
          rows: [
            {
              id: 'row',
              kind: 'native',
              operation: row,
              stampWei: '0',
              feeWei: row.observedFeeWei,
              feeCoverage: row.feeCoverage,
            },
          ],
        },
      ],
      inspectionStatus: 'available',
      nativeUnit: 'MONT',
      nativeAmount: value =>
        value === row.intendedValueWei ? '1.0' : '0.0021',
      networkName: chain => (chain === 'monad-testnet' ? 'Monad Testnet' : ''),
      transactionExplorerLink: (hash, chain) =>
        `https://explorer.example/${chain}/${hash}`,
      formatSwapTime: () => 'Oct 11',
    },
    global: {
      mocks: { $t: translate },
      stubs: {
        AddressText: {
          props: ['address'],
          template: '<span class="address-text">{{ address }}</span>',
        },
        ...Object.fromEntries(
          [
            'QCardSection',
            'QList',
            'QItemLabel',
            'QItem',
            'QItemSection',
            'QIcon',
            'QBadge',
          ].map(name => [name, { template: '<div><slot /></div>' }]),
        ),
      },
    },
  })
}

it('shows one compact transfer, with technical evidence behind a native keyboard-accessible disclosure', () => {
  const wrapper = mountHistory('included')
  const details = wrapper.get('details')
  expect(details.attributes('open')).toBeUndefined()
  expect(details.get('summary').text()).toBe('Details')
  expect(wrapper.get('[data-testid="wallet-activity-status"]').text()).toBe(
    'Sent',
  )
  expect(wrapper.text().split(recipient)).toHaveLength(2)
  // The row reads the shortened amount; the exact one is its title.
  const amount = wrapper.get('.wallet-history-amount span')
  expect(amount.text()).toBe('1 MONT')
  expect(amount.attributes('title')).toBe('1.0 MONT')
  expect(wrapper.text().split('Sent on Monad Testnet.')).toHaveLength(2)
  expect(wrapper.text()).not.toContain('evm-native-v1:')
  expect(wrapper.text()).not.toContain('Intended recipient amount')
  expect(details.text()).toContain('Not in a block yet.')
  expect(wrapper.text()).not.toContain('Date unavailable')
})

it.each([
  ['partial', 'Partly processed'],
  ['pending', 'Pending'],
  ['missing', 'Awaiting network'],
  ['unknown', 'Checking payment'],
  ['reverted', 'Reverted'],
  ['cancelled', 'Cancelled'],
] as const)('keeps %s distinct from a confirmed payment', (status, label) => {
  const wrapper = mountHistory(status)
  expect(wrapper.get('[data-testid="wallet-activity-status"]').text()).toBe(
    label,
  )
  expect(wrapper.text()).not.toContain('Sent on Monad Testnet.')
  if (!['cancelled', 'reverted'].includes(status))
    expect(wrapper.get('details').text()).toContain(
      'full payment is not yet confirmed',
    )
})

it('retains every transaction and its own observed state without implying all fees are known', () => {
  const wrapper = mountHistory('partial')
  const details = wrapper.get('details')
  expect(details.findAll('a').map(link => link.attributes('href'))).toEqual(
    hashes.map(hash => `https://explorer.example/monad-testnet/${hash}`),
  )
  expect(details.text()).toMatch(/Transaction 1\s*Confirmed/)
  expect(details.text()).toMatch(/Transaction 2\s*Pending/)
  expect(details.text()).toContain('Block 123')
  expect(details.text()).toContain(
    'Observed fees so far (partial): 0.0021 MONT',
  )
  expect(details.text()).toContain('Not yet shared with your other devices.')
})

it('labels a successful contract call as confirmed rather than claiming a native transfer', () => {
  const wrapper = mountHistory('included', 'contract')
  expect(wrapper.get('[data-testid="wallet-activity-status"]').text()).toBe(
    'Confirmed',
  )
  expect(wrapper.get('.wallet-history-content').text()).toContain('Contract')
})

it('shows the payment apart from the change returned to the wallet, each with its own fees', () => {
  const change = '0x' + 'c'.repeat(64)
  const wrapper = shallowMount(History, {
    props: {
      chainIdentifier: 'monad-testnet',
      groups: [
        {
          id: 'activity',
          label: 'walletPanel.tabHistory',
          rows: [
            {
              id: 'row',
              kind: 'native',
              timeMs: Date.UTC(2026, 9, 20),
              stampWei: '0',
              feeWei: '2100000000000000',
              feeCoverage: 'partial',
              operation: {
                ...operation('included'),
                kind: 'transaction-set',
                members: [
                  {
                    role: 'payment',
                    transactionHash: hashes[0],
                    state: 'included-success',
                    blockNumber: 7,
                    blockHash: '0x' + '1'.repeat(64),
                    feeWei: '2100000000000000',
                  },
                  { role: 'change', transactionHash: change, state: 'missing' },
                ],
              },
            },
          ],
        },
      ],
      inspectionStatus: 'available',
      nativeUnit: 'MONR',
      nativeAmount: value => (value === '0' ? '0' : `amt(${value})`),
      networkName: () => 'Monad Regtest',
      transactionExplorerLink: () => undefined,
      formatSwapTime: () => 'Oct 20',
    },
    global: {
      mocks: { $t: translate },
      stubs: {
        AddressText: {
          props: ['address'],
          template: '<span class="address-text">{{ address }}</span>',
        },
      },
    },
  })
  const details = wrapper.get('[data-testid="wallet-native-operation"]')
  // The details name the card's own figure, the change's transaction included: with the
  // change not in a block yet, it is a figure so far.
  expect(
    details.get('[data-testid="wallet-native-operation-fee"]').text(),
  ).toBe('Observed fees so far (partial): amt(2100000000000000) MONR')
  const changeSection = details.get(
    '[data-testid="wallet-native-operation-change"]',
  )
  expect(changeSection.text()).toContain('Change returned to your wallet (1)')
  expect(changeSection.text()).toContain(change)
  expect(details.text().split('Transaction 1')).toHaveLength(2)
  expect(details.text()).not.toContain('Transaction 2')
  expect(wrapper.get('[data-testid="wallet-activity-date"]').text()).toBe(
    'Oct 20',
  )
  // Regtest has no explorer: no link at all.
  expect(details.findAll('a')).toHaveLength(0)
})

it.each([
  ['received', 'Received', undefined],
  ['pending', 'Arriving', 'The amount the sender stated'],
] as const)('lists a %s payment as incoming', (status, label, note) => {
  const wrapper = shallowMount(History, {
    props: {
      chainIdentifier: 'monad-testnet',
      groups: [
        {
          id: 'activity',
          label: 'walletPanel.tabHistory',
          rows: [
            {
              id: 'received:x',
              kind: 'received',
              timeMs: 1,
              payment: {
                address: '0x' + '7'.repeat(40),
                origin: 'stealth',
                status,
                amountWei: 0n,
                ...(status === 'received' ? { receivedAmountWei: 5n } : {}),
                claimedAmountWei: 5n,
                spendable: status === 'received',
                discoveredAtMs: 1,
              },
            },
          ],
        },
      ],
      inspectionStatus: 'available',
      nativeUnit: 'MONR',
      nativeAmount: value => value,
      networkName: () => '',
      transactionExplorerLink: () => undefined,
      formatSwapTime: () => 'then',
    },
    global: { mocks: { $t: translate } },
  })
  expect(wrapper.get('[data-testid="wallet-activity-status"]').text()).toBe(
    label,
  )
  expect(wrapper.text()).toContain('+5 MONR')
  expect(wrapper.text()).toContain('Payment received')
  if (note) expect(wrapper.text()).toContain(note)
  expect(wrapper.find('[data-testid="wallet-native-operation"]').exists()).toBe(
    false,
  )
})

it('shows a send another device made: what it was for, to whom, when, and its transactions', () => {
  const txHash = '0x' + 'c'.repeat(64)
  const wrapper = shallowMount(History, {
    props: {
      chainIdentifier: 'monad-regtest',
      groups: [
        {
          id: 'activity',
          label: 'walletPanel.tabHistory',
          rows: [
            {
              id: 'noted:m1:stamp',
              kind: 'noted',
              purpose: 'stamp',
              recipient,
              valueWei: '30000000000000000',
              state: 'included',
              timeMs: Date.UTC(2026, 9, 26),
              sends: [
                {
                  txHash,
                  from: recipient,
                  nonce: 0,
                  to: recipient,
                  valueWei: '30000000000000000',
                  call: false,
                  purpose: 'stamp',
                  noteIndex: 0,
                  notedAtMs: 1,
                  state: 'included',
                  inclusion: {
                    status: 'success',
                    blockNumber: 42,
                    blockHash: '0x' + 'd'.repeat(64),
                    blockTimeMs: Date.UTC(2026, 9, 26),
                    feeWei: '1',
                  },
                },
              ],
            },
          ],
        },
      ],
      inspectionStatus: 'available',
      nativeUnit: 'MONR',
      nativeAmount: () => '0.030000000000000000',
      networkName: () => 'Monad Regtest',
      transactionExplorerLink: () => undefined,
      formatSwapTime: () => '3m ago',
    },
    global: {
      mocks: { $t: translate },
      stubs: {
        AddressText: {
          props: ['address'],
          template: '<span class="address-text">{{ address }}</span>',
        },
        ...Object.fromEntries(
          [
            'QCardSection',
            'QList',
            'QItemLabel',
            'QItem',
            'QItemSection',
            'QIcon',
            'QBadge',
          ].map(name => [name, { template: '<div><slot /></div>' }]),
        ),
      },
    },
  })
  expect(wrapper.get('.wallet-history-amount span').text()).toBe('0.03 MONR')
  expect(wrapper.text()).toContain('Message stamp')
  expect(wrapper.get('[data-testid="wallet-activity-date"]').text()).toBe(
    '3m ago',
  )
  expect(wrapper.get('[data-testid="wallet-activity-status"]').text()).toBe(
    'Sent',
  )
  const details = wrapper.get('[data-testid="wallet-noted-send"]')
  expect(details.text()).toContain(txHash)
  expect(details.text()).toContain('Block 42')
})

it('shows a deposit from outside Frank: what arrived, from whom, its transaction and block; and says when deposits could not be read', () => {
  const txHash = '0x' + 'e'.repeat(64)
  const sender = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
  const deposit = (
    asset:
      | { kind: 'native' }
      | { kind: 'erc20'; contract: string; symbol: string; decimals: number },
    amount: string,
    logIndex?: number,
  ) => ({
    id:
      logIndex === undefined ? `${txHash}:native` : `${txHash}:log:${logIndex}`,
    chainIdentifier: 'monad-regtest',
    txHash,
    ...(logIndex === undefined ? {} : { logIndex }),
    to: recipient,
    from: sender,
    asset,
    amount,
    blockNumber: 77,
    blockHash: '0x' + 'f'.repeat(64),
    blockTimeMs: Date.UTC(2026, 9, 27),
  })
  const rows = [
    deposit({ kind: 'native' }, '20000000000000000000'),
    deposit(
      { kind: 'erc20', contract: recipient, symbol: 'USDC', decimals: 6 },
      '2500000',
      3,
    ),
  ].map(item => ({
    id: `deposit:${item.id}`,
    kind: 'deposit' as const,
    deposit: item,
    timeMs: item.blockTimeMs,
  }))
  const wrapper = shallowMount(History, {
    props: {
      chainIdentifier: 'monad-regtest',
      groups: [{ id: 'activity', label: 'walletPanel.tabHistory', rows }],
      inspectionStatus: 'available',
      depositsUnread: true,
      nativeUnit: 'MONR',
      nativeAmount: (value: string) =>
        value === '20000000000000000000' ? '20.0' : value,
      networkName: () => 'Monad Regtest',
      transactionExplorerLink: (hash: string) =>
        `https://explorer.example/${hash}`,
      formatSwapTime: () => 'just now',
    },
    global: {
      mocks: { $t: translate },
      stubs: {
        AddressText: {
          props: ['address'],
          template: '<span class="address-text">{{ address }}</span>',
        },
        ...Object.fromEntries(
          [
            'QCardSection',
            'QList',
            'QItemLabel',
            'QItem',
            'QItemSection',
            'QIcon',
            'QBadge',
          ].map(name => [name, { template: '<div><slot /></div>' }]),
        ),
      },
    },
  })
  const items = wrapper.findAll('[data-testid="wallet-activity-item"]')
  expect(items).toHaveLength(2)
  expect(items[0]!.get('[data-testid="wallet-deposit-amount"]').text()).toBe(
    '+20 MONR',
  )
  expect(items[0]!.text()).toContain('Received from')
  expect(items[0]!.text()).toContain(sender)
  expect(items[0]!.get('[data-testid="wallet-activity-status"]').text()).toBe(
    'Received',
  )
  const details = items[0]!.get('[data-testid="wallet-deposit"]')
  expect(details.text()).toContain(txHash)
  expect(details.text()).toContain('Read from block 77 of the network.')
  expect(details.get('a').attributes('href')).toBe(
    `https://explorer.example/${txHash}`,
  )
  expect(items[1]!.get('[data-testid="wallet-deposit-amount"]').text()).toBe(
    '+2.5 USDC',
  )
  expect(items[1]!.text()).toContain('Received USDC from')
  expect(
    wrapper.get('[data-testid="wallet-deposits-unread"]').text(),
  ).toContain('could not be read')
})

it('reads a background merge of coins as "Merged N coins", with what it was and its fee, not as an amount sent', () => {
  const wrapper = mountHistory('included', 'transaction-set', 'consolidation')
  expect(wrapper.get('[data-testid="wallet-activity-merged"]').text()).toBe(
    'Merged 2 coins',
  )
  expect(wrapper.get('.wallet-history-amount').text()).not.toContain('MONT')
  expect(wrapper.text()).toContain(
    'Small coins merged into one of your accounts',
  )
  expect(wrapper.get('[data-testid="wallet-activity-fee"]').exists()).toBe(true)
})

it('names one network fee for a send: the card and its details show the same figure', () => {
  // A contact payment of two transactions and one that returned change, each charged 2142 µMON:
  // History's card shows all three (0.006426), and so must the details (not 0.004284).
  const fee = '2142000000000000'
  const total = '6426000000000000'
  const change = '0x' + 'c'.repeat(64)
  const wrapper = shallowMount(History, {
    props: {
      chainIdentifier: 'monad-regtest',
      groups: [
        {
          id: 'activity',
          label: 'walletPanel.tabHistory',
          rows: [
            {
              id: 'row',
              kind: 'native',
              timeMs: Date.UTC(2026, 9, 27),
              stampWei: '0',
              feeWei: total,
              feeCoverage: 'complete',
              operation: {
                ...operation('included'),
                chainIdentifier: 'monad-regtest',
                kind: 'transaction-set',
                purpose: 'contact-payment',
                members: [
                  ...hashes.map(transactionHash => ({
                    role: 'payment' as const,
                    transactionHash,
                    state: 'included-success' as const,
                    blockNumber: 7,
                    feeWei: fee,
                  })),
                  {
                    role: 'change' as const,
                    transactionHash: change,
                    state: 'included-success' as const,
                    blockNumber: 8,
                    feeWei: fee,
                  },
                ],
              },
            },
          ],
        },
      ],
      inspectionStatus: 'available',
      nativeUnit: 'MONR',
      nativeAmount: value => `amt(${value})`,
      networkName: () => 'Monad Regtest',
      transactionExplorerLink: () => undefined,
      formatSwapTime: () => 'Oct 27',
    },
    global: {
      mocks: { $t: translate },
      stubs: {
        AddressText: {
          props: ['address'],
          template: '<span class="address-text">{{ address }}</span>',
        },
      },
    },
  })
  expect(wrapper.get('[data-testid="wallet-activity-fee"]').text()).toBe(
    `Network fee amt(${total}) MONR`,
  )
  expect(
    wrapper.get('[data-testid="wallet-native-operation-fee"]').text(),
  ).toBe(`Observed network fees: amt(${total}) MONR`)
})

it('shows actual recovery receipt source and transaction separately from the intended stamp', () => {
  const txHash = '0x' + 'ac'.repeat(32)
  const from = '0x' + '01'.repeat(20)
  const receipt = {
    chainIdentifier: 'monad-testnet',
    txHash,
    from,
    to: recipient,
    amount: '30',
    blockNumber: 2,
    blockHash: '0x' + '03'.repeat(32),
    blockTimeMs: 2000,
  }
  const payment = {
    address: recipient,
    origin: 'stamp' as const,
    status: 'received' as const,
    amountWei: 30n,
    receivedAmountWei: 30n,
    claimedAmountWei: 100n,
    partial: true,
    spendable: true,
    discoveredAtMs: 1,
    nativeStampRecovery: {
      chainIdentifier: 'monad-testnet',
      originalTransactionHash: '0x' + 'ab'.repeat(32),
      supersededAt: { blockNumber: 1, blockHash: receipt.blockHash },
      receipts: [receipt],
    },
  }
  const wrapper = shallowMount(History, {
    props: {
      chainIdentifier: 'monad-testnet',
      groups: [
        {
          id: 'activity',
          label: 'walletPanel.tabHistory',
          rows: [
            {
              id: 'received:x',
              kind: 'received',
              timeMs: 1,
              payment,
              payments: [payment],
            },
          ],
        },
      ],
      inspectionStatus: 'available',
      nativeUnit: 'MONR',
      nativeAmount: value => value,
      networkName: () => '',
      transactionExplorerLink: hash => `https://example.test/tx/${hash}`,
      formatSwapTime: () => 'then',
    },
    global: { mocks: { $t: translate } },
  })
  const details = wrapper.get('[data-testid="wallet-recovered-stamp"]')
  expect(details.html()).toContain(from)
  expect(details.html()).toContain(txHash)
  expect(details.html()).not.toContain(
    payment.nativeStampRecovery.originalTransactionHash,
  )
  expect(
    wrapper.get('[data-testid="wallet-received-partial"]').text(),
  ).toContain('30 MONR of the 100 MONR stated')
})
