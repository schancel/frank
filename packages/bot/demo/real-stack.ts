import { createRelayPricedEvmChain } from '@frank/wallet/chain/evm-host'
/**
 * The real test harness: the real relay binary against the real chain (Monad testnet), real
 * wallets, real transfers. Nothing here simulates a chain or a relay.
 *
 *   const stack = await startRealStack()                  // relay on port 28098, testnet RPC from .env
 *   const alice = await stack.openWallet('alice')         // an account: keys, directory entry, profile
 *   await stack.fund(alice.mainAccount, 12_000_000_000_000_000n)   // from the TEST wallet, confirmed
 *   const digest = await alice.send(bob.address, [{ type: 'text', text: 'hi' }], 1_000_000_000_000n)
 *   const got = await bob.receive(m => m.payloadDigest === digest)
 *   await stack.stop()                                    // closes the wallets, stops the relay
 *
 * Configuration comes from the process environment, then the repo's `.env`:
 *   MONAD_TESTNET_HTTP_RPC_URL   required (may be a comma-separated list)
 *   FRANK_TEST_WALLET_JSON       required for `fund`: {"address","privateKey"} of a funded testnet
 *                                wallet used ONLY by tests. Never the demo's funding wallet
 *                                (E2E_DEMO_MAIN_WALLET_JSON): the demo's bot host counts that
 *                                wallet's nonces in memory, so a transfer sent from it by anyone
 *                                else makes the host's next payment fail. There is no fallback.
 *   FRANK_TEST_MAX_FUND_WEI      the most one `fund` call may send (default 0.5 MON)
 *   CASHWEBD_BIN                 a prebuilt relay; otherwise this worktree's Cargo build is used
 *   FRANK_REAL_STACK_RELAY_PORT  port of the relay this starts (default 28098)
 *   FRANK_REAL_STACK_DIR         where state lives (default ~/.frank-real-stack)
 *
 * State is PERSISTENT and wallets are reused: `openWallet('alice')` against the same relay opens
 * the same account every run (its keys are in `<dir>/<relay>/wallets/alice`, mode 0600), with
 * whatever it still holds, so a run funds an account only when it has run dry and nothing is
 * stranded between runs. `stack.sweep()` sends what the opened wallets' main and identity
 * accounts hold, and what is left in their spent single-use sender accounts (the unused part of
 * each message's fee reserve), back to the test wallet, and returns what it could not move with
 * the reason; money in a wallet's stamp accounts prepared for coming messages stays with the
 * wallet and is spent by its next messages. A script that funds a wallet calls `sweep()` in a
 * `finally`. What a crashed run leaves is collected by `yarn --cwd packages/bot funds:sweep`.
 *
 * It spends real testnet funds: only what `fund` is asked for plus gas. Transfers from the test
 * wallet are serialised across processes by a lock directory beside the wallet file, each with
 * the next pending nonce and waited for, so parallel test runs cannot collide.
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

import { JsonRpcProvider, Wallet, formatEther } from 'ethers'

import { DirectoryManager } from '@frank/bot-framework/directory-manager'
import { RelayProfileManager } from '@frank/bot-framework/relay-profile-manager'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { deriveDomainRoot } from '@frank/domain-roots'
import type { ActiveChain, DirectMessageReceived, DirectMessageSendResult } from '@frank/wallet/chain/active-chain'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import { installCanonicalDirectory, loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { monadProtocolIdentity } from '@frank/wallet/monad-provider'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'

import { chainId, rpcUrlList } from './chain-rpc'
import { DEMO_DEFAULT_BURN_ADDRESS } from './demo-config'
import { readEnvFile } from './env-file'
import { Supervisor } from './supervisor'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const RELAY_SCRIPT = join(REPO_ROOT, 'backend', 'cashweb', 'run-local-monad.sh')
const MONAD_TESTNET_CHAIN_ID = 10143n
/** The most one `fund` call sends unless the caller or FRANK_TEST_MAX_FUND_WEI says otherwise. */
export const DEFAULT_MAX_FUND_WEI = 500_000_000_000_000_000n
const DEFAULT_RELAY_PORT = 28098
/** THE float: what a persistent test account (a harness wallet's main account, the smoke user,
 * a browser check's account) keeps between runs so the next run need not be funded again.
 * Everything above it goes back to the wallet that funded it when a run ends. 0.02 MON. */
