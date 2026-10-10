/**
 * A local stack on regtest networks: real chain nodes and the real relay binary pointed at them.
 * Nothing is simulated, nothing costs money, and nothing outside this machine is contacted (apart
 * from the one-time download of the node, see bitcoin-abc.ts).
 *
 *   const stack = await startRegtestStack()
 *   const xec = stack.chains['xec-regtest']
 *   await xec.fund('ecregtest:q...', 1_000_000n)     // from the faucet, confirmed in a block
 *   // wallets read and send through `${stack.relayUrl}/chain-rpc/xec-regtest/chronik`,
 *   // and are given `xec.checkpoint` (the relay was given the same block)
 *   await xec.mine()                                  // a block now; one also comes every 3 s
 *   await stack.stop()                                // stops the relay and the nodes
 *
 * Each run is a new chain: its state is in a new directory under FRANK_REGTEST_STACK_DIR (default
 * the system temporary directory) and is deleted by `stop()` unless FRANK_REGTEST_KEEP=1. Ports are
 * free ones chosen by the system, never 8080, 8098 or 8545.
 *
 * The relay binary is CASHWEBD_BIN, otherwise this worktree's Cargo build (built first if needed).
 *
 * Networks: `xec-regtest` (eCash, Chronik). A Monad regtest (monad-solonet, chain ID 20143) is to
 * be added as another RegtestChain; it also needs the relay's mailbox and EVM proxy rows, which
 * this file does not write yet.
 */
import { execFile } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { Supervisor } from '../supervisor'
import { startEcashRegtest } from './ecash-regtest'
import { freePort, isListening, RegtestChain, sleep } from './regtest-chain'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RELAY_DIR = join(REPO_ROOT, 'backend', 'cashweb')

export interface RegtestStack {
  readonly relayUrl: string
  /** The running networks by canonical chain identifier. */
  readonly chains: Readonly<Record<string, RegtestChain>>
  readonly stateDir: string
  readonly relayLogPath: string
  /** Stops the relay and every node, and checks their ports are closed. Safe to call twice. */
  stop(): Promise<void>
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { cwd: RELAY_DIR, env, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args.join(' ')} failed:\n${stderr.slice(-4000)}`))
      else resolveRun(stdout)
    })
  })
}

/** The relay daemon: CASHWEBD_BIN, or this worktree's build (through the shared Cargo slot). */
async function relayBinary(env: Record<string, string | undefined>): Promise<string> {
  if (env.CASHWEBD_BIN) return resolve(env.CASHWEBD_BIN)
  const childEnv = { ...process.env, ...env } as NodeJS.ProcessEnv
  const protoc = (await run('bash', [join(RELAY_DIR, 'protoc-tool', 'resolve.sh'), REPO_ROOT], childEnv)).trim()
  const out = await run(
    join(REPO_ROOT, '.agents', 'scripts', 'with-cargo-slot'),
    [env.CARGO ?? 'cargo', 'build', '-p', 'cashwebd-exe', '--bin', 'cashwebd-exe', '--message-format=json'],
    { ...childEnv, PROTOC: protoc },
  )
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue
    const record = JSON.parse(line) as { reason?: string; target?: { name?: string }; executable?: string }
    if (record.reason === 'compiler-artifact' && record.target?.name === 'cashwebd-exe' && record.executable) {
      return record.executable
    }
  }
  throw new Error('cargo did not report a cashwebd-exe binary')
}

/** The relay's whole configuration for one run: no Monad mailbox, one proxy row per network. */
function relayConfig(port: number, dbPath: string, chains: RegtestChain[]): string {
  return [
    `host = "127.0.0.1:${port}"`,
    `url = "http://127.0.0.1:${port}"`,
    '',
    '[registry]',
    `db_path = ${JSON.stringify(dbPath)}`,
    'net = "regtest"',
    'peers = []',
    'public_relay_urls = []',
    '',
    '[registry.monad_mailbox]',
    'enabled = false',
    '',
    '[registry.pop]',
    'enabled = false',
    'monad_rpc_url = "http://unused.invalid"',
    'hmac_secret = "unused-because-pop-is-disabled"',
    'payment_recipient = "0x0000000000000000000000000000000000000000"',
    'min_value_wei = "0"',
    '',
    '[registry.bitcoin_proxy]',
    'enabled = true',
    '',
    ...chains.filter(chain => chain.relay.section === 'bitcoin_proxy').map(chain => `${chain.relay.row}\n`),
  ].join('\n')
}

export async function startRegtestStack(
  options: {
    env?: Record<string, string | undefined>
    /** How often each network makes a block without being asked (default 3000 ms). */
    blockIntervalMs?: number
  } = {},
): Promise<RegtestStack> {
  const env = options.env ?? process.env
  // Build (or find) the relay before starting anything that would have to be stopped.
  const cashwebd = await relayBinary(env)
  const base = resolve(env.FRANK_REGTEST_STACK_DIR ?? tmpdir())
  mkdirSync(base, { recursive: true })
  const stateDir = mkdtempSync(join(base, 'frank-regtest-'))
  const relayLogPath = join(stateDir, 'logs', 'relay.log')
  const supervisor = new Supervisor(env, () => {})
  const chains: RegtestChain[] = []
  let relayPort: number | undefined
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      await supervisor.stopAll()
      const failures: unknown[] = []
      for (const chain of chains) await chain.stop().catch(err => failures.push(err))
      if (relayPort !== undefined && (await isListening(relayPort))) {
        failures.push(new Error(`the relay's port ${relayPort} is still open after stop`))
      }
      if (env.FRANK_REGTEST_KEEP !== '1') rmSync(stateDir, { recursive: true, force: true })
      if (failures.length > 0) throw failures[0]
    })())

  try {
    chains.push(await startEcashRegtest({ stateDir, blockIntervalMs: options.blockIntervalMs, env }))

    relayPort = await freePort()
    const relayUrl = `http://127.0.0.1:${relayPort}`
    const configPath = join(stateDir, 'relay.toml')
    writeFileSync(configPath, relayConfig(relayPort, join(stateDir, 'relay-db'), chains), { mode: 0o600 })
    const relayEnv = Object.assign({}, ...chains.map(chain => chain.relay.env)) as Record<string, string>
    const relay = supervisor.start({
      name: 'relay',
      command: cashwebd,
      args: [configPath],
      cwd: stateDir,
      logPath: relayLogPath,
      env: relayEnv,
    })
    // The relay answers only after it has found each network's checkpoint block on its upstream.
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        const response = await fetch(`${relayUrl}/chains`)
        if (response.ok) {
          const advertised = JSON.stringify(await response.json())
          const missing = chains.filter(chain => !advertised.includes(`"${chain.chainIdentifier}"`))
          if (missing.length > 0) {
            throw new Error(`the relay does not serve ${missing.map(chain => chain.chainIdentifier).join(', ')}`)
          }
          break
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('the relay does not serve')) throw err
      }
      if (relay.hasExited() || Date.now() > deadline) {
        throw new Error(
          `the relay ${relay.hasExited() ? 'exited during startup' : 'did not answer in time'}:\n${relay.tail().join('\n')}`,
        )
      }
      await sleep(250)
    }
    return {
      relayUrl,
      chains: Object.fromEntries(chains.map(chain => [chain.chainIdentifier, chain])),
      stateDir,
      relayLogPath,
      stop,
    }
  } catch (err) {
    await stop().catch(() => undefined)
    throw err
  }
}
