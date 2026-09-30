/**
 * Configuration for the one-command demo (#312), from environment variables and an optional
 * user-provided `.env` file ONLY. `DEMO_VARS` is the single list of every variable the launcher
 * reads or sets; the README table is generated from it and a test keeps the two in sync.
 *
 * Only these names are ever taken from the `.env` file or passed on to child processes; every
 * other variable in the file or the environment is ignored, so a `.env` full of unrelated
 * secrets never reaches a bot.
 */
import { homedir } from 'os'
import { join, resolve } from 'path'

export interface DemoVar {
  name: string
  /** Where it applies: launcher, relay, chain, wallet, or a bot. */
  scope: string
  /** Default when unset ("required" means the demo will not start without it). */
  default: string
  description: string
  /** A secret: never printed. */
  secret?: boolean
}

export const DEMO_VARS: readonly DemoVar[] = [
  {
    name: 'FRANK_DEMO_ENV_FILE',
    scope: 'launcher',
    default: '<repo>/.env if it exists',
    description:
      'Path of the .env file to read (KEY=value lines). The process environment wins over the file. Never committed; you provide it.',
  },
  {
    name: 'FRANK_DEMO_STATE_DIR',
    scope: 'launcher',
    default: '~/.frank-demo',
    description:
      'One directory holding every bot identity, bot state, the relay database, the fake-chain wallet and the logs. Reused across runs.',
  },
  {
    name: 'FRANK_DEMO_FAKE_CHAIN',
    scope: 'launcher',
    default: '0',
    description:
      'Set to 1 (same as the --fake-chain flag) to run against a built-in fake Monad JSON-RPC: no keys, no funds, no network.',
  },
  {
    name: 'FRANK_DEMO_RELAY_PORT',
    scope: 'relay',
    default: '8098',
    description: 'Port the local relay listens on (127.0.0.1).',
  },
  {
    name: 'FRANK_DEMO_FAKE_RPC_PORT',
    scope: 'chain',
    default: '8545',
    description: 'Port of the fake-chain RPC (only with FRANK_DEMO_FAKE_CHAIN=1).',
  },
  {
    name: 'CASHWEBD_BIN',
    scope: 'relay',
    default: 'built with Cargo',
    description: 'Path of a prebuilt cashwebd-exe; skips the Cargo build in run-local-monad.sh.',
  },
  {
    name: 'CARGO',
    scope: 'relay build',
    default: 'cargo',
    description:
      'Toolchain variables (also CARGO_HOME, CARGO_TARGET_DIR, RUSTUP_HOME, RUSTUP_TOOLCHAIN) are passed to the relay build only when set. Ignored with CASHWEBD_BIN.',
  },
  { name: 'CARGO_HOME', scope: 'relay build', default: 'unset', description: 'See CARGO.' },
  {
    name: 'CARGO_TARGET_DIR',
    scope: 'relay build',
    default: 'unset',
    description:
      'See CARGO. Point it at a scratch directory to keep the build out of the repo tree.',
  },
  { name: 'RUSTUP_HOME', scope: 'relay build', default: 'unset', description: 'See CARGO.' },
  { name: 'RUSTUP_TOOLCHAIN', scope: 'relay build', default: 'unset', description: 'See CARGO.' },
  {
    name: 'MONAD_TESTNET_HTTP_RPC_URL',
    scope: 'chain',
    default: 'required unless fake chain',
    description: 'Monad TESTNET JSON-RPC URL (chain id 10143). May embed an API key.',
    secret: true,
  },
  {
    name: 'FRANK_NETWORK_TAG',
    scope: 'chain',
    default: 'MONT',
    description: 'Network tag the relay and bots stamp messages with (MONT = Monad testnet).',
  },
  {
    name: 'CASHWEB_STAMP_MIN_BURN_VALUE_WEI',
    scope: 'relay',
    default: '1000000000000',
    description: 'Minimum wei a message stamp must pay (0.000001 MON).',
  },
  {
    name: 'FRANK_DM_DEFAULT_STAMP_VALUE_WEI',
    scope: 'bots',
    default: '10000000000000000',
    description: 'Default stamp value bots pay per message (0.01 MON).',
  },
  {
    name: 'E2E_DEMO_MAIN_WALLET_JSON',
    scope: 'wallet',
    default: 'required unless fake chain',
    description:
      'Not allowed with --fake-chain (a throwaway wallet is generated). Path of a JSON file {"address","privateKey"} of a funded TESTNET wallet that pays for bot stamps and payouts. Read by the bots, never by the launcher. chmod 600.',
    secret: true,
  },
  {
    name: 'FRANK_DEMO_FAUCET_WALLET_JSON',
    scope: 'wallet',
    default: 'required on a real network unless FRANK_DEMO_NO_FAUCET=1',
    description:
      'Path of a SEPARATE funded testnet wallet file for the faucet (it must differ from E2E_DEMO_MAIN_WALLET_JSON: two processes sending from one wallet reuse nonces, and the faucet should not hold the stamp wallet). Not allowed with --fake-chain.',
    secret: true,
  },
  {
    name: 'FRANK_DEMO_NO_FAUCET',
    scope: 'faucet',
    default: '0',
    description: 'Set to 1 to run without the faucet on a real network.',
  },
  {
    name: 'QWEN_API_KEY',
    scope: 'qwen',
    default: 'unset = stub mode',
    description:
      'Set to run the Qwen bot against a real model (needs QWEN_OPENAI_COMPATIBLE_ENDPOINT). Unset: the bot runs in offline STUB mode and its replies say so.',
    secret: true,
  },
  {
    name: 'QWEN_OPENAI_COMPATIBLE_ENDPOINT',
    scope: 'qwen',
    default: 'required with QWEN_API_KEY',
    description: 'OpenAI-compatible base URL of the model provider.',
  },
  {
    name: 'QWEN_MODEL',
    scope: 'qwen',
    default: 'qwen3.8-max',
    description: 'Model name for live mode.',
  },
  {
    name: 'QWEN_BOT_MODE',
    scope: 'qwen',
    default: 'live if QWEN_API_KEY, else stub',
    description: 'Force "stub" or "live". "live" without a key is an error, never a silent stub.',
  },
  {
    name: 'RAFFLE_BOT_ENTRY_PRICE_WEI',
    scope: 'raffle',
    default: '20000000000000000',
    description: 'Raffle entry price (0.02 MON).',
  },
  {
    name: 'RAFFLE_BOT_MAX_TOPUP_WEI',
    scope: 'raffle',
    default: '50000000000000000',
    description:
      'Largest operator (stamp wallet) top-up the raffle accepts at draw time to cover swept-entry gas and payout gas; a bigger shortfall holds the draw and logs it (0.05 MON).',
  },
  {
    name: 'RAFFLE_BOT_MAX_ENTRIES',
    scope: 'raffle',
    default: '3',
    description: 'Entrants per round; demo default is small so a round fills quickly.',
  },
  {
    name: 'BLACKJACK_BOT_MIN_WAGER_WEI',
    scope: 'blackjack',
    default: 'bot default (0.01 MON)',
    description: 'Table minimum.',
  },
  {
    name: 'BLACKJACK_BOT_MAX_WAGER_WEI',
    scope: 'blackjack',
    default: 'bot default (1 MON)',
    description: 'Table maximum.',
  },
  {
    name: 'VENDOR_BOT_CATALOG_DIR',
    scope: 'picture shop',
    default: 'bundled demo-catalog/',
    description: 'Directory with manifest.json and image files the shop sells.',
  },
  {
    name: 'FAUCET_AMOUNT_WEI',
    scope: 'faucet',
    default: '50000000000000000',
    description: 'Testnet MON sent to each new profile (0.05 MON).',
  },
  {
    name: 'FAUCET_MAX_PER_DAY',
    scope: 'faucet',
    default: '20',
    description: 'New addresses funded per rolling 24 hours.',
  },
  {
    name: 'FAUCET_MIN_RESERVE_WEI',
    scope: 'faucet',
    default: '100000000000000000',
    description: 'The faucet wallet keeps at least this balance.',
  },
  {
    name: 'FRANK_BOT_PEER_DENYLIST',
    scope: 'bots',
    default: 'empty',
    description: 'Comma-separated addresses no bot engages.',
  },
  {
    name: 'FRANK_BOT_MAX_REPLIES_PER_PEER',
    scope: 'bots',
    default: '20',
    description: 'Per-peer reply budget per window.',
  },
]

