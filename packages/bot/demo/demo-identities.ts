/**
 * The launcher's identity step: every bot's address has to be known before the relay starts (the
 * curated defaults are relay configuration), so the launcher creates the bot profiles ahead of
 * the bots.
 *
 * The bot host owns a profile: its account root, its state store and the rule for when a profile
 * may be created (`admitBotProfile` in `@frank/bot-framework`). The launcher therefore asks the
 * host's own provisioning for each profile instead of writing an account root or an identity file
 * first. A root or identity that the host did not create is, to the host, a previously used
 * identity on a new state path, and it refuses to start on it.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { provisionBotProfile } from '@frank/bot-framework/bot-profile-admission'
import { MonadIdentity } from '@frank/wallet/monad-identity'

import { loadQwenCanonicalRoots } from '../qwen-bot-common'
import { CuratedEntry } from '../print-curated-defaults'
import { BOT_PROFILES } from '../bot-directory'
import { DemoConfig, DemoConfigError } from './demo-config'

export interface BotIdentities {
  /** Display address of every bot that has a profile, by bot name. */
  addresses: Record<string, string>
  /** The relay's curated defaults: exactly the bots of this run, in `BOT_PROFILES` order. */
  curated: CuratedEntry[]
}

function writeIdentityFile(path: string, identity: MonadIdentity): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ privateKeyHex: identity.toPrivateKeyHex() }, null, 2), { mode: 0o600 })
}

export async function prepareBotIdentities(config: DemoConfig): Promise<BotIdentities> {
  const addresses: Record<string, string> = {}
  for (const bot of config.bots) {
    if (!bot.identityJson) continue
    if (bot.env.QWEN_BOT_CANONICAL_ROOTS_JSON) {
      mkdirSync(dirname(bot.env.QWEN_BOT_CANONICAL_ROOTS_JSON), { recursive: true, mode: 0o700 })
      const roots = loadQwenCanonicalRoots(bot.env.QWEN_BOT_CANONICAL_ROOTS_JSON)
      const identity = MonadIdentity.fromDomainRoot(roots.authentication)
      writeIdentityFile(bot.identityJson, identity)
      addresses[bot.name] = identity.displayAddress
      continue
    }
    let identity: MonadIdentity
    try {
      identity = await provisionBotProfile({
        stateDir: bot.hostStateDir,
        botId: bot.name,
        identityPath: bot.identityJson,
        networkTag: config.networkTag,
      })
    } catch (err) {
      const profileDir = join(bot.hostStateDir, 'bots', bot.name)
      throw new DemoConfigError([
        `the ${bot.name} bot's saved profile cannot be reused: ${err instanceof Error ? err.message : String(err)}`,
        `  Its files are ${profileDir} and ${bot.identityJson}. They were written by an older version or by an interrupted first start, and the bot refuses to start on a profile it did not create itself.`,
        `  No key or saved message state was changed. Start with a new FRANK_DEMO_STATE_DIR, or move ${config.stateDir} away if nothing in it is needed.`,
      ])
    }
    // The exported copy of the identity, for tools that read it. Written only after the profile
    // exists: an identity file without a profile would make the host refuse the bot.
    writeIdentityFile(bot.identityJson, identity)
    addresses[bot.name] = identity.displayAddress
  }
  const curated = BOT_PROFILES.flatMap(spec =>
    addresses[spec.key] ? [{ address: addresses[spec.key], name: spec.name }] : [],
  )
  return { addresses, curated }
}
