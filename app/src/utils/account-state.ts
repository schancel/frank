/**
 * Onboarding state of the stored account, derived from what is already persisted (#284).
 * Pure: reads no store and writes nothing.
 *
 * Grandfathering rule (the migration for accounts that predate the confirmation marker):
 *   - COMPLETED  = a stored seed AND a stored display name. Such an account finished onboarding
 *     (before or after the recovery-phrase confirmation existed) and is never sent back to
 *     onboarding, whether or not `seedConfirmedAt` is set. No data is rewritten to grandfather it.
 *   - NEEDS_RECOVERY = a stored seed and NO display name (accounts created by the old /setup bug,
 *     #267, which persisted a generated seed on open). Not treated as set up: the user is routed
 *     to /setup in resume mode, which shows the STORED phrase (never regenerates it), asks them to
 *     confirm it and choose a name.
 *   - FRESH = no stored seed and no stored name (never started, or a reload mid-setup: nothing
 *     is persisted until the final step).
 *   - NAME_ONLY = a stored display name and NO seed (legacy profile-only account, #308). Passes the
 *     router gate but requires replace acknowledgement to overwrite in /setup.
 *   - A completed account with no marker is offered a dismissible backup reminder
 *     (needsBackupConfirmation); it is never blocked.
 */
export type AccountState =
  | 'fresh'
  | 'needs-recovery'
  | 'completed-unconfirmed'
  | 'confirmed'
  | 'name-only'

export interface StoredAccountFacts {
  seedPhrase: string | null | undefined
  name: string | null | undefined
  seedConfirmedAt: number | null | undefined
}

export function classifyAccount(facts: StoredAccountFacts): AccountState {
  if (!facts.seedPhrase) return facts.name ? 'name-only' : 'fresh'
  if (!facts.name) return 'needs-recovery'
  return facts.seedConfirmedAt != null ? 'confirmed' : 'completed-unconfirmed'
}

/** The account may use the app (no onboarding redirect). Needs a seed and a name. */
export function isSetupComplete(facts: StoredAccountFacts): boolean {
  const state = classifyAccount(facts)
  return state === 'completed-unconfirmed' || state === 'confirmed'
}

export function needsBackupConfirmation(facts: StoredAccountFacts): boolean {
  return classifyAccount(facts) === 'completed-unconfirmed'
}

/**
 * The onboarding gate used by the router: may this account leave /setup for the app?
 * A display name is sufficient (legacy accounts whose name predates the stored seed keep working;
 * routes that need a wallet independently require a seed). A stored seed WITHOUT a name never
 * passes (#284). `isSetupComplete` is stricter (seed and name) and drives `status.setup`; the
 * two differ only for a name with no seed, which the router's walletRequiredRoutes redirect.
 */
export function setupGatePasses(facts: StoredAccountFacts): boolean {
  return !!facts.name
}
