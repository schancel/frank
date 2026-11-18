/**
 * A local dev node of a real EVM client (`anvil`) for a test file.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. `findAnvil()` returns undefined without one, and a suite
 * should then report itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Wallet } from 'ethers'

export const ANVIL_DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

export function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json')),
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(
      root,
      `anvil-${process.platform}-${arch}`,
      'bin',
      'anvil',
    )
    if (existsSync(packaged)) return packaged
  } catch {
    // Not installed as a package.
  }
  return spawnSync('anvil', ['--version']).status === 0 ? 'anvil' : undefined
}

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
