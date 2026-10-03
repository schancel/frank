import {
  beginCodex32Signup,
  type RecoveryPublicMetadata,
} from '@frank/account-recovery'
import { createVaultWriteIntent, openPreviewVault } from '@frank/account-vault'
import { DOMAIN_PURPOSES } from '@frank/domain-roots'
import {
  openAccountCustody,
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type ExpectedActive,
  type StageAccount,
} from '../index'

let assertions = 0
const cases: string[] = []
const opened: AccountCustody[] = []
function assert(value: unknown, message: string): asserts value {
  assertions++
  if (!value) throw new Error(message)
}
function equal(a: unknown, b: unknown, message: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), message)
}
async function rejects(action: () => Promise<unknown>, code: string) {
  try {
    await action()
  } catch (error) {
    assert(
      error instanceof CustodyError &&
        error.code === code &&
        error.message === `Account custody: ${code}`,
      `expected custody ${code}; received ${(error as Error).message}`,
    )
    return
  }
  throw new Error(`expected ${code}`)
}
async function open(namespace: string) {
  const result = await openAccountCustody({ namespace })
  opened.push(result)
  return result
}
function fixture(
  attemptId: string,
  expectedActive: ExpectedActive = { revision: 0, accountId: null },
  byte = 0,
): StageAccount {
  const ceremony = beginCodex32Signup({
    threshold: 2,
    identifier: 'frnk',
    indices: ['q', 'p'],
    randomBytes: length => new Uint8Array(length).fill(byte),
  })
  const recovered = ceremony.confirmWithMetadata(ceremony.shares)
  return {
    attemptId,
    accountId: `account-${byte}`,
    displayName: 'Fixture account',
    expectedActive,
    custodyEpoch: 1,
    metadata: recovered.metadata,
    roots: DOMAIN_PURPOSES.map(purpose => recovered.roots[purpose]),
  }
}
function erase(input: StageAccount) {
  for (const root of input.roots) root.bytes.fill(0)
}
function current(state: CustodySnapshot): ExpectedActive {
  return {
    revision: state.revision,
    accountId: state.active?.receipt.context.accountId ?? null,
  }
}
async function assertActive(api: AccountCustody, input: StageAccount) {
  const capability = await api.openActive()
  const serialized = JSON.stringify(capability)
  assert(
    !serialized.includes('bytes'),
    'capability serialization contains only public account metadata',
  )
  const roots = capability.takeRoots()
  roots.forEach((root, i) => {
    equal(root.purpose, input.roots[i].purpose, 'root purpose survived')
    equal(
      Array.from(root.bytes),
      Array.from(input.roots[i].bytes),
      'same typed root bytes',
    )
    root.bytes.fill(0)
  })
  capability.close()
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

/** Drop a real transaction's completion notification, while allowing the disk commit. */
function holdAcknowledgement(
  predicate: (store: IDBObjectStore, value: any) => boolean,
) {
  const reached = deferred(),
    original = IDBObjectStore.prototype.put
  let deliver: (() => void) | undefined
  IDBObjectStore.prototype.put = function (value, key) {
    if (!deliver && predicate(this, value)) {
      const tx = this.transaction,
        completion = tx.oncomplete
      tx.oncomplete = function (event) {
        deliver = () => {
          completion?.call(tx, event)
        }
        reached.resolve()
      }
    }
    return original.call(this, value, key)
  }
  return {
    reached: reached.promise,
    release() {
      IDBObjectStore.prototype.put = original
      deliver?.()
    },
    restore() {
      IDBObjectStore.prototype.put = original
    },
  }
}

function abortPut(predicate: (store: IDBObjectStore, value: any) => boolean) {
  const original = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, key) {
    const request = original.call(this, value, key)
    if (predicate(this, value)) this.transaction.abort()
    return request
  }
  return () => {
    IDBObjectStore.prototype.put = original
  }
}
async function storage(
  namespace: string,
  vault: boolean,
  stores: string[],
  work: (tx: IDBTransaction) => void,
) {
  const name = `${
    vault ? 'frank-preview-vault-' : 'frank-account-custody-'
  }${namespace}`
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      work(tx)
    })
  } finally {
    db.close()
  }
}
async function test(name: string, work: () => Promise<void>) {
  await work()
  cases.push(name)
}

