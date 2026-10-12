import type { DirectMessageAttemptStatus } from '@frank/wallet/chain'
import type { StealthPaymentProgress } from '@frank/wallet/stealth-payment'
import { Wallet, Transaction, keccak256, type Provider } from 'ethers'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { EvmLegacyConsolidator } from '@frank/wallet/chain/evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from '@frank/wallet/chain/evm-transaction-builder'
import { EvmNativeOperationJournal } from '@frank/wallet/storage/evm-native-operation-journal'
import {
  createFinancialOperationRecovery,
  type FinancialRecoverySession,
  type FinancialRecoveryWallet,
} from './recovery'

const digest = 'ab'.repeat(32)
const pending: StealthPaymentProgress = {
  status: 'pending',
  intendedAmountAtomic: 1n,
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  let current = true
  const payments = {
    list: jest.fn(async () => [
      { operationId: 'original', payloadDigest: digest },
    ]),
    submit: jest.fn(async () => pending),
    reconcile: jest.fn(async () => pending),
  }
  const wallet: FinancialRecoveryWallet = {
    chainIdentifier: 'monad-testnet',
    owner: {},
    payments,
  }
  const session: FinancialRecoverySession = {
    isCurrent: () => current,
    wallets: [wallet],
    deliveryOf: jest.fn(
      async (): Promise<DirectMessageAttemptStatus | undefined> => 'delivered',
    ),
  }
  const onError = jest.fn(),
    onProgress = jest.fn()
  const captureSession = jest.fn(async () => session)
  const recovery = createFinancialOperationRecovery({
    captureSession,
    onError,
    onProgress,
  })
  return {
    payments,
    wallet,
    session,
    captureSession,
    recovery,
    onError,
    onProgress,
    replaceSession: () => {
      current = false
    },
  }
}

it.each(['live', 'dead', 'unknown', undefined] as const)(
  'does not submit or reconcile a binding without durable delivery (%s)',
  async status => {
    const f = fixture()
    jest.mocked(f.session.deliveryOf).mockResolvedValue(status)
    await f.recovery.tick()
    expect(f.payments.submit).not.toHaveBeenCalled()
    expect(f.payments.reconcile).not.toHaveBeenCalled()
  },
)

it('holds a rejected delivery lookup and retries the original binding on a later tick', async () => {
  const f = fixture()
  const error = new Error('delivery store unavailable')
  jest.mocked(f.session.deliveryOf).mockRejectedValueOnce(error)
  await f.recovery.tick()
  expect(f.payments.submit).not.toHaveBeenCalled()
  expect(f.payments.reconcile).not.toHaveBeenCalled()
  expect(f.onError).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId: 'original',
      stage: 'delivery',
      error,
    }),
  )
  await f.recovery.tick()
  expect(f.payments.submit.mock.calls).toEqual([['original']])
  expect(f.payments.reconcile.mock.calls).toEqual([['original']])
})

it('leaves journal operations without a delivery binding untouched', async () => {
  const f = fixture()
  f.captureSession.mockResolvedValue({
    ...f.session,
    wallets: [
      {
        ...f.wallet,
        payments: {
          ...f.payments,
          list: async () => [{ operationId: 'unsigned' }],
        },
      },
    ],
  })
  await f.recovery.tick()
  expect(f.session.deliveryOf).not.toHaveBeenCalled()
  expect(f.payments.submit).not.toHaveBeenCalled()
  expect(f.payments.reconcile).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

it('retries a failed original operation from its owner list without any chat row', async () => {
  const f = fixture()
  f.payments.submit.mockRejectedValueOnce(new Error('offline'))
  await f.recovery.tick()
  expect(f.onError).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: 'original', stage: 'submit' }),
  )
  expect(f.payments.reconcile).not.toHaveBeenCalled()
  await f.recovery.tick()
  expect(f.payments.submit.mock.calls).toEqual([['original'], ['original']])
  expect(f.payments.reconcile).toHaveBeenCalledWith('original')
  expect(f.onProgress).toHaveBeenCalledWith(
    expect.objectContaining({ payloadDigest: digest, progress: pending }),
  )
})

it('keeps unrelated operations moving across overlapping ticks while one submission waits', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    blocked = deferred<StealthPaymentProgress>()
  f.payments.submit.mockImplementationOnce(async () => {
    entered.resolve()
    return blocked.promise
  })
  const first = f.recovery.tick()
  await entered.promise
  f.payments.list.mockResolvedValue([
    { operationId: 'original', payloadDigest: digest },
    { operationId: 'other', payloadDigest: 'cd'.repeat(32) },
  ])
  await f.recovery.tick()
  expect(f.payments.submit.mock.calls).toEqual([['original'], ['other']])
  expect(f.payments.reconcile).toHaveBeenCalledWith('other')
  blocked.resolve(pending)
  await first
})

it('checks all delivery bindings of one operation and submits it once', async () => {
  const f = fixture()
  f.payments.list.mockResolvedValue([
    { operationId: 'original', payloadDigest: 'cd'.repeat(32) },
    { operationId: 'original', payloadDigest: digest },
  ])
  jest
    .mocked(f.session.deliveryOf)
    .mockResolvedValueOnce('live')
    .mockResolvedValueOnce('delivered')
  await f.recovery.tick()
  expect(f.payments.submit).toHaveBeenCalledTimes(1)
  expect(f.onProgress).toHaveBeenCalledWith(
    expect.objectContaining({ payloadDigest: digest }),
  )
})