export const DEMO_VAR_NAMES: ReadonlySet<string> = new Set(DEMO_VARS.map(v => v.name))

/** Variables the launcher passes on to child processes only when set (a subset of DEMO_VARS). */
const PASSTHROUGH = [
  'FRANK_DM_DEFAULT_STAMP_VALUE_WEI',
  'RAFFLE_BOT_ENTRY_PRICE_WEI',
  'RAFFLE_BOT_MAX_TOPUP_WEI',
  'BLACKJACK_BOT_MIN_WAGER_WEI',
  'BLACKJACK_BOT_MAX_WAGER_WEI',
  'VENDOR_BOT_CATALOG_DIR',
  'FAUCET_AMOUNT_WEI',
  'FAUCET_MAX_PER_DAY',
  'FAUCET_MIN_RESERVE_WEI',
  'FRANK_BOT_PEER_DENYLIST',
  'FRANK_BOT_MAX_REPLIES_PER_PEER',
] as const

export const TOOLCHAIN_VARS = [
  'CARGO',
  'CARGO_HOME',
  'CARGO_TARGET_DIR',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
] as const

/** A duration far longer than any demo, in place of the bots' 10-minute idle exit. */
export const NEVER_IDLE_MS = String(30 * 24 * 60 * 60 * 1000)

