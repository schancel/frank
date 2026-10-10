import { readFileSync } from 'fs'
import { join } from 'path'

import { MAX_AMOUNT_WEI } from '../src/bots/faucet-bot'
import {
  DEMO_DEFAULT_BURN_ADDRESS,
  DEMO_FAUCET_AMOUNT_WEI,
  DEMO_VARS,
  DemoConfigError,
  renderDemoVarTable,
  resolveDemoConfig,
  resolveDirectoryDemoConfig,
} from './demo-config'
import { childEnv } from './supervisor'
import {
  RAFFLE_DEFAULT_ENTRY_PRICE_WEI,
  RAFFLE_DEFAULT_MAX_ENTRIES,
} from '../src/bots/raffle-bot'

const HOME = '/home/dummy'
const REAL_ENV = {
  MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc.example.invalid/v2/dummy-key',
  MONAD_TESTNET_WS_RPC_URL: 'wss://rpc.example.invalid/v2/dummy-key',
  E2E_DEMO_MAIN_WALLET_JSON: 'wallet.json',
}
const REAL = (env: Record<string, string> = {}, envFile: Record<string, string> = {}) =>
  resolveDemoConfig({
    env: { ...REAL_ENV, ...env },
    envFile,
    home: HOME,
    cwd: '/work',
  })

describe('explicit directory integration configuration', () => {
  const p = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const trust = {
    network: 'monad-testnet', subject: p, rev0T1: '11'.repeat(32), relayId: '00'.repeat(16),
    relayIdentity: { keyType: 1, point: p }, endpoint: 'https://127.0.0.1:19443', bindingExpiryNs: '1700000600000000000',
  }
  const complete = () => ({
    mode: 'synthetic-directory-admission', intent: 'new', nowNs: '1700000100000000001',
    bundle: { runDir: '/tmp/directory-trust-explicit', manifestIdentity: '22'.repeat(32) },
    installed: trust, participants: { 'relay-a': trust, 'relay-b': trust, bot: trust },
    location: '/tmp/directory-admission.level', continuityFile: '/tmp/directory-continuity.json', statementHex: '01',
  })
  it('selects the complete public configuration atomically without defaults or private account material', () => {
    const config = resolveDirectoryDemoConfig(complete())
    expect(config.installed.subject).toBe(p)
    expect(config.nowNs).toBe(1700000100000000001n)
    expect(config.intent).toBe('new')
    expect(config).not.toHaveProperty('wallet')
    expect(REAL()).not.toHaveProperty('directory')
  })
  it('requires an explicit loopback backend for route transport and retains the installed public endpoint', () => {
    const input = { ...complete(), routeTransport: { backendUrl: 'http://127.0.0.1:18098' } }
    expect(resolveDirectoryDemoConfig(input).routeTransport!.backendUrl).toBe(input.routeTransport.backendUrl)
    expect(resolveDirectoryDemoConfig(input).installed.endpoint).toBe(trust.endpoint)
    for (const backendUrl of ['https://127.0.0.1:18098', 'http://remote.invalid:18098', 'http://127.0.0.1:18098/path', 'http://user@127.0.0.1:18098'])
      expect(() => resolveDirectoryDemoConfig({ ...complete(), routeTransport: { backendUrl } })).toThrow()
  })
  it('keeps pending/mismatched participant sets unselected', () => {
    for (const participants of [undefined, { 'relay-a': trust, 'relay-b': null, bot: trust }, { 'relay-a': trust, 'relay-b': trust, bot: { ...trust, rev0T1: '33'.repeat(32) } }])
      expect(() => resolveDirectoryDemoConfig({ ...complete(), participants })).toThrow()
    expect(() => resolveDirectoryDemoConfig({ ...complete(), mode: undefined })).toThrow()
    expect(() => resolveDirectoryDemoConfig({ ...complete(), nowNs: 1700000100000000001 })).toThrow()
    expect(() => resolveDirectoryDemoConfig({ ...complete(), statementHex: undefined })).toThrow()
  })
})

function problemsOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (err) {
    if (err instanceof DemoConfigError) return err.problems
    throw err
  }
  return []
}

describe('resolveDemoConfig', () => {
  it('runs on Monad testnet with one wallet and every bot in ONE process, all state under the state dir', () => {
    const c = REAL()
    expect(c.rpcUrl).toBe(REAL_ENV.MONAD_TESTNET_HTTP_RPC_URL)
    expect(c.stateDir).toBe(join(HOME, '.frank-demo'))
    expect(c.mainWalletJson).toBe('/work/wallet.json')
    const names = ['blackjack', 'raffle', 'vendor', 'qwen', 'faucet', 'lobby', 'rps', 'dice']
    expect(c.bots.map(b => b.name)).toEqual(names)
    // One process, the framework's multi-bot entry point, told which bots to run.
    expect(c.botProcess.script).toBe('targets/all-bots.ts')
    expect(c.botProcess.env.FRANK_BOTS).toBe(names.join(','))
    expect(c.botProcess.hostStateDir).toBe(join(HOME, '.frank-demo', 'bot-host'))
    expect(c.botProcess.env.BOT_STATE_DIR).toBe(c.botProcess.hostStateDir)
    // The one funding wallet: the single bot host is its only user.
    expect(c.botProcess.env.E2E_DEMO_MAIN_WALLET_JSON).toBe('/work/wallet.json')
    for (const [k, v] of Object.entries(c.botProcess.env)) {
      if (/(IDENTITY_JSON|STATE_DIR)$/.test(k)) expect(v.startsWith(join(HOME, '.frank-demo'))).toBe(true)
    }
    // Every bot is told its own identity file, under the variable the bot reads.
    expect(c.botProcess.env.DICE_BOT_IDENTITY_JSON).toBe(c.bots.find(b => b.name === 'dice')!.identityJson)
    expect(c.botProcess.env.FAUCET_BOT_IDENTITY_JSON).toBe(join(HOME, '.frank-demo', 'bots', 'faucet', 'identity.json'))
  })

  it('needs an RPC URL and a wallet file, one clear line each', () => {
    const p = problemsOf(() => resolveDemoConfig({ env: {}, envFile: {}, home: HOME, cwd: '/work' }))
    expect(p).toHaveLength(2)
    expect(p[0]).toMatch(/^MONAD_TESTNET_HTTP_RPC_URL is required/)
    expect(p[1]).toMatch(/^E2E_DEMO_MAIN_WALLET_JSON is required/)
  })

  it('rejects a non-http RPC URL and a non-testnet tag', () => {
    expect(problemsOf(() => REAL({ MONAD_TESTNET_HTTP_RPC_URL: 'ws://x' }))).toEqual([
      'MONAD_TESTNET_HTTP_RPC_URL must be an http(s) URL',
    ])
    expect(problemsOf(() => REAL({ MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc1.example.invalid,ws://bad' }))).toEqual([
      'MONAD_TESTNET_HTTP_RPC_URL must be an http(s) URL',
    ])
    const multiRpc = REAL({
      MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc1.example.invalid, https://rpc2.example.invalid',
    })
    expect(multiRpc.rpcUrl).toBe('https://rpc1.example.invalid, https://rpc2.example.invalid')
    expect(multiRpc.secrets).toContain('https://rpc1.example.invalid')
    expect(multiRpc.secrets).toContain('https://rpc2.example.invalid')
    expect(problemsOf(() => REAL({ FRANK_NETWORK_TAG: 'MON1' }))[0]).toMatch(/must be MONT/)
    expect(problemsOf(() => REAL({ MONAD_TESTNET_WS_RPC_URL: 'https://x' }))).toEqual([
      'MONAD_TESTNET_WS_RPC_URL must be a ws(s) URL',
    ])
  })

  it('takes values from the env file, and the process environment wins', () => {
    const c = REAL({ FRANK_DEMO_RELAY_PORT: '9001' }, { FRANK_DEMO_RELAY_PORT: '9002', RAFFLE_BOT_MAX_ENTRIES: '4' })
    expect(c.relayPort).toBe(9001)
    expect(c.botProcess.env.RAFFLE_BOT_MAX_ENTRIES).toBe('4')
  })

  it('ignores every variable that is not documented: nothing else reaches a bot', () => {
    const c = REAL(
      { AWS_SECRET_ACCESS_KEY: 'do-not-forward', HOME_SECRET: 'x' },
      { GITHUB_TOKEN: 'do-not-forward-either' },
    )
    const all = JSON.stringify(c.botProcess.env)
    expect(all).not.toContain('do-not-forward')
    expect(all).not.toContain('HOME_SECRET')
  })

  it('a small raffle for the demo', () => {
    const env = REAL().botProcess.env
    expect(env.RAFFLE_BOT_MAX_ENTRIES).toBe('5')
  })

  it('passes the exact PROTOC override only to the relay toolchain, with environment precedence', () => {
    const c = REAL({ PROTOC: '/tools with spaces/protoc', UNLISTED_TOOL: 'hidden' }, { PROTOC: '/file/protoc' })
    expect(c.toolchainEnv).toEqual({ PROTOC: '/tools with spaces/protoc' })
    expect(REAL({}, { PROTOC: '/file/protoc' }).toolchainEnv.PROTOC).toBe('/file/protoc')
    expect(REAL({ PROTOC: '' }).toolchainEnv.PROTOC).toBe('')
    expect(c.botProcess.env).not.toHaveProperty('PROTOC')
  })

  describe('Qwen mode', () => {
    it('is the live model unless the stub is asked for by name; settings are passed through', () => {
      const c = REAL({
        QWEN_API_KEY: 'dummy-qwen-key',
        QWEN_OPENAI_COMPATIBLE_ENDPOINT: 'https://q.example.invalid/v1',
        QWEN_MODEL_TIMEOUT_MS: '9000',
        QWEN_MODEL_TRIES: '2',
        QWEN_ENABLE_THINKING: '1',
        QWEN_SYSTEM_PROMPT: 'be brief',
      })
      expect(c.qwenMode).toBe('live')
      expect(c.botProcess.env).toMatchObject({
        QWEN_API_KEY: 'dummy-qwen-key',
        QWEN_OPENAI_COMPATIBLE_ENDPOINT: 'https://q.example.invalid/v1',
        QWEN_MODEL_TIMEOUT_MS: '9000',
        QWEN_MODEL_TRIES: '2',
        QWEN_ENABLE_THINKING: '1',
        QWEN_SYSTEM_PROMPT: 'be brief',
      })
      expect(c.botProcess.env).not.toHaveProperty('QWEN_BOT_MODE')
      expect(c.secrets).toContain('dummy-qwen-key')
    })

    it('without a key the launcher still starts and never falls back to a stub: the Qwen bot reports its own failure', () => {
      const c = REAL()
      expect(c.qwenMode).toBe('live')
      expect(c.botProcess.env).not.toHaveProperty('QWEN_BOT_MODE')
      expect(c.botProcess.env).not.toHaveProperty('QWEN_API_KEY')
    })

    it('an explicit stub is passed on, and carries no key', () => {
      const c = REAL({ QWEN_API_KEY: 'k', QWEN_BOT_MODE: 'stub' })
      expect(c.qwenMode).toBe('stub')
      expect(c.botProcess.env.QWEN_BOT_MODE).toBe('stub')
      expect(c.botProcess.env).not.toHaveProperty('QWEN_API_KEY')
      expect(problemsOf(() => REAL({ QWEN_BOT_MODE: 'offline' }))[0]).toMatch(/must be "stub" or "live"/)
    })
  })

  it('leaves the bot host its own refill amounts unless the operator sets them', () => {
    expect(REAL().botProcess.env).not.toHaveProperty('FRANK_BOT_TOP_UP_TO_WEI')
    expect(REAL().funding).toEqual({ topUpBelowWei: 3n * 10n ** 17n, topUpToWei: 5n * 10n ** 17n, reserveWei: 10n ** 17n })
    const set = REAL({ FRANK_BOT_TOP_UP_TO_WEI: '7', FRANK_BOT_TOP_UP_BELOW_WEI: '3', FAUCET_MIN_RESERVE_WEI: '9' })
    expect(set.botProcess.env).toMatchObject({ FRANK_BOT_TOP_UP_TO_WEI: '7', FRANK_BOT_TOP_UP_BELOW_WEI: '3' })
    expect(set.funding).toEqual({ topUpBelowWei: 3n, topUpToWei: 7n, reserveWei: 9n })
  })

  it('one start may draw at most 1 MON unless the operator raises the limit or passes --allow-draw', () => {
    expect(REAL().maxStartDrawWei).toBe(10n ** 18n)
    expect(REAL({ FRANK_DEMO_MAX_START_DRAW_WEI: '5' }).maxStartDrawWei).toBe(5n)
    expect(
      resolveDemoConfig({ env: REAL_ENV, envFile: {}, allowDrawFlag: true, home: HOME, cwd: '/work' }).maxStartDrawWei,
    ).toBeUndefined()
    expect(problemsOf(() => REAL({ FRANK_DEMO_MAX_START_DRAW_WEI: 'lots' }))[0]).toMatch(/positive integer/)
  })

  it('validates ports, wei amounts and the raffle size', () => {
    expect(problemsOf(() => REAL({ FRANK_DEMO_RELAY_PORT: '70000' }))[0]).toMatch(/port number/)
    expect(problemsOf(() => REAL({ CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1.5' }))[0]).toMatch(/positive integer/)
    expect(problemsOf(() => REAL({ RAFFLE_BOT_MAX_ENTRIES: '1' }))[0]).toMatch(/>= 2/)
  })

  it('reports every problem at once', () => {
    const p = problemsOf(() =>
      REAL({
        FRANK_DEMO_RELAY_PORT: 'x',
        RAFFLE_BOT_MAX_ENTRIES: '0',
        QWEN_BOT_MODE: 'neither',
      }),
    )
    expect(p.length).toBeGreaterThanOrEqual(3)
  })

  it('never lists the real RPC URL as printable', () => {
    expect(REAL().secrets).toContain(REAL_ENV.MONAD_TESTNET_HTTP_RPC_URL)
    expect(REAL().secrets).toContain(REAL_ENV.MONAD_TESTNET_WS_RPC_URL)
  })

  it('FRANK_DEMO_NO_FAUCET=1 runs without the faucet bot', () => {
    const c = REAL({ FRANK_DEMO_NO_FAUCET: '1' })
    expect(c.bots.map(b => b.name)).not.toContain('faucet')
    expect(c.botProcess.env.FRANK_BOTS.split(',')).not.toContain('faucet')
    expect(c.botProcess.env).not.toHaveProperty('FAUCET_AMOUNT_WEI')
    expect(c.faucetAmountWei).toBeUndefined()
  })
})

describe('burn address (#364)', () => {
  const dEaD = '0x000000000000000000000000000000000000dEaD'

  it('defaults to the well-known burn address and reaches the bots (the relay gets it in demo.ts)', () => {
    const c = REAL()
    expect(DEMO_DEFAULT_BURN_ADDRESS).toBe(dEaD)
    expect(c.stampBurnAddress).toBe(dEaD)
    expect(c.botProcess.env.MONAD_STAMP_BURN_ADDRESS).toBe(dEaD)
  })

  it('can be overridden, and only by a valid 20-byte address', () => {
    const other = '0x1111111111111111111111111111111111111111'
    const c = REAL({ MONAD_STAMP_BURN_ADDRESS: other })
    expect(c.stampBurnAddress).toBe(other)
    expect(c.botProcess.env.MONAD_STAMP_BURN_ADDRESS).toBe(other)
    for (const bad of ['0xdead', 'dEaD', '0x' + 'g'.repeat(40)]) {
      expect(problemsOf(() => REAL({ MONAD_STAMP_BURN_ADDRESS: bad }))[0]).toMatch(
        /MONAD_STAMP_BURN_ADDRESS must be 0x/,
      )
    }
  })
})

describe('faucet amount (#362)', () => {
  it('is small by default (the faucet spends real testnet funds), and an explicit value wins', () => {
    expect(REAL().botProcess.env.FAUCET_AMOUNT_WEI).toBe(DEMO_FAUCET_AMOUNT_WEI)
    expect(DEMO_FAUCET_AMOUNT_WEI).toBe('50000000000000000')
    expect(REAL({ FAUCET_AMOUNT_WEI: '123' }).botProcess.env.FAUCET_AMOUNT_WEI).toBe('123')
  })

  it('never exceeds the faucet hard ceiling', () => {
    expect(problemsOf(() => REAL({ FAUCET_AMOUNT_WEI: (MAX_AMOUNT_WEI + 1n).toString() }))[0]).toMatch(/hard ceiling/)
    expect(REAL({ FAUCET_AMOUNT_WEI: MAX_AMOUNT_WEI.toString() }).faucetAmountWei).toBe(MAX_AMOUNT_WEI.toString())
  })
})

describe('README variable table', () => {
  it('is exactly the table generated from DEMO_VARS (every variable documented once)', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8')
    expect(readme).toContain(renderDemoVarTable())
    const names = DEMO_VARS.map(v => v.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('child environment', () => {
  it('passes only the short allowlist plus what is named explicitly', () => {
    const env = childEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        AWS_SECRET_ACCESS_KEY: 'x',
        QWEN_API_KEY: 'y',
      },
      { FRANK_NETWORK_TAG: 'MONT' },
    )
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      FRANK_NETWORK_TAG: 'MONT',
    })
  })
})

describe('raffle defaults stay consistent between the launcher and the bot (#363)', () => {
  const documented = (name: string) => DEMO_VARS.find(v => v.name === name)?.default
  it("documents the bot's own entry price, and passes no price override by default", () => {
    expect(documented('RAFFLE_BOT_ENTRY_PRICE_WEI')).toBe(RAFFLE_DEFAULT_ENTRY_PRICE_WEI.toString())
    expect(REAL().botProcess.env.RAFFLE_BOT_ENTRY_PRICE_WEI).toBeUndefined()
  })
  it('the launcher passes the documented round size', () => {
    expect(REAL().botProcess.env.RAFFLE_BOT_MAX_ENTRIES).toBe(documented('RAFFLE_BOT_MAX_ENTRIES'))
    expect(RAFFLE_DEFAULT_MAX_ENTRIES).toBe(5)
  })
})

describe('ngrok configuration', () => {
  it('defaults ngrok to disabled with standard ngrok binary and undefined public URLs', () => {
    const config = REAL()
    expect(config.ngrok).toBe(false)
    expect(config.ngrokBin).toBe('ngrok')
    expect(config.publicRelayUrl).toBeUndefined()
    expect(config.publicAppUrl).toBeUndefined()
  })

  it('enables ngrok via FRANK_DEMO_NGROK=1, true, or ngrokFlag', () => {
    expect(REAL({ FRANK_DEMO_NGROK: '1' }).ngrok).toBe(true)
    expect(REAL({ FRANK_DEMO_NGROK: 'true' }).ngrok).toBe(true)
    expect(
      resolveDemoConfig({
        env: REAL_ENV,
        envFile: {},
        ngrokFlag: true,
      }).ngrok,
    ).toBe(true)
  })

  it('rejects malformed public URLs', () => {
    expect(() => REAL({ FRANK_DEMO_PUBLIC_RELAY_URL: 'not-a-url' })).toThrow(
      'FRANK_DEMO_PUBLIC_RELAY_URL must be an http(s) URL',
    )
    expect(() => REAL({ FRANK_DEMO_PUBLIC_APP_URL: 'not-a-url' })).toThrow(
      'FRANK_DEMO_PUBLIC_APP_URL must be an http(s) URL',
    )
  })

  it('accepts valid public URLs and marks NGROK_AUTHTOKEN as secret', () => {
    const config = REAL({
      FRANK_DEMO_PUBLIC_RELAY_URL: 'https://relay.ngrok-free.app',
      FRANK_DEMO_PUBLIC_APP_URL: 'https://app.ngrok-free.app',
      NGROK_AUTHTOKEN: 'secret-token-xyz',
    })
    expect(config.publicRelayUrl).toBe('https://relay.ngrok-free.app')
    expect(config.publicAppUrl).toBe('https://app.ngrok-free.app')
    expect(config.secrets).toContain('secret-token-xyz')
  })
})

describe('bitcoin and solana relay proxies', () => {
  it('defaults to public testnet and devnet endpoints', () => {
    const config = REAL()
    expect(config.chronikUrl).toBe('https://chronik-testnet.fabien.cash')
    expect(config.solanaRpcUrl).toBe('https://api.devnet.solana.com')
  })

  it('accepts custom endpoints and redacts them if configured', () => {
    const config = REAL({
      XEC_TESTNET_CHRONIK_URL: 'https://custom-chronik.example.invalid',
      SOLANA_DEVNET_HTTP_RPC_URL: 'https://custom-solana.example.invalid/v2/key',
    })
    expect(config.chronikUrl).toBe('https://custom-chronik.example.invalid')
    expect(config.solanaRpcUrl).toBe('https://custom-solana.example.invalid/v2/key')
    expect(config.secrets).toContain('https://custom-chronik.example.invalid')
    expect(config.secrets).toContain('https://custom-solana.example.invalid/v2/key')
  })

  it('rejects malformed chronik and solana URLs', () => {
    expect(problemsOf(() => REAL({ XEC_TESTNET_CHRONIK_URL: 'ftp://not-http' }))).toEqual([
      'XEC_TESTNET_CHRONIK_URL must be an http(s) URL, got "ftp://not-http"',
    ])
    expect(problemsOf(() => REAL({ SOLANA_DEVNET_HTTP_RPC_URL: 'not-a-url' }))).toEqual([
      'SOLANA_DEVNET_HTTP_RPC_URL must be an http(s) URL, got "not-a-url"',
    ])
  })
})



describe('wallet file paths', () => {
  const base = {
    MONAD_TESTNET_HTTP_RPC_URL: REAL_ENV.MONAD_TESTNET_HTTP_RPC_URL,
    MONAD_TESTNET_WS_RPC_URL: REAL_ENV.MONAD_TESTNET_WS_RPC_URL,
  }
  it('a relative path written in the env file is relative to that file, wherever the launcher runs', () => {
    const config = resolveDemoConfig({
      env: base,
      envFile: { E2E_DEMO_MAIN_WALLET_JSON: '.wallets/main.json', FRANK_TEST_WALLET_JSON: '.wallets/test.json' },
      envFileDir: '/repo',
      home: '/home/dummy',
      cwd: '/repo/.worktrees/x/packages/bot',
    })
    expect(config.mainWalletJson).toBe('/repo/.wallets/main.json')
    expect(config.testWalletJson).toBe('/repo/.wallets/test.json')
  })
  it('a relative path given in the environment is relative to where the command was typed', () => {
    const config = resolveDemoConfig({
      env: { ...base, E2E_DEMO_MAIN_WALLET_JSON: 'w/main.json' },
      envFile: { E2E_DEMO_MAIN_WALLET_JSON: '.wallets/main.json' },
      envFileDir: '/repo',
      home: '/home/dummy',
      cwd: '/work',
    })
    expect(config.mainWalletJson).toBe('/work/w/main.json')
  })
})
