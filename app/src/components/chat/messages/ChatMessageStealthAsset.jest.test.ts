/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import type { StealthPaymentReceiptObservation } from '@frank/wallet/stealth-payment'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import ChatMessageStealthAsset from './ChatMessageStealthAsset.vue'
import { translateMessage } from '../../../i18n'
import { recipientAssetRows } from '../../../stealth-payments/presentation'
import type { StealthAssetOption } from '../../../stealth-payments/options'

const pub = `02${'11'.repeat(32)}`
const bytes = Uint8Array.from(Buffer.from(pub, 'hex'))
const configuredDex = getChainRegistryEntry('monad-testnet')!.dex![0]!
const usdc =
  'tokens' in configuredDex
    ? configuredDex.tokens.find(token => token.symbol === 'USDC')!
    : undefined
const tokenAddress = usdc && 'address' in usdc ? usdc.address! : ''
function transfer(
  chainIdentifier = 'monad-testnet',
  amountAtomic = '9007199254740993000001',
) {
  return {
    chainIdentifier,
    amountAtomic,
    txId: 'ab'.repeat(32),
    destination: '12'.repeat(20),
    asset: { kind: 'token' as const, identifier: tokenAddress.slice(2) },
    stealthMetadata: { keyType: 1 as const, ephemeralPubKey: pub },
    recipientSpendKey: { keyType: 1 as const, publicKey: pub },
    derivationScheme: 1,
    rawTx: '010203',
  }
}
function item(): RecipientAssetPaymentItem {
  return {
    type: 'stealth-asset',
    transfers: [transfer()],
    memo: 'For lunch <script>',
  }
}
function context(
  observe = jest.fn(
    async (): Promise<StealthPaymentReceiptObservation> => ({
      status: 'pending',
      intendedAmountAtomic: 9007199254740993000001n,
      spendability: 'pending',
    }),
  ),
) {
  const record = jest.fn(),
    submit = jest.fn()
  const receipts = jest.fn(() => ({ observe, record, submit }))
  return {
    payloadDigest: 'cd'.repeat(32),
    spendPublicKey: bytes.slice(),
    assertCurrent: jest.fn(),
    receipts,
    observe,
    record,
    submit,
  }
}
function render(props = {}) {
  return mount(ChatMessageStealthAsset, {
    props: { item: item(), ...props },
    global: {
      provide: { _q_: { dark: { isActive: false } } },
      stubs: {
        QCard: { template: '<div><slot /></div>' },
        QBadge: { template: '<span><slot /></span>' },
        QBtn: {
          props: ['label'],
          template: '<button @click="$emit(\'click\')">{{label}}</button>',
        },
      },
    },
  })
}
const text = (wrapper: ReturnType<typeof render>, id: string) =>
  wrapper.get(`[data-testid="${id}"]`).text()

test('mount observes exact grouped token claims without recording, submitting or turning the claim into funds', async () => {
  const ctx = context(),
    payment = item()
  payment.transfers.push({
    ...transfer(),
    amountAtomic: '7',
    txId: 'ef'.repeat(32),
    rawTx: '040506',
  })
  ctx.observe.mockResolvedValue({
    status: 'pending',
    intendedAmountAtomic: 9007199254740993000008n,
    spendability: 'pending',
  })
  const wrapper = render({ item: payment, observationContext: ctx })
  expect(text(wrapper, 'asset-status')).toBe('Pending chain verification')
  expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
  await flushPromises()
  expect(wrapper.findAll('[data-testid="asset-payment-row"]')).toHaveLength(1)
  expect(text(wrapper, 'asset-intended')).toBe(
    'Intended: 9007199254740993.000008 USDC',
  )
  expect(ctx.receipts).toHaveBeenCalledWith('monad-testnet')
  expect(ctx.observe).toHaveBeenCalledWith(
    expect.objectContaining({
      amountAtomic: 9007199254740993000008n,
      rawTransactions: ['010203', '040506'],
      payloadDigest: ctx.payloadDigest,
    }),
  )
  expect(ctx.record).not.toHaveBeenCalled()
  expect(ctx.submit).not.toHaveBeenCalled()
  expect(text(wrapper, 'asset-memo')).toBe('For lunch <script>')
})

test.each([
  ['partial', 'spendable', 1234567n, 'Partially received'],
  [
    'succeeded',
    'needs-native-gas',
    9007199254740993000001n,
    'Needs native funds for fees',
  ],
  ['failed', 'pending', undefined, 'Failed'],
] as const)(
  'displays actual %s evidence separately from intended amount',
  async (status, spendability, verifiedReceivedAmountAtomic, label) => {
    const ctx = context()
    ctx.observe.mockResolvedValue({
      status,
      spendability,
      verifiedReceivedAmountAtomic,
      intendedAmountAtomic: 9007199254740993000001n,
    })
    const wrapper = render({ observationContext: ctx })
    await flushPromises()
    expect(text(wrapper, 'asset-status')).toBe(label)
    expect(text(wrapper, 'asset-intended')).toContain(
      '9007199254740993.000001 USDC',
    )
    if (verifiedReceivedAmountAtomic === undefined)
      expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(
        false,
      )
    else
      expect(text(wrapper, 'asset-verified')).toContain(
        status === 'partial' ? '1.234567 USDC' : '9007199254740993.000001 USDC',
      )
  },
)

