import {
  beginCodex32Signup,
  decodeRecoveryDescriptor,
  exportCodex32Backup,
  destroyRecoveredAccount,
  recoverCodex32Shares,
  type RecoveryPublicMetadata,
} from '@frank/account-recovery'
import { createVaultWriteIntent, openPreviewVault } from '@frank/account-vault'
import { aad } from '../../../../../packages/account-vault/src/encoding'
import { DOMAIN_PURPOSES, type DomainRoot } from '@frank/domain-roots'
import {
  openAccountCustody,
  resetAccountCustody,
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type ExpectedActive,
  type StageAccount,
  type RetentionIntent,
} from '../index'

/** What staging takes, plus the roots that account root derives, for expectations only. */
type Fixture = StageAccount & { roots: readonly DomainRoot[] }

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
): Fixture {
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
    accountRoot: recovered.accountRoot,
  }
}
function erase(input: Fixture) {
  for (const root of input.roots) root.bytes.fill(0)
  input.accountRoot.fill(0)
}
function current(state: CustodySnapshot): ExpectedActive {
  return {
    revision: state.revision,
    accountId: state.active?.receipt.context.accountId ?? null,
  }
}
async function assertActive(api: AccountCustody, input: Fixture) {
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
/** Replace a committed vault record's plaintext, sealed with its own stored key and receipt. */
async function reseal(
  namespace: string,
  receipt: Parameters<typeof aad>[0],
  plaintext: Uint8Array<ArrayBuffer>,
) {
  const id = receipt.context.creationId
  let key: CryptoKey | undefined
  await storage(namespace, true, ['keys'], tx => {
    const request = tx.objectStore('keys').get(id)
    request.onsuccess = () => {
      key = request.result.key
    }
  })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(receipt), tagLength: 128 },
      key!,
      plaintext,
    ),
  )
  await storage(namespace, true, ['records'], tx => {
    const store = tx.objectStore('records'),
      request = store.get(id)
    request.onsuccess = () => {
      store.put({ ...request.result, iv, ciphertext }, id)
    }
  })
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
    const active = await api.retentionSnapshot()
    await api.acquireRetention({
      ...active.active!,
      operationId: 'restart-retention',
      expectedGeneration: active.nextGeneration,
    })
  } else {
    equal(
      await api.reconcile(input.attemptId),
      'active',
      'lost activation ack resolved from durable active pointer',
    )
    const retained = await api.retentionSnapshot()
    equal(retained.holds.length, 1, 'hold survived process crash')
    equal(retained.nextGeneration, 1, 'counter survived process crash')
    const state = await api.activate(input.attemptId, input.expectedActive)
    equal(
      (await api.retentionSnapshot()).holds,
      retained.holds,
      'already committed activation remains idempotent with hold',
    )
    await api.releaseRetention(retained.holds[0])
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

async function retentionRegressions() {
  const admit = async (
    api: AccountCustody,
    operationId: string,
  ): Promise<RetentionIntent> => {
    const snapshot = await api.retentionSnapshot()
    assert(snapshot.active !== null, 'retention requires an active incarnation')
    return {
      ...snapshot.active,
      operationId,
      expectedGeneration: snapshot.nextGeneration,
    }
  }
  const active = async (namespace: string) => {
    const api = await open(namespace),
      input = fixture(namespace)
    await api.stage(input)
    const state = await api.activate(input.attemptId, input.expectedActive)
    return { api, input, state }
  }
  await test('retention inspection is absent without creating namespaces or default rows', async () => {
    const before = (await indexedDB.databases()).map(db => db.name).sort()
    const api = await open('retention-absent')
    equal(
      await api.retentionSnapshot(),
      { active: null, nextGeneration: 0, holds: [] },
      'empty retention view',
    )
    equal(
      (await indexedDB.databases()).map(db => db.name).sort(),
      before,
      'no default retention database',
    )
  })
  await test('retention generations serialize independent admissions and survive release and reacquisition', async () => {
    const { api, input, state } = await active('retention-generations'),
      other = await open('retention-generations')
    const first = await admit(api, 'payment-a'),
      second = { ...first, operationId: 'payment-b' }
    const outcomes = await Promise.allSettled([
      api.acquireRetention(first),
      other.acquireRetention(second),
    ])
    equal(
      outcomes.filter(result => result.status === 'fulfilled').length,
      1,
      'one expected generation admits once',
    )
    const winner = outcomes.find(result => result.status === 'fulfilled')!
    assert(winner.status === 'fulfilled', 'hold admitted')
    const original = winner.value,
      intent = original.operationId === first.operationId ? first : second
    const unrelated = await other.acquireRetention(
      await admit(other, 'payment-c'),
    )
    equal(
      await api.acquireRetention(intent),
      original,
      'exact retry survives unrelated generation advance',
    )
    equal(
      await api.snapshot(),
      state,
      'hold changes preserve account and replacement revision',
    )
    const copied = await api.retentionSnapshot()
    ;(copied.holds as any[])[0].operationId = 'caller-mutated'
    equal(
      (await api.retentionSnapshot()).holds[0].operationId,
      original.operationId,
      'returned holds are copy-isolated',
    )
    equal(
      await api.releaseRetention(original),
      'released',
      'exact release succeeds',
    )
    equal(
      await api.releaseRetention(original),
      'absent',
      'duplicate release is absence, not settlement',
    )
    await rejects(() => api.acquireRetention(intent), 'conflict')
    const renewed = await other.acquireRetention(
      await admit(other, original.operationId),
    )
    await rejects(() => api.releaseRetention(original), 'conflict')
    equal(
      (await api.retentionSnapshot()).holds.length,
      2,
      'delayed release leaves fresh hold intact',
    )
    await api.releaseRetention(renewed)
    await api.releaseRetention(unrelated)
    equal(
      (await api.retentionSnapshot()).nextGeneration,
      3,
      'release never resets counter',
    )
    erase(input)
  })
  await test('retention is durable before acknowledgment and closed owners reconcile the original intent', async () => {
    const { api, input } = await active('retention-ack'),
      other = await open('retention-ack')
    const intent = await admit(api, 'lost-ack')
    const held = holdAcknowledgement(
      (store, value) =>
        store.name === 'state' &&
        Array.isArray(value.holds) &&
        value.holds.some((hold: any) => hold.operationId === 'lost-ack'),
    )
    let acknowledged = false
    const acquiring = api.acquireRetention(intent).then(value => {
      acknowledged = true
      return value
    })
    try {
      await held.reached
      assert(
        !acknowledged,
        'durable write completion must precede acknowledgment',
      )
      const extra = await other.acquireRetention(
        await admit(other, 'unrelated-ack'),
      )
      api.close()
      held.release()
      await rejects(() => acquiring, 'closed')
      const receipt = await other.acquireRetention(intent)
      equal(
        receipt.generation,
        0,
        'ambiguous caller retries exact original generation',
      )
      equal(
        (await other.retentionSnapshot()).nextGeneration,
        2,
        'retry consumes no new generation',
      )
      await other.releaseRetention(receipt)
      await other.releaseRetention(extra)
    } finally {
      held.release()
      erase(input)
    }
  })
  await test('retention snapshots input before await and rejects wrong incarnation or receipt', async () => {
    const { api, input } = await active('retention-input')
    const intent = structuredClone(await admit(api, 'input-owned'))
    const promised = api.acquireRetention(intent)
    ;(intent as any).expectedGeneration = 100
    ;(intent.accountReceipt.context as any).accountId = 'changed-after-call'
    const receipt = await promised
    equal(receipt.generation, 0, 'synchronous intent snapshot retained')
    const next = await admit(api, 'wrong')
    await rejects(
      () =>
        api.acquireRetention({
          ...next,
          accountRevision: next.accountRevision + 1,
        }),
      'conflict',
    )
    const foreign = fixture('foreign-incarnation', undefined, 19),
      temporary = await open('retention-foreign')
    const staged = await temporary.stage(foreign)
    await rejects(
      () =>
        api.acquireRetention({
          ...next,
          accountReceipt: staged.pending!.account.receipt,
        }),
      'conflict',
    )
    await rejects(
      () => api.acquireRetention({ ...next, expectedGeneration: -1 }),
      'invalid-input',
    )
    await api.releaseRetention(receipt)
    erase(input)
    erase(foreign)
  })
  await test('holds exclude replacement atomically while pending cancellation preserves active roots', async () => {
    const { api, input, state } = await active('retention-replacement'),
      other = await open('retention-replacement')
    const replacement = fixture('retention-replace-next', current(state), 21)
    await other.stage(replacement)
    const intent = await admit(api, 'in-flight-payment')
    const race = await Promise.allSettled([
      api.acquireRetention(intent),
      other.activate(replacement.attemptId, replacement.expectedActive),
    ])
    equal(
      race.filter(result => result.status === 'fulfilled').length,
      1,
      'hold and replacement cannot both win',
    )
    if (race[0].status === 'fulfilled') {
      await rejects(
        () => other.activate(replacement.attemptId, replacement.expectedActive),
        'conflict',
      )
      await assertActive(api, input)
      const retainedRoot = await api.exportAccountRoot()
      equal(
        Array.from(retainedRoot.accountRoot!),
        Array.from(input.accountRoot),
        'refused replacement retains exact account root',
      )
      retainedRoot.accountRoot?.fill(0)
      await other.cancel(replacement.attemptId)
      await assertActive(api, input)
      equal(
        (await api.retentionSnapshot()).holds.length,
        1,
        'cancelling pending account preserves active hold',
      )
      await api.releaseRetention(race[0].value)
      const next = fixture(
        'retention-after-release',
        current(await api.snapshot()),
        25,
      )
      await other.stage(next)
      const stagedBefore = await other.snapshot()
      const temporary = await api.acquireRetention(
        await admit(api, 'staged-precondition'),
      )
      await api.releaseRetention(temporary)
      equal(
        await other.snapshot(),
        stagedBefore,
        'hold changes preserve staged replacement preconditions',
      )
      await other.activate(next.attemptId, next.expectedActive)
      await assertActive(other, next)
      erase(next)
    } else {
      await rejects(() => api.acquireRetention(intent), 'conflict')
      await assertActive(other, replacement)
    }
    erase(input)
    erase(replacement)
  })
  await test('replacement winning first refuses stale retention and committed activation retry preserves a hold', async () => {
    const { api, input, state } = await active('retention-new-active')
    const oldIntent = await admit(api, 'old-incarnation')
    const replacement = fixture('retention-new-activation', current(state), 22)
    await api.stage(replacement)
    await api.activate(replacement.attemptId, replacement.expectedActive)
    await rejects(() => api.acquireRetention(oldIntent), 'conflict')
    const receipt = await api.acquireRetention(
      await admit(api, 'new-incarnation'),
    )
    await api.activate(replacement.attemptId, replacement.expectedActive)
    equal(
      (await api.retentionSnapshot()).holds,
      [receipt],
      'activation retry does not perform replacement',
    )
    await api.reconcile(input.attemptId)
    await assertActive(api, replacement)
    await api.releaseRetention(receipt)
    erase(input)
    erase(replacement)
  })
  await test('cleanup reauthorizes exact pending ownership before touching a retained active vault', async () => {
    const ns = 'retention-cleanup',
      { api, input, state } = await active(ns)
    const replacement = fixture('cleanup-pending', current(state), 23)
    await api.stage(replacement)
    const target = (await api.snapshot()).pending!.account.receipt
    const held = holdAcknowledgement(
      (store, value) =>
        store.name === 'state' && value.pending?.status === 'discarding',
    )
    const cancelling = api.cancel(replacement.attemptId)
    try {
      await held.reached
      const retained = await api.acquireRetention(
        await admit(api, 'cleanup-active'),
      )
      await storage(ns, false, ['state'], tx => {
        const store = tx.objectStore('state'),
          request = store.get('account')
        request.onsuccess = () =>
          store.put({ ...request.result, pending: null }, 'account')
      })
      held.release()
      await rejects(() => cancelling, 'conflict')
      await assertActive(api, input)
      const vault = await openPreviewVault({ namespace: ns })
      const pendingRoot = await vault.openAccountRoot(target)
      equal(
        Array.from(pendingRoot!),
        Array.from(replacement.accountRoot),
        'unowned pending target was not discarded',
      )
      pendingRoot?.fill(0)
      vault.close()
      await api.releaseRetention(retained)
    } finally {
      held.release()
      erase(input)
      erase(replacement)
    }
  })
  await test('retention capacity exhaustion and strict durability refusal never evict or acknowledge holds', async () => {
    const ns = 'retention-bounds',
      { api, input } = await active(ns)
    for (let i = 0; i < 64; i++)
      await api.acquireRetention(await admit(api, `capacity-${i}`))
    const full = await api.retentionSnapshot()
    await rejects(
      () =>
        api.acquireRetention({
          ...full.active!,
          operationId: 'capacity-extra',
          expectedGeneration: full.nextGeneration,
        }),
      'capacity',
    )
    equal(
      await api.retentionSnapshot(),
      full,
      'capacity leaves all holds unchanged',
    )
    for (const hold of full.holds) await api.releaseRetention(hold)
    await storage(ns, false, ['state'], tx =>
      tx
        .objectStore('state')
        .put(
          { schema: 1, nextGeneration: Number.MAX_SAFE_INTEGER, holds: [] },
          'retention-v1',
        ),
    )
    const exhausted = await admit(api, 'counter-exhausted')
    await rejects(() => api.acquireRetention(exhausted), 'capacity')
    const before = await api.retentionSnapshot()
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args)
      if (
        this.name === `frank-account-custody-${ns}` &&
        args[1] === 'readwrite'
      )
        Object.defineProperty(tx, 'durability', { value: 'relaxed' })
      return tx
    }
    try {
      await rejects(
        () =>
          api.releaseRetention({
            ...before.active!,
            operationId: 'absent',
            generation: 0,
          }),
        'storage-failed',
      )
    } finally {
      IDBDatabase.prototype.transaction = original
    }
    equal(
      await api.retentionSnapshot(),
      before,
      'strict refusal leaves durable authority unchanged',
    )
    erase(input)
  })
  await test('complete retention corruption and stale affinity block inspection and activation', async () => {
    const ns = 'retention-corrupt',
      { api, input, state } = await active(ns)
    const intent = await admit(api, 'corrupt-fixture')
    const receipt = await api.acquireRetention(intent)
    const replacement = fixture('corrupt-replacement', current(state), 24)
    await api.stage(replacement)
    const valid = { schema: 1, nextGeneration: 1, holds: [receipt] }
    for (const bad of [
      null,
      { ...valid, schema: 2 },
      { ...valid, extra: true },
      { ...valid, nextGeneration: 0 },
      { ...valid, holds: [receipt, receipt] },
      { ...valid, holds: [{ ...receipt, accountRevision: 99 }] },
      {
        ...valid,
        holds: [
          {
            ...receipt,
            accountReceipt: { ...receipt.accountReceipt, revision: 9 },
          },
        ],
      },
      { ...valid, holds: new Array(1) },
      { ...valid, nextGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, resetting: false },
      { ...valid, resetting: true },
    ]) {
      await storage(ns, false, ['state'], tx =>
        tx.objectStore('state').put(bad, 'retention-v1'),
      )
      await rejects(() => api.retentionSnapshot(), 'locked')
      await rejects(
        () => api.activate(replacement.attemptId, replacement.expectedActive),
        'locked',
      )
      let cleanupCalled = false
      await rejects(
        () =>
          api.reset(async () => {
            cleanupCalled = true
          }),
        'locked',
      )
      assert(!cleanupCalled, 'corrupt retention blocks reset before cleanup')
      await rejects(() => openAccountCustody({ namespace: ns }), 'locked')
    }
    await storage(ns, false, ['state'], tx =>
      tx.objectStore('state').put(valid, 'retention-v1'),
    )
    await assertActive(api, input)
    await api.releaseRetention(receipt)
    erase(input)
    erase(replacement)
  })
  await test('holds exclude reset atomically across independent instances and preserve durable generations', async () => {
    const ns = 'retention-reset-race',
      { api, input, state } = await active(ns),
      other = await open(ns)
    const pending = fixture('reset-race-pending', current(state), 26)
    const staged = await other.stage(pending)
    const intent = await admit(api, 'in-flight-swap')
    let cleanupRuns = 0
    const race = await Promise.allSettled([
      api.acquireRetention(intent),
      other.reset(async () => {
        cleanupRuns++
      }),
    ])
    equal(
      race.filter(result => result.status === 'fulfilled').length,
      1,
      'hold and reset cannot both win',
    )
    if (race[0].status === 'fulfilled') {
      equal(cleanupRuns, 0, 'winning hold prevents reset cleanup')
      await rejects(
        () =>
          other.reset(async () => {
            cleanupRuns++
          }),
        'conflict',
      )
      equal(cleanupRuns, 0, 'retained account refuses reset before cleanup')
      await assertActive(api, input)
      await api.releaseRetention(race[0].value)
      const afterReset = await other.reset(async () => {
        cleanupRuns++
      })
      equal(cleanupRuns, 1, 'released hold permits reset cleanup')
      equal(
        afterReset,
        { schema: 1, revision: 0, active: null, pending: null },
        'reset clears active and pending records',
      )
    } else {
      equal(cleanupRuns, 1, 'winning reset runs cleanup once')
      await rejects(() => api.acquireRetention(intent), 'conflict')
    }
    const postResetRetention = await api.retentionSnapshot()
    assert(
      postResetRetention.active === null &&
        postResetRetention.holds.length === 0 &&
        postResetRetention.nextGeneration >= 1,
      'reset preserves custody namespace and advances durable generation',
    )
    await rejects(() => api.acquireRetention(intent), 'conflict')
    const vault = await openPreviewVault({ namespace: ns })
    equal(
      await vault.reconcile(state.active!.receipt),
      'removed',
      'active vault slot retired by reset',
    )
    equal(
      await vault.reconcile(staged.pending!.account.receipt),
      'removed',
      'pending vault slot retired by reset',
    )
    vault.close()
    const successor = fixture(
      'reset-race-successor',
      { revision: 0, accountId: null },
      27,
    )
    await api.stage(successor)
    await api.activate(successor.attemptId, successor.expectedActive)
    await assertActive(api, successor)
    equal(
      (await api.retentionSnapshot()).nextGeneration,
      postResetRetention.nextGeneration,
      'subsequent activation preserves post-reset generation',
    )
    erase(input)
    erase(pending)
    erase(successor)
  })
  await test('reset fences admission across its destructive lifecycle and recovers after interrupted cleanup', async () => {
    const ns = 'retention-reset-fence',
      { api, input, state } = await active(ns),
      other = await open(ns)
    const staged = fixture('reset-fence-staged', current(state), 28)
    await api.stage(staged)
    const preResetIntent = await admit(api, 'pre-reset-intent')
    const reachedCleanup = deferred(),
      releaseCleanup = deferred()
    let shouldFailCleanup = true
    const failingReset = resetAccountCustody({
      namespace: ns,
      async cleanup() {
        reachedCleanup.resolve()
        await releaseCleanup.promise
        if (shouldFailCleanup) throw new CustodyError('unavailable')
      },
    })
    await reachedCleanup.promise
    await rejects(() => other.snapshot(), 'locked')
    await rejects(() => other.retentionSnapshot(), 'locked')
    await rejects(() => other.openActive(), 'locked')
    await rejects(() => other.exportAccountRoot(), 'locked')
    await rejects(() => other.acquireRetention(preResetIntent), 'conflict')
    const blockedStage = fixture(
      'reset-fence-blocked',
      { revision: 0, accountId: null },
      29,
    )
    await rejects(() => other.stage(blockedStage), 'conflict')
    await rejects(
      () => other.activate(staged.attemptId, staged.expectedActive),
      'conflict',
    )
    await rejects(() => other.cancel(staged.attemptId), 'conflict')
    await rejects(() => other.reconcile(staged.attemptId), 'conflict')
    await rejects(() => other.openPending(staged.attemptId), 'conflict')
    releaseCleanup.resolve()
    await rejects(() => failingReset, 'unavailable')
    // Interrupted reset remains fenced until a retry completes cleanup.
    const reopened = await open(ns)
    await rejects(() => reopened.snapshot(), 'locked')
    await rejects(() => reopened.acquireRetention(preResetIntent), 'conflict')
    shouldFailCleanup = false
    let retriedCleanup = 0
    const completed = await resetAccountCustody({
      namespace: ns,
      async cleanup() {
        retriedCleanup++
      },
    })
    equal(retriedCleanup, 1, 'retry executes cleanup and completes reset')
    equal(
      completed,
      { schema: 1, revision: 0, active: null, pending: null },
      'completed reset restores fresh snapshot',
    )
    equal(
      await reopened.retentionSnapshot(),
      { active: null, nextGeneration: 1, holds: [] },
      'interrupted reset retry does not double-increment generation',
    )
    erase(input)
    erase(staged)
    erase(blockedStage)
  })
  await test('reset revokes local untaken capabilities and a paused reset cannot clobber a post-reset successor', async () => {
    const ns = 'retention-reset-late',
      { api, input } = await active(ns),
      other = await open(ns)
    const capability = await api.openActive()
    const reached = deferred(),
      resume = deferred()
    const slowReset = api.reset(async () => {
      reached.resolve()
      await resume.promise
    })
    await reached.promise
    let capCode = ''
    try {
      capability.takeRoots()
    } catch (error) {
      capCode = (error as CustodyError).code
    }
    equal(
      capCode,
      'closed',
      'reset revokes untaken capabilities on the resetting facade',
    )
    await other.reset()
    const successor = fixture(
      'reset-late-successor',
      { revision: 0, accountId: null },
      30,
    )
    await other.stage(successor)
    await other.activate(successor.attemptId, successor.expectedActive)
    resume.resolve()
    await rejects(() => slowReset, 'conflict')
    await assertActive(other, successor)
    await rejects(
      () => api.reset('not-a-function' as unknown as () => Promise<void>),
      'invalid-input',
    )
    await rejects(
      () =>
        resetAccountCustody({
          namespace: ns,
          cleanup: 'not-a-function' as unknown as () => Promise<void>,
        }),
      'invalid-input',
    )
    erase(input)
    erase(successor)
  })
}

