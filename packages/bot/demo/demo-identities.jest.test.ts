/**
 * The launcher has to know every bot's address before the relay starts, so it creates the bot
 * profiles itself. The bot host then has to accept exactly what the launcher left behind: these
 * tests run the launcher's identity step on a real directory and admit each profile the way the
 * one bot process does (`FrankBotHost.register` goes through the same `admitBotProfile`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

import { admitBotProfile } from '@frank/bot-framework/bot-profile-admission'
import { bip32MasterFromDomainRoot } from '@frank/wallet/bip32-domain-root'
import { MONAD_IDENTITY_DERIVATION_PATH } from '@frank/wallet/monad-identity'

import { BOT_PROFILES } from '../bot-directory'
import { DemoConfig, DemoConfigError, resolveDemoConfig } from './demo-config'
import { prepareBotIdentities } from './demo-identities'

const BOTS = ['blackjack', 'raffle', 'vendor', 'qwen', 'faucet', 'lobby', 'rps', 'dice']

let dir: string
let stateDir: string
const configure = (): DemoConfig =>
  resolveDemoConfig({
    env: {
      FRANK_DEMO_STATE_DIR: stateDir,
      MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc.example.invalid',
      E2E_DEMO_MAIN_WALLET_JSON: join(dir, 'wallet.json'),
    },
    envFile: {},
    home: dir,
    cwd: dir,
  })

/** What the one bot process is started with for this bot: the shared host state directory and
 * the bot's identity file. Every bot definition reads `process.env[identityEnv] ?? default`. */
function started(config: DemoConfig, name: string) {
  const spec = BOT_PROFILES.find(s => s.key === name)!
  const env = config.botProcess.env
  return {
    stateDir: env.BOT_STATE_DIR,
    identityPath: env[spec.identityEnv] ?? spec.identityDefaultPath,
    configured: env[spec.identityEnv],
  }
}

async function admitted(config: DemoConfig, name: string): Promise<{ address: string; mainAccount: string }> {
  const { stateDir: hostStateDir, identityPath } = started(config, name)
  const profile = await admitBotProfile({
    stateDir: hostStateDir,
    botId: name,
    identityPath,
    network: 'monad-testnet',
  })
  await profile.operations.close()
  await profile.state.close()
  return {
    address: profile.operations.owner.address,
    // The account the wallet pays stamps from, derived from the roots the host hands the wallet.
    mainAccount: bip32MasterFromDomainRoot(profile.roots.evm, 'evm-wallet').derivePath(MONAD_IDENTITY_DERIVATION_PATH)
      .address,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'demo-identities-'))
  stateDir = join(dir, 'state')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('bot profiles the launcher creates', () => {
  it('gives every bot, the faucet included, an identity file inside the state directory', () => {
    const config = configure()
    expect(config.bots.map(b => b.name).sort()).toEqual([...BOTS].sort())
    for (const bot of config.bots) {
      const { configured, stateDir: hostStateDir } = started(config, bot.name)
      expect(configured).toBe(bot.identityJson)
      expect(configured!.startsWith(stateDir + sep)).toBe(true)
      expect(hostStateDir.startsWith(stateDir + sep)).toBe(true)
    }
  })

  it('are admitted by the bot host on a fresh state directory, at the announced addresses', async () => {
    const config = configure()
    const { addresses, mainAccounts } = await prepareBotIdentities(config)
    expect(Object.keys(addresses).sort()).toEqual([...BOTS].sort())
    for (const bot of config.bots) {
      const host = await admitted(config, bot.name)
      expect(host.address).toBe(addresses[bot.name].toLowerCase())
      // The launcher checks this account's balance on chain: it must be the one the wallet uses.
      expect(host.mainAccount).toBe(mainAccounts[bot.name])
      expect(mainAccounts[bot.name].toLowerCase()).not.toBe(addresses[bot.name].toLowerCase())
    }
    // Each bot keeps its own key: no two share an address.
    expect(new Set(Object.values(addresses)).size).toBe(BOTS.length)
    expect(new Set(Object.values(mainAccounts)).size).toBe(BOTS.length)
  })

  it('keep their addresses when the launcher and then the bots start again', async () => {
    const config = configure()
    const first = await prepareBotIdentities(config)
    for (const bot of config.bots) await admitted(config, bot.name)
    const second = await prepareBotIdentities(config)
    expect(second.addresses).toEqual(first.addresses)
    expect(second.mainAccounts).toEqual(first.mainAccounts)
    for (const bot of config.bots) {
      expect((await admitted(config, bot.name)).address).toBe(first.addresses[bot.name].toLowerCase())
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
    expect((failure as Error).message).toContain(join(stateDir, 'bot-host', 'bots', 'blackjack'))
    expect((failure as Error).message).not.toContain('11'.repeat(32))
    expect(readFileSync(identityPath, 'utf8')).toBe(saved)
    // No account root was adopted for it, and no other bot was created past it.
    expect(existsSync(join(stateDir, 'bot-host', 'bots', 'blackjack', 'account-root.hex'))).toBe(false)
    expect(readdirSync(join(stateDir, 'bot-host', 'bots'))).toEqual(['blackjack'])
  })
})
