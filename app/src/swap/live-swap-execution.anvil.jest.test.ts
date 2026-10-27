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
function escrowAddress(): string {
  const digest = sha256(
    utf8ToBytes(
      ['frank/swap-testnet-evm-escrow/v1', SWAP_ID, INITIATOR, RESPONDER].join(
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
})
