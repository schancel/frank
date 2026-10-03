import { readFileSync } from 'fs'
import { join } from 'path'

import {
  BET_MESSAGE_FEE_RESERVE_WEI,
  BLACKJACK_DEFAULT_MIN_WAGER_WEI,
} from '@frank/wallet/message-item-plugins/blackjack/game'

import { MAX_AMOUNT_WEI } from '../faucet-core'
import {
  DEMO_DEFAULT_BURN_ADDRESS,
  DEMO_FAKE_FAUCET_AMOUNT_WEI,
  DEMO_REAL_FAUCET_AMOUNT_WEI,
  DEMO_VARS,
  DemoConfigError,
  NEVER_IDLE_MS,
  renderDemoVarTable,
  resolveDemoConfig,
} from './demo-config'
import { childEnv } from './supervisor'
import {
  RAFFLE_DEFAULT_ENTRY_PRICE_WEI,
  RAFFLE_DEFAULT_MAX_ENTRIES,
  RAFFLE_DEFAULT_MAX_TOPUP_PER_DAY_WEI,
  RAFFLE_DEFAULT_MAX_TOPUP_WEI,
} from '../raffle-settlement'

const HOME = '/home/dummy'
const FAKE = (env: Record<string, string> = {}, envFile: Record<string, string> = {}) =>
  resolveDemoConfig({
    env,
    envFile,
    fakeChainFlag: true,
    home: HOME,
    cwd: '/work',
  })
