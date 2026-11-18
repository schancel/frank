/**
 * @jest-environment node
 */
/**
 * INTEGRATION: refunding an earlier-funded swap's EVM escrow (review A3 keeps refunds working
 * while new swaps are turned off).
 *
 * Real: a local dev node of a real EVM client (`anvil`), ethers' JSON-RPC provider as the
 * wallet's node access, a real funded escrow and the real sweep transaction.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Wallet } from 'ethers'
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { EvmChainWalletHandle } from '@frank/wallet/chain'
import {
  createLiveEvmSwapCapability,
  observeEvmEscrowFunding,
  SwapExecutionDisabledError,
} from './live-swap-execution'

function findAnvil(): string | undefined {
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
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const SWAP_ID = 'ab'.repeat(32)
const INITIATOR = '02' + '11'.repeat(32)
const RESPONDER = '03' + '22'.repeat(32)

/** The escrow key the live swap derives (`deriveEvmEscrowPrivateKeyHex`). */
function escrowAddress(swapId = SWAP_ID): string {
  const digest = sha256(
    utf8ToBytes(
      ['frank/swap-testnet-evm-escrow/v1', swapId, INITIATOR, RESPONDER].join(
        '|',
      ),
    ),
  )
  return new Wallet(`0x${bytesToHex(digest)}`).address
}

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: live-swap-execution.anvil needs an anvil binary (set ANVIL_BIN).',
  )
const suite = anvilBin ? describe : describe.skip

