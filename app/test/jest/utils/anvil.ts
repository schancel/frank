/**
 * A local dev node of a real EVM client (`anvil`) for a test file.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. `findAnvil()` returns undefined without one; a suite then
 * decides with `nodeSuiteReady` (@frank/wallet/node-binaries.testutil).
 */
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { JsonRpcProvider, Wallet } from 'ethers'

export const ANVIL_DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

export { findAnvil } from '@frank/wallet/node-binaries.testutil'

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

export interface AnvilNode {
  provider: JsonRpcProvider
  /** A funded dev account. */
  dev: Wallet
  /** Mines `blocks` empty blocks. */
  mine(blocks?: number): Promise<void>
  /** Moves the chain clock forward and mines a block. */
  advanceTime(seconds: number): Promise<void>
  stop(): void
}

export async function startAnvil(
  bin: string,
  chainId = 10143,
): Promise<AnvilNode> {
  const port = await freePort()
  const node: ChildProcess = spawn(
    bin,
    ['--port', String(port), '--chain-id', String(chainId)],
    { stdio: 'ignore' },
  )
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  for (let i = 0; ; i++) {
    try {
      await provider.getBlockNumber()
      break
    } catch (error) {
      if (i > 100) {
        node.kill()
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  return {
    provider,
    dev: new Wallet(ANVIL_DEV_KEY, provider),
    async mine(blocks = 1) {
      await provider.send('anvil_mine', [`0x${blocks.toString(16)}`])
    },
    async advanceTime(seconds: number) {
      await provider.send('evm_increaseTime', [seconds])
      await provider.send('evm_mine', [])
    },
    stop() {
      provider.destroy()
      node.kill()
    },
  }
}
