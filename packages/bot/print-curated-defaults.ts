/**
 * Prints the relay's curated-default-contact config for the demo bots (#317):
 *
 *   cd packages/bot && yarn -s curated-defaults >> relay-curated.toml
 *
 * Paste/append the `[[registry.curated_defaults]]` blocks into the relay's config (see
 * `backend/docker/cashwebd.toml`), then restart the relay: `GET /metadata/monad/curated-defaults`
 * then lists the bots and the app shows them in Contacts for a new user. Addresses are derived
 * from each bot's identity file (`*_BOT_IDENTITY_JSON`), so they are per machine/network, never
 * hard-coded. Read-only: it never creates an identity file and fails naming every missing one
 * (start those bots once); `--create-missing` explicitly opts in to creating them. Only addresses and names are
 * printed: no key material. Progress logs go to stderr so stdout is pure TOML.
 */
import { resolve } from 'path'

import { BOT_PROFILES } from './bot-directory'
import { loadExistingIdentity, loadOrCreateIdentity } from './qwen-bot-common'

export interface CuratedEntry {
  address: string
  name: string
}

/** TOML string literal for a display name (basic string, escaping `\` and `"`). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderCuratedDefaultsToml(entries: CuratedEntry[]): string {
  return entries
    .map(
      entry =>
        `[[registry.curated_defaults]]\naddress = ${tomlString(
          entry.address,
        )}\nname = ${tomlString(entry.name)}\n`,
    )
    .join('\n')
}

type Loader = (path: string, label: string) => { displayAddress: string }

/** Every bot's entry, plus one error per bot whose identity could not be loaded, so the operator
 * sees all missing identity files at once. */
export function collectCuratedEntries(
  env: Record<string, string | undefined>,
  load: Loader,
): { entries: CuratedEntry[]; errors: string[] } {
  const entries: CuratedEntry[] = []
  const errors: string[] = []
  for (const spec of BOT_PROFILES) {
    try {
      const path = resolve(
        process.cwd(),
        env[spec.identityEnv] ?? spec.identityDefaultPath,
      )
      entries.push({
        address: load(path, spec.key).displayAddress,
        name: spec.name,
      })
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { entries, errors }
}

export function botCuratedEntries(
  env: Record<string, string | undefined>,
  load: Loader,
): CuratedEntry[] {
  const { entries, errors } = collectCuratedEntries(env, load)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return entries
}

if (require.main === module) {
  // Read-only by default: identity files are never created here. `--create-missing` opts in (for
  // a launcher that runs this before the bots ever started).
  const create = process.argv.includes('--create-missing')
  // Loaders log progress with console.log; keep stdout clean for the TOML.
  const log = console.log
  console.log = (...args: unknown[]) => console.error(...args)
  const { entries, errors } = collectCuratedEntries(
    process.env,
    create ? loadOrCreateIdentity : loadExistingIdentity,
  )
  console.log = log
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    console.error(
      'Nothing printed. Start those bots once, or pass --create-missing.',
    )
    process.exit(1)
  }
  process.stdout.write(renderCuratedDefaultsToml(entries))
}
