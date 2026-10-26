/**
 * INTEGRATION: dating sent transactions by their blocks on a real EVM node (`anvil`).
 *
 * Real: anvil, ethers' JSON-RPC provider talking to it. Every request the provider puts on the
 * wire is recorded, and each must be one the relay's RPC proxy serves
 * (backend/cashweb/cashweb-registry/src/http/evm_rpc.rs `validate_call`): it answers
 * `eth_getBlockByHash` with 403 `rpc_method_denied`, which fails the whole batch it was in.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Wallet } from 'ethers'
import { readEvmBlockTimes } from './evm-block-times'

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json')),
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(root, `anvil-${process.platform}-${arch}`, 'bin', 'anvil')
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
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** The calls the relay serves, and how (see `validate_call`). */
function relayServes(call: { method: string; params: unknown[] }): boolean {
  if (call.method === 'eth_getBlockByNumber') return call.params[1] === false
  return [
    'eth_chainId',
    'eth_blockNumber',
    'eth_getBalance',
    'eth_getCode',
    'eth_getTransactionCount',
    'eth_gasPrice',
    'eth_maxPriorityFeePerGas',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
  ].includes(call.method)
}

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn('NOT RUN: evm-block-times.anvil needs an anvil binary (set ANVIL_BIN).')
const suite = anvilBin ? describe : describe.skip

suite('block times of sent transactions (anvil)', () => {
  jest.setTimeout(60_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  const requests: { method: string; params: unknown[] }[] = []

  beforeAll(async () => {
    const port = await freePort()
    node = spawn(anvilBin!, ['--port', String(port), '--chain-id', '10143'], {
      stdio: 'ignore',
    })
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
    void chain.on('debug', (event: { action: string; payload?: unknown }) => {
      if (event.action !== 'sendRpcPayload') return
      const payload = event.payload as
        | { method: string; params: unknown[] }
        | { method: string; params: unknown[] }[]
      requests.push(...(Array.isArray(payload) ? payload : [payload]))
    })
    for (let i = 0; ; i++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (i > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })
  afterAll(() => {
    chain?.destroy()
    node?.kill()
  })

  it('reads each block by its height, only with calls the relay serves, and dates it by the chain', async () => {
    const dev = new Wallet(DEV_KEY, chain)
    const sent = []
    for (let i = 0; i < 3; i++) {
      const tx = await dev.sendTransaction({ to: dev.address, value: 1n })
      sent.push((await tx.wait())!)
    }
    requests.length = 0
    const known = new Map<string, number>()
    const blocks = sent.map(receipt => ({
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
    }))
    // A hash that is not the block at that height (a block replaced since) is left out.
    const replaced = { blockNumber: sent[0]!.blockNumber, blockHash: '0x' + '12'.repeat(32) }
    const times = await readEvmBlockTimes(chain, [...blocks, replaced], known)

    for (const receipt of sent) {
      const block = (await chain.getBlock(receipt.blockNumber))!
      expect(times.get(receipt.blockHash.toLowerCase())).toBe(block.timestamp * 1000)
    }
    expect(times.has(replaced.blockHash)).toBe(false)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.filter(call => !relayServes(call))).toEqual([])
    expect(requests.map(call => call.method)).not.toContain('eth_getBlockByHash')

    // A block's time is read once.
    requests.length = 0
    await readEvmBlockTimes(chain, blocks, known)
    expect(requests).toEqual([])
  })
})
