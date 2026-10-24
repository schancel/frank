import {
  createOutgoingRecovery,
  type OutgoingRecoveryPorts,
  type RecoveryContext,
  type RecoveryConversation,
  type RecoveryMessage,
} from './outgoing-recovery'
import type { WalletHandle } from '@frank/wallet/chain'

const wallet = {} as WalletHandle
const stale = new Error('stale owner')
const message = (
  id = 'local',
  digest: string | null = 'original',
): RecoveryMessage => ({
  payloadDigest: id,
  senderAddress: 'owner',
  outbound: true,
  status: digest ? 'payment-pending' : 'pending',
  sealedMessageId: 'sealed',
  delivery: digest ? { attemptDigest: digest } : {},
})
function fixture(rows = [message()]) {
  const records = new Map(rows.map(row => [row.payloadDigest, row]))
  let conversations: Array<[string, RecoveryConversation<RecoveryMessage>]> = [
    ['uuid', { address: 'peer', messages: rows }],
  ]
  let current = true
  const events: string[] = []
  const lookup = jest.fn<
    ReturnType<RecoveryContext['attemptOf']>,
    Parameters<RecoveryContext['attemptOf']>
  >(async () => ({ payloadDigest: 'original', paid: true }))
  const reconcile = jest.fn<
    ReturnType<RecoveryContext['reconcileAttempts']>,
    Parameters<RecoveryContext['reconcileAttempts']>
  >(async () => ({ original: 'delivered' }))
  // Receiver-dependent methods catch accidental detachment at the headless boundary.
  const context: RecoveryContext & { marker: string } = {
    marker: 'captured',
    current() {
      expect(this.marker).toBe('captured')
      return current
    },
    parseAddress(address) {
      expect(this.marker).toBe('captured')
      return address === 'key-address'
    },
    attemptOf(wallet, id) {
      expect(this.marker).toBe('captured')
      return lookup(wallet, id)
    },
    reconcileAttempts(wallet, digests) {
      expect(this.marker).toBe('captured')
      events.push('reconcile')
      return reconcile(wallet, digests)
    },
  }
  const ports: OutgoingRecoveryPorts<RecoveryMessage> = {
    message: id => records.get(id),
    conversations: () => [...conversations],
    inflight: new Set(),
    starting: new Set(),
    withLock: async (_id, run) => ({ result: await run() }),
    captureContext: () => context,
    resultAssertion: (_wallet, id, selected, digest, isCurrent) => () => {
      if (
        !isCurrent() ||
        records.get(id) !== selected ||
        selected.delivery?.attemptDigest !== digest ||
        selected.senderAddress !== 'owner'
      )
        throw stale
    },
    isStale: error => error === stale,
    owns: (_wallet, row) => row.senderAddress === 'owner',
    isAddress: address => address === 'peer',
    displayAddress: address => `display:${address}`,
    messageId: id => `derived:${id}`,
    refresh: jest.fn(async () => 'same' as const),
    setState: jest.fn(async (_address, id, status, delivery, options) => {
      options.assertCurrent()
      events.push(`state:${id}:${status}`)
      Object.assign(records.get(id)!, { status, delivery })
    }),
    confirm: jest.fn(async params => {
      params.assertCurrent()
      events.push(`confirm:${params.id}`)
      records.get(params.id)!.status = 'confirmed'
    }),
    run: jest.fn(async params => {
      events.push(`run:${params.id}`)
    }),
    runExclusive: jest.fn(async params => {
      events.push(`exclusive:${params.id}`)
    }),
    warn: jest.fn(),
  }
  return {
    records,
    ports,
    lookup,
    reconcile,
    context,
    events,
    recovery: createOutgoingRecovery(ports),
    expire: () => {
      current = false
    },
    conversations: (value: typeof conversations) => {
      conversations = value
    },
  }
}

