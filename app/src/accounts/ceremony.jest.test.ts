import { webcrypto } from 'crypto'
import {
  createLongBchChecksum,
  GF32_ALPHABET,
  splitCodex32,
} from '@frank/codex32'
import {
  exportRecoveryShares,
  decodeRecoveryDescriptor,
} from '@frank/account-recovery'
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
test.each(['insufficient', 'duplicate', 'checksum', 'other-account'])(
  'rejects %s without staging and preserves ceremony for retry',
  async kind => {
    const f = await signup()
    let shares = f.shares.slice(0, 2)
    if (kind === 'insufficient') shares = shares.slice(0, 1)
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
    ).resolves.toBeDefined()
    expect(accountSession.stage).toHaveBeenCalledTimes(1)
  },
)
test('accepts all shares when count exceeds threshold without rejecting as excess', async () => {
  const f = await signup()
  await expect(f.ceremony.confirm(f.shares, 'Fixture')).resolves.toBeDefined()
  expect(accountSession.stage).toHaveBeenCalledTimes(1)
})
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
  expect(staged.displayName).toBe('')
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
  const id = (share: string) => share.slice(8, 12)
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
  const data = Array.from(share.slice(3, -15), char =>
    GF32_ALPHABET.indexOf(char),
  )
  try {
    for (let i = 10; i < data.length; i++)
      data[i] = webcrypto.getRandomValues(new Uint8Array(1))[0] & 31
    return `fr1${[...data, ...createLongBchChecksum('fr', data)]
      .map(value => GF32_ALPHABET[value])
      .join('')}`
  } finally {
    data.fill(0)
  }
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

test('ten mixed root/historical strings require explicit selection before staging', async () => {
  const root = webcrypto.getRandomValues(new Uint8Array(32)),
    seed = webcrypto.getRandomValues(new Uint8Array(64)),
    other = webcrypto.getRandomValues(new Uint8Array(32))
  const make = (
    format: 'root' | 'historical',
    secret: Uint8Array,
    threshold: number,
    shareCount: number,
    identifier: string,
  ) =>
    exportRecoveryShares({
      format,
      secret,
      threshold,
      shareCount,
      identifier,
      randomBytes: length => webcrypto.getRandomValues(new Uint8Array(length)),
    })
  const ceremony = createAccountCeremony()
  try {
    const pile = [
      ...make('root', root, 2, 3, 'test'),
      ...make('historical', seed, 3, 5, 'test').slice(0, 3),
      ...make('root', other, 2, 3, 'test'),
      ...make('root', root, 1, 1, 'same'),
    ]
    expect(pile.length).toBe(10)
    await ceremony.beginRestore()
    const result = await ceremony.confirm(pile, '')
    expect(accountSession.stage).not.toHaveBeenCalled()
    if (!('candidates' in result))
      throw new Error('Expected explicit account selection')
    expect(result.candidates.length).toBe(3)
    expect(result.report.every(share => share.status === 'supports')).toBe(true)
    await ceremony.choose(1)
    expect(accountSession.stage).toHaveBeenCalledTimes(1)
    await expect(ceremony.choose(0)).rejects.toThrow()
    expect(accountSession.stage).toHaveBeenCalledTimes(1)
  } finally {
    ceremony.cancel()
    root.fill(0)
    seed.fill(0)
    other.fill(0)
  }
})

test('createDirect stages new account root immediately without backup shares', async () => {
  const ceremony = createAccountCeremony()
  try {
    const outcome = await ceremony.createDirect('Alice')
    expect(accountSession.stage).toHaveBeenCalledTimes(1)
    expect(outcome.isRestore).toBe(false)
    expect(typeof outcome.attemptId).toBe('string')
    const staged = (accountSession.stage as jest.Mock).mock.calls[0][0]
    expect(staged.displayName).toBe('Alice')
    expect(staged.accountRoot).toBeInstanceOf(Uint8Array)
    expect(staged.accountRoot.length).toBe(32)
    expect(staged.metadata).toBeDefined()
  } finally {
    ceremony.cancel()
  }
})

test('recoveryErrorMessage maps custody and input error codes without falling back to Codex32 share message', () => {
  expect(recoveryErrorMessage({ code: 'invalid-input' })).toBe(
    'The recovery phrase or input is invalid. Check your words and try again.',
  )
  expect(recoveryErrorMessage({ code: 'locked' })).toContain(
    'Account storage is locked',
  )
  expect(recoveryErrorMessage({ code: 'unavailable' })).toContain(
    'Account storage is currently unavailable',
  )
  expect(recoveryErrorMessage({ code: 'outdated-attempt' })).toContain(
    'outdated',
  )
})

test('capture cancels a stale pending attempt before staging a new ceremony', async () => {
  jest
    .mocked(accountSession.snapshot)
    .mockResolvedValueOnce({
      schema: 1,
      revision: 0,
      active: null,
      pending: {
        status: 'staging',
        account: {
          displayName: '',
          descriptor: 'stale',
          fingerprint: '00',
          receipt: {
            operationId: 'stale-attempt',
            context: {
              accountId: 'stale-account',
              custodyEpoch: 1,
              recoveryFormat: 'codex32-root32-v1',
              registry: 'frank-bip85-bip32-v1',
              purposes: [],
            },
          },
        },
        expectedActive: { revision: 0, accountId: null },
      },
    })
    .mockResolvedValueOnce({
      schema: 1,
      revision: 0,
      active: null,
      pending: null,
    })
  const ceremony = createAccountCeremony()
  try {
    await ceremony.createDirect('Alice')
    expect(accountSession.cancelPending).toHaveBeenCalledWith('stale-attempt')
    expect(accountSession.stage).toHaveBeenCalledTimes(1)
  } finally {
    ceremony.cancel()
  }
})


test('a restore that keeps pending attempts refuses, and leaves a durable pending signup alone', async () => {
  // Another tab began a signup after this tab read its status as fresh.
  jest.mocked(accountSession.snapshot).mockResolvedValueOnce({
    schema: 1,
    revision: 1,
    active: null,
    pending: {
      status: 'staging',
      account: {
        displayName: '',
        descriptor: 'other-tab',
        fingerprint: '00',
        receipt: {
          operationId: 'other-tab-signup',
          context: {
            accountId: 'other-tab-account',
            custodyEpoch: 1,
            recoveryFormat: 'codex32-root32-v1',
            registry: 'frank-bip85-bip32-v1',
            purposes: [],
          },
        },
      },
      expectedActive: { revision: 0, accountId: null },
    },
  })
  const ceremony = createAccountCeremony()
  await expect(
    ceremony.beginRestore(undefined, { keepPending: true }),
  ).rejects.toMatchObject({ name: 'CustodyError', code: 'conflict' })
  expect(accountSession.cancelPending).not.toHaveBeenCalled()
  expect(accountSession.stage).not.toHaveBeenCalled()
  // The refused ceremony cannot go on to stage anything.
  await expect(ceremony.confirm(['a', 'b'], 'Bob')).rejects.toThrow()
  expect(accountSession.stage).not.toHaveBeenCalled()
})
