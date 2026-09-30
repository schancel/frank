/**
 * Prints the relay's curated-default-contact config for the demo bots (#317):
 *
 *   cd packages/bot && yarn -s curated-defaults >> relay-curated.toml
 *
 * Paste/append the `[[registry.curated_defaults]]` blocks into the relay's config (see
 * `backend/docker/cashwebd.toml`), then restart the relay: `GET /metadata/monad/curated-defaults`
 * then lists the bots and the app shows them in Contacts for a new user. Addresses are derived
 * from each bot's identity file (`*_BOT_IDENTITY_JSON`, created on first use exactly like the bots
 * themselves do), so they are per machine/network, never hard-coded. Only addresses and names are
 * printed: no key material. Progress logs go to stderr so stdout is pure TOML.
 */
import { resolve } from 'path'

import { BOT_PROFILES } from './bot-directory'
import { loadOrCreateIdentity } from './qwen-bot-common'

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

export function botCuratedEntries(
  env: Record<string, string | undefined>,
  load: (path: string, label: string) => { displayAddress: string },
): CuratedEntry[] {
  return BOT_PROFILES.map(spec => ({
    address: load(
      resolve(process.cwd(), env[spec.identityEnv] ?? spec.identityDefaultPath),
      spec.key,
    ).displayAddress,
    name: spec.name,
  }))
}

if (require.main === module) {
  // `loadOrCreateIdentity` logs progress with console.log; keep stdout clean for the TOML.
  const log = console.log
  console.log = (...args: unknown[]) => console.error(...args)
  const entries = botCuratedEntries(process.env, loadOrCreateIdentity)
  console.log = log
  process.stdout.write(renderCuratedDefaultsToml(entries))
}
