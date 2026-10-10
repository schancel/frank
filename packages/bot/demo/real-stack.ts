/**
 * The real test harness: the real relay binary against the real chain (Monad testnet), real
 * wallets, real transfers. Nothing here simulates a chain or a relay.
 *
 *   const stack = await startRealStack()                  // relay on a free port, testnet RPC from .env
 *   const alice = await stack.openWallet('alice')         // fresh account, directory entry published
 *   await stack.fund(alice.mainAccount, 20_000_000_000_000_000n)   // from the funding wallet, confirmed
 *   const digest = await alice.send(bob.address, [{ type: 'text', text: 'hi' }], 1_000_000_000_000n)
 *   const got = await bob.receive(m => m.payloadDigest === digest)
 *   await stack.stop()                                    // sweeps what is left back, stops the relay
 *
 * Configuration comes from the process environment, then the repo's `.env`:
 *   MONAD_TESTNET_HTTP_RPC_URL   required (may be a comma-separated list)
 *   FRANK_TEST_WALLET_JSON       {"address","privateKey"} of a funded testnet wallet that `fund`
 *                                spends from. Use it whenever a demo is running: the demo's bot
 *                                host is the only user of E2E_DEMO_MAIN_WALLET_JSON and counts its
 *                                nonces in memory, so a transfer sent from that wallet by anyone
 *                                else makes the host's next payment fail.
 *   E2E_DEMO_MAIN_WALLET_JSON    what `fund` spends from when FRANK_TEST_WALLET_JSON is unset
 *                                (fine while no demo is running)
 *   CASHWEBD_BIN                 a prebuilt relay; otherwise this worktree's Cargo build is used
 *   FRANK_REAL_STACK_RELAY_PORT  relay port (default: a free port)
 *   FRANK_REAL_STACK_DIR         where state and logs go (default: a new temp directory)
 *
 * It spends real testnet funds: only what `fund` is asked for plus gas. Funding transfers from
 * the one funding wallet are serialised across processes by a lock file beside the wallet file,
 * each with the next pending nonce and waited for, so parallel test runs cannot collide.
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

import { JsonRpcProvider, Wallet, formatEther } from 'ethers'

import { DirectoryManager } from '@frank/bot-framework/directory-manager'
import { RelayProfileManager } from '@frank/bot-framework/relay-profile-manager'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { deriveDomainRoot } from '@frank/domain-roots'
import type { ActiveChain, DirectMessageReceived, DirectMessageSendResult } from '@frank/wallet/chain/active-chain'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import { createEvmChain, installCanonicalDirectory, loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'

import { chainId, rpcUrlList } from './chain-rpc'
import { DEMO_DEFAULT_BURN_ADDRESS } from './demo-config'
import { readEnvFile } from './env-file'
import { Supervisor } from './supervisor'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const RELAY_SCRIPT = join(REPO_ROOT, 'backend', 'cashweb', 'run-local-monad.sh')
const MONAD_TESTNET_CHAIN_ID = 10143n
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

export interface RealRelay {
  url: string
  logPath: string
  stop(): Promise<void>
}

/** Starts the real relay binary through the documented launcher and waits until it answers. The
 * relay itself checks its upstream's chain id and genesis block against the chain registry. */
export async function startRealRelay(options: {
  env?: Record<string, string | undefined>
  port?: number
  stateDir: string
  timeoutS?: number
}): Promise<RealRelay> {
  const env = options.env ?? realStackEnv()
  const rpcUrl = env.MONAD_TESTNET_HTTP_RPC_URL
  if (!rpcUrl) throw new Error('MONAD_TESTNET_HTTP_RPC_URL is required (environment or .env)')
  const port = options.port ?? (env.FRANK_REAL_STACK_RELAY_PORT ? Number(env.FRANK_REAL_STACK_RELAY_PORT) : await freePort())
  const url = `http://127.0.0.1:${port}`
  const logPath = join(options.stateDir, 'logs', 'relay.log')
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
  const deadline = Date.now() + (options.timeoutS ?? 1800) * 1000
  for (;;) {
    try {
      if ((await fetch(`${url}/relay/v1/info`)).ok) break
    } catch {
      /* not up yet */
    }
    if (relay.hasExited() || Date.now() > deadline) {
      await stop()
      throw new Error(
        `the relay ${relay.hasExited() ? 'exited during startup' : 'did not answer in time'}; see ${logPath}`,
      )
    }
    await sleep(500)
  }
  return { url, logPath, stop }
}

/** Sends `valueWei` from the funding wallet to `to` and waits for it to confirm. One transfer at
 * a time across every process using the same wallet file (a lock directory beside it). */
export async function fundFromWallet(params: {
  rpcUrl: string
  walletJsonPath: string
  to: string
  valueWei: bigint
}): Promise<{ txHash: string; from: string }> {
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
        `the funding wallet ${wallet.address} holds ${formatEther(balance)} MON, not enough to send ${formatEther(params.valueWei)} MON`,
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
  /** The address other accounts message. */
  address: string
  /** The account that holds this wallet's money and pays its stamps. */
  mainAccount: string
  handle: EvmChainWalletHandle
  chain: ActiveChain
  /** Sends and waits until the relay has delivered it. The relay may first answer "accepted,
   * payment not confirmed yet"; the same attempt is then reconciled (never sent again) until it is
   * delivered, as the app and the bot host do. Returns the message's payload digest. */
  send(to: string, items: MessageItem[], stampValueWei?: bigint, timeoutMs?: number): Promise<string>
  /** Polls this wallet's mailbox until an inbound message matches, and returns it. */
  receive(match: (message: DirectMessageReceived) => boolean, timeoutMs?: number): Promise<DirectMessageReceived>
  close(): Promise<void>
}

