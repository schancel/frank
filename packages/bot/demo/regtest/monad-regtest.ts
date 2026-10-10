/**
 * A local Monad network: monad-solonet (github.com/monad-crypto/monad-solonet), the real Monad
 * consensus and execution client as a single validator. It is the network `monad-regtest`: chain
 * ID 20143 (Monad's devnet ID; testnet is 10143, mainnet 143), tag MONR. It charges the gas limit
 * and enforces the reserve balance exactly as Monad does (docs/protocol/chains/monad-reserve-balance.md).
 *
 *   yarn --cwd packages/bot regtest:monad-status   # is the VM up, is the chain making blocks
 *   yarn --cwd packages/bot regtest:monad-stop     # remove the chain and stop the VM
 *
 * Solonet only runs on x86_64 Linux. On an Apple silicon Mac that is an emulated VM, set up once:
 *
 *   brew install lima colima lima-additional-guestagents
 *
 * `ensureSolonet()` does the rest and is what every check calls first:
 *   1. starts the colima VM `frank-solonet` (x86_64, 8 CPUs, 16 GB, a sparse 300 GB disk that used
 *      16 GB after the first run) with `--activate=false`, so your Docker context does not change;
 *   2. raises the VM's network buffer limits, which the consensus client needs and a container
 *      on a bridge network cannot set for itself (once per VM boot);
 *   3. runs the `monadcrypto/monad-solonet` image with its JSON-RPC on 127.0.0.1:48080 and
 *      WebSocket on 127.0.0.1:48081 (solonet's own default, host networking on port 8080, would
 *      take a port the demo uses);
 *   4. waits for blocks.
 * A cold start takes 5 to 8 minutes (VM boot about 3, the chain about 5) and the VM then uses about
 * two cores and 8.6 GB while it runs, so a running solonet is REUSED by every check and is stopped
 * only by `regtest:monad-stop`. Blocks come about every 0.3 s on their own.
 *
 * FRANK_SOLONET_RPC_URL points the harness at a solonet someone else runs (a Linux host, say);
 * nothing is started or stopped then.
 */
import { execFile } from 'child_process'

import { JsonRpcProvider, Wallet } from 'ethers'

import { RegtestChain, sleep } from './regtest-chain'

export const MONAD_REGTEST_CHAIN = 'monad-regtest'
export const MONAD_REGTEST_CHAIN_ID = 20143n
export const MONAD_REGTEST_NETWORK_TAG = 'MONR'
/** The relay's minimum stamp on this network, the same as the local testnet config. */
export const MONAD_REGTEST_MIN_STAMP_WEI = 1_000_000_000_000n
/**
 * Account 0 of the standard dev-node mnemonic ("test test ... junk"), which solonet's genesis
 * funds. Publicly known: it is a faucet for a local chain and nothing else.
 */
const FAUCET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const UPSTREAM_ENV = 'MONAD_REGTEST_HTTP_RPC_URL'
/** The first block after genesis: every solonet starts from the same genesis allocation. */
const CHECKPOINT_HEIGHT = 1

const PROFILE = 'frank-solonet'
const CONTAINER = 'frank-solonet'
const IMAGE = 'monadcrypto/monad-solonet'
const RPC_PORT = 48080
const WS_PORT = 48081
const DOCKER = ['--context', `colima-${PROFILE}`]

function run(command: string, args: string[], timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  return new Promise(resolveRun => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolveRun({ code, out: `${stdout}${stderr}` })
    })
  })
}