const REAL_ENV = {
  MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc.example.invalid/v2/dummy-key',
  MONAD_TESTNET_WS_RPC_URL: 'wss://rpc.example.invalid/v2/dummy-key',
  E2E_DEMO_MAIN_WALLET_JSON: 'wallet.json',
  FRANK_DEMO_FAUCET_WALLET_JSON: 'faucet.json',
}
const REAL = (env: Record<string, string> = {}, envFile: Record<string, string> = {}) =>
  resolveDemoConfig({
    env: { ...REAL_ENV, ...env },
    envFile,
    fakeChainFlag: false,
    home: HOME,
    cwd: '/work',
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
  it('fake chain needs no key, RPC or wallet and points everything at the state dir', () => {
    const c = FAKE()
    expect(c.fakeChain).toBe(true)
    expect(c.rpcUrl).toBe('http://127.0.0.1:8545')
    expect(c.wsRpcUrl).toBeUndefined()
    expect(c.stateDir).toBe(join(HOME, '.frank-demo'))
    expect(c.mainWalletJson).toBe(join(HOME, '.frank-demo', 'fake-chain-wallet.json'))
    expect(c.bots.map(b => b.name)).toEqual(['blackjack', 'raffle', 'vendor', 'qwen', 'faucet'])
    for (const bot of c.bots) {
      for (const [k, v] of Object.entries(bot.env)) {
        if (/(IDENTITY_JSON|STATE_DIR|HANDOFF_JSON)$/.test(k)) {
          expect(v.startsWith(join(HOME, '.frank-demo'))).toBe(true)
        }
      }
    }
  })

  it('every bot has a started-line, so a profile left from an earlier run is never mistaken for a running bot', () => {
    for (const bot of FAKE().bots) expect(bot.readyLine).toBeInstanceOf(RegExp)
    expect(
      FAKE()
        .bots.find(b => b.name === 'vendor')!
        .readyLine.test(
          '\nPolling http://x/message/monad/inbox/<me> (signed mailbox read, since=<t>) every 4000ms ...',
        ),
    ).toBe(true)
  })

  it('a real network needs an RPC URL and a wallet file, one clear line each', () => {
    const p = problemsOf(() =>
      resolveDemoConfig({
        env: {},
        envFile: {},
        fakeChainFlag: false,
        home: HOME,
        cwd: '/work',
      }),
    )
    expect(p).toHaveLength(3)
    expect(p[0]).toMatch(/^MONAD_TESTNET_HTTP_RPC_URL is required/)
    expect(p[1]).toMatch(/^E2E_DEMO_MAIN_WALLET_JSON is required/)
    expect(p.join('\n')).toContain('--fake-chain')
  })

  it('rejects a non-http RPC URL and a non-testnet tag', () => {
    expect(problemsOf(() => REAL({ MONAD_TESTNET_HTTP_RPC_URL: 'ws://x' }))).toEqual([
      'MONAD_TESTNET_HTTP_RPC_URL must be an http(s) URL',
    ])
    expect(problemsOf(() => REAL({ FRANK_NETWORK_TAG: 'MON1' }))[0]).toMatch(/must be MONT/)
    expect(problemsOf(() => REAL({ MONAD_TESTNET_WS_RPC_URL: 'https://x' }))).toEqual([
      'MONAD_TESTNET_WS_RPC_URL must be a ws(s) URL',
    ])
    expect(problemsOf(() => FAKE({ MONAD_TESTNET_WS_RPC_URL: 'ws://x' }))[0]).toMatch(
      /fake-chain does not provide a WebSocket RPC/,
    )
  })

  it('takes values from the env file, and the process environment wins', () => {
    const c = REAL({ FRANK_DEMO_RELAY_PORT: '9001' }, { FRANK_DEMO_RELAY_PORT: '9002', RAFFLE_BOT_MAX_ENTRIES: '4' })
    expect(c.relayPort).toBe(9001)
    expect(c.bots.find(b => b.name === 'raffle')?.env.RAFFLE_BOT_MAX_ENTRIES).toBe('4')
  })

  it('ignores every variable that is not documented: nothing else reaches a bot', () => {
    const c = REAL(
      { AWS_SECRET_ACCESS_KEY: 'do-not-forward', HOME_SECRET: 'x' },
      { GITHUB_TOKEN: 'do-not-forward-either' },
    )
    const all = JSON.stringify(c.bots.map(b => b.env))
    expect(all).not.toContain('do-not-forward')
    expect(all).not.toContain('HOME_SECRET')
  })

  it('demo-friendly limits: no idle exit, small raffle, no Qwen reply cap, no double funding', () => {
    const c = FAKE()
    const env = (n: string) => c.bots.find(b => b.name === n)!.env
    expect(env('blackjack').BLACKJACK_BOT_IDLE_TIMEOUT_MS).toBe(NEVER_IDLE_MS)
    expect(env('raffle').RAFFLE_BOT_IDLE_TIMEOUT_MS).toBe(NEVER_IDLE_MS)
    expect(env('vendor').VENDOR_BOT_IDLE_TIMEOUT_MS).toBe(NEVER_IDLE_MS)
    expect(env('raffle').RAFFLE_BOT_MAX_ENTRIES).toBe('5')
    expect(env('qwen')).not.toHaveProperty('QWEN_BOT_MAX_REPLIES')
    expect(env('qwen').QWEN_BOT_FUND_VALUE_WEI).toBe('0')
    expect(env('faucet').FAUCET_MAX_PER_RUN).toBe('1000')
  })

  it('passes the exact PROTOC override only to the relay toolchain, with environment precedence', () => {
    const c = FAKE({ PROTOC: '/tools with spaces/protoc', UNLISTED_TOOL: 'hidden' }, { PROTOC: '/file/protoc' })
    expect(c.toolchainEnv).toEqual({ PROTOC: '/tools with spaces/protoc' })
    expect(FAKE({}, { PROTOC: '/file/protoc' }).toolchainEnv.PROTOC).toBe('/file/protoc')
    expect(FAKE({ PROTOC: '' }).toolchainEnv.PROTOC).toBe('')
    for (const bot of c.bots) expect(bot.env).not.toHaveProperty('PROTOC')
  })

  describe('Qwen mode', () => {
    it('is stub without a key, and never carries a key or endpoint then', () => {
      const c = FAKE()
      expect(c.qwenMode).toBe('stub')
      expect(c.bots.find(b => b.name === 'qwen')!.env).toMatchObject({
        QWEN_BOT_MODE: 'stub',
      })
      expect(c.bots.find(b => b.name === 'qwen')!.env).not.toHaveProperty('QWEN_API_KEY')
    })

    it('is live with a key (and needs the endpoint)', () => {
      const c = FAKE({
        QWEN_API_KEY: 'dummy-qwen-key',
        QWEN_OPENAI_COMPATIBLE_ENDPOINT: 'https://q.example.invalid/v1',
      })
      expect(c.qwenMode).toBe('live')
      expect(c.bots.find(b => b.name === 'qwen')!.env.QWEN_API_KEY).toBe('dummy-qwen-key')
      expect(c.secrets).toContain('dummy-qwen-key')
      expect(problemsOf(() => FAKE({ QWEN_API_KEY: 'k' }))).toEqual([
        'QWEN_API_KEY is set, so QWEN_OPENAI_COMPATIBLE_ENDPOINT is required',
      ])
    })

    it('explicit live without a key is an error, not a silent stub', () => {
      expect(problemsOf(() => FAKE({ QWEN_BOT_MODE: 'live' }))[0]).toMatch(/needs QWEN_API_KEY/)
    })

    it('explicit stub wins even when a key is present', () => {
      const c = FAKE({ QWEN_API_KEY: 'k', QWEN_BOT_MODE: 'stub' })
      expect(c.qwenMode).toBe('stub')
      expect(c.bots.find(b => b.name === 'qwen')!.env).not.toHaveProperty('QWEN_API_KEY')
    })
  })

  it('validates ports, wei amounts and the raffle size', () => {
    expect(problemsOf(() => FAKE({ FRANK_DEMO_RELAY_PORT: '70000' }))[0]).toMatch(/port number/)
    expect(problemsOf(() => FAKE({ CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1.5' }))[0]).toMatch(/positive integer/)
    expect(problemsOf(() => FAKE({ RAFFLE_BOT_MAX_ENTRIES: '1' }))[0]).toMatch(/>= 2/)
  })

  it('reports every problem at once', () => {
    const p = problemsOf(() =>
      REAL({
        FRANK_DEMO_RELAY_PORT: 'x',
        RAFFLE_BOT_MAX_ENTRIES: '0',
        QWEN_BOT_MODE: 'live',
      }),
    )
    expect(p.length).toBeGreaterThanOrEqual(3)
  })

  it('never lists the real RPC URL as printable', () => {
    expect(REAL().secrets).toContain(REAL_ENV.MONAD_TESTNET_HTTP_RPC_URL)
    expect(REAL().secrets).toContain(REAL_ENV.MONAD_TESTNET_WS_RPC_URL)
    expect(FAKE().secrets).toEqual([])
  })

  describe('wallets (least privilege)', () => {
    it('--fake-chain refuses a user-supplied wallet of either kind', () => {
      expect(problemsOf(() => FAKE({ E2E_DEMO_MAIN_WALLET_JSON: 'real.json' }))[0]).toMatch(
        /E2E_DEMO_MAIN_WALLET_JSON is set, but --fake-chain generates its own throwaway wallets/,
      )
      expect(problemsOf(() => FAKE({ FRANK_DEMO_FAUCET_WALLET_JSON: 'real.json' }))[0]).toMatch(
        /FRANK_DEMO_FAUCET_WALLET_JSON is set, but --fake-chain/,
      )
      // also from the env file
      expect(problemsOf(() => FAKE({}, { E2E_DEMO_MAIN_WALLET_JSON: 'real.json' }))).toHaveLength(1)
    })

    it('the fake chain uses generated wallets, separate for the faucet', () => {
      const c = FAKE()
      const faucet = c.bots.find(b => b.name === 'faucet')!.env.E2E_DEMO_MAIN_WALLET_JSON
      expect(c.mainWalletJson).toBe(join(HOME, '.frank-demo', 'fake-chain-wallet.json'))
      expect(faucet).toBe(join(HOME, '.frank-demo', 'fake-chain-faucet-wallet.json'))
    })

    it('a real network requires a SEPARATE faucet wallet, or an explicit opt-out', () => {
      const { FRANK_DEMO_FAUCET_WALLET_JSON: _f, ...noFaucetWallet } = REAL_ENV
      const bare = () =>
        resolveDemoConfig({
          env: noFaucetWallet,
          envFile: {},
          fakeChainFlag: false,
          home: HOME,
          cwd: '/work',
        })
      expect(problemsOf(bare)).toEqual([
        'FRANK_DEMO_FAUCET_WALLET_JSON is required on a real network (a separate funded testnet wallet for the faucet), or set FRANK_DEMO_NO_FAUCET=1 to run without the faucet',
      ])
      expect(problemsOf(() => REAL({ FRANK_DEMO_FAUCET_WALLET_JSON: 'wallet.json' }))[0]).toMatch(
        /must be a different file/,
      )
      const opted = resolveDemoConfig({
        env: { ...noFaucetWallet, FRANK_DEMO_NO_FAUCET: '1' },
        envFile: {},
        fakeChainFlag: false,
        home: HOME,
        cwd: '/work',
      })
      expect(opted.bots.map(b => b.name)).toEqual(['blackjack', 'raffle', 'vendor', 'qwen'])
    })

    it('the stamp wallet goes only to the bots that pay from it; the faucet gets its own and never it', () => {
      const c = REAL()
      const main = '/work/wallet.json'
      const faucet = c.bots.find(b => b.name === 'faucet')!
      expect(faucet.env.E2E_DEMO_MAIN_WALLET_JSON).toBe('/work/faucet.json')
      expect(Object.values(faucet.env)).not.toContain(main)
      for (const name of ['blackjack', 'raffle', 'vendor', 'qwen']) {
        expect(c.bots.find(b => b.name === name)!.env.E2E_DEMO_MAIN_WALLET_JSON).toBe(main)
      }
    })
  })
})

describe('burn address (#364)', () => {
  const dEaD = '0x000000000000000000000000000000000000dEaD'

  it('defaults to the well-known burn address and reaches every bot (the relay gets it in demo.ts)', () => {
    const c = FAKE()
    expect(DEMO_DEFAULT_BURN_ADDRESS).toBe(dEaD)
    expect(c.stampBurnAddress).toBe(dEaD)
    for (const bot of c.bots) expect(bot.env.MONAD_STAMP_BURN_ADDRESS).toBe(dEaD)
  })

  it('can be overridden, and only by a valid 20-byte address', () => {
    const other = '0x1111111111111111111111111111111111111111'
    const c = FAKE({ MONAD_STAMP_BURN_ADDRESS: other })
    expect(c.stampBurnAddress).toBe(other)
    for (const bot of c.bots) expect(bot.env.MONAD_STAMP_BURN_ADDRESS).toBe(other)
    for (const bad of ['0xdead', 'dEaD', '0x' + 'g'.repeat(40)]) {
      expect(problemsOf(() => FAKE({ MONAD_STAMP_BURN_ADDRESS: bad }))[0]).toMatch(
        /MONAD_STAMP_BURN_ADDRESS must be 0x/,
      )
    }
  })
})

describe('faucet amount (#362)', () => {
  const faucetEnv = (c: ReturnType<typeof FAKE>) => c.bots.find(b => b.name === 'faucet')!.env

  it('covers a minimum-bet blackjack hand with margin on the fake chain, within the faucet ceiling', () => {
    const c = FAKE()
    const amount = BigInt(faucetEnv(c).FAUCET_AMOUNT_WEI)
    expect(amount).toBe(BigInt(DEMO_FAKE_FAUCET_AMOUNT_WEI))
    const defaultStamp = BigInt(DEMO_VARS.find(v => v.name === 'FRANK_DM_DEFAULT_STAMP_VALUE_WEI')!.default)
    const cheapestHand = BLACKJACK_DEFAULT_MIN_WAGER_WEI + defaultStamp + BET_MESSAGE_FEE_RESERVE_WEI
    expect(amount).toBeGreaterThanOrEqual(cheapestHand)
    // A raffle entry (0.02) and a shop purchase (0.1) besides, and the ceiling still holds.
    expect(amount).toBeGreaterThanOrEqual(cheapestHand + 2n * 10n ** 16n + 10n ** 17n)
    expect(amount).toBeLessThanOrEqual(MAX_AMOUNT_WEI)
    expect(c.faucetAmountWei).toBe(amount.toString())
  })

  it('keeps the small default on a real network, and an explicit value wins on both', () => {
    expect(faucetEnv(REAL()).FAUCET_AMOUNT_WEI).toBe(DEMO_REAL_FAUCET_AMOUNT_WEI)
    expect(DEMO_REAL_FAUCET_AMOUNT_WEI).toBe('50000000000000000')
    expect(faucetEnv(REAL({ FAUCET_AMOUNT_WEI: '123' })).FAUCET_AMOUNT_WEI).toBe('123')
    expect(faucetEnv(FAKE({ FAUCET_AMOUNT_WEI: '123' })).FAUCET_AMOUNT_WEI).toBe('123')
  })

  it('never exceeds the faucet hard ceiling', () => {
    expect(problemsOf(() => FAKE({ FAUCET_AMOUNT_WEI: (MAX_AMOUNT_WEI + 1n).toString() }))[0]).toMatch(/hard ceiling/)
    expect(FAKE({ FAUCET_AMOUNT_WEI: MAX_AMOUNT_WEI.toString() }).faucetAmountWei).toBe(MAX_AMOUNT_WEI.toString())
  })
})

describe('fake chain state (#361 follow-up)', () => {
  it('keeps the ledger and the faucet records together, so they can only reset together', () => {
    const c = FAKE()
    const dir = join(HOME, '.frank-demo', 'fake-chain')
    expect(c.fakeChainLedger).toBe(join(dir, 'ledger.json'))
    expect(c.bots.find(b => b.name === 'faucet')!.env.FAUCET_STATE_DIR).toBe(join(dir, 'faucet-state'))
  })

  it('a real network has no ledger and keeps the faucet state under bots/', () => {
    const c = REAL()
    expect(c.fakeChainLedger).toBeUndefined()
    expect(c.bots.find(b => b.name === 'faucet')!.env.FAUCET_STATE_DIR).toBe(
      join(HOME, '.frank-demo', 'bots', 'faucet', 'state'),
    )
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
  it("documents the bot's own entry price and top-up limit, and passes no price override by default", () => {
    expect(documented('RAFFLE_BOT_ENTRY_PRICE_WEI')).toBe(RAFFLE_DEFAULT_ENTRY_PRICE_WEI)
    expect(documented('RAFFLE_BOT_MAX_TOPUP_WEI')).toBe(RAFFLE_DEFAULT_MAX_TOPUP_WEI)
    expect(documented('RAFFLE_BOT_MAX_TOPUP_PER_DAY_WEI')).toBe(RAFFLE_DEFAULT_MAX_TOPUP_PER_DAY_WEI)
    const raffle = FAKE().bots.find(b => b.name === 'raffle')!
    expect(raffle.env.RAFFLE_BOT_ENTRY_PRICE_WEI).toBeUndefined()
  })
  it('the launcher passes the documented round size, and RAFFLE_BOT_MAX_TOPUP_WEI through', () => {
    const raffle = FAKE().bots.find(b => b.name === 'raffle')!
    expect(raffle.env.RAFFLE_BOT_MAX_ENTRIES).toBe(documented('RAFFLE_BOT_MAX_ENTRIES'))
    expect(RAFFLE_DEFAULT_MAX_ENTRIES).toBe(5)
    expect(
      FAKE({ RAFFLE_BOT_MAX_TOPUP_WEI: '7' }).bots.find(b => b.name === 'raffle')!.env.RAFFLE_BOT_MAX_TOPUP_WEI,
    ).toBe('7')
  })
})
