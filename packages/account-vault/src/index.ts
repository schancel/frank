import type { DomainRoot } from '@frank/domain-roots'
import { aad, createIntent, decode, intent, plaintext, receipt, same, validate } from './encoding.js'
import { commit, database, discardIntent, read, remove, transaction, validKey, type RecordRow } from './storage.js'
import { VaultError, type PreviewVault, type VaultContext, type VaultReceipt, type VaultWriteIntent } from './types.js'

export { VaultError } from './types.js'
export type { PreviewVault, VaultContext, VaultErrorCode, VaultReceipt, VaultWriteIntent } from './types.js'

export function createVaultWriteIntent(input: {
  context: VaultContext; expected: VaultReceipt | null; operationId: string
}): VaultWriteIntent {
  return validate(() => createIntent(input))
}

async function capability(name: string): Promise<void> {
  let db: IDBDatabase | undefined
  let plain: Uint8Array | undefined
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, Uint8Array.of(70, 86, 1))
    db = await database(name, true)
    await transaction<void>(db, ['probe'], 'readwrite', (tx, result) => {
      tx.objectStore('probe').put({ key, iv, ciphertext }, 'capability'); result(undefined)
    })
    db.close()
    db = await database(name, true)
    const stored = await transaction<{ key: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }>(db, ['probe'], 'readonly', (tx, result) => {
      const request = tx.objectStore('probe').get('capability')
      request.onsuccess = () => result(request.result)
    })
    if (!stored || !validKey(stored.key) || !(stored.iv instanceof Uint8Array) || stored.iv.length !== 12 ||
        !(stored.ciphertext instanceof ArrayBuffer) || stored.ciphertext.byteLength !== 19) throw 0
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv, tagLength: 128 }, stored.key, stored.ciphertext))
    if (plain.length !== 3 || plain[0] !== 70 || plain[1] !== 86 || plain[2] !== 1) throw 0
  } catch { throw new VaultError('unavailable') } finally { plain?.fill(0); db?.close() }
}

/** Preview only; success proves this runtime's database-close/reopen capability, not hardware custody. */
export async function openPreviewVault(options: { namespace: string }): Promise<PreviewVault> {
  const namespace = validate(() => {
    const value = options?.namespace
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw 0
    return value
  })
  const name = `frank-preview-vault-${namespace}`
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB || !globalThis.CryptoKey) throw new VaultError('unavailable')
  await capability(`${name}.capability`)
  const db = await database(name)
  let closed = false
  const active = () => { if (closed) throw new VaultError('closed') }
  const current = async (target: VaultReceipt) => {
    active()
    const stored = await read(db, target.context.creationId)
    active()
    return stored
  }
  return Object.freeze({
    async stage(input, roots: readonly DomainRoot[]) {
      active()
      const snapshot = validate(() => intent(input))
      const bytes = validate(() => plaintext(roots, snapshot.receipt.context))
      try {
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(snapshot.receipt), tagLength: 128 }, key, bytes))
        active()
        await commit(db, snapshot, { receipt: snapshot.receipt, iv, ciphertext }, key)
        return snapshot.receipt
      } catch (error) {
        if (error instanceof VaultError) throw error
        throw new VaultError('storage-failed')
      } finally { bytes.fill(0) }
    },
    async open(input) {
      const target = validate(() => receipt(input))
      const stored = await current(target)
      if (!stored.fence?.receipt) throw new VaultError('locked')
      if (!same(stored.fence.receipt, target)) throw new VaultError('conflict')
      const row = stored.record as RecordRow
      let bytes: Uint8Array | undefined
      try {
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData: aad(target), tagLength: 128 }, stored.key!.key, row.ciphertext))
        active()
        // Recheck after crypto: a concurrent removal/replacement must not publish old roots.
        const latest = await current(target)
        if (!latest.fence?.receipt || !same(latest.fence.receipt, target)) throw new VaultError('conflict')
        return decode(bytes, target.context)
      } catch (error) {
        if (error instanceof VaultError) throw error
        throw new VaultError('corrupt')
      } finally { bytes?.fill(0) }
    },
    async reconcile(input) {
      const target = validate(() => receipt(input))
      const stored = await current(target)
      if (!stored.fence) return 'absent'
      if (!stored.fence.receipt) return 'removed'
      return same(stored.fence.receipt, target) ? 'committed' : 'superseded'
    },
    async remove(input) { active(); await remove(db, validate(() => receipt(input))) },
    async discardIntent(input) { active(); await discardIntent(db, validate(() => intent(input))) },
    close() { closed = true; db.close() },
  } satisfies PreviewVault)
}
