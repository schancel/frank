/**
 * The local Monad chain (monad-solonet) as a stack for `parallel-send.livecheck.ts`:
 *
 *   yarn --cwd packages/bot regtest:monad-start      # once; the chain is reused
 *   yarn --cwd packages/bot regtest:monad-parallel-send   # PHASES=a,d,e,h,r,b by default
 *
 * The real relay binary on the real Monad client; funds come from the solonet's faucet and cost
 * nothing. The relay and the faucet reach the chain through a plain TCP relay in this process,
 * so that the check can make the chain unreachable (`chainOutage`: the port is closed, every
 * connection through it is cut) and reachable again. What the check asserts is read from the
 * chain directly, never through that port.
 */
import { createServer, connect, type Server, type Socket } from 'net'

import { FetchRequest, JsonRpcProvider } from 'ethers'

import type { CheckStack } from '../../parallel-send.livecheck'
import { fundsLine, openRealWallet, type RealWallet, type SweepOutcome } from '../real-stack'
import { MONAD_REGTEST_CHAIN, MONAD_REGTEST_CHAIN_ID, MONAD_REGTEST_NETWORK_TAG, ensureSolonet, payAtFreshNonce } from './monad-regtest'
import { monadOf, openMonadWallet, returnToFaucet } from './monad-wallets'
import { freePort } from './regtest-chain'
import { startRegtestStack, type RegtestStack } from './regtest-stack'

/** A TCP relay to `target` that can be switched off (connection refused, live ones cut) and on. */
async function switchablePort(target: { host: string; port: number }) {
  const port = await freePort()
  const open = new Set<Socket>()
  let server: Server | undefined
  const up = () =>
    new Promise<void>((resolveUp, reject) => {
      if (server) return resolveUp()
      server = createServer(client => {
        const upstream = connect(target.port, target.host)
        for (const socket of [client, upstream]) {
          open.add(socket)
          socket.on('close', () => open.delete(socket))
          socket.on('error', () => socket.destroy())
        }
        client.pipe(upstream)
        upstream.pipe(client)
        client.on('close', () => upstream.destroy())
        upstream.on('close', () => client.destroy())
      })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolveUp())
    })
  const down = () =>
    new Promise<void>(resolveDown => {
      const closing = server
      server = undefined
      for (const socket of open) socket.destroy()
      if (!closing) return resolveDown()
      closing.close(() => resolveDown())
    })
  await up()
  return { url: `http://127.0.0.1:${port}`, up, down }
}

export async function startCheckStack(options: { relayUrl?: string } = {}): Promise<CheckStack> {
  const { rpcUrl } = await ensureSolonet(process.env)
  // Reads for the check's own assertions: straight to the chain.
  // The solonet's port is forwarded from a VM, and that forward now and then drops a connection
  // in the middle of an answer ("socket hang up"): such a request is made again.
  const connection = new FetchRequest(rpcUrl)
  const getUrl = FetchRequest.createGetUrlFunc()
  connection.getUrlFunc = async (request, signal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getUrl(request, signal)
      } catch (error) {
        if (attempt >= 3) throw error
        await new Promise(resolveWait => setTimeout(resolveWait, 150))
      }
    }
  }
  const provider = new JsonRpcProvider(connection, MONAD_REGTEST_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  const wallets: RealWallet[] = []
  const track = (wallet: RealWallet) => {
    const earlier = wallets.findIndex(opened => opened.label === wallet.label)
    if (earlier >= 0) wallets.splice(earlier, 1)
    wallets.push(wallet)
    return wallet
  }
  const none = { returnedWei: 0n, floatWei: 0n, left: [] }

  if (options.relayUrl) {
    // Another process of the same run (the one that is killed): the relay is already up and the
    // wallets' state is the run's.
    const stateDir = process.env.PSEND_STATE_DIR
    if (!stateDir) throw new Error('PSEND_STATE_DIR is required with a relay that is already running')
    const stop = async () => {
      for (const wallet of wallets) await wallet.close().catch(() => undefined)
      provider.destroy()
    }
    return {
      relayUrl: options.relayUrl,
      rpcUrl,
      stateDir,
      provider,
      fundingAddress: '',
      openWallet: async (label, walletOptions) =>
        track(
          await openRealWallet({
            label,
            relayUrl: options.relayUrl!,
            stateDir,
            stampValueWei: walletOptions?.stampValueWei,
            network: { rpcChain: MONAD_REGTEST_CHAIN, networkTag: MONAD_REGTEST_NETWORK_TAG },
          }),
        ),
      fund: async () => {
        throw new Error('this process does not fund')
      },
      sweep: async () => none,
      finish: stop,
      stop,
    }
  }

  const target = new URL(rpcUrl)
  const gate = await switchablePort({ host: target.hostname, port: Number(target.port) })
  let stack: RegtestStack
  try {
    stack = await startRegtestStack({
      chains: ['monad-regtest'],
      // The relay's upstream reaches the chain through the switchable gate.
      env: { ...process.env, FRANK_SOLONET_RPC_URL: gate.url, FRANK_REGTEST_KEEP: '1' },
    })
  } catch (error) {
    provider.destroy()
    await gate.down()
    throw error
  }
  const monad = monadOf(stack)
  // The faucet pays straight to the chain, not through the gate (whose connections are cut
  // when a check closes it), one payment at a time.
  const faucet = monad.faucet.connect(provider)
  let paying: Promise<unknown> = Promise.resolve()
  let fundedWei = 0n
  let unresolvedFunding = false
  const fund = (to: string, valueWei: bigint): Promise<string> => {
    const next = paying.then(async () => {
      if (unresolvedFunding) throw new Error('original setup funding is unresolved; no new funding authorized')
      try {
        const hash = await payAtFreshNonce(faucet, { to, value: valueWei, gasLimit: 21_000n })
        fundedWei += valueWei
        return hash
      } catch (error) {
        unresolvedFunding = true
        throw error
      }
    })
    paying = next.catch(() => undefined)
    return next
  }
  let closed: Promise<void> | undefined
  const closeWallets = () => (closed ??= (async () => {
    const results = await Promise.allSettled(wallets.map(wallet => wallet.close()))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  })())
  let swept: Promise<SweepOutcome> | undefined
  const sweep = () => (swept ??= (async () => {
    await paying
    await gate.up()
    await closeWallets()
    const result = await returnToFaucet(stack)
    if (result.unswept !== 0 || unresolvedFunding)
      throw new Error(`original setup remains unresolved: ${result.unswept} return checks failed; state retained at ${stack.stateDir}`)
    return { returnedWei: result.returnedWei, floatWei: 0n, left: result.left }
  })())
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      try { await closeWallets() }
      finally {
        try { await stack.stop() }
        finally { provider.destroy(); await gate.down() }
      }
    })())
  let finished: Promise<void> | undefined
  const finish = () => (finished ??= (async () => {
    try {
      const outcome = await sweep()
      console.log(fundsLine({ fundedWei, outcome, to: monad.faucetAddress, where: stack.stateDir }))
    } finally { await stop() }
  })())
  return {
    relayUrl: stack.relayUrl,
    rpcUrl,
    stateDir: stack.stateDir,
    provider,
    fundingAddress: monad.faucetAddress,
    openWallet: async (label, walletOptions) =>
      track(await openMonadWallet(stack, label, { stampValueWei: walletOptions?.stampValueWei })),
    fund,
    sweep,
    finish,
    stop,
    chainOutage: { down: gate.down, up: gate.up },
  }
}
