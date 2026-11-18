/**
 * The swap and coin-note livechecks load the way their headers say to run them
 * (`yarn workspace @frank/bot livecheck:...`, which runs `node --import tsx` in packages/bot).
 * They reach @frank/crypto-box and @frank/nakamoto through @frank/cashweb; those packages
 * export only a built ESM entry, so the script loads only when tsx reads packages/bot's
 * tsconfig `paths`. Started without their settings, each stops at its own first check, before
 * any network or wallet: that is proof the whole module graph loaded.
 */
import { spawnSync } from 'child_process'
import { resolve } from 'path'

import botPackage from '../package.json'

const botDir = resolve(__dirname, '..')

const livechecks = [
  ['livecheck:solana-swap-note', /Set SWAP_LIVECHECK_RELAY_URL/],
  ['livecheck:swap-note', /Set SWAP_LIVECHECK_RELAY_URL/],
  ['livecheck:received-coin-note', /Set COIN_NOTE_LIVECHECK_DIR/],
] as const

it.each(livechecks)(
  '%s loads every module it imports',
  (script, firstCheck) => {
    const command = (botPackage.scripts as Record<string, string>)[script]
    expect(command).toMatch(/^node --import tsx demo\/\S+\.livecheck\.ts$/)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(SWAP_LIVECHECK_|COIN_NOTE_LIVECHECK_|TSX_TSCONFIG_PATH$)/.test(
            key,
          ),
      ),
    )
    const run = spawnSync(process.execPath, command.split(' ').slice(1), {
      cwd: botDir,
      env,
      encoding: 'utf8',
      timeout: 110_000,
    })
    const output = `${run.stdout}${run.stderr}`
    expect(output).not.toMatch(
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module/,
    )
    expect(output).toMatch(firstCheck)
  },
  120_000,
)
