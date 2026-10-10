/**
 * The launcher has to know every bot's address before the relay starts, so it creates the bot
 * profiles itself. The bot host then has to accept exactly what the launcher left behind: these
 * tests run the launcher's identity step on a real directory and admit each profile the way the
 * bot's own process does (`FrankBotHost.register` goes through the same `admitBotProfile`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

import { admitBotProfile } from '@frank/bot-framework/bot-profile-admission'

import { BOT_PROFILES } from '../bot-directory'
import { DemoConfig, DemoConfigError, resolveDemoConfig } from './demo-config'
import { prepareBotIdentities } from './demo-identities'

/** The variable each bot's entry script reads its host state directory from. */
const STATE_DIR_ENV: Record<string, string> = {
  blackjack: 'BLACKJACK_BOT_STATE_DIR',
  raffle: 'RAFFLE_BOT_STATE_DIR',
  vendor: 'VENDOR_BOT_STATE_DIR',
  qwen: 'QWEN_BOT_STATE_DIR',
  faucet: 'FAUCET_STATE_DIR',
  lobby: 'LOBBY_BOT_STATE_DIR',
  rps: 'RPS_BOT_STATE_DIR',
  dice: 'DICE_BOT_STATE_DIR',
}

let dir: string
let stateDir: string
const configure = (fake = true): DemoConfig =>
  resolveDemoConfig({
    env: fake
      ? { FRANK_DEMO_STATE_DIR: stateDir }
      : {
          FRANK_DEMO_STATE_DIR: stateDir,
          MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc.example.invalid',
          E2E_DEMO_MAIN_WALLET_JSON: join(dir, 'wallet.json'),
          FRANK_DEMO_FAUCET_WALLET_JSON: join(dir, 'faucet.json'),
        },
    envFile: {},
    fakeChainFlag: fake,
    home: dir,
    cwd: dir,
  })

/** What the bot's own process is started with: its state directory and identity file. */
function started(config: DemoConfig, name: string) {
  const bot = config.bots.find(b => b.name === name)!
  const spec = BOT_PROFILES.find(s => s.key === name)!
  return {
    stateDir: bot.env[STATE_DIR_ENV[name]],
    // Every bot definition reads `process.env[identityEnv] ?? identityDefaultPath`.
    identityPath: bot.env[spec.identityEnv] ?? spec.identityDefaultPath,
    configured: bot.env[spec.identityEnv],
  }
}

async function admittedAddress(config: DemoConfig, name: string): Promise<string> {
  const { stateDir: hostStateDir, identityPath } = started(config, name)
  const profile = await admitBotProfile({
    stateDir: hostStateDir,
    botId: name,
    identityPath,
    network: 'monad-testnet',
  })
  await profile.operations.close()
  await profile.state.close()
  return profile.operations.owner.address
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'demo-identities-'))
  stateDir = join(dir, 'state')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe.each([
  ['the fake chain', true],
  ['a real network', false],
])('bot profiles the launcher creates on %s', (_label, fake) => {
  it('gives every bot, the faucet included, an identity file inside the state directory', () => {
    const config = configure(fake)
    expect(config.bots.map(b => b.name).sort()).toEqual(Object.keys(STATE_DIR_ENV).sort())
    for (const bot of config.bots) {
      const { configured, stateDir: hostStateDir } = started(config, bot.name)
      expect(configured).toBeDefined()
      expect(configured!.startsWith(stateDir + sep)).toBe(true)
      expect(hostStateDir.startsWith(stateDir + sep)).toBe(true)
    }
  })

  it('are admitted by the bot host on a fresh state directory, at the announced address', async () => {
    const config = configure(fake)
    const { addresses } = await prepareBotIdentities(config)
    expect(Object.keys(addresses).sort()).toEqual(Object.keys(STATE_DIR_ENV).sort())
    for (const bot of config.bots) {
      expect(await admittedAddress(config, bot.name)).toBe(addresses[bot.name].toLowerCase())
    }
  })

  it('keep their addresses when the launcher and then the bots start again', async () => {
    const config = configure(fake)
    const first = await prepareBotIdentities(config)
    for (const bot of config.bots) await admittedAddress(config, bot.name)
    const second = await prepareBotIdentities(config)
    expect(second.addresses).toEqual(first.addresses)
    for (const bot of config.bots) {
      expect(await admittedAddress(config, bot.name)).toBe(first.addresses[bot.name].toLowerCase())
    }
  })
})

describe('a bot profile the launcher did not create', () => {
  it('is refused with the directory to move away, and is left exactly as it was', async () => {
    const config = configure()
    const { identityPath } = started(config, 'blackjack')
    mkdirSync(join(stateDir, 'bots', 'blackjack'), { recursive: true })
    const saved = JSON.stringify({ privateKeyHex: '0x' + '11'.repeat(32) })
    writeFileSync(identityPath, saved, { mode: 0o600 })

    const failure = await prepareBotIdentities(config).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(DemoConfigError)
    expect((failure as Error).message).toContain(join(stateDir, 'bots', 'blackjack'))
    expect((failure as Error).message).not.toContain('11'.repeat(32))
    expect(readFileSync(identityPath, 'utf8')).toBe(saved)
    // No account root was adopted for it, and no other bot was created past it.
    expect(existsSync(join(stateDir, 'bots', 'blackjack', 'state', 'bots', 'blackjack', 'account-root.hex'))).toBe(false)
    expect(readdirSync(join(stateDir, 'bots'))).toEqual(['blackjack'])
  })
})
