import { recordEvmRpcFailure } from '@frank/wallet/evm-rpc-failure'
import {
  createOutgoingExecution,
  type ExecutionMessage,
  type ExecutionContext,
  type OutgoingExecutionPorts,
} from './outgoing-execution'
import { createOutgoingRecovery } from './outgoing-recovery'
import { directMessageNotAttempted } from '@frank/wallet/chain/active-chain'
import type { DirectMessageClient, WalletHandle } from '@frank/wallet/chain'

const wallet = { chainIdentifier: 'monad-testnet' } as WalletHandle
const stale = new Error('stale')
const receipt = {
  payloadDigest: 'original',
  stampValueWei: 1n,
  stampPayments: [],
  preparationTxHashes: [],
}
const request = { wallet, address: 'peer', id: 'local', manual: false }
function fixture(financial = false) {
  const row: ExecutionMessage = {
    payloadDigest: 'local',
    senderAddress: 'owner',
    outbound: true,
    status: 'pending',
    items: [{ type: 'text', text: 'hello' }],
    sealedMessageId: 'sealed',
    conversationId: 'thread',
    stampValueWei: 1n,
    ...(financial
      ? {
          financialOperations: [
            { chainIdentifier: 'solana-devnet', operationId: 'kept' },
          ],
        }
      : {}),
  }
  const records = new Map([['local', row]])
  const events: string[] = []
  let current = true
  const send = jest.fn<
    ReturnType<DirectMessageClient['send']>,
    Parameters<DirectMessageClient['send']>
  >(async params => {
    await params.onAttemptCreated?.('original')
    return receipt
  })
  const reconcile = jest.fn<
    ReturnType<DirectMessageClient['reconcileAttempts']>,
    Parameters<DirectMessageClient['reconcileAttempts']>
  >(async () => ({ original: 'delivered' }))
  const dm: ExecutionContext['directMessages'] = {
    send(params) {
      expect(this).toBe(dm)
      events.push('send')
      return send(params)
    },
    reconcileAttempts(params) {
      expect(this).toBe(dm)
      events.push('reconcile')
      return reconcile(params)
    },
    attemptOf: jest.fn(async () => {
      events.push('lookup')
      return { payloadDigest: 'original', paid: true }
    }),
    unattributedAttempts: jest.fn(async () => []),
    resolveUnattributedAttempts: jest.fn(async () => undefined),
  }
  const context: ExecutionContext = {
    chainIdentifier: 'monad-testnet',
    current: () => current,
    parseAddress: address => ({ raw: address }),
    directMessages: dm,
  }
  const payment = {
    expose: jest.fn(async (_digest: string) => {
      events.push('expose')
    }),
    submit: jest.fn(async () => {
      events.push('submit')
    }),
  }
  const bind = jest.fn(async (binding: { phase: string }) => {
    events.push(`bind:${binding.phase}`)
  })
  const ports: OutgoingExecutionPorts<ExecutionMessage> = {
    message: id => records.get(id),
    messageEntries: () => [...records],
    conversations: () => [{ address: 'peer', messages: [...records.values()] }],
    inflight: new Set(),
    withLock: jest.fn(async (_id, run) => ({ result: await run() })),
    owns: (_wallet, message) => message.senderAddress === 'owner',
    resultAssertion: (_wallet, id, message, digest, isCurrent) => () => {
      if (
        !isCurrent() ||
        records.get(id) !== message ||
        message.delivery?.attemptDigest !== digest
      )
        throw stale
    },
    isStale: error => error === stale,
    messageId: id => `derived:${id}`,
    refresh: jest.fn(async () => 'same' as const),
    captureMessagingContext: () => context,
    captureFinancialScope: (
      _wallet,
      message,
      _chain,
      isCurrent,
      stillCurrent,
    ) => ({
      accountId: () => 'account',
      assertCurrent: () => {
        if (!isCurrent() || !stillCurrent() || records.get('local') !== message)
          throw stale
      },
    }),
    captureFinancial: jest.fn(async () => {
      events.push('capture-financial')
      return payment
    }),
    readFinancialBootstrapAuthority: jest.fn(async () => {
      events.push('bootstrap')
      return { paid: true, financialOperations: row.financialOperations! }
    }),
    financialRepository: async () => {
      events.push('repository')
      return { bindFinancialEnvelope: bind }
    },
    captureApplication: jest.fn(async () => undefined),
    setState: jest.fn(async (_address, id, status, delivery, options) => {
      options?.assertCurrent?.()
      events.push(`state:${status}:${delivery.attemptDigest ?? '-'}`)
      Object.assign(records.get(id)!, { status, delivery })
    }),
    forgetTiedUpAttempt: jest.fn(async (_address, id, _digest, options) => {
      options.assertCurrent()
      events.push('forget-tied-up')
      Object.assign(records.get(id)!, { status: 'pending', delivery: {} })
    }),
    confirm: jest.fn(async params => {
      params.assertCurrent?.()
      events.push('confirm')
      records.set(params.payloadDigest, { ...row, status: 'confirmed' })
    }),
    applyAttemptStatus: async params =>
      createOutgoingRecovery({
        message: id => records.get(id),
        conversations: () => [],
        inflight: ports.inflight,
        starting: new Set(),
        withLock: ports.withLock,
        captureContext: () => ({
          current: context.current,
          parseAddress: () => true,
          attemptOf: async () => undefined,
          reconcileAttempts: async () => ({}),
        }),
        resultAssertion: ports.resultAssertion,
        isStale: ports.isStale,
        owns: ports.owns,
        isAddress: () => true,
        displayAddress: x => x,
        messageId: ports.messageId,
        refresh: ports.refresh,
        setState: ports.setState,
        confirm: ports.confirm,
        run: async () => undefined,
        runExclusive: async () => undefined,
        warn: jest.fn(),
      }).applyAttemptStatus(params),
    reconcileOutgoing: jest.fn(async () => {
      events.push(`wake:${ports.inflight.has('local')}`)
      return { pending: 0 }
    }),
    presentation: {
      subject: jest.fn(() => 'subject'),
      subjectCarried: jest.fn(() => {
        events.push('subject-carried')
      }),
      wakeupItems: jest.fn((_wallet, _address, items) => items),
      cancellable: jest.fn(() => ({
        signal: new AbortController().signal,
        done: () => {
          events.push('cancel-done')
        },
      })),
      progress: jest.fn(),
      clearProgress: jest.fn(() => {
        events.push('clear-progress')
      }),
      endWaiting: jest.fn(() => {
        events.push('end-waiting')
      }),
    },
    waitForMessagingReady: jest.fn(async () => true),
    delay: jest.fn(async () => undefined),
    classifySendFailure: jest.fn((_error, digest) => ({
      reason: 'error',
      ...(digest ? { keepDigest: digest } : {}),
    })),
    errorDetail: error =>
      error instanceof Error ? error.message : String(error),
    stripReleasedPayments: jest.fn(),
    log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  }
  return {
    row,
    records,
    events,
    ports,
    context,
    dm,
    send,
    reconcile,
    payment,
    bind,
    expire: () => {
      current = false
    },
    engine: createOutgoingExecution(ports),
  }
}