test('refresh drops previously verified evidence after reorg or unavailable observation', async () => {
  const ctx = context()
  ctx.observe.mockResolvedValue({
    status: 'succeeded',
    intendedAmountAtomic: 9007199254740993000001n,
    verifiedReceivedAmountAtomic: 9007199254740993000001n,
    spendability: 'spendable',
  })
  const wrapper = render({ observationContext: ctx })
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Received')
  ctx.observe.mockResolvedValue({
    status: 'pending',
    intendedAmountAtomic: 9007199254740993000001n,
    spendability: 'pending',
  })
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Pending chain verification')
  expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
  ctx.observe.mockRejectedValue(new Error('offline'))
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Verification unavailable')
  expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
})

test('unknown scheme preserves content and never asks for custody or an owner', async () => {
  const payment = item(),
    ctx = context()
  payment.transfers[0]!.derivationScheme = 99
  const wrapper = render({ item: payment, observationContext: ctx })
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Unsupported payment')
  expect(text(wrapper, 'asset-unsupported-details')).toContain('99')
  expect(text(wrapper, 'asset-unsupported-details')).toContain(pub)
  expect(ctx.receipts).not.toHaveBeenCalled()
})

test('outgoing delivery state never starts observation or asserts recipient settlement', async () => {
  const ctx = context(),
    wrapper = render({
      observationContext: ctx,
      outbound: true,
      outboundState: 'delivered',
    })
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Message delivered')
  expect(wrapper.text()).not.toContain('Verified received')
  expect(ctx.receipts).not.toHaveBeenCalled()
  expect(ctx.assertCurrent).not.toHaveBeenCalled()
})

test('missing cached owner and expired observation stay unavailable without fake zero', async () => {
  const ctx = context()
  ctx.receipts.mockReturnValue(undefined as never)
  const wrapper = render({ observationContext: ctx })
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Verification unavailable')
  expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
  const live = context()
  live.assertCurrent.mockImplementation(() => {
    throw new Error('replaced session')
  })
  await wrapper.setProps({ observationContext: live })
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Verification unavailable')
  expect(live.observe).not.toHaveBeenCalled()
})

test('canonical native rows keep configured decimal scales and never aggregate different assets', () => {
  const chains = [
    ['btc-testnet', 'BTC', 8],
    ['bch-testnet', 'BCH', 8],
    ['xec-testnet', 'tXEC', 2],
  ] as const
  const payment: RecipientAssetPaymentItem = {
    type: 'stealth-asset',
    transfers: chains.map(([chain]) => ({
      ...transfer(chain, '123456789'),
      asset: { kind: 'native' },
    })),
  }
  const options: StealthAssetOption[] = chains.map(
    ([chainIdentifier, unit, decimals]) => ({
      key: chainIdentifier,
      chainIdentifier,
      asset: { kind: 'native' },
      label: unit,
      unit,
      decimals,
      nativeUnit: unit,
      nativeDecimals: decimals,
    }),
  )
  const rows = recipientAssetRows(payment, options)
  expect(rows.map(row => row.intendedAmount)).toEqual([
    '1.23456789',
    '1.23456789',
    '1234567.89',
  ])
  expect(rows.map(row => row.chainIdentifier)).toEqual(
    chains.map(([chain]) => chain),
  )
  expect(recipientAssetRows(payment, [])[0]!.intendedAmount).toBe('123456789')
})

test('explorer routing uses the canonical row chain and absent metadata keeps plain hashes', async () => {
  const transactionUrl = jest.fn(
    (chain: string, tx: string) => `https://example.test/${chain}/tx/${tx}`,
  )
  const wrapper = render({ outbound: true, transactionUrl })
  expect(transactionUrl).toHaveBeenCalledWith('monad-testnet', 'ab'.repeat(32))
  expect(wrapper.get('[data-testid="asset-explorer"]').attributes('href')).toBe(
    `https://example.test/monad-testnet/tx/${'ab'.repeat(32)}`,
  )
  expect(
    render({ outbound: true }).find('[data-testid="asset-explorer"]').exists(),
  ).toBe(false)
})

test('a replaced observation context cannot restore a late verified amount', async () => {
  let complete!: (value: StealthPaymentReceiptObservation) => void
  const old = context(
    jest.fn(
      () =>
        new Promise<StealthPaymentReceiptObservation>(resolve => {
          complete = resolve
        }),
    ),
  )
  const wrapper = render({ observationContext: old })
  await flushPromises()
  await wrapper.setProps({ observationContext: context() })
  await flushPromises()
  complete({
    status: 'succeeded',
    intendedAmountAtomic: 9007199254740993000001n,
    verifiedReceivedAmountAtomic: 9007199254740993000001n,
    spendability: 'spendable',
  })
  await flushPromises()
  expect(text(wrapper, 'asset-status')).toBe('Pending chain verification')
  expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
})

test('French presentation localizes verification state and exact atomic units', async () => {
  const payment: RecipientAssetPaymentItem = {
    type: 'stealth-asset',
    transfers: [
      { ...transfer('btc-testnet', '123456789'), asset: { kind: 'native' } },
    ],
  }
  const wrapper = mount(ChatMessageStealthAsset, {
    props: { item: payment },
    global: {
      provide: { _q_: { dark: { isActive: false } } },
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) => {
          let text = translateMessage(key, 'fr-fr')
          for (const [name, value] of Object.entries(params ?? {}))
            text = text.replace(`{${name}}`, String(value))
          return text
        },
      },
      stubs: {
        QCard: { template: '<div><slot /></div>' },
        QBadge: { template: '<span><slot /></span>' },
        QBtn: true,
      },
    },
  })
  await flushPromises()
  expect(wrapper.get('[data-testid="asset-intended"]').text()).toContain(
    'Prévu : 123456789 unités atomiques',
  )
  expect(wrapper.get('[data-testid="asset-status"]').text()).toBe(
    'Vérification indisponible',
  )
})
