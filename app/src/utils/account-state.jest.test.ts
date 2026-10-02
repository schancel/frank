import {
  accountDigest,
  classifyAccount,
  isSetupComplete,
  needsBackupConfirmation,
  setupGatePasses,
} from './account-state'

const SEED = 'test test test test test test test test test test test junk'

// One row per account state named in #284.
const cases = [
  {
    label: 'fresh (never started)',
    facts: { seedPhrase: null, name: undefined, seedConfirmedAt: undefined },
    state: 'fresh',
    complete: false,
    reminder: false,
  },
  {
    label: 'mid-setup reload (nothing persisted yet)',
    facts: { seedPhrase: null, name: '', seedConfirmedAt: null },
    state: 'fresh',
    complete: false,
    reminder: false,
  },
  {
    label: 'completed-old (seed + name, no marker): grandfathered',
    facts: { seedPhrase: SEED, name: 'Alice', seedConfirmedAt: undefined },
    state: 'completed-unconfirmed',
    complete: true,
    reminder: true,
  },
  {
    label: 'affected-by-#267 (seed, no name)',
    facts: { seedPhrase: SEED, name: undefined, seedConfirmedAt: null },
    state: 'needs-recovery',
    complete: false,
    reminder: false,
  },
  {
    label: 'confirmed (seed + name + marker)',
    facts: { seedPhrase: SEED, name: 'Alice', seedConfirmedAt: 1 },
    state: 'confirmed',
    complete: true,
    reminder: false,
  },
  {
    label: 'legacy profile (name only, no seed, #308)',
    facts: { seedPhrase: null, name: 'Alice', seedConfirmedAt: null },
    state: 'name-only',
    complete: false,
    reminder: false,
  },
] as const

describe('account state (#284, #308)', () => {
  it.each(cases)('$label', ({ facts, state, complete, reminder }) => {
    expect(classifyAccount(facts)).toBe(state)
    expect(isSetupComplete(facts)).toBe(complete)
    expect(needsBackupConfirmation(facts)).toBe(reminder)
  })

  it('a completed-old account is never treated as needing onboarding, marker or not', () => {
    for (const seedConfirmedAt of [null, undefined, 0, 123]) {
      expect(
        isSetupComplete({ seedPhrase: SEED, name: 'Alice', seedConfirmedAt }),
      ).toBe(true)
    }
  })

  it.each(cases)(
    'router gate agrees with the state table: $label',
    ({ facts, state }) => {
      // Seed-only (needs-recovery) never passes; every named account passes.
      expect(setupGatePasses(facts)).toBe(
        state === 'completed-unconfirmed' ||
          state === 'confirmed' ||
          state === 'name-only',
      )
    },
  )

  it('a name without a seed passes the router gate, classifies as name-only, and is not "complete" (walletRequired routes redirect it)', () => {
    const facts = { seedPhrase: null, name: 'Alice', seedConfirmedAt: null }
    expect(setupGatePasses(facts)).toBe(true)
    expect(classifyAccount(facts)).toBe('name-only')
    expect(isSetupComplete(facts)).toBe(false)
  })

  describe('accountDigest (#308)', () => {
    it('returns fresh for fresh accounts', () => {
      expect(
        accountDigest({
          seedPhrase: null,
          name: null,
          seedConfirmedAt: null,
        }),
      ).toBe('fresh')
      expect(
        accountDigest({
          seedPhrase: undefined,
          name: undefined,
          seedConfirmedAt: undefined,
        }),
      ).toBe('fresh')
    })

    it('returns deterministic digest for name-only account', () => {
      expect(
        accountDigest({
          seedPhrase: null,
          name: 'Alice',
          seedConfirmedAt: null,
        }),
      ).toBe('name-only::::Alice::')
    })

    it('returns distinct digests for different account facts', () => {
      const digest1 = accountDigest({
        seedPhrase: 'seed1',
        name: 'Alice',
        seedConfirmedAt: 10,
      })
      const digest2 = accountDigest({
        seedPhrase: 'seed2',
        name: 'Alice',
        seedConfirmedAt: 10,
      })
      const digest3 = accountDigest({
        seedPhrase: 'seed1',
        name: 'Bob',
        seedConfirmedAt: 10,
      })
      const digest4 = accountDigest({
        seedPhrase: 'seed1',
        name: 'Alice',
        seedConfirmedAt: 20,
      })

      expect(digest1).not.toBe(digest2)
      expect(digest1).not.toBe(digest3)
      expect(digest1).not.toBe(digest4)
    })
  })
})