/** A fresh account on the real relay: new keys, a published directory entry and a profile, the
 * same steps the app and the bot host take. It holds no money until it is funded. */
export async function openRealWallet(params: {
  label: string
  relayUrl: string
  stateDir: string
  stampValueWei?: bigint
  burnAddress?: string
}): Promise<RealWallet> {
  const dir = join(params.stateDir, 'wallets', params.label)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The account root is kept (0600) so the money in the account can be recovered after a crash.
  const rootFile = join(dir, 'account-root.hex')
  if (!existsSync(rootFile)) writeFileSync(rootFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  const accountRoot = Uint8Array.from(Buffer.from(readFileSync(rootFile, 'utf8').trim(), 'hex'))
  const roots = {
    evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
    authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
    messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
  }
  accountRoot.fill(0)
  const startedAt = Date.now()
  const chain = createEvmChain({
    ...loadMonadChainConfigFromEnv({ isTestnet: true }),
    relayBaseUrl: params.relayUrl,
    networkTag: 'MONT',
    stampBurnAddress: params.burnAddress ?? DEMO_DEFAULT_BURN_ADDRESS,
    walletStorageLocation: join(dir, 'chain-storage'),
    subAccountPoolSize: 1,
    ...(params.stampValueWei ? { defaultStampValueWei: params.stampValueWei } : {}),
  })
  const handle = (await chain.createWallet(roots)) as EvmChainWalletHandle
  const directory = DirectoryManager.create({
    handle,
    networkTag: 'MONT',
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
  })
  return {
    label: params.label,
    address: handle.identity.address.raw,
    mainAccount: (await handle.getReceiveAddress()).raw,
    handle,
    chain,
    async send(to, items, stampValueWei, timeoutMs = 180_000) {
      let digest: string | undefined
      try {
        const sent: DirectMessageSendResult = await chain.directMessages.send({
          wallet: handle,
          recipient: { raw: to },
          items,
          stampValue: stampValueWei,
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

export interface RealStack {
  relayUrl: string
  rpcUrl: string
  stateDir: string
  provider: JsonRpcProvider
  /** Address of the funding wallet. */
  fundingAddress: string
  openWallet(label: string, options?: { stampValueWei?: bigint }): Promise<RealWallet>
  fund(to: string, valueWei: bigint): Promise<string>
  /** Closes the wallets, sends what their main accounts still hold back to the funding wallet,
   * and stops the relay. Safe to call more than once. */
  stop(): Promise<void>
}

/** Relay + chain + funding wallet, ready for wallets. `relayUrl` uses a relay that is already
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
  const walletJson = env.FRANK_TEST_WALLET_JSON || env.E2E_DEMO_MAIN_WALLET_JSON
  const walletJsonPath = walletJson ? resolve(REPO_ROOT, walletJson) : undefined
  const fundingAddress = walletJsonPath
    ? (JSON.parse(readFileSync(walletJsonPath, 'utf8')) as { address: string }).address
    : ''
  const stateDir = options.stateDir ?? env.FRANK_REAL_STACK_DIR ?? mkdtempSync(join(tmpdir(), 'frank-real-stack-'))
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const relay = options.relayUrl
    ? undefined
    : await startRealRelay({ env, port: options.relayPort, stateDir })
  const relayUrl = options.relayUrl ?? (relay as RealRelay).url
  const provider = new JsonRpcProvider(rpcUrlList(rpcUrl)[0], MONAD_TESTNET_CHAIN_ID, { staticNetwork: true })
  const wallets: RealWallet[] = []
  let stopped: Promise<void> | undefined

  const sweep = async (wallet: RealWallet) => {
    if (!fundingAddress) return
    const key = wallet.handle.mainPrivateKey
    if (!key) return
    const signer = new Wallet(key, provider)
    const balance = await provider.getBalance(signer.address)
    // A plain transfer at the node's gas price costs exactly 21000 x that price.
    const gasPrice = BigInt(await provider.send('eth_gasPrice', []))
    const cost = gasPrice * 21_000n
    if (balance <= cost) return
    const tx = await signer.sendTransaction({
      type: 0,
      to: fundingAddress,
      value: balance - cost,
      gasLimit: 21_000n,
      gasPrice,
    })
    await tx.wait(1, 120_000)
  }

  return {
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
      wallets.push(wallet)
      return wallet
    },
    async fund(to, valueWei) {
      if (!walletJsonPath) throw new Error('FRANK_TEST_WALLET_JSON (or E2E_DEMO_MAIN_WALLET_JSON) is required to fund a wallet')
      return (await fundFromWallet({ rpcUrl, walletJsonPath, to, valueWei })).txHash
    },
    stop: () =>
      (stopped ??= (async () => {
        for (const wallet of wallets) {
          await sweep(wallet).catch(err =>
            console.error(
              `[real-stack] could not return ${wallet.label}'s funds (its key is in ${join(stateDir, 'wallets', wallet.label)}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          )
          await wallet.close().catch(() => undefined)
        }
        provider.destroy()
        await relay?.stop()
      })()),
  }
}