export const TEST_ACCOUNT_FLOAT_WEI = 20_000_000_000_000_000n
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolvePort(port))
    })
  })
}

/** The process environment over the repo's `.env` (or `FRANK_DEMO_ENV_FILE`). Values are never printed. */
export function realStackEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const file = env.FRANK_DEMO_ENV_FILE ? resolve(env.FRANK_DEMO_ENV_FILE) : join(REPO_ROOT, '.env')
  const fromFile = readEnvFile(file)
  // A relative wallet path in the file means relative to the file.
  for (const name of ['E2E_DEMO_MAIN_WALLET_JSON', 'FRANK_TEST_WALLET_JSON']) {
    if (fromFile[name]) fromFile[name] = resolve(dirname(file), fromFile[name])
  }
  return { ...fromFile, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** The lines a relay launch added to its log after byte `from`. */
export function relayLogLinesSince(path: string, from: number): string[] {
  try {
    return readFileSync(path).subarray(from).toString('utf8').split('\n')
  } catch {
    return []
  }
}

export interface RealRelay {
  url: string
  logPath: string
  stop(): Promise<void>
}

/** Starts the real relay binary through the documented launcher and waits until it answers. The
 * relay itself checks its upstream's chain id and genesis block against the chain registry. */
export async function startRealRelay(options: {
  env?: Record<string, string | undefined>
  port: number
  stateDir: string
  timeoutS?: number
}): Promise<RealRelay> {
  const env = options.env ?? realStackEnv()
  const rpcUrl = env.MONAD_TESTNET_HTTP_RPC_URL
  if (!rpcUrl) throw new Error('MONAD_TESTNET_HTTP_RPC_URL is required (environment or .env)')
  const port = options.port
  const url = `http://127.0.0.1:${port}`
  const logPath = join(options.stateDir, 'logs', 'relay.log')
  const logStart = fileSize(logPath)
  const supervisor = new Supervisor(env, () => {})
  const relay = supervisor.start({
    name: 'relay',
    command: 'bash',
    args: [RELAY_SCRIPT],
    cwd: REPO_ROOT,
    logPath,
    env: {
      MONAD_TESTNET_HTTP_RPC_URL: rpcUrl,
      ...(env.MONAD_TESTNET_WS_RPC_URL ? { MONAD_TESTNET_WS_RPC_URL: env.MONAD_TESTNET_WS_RPC_URL } : {}),
      ...(env.XEC_TESTNET_CHRONIK_URL ? { XEC_TESTNET_CHRONIK_URL: env.XEC_TESTNET_CHRONIK_URL } : {}),
      ...(env.SOLANA_DEVNET_HTTP_RPC_URL ? { SOLANA_DEVNET_HTTP_RPC_URL: env.SOLANA_DEVNET_HTTP_RPC_URL } : {}),
      FRANK_NETWORK_TAG: 'MONT',
      MONAD_STAMP_BURN_ADDRESS: env.MONAD_STAMP_BURN_ADDRESS ?? DEMO_DEFAULT_BURN_ADDRESS,
      FRANK_RELAY_LISTEN: `127.0.0.1:${port}`,
      FRANK_RELAY_DB_PATH: join(options.stateDir, 'relay-db'),
      FRANK_RUN_LOCAL_SKIP_DOTENV: '1',
      ...(env.CASHWEBD_BIN ? { CASHWEBD_BIN: env.CASHWEBD_BIN } : {}),
      ...Object.fromEntries(
        ['PROTOC', 'CARGO', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN'].flatMap(name =>
          env[name] ? [[name, env[name] as string]] : [],
        ),
      ),
    },
  })
  const stop = () => supervisor.stopAll()
  // The launcher script moves an old-format relay database aside and says so in the log: repeat
  // that line here, where the person running the test sees it.
  let reported = false
  const reportMovedAside = () => {
    if (reported) return
    for (const line of relayLogLinesSince(logPath, logStart)) {
      if (!line.includes('MOVED ASIDE')) continue
      reported = true
      console.log(`[real-stack] ${line}`)
    }
  }
  const deadline = Date.now() + (options.timeoutS ?? 1800) * 1000
  for (;;) {
    try {
      if ((await fetch(`${url}/relay/v1/info`)).ok) break
    } catch {
      /* not up yet */
    }
    reportMovedAside()
    if (relay.hasExited() || Date.now() > deadline) {
      await stop()
      throw new Error(
        `the relay ${relay.hasExited() ? 'exited during startup' : 'did not answer in time'}; see ${logPath}`,
      )
    }
    await sleep(500)
  }
  reportMovedAside()
  return { url, logPath, stop }
}

/** Sends `valueWei` from the test wallet to `to` and waits for it to confirm. One transfer at a
 * time across every process using the same wallet file (a lock directory beside it). Refuses an
 * amount above `maxWei` (default 0.5 MON): a larger transfer has to be asked for on purpose. */
export async function fundFromWallet(params: {
  rpcUrl: string
  walletJsonPath: string
  to: string
  valueWei: bigint
  maxWei?: bigint
}): Promise<{ txHash: string; from: string }> {
  const maxWei = params.maxWei ?? DEFAULT_MAX_FUND_WEI
  if (params.valueWei > maxWei) {
    throw new Error(
      `refusing to send ${formatEther(params.valueWei)} MON in one funding transfer: the limit is ${formatEther(maxWei)} MON (pass a higher maxWei, or set FRANK_TEST_MAX_FUND_WEI, to allow it)`,
    )
  }
  const lock = `${params.walletJsonPath}.funding-lock`
  const lockDeadline = Date.now() + 10 * 60_000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (Date.now() > lockDeadline) throw new Error(`could not take the funding lock ${lock}; remove it if no test is running`)
      await sleep(500)
    }
  }
  const provider = new JsonRpcProvider(rpcUrlList(params.rpcUrl)[0], MONAD_TESTNET_CHAIN_ID, { staticNetwork: true })
  try {
    const { privateKey } = JSON.parse(readFileSync(params.walletJsonPath, 'utf8')) as { privateKey: string }
    const wallet = new Wallet(privateKey, provider)
    const balance = await provider.getBalance(wallet.address)
    if (balance <= params.valueWei) {
      throw new Error(
        `the test wallet ${wallet.address} holds ${formatEther(balance)} MON, not enough to send ${formatEther(params.valueWei)} MON`,
      )
    }
    const nonce = await provider.getTransactionCount(wallet.address, 'pending')
    const tx = await wallet.sendTransaction({ to: params.to, value: params.valueWei, nonce })
    const receipt = await tx.wait(1, 120_000)
    if (!receipt || receipt.status !== 1) throw new Error(`funding transfer ${tx.hash} did not succeed`)
    return { txHash: tx.hash, from: wallet.address }
  } finally {
    provider.destroy()
    rmdirSync(lock)
  }
}

