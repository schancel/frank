/**
 * An eCash regtest network: one real Bitcoin ABC node with its Chronik indexer, on free local
 * ports, with a funded faucet and a block driver.
 *
 * A regtest node makes a block only when asked. The driver here asks on a timer (every
 * `blockIntervalMs`, default 3 s) so payments confirm without the test doing anything, and
 * `mine()` asks at once. 101 blocks are mined at the start so the first block's reward has matured
 * and the faucet can pay.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { Supervisor } from '../supervisor'
import { ensureBitcoinAbc } from './bitcoin-abc'
import { freePort, isListening, RegtestChain, sleep } from './regtest-chain'

export const ECASH_REGTEST_CHAIN = 'xec-regtest'
const CHRONIK_ENV = 'XEC_REGTEST_CHRONIK_URL'
/** Height of the checkpoint block: the first block this run mined, which no other chain has. */
const CHECKPOINT_HEIGHT = 1
/** Blocks before the faucet's first reward is spendable (100 confirmations). */
const MATURITY_BLOCKS = 101

export interface EcashRegtest extends RegtestChain {
  /** Chronik of the node itself. Wallets use the relay's proxy; this is for checking the chain. */
  readonly chronikUrl: string
  readonly logPath: string
  /** Calls the node's JSON-RPC (wallet calls go to the faucet wallet). */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>
}

/** Satoshis as the decimal XEC amount the node's RPC takes (1 XEC = 100 satoshis). */
function xecAmount(sats: bigint): string {
  return `${sats / 100n}.${(sats % 100n).toString().padStart(2, '0')}`
}

export async function startEcashRegtest(options: {
  stateDir: string
  blockIntervalMs?: number
  env?: Record<string, string | undefined>
}): Promise<EcashRegtest> {
  const env = options.env ?? process.env
  const bitcoind = await ensureBitcoinAbc(env)
  const dataDir = join(options.stateDir, 'xec-regtest')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const logPath = join(options.stateDir, 'logs', 'xec-regtest.log')
  const rpcPort = await freePort()
  const chronikPort = await freePort()
  const supervisor = new Supervisor(env, () => {})
  // Children run in their own process group, so a signal to this process does not reach the
  // node. Whatever ends this process, the node goes with it. Prepended so that it runs before
  // the stack removes the run's directory.
  const killNow = () => supervisor.killAllNow()
  process.prependListener('exit', killNow)
  const node = supervisor.start({
    name: 'xec-regtest',
    command: bitcoind,
    args: [
      '-regtest',
      `-datadir=${dataDir}`,
      '-server',
      '-listen=0',
      `-rpcport=${rpcPort}`,
      '-rpcbind=127.0.0.1',
      '-rpcallowip=127.0.0.1',
      '-chronik',
      `-chronikbind=127.0.0.1:${chronikPort}`,
      // By default the node mines only transactions that Avalanche has finalized. One node has
      // no Avalanche quorum, so nothing would ever confirm; mine straight from the mempool.
      '-avalanchepreconsensusmining=0',
      // Fee per kB (in XEC) for the faucet's own payments; a fresh chain has no fee estimate.
      '-fallbackfee=10',
    ],
    cwd: dataDir,
    logPath,
    env: {},
  })

  // The node writes a one-run RPC password to this file when it starts.
  const cookiePath = join(dataDir, 'regtest', '.cookie')
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${rpcPort}/wallet/faucet`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(readFileSync(cookiePath, 'utf8').trim()).toString('base64')}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'frank-regtest', method, params }),
    })
    const body = (await response.json()) as { result: T; error: { message: string } | null }
    if (body.error) throw new Error(`xec-regtest ${method}: ${body.error.message}`)
    return body.result
  }

  let timer: NodeJS.Timeout | undefined
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      if (timer) clearInterval(timer)
      await queue.catch(() => undefined)
      if (!node.hasExited()) {
        // Ask the node to shut down cleanly, then make sure of it.
        await rpc('stop').catch(() => undefined)
        await Promise.race([node.exited, sleep(15_000)])
      }
      await supervisor.stopAll()
      process.off('exit', killNow)
      for (const port of [rpcPort, chronikPort]) {
        if (await isListening(port)) throw new Error(`xec-regtest: port ${port} is still open after stop`)
      }
    })())

  // One RPC conversation at a time: the timer, `fund` and `mine` never interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  try {
    const deadline = Date.now() + 60_000
    for (;;) {
      if (node.hasExited()) throw new Error(`the eCash node exited during startup; see ${logPath}`)
      if (existsSync(cookiePath)) {
        try {
          await rpc('getblockcount')
          break
        } catch {
          /* still loading */
        }
      }
      if (Date.now() > deadline) throw new Error(`the eCash node did not answer in time; see ${logPath}`)
      await sleep(250)
    }
    await rpc('createwallet', ['faucet'])
    const faucetAddress = await rpc<string>('getnewaddress')
    const mineNow = (blocks: number) => rpc<string[]>('generatetoaddress', [blocks, faucetAddress])
    await mineNow(MATURITY_BLOCKS)
    const checkpointHash = await rpc<string>('getblockhash', [CHECKPOINT_HEIGHT])
    const chronikUrl = `http://127.0.0.1:${chronikPort}`

    timer = setInterval(() => {
      void exclusive(() => mineNow(1)).catch(() => undefined)
    }, options.blockIntervalMs ?? 3000)
    timer.unref()

    return {
      chainIdentifier: ECASH_REGTEST_CHAIN,
      checkpoint: { height: CHECKPOINT_HEIGHT, hash: checkpointHash },
      relay: {
        section: 'bitcoin_proxy',
        row: [
          '[[registry.bitcoin_proxy.chains]]',
          `id = "${ECASH_REGTEST_CHAIN}"`,
          `chronik_upstream_env = "${CHRONIK_ENV}"`,
          `checkpoint_height = ${CHECKPOINT_HEIGHT}`,
          `checkpoint_hash = "${checkpointHash}"`,
        ].join('\n'),
        env: { [CHRONIK_ENV]: chronikUrl },
      },
      chronikUrl,
      logPath,
      rpc,
      fund: (address, amount) =>
        exclusive(async () => {
          const txid = await rpc<string>('sendtoaddress', [address, xecAmount(amount)])
          await mineNow(1)
          return txid
        }),
      mine: (blocks = 1) => exclusive(() => mineNow(blocks)).then(() => undefined),
      stop,
    }
  } catch (err) {
    await stop().catch(() => undefined)
    throw err
  }
}