it('runs headlessly with stable request identity, sidecar/subject timing and existing callbacks', async () => {
  const f = fixture()
  const callerProgress = jest.fn()
  f.send.mockImplementation(async params => {
    expect(f.ports.presentation.subjectCarried).not.toHaveBeenCalled()
    const progress = { stage: 'waiting-for-chain' as const }
    params.onPreparationProgress?.(progress)
    expect(f.ports.presentation.progress).toHaveBeenCalledWith(
      'local',
      progress,
    )
    expect(callerProgress).toHaveBeenCalledWith(progress)
    await params.onAttemptCreated?.('original')
    return receipt
  })
  await expect(
    f.engine.runOutgoing({ ...request, onPreparationProgress: callerProgress }),
  ).resolves.toEqual({ state: 'sent', payloadDigest: 'original' })
  expect(f.send.mock.calls[0][0]).toMatchObject({
    messageId: 'sealed',
    conversationId: 'thread',
    conversationName: 'subject',
    items: f.row.items,
  })
  expect(f.events).toEqual([
    'state:pending:-',
    'send',
    'clear-progress',
    'state:pending:original',
    'subject-carried',
    'end-waiting',
    'confirm',
  ])
  expect(f.ports.inflight.size).toBe(0)
})

it.each([false, true])(
  'preserves existing message locking when lockHeld=%s',
  async lockHeld => {
    const f = fixture()
    await f.engine.runOutgoing({ ...request, lockHeld })
    expect(f.ports.withLock).toHaveBeenCalledTimes(lockHeld ? 0 : 1)
    expect(f.ports.inflight.size).toBe(0)
  },
)

