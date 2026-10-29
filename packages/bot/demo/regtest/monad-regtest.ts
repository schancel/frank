/**
 * A local Monad network: monad-solonet (github.com/monad-crypto/monad-solonet), the real Monad
 * consensus and execution client as a single validator. It is the network `monad-regtest`: chain
 * ID 20143 (Monad's devnet ID; testnet is 10143, mainnet 143), tag MONR. It charges the gas limit
 * and enforces the reserve balance exactly as Monad does (docs/protocol/chains/monad-reserve-balance.md).
 *
 *   yarn --cwd packages/bot regtest:monad-status   # is the VM up, is the chain making blocks
 *   yarn --cwd packages/bot regtest:monad-stop     # remove the chain and stop the VM
 *   yarn --cwd packages/bot regtest:monad-fund 0x... 5   # the faucet pays 5 MON to 0x...
 *   yarn --cwd packages/bot regtest:monad-sweep < keys  # each key (one per line) pays all back
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
 *   3. creates the chain only when its container is absent; a stopped container is retained
 *      for explicit recovery or disposal. Runs `monadcrypto/monad-solonet` with JSON-RPC on
 *      127.0.0.1:48080 and WebSocket on 127.0.0.1:48081 (its host-networking default on port 8080 would
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

import { isError, JsonRpcProvider, parseEther, Transaction, TransactionRequest, Wallet } from 'ethers'

import { RegtestChain, sleep } from './regtest-chain'

export const MONAD_REGTEST_CHAIN = 'monad-regtest'
export const MONAD_REGTEST_CHAIN_ID = 20143n
export const MONAD_REGTEST_NETWORK_TAG = 'MONR'
/** The relay's minimum stamp on this network, the same as the local testnet config: the payment
 * floor, 10 x 21000 gas x 100 gwei (docs/protocol/chains/README.md). */
export const MONAD_REGTEST_MIN_STAMP_WEI = 21_000_000_000_000_000n
/**
 * Account 0 of the standard dev-node mnemonic ("test test ... junk"), which solonet's genesis
 * funds. Publicly known: it is a faucet for a local chain and nothing else.
 */
const FAUCET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const UPSTREAM_ENV = 'MONAD_REGTEST_HTTP_RPC_URL'
/**
 * How far below the head the relay's checkpoint sits. Solonet keeps only its last few thousand
 * blocks, so a long-lived chain no longer has block 1; a recent block is always there.
 */
const CHECKPOINT_DEPTH = 16

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

async function chainId(rpcUrl: string): Promise<bigint | undefined> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(3000),
    })
    const body = (await response.json()) as { result?: string }
    return body.result ? BigInt(body.result) : undefined
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
  /** `stopped` is a container of an earlier run that no longer runs (exited, created or dead).
   * A paused, restarting or removing container is reported as an error instead. */
  container: 'running' | 'stopped' | 'absent' | 'not-managed'
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
  const listed = await run(
    'docker',
    [...DOCKER, 'ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.State}}'],
    30_000,
  )
  // A failed listing (a lost Colima socket forward, a timeout) says nothing about the chain:
  // reporting it absent would let ensureSolonet remove a running chain.
  if (listed.code !== 0) {
    throw new Error(`cannot read the state of the ${CONTAINER} container; leaving it alone:\n${listed.out.slice(-2000)}`)
  }
  const state = listed.out.trim()
  if (['paused', 'restarting', 'removing'].includes(state)) {
    throw new Error(`the ${CONTAINER} container is ${state}; resolve that by hand (docker --context colima-${PROFILE} ...)`)
  }
  const container = state === '' ? 'absent' : state === 'running' ? 'running' : 'stopped'
  return { external: false, vm: 'running', container, rpcUrl, block: container === 'running' ? await blockNumber(rpcUrl) : undefined }
}

/** Starts the VM if needed and creates a chain only when absent, then waits for blocks.
 * Returns the chain's RPC URLs. Retains stopped chains and leaves running chains as they are. */
