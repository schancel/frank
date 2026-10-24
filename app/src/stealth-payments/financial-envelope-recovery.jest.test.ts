import { createFinancialEnvelopeRecovery } from './financial-envelope-recovery'
import type { FinancialEnvelopeBinding } from '@frank/cashweb/relay/storage/storage'

type RecoveryOptions = Parameters<typeof createFinancialEnvelopeRecovery>[0]

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
  const submit = jest.fn(async () => undefined)
  const errors = jest.fn()
  const bind = jest.fn(async (_binding: FinancialEnvelopeBinding) => undefined)
  const capture = jest.fn(
    async (
      _references: Parameters<RecoveryOptions['capture']>[0],
    ): ReturnType<RecoveryOptions['capture']> => ({ expose, submit }),
  )
  const reconcile = jest.fn(
    async (
      params: Parameters<
        Parameters<typeof createFinancialEnvelopeRecovery>[0]['reconcile']
      >[0],
    ): ReturnType<RecoveryOptions['reconcile']> => {
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
    attemptOf: jest.fn(
      async (_messageId: string): ReturnType<RecoveryOptions['attemptOf']> => ({
        payloadDigest: digest,
        paid: true,
      }),
    ),
    deliveryOf: jest.fn(
      async (): ReturnType<RecoveryOptions['deliveryOf']> => 'live',
    ),
    onError: errors,
  }
  return {
    options,
    expose,
    submit,
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
  f.submit.mockImplementation(async () => {
    order.push('submit')
  })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(order).toEqual(['bind', 'bind', 'expose', 'submit'])
  expect(f.capture).toHaveBeenCalledWith(pending.financialOperations)
  expect(f.reconcile.mock.calls[0][0]).toMatchObject({
    messageIds: [pending.messageId],
    payloadDigests: [digest],
  })
  expect(f.errors).not.toHaveBeenCalled()
})
it('retains an absent original as observable pending without opening a financial owner', async () => {
  const f = fixture()
  f.options.attemptOf.mockResolvedValue(undefined)
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
it('rejects a callback naming another original before exposure', async () => {
  const f = fixture()
  f.reconcile.mockImplementation(async params => {
    await params.onEnvelopeDurable(
      digest,
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    )
    return {}
  })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.bind).toHaveBeenCalledTimes(1)
  expect(f.expose).not.toHaveBeenCalled()
  expect(f.errors).toHaveBeenCalledTimes(1)
})
it('overlapping ticks exclude only the original whose callback is in flight', async () => {
  const f = fixture()
  let unblock!: () => void
  f.bind.mockResolvedValueOnce(undefined).mockImplementationOnce(
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

it('submits the bound original after durable delivery without a presentation row or another exposure', async () => {
  const f = fixture()
  const bound: FinancialEnvelopeBinding = {
    ...pending,
    phase: 'bound',
    payloadDigest: digest,
  }
  f.options.store.financialEnvelopeBindings = async () => [bound]
  f.options.deliveryOf.mockResolvedValue('delivered')
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.options.deliveryOf).toHaveBeenCalledWith(digest)
  expect(f.capture).toHaveBeenCalledWith(pending.financialOperations)
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.reconcile).not.toHaveBeenCalled()
  expect(f.bind).not.toHaveBeenCalled()
  expect(f.expose).not.toHaveBeenCalled()
})

it.each(['live', 'dead', 'unknown'] as const)(
  'does not submit an exposed original when reconciliation reports %s',
  async status => {
    const f = fixture()
    f.reconcile.mockImplementation(async params => {
      await params.onEnvelopeDurable(digest, pending.messageId)
      return { [digest]: status }
    })
    await createFinancialEnvelopeRecovery(f.options).tick()
    expect(f.expose).toHaveBeenCalledTimes(1)
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.errors).toHaveBeenCalledTimes(status === 'unknown' ? 1 : 0)
  },
)

it('does not infer a pending original identity from an unrelated delivered result', async () => {
  const f = fixture()
  f.options.attemptOf.mockResolvedValue(undefined)
  f.reconcile.mockResolvedValue({ [digest]: 'delivered' })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.errors).toHaveBeenCalledTimes(1)
})

it.each(['message', 'digest'] as const)(
  'rejects a bound callback with conflicting %s before exposure or submission',
  async conflict => {
    const f = fixture()
    f.options.store.financialEnvelopeBindings = async () => [
      { ...pending, phase: 'bound', payloadDigest: digest },
    ]
    f.reconcile.mockImplementation(async params => {
      expect(params.payloadDigests).toEqual([digest])
      await params.onEnvelopeDurable(
        conflict === 'digest' ? 'cd'.repeat(32) : digest,
        conflict === 'message'
          ? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
          : pending.messageId,
      )
      return { [digest]: 'delivered' }
    })
    await createFinancialEnvelopeRecovery(f.options).tick()
    expect(f.bind).not.toHaveBeenCalled()
    expect(f.capture).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.errors).toHaveBeenCalledTimes(1)
  },
)