async function restart(phase: string) {
  const api = await open('restart'),
    input = fixture('restart-attempt')
  if (phase === 'stage') {
    const hold = holdAcknowledgement(store => store.name === 'records')
    void api.stage(input).catch(() => undefined)
    await hold.reached
    hold.restore()
    const state = await api.snapshot()
    assert(
      state.active === null && state.pending?.status === 'staging',
      'lost stage ack cannot complete setup',
    )
    equal(
      await api.reconcile(input.attemptId),
      'ready',
      'saved intent resolves lost stage ack through authenticated open',
    )
  } else if (phase === 'activate') {
    const state = await api.snapshot()
    assert(
      state.active === null && state.pending?.status === 'staging',
      'process restart never activates pending material',
    )
    equal(
      await api.reconcile(input.attemptId),
      'ready',
      'staged roots survive process crash',
    )
    const hold = holdAcknowledgement(
      (store, value) => store.name === 'state' && value.active !== null,
    )
    void api
      .activate(input.attemptId, input.expectedActive)
      .catch(() => undefined)
    await hold.reached
    hold.restore()
    // Harness kills this process without delivering the activation acknowledgement.
    assert(
      (await api.snapshot()).active !== null,
      'active pointer and metadata committed together',
    )
  } else {
    equal(
      await api.reconcile(input.attemptId),
      'active',
      'lost activation ack resolved from durable active pointer',
    )
    const state = await api.activate(input.attemptId, input.expectedActive)
    equal(state.revision, 1, 'retry is not another activation')
    assert(
      state.pending === null,
      'first activation has no obsolete active cleanup',
    )
    equal(state.active?.displayName, input.displayName, 'public name persisted')
    await assertActive(api, input)
    api.close()
    await rejects(() => api.openActive(), 'closed')
  }
  erase(input)
}

