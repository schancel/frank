/** @jest-environment jsdom */
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils'
import TempoPathUsdPanel from './TempoPathUsdPanel.vue'
import { accountStatus } from '../../accounts/session'

enableAutoUnmount(afterEach)

const mockOpen = jest.fn()
jest.mock('../../accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ status: 'ready', revision: 1 }),
}))
const mockStatus = accountStatus as { status: string; revision: number }
jest.mock('../../accounts/tempo-wallets', () => ({
  openTempoPathUsdWallet: (...args: unknown[]) => mockOpen(...args),
}))

const recipient = '0x0000000000000000000000000000000000000002'
const source = '0x0000000000000000000000000000000000000001'
const quote = {
  source,
  recipient,
  amountAtomic: 1_000_000n,
  nonce: 2n,
  feeAsset: {
    chainIdentifier: 'tempo-testnet',
    kind: 'tip20',
    contract: '0x20c0000000000000000000000000000000000000',
    decimals: 6,
  },
  maximumFeeAtomic: 20_000n,
}

function fixture() {
  const wallet = {
    address: source,
    balanceAtomic: jest.fn(async () => 2_000_000n),
    quote: jest.fn(async () => quote),
    prepare: jest.fn(async () => ({
      operationId: '0x' + 'ab'.repeat(32),
      amountAtomic: '1000000',
      recipient,
      exposed: false,
      transactionHash: null,
      observation: { state: 'unknown' },
    })),
    submit: jest.fn(async () => ({
      operationId: '0x' + 'ab'.repeat(32),
      amountAtomic: '1000000',
      recipient,
      exposed: true,
      transactionHash: '0x' + 'cd'.repeat(32),
      observation: { state: 'pending' },
    })),
    reconcile: jest.fn(),
    receivedItems: jest.fn(() => []),
    syncReceivedCatchUp: jest.fn(async () => ({
      nextBlock: 2000n,
      complete: false,
    })),
  }
  const close = jest.fn(async () => undefined)
  mockOpen.mockResolvedValue({ wallet, pendingOperations: [], close })
  return { wallet, close }
}

function controls(wrapper: ReturnType<typeof shallowMount>) {
  return (
    wrapper.vm as unknown as { $: { setupState: Record<string, unknown> } }
  ).$.setupState as {
    recipient: string
    amount: string
    reviewPayment(): Promise<void>
    confirmPayment(): Promise<void>
    refresh(): Promise<void>
    unresolved: boolean
    review: typeof quote | null
    operations: unknown[]
  }
}
const stubs = {
  QBanner: true,
  QBtn: true,
  QSkeleton: true,
  QInput: true,
  QCard: true,
  QCardSection: true,
  QCardActions: true,
  QList: true,
  QItem: true,
  QItemSection: true,
  QItemLabel: true,
}

beforeEach(() => {
  mockOpen.mockReset()
  mockStatus.status = 'ready'
  mockStatus.revision++
})

test('review binds six-decimal amount and a PathUSD fee ceiling before submit', async () => {
  const { wallet } = fixture()
  const wrapper = shallowMount(TempoPathUsdPanel, { global: { stubs } })
  await flushPromises()
  const state = controls(wrapper)
  state.recipient = recipient
  state.amount = '1'
  await state.reviewPayment()
  expect(wallet.quote).toHaveBeenCalledWith(recipient, 1_000_000n)
  expect(state.review?.maximumFeeAtomic).toBe(20_000n)
  await state.confirmPayment()
  expect(wallet.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      recipient,
      amountAtomic: 1_000_000n,
      authorizedFeeAsset: quote.feeAsset,
      authorizedFeeCeilingAtomic: 20_000n,
      quotedNonce: 2n,
    }),
  )
  expect(wallet.submit).toHaveBeenCalledTimes(1)
  expect(state.unresolved).toBe(true)
})

test('an uncertain submission prevents a fresh payment and keeps its operation visible', async () => {
  const { wallet } = fixture()
  wallet.submit.mockRejectedValueOnce(new Error('timeout'))
  const wrapper = shallowMount(TempoPathUsdPanel, { global: { stubs } })
  await flushPromises()
  const state = controls(wrapper)
  state.recipient = recipient
  state.amount = '1'
  await state.reviewPayment()
  await state.confirmPayment()
  expect(state.unresolved).toBe(true)
  expect(state.operations).toHaveLength(1)
  await state.reviewPayment()
  expect(wallet.quote).toHaveBeenCalledTimes(1)
})