export interface RealWallet {
  label: string
  /** True when this account already existed in the state directory (its keys were reused). */
  reused: boolean
  /** The address other accounts message. */
  address: string
  /** The account that holds this wallet's money and pays its stamps. */
  mainAccount: string
  handle: EvmChainWalletHandle
  chain: ActiveChain
  /** The verified directory installed for this wallet. A check that needs to stand between the
   * wallet and the relay (to drop one answer, say) installs a copy of it with its own `fetch`. */
  directory: Parameters<typeof installCanonicalDirectory>[1]
  /** Sends and waits until the relay has delivered it. The relay may first answer "accepted,
   * payment not confirmed yet"; the same attempt is then reconciled (never sent again) until it is
   * delivered, as the app and the bot host do. Returns the message's payload digest. */
  send(to: string, items: MessageItem[], stampValueWei?: bigint, timeoutMs?: number): Promise<string>
  /** Polls this wallet's mailbox until an inbound message matches, and returns it. */
  receive(match: (message: DirectMessageReceived) => boolean, timeoutMs?: number): Promise<DirectMessageReceived>
  close(): Promise<void>
}

/** An account on the real relay: keys (made on first use, reused afterwards), a published
 * directory entry and a profile, the same steps the app and the bot host take. A new account
 * holds no money until it is funded. */
