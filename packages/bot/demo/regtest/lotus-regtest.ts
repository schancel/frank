/**
 * A Lotus v2 regtest network: one real `lotusd -regtest` (the Lotus repository's v2 series, with
 * Chronik) on free local ports, with a faucet and a block driver.
 *
 * The node is LOTUSD_BIN (Lotus v2 publishes no release; for example
 * `<lotus>/daemon/.build/v2-current/lotusd`). It is only ever started with `-regtest`: Lotus v2
 * native transactions exist only there (docs/plans/lotus-v2-base).
 *
 * The faucet is the public test key whose native coinbases the node mines (scalar 7, as in
 * packages/wallet/lotus-v2/lotusd-regtest.testutil.ts). `fund` pays from a matured coinbase with
 * a native v7 transaction built through @frank/nakamoto and mines a block. Chronik `/v2` is
 * confirmed-only, so a block also comes every `blockIntervalMs` (default 3 s): a wallet's send
 * shows in its balance and History without anyone mining by hand.
 *
 * `faucetPay` (below) is the same payment from another process, given the node's RPC and Chronik
 * addresses: `yarn --cwd packages/bot regtest:lotus-fund` uses it against a running stack.
 */
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

import {
  keyhashPaymentSize,
  lotusV2AddressRoot,
  lotusV2KeyhashDestination,
  lotusV2XOnlyKey,
  rpcTxid,
  signKeyhashPayment,
} from '@frank/wallet/lotus-v2/network'

import { Supervisor } from '../supervisor'
import { freePort, isListening, RegtestChain, sleep } from './regtest-chain'

export const LOTUS_REGTEST_CHAIN = 'lotus-v2-regtest'
const CHRONIK_ENV = 'LOTUS_V2_REGTEST_CHRONIK_URL'
/** Height of the checkpoint block: the first block this run mined, which no other chain has. */
const CHECKPOINT_HEIGHT = 1
const COINBASE_MATURITY = 100
/** Blocks mined at start: the first 40 faucet coinbases are mature. */
const START_BLOCKS = COINBASE_MATURITY + 40
const RPC_USER = 'frank'
const RPC_PASSWORD = 'frank'

export interface LotusNodeEndpoints {
  readonly rpcUrl: string
  readonly chronikUrl: string
}

export interface LotusRegtest extends RegtestChain {
  readonly chronikUrl: string
  readonly rpcUrl: string
  readonly logPath: string
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>
}

function faucet() {
  const secret = new Uint8Array(32)
  secret[31] = 7
  return { secret, ...lotusV2KeyhashDestination('regtest', lotusV2XOnlyKey(secret)) }
}

export function lotusRpc(rpcUrl: string) {
  return async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString('base64')}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'frank-regtest', method, params }),
    })
    const body = (await response.json()) as { result: T; error: { message: string } | null }
    if (body.error) throw new Error(`lotus-v2-regtest ${method}: ${body.error.message}`)
    return body.result
  }
}

/** Mines `blocks` to the faucet and waits until Chronik's confirmed `/v2` index has them. */
export async function lotusMine(node: LotusNodeEndpoints, blocks: number): Promise<void> {
  const rpc = lotusRpc(node.rpcUrl)
  await rpc('generatetoaddress', [blocks, faucet().address])
  const height = await rpc<number>('getblockcount')
  for (let i = 0; i < 300; i++) {
    const status = (await (await fetch(`${node.chronikUrl}/v2/status`)).json()) as {
      ready: boolean
      snapshot?: { height: string }
    }
    if (status.ready && Number(status.snapshot?.height) >= height) return
    await sleep(100)
  }
  throw new Error('lotus-v2-regtest: Chronik did not index the tip in time')
}

/**
 * Pays `atoms` to `address` from one of the faucet's matured coinbases and mines it. `skip`
 * names coins this process already spent (the confirmed-only index still lists a mempool spend).
 */
