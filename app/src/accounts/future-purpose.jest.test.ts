/**
 * The account root is the one thing kept, and every purpose root is derived from it when the
 * account is opened. So a purpose added to the registry after an account was created is simply
 * there the next time that account opens, with no shares re-entered and nothing rewritten.
 *
 * The registry is frozen, so this test registers a sixth, test-only purpose by wrapping the real
 * module: the five real purposes go to the real derivation untouched, and the sixth is derived
 * here with Node's HKDF in the registry's documented layout. Session, custody, vault, ceremony and
 * recovery are all real (see ./testing/device).
 */
import type { DomainRoot } from '@frank/domain-roots'
import { AccountPurposeUnavailableError } from './session'
import {
  closeDevices,
  describeAccount,
  failure,
  forgetAccountRoot,
  freshDevice,
  openSession,
  prepareDevices,
  restore,
  signUp,
  type Session,
} from './testing/device'

const SIXTH = 'test-sixth-purpose' as DomainRoot['purpose']
let mockSixthRegistered = false

jest.mock('@frank/domain-roots', () => {
  const actual = jest.requireActual('@frank/domain-roots')
  const { hkdfSync } = jest.requireActual('crypto')
  const purpose = 'test-sixth-purpose'
  const u16 = (value: number) => Buffer.from([value >>> 8, value & 0xff])
  const registry = Buffer.from(actual.DERIVATION_REGISTRY_ID, 'ascii')
  const label = Buffer.from(`frank/domain-root/v1/${purpose}`, 'ascii')
  const info = Buffer.concat([
    u16(registry.length),
    registry,
    u16(6),
    u16(label.length),
    label,
    u16(32),
  ])
  return {
    ...actual,
    get DOMAIN_PURPOSES() {
      return mockSixthRegistered
        ? [...actual.DOMAIN_PURPOSES, purpose]
        : actual.DOMAIN_PURPOSES
    },
    deriveDomainRoot(accountRoot: Uint8Array, wanted: string) {
      if (wanted !== purpose)
        return actual.deriveDomainRoot(accountRoot, wanted)
      if (!mockSixthRegistered) throw new Error('Unknown domain-root purpose')
      return Object.freeze({
        registry: actual.DERIVATION_REGISTRY_ID,
        purpose,
        bytes: new Uint8Array(
          hkdfSync(
            'sha256',
            accountRoot,
            Buffer.from('frank/domain-root-registry/v1', 'ascii'),
            info,
            32,
          ),
        ),
      })
    },
  }
})
jest.mock('./session', () => ({
  ...jest.requireActual('./session'),
  get accountSession() {
    return jest.requireActual('./testing/device').currentSession()
  },
}))
jest.mock('@frank/cashweb/relay', () => ({
  probeDirectoryRelay: jest.fn(async () => undefined),
}))

beforeAll(prepareDevices)
beforeEach(() => {
  mockSixthRegistered = false
})
afterEach(closeDevices)

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
async function sixthRoot(session: Session) {
  const root = await session.getActiveDomainRoot(SIXTH)
  try {
    return hex(root)
  } finally {
    root.fill(0)
  }
}
/** Every stored byte of this device's vault and custody state, to show nothing was written. */
async function storedBytes() {
  const dump: Record<string, unknown> = {}
  for (const [name, stores] of [
    ['frank-preview-vault-local-account-v1', ['records', 'fences']],
    ['frank-account-custody-local-account-v1', ['state']],
  ] as const) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    for (const store of stores) {
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      dump[`${name}/${store}`] = JSON.parse(
        JSON.stringify(rows, (_key, value) =>
          value instanceof Uint8Array ? Array.from(value) : value,
        ),
      )
    }
    db.close()
  }
  return JSON.stringify(dump)
}

test('a purpose added after an account was created is derived for it on the next open', async () => {
  const first = freshDevice()
  const shares = await signUp(first)
  const original = await describeAccount(first)
  expect(Object.keys(original.roots)).toHaveLength(5)
  // Before the purpose exists there is nothing to ask for.
  expect(await failure(() => sixthRoot(first))).toBeInstanceOf(
    AccountPurposeUnavailableError,
  )
  await first.close()
  const before = await storedBytes()

  // The app is updated: the registry gains a sixth purpose. Same device, same stored account.
  mockSixthRegistered = true
  const later = openSession()
  await later.initialize()
  const reopened = await describeAccount(later)
  expect(Object.keys(reopened.roots)).toHaveLength(6)
  const sixth = reopened.roots[SIXTH]
  expect(sixth).toMatch(/^[0-9a-f]{64}$/)
  expect(Object.values(original.roots)).not.toContain(sixth)
  // The account is otherwise exactly the one that was created.
  const { [SIXTH]: _added, ...firstFive } = reopened.roots
  expect({ ...reopened, roots: firstFive }).toEqual(original)
  await later.close()
  // Deriving happened in memory: opening wrote nothing.
  expect(await storedBytes()).toBe(before)

  // A fresh restore from the same shares derives the same sixth root.
  const restored = freshDevice()
  await restore(restored, shares.slice(0, 2))
  expect(await describeAccount(restored)).toEqual(reopened)
  expect(await sixthRoot(restored)).toBe(sixth)
})

test('an account stored before the account root was kept still opens, unchanged, and says it has no new purpose', async () => {
  const first = freshDevice()
  const shares = await signUp(first)
  const original = await describeAccount(first)
  await forgetAccountRoot(first.state.account!.receipt, original.roots)
  await first.close()
  const before = await storedBytes()

  mockSixthRegistered = true
  const later = openSession()
  await later.initialize()
  expect(later.state.status).toBe('ready')
  const wallet = await later.getWallet()
  expect(wallet.identity.displayAddress).toBe(original.identityAddress)
  for (const [purpose, root] of Object.entries(original.roots)) {
    const bytes = await later.getActiveDomainRoot(
      purpose as DomainRoot['purpose'],
    )
    expect(hex(bytes)).toBe(root)
  }
  const error = await failure(() => sixthRoot(later))
  expect(error).toBeInstanceOf(AccountPurposeUnavailableError)
  expect(later.state.status).toBe('ready')
  await later.close()
  expect(await storedBytes()).toBe(before)

  // Its signup shares restore a full account, new purpose included.
  const restored = freshDevice()
  await restore(restored, shares.slice(0, 2))
  const full = await describeAccount(restored)
  expect(Object.keys(full.roots)).toHaveLength(6)
  const { [SIXTH]: sixth, ...firstFive } = full.roots
  expect(firstFive).toEqual(original.roots)
  expect(sixth).toMatch(/^[0-9a-f]{64}$/)
})