it('bounds each pass and rotates beyond retained completed history', async () => {
  const f = fixture()
  f.payments.list.mockResolvedValue(
    Array.from({ length: 20 }, (_, index) => ({
      operationId: String(index),
      payloadDigest: digest,
    })),
  )
  await f.recovery.tick()
  expect(f.payments.submit).toHaveBeenCalledTimes(16)
  await f.recovery.tick()
  expect(f.payments.submit.mock.calls.slice(16, 20)).toEqual([
    ['16'],
    ['17'],
    ['18'],
    ['19'],
  ])
})

it('drops old session effects and callbacks after an awaited delivery lookup', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    lookup = deferred<DirectMessageAttemptStatus>()
  jest.mocked(f.session.deliveryOf).mockImplementation(async () => {
    entered.resolve()
    return lookup.promise
  })
  const work = f.recovery.tick()
  await entered.promise
  f.replaceSession()
  lookup.resolve('delivered')
  await work
  expect(f.payments.submit).not.toHaveBeenCalled()
  expect(f.onProgress).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

it('drops stale submission errors instead of notifying the replacement account', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    blocked = deferred<StealthPaymentProgress>()
  f.payments.submit.mockImplementation(async () => {
    entered.resolve()
    await blocked.promise
    throw new Error('old account offline')
  })
  const work = f.recovery.tick()
  await entered.promise
  f.replaceSession()
  blocked.resolve(pending)
  await work
  expect(f.payments.reconcile).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

it('reports one unreadable owner while recovering another canonical wallet', async () => {
  const f = fixture()
  const other = fixture()
  f.payments.list.mockRejectedValue(new Error('store unavailable'))
  f.captureSession.mockResolvedValue({
    ...f.session,
    wallets: [f.wallet, { ...other.wallet, chainIdentifier: 'xec-testnet' }],
  })
  await f.recovery.tick()
  expect(f.onError).toHaveBeenCalledWith(
    expect.objectContaining({
      stage: 'list',
      chainIdentifier: 'monad-testnet',
    }),
  )
  expect(other.payments.submit).toHaveBeenCalledWith('original')
})

it('retries the real EVM journal owner with identical signed bytes after ambiguous submission', async () => {
  const signer = new Wallet('0x' + '01'.padStart(64, '0'))
  const recipient = new Wallet('0x' + '02'.padStart(64, '0'))
  const location = await mkdtemp(join(tmpdir(), 'financial-recovery-review-'))
  const journal = new EvmNativeOperationJournal({
    location,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'recovery-test',
    },
  })
  await journal.Open()
  const broadcast = jest.fn(async (raw: string) => ({ hash: keccak256(raw) }))
  broadcast.mockRejectedValueOnce(new Error('lost response'))
  const provider = {
    getBlock: async () => ({ hash: '0x' + 'aa'.repeat(32), number: 1 }),
    getBalance: async () => 1_000_000n,
    getTransactionCount: async () => 0,
    getFeeData: async () => ({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 1n,
    }),
    getTransaction: async () => null,
    getTransactionReceipt: async () => null,
    estimateGas: async () => 21_000n,
    broadcastTransaction: broadcast,
  } as unknown as Provider
  const owner = new EvmLegacyConsolidator({
    journal,
    provider,
    transactionBuilder: new NativeEvmTransactionBuilder(),
    getSources: async () => [
      { kind: 'main', address: signer.address.toLowerCase() },
    ],
    sign: async (_source, raw) => signer.signTransaction(Transaction.from(raw)),
  })
  try {
    const prepared = await owner.signNative({
      recipient: { raw: recipient.address },
      value: 1n,
    })
    const member = prepared.members[0]
    if (!member?.signed) throw new Error('Expected a signed journal member')
    const original = member.signed.rawTransaction
    // Narrow fixture adapter around the real journal owner. Host delivery binding already exists;
    // the recovery driver sees neither chat data nor signing/preparation capabilities.
    const payments: FinancialRecoveryWallet['payments'] = {
      list: async () =>
        journal.list().map(row => ({
          operationId: row.operationId,
          payloadDigest: digest,
        })),
      submit: async id => {
        await owner.resumeOperation(id)
        return pending
      },
      reconcile: async id => {
        await owner.observe(id, 0)
        return pending
      },
    }
    const onError = jest.fn()
    const recovery = createFinancialOperationRecovery({
      captureSession: async () => ({
        isCurrent: () => true,
        wallets: [{ chainIdentifier: 'monad-testnet', owner, payments }],
        deliveryOf: async () => 'delivered',
      }),
      onError,
    })
    await recovery.tick()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'submit' }),
    )
    expect(journal.get(prepared.operationId).cancelled).toBe(false)
    await recovery.tick()
    expect(broadcast.mock.calls).toEqual([[original], [original]])
    expect(journal.get(prepared.operationId).members[0]).toMatchObject({
      signed: { rawTransaction: original },
    })
  } finally {
    await journal.Close()
    await rm(location, { recursive: true, force: true })
  }
})