async function regressions() {
  await retentionRegressions()
  await test('absent inspection creates no namespaces and observes later authorized creation', async () => {
    const inventory = async () =>
      (await indexedDB.databases()).map(db => db.name).sort()
    const before = await inventory()
    const reader = await open('read-only-absent')
    equal(
      await reader.snapshot(),
      { schema: 1, revision: 0, active: null, pending: null },
      'empty public snapshot',
    )
    await rejects(() => reader.openActive(), 'locked')
    equal(
      await inventory(),
      before,
      'read-only custody does not create databases',
    )
    const writer = await open('read-only-absent'),
      input = fixture('read-only-later')
    await writer.stage(input)
    await writer.activate(input.attemptId, input.expectedActive)
    await assertActive(reader, input)
    erase(input)
  })
  await test('close during lazy vault open refuses material and releases late connections', async () => {
    const ns = 'closed-lazy-vault',
      writer = await open(ns),
      input = fixture('closed-lazy-vault')
    await writer.stage(input)
    await writer.activate(input.attemptId, input.expectedActive)
    writer.close()
    const reader = await open(ns),
      arrived = deferred(),
      release = deferred()
    const original = IDBFactory.prototype.open
    IDBFactory.prototype.open = function (...args) {
      const request = original.apply(this, args)
      if (args[0] === `frank-preview-vault-${ns}`) {
        let handler:
          | ((this: IDBOpenDBRequest, event: Event) => unknown)
          | null = null
        Object.defineProperty(request, 'onsuccess', {
          set(value) {
            handler = value
          },
        })
        request.addEventListener('success', event => {
          arrived.resolve()
          void release.promise.then(() => handler?.call(request, event))
        })
      }
      return request
    }
    try {
      const opening = reader.openActive()
      await arrived.promise
      reader.close()
      release.resolve()
      await rejects(() => opening, 'closed')
    } finally {
      release.resolve()
      IDBFactory.prototype.open = original
      erase(input)
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(`frank-preview-vault-${ns}`)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () =>
        reject(new Error('late vault connection leaked'))
    })
  })

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
      { displayName: ' untrimmed' },
      { displayName: String.fromCharCode(0) },
      { custodyEpoch: -1 },
      { attemptId: 'space forbidden' },
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
    erase(input)
  })

  await test('only the account root of the staged account is accepted', async () => {
    const api = await open('account-root-input'),
      input = fixture('account-root-input'),
      other = fixture('account-root-other', undefined, 5)
    for (const accountRoot of [
      // The defect this guards: a derived domain root offered as the account root.
      ...input.roots.map(root => root.bytes),
      other.accountRoot,
      new Uint8Array(32).fill(9),
      new Uint8Array(31),
      undefined as unknown as Uint8Array,
    ])
      await rejects(() => api.stage({ ...input, accountRoot }), 'invalid-input')
    equal(
      (await api.snapshot()).pending,
      null,
      'a wrong account root persists nothing',
    )
    erase(input)
    erase(other)
  })

  await test('a backup issued from stored custody restores the same account in a fresh store', async () => {
    const original = fixture('backup-original', undefined, 21)
    const expectedRoots = original.roots.map(root => Array.from(root.bytes))
    let api = await open('backup-source')
    const staged = await api.stage(original)
    const descriptor = staged.pending!.account.descriptor
    await api.activate(original.attemptId, original.expectedActive)
    erase(original)
    // Nothing from signup survives in memory: reopen custody as a later session would.
    api.close()
    api = await open('backup-source')
    const issue = async () => {
      const exported = await api.exportAccountRoot()
      assert(exported.accountRoot !== null, 'new accounts keep their root')
      equal(exported.account.descriptor, descriptor, 'export names the account')
      assert(
        !JSON.stringify(exported.account).includes('bytes'),
        'exported account metadata is public',
      )
      try {
        return exportCodex32Backup({
          accountRoot: exported.accountRoot,
          expected: decodeRecoveryDescriptor(exported.account.descriptor),
          threshold: 2,
          shareCount: 3,
          randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
        })
      } finally {
        exported.accountRoot.fill(0)
      }
    }
    const first = await issue(),
      second = await issue()
    for (const [name, shares] of [
      ['first', first.slice(0, 2)],
      ['second', second.slice(1, 3)],
    ] as const) {
      const recovered = recoverCodex32Shares(shares)
      const restored = await open(`backup-restored-${name}`)
      const input: StageAccount = {
        attemptId: `backup-restored-${name}`,
        accountId: `restored-${name}`,
        displayName: 'Restored account',
        expectedActive: { revision: 0, accountId: null },
        custodyEpoch: 1,
        metadata: recovered.metadata,
        accountRoot: recovered.accountRoot,
      }
      const pending = await restored.stage(input)
      equal(
        pending.pending!.account.descriptor,
        descriptor,
        'restored account has the original public descriptor',
      )
      await restored.activate(input.attemptId, input.expectedActive)
      destroyRecoveredAccount(recovered)
      const capability = await restored.openActive()
      const roots = capability.takeRoots()
      equal(
        roots.map(root => Array.from(root.bytes)),
        expectedRoots,
        'every restored root equals the original',
      )
      roots.forEach(root => root.bytes.fill(0))
      capability.close()
      // And the restored device can issue its own honest backup.
      const again = await restored.exportAccountRoot()
      assert(again.accountRoot !== null, 'restored accounts keep their root')
      again.accountRoot.fill(0)
    }
    let mixed = ''
    try {
      recoverCodex32Shares([first[0], second[1]])
    } catch (error) {
      mixed = (error as { code?: string }).code ?? ''
    }
    equal(mixed, 'inconsistent-share', 'shares of two backups do not combine')
  })

  await test('staging reads the stored account root back and refuses a record that cannot reproduce the account', async () => {
    const api = await open('stage-readback'),
      input = fixture('stage-readback', undefined, 23)
    const staged = await api.stage(input)
    const receipt = staged.pending!.account.receipt
    // A different account root, as a bad write would leave.
    const bad = Uint8Array.of(3, ...new Uint8Array(32).fill(77))
    await reseal('stage-readback', receipt, bad)
    await rejects(() => api.stage(input), 'conflict')
    await rejects(() => api.reconcile(input.attemptId), 'conflict')
    await rejects(
      () => api.activate(input.attemptId, input.expectedActive),
      'conflict',
    )
    equal((await api.snapshot()).active, null, 'nothing was activated')
    erase(input)
  })

  await test('an attempt staged before account roots were kept cannot be activated, only cancelled', async () => {
    const api = await open('outdated-attempt'),
      input = fixture('outdated-attempt', undefined, 24)
    const staged = await api.stage(input)
    const older = new Uint8Array(2 + input.roots.length * 33)
    older[0] = 1
    older[1] = input.roots.length
    input.roots.forEach((root, i) => {
      older[2 + i * 33] = DOMAIN_PURPOSES.indexOf(root.purpose) + 1
      older.set(root.bytes, 3 + i * 33)
    })
    await reseal('outdated-attempt', staged.pending!.account.receipt, older)
    await rejects(() => api.reconcile(input.attemptId), 'outdated-attempt')
    await rejects(
      () => api.activate(input.attemptId, input.expectedActive),
      'outdated-attempt',
    )
    const cancelled = await api.cancel(input.attemptId)
    equal(cancelled.pending, null, 'the outdated attempt can be cancelled')
    equal(cancelled.active, null, 'and nothing was activated')
    erase(input)
  })

  await test('an account stored before account roots were kept reports that it has none', async () => {
    const api = await open('backup-older'),
      input = fixture('backup-older', undefined, 22)
    const staged = await api.stage(input)
    const receipt = staged.pending!.account.receipt
    await api.activate(input.attemptId, input.expectedActive)
    // Rewrite the vault record in the framing used before this change: typed roots only.
    const older = new Uint8Array(2 + input.roots.length * 33)
    older[0] = 1
    older[1] = input.roots.length
    // Stored roots that are deliberately not what any account root here derives: an older
    // account runs on exactly what its record holds.
    const expectedRoots = input.roots.map(root =>
      Array.from(root.bytes, byte => byte ^ 0x5a),
    )
    input.roots.forEach((root, i) => {
      older[2 + i * 33] = DOMAIN_PURPOSES.indexOf(root.purpose) + 1
      older.set(expectedRoots[i], 3 + i * 33)
    })
    erase(input)
    await reseal('backup-older', receipt, older)
    const record = async () => {
      let row: { iv: Uint8Array; ciphertext: Uint8Array } | undefined
      await storage('backup-older', true, ['records'], tx => {
        const request = tx.objectStore('records').get(input.attemptId)
        request.onsuccess = () => {
          row = request.result
        }
      })
      return [Array.from(row!.iv), Array.from(row!.ciphertext)]
    }
    const before = await record()
    // A later session: reopen custody and use the account.
    api.close()
    const later = await open('backup-older')
    const exported = await later.exportAccountRoot()
    equal(exported.accountRoot, null, 'no account root, and none is invented')
    const capability = await later.openActive()
    const roots = capability.takeRoots()
    equal(
      roots.map(root => Array.from(root.bytes)),
      expectedRoots,
      'the older account still opens with exactly its stored roots',
    )
    roots.forEach(root => root.bytes.fill(0))
    capability.close()
    equal(await record(), before, 'opening an older account rewrites nothing')
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
            input.accountRoot,
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
    const originalAccountRoot = Array.from(input.accountRoot)
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
      !json.includes(JSON.stringify(originalAccountRoot)),
      'no serialized account root',
    )
    assert(
      Object.isFrozen(staged) &&
        Object.isFrozen(staged.pending!.account.receipt.context.purposes),
      'public snapshots do not permit mutation',
    )
    await api.activate(input.attemptId, input.expectedActive)
    await assertActive(api, { ...input, roots: originalRoots })
    const kept = await api.exportAccountRoot()
    equal(
      Array.from(kept.accountRoot ?? []),
      originalAccountRoot,
      'account root captured before the caller erased its copy',
    )
    kept.accountRoot?.fill(0)
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
      const inspecting = await open('unsupported-existing')
      equal(
        await inspecting.snapshot(),
        supportedBefore,
        'public read requires no key clone',
      )
      await assertActive(inspecting, supportedInput)
      const newInput = fixture('unsupported-new', current(supportedBefore), 13)
      try {
        await rejects(() => inspecting.stage(newInput), 'unavailable')
      } finally {
        erase(newInput)
      }
    } finally {
      IDBObjectStore.prototype.put = clone
    }
    equal(
      (await supported.snapshot()).active,
      supportedBefore.active,
      'failed mutation capability probe never changes existing active account',
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