async function must(command: string, args: string[], timeoutMs?: number): Promise<string> {
  const result = await run(command, args, timeoutMs)
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.out.slice(-2000)}`)
  return result.out
}

async function blockNumber(rpcUrl: string): Promise<number | undefined> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(3000),
    })
    const body = (await response.json()) as { result?: string }
    return body.result ? Number(BigInt(body.result)) : undefined
  } catch {
    return undefined
  }
}

async function vmRunning(): Promise<boolean> {
  const status = await run('colima', ['status', PROFILE], 30_000)
  return status.code === 0
}

export interface SolonetStatus {
  /** Set when FRANK_SOLONET_RPC_URL names a solonet this harness does not manage. */
  external: boolean
  vm: 'running' | 'stopped' | 'colima-not-installed' | 'not-managed'
  container: 'running' | 'absent' | 'not-managed'
  rpcUrl: string
  /** The chain's height, when it answers. */
  block?: number
}

export async function solonetStatus(env: Record<string, string | undefined> = process.env): Promise<SolonetStatus> {
  if (env.FRANK_SOLONET_RPC_URL) {
    const rpcUrl = env.FRANK_SOLONET_RPC_URL
    return { external: true, vm: 'not-managed', container: 'not-managed', rpcUrl, block: await blockNumber(rpcUrl) }
  }
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}`
  if ((await run('colima', ['version'], 30_000)).code !== 0) {
    return { external: false, vm: 'colima-not-installed', container: 'absent', rpcUrl }
  }
  if (!(await vmRunning())) return { external: false, vm: 'stopped', container: 'absent', rpcUrl }
  const running = await run('docker', [...DOCKER, 'ps', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}'], 30_000)
  const container = running.out.trim() === CONTAINER ? 'running' : 'absent'
  return { external: false, vm: 'running', container, rpcUrl, block: container === 'running' ? await blockNumber(rpcUrl) : undefined }
}

/** Starts whatever of the VM and the chain is not running, and waits for blocks. Returns the
 * chain's JSON-RPC and WebSocket URLs. Leaves a running solonet as it is. */
export async function ensureSolonet(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = line => console.log(line),
): Promise<{ rpcUrl: string; wsUrl?: string }> {
  let status = await solonetStatus(env)
  if (status.external) {
    if (status.block === undefined) throw new Error(`FRANK_SOLONET_RPC_URL (${status.rpcUrl}) does not answer`)
    return { rpcUrl: status.rpcUrl }
  }
  if (status.vm === 'colima-not-installed') {
    throw new Error('colima is not installed: brew install lima colima lima-additional-guestagents (see monad-regtest.ts)')
  }
  const urls = { rpcUrl: status.rpcUrl, wsUrl: `ws://127.0.0.1:${WS_PORT}` }
  if (status.vm === 'stopped') {
    log(`[solonet] starting the x86_64 VM "${PROFILE}" (about 3 minutes; your Docker context is not changed)`)
    await must(
      'colima',
      ['start', PROFILE, '--arch', 'x86_64', '--cpu-type', 'max', '--cpu', '8', '--memory', '16', '--disk', '300', '--activate=false'],
      1_200_000,
    )
    status = await solonetStatus(env)
  }
  if (status.container !== 'running') {
    // The limits are lost when the VM restarts; setting them again is harmless.
    await must('colima', [
      'ssh', '-p', PROFILE, '--', 'sudo', 'sysctl', '-w',
      'net.core.rmem_max=62500000', 'net.core.rmem_default=62500000',
      'net.core.wmem_max=62500000', 'net.core.wmem_default=62500000',
    ])
    // A stopped container of an earlier run holds an old chain; start a new one.
    await run('docker', [...DOCKER, 'rm', '-f', CONTAINER], 60_000)
    log('[solonet] starting the chain (about 5 minutes under emulation; the first run also downloads the image)')
    await must(
      'docker',
      [
        ...DOCKER, 'run', '-d', '--name', CONTAINER, '--privileged', '--ulimit', 'nofile=16384:16384',
        '-p', `127.0.0.1:${RPC_PORT}:8080`, '-p', `127.0.0.1:${WS_PORT}:8081`, IMAGE,
      ],
      1_800_000,
    )
  }
  const deadline = Date.now() + 15 * 60_000
  for (;;) {
    const block = await blockNumber(urls.rpcUrl)
    // The chain's own start-up waits for its first ten blocks before it funds its validator.
    if (block !== undefined && block >= 12) return urls
    if (Date.now() > deadline) {
      throw new Error(
        `solonet made no blocks within 15 minutes; see: docker --context colima-${PROFILE} logs ${CONTAINER}`,
      )
    }
    await sleep(3000)
  }
}

/** Removes the chain and stops the VM. The next `ensureSolonet` starts a new chain. */
export async function stopSolonet(): Promise<void> {
  if (!(await vmRunning())) return
  await run('docker', [...DOCKER, 'rm', '-f', CONTAINER], 120_000)
  await must('colima', ['stop', PROFILE], 300_000)
}

export interface MonadRegtest extends RegtestChain {
  readonly rpcUrl: string
  /** Reads the chain itself (not through the relay), for checking what the wallets report. */
  readonly provider: JsonRpcProvider
  readonly faucetAddress: string
  /** The faucet's signer, for harness steps that need a funded account (deploying contracts). */
  readonly faucet: Wallet
}