async function regressions() {
  await test('every rollback boundary retains sufficient evidence and the prior account', async () => {
    for (const boundary of ['mark', 'discard', 'clear'] as const) {
      const api = await open(`rollback-${boundary}`),
        first = fixture(`rollback-first-${boundary}`)
      await api.stage(first)
      const active = await api.activate(first.attemptId, first.expectedActive)
      const next = fixture(`rollback-next-${boundary}`, current(active), 3)
      await api.stage(next)
      const restore = abortPut((store, value) =>
        boundary === 'mark'
          ? store.name === 'state' && value.pending?.status === 'discarding'
          : boundary === 'discard'
          ? store.name === 'fences' && value.receipt === null
          : store.name === 'state' && value.pending === null,
      )
      try {
        await rejects(() => api.cancel(next.attemptId), 'storage-failed')
      } finally {
        restore()
      }
      await assertActive(api, first)
      const state = await api.snapshot()
      equal(
        state.pending?.status,
        boundary === 'mark' ? 'staging' : 'discarding',
        'failed rollback retains correct intent state',
      )
      api.close()
      const reopened = await open(`rollback-${boundary}`)
      if (boundary === 'mark') await reopened.cancel(next.attemptId)
      else
        equal(
          await reopened.reconcile(next.attemptId),
          'discarded',
          'restart resumes exact cleanup',
        )
      await assertActive(reopened, first)
      erase(first)
      erase(next)
    }
  })

  await test('vault commit abort preserves public intent and prior active account', async () => {
    const api = await open('vault-abort'),
      first = fixture('vault-abort-first')
    await api.stage(first)
    const active = await api.activate(first.attemptId, first.expectedActive)
    const next = fixture('vault-abort-next', current(active), 7)
    const restore = abortPut(store => store.name === 'records')
    try {
      await rejects(() => api.stage(next), 'storage-failed')
    } finally {
      restore()
    }
    equal(
      await api.reconcile(next.attemptId),
      'incomplete',
      'aborted wrapped-material write is incomplete',
    )
    await assertActive(api, first)
    await api.stage(next)
    equal(
      await api.reconcile(next.attemptId),
      'ready',
      'retry same intent succeeds after vault abort',
    )
    await api.cancel(next.attemptId)
    await assertActive(api, first)
    erase(first)
    erase(next)
  })

  await test('same account revision rejects a stale replacement and duplicate activation linearizes once', async () => {
    const a = await open('revision'),
      b = await open('revision'),
      first = fixture('revision-first')
    await a.stage(first)
    const initial = await a.activate(first.attemptId, first.expectedActive)
    const next = fixture('revision-next', current(initial))
    await a.stage(next)
    const outcomes = await Promise.allSettled([
      a.activate(next.attemptId, next.expectedActive),
      b.activate(next.attemptId, next.expectedActive),
    ])
    assert(
      outcomes.some(result => result.status === 'fulfilled'),
      'a duplicate activation succeeds',
    )
    equal(
      (await a.snapshot()).revision,
      2,
      'one active revision increment for concurrent duplicate activation',
    )
    await a.reconcile(first.attemptId)
    await rejects(
      () => b.stage(fixture('revision-stale', current(initial))),
      'conflict',
    )
    equal(
      await b.reconcile(next.attemptId),
      'active',
      'duplicate actor resolves from authoritative pointer',
    )
    await assertActive(a, next)
    erase(first)
    erase(next)
  })

  await test('invalid input and throwing accessors do not persist an intent or expose caller errors', async () => {
    const api = await open('invalid-input'),
      input = fixture('invalid-input')
    for (const update of [
      { displayName: '' },
      { displayName: ' untrimmed' },
      { displayName: String.fromCharCode(0) },
      { custodyEpoch: -1 },
      { attemptId: 'space forbidden' },
      { roots: input.roots.slice().reverse() },
      { roots: [input.roots[0], input.roots[0]] },
      { roots: [{ ...input.roots[0], bytes: new Uint8Array(31) }] },
    ])
      await rejects(() => api.stage({ ...input, ...update }), 'invalid-input')
    await rejects(
      () =>
        api.stage({
          ...input,
          get metadata(): RecoveryPublicMetadata {
            throw new Error('secret-sentinel')
          },
        }),
      'invalid-input',
    )
    equal(
      (await api.snapshot()).pending,
      null,
      'validation precedes all public writes',
    )
    await api.stage(input)
    const altered = {
      ...input,
      roots: input.roots.map(root => ({
        ...root,
        bytes: new Uint8Array(32).fill(99),
      })),
    }
    await rejects(() => api.stage(altered), 'conflict')
    equal(
      await api.reconcile(input.attemptId),
      'ready',
      'same receipt retry cannot substitute different roots',
    )
    erase(input)
    erase(altered)
  })

  await test('intent abort and crash after intent keep account incomplete; stable same-input retry', async () => {
    const api = await open('intent'),
      input = fixture('intent-attempt')
    const restore = abortPut(store => store.name === 'state')
    try {
      await rejects(() => api.stage(input), 'storage-failed')
    } finally {
      restore()
    }
    equal(
      (await api.snapshot()).pending,
      null,
      'aborted public intent did not persist',
    )
    const generate = crypto.subtle.generateKey
    crypto.subtle.generateKey = (() =>
      Promise.reject(new Error('synthetic-secret'))) as typeof generate
    try {
      await rejects(() => api.stage(input), 'storage-failed')
    } finally {
      crypto.subtle.generateKey = generate
    }
    equal(
      await api.reconcile(input.attemptId),
      'incomplete',
      'persisted intent and absent material',
    )
    api.close()
    const reopened = await open('intent')
    equal(
      await reopened.reconcile(input.attemptId),
      'incomplete',
      'incomplete survives facade reopen',
    )
    await rejects(() => reopened.stage(fixture('other-attempt')), 'conflict')
    const before = (await reopened.snapshot()).pending
    await reopened.stage(input)
    equal(
      (await reopened.snapshot()).pending,
      before,
      'retry retains exact public intent and IDs',
    )
    await rejects(() => reopened.openActive(), 'locked')
    await reopened.activate(input.attemptId, input.expectedActive)
    await assertActive(reopened, input)
    erase(input)
  })

  await test('replacement activation abort preserves prior roots; cleanup follows atomic switch', async () => {
    const api = await open('replacement'),
      first = fixture('first')
    await api.stage(first)
    const initial = await api.activate(first.attemptId, first.expectedActive)
    const replacement = fixture('second', current(initial), 2)
    const staged = await api.stage(replacement)
    assert(
      staged.active?.receipt.context.creationId !==
        staged.pending?.account.receipt.context.creationId,
      'replacement owns independent vault slot',
    )
    const restore = abortPut(
      (store, value) =>
        store.name === 'state' &&
        value.active?.receipt.operationId === 'second',
    )
    try {
      await rejects(
        () => api.activate('second', replacement.expectedActive),
        'storage-failed',
      )
    } finally {
      restore()
    }
    await assertActive(api, first)
    await rejects(
      () => api.activate('second', { revision: 0, accountId: null }),
      'conflict',
    )
    const committed = await api.activate('second', replacement.expectedActive)
    assert(
      committed.pending?.status === 'discarding' &&
        committed.pending.account.receipt.operationId === 'first',
      'old receipt is durable cleanup only after switch',
    )
    await rejects(
      () => api.stage(fixture('third', current(committed), 3)),
      'conflict',
    )
    await assertActive(api, replacement)
    equal(
      await api.reconcile('first'),
      'discarded',
      'exact old receipt cleaned',
    )
    await assertActive(api, replacement)
    const vault = await openPreviewVault({ namespace: 'replacement' })
    equal(
      await vault.reconcile(initial.active!.receipt),
      'removed',
      'only old active removed',
    )
    vault.close()
    erase(first)
    erase(replacement)
  })

  await test('two instances admit one pending attempt and one activation or cancellation', async () => {
    const a = await open('races'),
      b = await open('races'),
      one = fixture('race-one'),
      two = fixture('race-two', undefined, 2)
    const stages = await Promise.allSettled([a.stage(one), b.stage(two)])
    equal(
      stages.filter(result => result.status === 'fulfilled').length,
      1,
      'one stage wins IDB CAS',
    )
    const pending = (await a.snapshot()).pending!
    const operation = pending.account.receipt.operationId
    const outcomes = await Promise.allSettled([
      a.activate(operation, pending.expectedActive),
      b.cancel(operation),
    ])
    equal(
      outcomes.filter(result => result.status === 'fulfilled').length,
      1,
      'one terminal transition wins',
    )
    const state = await a.snapshot()
    if (state.active) {
      await assertActive(a, operation === one.attemptId ? one : two)
      await rejects(() => b.cancel(operation), 'conflict')
    } else
      assert(
        state.pending === null,
        'winning cancel leaves no active or pending row',
      )
    erase(one)
    erase(two)
  })

  await test('cancel fences a paused precommit writer across independent instances', async () => {
    const a = await open('late'),
      b = await open('late'),
      input = fixture('late-attempt')
    const encrypt = crypto.subtle.encrypt,
      reached = deferred(),
      release = deferred()
    crypto.subtle.encrypt = async function (
      this: SubtleCrypto,
      ...args: Parameters<SubtleCrypto['encrypt']>
    ) {
      if ((args[2] as Uint8Array).byteLength > 3) {
        reached.resolve()
        await release.promise
      }
      return encrypt.apply(this, args)
    } as typeof encrypt
    const staging = a.stage(input)
    try {
      await reached.promise
      const cancelled = await b.cancel(input.attemptId)
      assert(
        cancelled.pending === null && cancelled.active === null,
        'absent intent fenced and cleared',
      )
    } finally {
      crypto.subtle.encrypt = encrypt
      release.resolve()
    }
    await rejects(() => staging, 'conflict')
    equal(
      (await a.snapshot()).active,
      null,
      'late stage cannot resurrect cancelled setup',
    )
    const next = fixture('late-successor', undefined, 3)
    await b.stage(next)
    await b.activate(next.attemptId, next.expectedActive)
    await rejects(() => a.cancel(input.attemptId), 'conflict')
    await assertActive(b, next)
    erase(input)
    erase(next)
  })

  await test('lost cleanup acknowledgement retains exact durable evidence until retry', async () => {
    const a = await open('cleanup'),
      input = fixture('cleanup-attempt')
    await a.stage(input)
    const hold = holdAcknowledgement(
      (store, value) => store.name === 'fences' && value.receipt === null,
    )
    const cancellation = a.cancel(input.attemptId)
    await hold.reached
    hold.restore()
    const b = await open('cleanup')
    equal(
      (await b.snapshot()).pending?.status,
      'discarding',
      'cleanup evidence retained across lost receipt ack',
    )
    equal(
      await b.reconcile(input.attemptId),
      'discarded',
      'exact tombstone resolves acknowledgement loss',
    )
    const next = fixture('cleanup-successor', undefined, 4)
    await b.stage(next)
    hold.release()
    await cancellation
    equal(
      (await b.snapshot()).pending?.account.receipt.operationId,
      next.attemptId,
      'late cleanup acknowledgement cannot clear successor',
    )
    erase(input)
    erase(next)
  })

  await test('committed reconciliation is not authentication; missing and corrupt material fail closed', async () => {
    for (const damage of [
      'key',
      'ciphertext',
      'removed',
      'superseded',
    ] as const) {
      const api = await open(`damage-${damage}`),
        first = fixture(`damage-prior-${damage}`)
      await api.stage(first)
      const active = await api.activate(first.attemptId, first.expectedActive)
      const input = fixture(`damage-${damage}`, current(active), 2)
      const staged = await api.stage(input),
        receipt = staged.pending!.account.receipt
      if (damage === 'key')
        await storage(`damage-${damage}`, true, ['keys'], tx =>
          tx.objectStore('keys').delete(input.attemptId),
        )
      if (damage === 'ciphertext')
        await storage(`damage-${damage}`, true, ['records'], tx => {
          const store = tx.objectStore('records'),
            request = store.get(input.attemptId)
          request.onsuccess = () => {
            request.result.ciphertext[0] ^= 1
            store.put(request.result, input.attemptId)
          }
        })
      if (damage === 'removed' || damage === 'superseded') {
        const vault = await openPreviewVault({ namespace: `damage-${damage}` })
        if (damage === 'removed') await vault.remove(receipt)
        else
          await vault.stage(
            createVaultWriteIntent({
              expected: receipt,
              context: receipt.context,
              operationId: 'foreign',
            }),
            input.roots,
          )
        vault.close()
      }
      await rejects(() => api.reconcile(input.attemptId), 'locked')
      await rejects(
        () => api.activate(input.attemptId, input.expectedActive),
        damage === 'superseded' ? 'conflict' : 'locked',
      )
      equal(
        (await api.snapshot()).active,
        active.active,
        `${damage} never replaces prior active`,
      )
      await assertActive(api, first)
      if (damage === 'superseded' || damage === 'removed') {
        await rejects(() => api.cancel(input.attemptId), 'conflict')
        assert(
          (await api.snapshot()).pending !== null,
          'unproven cleanup remains bounded and blocked',
        )
      } else await api.cancel(input.attemptId)
      erase(input)
      erase(first)
    }
  })

  await test('input ownership, accessor capture, public serialization and explicit capability release', async () => {
    const api = await open('ownership'),
      input = fixture('ownership-attempt')
    const originalRoots = input.roots.map(root => ({
      ...root,
      bytes: root.bytes.slice(),
    }))
    let descriptorReads = 0
    const descriptor = input.metadata.descriptor
    const metadata: RecoveryPublicMetadata = {
      get descriptor() {
        descriptorReads++
        return descriptor
      },
      masterRetirementId: input.metadata.masterRetirementId,
      recoveryIdentityCommitment: input.metadata.recoveryIdentityCommitment,
    }
    const caller = { ...input, metadata, secret: 'do-not-serialize-me' }
    const retirement = Array.from(metadata.masterRetirementId, byte =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const staging = api.stage(caller)
    caller.displayName = 'Changed later'
    metadata.masterRetirementId.fill(9)
    erase(input)
    const staged = await staging
    equal(descriptorReads, 1, 'descriptor captured once')
    equal(
      staged.pending?.account.masterRetirementId,
      retirement,
      'owned public commitment captured before caller mutation',
    )
    equal(
      staged.pending?.account.displayName,
      'Fixture account',
      'name captured before await',
    )
    const json = JSON.stringify(staged)
    let persisted: unknown
    await storage('ownership', false, ['state'], tx => {
      const request = tx.objectStore('state').get('account')
      request.onsuccess = () => {
        persisted = request.result
      }
    })
    equal(
      persisted,
      staged,
      'ordinary durable-state export is exactly the public allowlist',
    )
    assert(
      !json.includes('do-not-serialize-me') &&
        !json.includes('bytes') &&
        !json.includes('shares') &&
        !json.includes('mnemonic'),
      'public allowlist omits arbitrary fields and secrets',
    )
    for (const root of originalRoots)
      assert(
        !json.includes(JSON.stringify(Array.from(root.bytes))),
        'no serialized raw roots',
      )
    assert(
      Object.isFrozen(staged) &&
        Object.isFrozen(staged.pending!.account.receipt.context.purposes),
      'public snapshots do not permit mutation',
    )
    await api.activate(input.attemptId, input.expectedActive)
    await assertActive(api, { ...input, roots: originalRoots })
    const capability = await api.openActive()
    api.close()
    let code = ''
    try {
      capability.takeRoots()
    } catch (error) {
      code = (error as CustodyError).code
    }
    equal(code, 'closed', 'facade close revokes and erases untaken capability')
    originalRoots.forEach(root => root.bytes.fill(0))
  })

  await test('malformed records, unsupported schema and unsupported clone fail closed without overwrite', async () => {
    const api = await open('malformed'),
      input = fixture('malformed-attempt')
    await api.stage(input)
    await api.activate(input.attemptId, input.expectedActive)
    api.close()
    await storage('malformed', false, ['state'], tx => {
      const store = tx.objectStore('state'),
        request = store.get('account')
      request.onsuccess = () => {
        store.put({ ...request.result, schema: 99 }, 'account')
      }
    })
    await rejects(
      () => openAccountCustody({ namespace: 'malformed' }),
      'locked',
    )
    let schema: number | undefined
    await storage('malformed', false, ['state'], tx => {
      const request = tx.objectStore('state').get('account')
      request.onsuccess = () => {
        schema = request.result.schema
      }
    })
    equal(schema, 99, 'unknown record not overwritten')
    const supported = await open('unsupported-existing'),
      supportedInput = fixture('unsupported-existing')
    await supported.stage(supportedInput)
    const supportedBefore = await supported.activate(
      supportedInput.attemptId,
      supportedInput.expectedActive,
    )
    const clone = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'probe')
        throw new DOMException('fixture clone failure', 'DataCloneError')
      return clone.call(this, value, key)
    }
    try {
      await rejects(
        () => openAccountCustody({ namespace: 'unsupported-existing' }),
        'unavailable',
      )
    } finally {
      IDBObjectStore.prototype.put = clone
    }
    equal(
      await supported.snapshot(),
      supportedBefore,
      'failed capability probe never changes existing active state',
    )
    await assertActive(supported, supportedInput)
    erase(supportedInput)
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('frank-account-custody-future-version', 2)
      request.onupgradeneeded = () => request.result.createObjectStore('future')
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
    await rejects(
      () => openAccountCustody({ namespace: 'future-version' }),
      'unavailable',
    )
    await rejects(
      () => openAccountCustody({ namespace: '../bad' }),
      'invalid-input',
    )
    erase(input)
  })
}

export async function run(phase: string) {
  let sideEffects = 0
  const fetch = globalThis.fetch,
    log = console.log,
    warn = console.warn,
    error = console.error
  globalThis.fetch = (() => {
    sideEffects++
    throw new Error('network prohibited')
  }) as typeof fetch
  console.log =
    console.warn =
    console.error =
      () => {
        sideEffects++
      }
  try {
    if (phase === 'regressions') await regressions()
    else await restart(phase)
    equal(
      sideEffects,
      0,
      'no network calls or secret logging; zero-funds local activation',
    )
    return { assertions, cases, networkCallsAndLogs: sideEffects }
  } finally {
    // Crash phases leave connections and awaiting operations alive for SIGKILL.
    if (phase === 'reopen' || phase === 'regressions')
      for (const api of opened) api.close()
    globalThis.fetch = fetch
    console.log = log
    console.warn = warn
    console.error = error
  }
}