export async function faucetPay(
  node: LotusNodeEndpoints,
  address: string,
  atoms: bigint,
  skip: Set<string> = new Set(),
): Promise<string> {
  const rpc = lotusRpc(node.rpcUrl)
  const { secret, root } = faucet()
  const tip = await rpc<number>('getblockcount')
  type Rec = { txid: string; out_idx: number; value: string; creation: { height: string; tx_index: number } }
  const records: Rec[] = []
  let cursor: string | null = null
  do {
    const page = (await (
      await fetch(`${node.chronikUrl}/v2/branches/utxos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ any_branch: [root], page_size: 100, ...(cursor ? { cursor } : {}) }),
      })
    ).json()) as { cursor: string | null; outputs?: { record: Rec }[] }
    if (!page.outputs) throw new Error(`Chronik refused the faucet query: ${JSON.stringify(page)}`)
    records.push(...page.outputs.map(output => output.record))
    cursor = page.cursor
  } while (cursor)
  const fee = BigInt(keyhashPaymentSize(1, 2))
  const coin = records.find(
    record =>
      record.creation.tx_index === 0 &&
      Number(record.creation.height) <= tip - COINBASE_MATURITY &&
      !skip.has(`${record.txid}:${record.out_idx}`) &&
      BigInt(record.value) >= atoms + fee + 546n,
  )
  if (!coin) throw new Error(`The faucet has no matured coinbase of at least ${atoms} atoms left`)
  skip.add(`${coin.txid}:${coin.out_idx}`)
  const tx = signKeyhashPayment({
    network: 'regtest',
    inputs: [{ txid: coin.txid, outIdx: coin.out_idx, value: BigInt(coin.value), secret }],
    outputs: [
      { value: atoms, root: lotusV2AddressRoot('regtest', address.trim()) },
      { value: BigInt(coin.value) - atoms - fee, root },
    ],
  })
  const accepted = await rpc<string>('sendrawtransaction', [tx.raw])
  if (accepted !== rpcTxid(tx.txid)) throw new Error('lotusd reported another txid')
  await lotusMine(node, 1)
  return tx.txid
}

export async function startLotusRegtest(options: {
  stateDir: string
  blockIntervalMs?: number
  env?: Record<string, string | undefined>
}): Promise<LotusRegtest> {
  const env = options.env ?? process.env
  const lotusd = env.LOTUSD_BIN
  if (!lotusd || !existsSync(lotusd))
    throw new Error(
      'lotus-v2-regtest needs LOTUSD_BIN: a lotusd built from the Lotus repository v2 series, with Chronik (for example <lotus>/daemon/.build/v2-current/lotusd)',
    )
  const dataDir = join(options.stateDir, LOTUS_REGTEST_CHAIN)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const logPath = join(options.stateDir, 'logs', `${LOTUS_REGTEST_CHAIN}.log`)
  const [rpcPort, chronikPort, p2pPort] = [await freePort(), await freePort(), await freePort()]
  const supervisor = new Supervisor(env, () => {})
  const killNow = () => supervisor.killAllNow()
  process.prependListener('exit', killNow)
  const node = supervisor.start({
    name: LOTUS_REGTEST_CHAIN,
    command: lotusd,
    args: [
      // Regtest only, always: Lotus v2 native transactions exist nowhere else.
      '-regtest',
      `-datadir=${dataDir}`,
      '-server',
      '-listen=0',
      `-port=${p2pPort}`,
      `-rpcuser=${RPC_USER}`,
      `-rpcpassword=${RPC_PASSWORD}`,
      `-rpcport=${rpcPort}`,
      '-rpcbind=127.0.0.1',
      '-rpcallowip=127.0.0.1',
      '-txindex=1',
      '-chronik=1',
      `-chronikbind=127.0.0.1:${chronikPort}`,
    ],
    cwd: dataDir,
    logPath,
    env: {},
  })
  const endpoints = {
    rpcUrl: `http://127.0.0.1:${rpcPort}/`,
    chronikUrl: `http://127.0.0.1:${chronikPort}`,
  }
  const rpc = lotusRpc(endpoints.rpcUrl)

  let timer: NodeJS.Timeout | undefined
  let stopped: Promise<void> | undefined
  // One node conversation at a time: the timer, `fund` and `mine` never interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }
  const stop = () =>
    (stopped ??= (async () => {
      if (timer) clearInterval(timer)
      await queue.catch(() => undefined)
      if (!node.hasExited()) {
        await rpc('stop').catch(() => undefined)
        await Promise.race([node.exited, sleep(20_000)])
      }
      await supervisor.stopAll()
      process.off('exit', killNow)
      for (const port of [rpcPort, chronikPort])
        if (await isListening(port)) throw new Error(`${LOTUS_REGTEST_CHAIN}: port ${port} is still open after stop`)
    })())

  try {
    const deadline = Date.now() + 60_000
    for (;;) {
      if (node.hasExited()) throw new Error(`lotusd exited during startup; see ${logPath}`)
      try {
        await rpc('getblockcount')
        break
      } catch {
        if (Date.now() > deadline) throw new Error(`lotusd did not answer in time; see ${logPath}`)
        await sleep(250)
      }
    }
    await lotusMine(endpoints, START_BLOCKS)
    const checkpointHash = await rpc<string>('getblockhash', [CHECKPOINT_HEIGHT])
    const spent = new Set<string>()
    timer = setInterval(() => {
      void exclusive(() => lotusMine(endpoints, 1)).catch(() => undefined)
    }, options.blockIntervalMs ?? 3000)
    timer.unref()
    return {
      chainIdentifier: LOTUS_REGTEST_CHAIN,
      checkpoint: { height: CHECKPOINT_HEIGHT, hash: checkpointHash },
      relay: {
        section: 'bitcoin_proxy',
        row: [
          '[[registry.bitcoin_proxy.chains]]',
          `id = "${LOTUS_REGTEST_CHAIN}"`,
          `chronik_upstream_env = "${CHRONIK_ENV}"`,
          `checkpoint_height = ${CHECKPOINT_HEIGHT}`,
          `checkpoint_hash = "${checkpointHash}"`,
        ].join('\n'),
        env: { [CHRONIK_ENV]: endpoints.chronikUrl },
      },
      ...endpoints,
      logPath,
      rpc,
      fund: (address, atoms) => exclusive(() => faucetPay(endpoints, address, atoms, spent)),
      mine: (blocks = 1) => exclusive(() => lotusMine(endpoints, blocks)),
      stop,
    }
  } catch (err) {
    await stop().catch(() => undefined)
    throw err
  }
}
