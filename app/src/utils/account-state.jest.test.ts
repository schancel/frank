import {
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
] as const

describe('account state (#284)', () => {
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
        state === 'completed-unconfirmed' || state === 'confirmed',
      )
    },
  )

  it('a name without a seed passes the router gate but is not "complete" (walletRequired routes redirect it)', () => {
    const facts = { seedPhrase: null, name: 'Alice', seedConfirmedAt: null }
    expect(setupGatePasses(facts)).toBe(true)
    expect(isSetupComplete(facts)).toBe(false)
  })
})
