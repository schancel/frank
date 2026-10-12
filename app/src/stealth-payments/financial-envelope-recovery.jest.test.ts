import { createFinancialEnvelopeRecovery } from './financial-envelope-recovery'
import type { FinancialEnvelopeBinding } from '@frank/cashweb/relay/storage/storage'

const pending: FinancialEnvelopeBinding = {
  version: 1,
  phase: 'pending',
  accountId: 'synthetic-account',
  messagingChainIdentifier: 'monad-testnet',
  messageId: '11111111-2222-4333-8444-555555555555',
  financialOperations: [
    { chainIdentifier: 'solana-devnet', operationId: 'original' },
  ],
}
const digest = 'ab'.repeat(32)
function fixture() {
  let current = true
  const expose = jest.fn(async () => undefined)
  const errors = jest.fn()
  const bind = jest.fn(async (_binding: FinancialEnvelopeBinding) => undefined)
  const capture = jest.fn(async () => ({ expose }))
  const reconcile = jest.fn(
    async (
      params: Parameters<
        Parameters<typeof createFinancialEnvelopeRecovery>[0]['reconcile']
      >[0],
    ) => {
      await params.onEnvelopeDurable(digest, pending.messageId)
      return { [digest]: 'delivered' as const }
    },
  )
  const options = {
    accountId: pending.accountId,
    messagingChainIdentifier: pending.messagingChainIdentifier,
    isCurrent: () => current,
    store: {
      financialEnvelopeBindings: async () => [pending],
      bindFinancialEnvelope: bind,
    },
    capture,
    reconcile,
    deliveryOf: jest.fn(async () => 'live' as const),
    onError: errors,
  }
  return {
    options,
    expose,
    errors,
    bind,
    capture,
    reconcile,
    expire: () => {
      current = false
    },
  }
}

it('binds actual digest durably before capturing and exposing the complete original set', async () => {
  const f = fixture(),
    order: string[] = []
  f.bind.mockImplementation(async binding => {
    expect(binding).toEqual({
      ...pending,
      phase: 'bound',
      payloadDigest: digest,
    })
    order.push('bind')
  })
  f.expose.mockImplementation(async () => {
    order.push('expose')
  })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(order).toEqual(['bind', 'expose'])
  expect(f.capture).toHaveBeenCalledWith(pending.financialOperations)
  expect(f.reconcile.mock.calls[0][0]).toMatchObject({
    messageIds: [pending.messageId],
    payloadDigests: [],
  })
  expect(f.errors).not.toHaveBeenCalled()
})
it('retains an absent original as observable pending without opening a financial owner', async () => {
  const f = fixture()
  f.reconcile.mockResolvedValue({})
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.errors).toHaveBeenCalledWith(
    pending,
    expect.objectContaining({
      message: expect.stringContaining('original has not been stored'),
    }),
  )
  expect(f.bind).not.toHaveBeenCalled()
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.expose).not.toHaveBeenCalled()
})
it('keeps the owner barrier on binding failure, and fences late completion after account replacement', async () => {
  const f = fixture()
  f.bind.mockRejectedValueOnce(new Error('storage interrupted'))
  const recovery = createFinancialEnvelopeRecovery(f.options)
  await recovery.tick()
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.expose).not.toHaveBeenCalled()
  f.bind.mockImplementationOnce(async () => {
    f.expire()
  })
  await recovery.tick()
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.expose).not.toHaveBeenCalled()
})
it('rejects a callback naming another original before any binding or exposure', async () => {
  const f = fixture()
  f.reconcile.mockImplementation(async params => {
    await params.onEnvelopeDurable(
      digest,
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    )
    return {}
  })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.bind).not.toHaveBeenCalled()
  expect(f.expose).not.toHaveBeenCalled()
  expect(f.errors).toHaveBeenCalledTimes(1)
})
it('overlapping ticks exclude only the original whose callback is in flight', async () => {
  const f = fixture()
  let unblock!: () => void
  f.bind.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        unblock = resolve
      }),
  )
  const recovery = createFinancialEnvelopeRecovery(f.options)
  const first = recovery.tick()
  while (!unblock) await Promise.resolve()
  await recovery.tick()
  expect(f.reconcile).toHaveBeenCalledTimes(1)
  unblock()
  await first
  expect(f.expose).toHaveBeenCalledTimes(1)
})