const INBOX_POLLING = /Polling .*\/message\/monad\/inbox/

export type BotName = 'blackjack' | 'raffle' | 'vendor' | 'qwen' | 'faucet'

export interface DemoBot {
  name: BotName
  /** Bot entry file, relative to packages/bot. */
  script: string
  env: Record<string, string>
  /** Identity file (absent for the faucet, which has none). */
  identityJson?: string
  /** Stdout pattern printed once the bot is running its loop. A profile that already exists on the
   * relay from an earlier run does not mean the bot has started, so this is always required. */
  readyLine: RegExp
}

export interface DemoConfig {
  fakeChain: boolean
  stateDir: string
  relayPort: number
  relayUrl: string
  fakeRpcPort: number
  rpcUrl: string
  networkTag: string
  minStampWei: string
  mainWalletJson: string
  cashwebdBin?: string
  /** Toolchain variables for the relay build (only those that are set). */
  toolchainEnv: Record<string, string>
  qwenMode: 'stub' | 'live'
  /** Secret-bearing values that must never be printed. */
  secrets: string[]
  bots: DemoBot[]
}

export class DemoConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'))
  }
}

function port(name: string, raw: string | undefined, dflt: number, problems: string[]): number {
  if (raw === undefined || raw === '') return dflt
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || n < 1 || n > 65535) {
    problems.push(`${name} must be a port number (1-65535), got "${raw}"`)
    return dflt
  }
  return n
}

function wei(name: string, raw: string | undefined, dflt: string, problems: string[]): string {
  if (raw === undefined || raw === '') return dflt
  if (!/^[1-9][0-9]*$/.test(raw)) {
    problems.push(`${name} must be a positive integer number of wei, got "${raw}"`)
    return dflt
  }
  return raw
}

/**
 * Merges the process environment over the `.env` file (only names in DEMO_VARS), validates, and
 * lays out every bot's environment inside `stateDir`. Never reads a file itself: the caller passes
 * the parsed env file, so this is a pure function and tests use dummy values.
 */