it('retains the original captured messaging receiver across a refresh await', async () => {
  const f = fixture()
  const replacement = jest.fn()
  f.ports.refresh = async () => {
    f.ports.captureMessagingContext = () => ({
      ...f.context,
      directMessages: { ...f.dm, send: replacement },
    })
    return 'same'
  }
  await f.engine.runOutgoing({ ...request, manual: true })
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(replacement).not.toHaveBeenCalled()
})

it('retains paid financial authority and the strict envelope barrier before original submission', async () => {
  const f = fixture(true)
  f.row.delivery = { attemptDigest: 'original' }
  f.reconcile.mockImplementation(async params => {
    await params.onEnvelopeDurable?.('original', 'sealed')
    return { original: 'delivered' }
  })
  await expect(f.engine.runOutgoing(request)).resolves.toEqual({
    state: 'sent',
    payloadDigest: 'original',
  })
  expect(f.events).toEqual([
    'capture-financial',
    'bootstrap',
    'lookup',
    'repository',
    'bind:pending',
    'bind:bound',
    'reconcile',
    'state:pending:original',
    'repository',
    'bind:bound',
    'expose',
    'submit',
    'confirm',
  ])
  expect(f.send).not.toHaveBeenCalled()
  expect(f.reconcile.mock.calls[0][0]).toMatchObject({
    payloadDigests: ['original'],
    messageIds: ['sealed'],
    maxPutAttempts: 1,
  })
})

it('keeps free financial original replay on send under the same sealed identity', async () => {
  const f = fixture(true)
  f.row.stampValueWei = 0n
  f.send.mockImplementation(async params => {
    await params.onEnvelopeDurable?.('original', 'sealed')
    return { ...receipt, stampValueWei: 0n }
  })
  await f.engine.runOutgoing(request)
  expect(f.reconcile).not.toHaveBeenCalled()
  expect(f.send.mock.calls[0][0].messageId).toBe('sealed')
  expect(f.events.indexOf('bind:pending')).toBeLessThan(
    f.events.indexOf('send'),
  )
  expect(f.events.indexOf('bind:bound')).toBeLessThan(
    f.events.indexOf('expose'),
  )
  expect(f.events.indexOf('expose')).toBeLessThan(f.events.indexOf('submit'))
})

it('keeps a delivered original pending when financial submission rejects', async () => {
  const f = fixture(true)
  const failure = new Error('broadcast uncertain')
  f.payment.submit.mockRejectedValue(failure)
  await expect(f.engine.runOutgoing(request)).resolves.toEqual({
    state: 'payment-pending',
  })
  expect(f.row.delivery?.attemptDigest).toBe('original')
  expect(f.ports.confirm).not.toHaveBeenCalled()
})

it('retains ownDigest before strict attribution failure and passes the exact error to classification', async () => {
  const f = fixture()
  const failure = new Error('strict write failed')
  const set = f.ports.setState
  f.ports.setState = async (...args) => {
    if (args[4]?.strict) throw failure
    return set(...args)
  }
  await expect(f.engine.runOutgoing(request)).resolves.toEqual({
    state: 'failed',
    reason: 'error',
  })
  expect(f.ports.classifySendFailure).toHaveBeenCalledWith(failure, 'original')
  expect(f.row.delivery?.attemptDigest).toBe('original')
  expect(f.send).toHaveBeenCalledTimes(1)
})

