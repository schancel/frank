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
  intendedValueWei: '1000000000000000000',
  payment,
  members: hashes.map((transactionHash, index) => ({
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
) {
  const row = { ...operation(payment), kind }
  return shallowMount(History, {
    props: {
      groups: [
        {
          id: 'native',
          label: 'walletHistory.transfers',
          rows: [{ id: 'row', kind: 'native', operation: row }],
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
  expect(wrapper.text().split('1.0 MONT')).toHaveLength(2)
  expect(wrapper.text().split('Sent on Monad Testnet.')).toHaveLength(2)
  expect(wrapper.text()).not.toContain('evm-native-v1:')
  expect(wrapper.text()).not.toContain('Intended recipient amount')
  expect(details.text()).toContain('The date was not recorded')
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