export async function openRealWallet(params: {
  label: string
  relayUrl: string
  stateDir: string
  stampValueWei?: bigint
  burnAddress?: string
  /** The Monad network the relay runs on (default Monad testnet). The regtest stack passes
   * `monad-regtest` / `MONR`. */
  network?: {
    rpcChain: string
    networkTag: 'MONT' | 'MON1' | 'MONR'
    /** Addresses of contracts deployed for this run (a regtest chain has no committed record). */
    contracts?: { stateChannel?: string; htlc?: string }
  }
}): Promise<RealWallet> {
  const network = params.network ?? { rpcChain: 'monad-testnet', networkTag: 'MONT' as const }
  const identity = monadProtocolIdentity(network.rpcChain)
  if (!identity || identity.networkTag !== network.networkTag) {
    throw new Error(`${network.rpcChain} / ${network.networkTag} is not a Monad network the wallet knows`)
  }
  const dir = join(params.stateDir, 'wallets', params.label)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The account root is kept (0600) so the money in the account can be recovered after a crash.
  const rootFile = join(dir, 'account-root.hex')
  const reused = existsSync(rootFile)
  if (!reused) writeFileSync(rootFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  const accountRoot = Uint8Array.from(Buffer.from(readFileSync(rootFile, 'utf8').trim(), 'hex'))
  const roots = {
    evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
    authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
    messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
  }
  accountRoot.fill(0)
  const startedAt = Date.now()
  const chain = createRelayPricedEvmChain({
    ...loadMonadChainConfigFromEnv({ isTestnet: true }),
    networkId: network.rpcChain,
    rpcChain: network.rpcChain,
    chainId: identity.chainId,
    relayBaseUrl: params.relayUrl,
    networkTag: network.networkTag,
    ...(network.contracts ? { contracts: network.contracts } : {}),
    stampBurnAddress: params.burnAddress ?? DEMO_DEFAULT_BURN_ADDRESS,
    walletStorageLocation: join(dir, 'chain-storage'),
    subAccountPoolSize: 1,
  })
  const handle = (await chain.createWallet(roots)) as EvmChainWalletHandle
  const directory = DirectoryManager.create({
    handle,
    networkTag: network.networkTag,
    relayBaseUrl: params.relayUrl,
    location: join(dir, 'directory'),
  })
  await directory.publishWithRetry(params.label)
  installCanonicalDirectory(handle, directory.rawDirectory)
  installMessageItemRegistry(handle, createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable))
  await RelayProfileManager.registerProfile({
    relayBaseUrl: params.relayUrl,
    identity: handle.identity,
    label: params.label,
    profile: { name: params.label, bot: false },
    statementNetwork: network.rpcChain,
  })
  return {
    label: params.label,
    reused,
    address: handle.identity.address.raw,
    mainAccount: (await handle.getReceiveAddress()).raw,
    handle,
    chain,
    directory: directory.rawDirectory,
    async send(to, items, stampValueWei, timeoutMs = 180_000) {
      let digest: string | undefined
      try {
        const sent: DirectMessageSendResult = await chain.directMessages.send({
          wallet: handle,
          recipient: { raw: to },
          items,
          stampValue: stampValueWei ?? params.stampValueWei,
          onAttemptCreated: created => {
            digest = created
          },
        })
        return sent.payloadDigest
      } catch (err) {
        // No attempt was created: nothing to reconcile, the send simply failed.
        if (digest === undefined) throw err
      }
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const status = (await chain.directMessages.reconcileAttempts({ wallet: handle, payloadDigests: [digest] }))[digest]
        if (status === 'delivered') return digest
        if (status === 'dead') throw new Error(`the relay ended ${params.label}'s message ${digest}; it will never be delivered`)
        if (Date.now() > deadline) {
          throw new Error(`${params.label}'s message ${digest} was accepted but not delivered within ${timeoutMs}ms (status ${status})`)
        }
        await sleep(3000)
      }
    },
    async receive(match, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const messages = await chain.directMessages.fetchSince({ wallet: handle, sinceMs: startedAt })
        const found = messages.find(m => !m.outbound && match(m))
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(
            `${params.label} received no matching message within ${timeoutMs}ms (saw ${messages.filter(m => !m.outbound).length} inbound)`,
          )
        }
        await sleep(2000)
      }
    },
    async close() {
      await directory.close()
      await handle.close()
    },
  }
}