suite('the live EVM swap leg (anvil)', () => {
  jest.setTimeout(60_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet

  beforeAll(async () => {
    const port = await freePort()
    node = spawn(anvilBin!, ['--port', String(port), '--chain-id', '10143'], {
      stdio: 'ignore',
    })
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
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
    dev = new Wallet(DEV_KEY, chain)
  })
  afterAll(() => {
    chain?.destroy()
    node?.kill()
  })

  function evmWallet(mainAccount: Wallet | undefined) {
    return {
      provider: chain,
      httpClient: {
        submitRawTransaction: async (raw: string) =>
          (await chain.broadcastTransaction(raw)).hash,
        getTransactionReceipt: async (hash: string) =>
          (await chain.getTransactionReceipt(hash)) ?? undefined,
      },
      mainAccount,
    } as unknown as EvmChainWalletHandle
  }

  it("refunds the responder's funded escrow to the wallet's main account", async () => {
    const escrow = escrowAddress()
    const funding = await dev.sendTransaction({
      to: escrow,
      value: 10n ** 18n,
    })
    await funding.wait()
    const main = Wallet.createRandom()
    const capability = createLiveEvmSwapCapability(() =>
      evmWallet(main as unknown as Wallet),
    )

    const { txHash } = await capability.broadcastTransaction(
      `swap-evm-refund:${SWAP_ID}:${INITIATOR}:${RESPONDER}:responder`,
    )

    const receipt = await chain.getTransactionReceipt(txHash)
    expect(receipt?.status).toBe(1)
    expect(receipt?.from).toBe(escrow)
    expect(receipt?.to).toBe(main.address)
    expect(await chain.getBalance(main.address)).toBeGreaterThan(0n)
  })

  it('refuses a sweep when the wallet has no main account to receive it', async () => {
    const escrow = escrowAddress()
    await (await dev.sendTransaction({ to: escrow, value: 10n ** 18n })).wait()
    const funded = await chain.getBalance(escrow)
    const capability = createLiveEvmSwapCapability(() => evmWallet(undefined))
    await expect(
      capability.broadcastTransaction(
        `swap-evm-claim:${SWAP_ID}:${INITIATOR}:${RESPONDER}:initiator`,
      ),
    ).rejects.toThrow('The EVM wallet has no main account')
    expect(await chain.getBalance(escrow)).toBe(funded)
  })

  it('never funds a new swap', async () => {
    const capability = createLiveEvmSwapCapability(() => evmWallet(undefined))
    await expect(capability.reserveInput({} as never)).rejects.toBeInstanceOf(
      SwapExecutionDisabledError,
    )
  })

  describe("observing an escrow's funding", () => {
    const PRINCIPAL = 10n ** 17n
    const mine = (blocks: number) =>
      chain.send('anvil_mine', [`0x${blocks.toString(16)}`])
    const watch = (swapId: string, principal = PRINCIPAL) =>
      createLiveEvmSwapCapability(() =>
        evmWallet(Wallet.createRandom() as unknown as Wallet),
      ).observeFunding(
        `swap-evm-watch-id:${swapId}:${INITIATOR}:${RESPONDER}:${principal}`,
      )

    it('reports the real depth of the funding, final only at 10 blocks', async () => {
      const swapId = 'c1'.repeat(32)
      expect(await watch(swapId)).toEqual({
        status: 'unseen',
        confirmations: 0,
      })

      await (
        await dev.sendTransaction({
          to: escrowAddress(swapId),
          value: PRINCIPAL,
        })
      ).wait()
      expect(await watch(swapId)).toMatchObject({
        status: 'included',
        confirmations: 1,
        spent: false,
      })

      await mine(4)
      expect(await watch(swapId)).toMatchObject({
        status: 'included',
        confirmations: 5,
      })

      await mine(5)
      expect(await watch(swapId)).toMatchObject({
        status: 'final',
        confirmations: 10,
        spent: false,
      })
    })

    it('does not count a deposit short of the principal as funding', async () => {
      const swapId = 'c2'.repeat(32)
      await (
        await dev.sendTransaction({
          to: escrowAddress(swapId),
          value: (PRINCIPAL * 95n) / 100n,
        })
      ).wait()
      await mine(12)
      expect(await watch(swapId)).toEqual({
        status: 'unseen',
        confirmations: 0,
      })
    })

    it('reports a swept escrow as spent, with the depth it is funded at', async () => {
      const swapId = 'c3'.repeat(32)
      await (
        await dev.sendTransaction({
          to: escrowAddress(swapId),
          value: PRINCIPAL,
        })
      ).wait()
      await mine(2)
      const capability = createLiveEvmSwapCapability(() =>
        evmWallet(Wallet.createRandom() as unknown as Wallet),
      )
      await capability.broadcastTransaction(
        `swap-evm-refund:${swapId}:${INITIATOR}:${RESPONDER}:responder`,
      )
      // The sweep leaves at most dust from its gas estimate.
      expect(await chain.getBalance(escrowAddress(swapId))).toBeLessThan(
        PRINCIPAL / 1000n,
      )

      expect(await watch(swapId)).toMatchObject({
        status: 'included',
        confirmations: 4,
        spent: true,
      })
      await mine(6)
      expect(await watch(swapId)).toMatchObject({
        status: 'final',
        confirmations: 10,
        spent: true,
      })
    })

    it('grows deep and final across observations on a node that serves only the latest state', async () => {
      const escrow = escrowAddress('c4'.repeat(32))
      // The node refuses every account query at an older block, as a pruned node does.
      const latestOnly = {
        getBlockNumber: () => chain.getBlockNumber(),
        async getBalance(address: string, block?: number) {
          if (block !== undefined && block !== (await chain.getBlockNumber()))
            throw new Error('missing trie node')
          return chain.getBalance(address, block)
        },
        async getTransactionCount(address: string, block?: number) {
          if (block !== undefined && block !== (await chain.getBlockNumber()))
            throw new Error('missing trie node')
          return chain.getTransactionCount(address, block)
        },
      }
      const observe = (previous?: Awaited<ReturnType<typeof watch>>) =>
        observeEvmEscrowFunding(
          latestOnly as never,
          escrow,
          PRINCIPAL,
          previous,
        )

      await (await dev.sendTransaction({ to: escrow, value: PRINCIPAL })).wait()
      await mine(3)
      const first = await observe()
      // Only the latest block is certain on such a node.
      expect(first).toMatchObject({ status: 'included', confirmations: 1 })

      await mine(9)
      // Without the stored observation the depth would stay at 1 forever.
      expect(await observe()).toMatchObject({ confirmations: 1 })
      expect(await observe(first)).toMatchObject({
        status: 'final',
        confirmations: 10,
        blockHeight: first.blockHeight,
      })
    })

    // Runs last: it rewinds the chain.
    it('does not trust a stored funding block that a reorg has moved later', async () => {
      const escrow = escrowAddress('c5'.repeat(32))
      const observe = (previous?: Awaited<ReturnType<typeof watch>>) =>
        observeEvmEscrowFunding(chain, escrow, PRINCIPAL, previous)
      const beforeFunding = await chain.send('evm_snapshot', [])

      await (await dev.sendTransaction({ to: escrow, value: PRINCIPAL })).wait()
      const first = await observe()
      expect(first).toMatchObject({ status: 'included', confirmations: 1 })

      // The reorg: the chain without that block, where the funding lands 5 blocks later.
      await chain.send('evm_revert', [beforeFunding])
      await mine(5)
      await (await dev.sendTransaction({ to: escrow, value: PRINCIPAL })).wait()
      await mine(4)
      const tip = await chain.getBlockNumber()
      // Counted from the stored block the funding would read as 10 deep, and final.
      expect(tip - first.blockHeight! + 1).toBe(10)

      expect(await observe(first)).toMatchObject({
        status: 'included',
        confirmations: 5,
        blockHeight: tip - 4,
      })
    })
  })
})