it.each(['paid', 'free', 'absent', 'error'] as const)(
  'resumes a cut-off %s original under its sealed identity',
  async kind => {
    const f = fixture([message('local', null)])
    if (kind === 'error') f.lookup.mockRejectedValue(new Error('offline'))
    else
      f.lookup.mockResolvedValue(
        kind === 'absent'
          ? undefined
          : { payloadDigest: 'original', paid: kind === 'paid' },
      )
    await f.recovery.resumeCutOffOutgoing({
      wallet,
      address: 'peer',
      id: 'local',
    })
    expect(f.lookup).toHaveBeenCalledWith(wallet, 'sealed')
    expect(f.ports.inflight.size).toBe(0)
    expect(f.events).toEqual(
      kind === 'paid'
        ? ['state:local:payment-pending']
        : kind === 'free'
        ? ['exclusive:local']
        : kind === 'absent'
        ? ['state:local:error']
        : [],
    )
    if (kind === 'free')
      expect(f.ports.runExclusive).toHaveBeenCalledWith({
        wallet,
        address: 'display:peer',
        id: 'local',
        manual: false,
        automatic: false,
        confirmed: false,
      })
    if (kind === 'absent')
      expect(f.records.get('local')?.delivery?.failureReason).toBe(
        'interrupted',
      )
    expect(f.ports.warn).toHaveBeenCalledTimes(kind === 'error' ? 1 : 0)
  },
)

it.each(['inflight', 'starting', 'lock-denied'] as const)(
  'does not inspect an original excluded by %s',
  async exclusion => {
    const f = fixture([message('local', null)])
    if (exclusion === 'lock-denied') f.ports.withLock = async () => undefined
    else (f.ports[exclusion] as Set<string>).add('local')
    await f.recovery.resumeCutOffOutgoing({
      wallet,
      address: 'peer',
      id: 'local',
    })
    expect(f.lookup).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
    expect(f.ports.inflight.has('local')).toBe(exclusion === 'inflight')
  },
)

it.each(['refresh', 'lookup'] as const)(
  'does not apply cut-off lookup after context changes at %s',
  async boundary => {
    const f = fixture([message('local', null)])
    if (boundary === 'refresh')
      f.ports.refresh = async () => {
        f.expire()
        return 'same'
      }
    else
      f.lookup.mockImplementation(async () => {
        f.expire()
        return { payloadDigest: 'original', paid: true }
      })
    await f.recovery.resumeCutOffOutgoing({
      wallet,
      address: 'peer',
      id: 'local',
    })
    expect(f.events).toEqual([])
    expect(f.ports.inflight.size).toBe(0)
  },
)

it('preserves shared conversation identity, routing, receiver binding and current final count', async () => {
  const financial = {
    ...message('financial'),
    financialOperations: [
      { chainIdentifier: 'solana-devnet', operationId: 'kept' },
    ],
  }
  const queued = { ...message('queued', null), status: 'payment-pending' }
  const foreign = { ...message('foreign'), senderAddress: 'another-account' }
  const plain = message()
  const f = fixture([plain, financial, queued, foreign])
  const chat = { address: '', messages: [plain, financial, queued, foreign] }
  f.conversations([
    ['key-address', chat],
    ['alias', chat],
  ])
  f.ports.run = jest.fn(async params => {
    f.events.push(`run:${params.id}`)
    if (params.id === 'queued')
      f.conversations([
        ['current', { address: 'peer', messages: [message('later')] }],
      ])
  })
  await expect(f.recovery.reconcileOutgoing({ wallet })).resolves.toEqual({
    pending: 1,
  })
  expect(f.events).toEqual([
    'run:financial',
    'reconcile',
    'confirm:local',
    'run:queued',
  ])
  expect(f.reconcile).toHaveBeenCalledWith(wallet, ['original'])
  expect(f.ports.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      address: 'key-address',
      payloadDigest: 'original',
    }),
  )
})

it.each(['delivered', 'live', 'dead', 'unknown'] as const)(
  'applies %s only to the selected digest',
  async status => {
    const f = fixture()
    f.reconcile.mockResolvedValue({ original: status })
    await f.recovery.reconcileOutgoing({ wallet })
    expect(f.events).toEqual([
      'reconcile',
      status === 'delivered'
        ? 'confirm:local'
        : `state:local:${status === 'live' ? 'payment-pending' : 'error'}`,
    ])
    if (status !== 'delivered')
      expect(f.records.get('local')?.delivery?.attemptDigest).toBe('original')
  },
)