it.each([true, false])(
  'queues only exact every-call no-effect evidence (%s)',
  async labelled => {
    const f = fixture()
    const failure = recordEvmRpcFailure(
      Object.assign(new Error('rate limited'), {
        code: 429,
        ...(labelled ? { [directMessageNotAttempted]: true } : {}),
      }),
    )
    f.send.mockRejectedValue(failure)
    await expect(f.engine.runOutgoing(request)).resolves.toEqual(
      labelled
        ? { state: 'payment-pending' }
        : { state: 'failed', reason: 'error' },
    )
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.send.mock.calls.map(([params]) => params.messageId)).toEqual([
      'sealed',
      'sealed',
      'sealed',
    ])
    // A queued message records why it waits: the relay or the network could not be reached.
    if (labelled)
      expect(f.row.delivery).toEqual({ failureReason: 'unreachable' })
    expect(f.ports.delay).toHaveBeenNthCalledWith(1, 500)
    expect(f.ports.delay).toHaveBeenNthCalledWith(2, 1000)
    expect(f.ports.presentation.wakeupItems).toHaveBeenCalledTimes(3)
    expect(f.ports.presentation.subjectCarried).not.toHaveBeenCalled()
  },
)

it('maps only the shared stale sentinel to busy and releases inflight on a financial capture rejection', async () => {
  const f = fixture(true)
  f.ports.captureFinancial = async () => {
    throw stale
  }
  await expect(f.engine.runOutgoing(request)).resolves.toEqual({
    state: 'busy',
  })
  expect(f.ports.inflight.size).toBe(0)
  const other = new Error('capture refused')
  f.ports.captureFinancial = async () => {
    throw other
  }
  await expect(f.engine.runOutgoing(request)).rejects.toBe(other)
  expect(f.ports.inflight.size).toBe(0)
})

it('wakes queued recovery after success while the current exclusion is held', async () => {
  const f = fixture()
  f.records.set('queued', {
    ...f.row,
    payloadDigest: 'queued',
    status: 'payment-pending',
    delivery: {},
  })
  await f.engine.runOutgoing(request)
  expect(f.events.at(-1)).toBe('wake:true')
  expect(f.ports.inflight.size).toBe(0)
})

it('wakes recovered-original work only after releasing its own exclusion', async () => {
  const f = fixture()
  f.send.mockRejectedValue(new Error('recovered elsewhere'))
  f.ports.classifySendFailure = () => ({ reason: 'recovered' })
  await expect(f.engine.runOutgoing(request)).resolves.toEqual({
    state: 'failed',
    reason: 'recovered',
  })
  expect(f.events.at(-1)).toBe('wake:false')
})

it('normalizes automatic and confirmed flags at the outer owner boundary', async () => {
  const f = fixture()
  await expect(
    f.engine.runOutgoing({ ...request, automatic: true }),
  ).resolves.toEqual({ state: 'sent', payloadDigest: 'original' })
  const g = fixture()
  g.row.status = 'error'
  g.row.delivery = { failureReason: 'recovered' }
  await expect(
    g.engine.runOutgoing({
      ...request,
      manual: true,
      automatic: true,
      confirmed: true,
    }),
  ).resolves.toEqual({ state: 'failed', reason: 'recovered' })
  expect(g.send).not.toHaveBeenCalled()
})

it.each([
  'pending-bind',
  'strict-callback',
  'bound-bind',
  'callback-context',
] as const)(
  'cannot expose or submit after the %s barrier is interrupted',
  async cut => {
    const f = fixture(true)
    const failure = new Error(cut)
    if (cut === 'pending-bind') f.bind.mockRejectedValueOnce(failure)
    if (cut === 'bound-bind')
      f.bind.mockImplementation(async binding => {
        if (binding.phase === 'bound') throw failure
      })
    if (cut === 'strict-callback' || cut === 'callback-context') {
      const set = f.ports.setState
      f.ports.setState = async (...args) => {
        if (args[4]?.strict) {
          if (cut === 'strict-callback') throw failure
          f.expire()
        }
        return set(...args)
      }
    }
    f.send.mockImplementation(async params => {
      await params.onEnvelopeDurable?.('original', 'sealed')
      return receipt
    })
    if (cut === 'pending-bind')
      await expect(f.engine.runOutgoing(request)).rejects.toBe(failure)
    else await f.engine.runOutgoing(request)
    expect(f.payment.expose).not.toHaveBeenCalled()
    expect(f.payment.submit).not.toHaveBeenCalled()
    expect(f.ports.confirm).not.toHaveBeenCalled()
    expect(f.ports.inflight.size).toBe(0)
    if (cut === 'pending-bind') expect(f.send).not.toHaveBeenCalled()
  },
)
