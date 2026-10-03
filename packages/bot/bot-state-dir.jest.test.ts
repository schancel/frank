import { readFileSync } from 'fs'
import { join } from 'path'

import {
  botStateDir,
  defaultBotStateDir,
  legacyBotStateDir,
  persistentStateDir,
  planBotStateDir,
  StateDirBot,
} from './bot-state-dir'

const HOME = '/home/dummy'
const plan = (
  over: Partial<Parameters<typeof planBotStateDir>[0]> & { existing?: string[] } = {},
) =>
  planBotStateDir({
    bot: 'vendor',
    envVar: 'VENDOR_BOT_STATE_DIR',
    env: {},
    home: HOME,
    tmpDirs: ['/tmp', '/var/folders/x/T'],
    exists: p => (over.existing ?? []).includes(p),
    ...over,
  })

describe('bot state directories', () => {
  it('defaults to a persistent per-user path, XDG-aware', () => {
    expect(defaultBotStateDir('qwen', {}, HOME)).toBe('/home/dummy/.frank-bots/qwen')
    expect(defaultBotStateDir('raffle', { XDG_STATE_HOME: '/state' }, HOME)).toBe(
      '/state/frank-bots/raffle',
    )
    expect(plan().dir).toBe('/home/dummy/.frank-bots/vendor')
    expect(plan().notices).toEqual([])
  })

  it('ignores a relative XDG_STATE_HOME (per the XDG spec)', () => {
    expect(defaultBotStateDir('qwen', { XDG_STATE_HOME: 'relative/state' }, HOME)).toBe(
      '/home/dummy/.frank-bots/qwen',
    )
  })

  it('refuses to start when no absolute home or state dir can be determined', () => {
    for (const home of ['', 'relative/home']) {
      expect(() => defaultBotStateDir('qwen', {}, home)).toThrow(
        /Cannot determine a persistent state directory/,
      )
      expect(() => defaultBotStateDir('qwen', { XDG_STATE_HOME: 'rel' }, home)).toThrow(
        /HOME is unset or not absolute/,
      )
    }
    // An absolute XDG dir needs no home.
    expect(defaultBotStateDir('qwen', { XDG_STATE_HOME: '/state' }, '')).toBe(
      '/state/frank-bots/qwen',
    )
  })

  it('an explicit env override must be absolute', () => {
    expect(() => plan({ env: { VENDOR_BOT_STATE_DIR: 'state/vendor' } })).toThrow(
      /VENDOR_BOT_STATE_DIR must be an absolute path/,
    )
  })

  it('the env variable overrides the default', () => {
    expect(plan({ env: { VENDOR_BOT_STATE_DIR: '/data/vendor' } }).dir).toBe('/data/vendor')
  })

  it('warns when the directory is under the system temp dir', () => {
    const p = plan({ env: { VENDOR_BOT_STATE_DIR: '/tmp/x' } })
    expect(p.notices).toHaveLength(1)
    expect(p.notices[0]).toMatch(/under a temporary directory.*stranded.*VENDOR_BOT_STATE_DIR/)
    expect(plan({ env: { VENDOR_BOT_STATE_DIR: '/var/folders/x/T/y' } }).notices).toHaveLength(1)
    expect(plan({ env: { VENDOR_BOT_STATE_DIR: '/tmpfoo/y' } }).notices).toEqual([])
    // macOS: /tmp is /private/tmp, /var/tmp is /private/var/tmp.
    const macTmp = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp']
    for (const d of ['/private/tmp/x', '/var/tmp/x', '/private/var/tmp/x']) {
      expect(plan({ env: { VENDOR_BOT_STATE_DIR: d }, tmpDirs: macTmp }).notices).toHaveLength(1)
    }
  })

  it('prints one migration notice naming both paths when only the old /tmp default exists', () => {
    const old = legacyBotStateDir('vendor')
    expect(old).toBe('/tmp/vendor-bot-state')
    const p = plan({ existing: [old] })
    expect(p.dir).toBe('/home/dummy/.frank-bots/vendor')
    expect(p.notices).toHaveLength(1)
    expect(p.notices[0]).toContain(old)
    expect(p.notices[0]).toContain('/home/dummy/.frank-bots/vendor')
    expect(p.notices[0]).toMatch(/NOT used or moved automatically/)
    expect(p.notices[0]).toMatch(/inspect .* first \(who owns it/)
    expect(p.notices[0]).toContain(`${old}/stamp-pool-seed.json`)
    expect(p.notices[0]).not.toMatch(/\bmv\b/)
  })

  it('no migration notice when the new dir already exists, or the operator chose a path', () => {
    const old = legacyBotStateDir('vendor')
    expect(plan({ existing: [old, '/home/dummy/.frank-bots/vendor'] }).notices).toEqual([])
    expect(
      plan({ existing: [old], env: { VENDOR_BOT_STATE_DIR: old } }).notices.join(),
    ).not.toMatch(/moved from/)
  })

  it.each([
    ['qwen', 'qwen-bot.livecheck.ts', 'QWEN_BOT_STATE_DIR'],
    ['blackjack', 'blackjack-bot.livecheck.ts', 'BLACKJACK_BOT_STATE_DIR'],
    ['raffle', 'raffle-bot.livecheck.ts', 'RAFFLE_BOT_STATE_DIR'],
    ['vendor', 'vendor-bot.livecheck.ts', 'VENDOR_BOT_STATE_DIR'],
  ] as Array<[StateDirBot, string, string]>)(
    'the %s bot takes its state dir from botStateDir, not a /tmp default',
    (bot, file, envVar) => {
      const src = readFileSync(join(__dirname, file), 'utf8')
      expect(src).toContain(`botStateDir('${bot}', '${envVar}')`)
      expect(src).not.toMatch(new RegExp(`${envVar} \\?\\? '/tmp`))
    },
  )

  it('botStateDir (the real entry point) warns for /private/tmp and /var/tmp paths', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = process.env.VENDOR_BOT_STATE_DIR
    try {
      for (const d of ['/private/tmp/frank-x', '/var/tmp/frank-x']) {
        process.env.VENDOR_BOT_STATE_DIR = d
        expect(botStateDir('vendor', 'VENDOR_BOT_STATE_DIR')).toBe(d)
      }
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      if (saved === undefined) delete process.env.VENDOR_BOT_STATE_DIR
      else process.env.VENDOR_BOT_STATE_DIR = saved
      warn.mockRestore()
    }
  })

  it('uses an explicit persistent component path and rejects relative paths', () => {
    const saved = process.env.QWEN_SENDER_WALLET_STATE_DIR
    try {
      process.env.QWEN_SENDER_WALLET_STATE_DIR = '/data/qwen-sender'
      expect(
        persistentStateDir(
          'qwen-sender-wallet',
          'QWEN_SENDER_WALLET_STATE_DIR',
        ),
      ).toBe('/data/qwen-sender')
      process.env.QWEN_SENDER_WALLET_STATE_DIR = 'relative/wallet'
      expect(() =>
        persistentStateDir(
          'qwen-sender-wallet',
          'QWEN_SENDER_WALLET_STATE_DIR',
        ),
      ).toThrow(/must be an absolute path/)
    } finally {
      if (saved === undefined)
        delete process.env.QWEN_SENDER_WALLET_STATE_DIR
      else process.env.QWEN_SENDER_WALLET_STATE_DIR = saved
    }
  })
})
