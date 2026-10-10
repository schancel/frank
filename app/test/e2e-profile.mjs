// The Chrome profile of a browser check, kept between runs.
//
// A browser check creates a Frank account inside its Chrome profile and funds it with real
// testnet MON. The account's keys exist only in that profile, so the profile is PERSISTENT:
// `~/.frank-e2e-browser/<check>/` (or E2E_PROFILE_DIR), created once and reused. The same account
// is opened on every run and funded only when it holds less than the run needs; what a run leaves
// stays in the account for the next one. Nothing here ever deletes the profile: deleting it loses
// the account and whatever it holds. To run a check's first-time onboarding again, point
// E2E_PROFILE_DIR at a new directory (that account then has its own money; its address is
// printed).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The profile directory of `check`, created when missing, and the account recorded in it. */
export async function persistentProfile(check) {
  const directory = resolve(
    process.env.E2E_PROFILE_DIR ?? join(homedir(), '.frank-e2e-browser', check),
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Addresses only (no key): written once the account exists, so the next run knows to open it
  // instead of creating another.
  const marker = join(directory, 'frank-account.json')
  let account
  try {
    account = JSON.parse(await readFile(marker, 'utf8'))
  } catch {
    account = undefined
  }
  return {
    directory,
    /** `{ receive, profile?, createdAt }` of the account in this profile, or undefined on a first run. */
    account,
    async recordAccount(addresses) {
      await writeFile(
        marker,
        JSON.stringify({ ...addresses, createdAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      )
    },
  }
}

/** The line every check prints last: where the money is and that it is kept. */
export function accountLine(directory, address, balanceWei) {
  const mon = (Number(BigInt(balanceWei) / 10n ** 12n) / 1e6).toFixed(6)
  return `ACCOUNT ${address} holds ${mon} MON; its keys are in the persistent profile ${directory} (reused by the next run; do not delete it)`
}
