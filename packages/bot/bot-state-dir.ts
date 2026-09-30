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
import { join, resolve, sep } from 'path'

export type StateDirBot = 'qwen' | 'blackjack' | 'raffle' | 'vendor'

export function defaultBotStateDir(
  bot: StateDirBot,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const base = env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, 'frank-bots') : join(home, '.frank-bots')
  return join(base, bot)
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
        `Move it (mv ${legacy} ${dir}) or keep using it by setting ${params.envVar}=${legacy}.`,
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
    tmpDirs: [tmpdir(), '/tmp'],
    exists: existsSync,
  })
  for (const line of plan.notices) console.warn(`[${bot}] ${line}`)
  return plan.dir
}