export function resolveDemoConfig(params: {
  env: Record<string, string | undefined>
  envFile: Record<string, string>
  fakeChainFlag: boolean
  /** Used to place the default state dir and resolve relative paths. */
  home?: string
  cwd?: string
}): DemoConfig {
  const home = params.home ?? homedir()
  const cwd = params.cwd ?? process.cwd()
  const merged: Record<string, string | undefined> = {}
  for (const name of DEMO_VAR_NAMES) {
    merged[name] = params.env[name] ?? params.envFile[name]
  }
  const problems: string[] = []
  const noFaucet = merged.FRANK_DEMO_NO_FAUCET === '1'
  const fakeChain = params.fakeChainFlag || merged.FRANK_DEMO_FAKE_CHAIN === '1'
  const stateDir = resolve(cwd, merged.FRANK_DEMO_STATE_DIR || join(home, '.frank-demo'))
  const relayPort = port('FRANK_DEMO_RELAY_PORT', merged.FRANK_DEMO_RELAY_PORT, 8098, problems)
  const fakeRpcPort = port(
    'FRANK_DEMO_FAKE_RPC_PORT',
    merged.FRANK_DEMO_FAKE_RPC_PORT,
    8545,
    problems,
  )
  const networkTag = merged.FRANK_NETWORK_TAG || 'MONT'
  if (networkTag !== 'MONT') {
    problems.push(
      `FRANK_NETWORK_TAG must be MONT: the demo runs on Monad testnet only (got "${networkTag}")`,
    )
  }
  const minStampWei = wei(
    'CASHWEB_STAMP_MIN_BURN_VALUE_WEI',
    merged.CASHWEB_STAMP_MIN_BURN_VALUE_WEI,
    '1000000000000',
    problems,
  )

  let rpcUrl = merged.MONAD_TESTNET_HTTP_RPC_URL ?? ''
  let mainWalletJson = merged.E2E_DEMO_MAIN_WALLET_JSON
    ? resolve(cwd, merged.E2E_DEMO_MAIN_WALLET_JSON)
    : ''
  if (fakeChain) {
    // The fake chain generates its own throwaway wallets; a real wallet file must never be used
    // (or even read) alongside it.
    for (const name of ['E2E_DEMO_MAIN_WALLET_JSON', 'FRANK_DEMO_FAUCET_WALLET_JSON']) {
      if (merged[name]) {
        problems.push(
          `${name} is set, but --fake-chain generates its own throwaway wallets and never uses a real one: unset it, or drop --fake-chain`,
        )
      }
    }
    rpcUrl = `http://127.0.0.1:${fakeRpcPort}`
    // The fake chain has no real funds: a wallet is generated under the state dir if none is given.
    mainWalletJson = join(stateDir, 'fake-chain-wallet.json')
  } else {
    if (!rpcUrl) {
      problems.push(
        'MONAD_TESTNET_HTTP_RPC_URL is required (set it in the environment or your .env file), or run with --fake-chain',
      )
    } else if (!/^https?:\/\//.test(rpcUrl)) {
      problems.push('MONAD_TESTNET_HTTP_RPC_URL must be an http(s) URL')
    }
    if (!mainWalletJson) {
      problems.push(
        'E2E_DEMO_MAIN_WALLET_JSON is required (path of a funded testnet wallet file {"address","privateKey"}), or run with --fake-chain',
      )
    }
  }

  const qwenKey = merged.QWEN_API_KEY
  const requestedMode = merged.QWEN_BOT_MODE
  if (requestedMode && requestedMode !== 'stub' && requestedMode !== 'live') {
    problems.push(`QWEN_BOT_MODE must be "stub" or "live", got "${requestedMode}"`)
  }
  const qwenMode: 'stub' | 'live' =
    requestedMode === 'stub' || requestedMode === 'live' ? requestedMode : qwenKey ? 'live' : 'stub'
  if (qwenMode === 'live') {
    if (!qwenKey) problems.push('QWEN_BOT_MODE=live needs QWEN_API_KEY (or use QWEN_BOT_MODE=stub)')
    if (!merged.QWEN_OPENAI_COMPATIBLE_ENDPOINT) {
      problems.push('QWEN_API_KEY is set, so QWEN_OPENAI_COMPATIBLE_ENDPOINT is required')
    }
  }

  const raffleMax = merged.RAFFLE_BOT_MAX_ENTRIES ?? '3'
  if (!/^\d+$/.test(raffleMax) || Number(raffleMax) < 2) {
    problems.push(`RAFFLE_BOT_MAX_ENTRIES must be an integer >= 2, got "${raffleMax}"`)
  }

  if (!fakeChain && !noFaucet) {
    // Least privilege: the faucet never shares the stamp wallet.
    const faucetPath = merged.FRANK_DEMO_FAUCET_WALLET_JSON
      ? resolve(cwd, merged.FRANK_DEMO_FAUCET_WALLET_JSON)
      : ''
    if (!faucetPath) {
      problems.push(
        'FRANK_DEMO_FAUCET_WALLET_JSON is required on a real network (a separate funded testnet wallet for the faucet), or set FRANK_DEMO_NO_FAUCET=1 to run without the faucet',
      )
    } else if (faucetPath === mainWalletJson) {
      problems.push(
        'FRANK_DEMO_FAUCET_WALLET_JSON must be a different file from E2E_DEMO_MAIN_WALLET_JSON',
      )
    }
  }

  if (problems.length > 0) throw new DemoConfigError(problems)

  const relayUrl = `http://127.0.0.1:${relayPort}`
  const faucetWallet = fakeChain
    ? join(stateDir, 'fake-chain-faucet-wallet.json')
    : merged.FRANK_DEMO_FAUCET_WALLET_JSON
    ? resolve(cwd, merged.FRANK_DEMO_FAUCET_WALLET_JSON)
    : ''

  const common: Record<string, string> = {
    E2E_DEMO_RELAY_URL: relayUrl,
    MONAD_TESTNET_HTTP_RPC_URL: rpcUrl,
    FRANK_NETWORK_TAG: networkTag,
    CASHWEB_STAMP_MIN_BURN_VALUE_WEI: minStampWei,
  }
  // The stamp wallet goes ONLY to the bots that pay stamps or payouts from it. Every bot but the
  // faucet does: each sends replies through stamp sub-accounts funded from it
  // (`setUpFundedStampClient`), the dealer and raffle also pay out from it. The faucet gets its
  // own wallet and never this one.
  const stampWallet = { E2E_DEMO_MAIN_WALLET_JSON: mainWalletJson }
  for (const name of PASSTHROUGH) {
    const value = merged[name]
    if (value) common[name] = value
  }

  const idPath = (bot: string) => join(stateDir, 'bots', bot, 'identity.json')
  const stateOf = (bot: string) => join(stateDir, 'bots', bot, 'state')

  const bots: DemoBot[] = [
    {
      name: 'blackjack',
      script: 'blackjack-bot.livecheck.ts',
      identityJson: idPath('blackjack'),
      readyLine: INBOX_POLLING,
      env: {
        ...common,
        ...stampWallet,
        BLACKJACK_BOT_IDENTITY_JSON: idPath('blackjack'),
        BLACKJACK_BOT_STATE_DIR: stateOf('blackjack'),
        BLACKJACK_BOT_IDLE_TIMEOUT_MS: NEVER_IDLE_MS,
      },
    },
    {
      name: 'raffle',
      script: 'raffle-bot.livecheck.ts',
      identityJson: idPath('raffle'),
      readyLine: INBOX_POLLING,
      env: {
        ...common,
        ...stampWallet,
        RAFFLE_BOT_IDENTITY_JSON: idPath('raffle'),
        RAFFLE_BOT_STATE_DIR: stateOf('raffle'),
        RAFFLE_BOT_MAX_ENTRIES: raffleMax,
        RAFFLE_BOT_IDLE_TIMEOUT_MS: NEVER_IDLE_MS,
      },
    },
    {
      name: 'vendor',
      script: 'vendor-bot.livecheck.ts',
      identityJson: idPath('vendor'),
      readyLine: INBOX_POLLING,
      env: {
        ...common,
        ...stampWallet,
        VENDOR_BOT_IDENTITY_JSON: idPath('vendor'),
        VENDOR_BOT_STATE_DIR: stateOf('vendor'),
        VENDOR_BOT_IDLE_TIMEOUT_MS: NEVER_IDLE_MS,
      },
    },
    {
      name: 'qwen',
      script: 'qwen-bot.livecheck.ts',
      identityJson: idPath('qwen'),
      readyLine: INBOX_POLLING,
      env: {
        ...common,
        ...stampWallet,
        QWEN_BOT_MODE: qwenMode,
        ...(qwenMode === 'live'
          ? {
              QWEN_API_KEY: qwenKey as string,
              QWEN_OPENAI_COMPATIBLE_ENDPOINT: merged.QWEN_OPENAI_COMPATIBLE_ENDPOINT as string,
              ...(merged.QWEN_MODEL ? { QWEN_MODEL: merged.QWEN_MODEL } : {}),
            }
          : {}),
        QWEN_BOT_IDENTITY_JSON: idPath('qwen'),
        QWEN_BOT_HANDOFF_JSON: join(stateDir, 'bots', 'qwen', 'handoff.json'),
        QWEN_BOT_STATE_DIR: stateOf('qwen'),
        // The faucet funds new users; the Qwen bot must not fund them a second time.
        QWEN_BOT_FUND_VALUE_WEI: '0',
      },
    },
    ...(noFaucet
      ? []
      : [
          {
            name: 'faucet' as BotName,
            script: 'faucet-bot.livecheck.ts',
            readyLine: /Faucet wallet:/,
            env: {
              ...common,
              E2E_DEMO_MAIN_WALLET_JSON: faucetWallet,
              FAUCET_STATE_DIR: join(stateDir, 'bots', 'faucet', 'state'),
              FAUCET_MAX_PER_RUN: '1000',
            },
          },
        ]),
  ]

  const secrets = [fakeChain ? undefined : rpcUrl, qwenKey].filter((v): v is string => !!v)
  return {
    fakeChain,
    stateDir,
    relayPort,
    relayUrl,
    fakeRpcPort,
    rpcUrl,
    networkTag,
    minStampWei,
    mainWalletJson,
    cashwebdBin: merged.CASHWEBD_BIN || undefined,
    toolchainEnv: Object.fromEntries(
      TOOLCHAIN_VARS.flatMap(name => (merged[name] ? [[name, merged[name] as string]] : [])),
    ),
    qwenMode,
    secrets,
    bots,
  }
}

/** The one README table documenting every variable; a test keeps README.md identical to this. */
export function renderDemoVarTable(): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|')
  const rows = DEMO_VARS.map(
    v =>
      `| \`${v.name}\` | ${v.scope} | ${cell(v.default)} | ${cell(v.description)}${
        v.secret ? ' Secret: never printed.' : ''
      } |`,
  )
  return [
    '| Variable | Applies to | Default | Meaning |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