export async function ensureSolonet(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = line => console.log(line),
): Promise<{ rpcUrl: string; wsUrl?: string }> {
  // A chain that answers as solonet is in use: never restart or replace it, and need no docker.
  if (!env.FRANK_SOLONET_RPC_URL) {
    const rpcUrl = `http://127.0.0.1:${RPC_PORT}`
    if ((await chainId(rpcUrl)) === MONAD_REGTEST_CHAIN_ID) {
      const block = await blockNumber(rpcUrl)
      if (block !== undefined && block >= 12) return { rpcUrl, wsUrl: `ws://127.0.0.1:${WS_PORT}` }
    }
  }
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
  if (status.container === 'stopped') {
    throw new Error(
      `the existing ${CONTAINER} container is stopped; its chain data is retained. ` +
      'Recover the existing container or explicitly dispose of it before starting a new chain.',
    )
  }
  if (status.container === 'absent') {
    // The limits are lost when the VM restarts; setting them again is harmless.
    await must('colima', [
      'ssh', '-p', PROFILE, '--', 'sudo', 'sysctl', '-w',
      'net.core.rmem_max=62500000', 'net.core.rmem_default=62500000',
      'net.core.wmem_max=62500000', 'net.core.wmem_default=62500000',
    ])
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
  /** The head when this handle was opened: where a check's own transactions start. */
  readonly startBlock: number
}

/** The leftover key sweep of this process (`solonet-keys.ts`), run once before anything funds. */
let leftoversSwept: Promise<void> | undefined

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
  const startBlock = await provider.getBlockNumber()
  // Keys an earlier check saved and never swept go back first (once per process).
  leftoversSwept ??= import('./solonet-keys')
    .then(({ sweepLeftoverKeyRuns }) => sweepLeftoverKeyRuns(rpcUrl))
    .then(
      () => undefined,
      error => console.warn(`[solonet] the leftover key sweep failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  await leftoversSwept
  const checkpointHeight = Math.max(
    1,
    startBlock - CHECKPOINT_DEPTH,
  )
  const checkpoint = await provider.getBlock(checkpointHeight)
  if (!checkpoint?.hash) {
    provider.destroy()
    throw new Error(`solonet has no block ${checkpointHeight}`)
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
    checkpoint: { height: checkpointHeight, hash: checkpoint.hash },
    relay: {
      section: 'evm_rpc',
      row: [
        '[[registry.evm_rpc.chains]]',
        `id = "${MONAD_REGTEST_CHAIN}"`,
        `expected_chain_id = ${MONAD_REGTEST_CHAIN_ID}`,
        `upstream_env = "${UPSTREAM_ENV}"`,
        `checkpoint_block_number = ${checkpointHeight}`,
        `checkpoint_block_hash = "${checkpoint.hash}"`,
        ...(wsUrl ? ['upstream_ws_env = "MONAD_REGTEST_WS_RPC_URL"'] : []),
        'max_get_logs_range = 10',
      ].join('\n'),
      env: { [UPSTREAM_ENV]: rpcUrl, ...(wsUrl ? { MONAD_REGTEST_WS_RPC_URL: wsUrl } : {}) },
      mailbox: { minValueWei: MONAD_REGTEST_MIN_STAMP_WEI },
    },
    rpcUrl,
    provider,
    faucet,
    faucetAddress: faucet.address,
    startBlock,
    fund: (address, amount) =>
      exclusive(() => payAtFreshNonce(faucet, { to: address, value: amount, gasLimit: 21_000n })),
    // Blocks come on their own; "mine" waits until that many more exist.
    mine: (blocks = 1) => waitBlocks(blocks),
    stop: async () => {
      await queue.catch(() => undefined)
      provider.destroy()
    },
  }
}

/**
 * Pays `amount` wei from the faucet to `address` on the running solonet and waits for it to land.
 * Needs only the chain's JSON-RPC, not a checkpoint: this is the `fund` command, for funding app
 * accounts and bot funding wallets of a lab by hand. Returns the transaction hash.
 */
export async function fundFromFaucet(
  address: string,
  amount: bigint,
  rpcUrl = process.env.FRANK_SOLONET_RPC_URL ?? `http://127.0.0.1:${RPC_PORT}`,
): Promise<string> {
  return sendAll(new Wallet(FAUCET_PRIVATE_KEY), address, rpcUrl, amount)
}

/**
 * Sends `amount` wei (default: the whole balance less the fee) from `key` to `to` on solonet:
 * the `sweep` command, which returns a lab's test funds to the faucet. Returns the hash, or
 * undefined when there is nothing worth sending.
 */
export async function sweepToFaucet(
  key: string,
  rpcUrl = process.env.FRANK_SOLONET_RPC_URL ?? `http://127.0.0.1:${RPC_PORT}`,
): Promise<string | undefined> {
  const faucet = new Wallet(FAUCET_PRIVATE_KEY)
  try {
    return await sendAll(new Wallet(key), faucet.address, rpcUrl)
  } catch (err) {
    if (err instanceof Error && err.message === 'nothing to sweep') return undefined
    throw err
  }
}

async function sendAll(signer: Wallet, to: string, rpcUrl: string, amount?: bigint): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl, MONAD_REGTEST_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  provider.pollingInterval = 250
  try {
    const reported = BigInt(await provider.send('eth_chainId', []))
    if (reported !== MONAD_REGTEST_CHAIN_ID) {
      throw new Error(`${rpcUrl} reports chain id ${reported}, not a Monad solonet (${MONAD_REGTEST_CHAIN_ID})`)
    }
    const wallet = signer.connect(provider)
    const fee = await provider.getFeeData()
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n
    let maxFeePerGas = (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 2n
    let value = amount
    if (value === undefined) {
      // Monad charges the gas limit at base fee + tip, up to the fee cap, not the cap itself. A
      // sweep caps the fee at base + tip + SWEEP_TIP_MARGIN_WEI and holds back exactly that;
      // every signing tips at least the quoted tip, so at most 21,000 x the margin is left.
      const base = (await provider.getBlock('latest'))?.baseFeePerGas
      if (base == null) throw new Error('solonet reports no base fee')
      maxFeePerGas = base + maxPriorityFeePerGas + SWEEP_TIP_MARGIN_WEI
      const balance = await provider.getBalance(wallet.address, 'pending')
      value = balance - 21_000n * maxFeePerGas
      if (value <= 0n) throw new Error('nothing to sweep')
    }
    return await payAtFreshNonce(wallet, { to, value, gasLimit: 21_000n, maxFeePerGas, maxPriorityFeePerGas })
  } finally {
    provider.destroy()
  }
}

/** How many times one payment is signed in all, at whatever nonces. */
const MAX_SIGNINGS = 12
/** The most the per-signing tip bump adds to the fee per gas (one wei per signing). */
export const SWEEP_TIP_MARGIN_WEI = BigInt(MAX_SIGNINGS)
/** How long a nonce the node may hold a signing at waits to be used, before the call fails. */
const NONCE_USE_TIMEOUT_MS = 120_000

/** The node's error, with what ethers wrapped around it. */
function errorText(error: unknown): string {
  const parts: string[] = []
  for (let cause: unknown = error, depth = 0; cause && depth < 4; depth++) {
    const record = cause as { message?: unknown; error?: unknown; info?: { error?: unknown } }
    if (typeof record.message === 'string') parts.push(record.message)
    cause = record.error ?? record.info?.error
  }
  return parts.join(' ')
}

/**
 * How the node answered a transaction it did not take.
 *  - `taken`: the sender already has another transaction at that nonce, or the nonce is used:
 *    another process paying from the same account (the faucet is shared by every check on this
 *    solonet) read the same pending nonce. Solonet says "An existing transaction had higher
 *    priority" (-32000); other nodes "nonce too low" or "replacement transaction underpriced".
 *  - `refused`: turned down for now and not held ("A newer transaction had higher priority";
 *    "Signer had insufficient balance", which Monad says until money received is about four
 *    blocks old: docs/protocol/chains/monad-reserve-balance.md).
 *  - `maybe-held`: the node was busy or the answer was lost; it may hold the transaction anyway.
 *  - undefined: anything else, which is not a nonce race.
 */
export function rejection(error: unknown): 'taken' | 'refused' | 'maybe-held' | undefined {
  if (isError(error, 'NONCE_EXPIRED') || isError(error, 'REPLACEMENT_UNDERPRICED')) return 'taken'
  const text = errorText(error)
  if (/existing transaction had higher priority|nonce too low|nonce has already been used|replacement transaction underpriced/i.test(text))
    return 'taken'
  if (/newer transaction had higher priority|signer had insufficient balance/i.test(text)) return 'refused'
  if (isError(error, 'TIMEOUT') || isError(error, 'NETWORK_ERROR') || /overloaded|try again|timed? ?out|busy|ECONNRESET|socket hang up/i.test(text))
    return 'maybe-held'
  return undefined
}

/**
 * Pays `request` from `signer` and waits until it has landed, paying once even when other
 * processes pay from the same account at the same time (the faucet is shared by every check on
 * this solonet).
 *
 * The rule is the wallet's (packages/wallet/chain/evm-refused-resign.ts): every signing is the
 * same payment, and every signing this call made is watched by hash, refused ones included (a
 * Monad node can take bytes it refused thousands of blocks later). A signing is made at a higher
 * nonce only once the chain shows the lower nonce was used by a transaction that is none of
 * this call's signings: then none of them can ever land. Until then the payment is signed again
 * at the same nonce (other bytes: one wei more tip) or waited on, so at most one signing can be
 * mined. Bounded: `MAX_SIGNINGS` signings, and a nonce the node may hold a signing at that is
 * not used within `NONCE_USE_TIMEOUT_MS` fails the call rather than move on. Returns the hash
 * that landed.
 */
export async function payAtFreshNonce(
  signer: Wallet,
  request: Omit<TransactionRequest, 'nonce' | 'from'>,
): Promise<string> {
  const provider = signer.provider as JsonRpcProvider | null
  if (!provider) throw new Error('payAtFreshNonce needs a connected signer')
  /** Every signing of this call, by hash. */
  const signed = new Set<string>()
  // Read from a block before any nonce this call signs at could have been used.
  const blocks = new SenderBlocks(provider, signer.address, await provider.getBlockNumber())
  let nonce = await provider.getTransactionCount(signer.address, 'pending')
  let why = ''
  // Signings of an earlier call (another run sweeping the same key, say) are not repeated: the
  // node may still refuse those bytes. The tip only ever rises, and a fee cap bounds the cost.
  const tipOffset = BigInt(Math.floor(Math.random() * 1_000_000))
  for (let signing = 1; signing <= MAX_SIGNINGS; signing++) {
    const populated = await signer.populateTransaction({ ...request, nonce })
    // Other bytes on each signing: the node keeps refusing bytes it once refused, even once they
    // would be valid. One wei more of tip changes them, within the same fee cap (the most the
    // payment can be charged per gas).
    if (populated.maxPriorityFeePerGas != null && populated.maxFeePerGas != null) {
      const tip = BigInt(populated.maxPriorityFeePerGas) + tipOffset + BigInt(signing - 1)
      const cap = BigInt(populated.maxFeePerGas)
      populated.maxPriorityFeePerGas = tip > cap ? cap : tip
    }
    const raw = await signer.signTransaction(populated)
    signed.add(Transaction.from(raw).hash as string)
    let answer: ReturnType<typeof rejection> | 'accepted' = 'accepted'
    try {
      await provider.send('eth_sendRawTransaction', [raw])
    } catch (error) {
      answer = rejection(error)
      if (!answer) throw error
      why = `nonce ${nonce}: ${errorText(error).slice(0, 160)}`
    }
    // Refused for now and held by nobody: signed again at the same nonce, unless it was used.
    // Otherwise (taken, held, or perhaps held) the nonce is waited on until it is used.
    const outcome = await nonceOutcome(provider, signer.address, nonce, signed, blocks, {
      wait: answer !== 'refused',
    })
    if (outcome.kind === 'ours') return outcome.hash
    if (outcome.kind === 'other') {
      why = `nonce ${nonce} was used by another transaction (${outcome.hash})`
      nonce = Math.max(nonce + 1, await provider.getTransactionCount(signer.address, 'pending'))
    }
    console.warn(`[solonet] ${signer.address}: ${why}; signing again at nonce ${nonce} (signing ${signing + 1})`)
    // A refusal for a young balance lasts a few blocks; a little jitter keeps two funders from
    // colliding in step.
    await sleep((answer === 'refused' ? 1000 : 100) + Math.floor(Math.random() * 400))
  }
  throw new Error(`${signer.address} could not pay after ${MAX_SIGNINGS} signings: ${why}`)
}

/**
 * What became of `sender`'s `nonce`: used by one of `ours` (`ours`, its hash), used by another
 * transaction (`other`), or not used yet (`unused`, only when not told to `wait`). Waiting, it
 * polls until the nonce is used, and fails after `NONCE_USE_TIMEOUT_MS`: one of ours could still
 * be mined there, so nothing may be signed at a higher nonce. Which transaction used the nonce is
 * read from the block that holds it (`blocks`), not guessed from a missing receipt.
 */
async function nonceOutcome(
  provider: JsonRpcProvider,
  sender: string,
  nonce: number,
  ours: ReadonlySet<string>,
  blocks: SenderBlocks,
  options: { wait: boolean },
): Promise<{ kind: 'ours' | 'other'; hash: string } | { kind: 'unused' }> {
  const deadline = Date.now() + NONCE_USE_TIMEOUT_MS
  for (;;) {
    if ((await provider.getTransactionCount(sender, 'latest')) > nonce) {
      const hash = await blocks.find(nonce)
      if (!ours.has(hash)) return { kind: 'other', hash }
      const receipt = await provider.getTransactionReceipt(hash)
      if (!receipt || receipt.status !== 1) throw new Error(`payment ${hash} did not succeed`)
      return { kind: 'ours', hash }
    }
    if (!options.wait) return { kind: 'unused' }
    if (Date.now() >= deadline) {
      throw new Error(
        `nonce ${nonce} of ${sender} was not used within ${NONCE_USE_TIMEOUT_MS / 1000} s; one of ${[...ours].join(', ')} could still land there`,
      )
    }
    await sleep(250)
  }
}

/**
 * `sender`'s transactions in the blocks from `from` on, by nonce, read block by block (solonet
 * keeps blocks but not the state of older ones, so a nonce cannot be looked up by block).
 * `from` is a block before any nonce asked about was used.
 */
class SenderBlocks {
  private next: number
  private readonly byNonce = new Map<number, string>()

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly sender: string,
    from: number,
  ) {
    this.next = from
  }

  /** The hash of the transaction that used `nonce`, which the chain says is used. */
  async find(nonce: number): Promise<string> {
    const deadline = Date.now() + 30_000
    for (;;) {
      const known = this.byNonce.get(nonce)
      if (known) return known
      const head = await this.provider.getBlockNumber()
      while (this.next <= head) {
        const block = await this.provider.getBlock(this.next, true)
        if (!block) break
        for (const tx of block.prefetchedTransactions)
          if (tx.from.toLowerCase() === this.sender.toLowerCase()) this.byNonce.set(tx.nonce, tx.hash)
        this.next += 1
      }
      if (this.byNonce.has(nonce)) continue
      if (Date.now() >= deadline) {
        throw new Error(`no block from the start of this payment holds ${this.sender}'s nonce ${nonce}`)
      }
      await sleep(250)
    }
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
    } else if (command === 'fund') {
      // fund <address> <amount in MON>
      const [address, amount] = process.argv.slice(3)
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !amount) {
        throw new Error('usage: monad-regtest.ts fund <0x address> <amount in MON, for example 5>')
      }
      const hash = await fundFromFaucet(address, parseEther(amount))
      console.log(`faucet paid ${amount} MON to ${address} in ${hash}`)
      return
    } else if (command === 'sweep') {
      // sweep: reads 0x private keys, one per line, from stdin (never from argv, which `ps` shows).
      const keys = (await new Promise<string>(done => {
        let text = ''
        process.stdin.on('data', chunk => (text += chunk))
        process.stdin.on('end', () => done(text))
      }))
        .split(/\s+/)
        .filter(Boolean)
      for (const key of keys) {
        const address = new Wallet(key).address
        const hash = await sweepToFaucet(key)
        console.log(hash ? `swept ${address} to the faucet in ${hash}` : `${address}: nothing to sweep`)
      }
      return
    } else if (command !== 'status') {
      throw new Error('usage: monad-regtest.ts status|start|stop|fund <address> <MON>|sweep (keys on stdin)')
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
