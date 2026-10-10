import { webcrypto } from 'crypto'
import { splitCodex32 } from '@frank/codex32'
import { decodeRecoveryDescriptor } from '@frank/account-recovery'
import { createAccountCeremony, recoveryErrorMessage } from './ceremony'
import { accountSession } from './session'
import { assertLegacyUnchanged } from './legacy'

jest.mock('./session', () => ({
  accountSession: {
    state: { revision: 0, account: null },
    snapshot: jest.fn(async () => ({
      revision: 0,
      active: null,
      pending: null,
    })),
    stage: jest.fn(async () => undefined),
    cancelPending: jest.fn(async () => undefined),
  },
}))
jest.mock('./legacy', () => ({
  legacyStatus: { revision: 0 },
  assertLegacyUnchanged: jest.fn(async () => undefined),
}))

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
})
beforeEach(() => {
  jest.clearAllMocks()
})
async function signup() {
  const ceremony = createAccountCeremony()
  const descriptor = await ceremony.beginNew(2, 3)
  return {
    ceremony,
    descriptor,
    shares: [0, 1, 2].map(index => ceremony.share(index)),
  }
}
test('does not stage before exact confirmation; stages only the account root and wipes it after', async () => {
  const f = await signup()
  expect(accountSession.stage).not.toHaveBeenCalled()
  await f.ceremony.confirm(f.shares.slice(0, 2), '  Synthetic account  ')
  const staged = jest.mocked(accountSession.stage).mock.calls[0][0]
  expect(staged.displayName).toBe('Synthetic account')
  expect(staged.expectedActive).toEqual({ revision: 0, accountId: null })
  expect(staged.accountRoot.every(byte => byte === 0)).toBe(true)
  expect('roots' in staged).toBe(false)
  expect(f.ceremony.share(0)).toBe('')
  await expect(
    f.ceremony.confirm(f.shares.slice(0, 2), 'Again'),
  ).rejects.toThrow()
})
test.each(['insufficient', 'excess', 'duplicate', 'checksum', 'other-account'])(
  'rejects %s without staging and consumes the ceremony',
  async kind => {
    const f = await signup()
    let shares = f.shares.slice(0, 2)
    if (kind === 'insufficient') shares = shares.slice(0, 1)
    if (kind === 'excess') shares = f.shares
    if (kind === 'duplicate') shares = [shares[0], shares[0]]
    if (kind === 'checksum')
      shares = [
        shares[0].slice(0, -1) + (shares[0].endsWith('q') ? 'p' : 'q'),
        shares[1],
      ]
    if (kind === 'other-account') {
      const other = await signup()
      shares = other.shares.slice(0, 2)
      other.ceremony.cancel()
    }
    await expect(f.ceremony.confirm(shares, 'Fixture')).rejects.toThrow()
    expect(accountSession.stage).not.toHaveBeenCalled()
    await expect(
      f.ceremony.confirm(f.shares.slice(0, 2), 'Fixture'),
    ).rejects.toThrow()
  },
)
test('independently pinned descriptor mismatch consumes restore rather than changing the expected account', async () => {
  const a = await signup(),
    b = await signup()
  const restore = createAccountCeremony()
  await restore.beginRestore(a.descriptor)
  await expect(
    restore.confirm(b.shares.slice(0, 2), 'Restored'),
  ).rejects.toMatchObject({ code: 'descriptor-mismatch' })
  await expect(
    restore.confirm(a.shares.slice(0, 2), 'Restored'),
  ).rejects.toThrow()
  expect(accountSession.stage).not.toHaveBeenCalled()
  a.ceremony.cancel()
  b.ceremony.cancel()
})
test('restore without descriptor recovers valid roots and stages account', async () => {
  const f = await signup()
  const restore = createAccountCeremony()
  const res = await restore.beginRestore()
  expect(res).toBe('')
  await restore.confirm(f.shares.slice(0, 2), 'Restored Account')
  expect(accountSession.stage).toHaveBeenCalledTimes(1)
  const staged = jest.mocked(accountSession.stage).mock.calls[0][0]
  expect(staged.displayName).toBe('Restored Account')
  f.ceremony.cancel()
})
test('stages the account root with the roots and wipes its own copy afterwards', async () => {
  const f = await signup()
  let seen: number[] = []
  jest.mocked(accountSession.stage).mockImplementationOnce(async input => {
    seen = Array.from(input.accountRoot)
  })
  await f.ceremony.confirm(f.shares.slice(0, 2), 'Fixture')
  expect(seen).toHaveLength(32)
  expect(seen.some(byte => byte !== 0)).toBe(true)
  const staged = jest.mocked(accountSession.stage).mock.calls[0][0]
  expect(staged.accountRoot.every(byte => byte === 0)).toBe(true)
})
test('each signup names its own share set', async () => {
  const a = await signup(),
    b = await signup()
  const id = (share: string) => share.slice(4, 8)
  expect(new Set(a.shares.map(id)).size).toBe(1)
  expect(id(a.shares[0])).not.toBe(id(b.shares[0]))
  a.ceremony.cancel()
  b.ceremony.cancel()
})
test.each([
  ['a derived root on its own', 32],
  ['unrelated bytes of master length', 64],
])(
  'default restore refuses shares that carry %s instead of an account',
  async (_name, length) => {
    const split = splitCodex32({
      threshold: 2,
      identifier: 'test',
      indices: ['q', 'p', 'z'],
      secret: webcrypto.getRandomValues(new Uint8Array(length)),
      randomBytes: n => webcrypto.getRandomValues(new Uint8Array(n)),
    })
    if (!split.ok) throw new Error('fixture')
    const restore = createAccountCeremony()
    await restore.beginRestore()
    const error = await restore
      .confirm(split.value.slice(0, 2), 'Restored')
      .then(
        () => undefined,
        (failure: unknown) => failure,
      )
    expect(error).toMatchObject({ code: 'not-account-backup' })
    expect(recoveryErrorMessage(error)).toMatch(/nothing was restored/)
    expect(accountSession.stage).not.toHaveBeenCalled()
  },
)
/** A well-formed share with the same header and index but wrong contents. */
function poisoned(share: string): string {
  const split = splitCodex32({
    threshold: Number(share[3]) as 2,
    identifier: share.slice(4, 8),
    indices: [
      share[8],
      ...Array.from('qpzry9x8gf').filter(i => i !== share[8]),
    ],
    secret: webcrypto.getRandomValues(new Uint8Array(64)),
    randomBytes: n => webcrypto.getRandomValues(new Uint8Array(n)),
  })
  if (!split.ok) throw new Error('fixture')
  return split.value[0]
}
test('restore accepts more shares than the threshold, stages the account and reports the bad share', async () => {
  const f = await signup()
  const restore = createAccountCeremony()
  await restore.beginRestore()
  const outcome = await restore.confirm(
    [poisoned(f.shares[0]), f.shares[1], f.shares[2]],
    'Restored',
  )
  expect(accountSession.stage).toHaveBeenCalledTimes(1)
  expect(outcome.report?.map(share => share.status)).toEqual([
    'inconsistent',
    'supports',
    'supports',
  ])
  expect('candidates' in outcome).toBe(false)
  f.ceremony.cancel()
})
test('exactly the threshold with a bad share is refused and says one more share would identify it', async () => {
  const f = await signup()
  const restore = createAccountCeremony()
  await restore.beginRestore()
  const error = await restore
    .confirm([poisoned(f.shares[0]), f.shares[1]], 'Restored')
    .then(
      () => undefined,
      (failure: unknown) => failure,
    )
  expect(error).toMatchObject({ code: 'not-account-backup' })
  expect((error as { shares: unknown[] }).shares).toHaveLength(2)
  expect(recoveryErrorMessage(error)).toMatch(/one more share/)
  expect(accountSession.stage).not.toHaveBeenCalled()
  f.ceremony.cancel()
})
test('complete share sets of two accounts: nothing is staged until the user picks, and only the pick is staged', async () => {
  const a = await signup(),
    b = await signup()
  for (const pick of [0, 1]) {
    jest.mocked(accountSession.stage).mockClear()
    const restore = createAccountCeremony()
    await restore.beginRestore()
    const outcome = await restore.confirm(
      [a.shares[0], b.shares[0], a.shares[1], b.shares[1]],
      'Restored',
    )
    expect(accountSession.stage).not.toHaveBeenCalled()
    if (!('candidates' in outcome)) throw new Error('expected a choice')
    expect(outcome.candidates.map(c => c.supporting)).toEqual([
      [0, 2],
      [1, 3],
    ])
    expect(outcome.candidates.map(c => c.descriptor)).toEqual([
      a.descriptor,
      b.descriptor,
    ])
    expect(new Set(outcome.candidates.map(c => c.address)).size).toBe(2)
    let fingerprint: number[] = []
    jest.mocked(accountSession.stage).mockImplementationOnce(async input => {
      fingerprint = Array.from(
        input.metadata.descriptor.publicRecoveryFingerprint,
      )
    })
    await restore.choose(pick, 'Restored')
    expect(accountSession.stage).toHaveBeenCalledTimes(1)
    const expected = decodeRecoveryDescriptor([a, b][pick].descriptor)
    expect(fingerprint).toEqual(Array.from(expected.publicRecoveryFingerprint))
    // The pick is spent: a second choose cannot stage the other account.
    await expect(restore.choose(1 - pick, 'Again')).rejects.toThrow()
    expect(accountSession.stage).toHaveBeenCalledTimes(1)
  }
  a.ceremony.cancel()
  b.ceremony.cancel()
})
test('more shares of one backup than the app checks are refused with the number allowed', async () => {
  const f = await signup()
  const restore = createAccountCeremony()
  await restore.beginRestore()
  // A 2-of-n backup allows 31; 32 entries is over any limit.
  const error = await restore
    .confirm(
      Array.from({ length: 32 }, () => f.shares[0]),
      'Restored',
    )
    .then(
      () => undefined,
      (failure: unknown) => failure,
    )
  expect(error).toMatchObject({ code: 'too-many-shares', maxShares: 31 })
  expect(recoveryErrorMessage(error)).toMatch(/Enter at most 31 shares/)
  expect(accountSession.stage).not.toHaveBeenCalled()
  f.ceremony.cancel()
})
test('a pinned descriptor selects its account from a pile holding two, without asking', async () => {
  const a = await signup(),
    b = await signup()
  const restore = createAccountCeremony()
  await restore.beginRestore(b.descriptor)
  const outcome = await restore.confirm(
    [a.shares[0], b.shares[0], a.shares[1], b.shares[1]],
    'Restored',
  )
  expect('candidates' in outcome).toBe(false)
  expect(accountSession.stage).toHaveBeenCalledTimes(1)
  expect(outcome.report?.map(share => share.status)).toEqual([
    'inconsistent',
    'supports',
    'inconsistent',
    'supports',
  ])
  a.ceremony.cancel()
  b.ceremony.cancel()
})
test('cancel during legacy-state check never stages recovered roots', async () => {
  const f = await signup()
  let resolve!: () => void
  jest.mocked(assertLegacyUnchanged).mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  const confirming = f.ceremony.confirm(f.shares.slice(0, 2), 'Fixture')
  f.ceremony.cancel()
  resolve()
  await expect(confirming).rejects.toThrow()
  expect(accountSession.stage).not.toHaveBeenCalled()
})
test('cancel while stage is suspended explicitly cleans the same attempt once stage settles', async () => {
  const f = await signup()
  let resolve!: () => void
  jest.mocked(accountSession.stage).mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  const confirming = f.ceremony.confirm(f.shares.slice(0, 2), 'Fixture')
  for (let i = 0; i < 10; i++) await Promise.resolve()
  f.ceremony.cancel()
  resolve()
  await confirming
  expect(accountSession.cancelPending).toHaveBeenCalledWith(
    jest.mocked(accountSession.stage).mock.calls[0][0].attemptId,
  )
})
test('bounded error text never includes arbitrary secret exception messages', () => {
  expect(recoveryErrorMessage(new Error('PRIVATE-SENTINEL'))).not.toContain(
    'PRIVATE-SENTINEL',
  )
  expect(recoveryErrorMessage({ code: 'duplicate-share' })).toContain(
    'different index',
  )
})