it.each([
  'list',
  'delivery',
  'bind',
  'capture',
  'expose',
  'reconcile',
] as const)(
  'starts no subsequent effect after context changes during %s',
  async boundary => {
    const f = fixture()
    if (boundary === 'list')
      f.options.store.financialEnvelopeBindings = async () => {
        f.expire()
        return [pending]
      }
    if (boundary === 'delivery') {
      f.options.store.financialEnvelopeBindings = async () => [
        { ...pending, phase: 'bound', payloadDigest: digest },
      ]
      f.options.deliveryOf.mockImplementation(async () => {
        f.expire()
        return 'delivered'
      })
    }
    if (boundary === 'bind')
      f.bind.mockImplementation(async () => {
        f.expire()
      })
    if (boundary === 'capture')
      f.capture.mockImplementation(async () => {
        f.expire()
        return { expose: f.expose, submit: f.submit }
      })
    if (boundary === 'expose')
      f.expose.mockImplementation(async () => {
        f.expire()
      })
    if (boundary === 'reconcile')
      f.reconcile.mockImplementation(async params => {
        await params.onEnvelopeDurable(digest, pending.messageId)
        f.expire()
        return { [digest]: 'delivered' }
      })
    await createFinancialEnvelopeRecovery(f.options).tick()
    expect(f.submit).not.toHaveBeenCalled()
    if (boundary === 'list') expect(f.reconcile).not.toHaveBeenCalled()
    if (boundary === 'delivery' || boundary === 'list' || boundary === 'bind')
      expect(f.capture).not.toHaveBeenCalled()
    if (boundary === 'capture') expect(f.expose).not.toHaveBeenCalled()
    expect(f.errors).not.toHaveBeenCalled()
  },
)

it.each(['capture', 'expose', 'submit'] as const)(
  'retains and retries the same references after %s fails',
  async boundary => {
    const f = fixture()
    const error = new Error(`${boundary} interrupted`)
    f[boundary].mockRejectedValueOnce(error)
    const recovery = createFinancialEnvelopeRecovery(f.options)
    await recovery.tick()
    expect(f.errors).toHaveBeenCalledWith(pending, error)
    if (boundary !== 'submit') expect(f.submit).not.toHaveBeenCalled()
    await recovery.tick()
    expect(f.submit).toHaveBeenCalledTimes(boundary === 'submit' ? 2 : 1)
    expect(
      f.capture.mock.calls.every(
        ([references]) => references === pending.financialOperations,
      ),
    ).toBe(true)
    expect(f.reconcile.mock.calls.map(([params]) => params.messageIds)).toEqual(
      [[pending.messageId], [pending.messageId]],
    )
  },
)

it('continues a later rotating batch while one original submission is stalled', async () => {
  const f = fixture()
  const rows = Array.from(
    { length: 17 },
    (_, i): FinancialEnvelopeBinding => ({
      ...pending,
      messageId: `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`,
      phase: 'bound',
      payloadDigest: i.toString(16).padStart(64, '0'),
      financialOperations: [
        { chainIdentifier: 'solana-devnet', operationId: `original-${i}` },
      ],
    }),
  )
  f.options.store.financialEnvelopeBindings = async () => rows
  f.options.deliveryOf.mockResolvedValue('delivered')
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const submitted: string[] = []
  f.capture.mockImplementation(async references => ({
    expose: f.expose,
    submit: async () => {
      const id = references[0].operationId
      submitted.push(id)
      if (id === 'original-0') {
        entered()
        await held
      }
    },
  }))
  const recovery = createFinancialEnvelopeRecovery(f.options)
  const first = recovery.tick()
  await started
  try {
    await recovery.tick()
    expect(submitted).toContain('original-16')
    expect(submitted.filter(id => id === 'original-0')).toHaveLength(1)
  } finally {
    release()
    await first
  }
  expect(f.errors).not.toHaveBeenCalled()
})

it('does not submit a delivered bound original after capture changes the session', async () => {
  const f = fixture()
  f.options.store.financialEnvelopeBindings = async () => [
    { ...pending, phase: 'bound', payloadDigest: digest },
  ]
  f.options.deliveryOf.mockResolvedValue('delivered')
  f.capture.mockImplementation(async () => {
    f.expire()
    return { expose: f.expose, submit: f.submit }
  })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.reconcile).not.toHaveBeenCalled()
  expect(f.errors).not.toHaveBeenCalled()
})

