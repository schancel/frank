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
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { provisionBotProfile } from '@frank/bot-framework/bot-profile-admission'
import { deriveDomainRoot } from '@frank/domain-roots'
import { bip32MasterFromDomainRoot } from '@frank/wallet/bip32-domain-root'
import { MONAD_IDENTITY_DERIVATION_PATH, MonadIdentity } from '@frank/wallet/monad-identity'

import { CuratedEntry } from '../print-curated-defaults'
import { BOT_PROFILES } from '../bot-directory'
import { DemoConfig, DemoConfigError } from './demo-config'

export interface BotIdentities {
  /** Display address of every bot, by bot name. */
  addresses: Record<string, string>
  /** The account each bot pays its message stamps from (its wallet's receive address), by bot
   * name. Public addresses only; the launcher reads their balances. */
  mainAccounts: Record<string, string>
  /** The relay's curated defaults: exactly the bots of this run, in `BOT_PROFILES` order. */
  curated: CuratedEntry[]
}

function writeIdentityFile(path: string, identity: MonadIdentity): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ privateKeyHex: identity.toPrivateKeyHex() }, null, 2), { mode: 0o600 })
}

/** The address of the profile's EVM main account, derived the way the wallet derives it
 * (`domainRootWalletMaterial`): the bot host funds it and every reply's stamp is paid from it. */
export function mainAccountAddress(profileDir: string): string {
  const accountRoot = Uint8Array.from(
    Buffer.from(readFileSync(join(profileDir, 'account-root.hex'), 'utf8').trim(), 'hex'),
  )
  try {
    const evm = deriveDomainRoot(accountRoot, 'evm-wallet')
    return bip32MasterFromDomainRoot(evm, 'evm-wallet').derivePath(MONAD_IDENTITY_DERIVATION_PATH).address
  } finally {
    accountRoot.fill(0)
  }
}

export async function prepareBotIdentities(config: DemoConfig): Promise<BotIdentities> {
  const addresses: Record<string, string> = {}
  const mainAccounts: Record<string, string> = {}
  const hostStateDir = config.botProcess.hostStateDir
  for (const bot of config.bots) {
    const profileDir = join(hostStateDir, 'bots', bot.name)
    let identity: MonadIdentity
    try {
      identity = await provisionBotProfile({
        stateDir: hostStateDir,
        botId: bot.name,
        identityPath: bot.identityJson,
        networkTag: config.networkTag,
      })
    } catch (err) {
      throw new DemoConfigError([
        `the ${bot.name} bot's saved profile cannot be reused: ${err instanceof Error ? err.message : String(err)}`,
        `  Its files are ${profileDir} and ${bot.identityJson}. They were written by an older version or by an interrupted first start, and the bot refuses to start on a profile it did not create itself.`,
        `  No key or saved message state was changed. These files hold the bot's key and so whatever its accounts hold on chain: do not delete them. To keep the other bots and their funds, move only ${profileDir} and ${bot.identityJson} aside; the bot then gets a new identity, which the funding wallet has to fund again.`,
      ])
    }
    // The exported copy of the identity, for tools that read it. Written only after the profile
    // exists: an identity file without a profile would make the host refuse the bot.
    writeIdentityFile(bot.identityJson, identity)
    addresses[bot.name] = identity.displayAddress
    mainAccounts[bot.name] = mainAccountAddress(profileDir)
  }
  const curated = BOT_PROFILES.flatMap(spec =>
    addresses[spec.key] ? [{ address: addresses[spec.key], name: spec.name }] : [],
  )
  return { addresses, mainAccounts, curated }
}
