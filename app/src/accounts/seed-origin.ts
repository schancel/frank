/**
 * Whether this device generated the account's seed, and when. A new seed has no chain history,
 * so its wallets skip the initial gap-limit walk of the seed's branches (owner ruling,
 * 2026-11-16). Restored, synced and imported accounts are never marked and walk in full.
 *
 * Device-local and advisory: the mark lives in this browser's storage, keyed by the local account
 * id (a fresh random id per ceremony attempt). Losing it (cleared storage, another browser) only
 * means a full walk, the safe default; nothing derives from it and it is never synced.
 */
const KEY_PREFIX = 'frank:seed-generated-here:v1:'

/** Records that this device generated the seed of `accountId` at `atMs`. */
export function recordSeedGeneratedHere(accountId: string, atMs = Date.now()) {
  try {
    globalThis.localStorage?.setItem(KEY_PREFIX + accountId, String(atMs))
  } catch {
    // Without the mark the account walks in full, as a restored one does.
  }
}

/** When this device generated the seed of `accountId`; undefined when it did not (or cannot
 * tell). */
export function seedGeneratedHereAt(
  accountId: string | undefined,
): number | undefined {
  if (!accountId) return undefined
  try {
    const raw = globalThis.localStorage?.getItem(KEY_PREFIX + accountId)
    const atMs = raw == null ? NaN : Number(raw)
    return Number.isSafeInteger(atMs) && atMs > 0 ? atMs : undefined
  } catch {
    return undefined
  }
}