/**
 * The running solonet as a regtest network (starting it if needed). `stop()` only lets go of this
 * process's connection: the chain keeps running for the next check.
 */
export async function startMonadRegtest(
  options: { env?: Record<string, string | undefined> } = {},
): Promise<MonadRegtest> {
  const env = options.env ?? process.env
  const { rpcUrl, wsUrl } = await ensureSolonet(env)
  const provider = new JsonRpcProvider(rpcUrl, MONAD_REGTEST_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  provider.pollingInterval = 250
  const reported = BigInt(await provider.send('eth_chainId', []))
  if (reported !== MONAD_REGTEST_CHAIN_ID) {
    provider.destroy()
    throw new Error(`${rpcUrl} reports chain id ${reported}, not a Monad solonet (${MONAD_REGTEST_CHAIN_ID})`)
  }
  const checkpoint = await provider.getBlock(CHECKPOINT_HEIGHT)
  if (!checkpoint?.hash) {
    provider.destroy()
    throw new Error(`solonet has no block ${CHECKPOINT_HEIGHT} yet`)
  }
  const faucet = new Wallet(FAUCET_PRIVATE_KEY, provider)

  // One faucet payment at a time in this process, each with the next pending nonce.
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const waitBlocks = async (blocks: number) => {
    const target = (await provider.getBlockNumber()) + blocks
    while ((await provider.getBlockNumber()) < target) await sleep(100)
  }

  return {
    chainIdentifier: MONAD_REGTEST_CHAIN,
    checkpoint: { height: CHECKPOINT_HEIGHT, hash: checkpoint.hash },
    relay: {
      section: 'evm_rpc',
      row: [
        '[[registry.evm_rpc.chains]]',
        `id = "${MONAD_REGTEST_CHAIN}"`,
        `expected_chain_id = ${MONAD_REGTEST_CHAIN_ID}`,
        `upstream_env = "${UPSTREAM_ENV}"`,
        `checkpoint_block_number = ${CHECKPOINT_HEIGHT}`,
        `checkpoint_block_hash = "${checkpoint.hash}"`,
        ...(wsUrl ? ['upstream_ws_env = "MONAD_REGTEST_WS_RPC_URL"'] : []),
        'max_get_logs_range = 10',
      ].join('\n'),
      env: { [UPSTREAM_ENV]: rpcUrl, ...(wsUrl ? { MONAD_REGTEST_WS_RPC_URL: wsUrl } : {}) },
      mailbox: {
        rpcUrl,
        expectedChainId: MONAD_REGTEST_CHAIN_ID,
        minValueWei: MONAD_REGTEST_MIN_STAMP_WEI,
        networkTag: MONAD_REGTEST_NETWORK_TAG,
      },
    },
    rpcUrl,
    provider,
    faucet,
    faucetAddress: faucet.address,
    fund: (address, amount) =>
      exclusive(async () => {
        const nonce = await provider.getTransactionCount(faucet.address, 'pending')
        const tx = await faucet.sendTransaction({ to: address, value: amount, nonce, gasLimit: 21_000n })
        const receipt = await tx.wait(1, 120_000)
        if (!receipt || receipt.status !== 1) throw new Error(`faucet payment ${tx.hash} did not succeed`)
        return tx.hash
      }),
    // Blocks come on their own; "mine" waits until that many more exist.
    mine: (blocks = 1) => waitBlocks(blocks),
    stop: async () => {
      await queue.catch(() => undefined)
      provider.destroy()
    },
  }
}

if (require.main === module) {
  const command = process.argv[2]
  const main = async () => {
    if (command === 'stop') {
      await stopSolonet()
      console.log('solonet stopped: chain removed, VM stopped')
    } else if (command === 'start') {
      const { rpcUrl } = await ensureSolonet()
      console.log(`solonet is making blocks at ${rpcUrl}`)
    } else if (command !== 'status') {
      throw new Error('usage: monad-regtest.ts status|start|stop')
    }
    const status = await solonetStatus()
    console.log(
      `VM ${status.vm}; chain ${status.container}; ${status.rpcUrl} ${
        status.block === undefined ? 'does not answer' : `is at block ${status.block}`
      }`,
    )
  }
  main().then(
    () => process.exit(0),
    err => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
