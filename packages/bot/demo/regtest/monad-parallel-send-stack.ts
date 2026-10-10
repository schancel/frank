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
import { openRealWallet, type RealWallet } from '../real-stack'
import { MONAD_REGTEST_CHAIN, MONAD_REGTEST_CHAIN_ID, MONAD_REGTEST_NETWORK_TAG, ensureSolonet } from './monad-regtest'
import { monadOf, openMonadWallet } from './monad-wallets'
import { freePort } from './regtest-chain'
import { startRegtestStack } from './regtest-stack'

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
  const { rpcUrl } = await ensureSolonet({ ...process.env, FRANK_SOLONET_RPC_URL: undefined })
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
  const stack = await startRegtestStack({
    chains: ['monad-regtest'],
    // The relay's upstream and the faucet go through the gate.
    env: { ...process.env, FRANK_SOLONET_RPC_URL: gate.url, FRANK_REGTEST_KEEP: process.env.FRANK_REGTEST_KEEP },
  })
  const monad = monadOf(stack)
  // The faucet pays straight to the chain, not through the gate (whose connections are cut
  // when a check closes it), one payment at a time.
  const faucet = monad.faucet.connect(provider)
  let paying: Promise<unknown> = Promise.resolve()
  // The node's count can lag a block behind a payment just mined: never reuse a nonce.
  let lastNonce = -1
  const fund = (to: string, valueWei: bigint): Promise<string> => {
    const next = paying.then(async () => {
      const nonce = Math.max(await provider.getTransactionCount(faucet.address, 'pending'), lastNonce + 1)
      lastNonce = nonce
      const tx = await faucet.sendTransaction({ to, value: valueWei, nonce, gasLimit: 21_000n })
      for (const deadline = Date.now() + 120_000; ; ) {
        const receipt = await provider.getTransactionReceipt(tx.hash)
        if (receipt) {
          if (receipt.status !== 1) throw new Error(`faucet payment ${tx.hash} did not succeed`)
          return tx.hash
        }
        if (Date.now() > deadline) throw new Error(`faucet payment ${tx.hash} was not mined in time`)
        await new Promise(resolveWait => setTimeout(resolveWait, 150))
      }
    })
    paying = next.catch(() => undefined)
    return next
  }
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      for (const wallet of wallets) await wallet.close().catch(() => undefined)
      provider.destroy()
      await gate.up().catch(() => undefined)
      await stack.stop()
      await gate.down()
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
    // Faucet money on a chain that is thrown away: nothing to return.
    sweep: async () => none,
    finish: async () => {
      console.log('[funds] local Monad chain: funded from its faucet, nothing to return')
      await stop()
    },
    stop,
    chainOutage: { down: gate.down, up: gate.up },
  }
}
