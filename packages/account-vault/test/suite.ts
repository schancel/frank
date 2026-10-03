import { DOMAIN_PURPOSES, DERIVATION_REGISTRY_ID, RECOVERY_FORMAT_ID, type DomainRoot } from '@frank/domain-roots'
import { createVaultWriteIntent, openPreviewVault, VaultError, type VaultContext, type VaultReceipt, type VaultWriteIntent } from '../src/index.js'

let assertions = 0
function ok(value: unknown, message: string): asserts value {
  assertions++
  if (!value) throw new Error(message)
}
async function fails(operation: () => unknown, code: string): Promise<void> {
  try { await operation() } catch (error) {
    ok(error instanceof VaultError && error.code === code && error.message === `Preview vault: ${code}`,
      `expected stable ${code}, got ${String(error)}`); return
  }
  throw new Error(`expected failure: ${code}`)
}
function context(id: string): VaultContext {
  return { accountId: `account-${id}`, creationId: id, recoveryFormat: RECOVERY_FORMAT_ID,
    registry: DERIVATION_REGISTRY_ID, purposes: DOMAIN_PURPOSES, custodyEpoch: 1,
    recoveryFingerprint: 'public-fixture-fingerprint', retirementContext: '' }
}
function roots(seed = 17): DomainRoot[] {
  return DOMAIN_PURPOSES.map((purpose, index) => ({ purpose, registry: DERIVATION_REGISTRY_ID,
    bytes: Uint8Array.from({ length: 32 }, (_, byte) => (seed + index * 32 + byte) & 255) }))
}
function initial(id: string): VaultWriteIntent {
  return createVaultWriteIntent({ context: context(id), expected: null, operationId: `write-${id}` })
}
function next(expected: VaultReceipt, operationId = 'replacement'): VaultWriteIntent {
  return createVaultWriteIntent({ context: { ...expected.context, custodyEpoch: expected.context.custodyEpoch + 1 }, expected, operationId })
}
function equalRoots(actual: readonly DomainRoot[], expected: readonly DomainRoot[]) {
  ok(actual.length === expected.length && actual.every((r, i) => r.purpose === expected[i].purpose &&
    r.registry === expected[i].registry && r.bytes.every((b, j) => b === expected[i].bytes[j])), 'root roundtrip')
}
async function raw(namespace: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`frank-preview-vault-${namespace}`)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function row(namespace: string, store: string, id: string): Promise<any> {
  const db = await raw(namespace)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store), request = tx.objectStore(store).get(id)
      tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
