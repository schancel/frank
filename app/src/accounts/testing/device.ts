/**
 * Test support for account backup and restore: real session, real custody facade and vault (on
 * fake IndexedDB with Node's WebCrypto), real ceremony and recovery package. A "device" is one
 * IndexedDB; a fresh device is a new, empty one.
 *
 * A test file using this must route the app's session singleton here:
 *
 *   jest.mock('<path>/accounts/session', () => ({
 *     ...jest.requireActual('<path>/accounts/session'),
 *     get accountSession() {
 *       return jest.requireActual('<path>/accounts/testing/device').currentSession()
 *     },
 *   }))
 *   jest.mock('@frank/cashweb/relay', () => ({ probeDirectoryRelay: async () => undefined }))
 *
 * Stand-ins, none of them part of backup or restore: the wallet object the session holds is built
 * from the real identity derivation instead of the full chain wallet (no network), the relay
 * directory probe finds nothing, and there is no legacy wallet blob.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'crypto'
import type { VaultReceipt } from '@frank/account-vault'
import { aad } from '../../../../packages/account-vault/src/encoding'
import { DOMAIN_PURPOSES, type DomainRoot } from '@frank/domain-roots'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { createAccountCeremony } from '../ceremony'
import { openAccountCustody } from '../custody'
import { inspectLegacyWallet } from '../legacy'
import { createAccountSession, type RuntimeWallet } from '../session'

export type Session = ReturnType<typeof createAccountSession>
let current: Session | undefined
export const currentSession = () => current

const NAMESPACE = 'local-account-v1'
const CHAINS = [
  'monad',
  'ecash',
  'bitcoin',
  'bitcoincash',
  'dogecoin',
  'solana',
]
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

export async function prepareDevices() {
  if (!globalThis.crypto?.subtle)
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      configurable: true,
    })
  await inspectLegacyWallet({
    get: () => Promise.reject({ notFound: true }),
  })
}

const opened: Session[] = []
export async function closeDevices() {
  for (const session of opened.splice(0)) await session.close()
  current = undefined
}

/** Switch to a new, empty browser profile and open the app's session on it. */
export function freshDevice(): Session {
  globalThis.indexedDB = new IDBFactory()
  return openSession()
}
/** A later app start on the same device: nothing carried over in memory. */
export function openSession(): Session {
  const session = createAccountSession({
    open: () => openAccountCustody({ namespace: NAMESPACE }),
    createWallet: async (roots: {
      authentication: DomainRoot<'identity-authentication'>
    }) =>
      ({
        identity: MonadIdentity.fromDomainRoot(roots.authentication),
        close: async () => undefined,
      } as unknown as RuntimeWallet),
  })
  opened.push(session)
  current = session
  return session
}

export async function activate(session: Session) {
  const pending = session.state.pending
  if (!pending) throw new Error('nothing staged')
  await session.activatePending(
    pending.account.receipt.operationId,
    pending.expectedActive,
  )
  expect(session.state.status).toBe('ready')
}

/** Create an account the way Setup does and return the shares it showed. */
export async function signUp(
  session: Session,
  threshold: 2 | 3 = 2,
  count: 3 | 5 = 3,
) {
  await session.initialize()
  const ceremony = createAccountCeremony()
  await ceremony.beginNew(threshold, count)
  const shares = Array.from({ length: count }, (_, i) => ceremony.share(i))
  await ceremony.confirm(shares.slice(0, threshold), 'Original')
  await activate(session)
  return shares
}

/** Restore the way Setup's default path does: no descriptor is pinned. */
export async function restore(session: Session, shares: readonly string[]) {
  await session.initialize()
  const ceremony = createAccountCeremony()
  await ceremony.beginRestore()
  const outcome = await ceremony.confirm(shares, 'Restored')
  await activate(session)
  return outcome
}

/** Everything that makes it "the same account": identity, all five roots, addresses. */
export async function describeAccount(session: Session) {
  const wallet = await session.getWallet()
  const roots: Record<string, string> = {}
  for (const purpose of DOMAIN_PURPOSES) {
    const root = await session.getActiveDomainRoot(purpose)
    roots[purpose] = hex(root)
    root.fill(0)
  }
  const addresses: Record<string, string> = {}
  for (const chain of CHAINS)
    addresses[chain] = await session.getChainAddress(chain)
  const account = session.state.account
  return {
    identityAddress: wallet.identity.displayAddress,
    identityKey: hex(await session.getCurvePublicKey('secp256k1')),
    roots,
    addresses,
    descriptor: account?.descriptor,
    fingerprint: account?.fingerprint,
    masterRetirementId: account?.masterRetirementId,
    recoveryIdentityCommitment: account?.recoveryIdentityCommitment,
  }
}

export async function failure(
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

/**
 * Rewrite this device's vault record in the framing used before account roots were stored:
 * the five typed roots and nothing else, sealed with the same stored key and public receipt.
 */
export async function forgetAccountRoot(
  receipt: VaultReceipt,
  roots: Record<string, string>,
) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`frank-preview-vault-${NAMESPACE}`)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const id = receipt.context.creationId
  const get = <T>(store: string) =>
    new Promise<T>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  const { key } = await get<{ key: CryptoKey }>('keys')
  const record = await get<Record<string, unknown>>('records')
  const older = new Uint8Array(2 + DOMAIN_PURPOSES.length * 33)
  older[0] = 1
  older[1] = DOMAIN_PURPOSES.length
  DOMAIN_PURPOSES.forEach((purpose, i) => {
    older[2 + i * 33] = i + 1
    older.set(Buffer.from(roots[purpose], 'hex'), 3 + i * 33)
  })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(receipt), tagLength: 128 },
      key,
      older,
    ),
  )
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite')
    tx.objectStore('records').put({ ...record, iv, ciphertext }, id)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}
