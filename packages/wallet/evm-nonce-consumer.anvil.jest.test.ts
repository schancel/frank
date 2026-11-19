/**
 * INTEGRATION: which transaction used an account's nonce, read from a real EVM node (`anvil`).
 *
 * Two transactions are signed at one nonce of one account (two devices of one account paying
 * from the same coin); the node mines one of them. The search must name the mined one `this`
 * and the other `another`, at the block that mined it, however many blocks later it looks, and
 * say nothing for a nonce the account has not used yet.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN, or fails
 * under FRANK_REQUIRE_NODES=1.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { JsonRpcProvider, Wallet } from 'ethers'
import { findNonceConsumer } from './evm-nonce-consumer'
import { anvilBinary, findAnvil, nodeSuiteReady } from './node-binaries.testutil'

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const anvilBin = findAnvil()
const suite = nodeSuiteReady('evm-nonce-consumer.anvil', [anvilBinary(anvilBin)]) ? describe : describe.skip

suite('the transaction that used a nonce, on a real EVM node (anvil)', () => {
  jest.setTimeout(60_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  beforeAll(async () => {
    const port = await freePort()
    node = spawn(anvilBin!, ['--port', String(port), '--chain-id', '10143', '--silent'], { stdio: 'ignore' })
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, { staticNetwork: true, cacheTimeout: -1 })
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (attempt > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })
  afterAll(() => {
    chain?.destroy()
    node?.kill()
  })

  test('the mined transaction is this one; the other signed at its nonce is another', async () => {
    const dev = new Wallet(DEV_KEY, chain)
    const coin = Wallet.createRandom().connect(chain)
    await (await dev.sendTransaction({ to: coin.address, value: 10n ** 18n })).wait()
    await chain.send('anvil_mine', ['0x20'])
    const fees = await chain.getFeeData()
    const signAt = (to: string, value: bigint) =>
      coin.signTransaction({
        type: 2, chainId: 10143n, nonce: 0, to, value, gasLimit: 21000n,
        maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
      })
    // Two devices' payments from the same coin; different values, so different transactions.
    const winner = await chain.broadcastTransaction(await signAt(Wallet.createRandom().address, 1000n))
    const loserRaw = await signAt(Wallet.createRandom().address, 2000n)
    const minedIn = (await winner.wait())!.blockNumber
    await expect(chain.broadcastTransaction(loserRaw)).rejects.toThrow()
    const loserHash = (await import('ethers')).Transaction.from(loserRaw).hash!
    expect(await chain.getTransactionReceipt(loserHash)).toBeNull()
    // Looked at well after it was used, as a device that comes back later does.
    await chain.send('anvil_mine', ['0x64'])
    const head = await chain.getBlockNumber()
    const account = coin.address.toLowerCase()
    await expect(findNonceConsumer(chain, { account, nonce: 0, transactionHash: loserHash }, head))
      .resolves.toEqual({ by: 'another', blockNumber: minedIn })
    await expect(findNonceConsumer(chain, { account, nonce: 0, transactionHash: winner.hash }, head))
      .resolves.toEqual({ by: 'this', blockNumber: minedIn })
    // A block before the nonce was used, and a nonce not used yet, say nothing.
    await expect(findNonceConsumer(chain, { account, nonce: 0, transactionHash: loserHash }, minedIn - 1))
      .resolves.toBeUndefined()
    await expect(findNonceConsumer(chain, { account, nonce: 1, transactionHash: loserHash }, head))
      .resolves.toBeUndefined()
  })
})
