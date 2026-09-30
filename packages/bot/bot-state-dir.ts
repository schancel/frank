/**
 * Default state directories for the bots (#313 review). They hold the stamp pool seed and the
 * bot's durable state, so they must survive reboots and tmp cleaners: the default is a per-user
 * persistent path, `$XDG_STATE_HOME/frank-bots/<bot>` when XDG_STATE_HOME is set, otherwise
 * `~/.frank-bots/<bot>`. The `<BOT>_BOT_STATE_DIR` variable still overrides it.
 *
 * The old default was `/tmp/<bot>-bot-state`. Nothing is moved automatically (that would be moving
 * key material behind the operator's back): when the old directory exists and the new one does
 * not, one notice names both paths so the operator can move it, or keep using it by setting the
 * variable. A directory under the system temp dir gets a warning either way.
 */
import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'

export type StateDirBot = 'qwen' | 'blackjack' | 'raffle' | 'vendor'

export function defaultBotStateDir(
  bot: StateDirBot,
  env: Record<string, string | undefined>,
  home: string,
): string {
  // Per the XDG spec a relative XDG_STATE_HOME is ignored. Anything relative would otherwise resolve
  // against the cwd, and a different cwd would silently start a new seed.
  const xdg = env.XDG_STATE_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, 'frank-bots', bot)
  if (!home || !isAbsolute(home)) {
    throw new Error(
      `Cannot determine a persistent state directory for the ${bot} bot: HOME is unset or not absolute. ` +
        'Set HOME, XDG_STATE_HOME, or the bot\'s *_BOT_STATE_DIR variable to an absolute path.',
    )
  }
  return join(home, '.frank-bots', bot)
}

export function legacyBotStateDir(bot: StateDirBot): string {
  return `/tmp/${bot}-bot-state`
}

export function isUnderTmp(dir: string, tmpDirs: readonly string[]): boolean {
  const resolved = resolve(dir)
  return tmpDirs.map(t => resolve(t)).some(t => resolved === t || resolved.startsWith(t + sep))
}

/** Pure decision: the directory to use plus the notices to print. */
export function planBotStateDir(params: {
  bot: StateDirBot
  envVar: string
  env: Record<string, string | undefined>
  home: string
  tmpDirs: readonly string[]
  exists: (path: string) => boolean
}): { dir: string; notices: string[] } {
  const explicit = params.env[params.envVar]
  if (explicit && !isAbsolute(explicit)) {
    throw new Error(
      `${params.envVar} must be an absolute path (got "${explicit}"): a relative path would resolve against the current directory and a different one would silently start a new seed.`,
    )
  }
  const dir = resolve(explicit || defaultBotStateDir(params.bot, params.env, params.home))
  const notices: string[] = []
  if (isUnderTmp(dir, params.tmpDirs)) {
    notices.push(
      `WARNING: state directory ${dir} is under a temporary directory; if it is cleared, the stamp pool seed is lost and funds on its sub-accounts are stranded. Set ${params.envVar} to a persistent path.`,
    )
  }
  const legacy = legacyBotStateDir(params.bot)
  if (!explicit && params.exists(legacy) && !params.exists(dir)) {
    notices.push(
      `NOTICE: the default state directory moved from ${legacy} to ${dir}. Your existing state (including the stamp pool seed) is still in ${legacy} and is NOT used or moved automatically. ` +
        `/tmp is shared: inspect ${legacy} first (who owns it, what is in it). Only if it is yours, copy the seed file (${legacy}/stamp-pool-seed.json) into ${dir}, ` +
        `along with its sub-account-pool and change-pool directories if you want to avoid reusing spent sub-accounts. Or keep using it by setting ${params.envVar}=${legacy}.`,
    )
  }
  return { dir, notices }
}

export function botStateDir(bot: StateDirBot, envVar: string): string {
  const plan = planBotStateDir({
    bot,
    envVar,
    env: process.env,
    home: homedir(),
    tmpDirs: [tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'],
    exists: existsSync,
  })
  for (const line of plan.notices) console.warn(`[${bot}] ${line}`)
  return plan.dir
}