it('does not redundantly persist an already live original', async () => {
  const row = message()
  row.delivery!.live = true
  const f = fixture([row])
  f.reconcile.mockResolvedValue({ original: 'live' })
  await f.recovery.reconcileOutgoing({ wallet })
  expect(f.ports.setState).not.toHaveBeenCalled()
})

it.each(['replacement', 'digest', 'association'] as const)(
  'skips one stale %s result while confirming the second original',
  async boundary => {
    const first = message('first', 'a'),
      second = message('second', 'b')
    const f = fixture([first, second])
    f.reconcile.mockImplementation(async () => {
      if (boundary === 'replacement') f.records.set('first', { ...first })
      if (boundary === 'digest') first.delivery = { attemptDigest: 'different' }
      return { a: 'delivered', b: 'delivered' }
    })
    if (boundary === 'association')
      f.ports.confirm = jest.fn(async params => {
        params.assertCurrent()
        await Promise.resolve() // serialized association read completed before its second guard
        if (params.id === 'first') f.records.set('first', { ...first })
        params.assertCurrent()
        f.events.push(`confirm:${params.id}`)
      })
    await f.recovery.reconcileOutgoing({ wallet })
    expect(f.events).toEqual(['reconcile', 'confirm:second'])
    expect(f.ports.warn).not.toHaveBeenCalled()
  },
)

it.each(['gone', 'unreadable', 'changed-digest'] as const)(
  'excludes refreshed %s originals from the batch',
  async result => {
    const f = fixture()
    f.ports.refresh = async () => {
      if (result === 'changed-digest') {
        f.records.get('local')!.delivery = { attemptDigest: 'different' }
        return 'changed'
      }
      return result
    }
    await f.recovery.reconcileOutgoing({ wallet })
    expect(f.reconcile).not.toHaveBeenCalled()
  },
)

it('continues queued work after a batch error but preserves refresh rejection', async () => {
  const queued = { ...message('queued', null), status: 'payment-pending' }
  const f = fixture([message(), queued])
  const failure = new Error('rpc unavailable')
  f.reconcile.mockRejectedValue(failure)
  await f.recovery.reconcileOutgoing({ wallet })
  expect(f.events).toEqual(['reconcile', 'run:queued'])
  expect(f.ports.warn).toHaveBeenCalledWith(
    'could not reconcile pending payment attempts',
    failure,
  )
  f.events.length = 0
  f.ports.refresh = async () => {
    throw failure
  }
  await expect(f.recovery.reconcileOutgoing({ wallet })).rejects.toBe(failure)
  expect(f.events).toEqual([])
})

it('ignores a replaced cut-off row after lookup and cleans up a refused mutation', async () => {
  const selected = message('local', null)
  const f = fixture([selected])
  f.lookup.mockImplementation(async () => {
    f.records.set('local', { ...selected })
    return { payloadDigest: 'original', paid: true }
  })
  await f.recovery.resumeCutOffOutgoing({
    wallet,
    address: 'peer',
    id: 'local',
  })
  expect(f.events).toEqual([])
  expect(f.ports.inflight.size).toBe(0)
  const failure = new Error('durable write failed')
  f.lookup.mockResolvedValue({ payloadDigest: 'original', paid: true })
  f.ports.setState = async () => {
    throw failure
  }
  await f.recovery.resumeCutOffOutgoing({
    wallet,
    address: 'peer',
    id: 'local',
  })
  expect(f.ports.warn).toHaveBeenCalledWith(
    'could not resume a cut-off send',
    failure,
  )
  expect(f.ports.inflight.size).toBe(0)
})

it('uses the existing derived identity when no sealed ID exists and lookup is absent', async () => {
  const row = message('local', null)
  delete row.sealedMessageId
  const f = fixture([row])
  f.lookup.mockResolvedValue(undefined)
  await f.recovery.resumeCutOffOutgoing({
    wallet,
    address: 'peer',
    id: 'local',
  })
  expect(f.lookup).toHaveBeenCalledWith(wallet, 'derived:local')
  expect(row.delivery?.failureReason).toBe('interrupted')
})