it('reports unreadable enumeration rather than treating it as no obligations', async () => {
  const f = fixture()
  const error = new Error('binding store unavailable')
  f.options.store.financialEnvelopeBindings = async () => {
    throw error
  }
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.errors).toHaveBeenCalledWith(undefined, error)
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.reconcile).not.toHaveBeenCalled()
})

it('keeps a bound original observable when neither delivery nor reconciliation can find it', async () => {
  const f = fixture()
  const bound: FinancialEnvelopeBinding = {
    ...pending,
    phase: 'bound',
    payloadDigest: digest,
  }
  f.options.store.financialEnvelopeBindings = async () => [bound]
  f.options.deliveryOf.mockResolvedValue(undefined)
  f.reconcile.mockResolvedValue({})
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.errors).toHaveBeenCalledWith(bound, expect.any(Error))
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.capture).not.toHaveBeenCalled()
})

it('does not mistake successful original submission for terminal financial settlement', async () => {
  const f = fixture()
  f.options.store.financialEnvelopeBindings = async () => [
    { ...pending, phase: 'bound', payloadDigest: digest },
  ]
  f.options.deliveryOf.mockResolvedValue('delivered')
  const recovery = createFinancialEnvelopeRecovery(f.options)
  await recovery.tick()
  await recovery.tick()
  expect(f.submit).toHaveBeenCalledTimes(2)
  expect(f.capture.mock.calls.map(([references]) => references)).toEqual([
    pending.financialOperations,
    pending.financialOperations,
  ])
  expect(f.reconcile).not.toHaveBeenCalled()
})

it.each(
  [true, false].flatMap(paid =>
    (['live', 'delivered'] as const).map(status => ({ paid, status })),
  ),
)(
  'recovers pending bootstrap after crash for paid=$paid original already $status without a new callback',
  async ({ paid, status }) => {
    const f = fixture()
    f.options.attemptOf.mockResolvedValue({ payloadDigest: digest, paid })
    f.options.deliveryOf.mockResolvedValue(status)
    f.reconcile.mockResolvedValue({ [digest]: status })
    await createFinancialEnvelopeRecovery(f.options).tick()
    expect(f.options.attemptOf).toHaveBeenCalledWith(pending.messageId)
    expect(f.bind).toHaveBeenCalledWith({
      ...pending,
      phase: 'bound',
      payloadDigest: digest,
    })
    expect(f.expose).not.toHaveBeenCalled()
    expect(f.submit).toHaveBeenCalledTimes(status === 'delivered' ? 1 : 0)
    if (status === 'live')
      expect(f.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          messageIds: [pending.messageId],
          payloadDigests: [digest],
        }),
      )
    else expect(f.reconcile).not.toHaveBeenCalled()
    expect(f.errors).not.toHaveBeenCalled()
  },
)

it('does not expose or reconcile when authoritative original lookup fails', async () => {
  const f = fixture()
  const error = new Error('original lookup unavailable')
  f.options.attemptOf.mockRejectedValue(error)
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.errors).toHaveBeenCalledWith(pending, error)
  expect(f.bind).not.toHaveBeenCalled()
  expect(f.reconcile).not.toHaveBeenCalled()
  expect(f.capture).not.toHaveBeenCalled()
})

it('does not bind a lookup result into a replacement session', async () => {
  const f = fixture()
  f.options.attemptOf.mockImplementation(async () => {
    f.expire()
    return { payloadDigest: digest, paid: false }
  })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.bind).not.toHaveBeenCalled()
  expect(f.options.deliveryOf).not.toHaveBeenCalled()
  expect(f.reconcile).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps the held original barrier when its callback disagrees with authoritative lookup', async () => {
  const f = fixture()
  f.reconcile.mockImplementation(async params => {
    await params.onEnvelopeDurable('cd'.repeat(32), pending.messageId)
    return { [digest]: 'delivered' }
  })
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.bind).toHaveBeenCalledTimes(1)
  expect(f.bind).toHaveBeenCalledWith({
    ...pending,
    phase: 'bound',
    payloadDigest: digest,
  })
  expect(f.expose).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.errors).toHaveBeenCalledTimes(1)
})

it('resumes the bound original after lookup linkage committed but its acknowledgement failed', async () => {
  const f = fixture()
  let retained: FinancialEnvelopeBinding = pending
  f.options.store.financialEnvelopeBindings = async () => [retained]
  const error = new Error('commit acknowledgement lost')
  f.bind.mockImplementationOnce(async binding => {
    retained = binding
    throw error
  })
  f.options.deliveryOf.mockResolvedValue('delivered')
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.errors).toHaveBeenCalledWith(pending, error)
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.capture).not.toHaveBeenCalled()
  await createFinancialEnvelopeRecovery(f.options).tick()
  expect(f.options.attemptOf).toHaveBeenCalledTimes(1)
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.expose).not.toHaveBeenCalled()
})
