/** @jest-environment jsdom */
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { Notify } from 'quasar'
import TempoPathUsdPanel from './TempoPathUsdPanel.vue'
import { accountStatus } from '../../accounts/session'

enableAutoUnmount(afterEach)

jest.mock('quasar', () => ({
  copyToClipboard: jest.fn(),
  Notify: { create: jest.fn() },
}))

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
    scheduleOpen(): void
    scanMore(): Promise<void>
    unresolved: boolean
    review: typeof quote | null
    operations: unknown[]
    catchUp: { nextBlock: bigint; complete: boolean } | null
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
  jest.mocked(Notify.create).mockClear()
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

test('refresh reopens the durable journal and clears an uncertainty only after final reconciliation', async () => {
  const { wallet, close } = fixture()
  wallet.submit.mockRejectedValueOnce(new Error('timeout'))
  const wrapper = shallowMount(TempoPathUsdPanel, { global: { stubs } })
  await flushPromises()
  const state = controls(wrapper)
  state.recipient = recipient
  state.amount = '1'
  await state.reviewPayment()
  await state.confirmPayment()
  expect(state.unresolved).toBe(true)
  mockOpen.mockResolvedValueOnce({
    wallet,
    close,
    pendingOperations: [
      {
        operationId: '0x' + 'ab'.repeat(32),
        amountAtomic: '1000000',
        recipient,
        exposed: true,
        observation: { state: 'included-success', finalized: true },
      },
    ],
  })
  state.scheduleOpen()
  await flushPromises()
  expect(close).toHaveBeenCalledTimes(1)
  expect(state.unresolved).toBe(false)
  expect(state.operations).toHaveLength(1)
})

test('account revision waits for an in-flight submit before closing and clears old draft/history', async () => {
  const { wallet, close } = fixture()
  let resolveSubmit: ((value: unknown) => void) | undefined
  wallet.submit.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveSubmit = resolve
      }),
  )
  const wrapper = shallowMount(TempoPathUsdPanel, { global: { stubs } })
  await flushPromises()
  const state = controls(wrapper)
  state.recipient = recipient
  state.amount = '1'
  await state.scanMore()
  expect(state.catchUp?.nextBlock).toBe(2000n)
  await state.reviewPayment()
  const sending = state.confirmPayment()
  await nextTick()
  await nextTick()
  mockStatus.revision++
  await nextTick()
  expect(close).not.toHaveBeenCalled()
  expect(state.recipient).toBe('')
  expect(state.amount).toBe('')
  expect(state.catchUp).toBeNull()
  resolveSubmit?.({
    operationId: '0x' + 'ab'.repeat(32),
    amountAtomic: '1000000',
    recipient,
    exposed: true,
    observation: { state: 'pending' },
  })
  await sending
  await flushPromises()
  expect(close).toHaveBeenCalledTimes(1)
})

test('account revision during prepare still submits the confirmed operation before closing', async () => {
  const { wallet, close } = fixture()
  let finishPrepare: ((value: unknown) => void) | undefined
  wallet.prepare.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishPrepare = resolve
      }),
  )
  const wrapper = shallowMount(TempoPathUsdPanel, { global: { stubs } })
  await flushPromises()
  const state = controls(wrapper)
  state.recipient = recipient
  state.amount = '1'
  await state.reviewPayment()
  const sending = state.confirmPayment()
  await nextTick()
  mockStatus.revision++
  await nextTick()
  expect(close).not.toHaveBeenCalled()
  finishPrepare?.({
    operationId: '0x' + 'ab'.repeat(32),
    amountAtomic: '1000000',
    recipient,
    exposed: false,
    observation: { state: 'unknown' },
  })
  await sending
  await flushPromises()
  expect(wallet.submit).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
})

test('revoked signer after account switch keeps the prepared operation and gives a persistent recovery notice', async () => {
  const { wallet, close } = fixture()
  let finishPrepare: ((value: unknown) => void) | undefined
  wallet.prepare.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishPrepare = resolve
      }),
  )
  wallet.submit.mockRejectedValueOnce(new Error('CustodyError/closed'))
  const wrapper = shallowMount(TempoPathUsdPanel, { global: { stubs } })
  await flushPromises()
  const state = controls(wrapper)
  state.recipient = recipient
  state.amount = '1'
  await state.reviewPayment()
  const sending = state.confirmPayment()
  await nextTick()
  mockStatus.revision++
  await nextTick()
  finishPrepare?.({
    operationId: '0x' + 'ab'.repeat(32),
    amountAtomic: '1000000',
    recipient,
    exposed: false,
    observation: { state: 'unknown' },
  })
  await sending
  await flushPromises()
  expect(wallet.submit).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(Notify.create).toHaveBeenCalledWith(
    expect.objectContaining({
      html: false,
      timeout: 0,
      message: expect.stringContaining('Resume the same payment'),
    }),
  )
})

test('account switch warns after an uncertain prepare write without assuming no payment effect', async () => {
  const { wallet, close } = fixture()
  let rejectPrepare: ((reason: unknown) => void) | undefined
  wallet.prepare.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectPrepare = reject
      }),
  )
  const wrapper = shallowMount(TempoPathUsdPanel, { global: { stubs } })
  await flushPromises()
  const state = controls(wrapper)
  state.recipient = recipient
  state.amount = '1'
  await state.reviewPayment()
  const sending = state.confirmPayment()
  await nextTick()
  mockStatus.revision++
  await nextTick()
  rejectPrepare?.(new Error('Journal write outcome uncertain'))
  await sending
  await flushPromises()
  expect(close).toHaveBeenCalledTimes(1)
  expect(wallet.submit).not.toHaveBeenCalled()
  expect(Notify.create).toHaveBeenCalledWith(
    expect.objectContaining({
      html: false,
      timeout: 0,
      message: expect.stringContaining('check Payment activity'),
    }),
  )
})