/** What a sweep returned and what it could not. */
export interface SweepOutcome {
  returnedWei: bigint
  /** What the persistent accounts keep on purpose (TEST_ACCOUNT_FLOAT_WEI each, at most). */
  floatWei: bigint
  /** Accounts that still hold something, each with the reason it was not moved. */
  left: { wallet: string; account: string; address: string; balanceWei: bigint; reason: string }[]
}

/** One line per account a sweep left money in, for a script's output. */
/** The one line a run that funded anything ends with: funded X, returned Y, left Z where (why). */
export function fundsLine(params: { fundedWei: bigint; outcome: SweepOutcome; to: string; where: string }): string {
  const { outcome } = params
  const stuck = outcome.left.reduce((sum, l) => sum + l.balanceWei, 0n)
  const reasons = new Map<string, number>()
  for (const l of outcome.left) {
    const reason = l.reason.split(':')[0]
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const why = [
    ...(outcome.floatWei > 0n ? [`${formatEther(outcome.floatWei)} is the float the persistent accounts keep for the next run`] : []),
    ...[...reasons].map(([reason, count]) => `${count} account${count === 1 ? '' : 's'}: ${reason}`),
  ]
  const leftWei = outcome.floatWei + stuck
  return `funded ${formatEther(params.fundedWei)} MON, returned ${formatEther(outcome.returnedWei)} MON to ${params.to || '(no test wallet configured)'}, left ${formatEther(leftWei)} MON in ${params.where}${why.length ? ` (${why.join('; ')})` : ''}`
}

export interface RealStack {
  relayUrl: string
  rpcUrl: string
  stateDir: string
  provider: JsonRpcProvider
  /** Address of the test wallet `fund` spends from ('' when FRANK_TEST_WALLET_JSON is unset). */
  fundingAddress: string
  /** `keepIdentityFunds`: the sweep leaves this wallet's identity account alone (the smoke's
   * test user: the faucet's one grant per profile sits there and is what the smoke checks). */
  openWallet(label: string, options?: { stampValueWei?: bigint; keepIdentityFunds?: boolean }): Promise<RealWallet>
  /** Sends from the test wallet; refuses above the per-call limit unless `maxWei` raises it. */
  fund(to: string, valueWei: bigint, options?: { maxWei?: bigint }): Promise<string>
  /** Sends what the opened wallets' main and identity accounts and their spent sender accounts
   * hold back to the test wallet, where it is worth the fee, and says what it left and why.
   * Every script that funds a wallet calls this in a `finally`, before `stop`. */
  sweep(): Promise<SweepOutcome>
  /** What every script ends with, in a `finally`: sweeps, prints the one funds line (funded,
   * returned, left where and why), then stops. Safe to call more than once. A stack that started
   * its own relay also does this on Ctrl-C, SIGTERM and SIGHUP before the process ends. */
  finish(): Promise<void>
  /** Closes the wallets and stops the relay (if this started one). Safe to call more than once. */
  stop(): Promise<void>
}

/** Relay + chain + test wallet, ready for wallets. `relayUrl` uses a relay that is already
 * running (for example the demo's) instead of starting one. */
export async function startRealStack(options: {
  env?: Record<string, string | undefined>
  relayUrl?: string
  relayPort?: number
  stateDir?: string
} = {}): Promise<RealStack> {
  const env = options.env ?? realStackEnv()
  const rpcUrl = env.MONAD_TESTNET_HTTP_RPC_URL
  if (!rpcUrl) throw new Error('MONAD_TESTNET_HTTP_RPC_URL is required (environment or .env)')
  const id = await chainId(rpcUrl)
  if (id !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error(`MONAD_TESTNET_HTTP_RPC_URL answers chain id ${id}, not Monad testnet (${MONAD_TESTNET_CHAIN_ID})`)
  }
  // The test wallet only. The demo's funding wallet is never used here: see the header.
  const walletJsonPath = env.FRANK_TEST_WALLET_JSON ? resolve(REPO_ROOT, env.FRANK_TEST_WALLET_JSON) : undefined
  const fundingAddress = walletJsonPath
    ? (JSON.parse(readFileSync(walletJsonPath, 'utf8')) as { address: string }).address
    : ''
  const maxFundWei = env.FRANK_TEST_MAX_FUND_WEI ? BigInt(env.FRANK_TEST_MAX_FUND_WEI) : DEFAULT_MAX_FUND_WEI
  const baseDir = options.stateDir ?? env.FRANK_REAL_STACK_DIR ?? join(homedir(), '.frank-real-stack')
  const port = options.relayPort ?? (env.FRANK_REAL_STACK_RELAY_PORT ? Number(env.FRANK_REAL_STACK_RELAY_PORT) : DEFAULT_RELAY_PORT)
  const relayUrlWanted = options.relayUrl ?? `http://127.0.0.1:${port}`
  // An account's directory entry lives on one relay, so state is kept per relay.
  const stateDir = join(baseDir, relayUrlWanted.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_'))
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const relay = options.relayUrl ? undefined : await startRealRelay({ env, port, stateDir })
  const relayUrl = relayUrlWanted
  const provider = new JsonRpcProvider(rpcUrlList(rpcUrl)[0], MONAD_TESTNET_CHAIN_ID, { staticNetwork: true })
  const wallets: RealWallet[] = []
  const keepIdentity = new Set<RealWallet>()
  let stopped: Promise<void> | undefined

  /** Returns one account's balance to the test wallet. `left` says why when it does not. */
  const sweepKey = async (
    privateKey: string,
    keepWei = 0n,
  ): Promise<{ address: string; returnedWei: bigint; balanceWei: bigint; keptWei: bigint; left?: string }> => {
    const moved = await sweepAbove(privateKey, keepWei)
    const kept = moved.balanceWei < keepWei ? moved.balanceWei : keepWei
    // What stays as the float is not a failure to return.
    return { ...moved, balanceWei: moved.balanceWei - kept, keptWei: kept, left: moved.balanceWei - kept > 0n ? moved.left : undefined }
  }
  /** `balanceWei` in the answer is what the account still holds afterwards. */
  const sweepAbove = async (privateKey: string, keepWei: bigint): Promise<{ address: string; returnedWei: bigint; balanceWei: bigint; left?: string }> => {
    const signer = new Wallet(privateKey, provider)
    const held = await provider.getBalance(signer.address)
    if (held <= keepWei) return { address: signer.address, returnedWei: 0n, balanceWei: held }
    const balance = held - keepWei
    // A plain transfer at the node's gas price costs exactly 21000 x that price. Not worth
    // sending unless it returns at least as much as it costs.
    const gasPrice = BigInt(await provider.send('eth_gasPrice', []))
    const cost = gasPrice * 21_000n
    if (balance < cost * 2n) {
      return { address: signer.address, returnedWei: 0n, balanceWei: held, left: `dust: under twice the transfer fee of ${formatEther(cost)} MON` }
    }
    try {
      const tx = await signer.sendTransaction({
        type: 0,
        to: fundingAddress,
        value: balance - cost,
        gasLimit: 21_000n,
        gasPrice,
      })
      const receipt = await tx.wait(1, 120_000)
      if (receipt?.status !== 1) return { address: signer.address, returnedWei: 0n, balanceWei: held, left: `transfer reverted: ${tx.hash}` }
      return { address: signer.address, returnedWei: balance - cost, balanceWei: keepWei }
    } catch (err) {
      return {
        address: signer.address,
        returnedWei: 0n,
        balanceWei: held,
        left: `the transfer failed: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : 'error'}`,
      }
    }
  }
  let fundedWei = 0n
  let finished: Promise<void> | undefined
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`[real-stack] ${signal}: returning test funds before stopping`)
    void stack
      .finish()
      .catch(() => undefined)
      .then(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  }
  // With a relay of its own this is the whole run, so it owns the signals. On somebody else's
  // relay (the demo's) the launcher owns them and the script's `finally` calls `finish`.
  if (relay) for (const signal of signals) process.on(signal, onSignal)

  const stack: RealStack = {
    relayUrl,
    rpcUrl,
    stateDir,
    provider,
    fundingAddress,
    async openWallet(label, walletOptions) {
      const wallet = await openRealWallet({
        label,
        relayUrl,
        stateDir,
        stampValueWei: walletOptions?.stampValueWei,
        burnAddress: env.MONAD_STAMP_BURN_ADDRESS,
      })
      // Opening a label again (after the caller closed it) replaces the earlier handle.
      const earlier = wallets.findIndex(opened => opened.label === label)
      if (earlier >= 0) wallets.splice(earlier, 1)
      wallets.push(wallet)
      if (walletOptions?.keepIdentityFunds) keepIdentity.add(wallet)
      return wallet
    },
    async fund(to, valueWei, fundOptions) {
      if (!walletJsonPath) {
        throw new Error(
          'FRANK_TEST_WALLET_JSON is required to fund a wallet: a funded testnet wallet used only by tests (never E2E_DEMO_MAIN_WALLET_JSON, which belongs to the demo\'s bot host)',
        )
      }
      const { txHash } = await fundFromWallet({ rpcUrl, walletJsonPath, to, valueWei, maxWei: fundOptions?.maxWei ?? maxFundWei })
      fundedWei += valueWei
      return txHash
    },
    async sweep() {
      const outcome: SweepOutcome = { returnedWei: 0n, floatWei: 0n, left: [] }
      if (!fundingAddress) return outcome
      // On Monad a transfer that empties a small account within a few blocks of that account's
      // last transaction reverts: let the run's last payments settle first.
      await sleep(2500)
      for (const wallet of wallets) {
        // A wallet pays each message from a single-use sender account funded with the stamp
        // plus a fee reserve; what the fee did not use stays behind in the spent account. That
        // is most of what a run leaves, so spent (never reused) sender accounts are returned
        // too. Accounts still funded for a coming message are the wallet's and stay.
        const pool = wallet.handle.pool as unknown as
          | {
              records(): { index: number; status: string }[]
              keyring: { deriveSubAccount(index: number): { privateKey: string } }
            }
          | undefined
        const spent = (pool?.records() ?? [])
          .filter(record => record.status === 'spent' || record.status === 'retired')
          .map(record => ({ account: `spent sender ${record.index}`, key: pool!.keyring.deriveSubAccount(record.index).privateKey }))
        const accounts = [
          { account: 'main account', key: wallet.handle.mainPrivateKey },
          ...(keepIdentity.has(wallet) ? [] : [{ account: 'identity account', key: wallet.handle.identity.toPrivateKeyHex() }]),
          ...spent,
        ]
        for (const { account, key } of accounts) {
          if (!key) continue
          // The main account is the persistent one: it keeps the float, nothing else does.
          const moved = await sweepKey(key, account === 'main account' ? TEST_ACCOUNT_FLOAT_WEI : 0n)
          outcome.returnedWei += moved.returnedWei
          outcome.floatWei += moved.keptWei
          if (moved.left) outcome.left.push({ wallet: wallet.label, account, address: moved.address, balanceWei: moved.balanceWei, reason: moved.left })
        }
      }
      return outcome
    },
    stop: () =>
      (stopped ??= (async () => {
        for (const wallet of wallets) await wallet.close().catch(() => undefined)
        provider.destroy()
        await relay?.stop()
        for (const signal of signals) process.off(signal, onSignal)
      })()),
    finish: () =>
      (finished ??= (async () => {
        let line: string
        try {
          line = fundsLine({ fundedWei, outcome: await stack.sweep(), to: fundingAddress, where: stateDir })
        } catch (err) {
          line = `funded ${formatEther(fundedWei)} MON, returned NOTHING (${err instanceof Error ? err.message.split('\n')[0] : 'error'}); it is still in the accounts under ${stateDir}`
        }
        console.log(`[funds] ${line}`)
        await stack.stop()
      })()),
  }
  return stack
}