async function change(namespace: string, store: string, id: string, mutate: (value: any) => any) {
  const db = await raw(namespace)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite'), objectStore = tx.objectStore(store)
      const request = objectStore.get(id)
      request.onsuccess = () => {
        const value = mutate(request.result)
        if (value === undefined) objectStore.delete(id); else objectStore.put(value, id)
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
async function nonExtractable(namespace: string, receipt: VaultReceipt) {
  const value = await row(namespace, 'keys', receipt.context.creationId)
  ok(value.key instanceof CryptoKey && !value.key.extractable, 'stored key non-extractable')
  for (const format of ['raw', 'jwk'] as const) {
    let rejected = false
    try { await crypto.subtle.exportKey(format, value.key) } catch { rejected = true }
    ok(rejected, `export ${format} rejected`)
  }
}

export async function run(phase: string) {
  if (phase === 'create' || phase === 'reopen') {
    const vault = await openPreviewVault({ namespace: 'restart' })
    const intent = initial('restart')
    if (phase === 'create') {
      await vault.stage(intent, roots())
      await vault.discardIntent(initial('restart-absent-discard'))
      const committedDiscard = initial('restart-committed-discard')
      await vault.stage(committedDiscard, roots())
      await vault.discardIntent(committedDiscard)
      // Only public coordinator state, never plaintext, is serialized.
      localStorage.setItem('vault-intent', JSON.stringify(intent))
    } else {
      const saved = JSON.parse(localStorage.getItem('vault-intent')!) as VaultWriteIntent
      ok(await vault.reconcile(saved.receipt) === 'committed', 'persisted intent reconciles in fresh browser')
    }
    for (const id of ['restart-absent-discard', 'restart-committed-discard']) {
      const discarded = initial(id)
      // Treat the original response as lost; a fresh process must prove exact ownership.
      await vault.discardIntent(discarded)
      ok(await vault.reconcile(discarded.receipt) === 'removed', 'discard retry survives process restart')
      await fails(() => vault.open(discarded.receipt), 'locked')
      await fails(() => vault.stage(discarded, roots()), 'conflict')
      await fails(() => vault.discardIntent(createVaultWriteIntent({ context: discarded.receipt.context,
        expected: null, operationId: 'foreign-operation' })), 'conflict')
    }
    equalRoots(await vault.open(intent.receipt), roots())
    await nonExtractable('restart', intent.receipt)
    vault.close(); vault.close()
    await fails(() => vault.open(intent.receipt), 'closed')
    return { assertions }
  }

  const ns = 'regressions'
  const vault = await openPreviewVault({ namespace: ns })
  const other = await openPreviewVault({ namespace: ns })
  // Cancellation can win before the very first crypto preparation has committed.
  const cancelled = initial('cancel-before-stage')
  const encryptBeforeCancel = SubtleCrypto.prototype.encrypt
  let resumeCancel!: () => void, beginCancel!: () => void
  const cancelGate = new Promise<void>(resolve => { resumeCancel = resolve })
  const cancelStarted = new Promise<void>(resolve => { beginCancel = resolve })
  SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
    beginCancel(); await cancelGate; return encryptBeforeCancel.apply(this, args)
  }
  const cancelledStage = vault.stage(cancelled, roots())
  try {
    await cancelStarted
    ok(await other.reconcile(cancelled.receipt) === 'absent', 'paused initial stage is absent')
    await other.discardIntent(cancelled)
    resumeCancel()
    await fails(() => cancelledStage, 'conflict')
  } finally { resumeCancel(); SubtleCrypto.prototype.encrypt = encryptBeforeCancel }
  ok(await vault.reconcile(cancelled.receipt) === 'removed', 'absent cancellation retains a fence')
  await fails(() => vault.open(cancelled.receipt), 'locked')
  await vault.discardIntent(cancelled)
  const cancelledFence = await row(ns, 'fences', cancelled.receipt.context.creationId)
  ok(JSON.stringify(cancelledFence) === JSON.stringify({ revision: 2, receipt: null, discardedIntent: cancelled }),
    'discard stores only bounded public intent evidence')

  // Commit-before-cancel and simultaneous calls across independent facade connections.
  const preserved = initial('discard-preserved'), committedDiscard = initial('discard-committed')
  await vault.stage(preserved, roots(44))
  await vault.stage(committedDiscard, roots())
  let resumeReplacement!: () => void, beginReplacement!: () => void
  const replacementGate = new Promise<void>(resolve => { resumeReplacement = resolve })
  const replacementStarted = new Promise<void>(resolve => { beginReplacement = resolve })
  SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
    beginReplacement(); await replacementGate; return encryptBeforeCancel.apply(this, args)
  }
  const lateReplacement = vault.stage(next(committedDiscard.receipt), roots(33))
  try {
    await replacementStarted
    await other.discardIntent(committedDiscard)
    resumeReplacement()
    await fails(() => lateReplacement, 'conflict')
  } finally { resumeReplacement(); SubtleCrypto.prototype.encrypt = encryptBeforeCancel }
  await vault.discardIntent(committedDiscard)
  equalRoots(await vault.open(preserved.receipt), roots(44))
  for (const store of ['records', 'keys']) {
    ok(await row(ns, store, committedDiscard.receipt.context.creationId) === undefined, 'exact discard deletes material')
  }
  for (let i = 0; i < 4; i++) {
    const item = initial(`discard-race-${i}`)
    const results = await Promise.allSettled([vault.stage(item, roots()), other.discardIntent(item)])
    ok(results[1].status === 'fulfilled', 'concurrent discard succeeds in either ordering')
    if (results[0].status === 'rejected') ok(results[0].reason instanceof VaultError && results[0].reason.code === 'conflict', 'late stage conflicts')
    ok(await vault.reconcile(item.receipt) === 'removed', 'no live material after concurrent discard success')
    await fails(() => vault.open(item.receipt), 'locked')
  }
  for (const item of [cancelled, committedDiscard, preserved]) {
    for (const update of [{ operationId: 'foreign-operation' },
      { context: { ...item.receipt.context, accountId: 'foreign-account' } },
      { context: { ...item.receipt.context, custodyEpoch: 2 } },
      { context: { ...item.receipt.context, recoveryFingerprint: 'foreign-fingerprint' } },
      { context: { ...item.receipt.context, retirementContext: 'foreign-retirement' } },
      { context: { ...item.receipt.context, purposes: [DOMAIN_PURPOSES[0]] } }]) {
      await fails(() => vault.discardIntent({ expected: null, receipt: { ...item.receipt, ...update } }), 'conflict')
    }
  }
  equalRoots(await vault.open(preserved.receipt), roots(44))
  const superseded = initial('discard-superseded'), replacement = next(superseded.receipt)
  await vault.stage(superseded, roots())
  await vault.stage(replacement, roots(55))
  await fails(() => other.discardIntent(superseded), 'conflict')
  equalRoots(await vault.open(replacement.receipt), roots(55))
  await other.discardIntent(replacement)
  await vault.discardIntent(replacement)
  await fails(() => vault.discardIntent({ ...replacement, expected: { ...superseded.receipt, operationId: 'foreign-predecessor' } }), 'conflict')
  const absentReplacement = next(initial('discard-absent-replacement').receipt)
  await fails(() => vault.discardIntent(absentReplacement), 'conflict')
  ok(await vault.reconcile(absentReplacement.receipt) === 'absent', 'absent replacement leaves no fence')
  const legacy = initial('discard-legacy')
  await vault.stage(legacy, roots()); await vault.remove(legacy.receipt)
  await fails(() => vault.discardIntent(legacy), 'conflict')
  await vault.remove(legacy.receipt)
  ok(await vault.reconcile(legacy.receipt) === 'removed', 'legacy removal remains readable and retryable')
  // Existing remove can read new tombstones without erasing their stronger retry proof.
  await vault.remove(committedDiscard.receipt)
  await vault.discardIntent(committedDiscard)

  const mutableDiscard = structuredClone(initial('discard-snapshot'))
  const savedDiscard = structuredClone(mutableDiscard)
  const snapshotDiscard = vault.discardIntent(mutableDiscard)
  ;(mutableDiscard.receipt.context as { accountId: string }).accountId = 'changed-after-call'
  ;(mutableDiscard.receipt as { operationId: string }).operationId = 'changed-after-call'
  await snapshotDiscard
  await vault.discardIntent(savedDiscard)
  await fails(() => vault.discardIntent(mutableDiscard), 'conflict')
  await fails(() => vault.discardIntent({ get receipt(): VaultReceipt { throw new Error('private-fixture-detail') }, expected: null }), 'invalid-input')
  await fails(() => vault.discardIntent({ ...savedDiscard, expected: undefined } as unknown as VaultWriteIntent), 'invalid-input')

  // Missing authorization and orphan material must be preserved for coordinator recovery.
  for (const damage of ['missing-fence', 'orphan-record', 'orphan-key', 'bad-fence', 'bad-revision', 'bad-evidence', 'live-evidence']) {
    const item = initial(`discard-damage-${damage}`), id = item.receipt.context.creationId
    await vault.stage(item, roots())
    if (damage === 'missing-fence' || damage.startsWith('orphan-')) {
      await change(ns, 'fences', id, () => undefined)
      if (damage === 'orphan-record') await change(ns, 'keys', id, () => undefined)
      if (damage === 'orphan-key') await change(ns, 'records', id, () => undefined)
    } else await change(ns, 'fences', id, r => {
      if (damage === 'bad-fence') return null
      if (damage === 'bad-revision') return { ...r, revision: 10 }
      if (damage === 'bad-evidence') return { revision: 2, receipt: null, discardedIntent: {} }
      return { ...r, discardedIntent: item }
    })
    const before = JSON.stringify(await row(ns, 'fences', id))
    await fails(() => vault.discardIntent(item), 'corrupt')
    ok(JSON.stringify(await row(ns, 'fences', id)) === before, 'bad authorization fence remains unchanged')
    ok((await row(ns, 'keys', id) !== undefined) === (damage !== 'orphan-record'), 'unauthorized key inventory preserved')
    ok((await row(ns, 'records', id) !== undefined) === (damage !== 'orphan-key'), 'unauthorized record inventory preserved')
  }
  // As with remove, an exact live fence can authorize cleanup of damaged material.
  const damagedMaterial = initial('discard-damaged-material')
  await vault.stage(damagedMaterial, roots())
  await change(ns, 'keys', damagedMaterial.receipt.context.creationId, () => undefined)
  await change(ns, 'records', damagedMaterial.receipt.context.creationId, r => ({ ...r, ciphertext: new Uint8Array(1) }))
  await vault.discardIntent(damagedMaterial)
  ok(await vault.reconcile(damagedMaterial.receipt) === 'removed', 'exact live fence authorizes damaged-material cleanup')

  const discardPut = IDBObjectStore.prototype.put
  const discardDelete = IDBObjectStore.prototype.delete
  for (const absent of [false, true]) {
    for (const failure of ['abort', 'put', 'delete']) {
      const item = initial(`discard-failure-${absent}-${failure}`)
      if (!absent) await vault.stage(item, roots())
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
        if (this.name === 'fences' && failure !== 'delete') {
          if (failure === 'abort') this.transaction.abort()
          else throw new DOMException('private-fixture-storage-detail')
        }
        return discardPut.apply(this, args)
      }
      IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
        if (this.name === 'keys' && failure === 'delete') throw new DOMException('private-fixture-storage-detail')
        return discardDelete.apply(this, args)
      }
      try { await fails(() => vault.discardIntent(item), 'storage-failed') }
      finally { IDBObjectStore.prototype.put = discardPut; IDBObjectStore.prototype.delete = discardDelete }
      ok(await vault.reconcile(item.receipt) === (absent ? 'absent' : 'committed'), 'failed discard cannot partially commit')
      if (!absent) equalRoots(await vault.open(item.receipt), roots())
      await vault.discardIntent(item)
    }
  }
  const closedDiscard = await openPreviewVault({ namespace: ns })
  closedDiscard.close()
  await fails(() => closedDiscard.discardIntent(preserved), 'closed')
  equalRoots(await vault.open(preserved.receipt), roots(44))
  const discardTransaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[1] === 'readwrite') throw new DOMException('private-fixture-transaction-detail')
    return discardTransaction.apply(this, args)
  }
  try { await fails(() => vault.discardIntent(preserved), 'storage-failed') }
  finally { IDBDatabase.prototype.transaction = discardTransaction }
  equalRoots(await vault.open(preserved.receipt), roots(44))
  for (const kind of ['accessor', 'proxy']) {
    const original = initial(`purpose-${kind}`)
    await vault.stage(original, roots())
    const replacement = next(original.receipt)
    const replacementRoots = roots(45)
    let reads = 0
    const purpose = () => ++reads === 1 ? DOMAIN_PURPOSES[0] : DOMAIN_PURPOSES[1]
    replacementRoots[0] = kind === 'accessor'
      ? { ...replacementRoots[0], get purpose() { return purpose() } }
      : new Proxy(replacementRoots[0], { get(target, key, receiver) {
        return key === 'purpose' ? purpose() : Reflect.get(target, key, receiver)
      } })
    await vault.stage(replacement, replacementRoots)
    equalRoots(await vault.open(replacement.receipt), roots(45))
    ok(reads === 1, `${kind} purpose read once and replacement remains readable`)
  }
  const first = initial('first')
  const input = roots()
  const staged = vault.stage(first, input)
  input.forEach(r => r.bytes.fill(0))
  await staged
  equalRoots(await vault.open(first.receipt), roots())
  const output = await vault.open(first.receipt)
  output[0].bytes.fill(0)
  equalRoots(await vault.open(first.receipt), roots())
  ok(await vault.reconcile(first.receipt) === 'committed', 'lost acknowledgement reconciliation')
  await fails(() => vault.stage(first, roots(45)), 'conflict')
  equalRoots(await vault.open(first.receipt), roots())
  ok(await vault.reconcile(initial('never').receipt) === 'absent', 'unstaged intent absent')

  const publicRecord = await row(ns, 'records', 'first')
  const serialized = JSON.stringify({ app: first, ciphertext: { ...publicRecord, iv: Array.from(publicRecord.iv), ciphertext: Array.from(publicRecord.ciphertext) } })
  for (const root of roots()) {
    ok(!serialized.includes(JSON.stringify(Array.from(root.bytes))), 'no root array in ordinary serialized state')
    ok(!serialized.includes(Array.from(root.bytes, b => b.toString(16).padStart(2, '0')).join('')), 'no hex root in ordinary serialized state')
  }
  ok(!('key' in publicRecord) && !serialized.includes('"bytes"'), 'ciphertext export excludes key store and raw roots')
  await nonExtractable(ns, first.receipt)

  for (const bad of [
    { ...context('bad'), registry: 'other' }, { ...context('bad'), purposes: ['identity-authentication', 'evm-wallet'] },
    { ...context('bad'), purposes: ['evm-wallet', 'evm-wallet'] }, { ...context('bad'), accountId: 'x'.repeat(129) },
    { ...context('bad'), custodyEpoch: -1 }, { ...context('bad'), recoveryFormat: 'bip39' },
  ]) await fails(() => createVaultWriteIntent({ context: bad as VaultContext, expected: null, operationId: 'bad' }), 'invalid-input')
  for (const badRoots of [[], [{ ...roots()[0], bytes: new Uint8Array(31) }, ...roots().slice(1)],
    [{ ...roots()[0], registry: 'other' }, ...roots().slice(1)], roots().reverse()]) {
    await fails(() => vault.stage(initial('bad-input'), badRoots as DomainRoot[]), 'invalid-input')
  }
  ok(await vault.reconcile(initial('bad-input').receipt) === 'absent', 'invalid input has no storage effects')
  const thrown = new Error('caller-controlled-secret-like-error')
  const throwingRoot = { ...roots()[0], get bytes(): Uint8Array { throw thrown } }
  await fails(() => vault.stage(initial('throwing-input'), [throwingRoot, ...roots().slice(1)]), 'invalid-input')
  await fails(() => createVaultWriteIntent({ get context(): VaultContext { throw thrown }, expected: null, operationId: 'bad' }), 'invalid-input')
  await fails(() => vault.open({ ...first.receipt, get context(): VaultContext { throw thrown } }), 'invalid-input')
  let purposeLengthReads = 0, rootLengthReads = 0
  const purposeProxy = new Proxy([...DOMAIN_PURPOSES], { get(target, key, receiver) {
    if (key === Symbol.iterator) throw new Error('caller iterator must not run')
    if (key === 'length') { purposeLengthReads++; return purposeLengthReads === 1 ? 5 : 1000000000 }
    return Reflect.get(target, key, receiver)
  } })
  const boundedIntent = createVaultWriteIntent({ context: { ...context('bounded-input'), purposes: purposeProxy }, expected: null, operationId: 'bounded-input' })
  const rootProxy = new Proxy(roots(), { get(target, key, receiver) {
    if (key === 'length') { rootLengthReads++; return rootLengthReads === 1 ? 5 : 1000000000 }
    return Reflect.get(target, key, receiver)
  } })
  await vault.stage(boundedIntent, rootProxy)
  ok(purposeLengthReads === 1 && rootLengthReads === 1, 'caller collection bounds read exactly once')
  equalRoots(await vault.open(boundedIntent.receipt), roots())

  // Observe owned plaintext passed to WebCrypto, then ensure the vault zeroes it on either outcome.
  const originalEncrypt = SubtleCrypto.prototype.encrypt
  const originalDecrypt = SubtleCrypto.prototype.decrypt
  let owned: Uint8Array | undefined
  SubtleCrypto.prototype.encrypt = function (...args: Parameters<SubtleCrypto['encrypt']>) {
    owned = args[2] as Uint8Array
    return originalEncrypt.apply(this, args)
  }
  const wipe = initial('wipe')
  try { await vault.stage(wipe, roots()) } finally { SubtleCrypto.prototype.encrypt = originalEncrypt }
  ok(owned?.every(b => b === 0), 'temporary plaintext wiped after success')
  SubtleCrypto.prototype.encrypt = function (...args: Parameters<SubtleCrypto['encrypt']>) {
    owned = args[2] as Uint8Array
    return Promise.reject(new DOMException('fixture failure'))
  }
  try { await fails(() => vault.stage(next(wipe.receipt), roots(44)), 'storage-failed') }
  finally { SubtleCrypto.prototype.encrypt = originalEncrypt }
  ok(owned?.every(b => b === 0), 'temporary plaintext wiped after failure')
  equalRoots(await vault.open(wipe.receipt), roots())
  let decrypted: ArrayBuffer | undefined
  SubtleCrypto.prototype.decrypt = async function (...args: Parameters<SubtleCrypto['decrypt']>) {
    decrypted = await originalDecrypt.apply(this, args)
    return decrypted
  }
  try { equalRoots(await vault.open(wipe.receipt), roots()) }
  finally { SubtleCrypto.prototype.decrypt = originalDecrypt }
  ok(decrypted && new Uint8Array(decrypted).every(b => b === 0), 'temporary decrypted bytes wiped')

  // Throw after the record put, exactly where failed structured clone/partial writes occur.
  const originalPut = IDBObjectStore.prototype.put
  for (const kind of ['clone', 'abort']) {
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'keys') {
        if (kind === 'clone') throw new DOMException('fixture clone failure', 'DataCloneError')
        this.transaction.abort()
      }
      return originalPut.apply(this, args)
    }
    try { await fails(() => vault.stage(next(wipe.receipt, kind), roots(66)), 'storage-failed') }
    finally { IDBObjectStore.prototype.put = originalPut }
    equalRoots(await vault.open(wipe.receipt), roots())
    ok(await vault.reconcile(wipe.receipt) === 'committed', `${kind} preserves old receipt`)
  }

  const writerA = next(first.receipt, 'writer-a'), writerB = next(first.receipt, 'writer-b')
  const race = await Promise.allSettled([vault.stage(writerA, roots(61)), other.stage(writerB, roots(62))])
  ok(race.filter(r => r.status === 'fulfilled').length === 1, 'one concurrent CAS winner')
  const loser = race.find(r => r.status === 'rejected') as PromiseRejectedResult
  ok(loser.reason instanceof VaultError && loser.reason.code === 'conflict', 'stale writer rejected')
  const winner = race[0].status === 'fulfilled' ? writerA : writerB
  equalRoots(await vault.open(winner.receipt), roots(race[0].status === 'fulfilled' ? 61 : 62))
  ok(await vault.reconcile(first.receipt) === 'superseded', 'old receipt superseded')
  const replacementRow = await row(ns, 'records', 'first')
  ok(!replacementRow.iv.every((byte: number, i: number) => byte === publicRecord.iv[i]), 'replacement uses fresh IV')
  await fails(() => vault.remove(first.receipt), 'conflict')

  // Every authenticated public field rejects changes; no plaintext is published.
  for (const changed of [
    { ...winner.receipt, operationId: 'wrong' },
    ...['accountId', 'creationId', 'recoveryFingerprint', 'retirementContext'].map(field => ({ ...winner.receipt,
      context: { ...winner.receipt.context, [field]: 'wrong' } })),
    { ...winner.receipt, context: { ...winner.receipt.context, custodyEpoch: 0 } },
  ]) await fails(() => vault.open(changed), changed.context.creationId === 'wrong' ? 'locked' : 'conflict')

  for (const damage of ['iv', 'ciphertext', 'tag', 'oversized', 'missing-key', 'malformed-key', 'extractable-key', 'missing-record', 'context', 'bad-payload']) {
    const item = initial(`damage-${damage}`)
    await vault.stage(item, roots())
    if (damage === 'missing-key') await change(ns, 'keys', item.receipt.context.creationId, () => undefined)
    else if (damage === 'malformed-key' || damage === 'extractable-key') {
      const key = damage === 'extractable-key'
        ? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
        : { not: 'a CryptoKey' }
      await change(ns, 'keys', item.receipt.context.creationId, r => ({ ...r, key }))
    }
    else if (damage === 'missing-record') await change(ns, 'records', item.receipt.context.creationId, () => undefined)
    else if (damage === 'bad-payload') {
      // Derive AAD from an intercepted authentic encryption call, without private imports.
      let params: AesGcmParams | undefined
      SubtleCrypto.prototype.encrypt = function (...args: Parameters<SubtleCrypto['encrypt']>) {
        params = args[0] as AesGcmParams
        return originalEncrypt.apply(this, args)
      }
      const replacement = next(item.receipt)
      try { await vault.stage(replacement, roots()) } finally { SubtleCrypto.prototype.encrypt = originalEncrypt }
      const replacementKey = (await row(ns, 'keys', item.receipt.context.creationId)).key
      const malformed = new Uint8Array(167); malformed[0] = 1; malformed[1] = 5
      const encrypted = await crypto.subtle.encrypt(params!, replacementKey, malformed)
      await change(ns, 'records', item.receipt.context.creationId, r => ({ ...r, ciphertext: new Uint8Array(encrypted) }))
      await fails(() => vault.open(replacement.receipt), 'corrupt')
      await vault.remove(replacement.receipt)
      continue
    } else await change(ns, 'records', item.receipt.context.creationId, record => {
      if (damage === 'iv') record.iv[0] ^= 1
      if (damage === 'ciphertext') record.ciphertext[0] ^= 1
      if (damage === 'tag') record.ciphertext[record.ciphertext.length - 1] ^= 1
      if (damage === 'oversized') record.ciphertext = new Uint8Array(1024 * 1024)
      if (damage === 'context') record.receipt.context.recoveryFingerprint = 'changed'
      return record
    })
    await fails(() => vault.open(item.receipt), damage === 'missing-key' ? 'locked' : 'corrupt')
    await vault.remove(item.receipt)
    ok(await row(ns, 'keys', item.receipt.context.creationId) === undefined, 'cleanup removes exact key')
    ok(await row(ns, 'records', item.receipt.context.creationId) === undefined, 'cleanup removes exact record')
  }

  // Change all stored metadata consistently: the AEAD itself must reject the altered context.
  for (const field of ['accountId', 'recoveryFingerprint', 'retirementContext', 'custodyEpoch', 'operationId', 'revision']) {
    const item = initial(`aad-${field}`)
    await vault.stage(item, roots())
    const changed: any = structuredClone(item.receipt)
    if (field === 'operationId') changed.operationId = 'altered'
    else if (field === 'revision') { changed.previousRevision = 1; changed.revision = 2 }
    else changed.context[field] = field === 'custodyEpoch' ? 3 : 'altered'
    for (const store of ['records', 'keys', 'fences']) {
      await change(ns, store, item.receipt.context.creationId, r => ({ ...r, receipt: changed,
        ...(store === 'fences' ? { revision: changed.revision } : {}) }))
    }
    await fails(() => vault.open(changed), 'corrupt')
    await vault.remove(changed)
  }

  const keyChange = initial('key-change')
  await vault.stage(keyChange, roots())
  const previousKey = (await row(ns, 'keys', 'key-change')).key
  const keyReplacement = next(keyChange.receipt)
  await vault.stage(keyReplacement, roots())
  await change(ns, 'keys', 'key-change', r => ({ ...r, key: previousKey }))
  await fails(() => vault.open(keyReplacement.receipt), 'corrupt')
  await vault.remove(keyReplacement.receipt)

  const originalDelete = IDBObjectStore.prototype.delete
  IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
    if (this.name === 'keys') this.transaction.abort()
    return originalDelete.apply(this, args)
  }
  try { await fails(() => vault.remove(wipe.receipt), 'storage-failed') }
  finally { IDBObjectStore.prototype.delete = originalDelete }
  equalRoots(await vault.open(wipe.receipt), roots())

  // Reads also recheck their receipt after crypto, before exposing roots.
  const reading = initial('reading')
  await vault.stage(reading, roots())
  let resumeRead!: () => void, beginRead!: () => void
  const readGate = new Promise<void>(resolve => { resumeRead = resolve })
  const readStarted = new Promise<void>(resolve => { beginRead = resolve })
  SubtleCrypto.prototype.decrypt = async function (...args: Parameters<SubtleCrypto['decrypt']>) {
    const result = await originalDecrypt.apply(this, args)
    decrypted = result; beginRead(); await readGate; return result
  }
  const inFlightRead = vault.open(reading.receipt)
  await readStarted
  await other.remove(reading.receipt)
  resumeRead()
  try { await fails(() => inFlightRead, 'conflict') }
  finally { SubtleCrypto.prototype.decrypt = originalDecrypt }
  ok(decrypted && new Uint8Array(decrypted).every(b => b === 0), 'racing read plaintext wiped without publishing roots')

  // A delayed preparation cannot resurrect a record removed while encryption was in flight.
  let release!: () => void, entered!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
    entered(); await paused; return originalEncrypt.apply(this, args)
  }
  const delayed = vault.stage(next(winner.receipt, 'delayed'), roots(91))
  await started
  await other.remove(winner.receipt)
  release()
  try { await fails(() => delayed, 'conflict') } finally { SubtleCrypto.prototype.encrypt = originalEncrypt }
  await vault.remove(winner.receipt)
  ok(await vault.reconcile(winner.receipt) === 'removed', 'removal reconciles idempotently')
  await fails(() => vault.stage(first, roots()), 'conflict')
  await fails(() => vault.open(winner.receipt), 'locked')
  const fence = await row(ns, 'fences', 'first')
  ok(fence.receipt === null && Object.keys(fence).length === 2, 'minimal removal fence')
  vault.close(); other.close()
  for (let i = 0; i < 3; i++) {
    const reopened = await openPreviewVault({ namespace: ns })
    equalRoots(await reopened.open(wipe.receipt), roots()); reopened.close()
  }

  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  try { await fails(() => openPreviewVault({ namespace: 'unsupported' }), 'unavailable') }
  finally { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor) }
  const idbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')!
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
  try { await fails(() => openPreviewVault({ namespace: 'unsupported' }), 'unavailable') }
  finally { Object.defineProperty(globalThis, 'indexedDB', idbDescriptor) }
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'probe') throw new DOMException('fixture clone failure', 'DataCloneError')
    return originalPut.apply(this, args)
  }
  try { await fails(() => openPreviewVault({ namespace: 'unsupported' }), 'unavailable') }
  finally { IDBObjectStore.prototype.put = originalPut }

  const originalOpen = IDBFactory.prototype.open
  let probeOpens = 0
  IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
    if (args[0].endsWith('-reopen-failure.capability') && ++probeOpens === 2) throw new DOMException('fixture reopen failure')
    return originalOpen.apply(this, args)
  }
  try { await fails(() => openPreviewVault({ namespace: 'reopen-failure' }), 'unavailable') }
  finally { IDBFactory.prototype.open = originalOpen }
  ok(probeOpens === 2, 'capability uses actual second IDB open')
  IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
    if (args[0] === 'frank-preview-vault-main-open-failure') throw new DOMException('fixture permission denial')
    return originalOpen.apply(this, args)
  }
  try { await fails(() => openPreviewVault({ namespace: 'main-open-failure' }), 'unavailable') }
  finally { IDBFactory.prototype.open = originalOpen }

  const capped = await openPreviewVault({ namespace: 'bounded' })
  const cappedFirst = initial('capped-first')
  await capped.stage(cappedFirst, roots())
  const db = await raw('bounded')
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('fences', 'readwrite')
    for (let i = 1; i < 1023; i++) tx.objectStore('fences').put({ revision: 2, receipt: null }, `fixture-fence-${i}`)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  })
  db.close()
  const cappedOther = await openPreviewVault({ namespace: 'bounded' })
  const boundaryDiscards = [initial('capacity-discard-a'), initial('capacity-discard-b')]
  const capacityRace = await Promise.allSettled([capped.discardIntent(boundaryDiscards[0]), cappedOther.discardIntent(boundaryDiscards[1])])
  ok(capacityRace.filter(r => r.status === 'fulfilled').length === 1, 'concurrent absent discards cannot exceed slot capacity')
  for (let i = 0; i < 2; i++) {
    const result = capacityRace[i]
    if (result.status === 'fulfilled') await cappedOther.discardIntent(boundaryDiscards[i])
    else {
      ok(result.reason instanceof VaultError && result.reason.code === 'capacity', 'discard at capacity rejects stably')
      ok(await capped.reconcile(boundaryDiscards[i].receipt) === 'absent', 'capacity rejection leaves no fence')
    }
  }
  cappedOther.close()
  const excess = initial('over-capacity')
  await fails(() => capped.stage(excess, roots()), 'capacity')
  ok(await capped.reconcile(excess.receipt) === 'absent', 'capacity leaves no partial inventory')
  const cappedReplacement = next(cappedFirst.receipt)
  await capped.stage(cappedReplacement, roots())
  await capped.discardIntent(cappedReplacement)
  await capped.discardIntent(cappedReplacement)
  ok(await capped.reconcile(cappedReplacement.receipt) === 'removed', 'live discard and exact retry need no new capacity')
  capped.close()
  const malformed = await openPreviewVault({ namespace: 'malformed' })
  for (const value of [null, false, 0, {}, { revision: 0, receipt: null }]) {
    const item = initial('malformed-fence')
    await change('malformed', 'fences', item.receipt.context.creationId, () => value)
    await fails(() => malformed.reconcile(item.receipt), 'corrupt')
    await fails(() => malformed.stage(item, roots()), 'corrupt')
  }
  malformed.close()
  return { assertions }
}
