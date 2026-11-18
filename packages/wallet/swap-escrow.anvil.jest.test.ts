/**
 * INTEGRATION: the wallet's GenericHTLC v2 encoders and reader against the compiled contract
 * (`packages/contracts/artifacts/GenericHTLC.json`) deployed to a real EVM node (`anvil`).
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { Contract, ContractFactory, JsonRpcProvider, Wallet, sha256, hexlify, randomBytes } from 'ethers'
import GenericHTLCArtifact from '@frank/contracts/artifacts/GenericHTLC.json'
import {
  encodeHtlcLock,
  encodeHtlcRefund,
  encodeHtlcWithdraw,
  htlcLockId,
  HTLC_NATIVE_TOKEN,
  readHtlcLock,
  type EvmHtlcTerms,
} from './swap-escrow'

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN)) return process.env.ANVIL_BIN
  try {
    const root = dirname(dirname(require.resolve('@foundry-rs/anvil/package.json')))
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

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn('NOT RUN: swap-escrow.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.')
const suite = anvilBin ? describe : describe.skip

suite('GenericHTLC v2 through the wallet encoders, on a real EVM node (anvil)', () => {
  jest.setTimeout(60_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let htlc: string
  const recipient = Wallet.createRandom().address
  const refundTo = Wallet.createRandom().address
  const preimage = hexlify(randomBytes(32))
  const hashLock = sha256(preimage)

  beforeAll(async () => {
    const port = await freePort()
    node = spawn(anvilBin!, ['--port', String(port), '--silent'], { stdio: 'ignore' })
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 })
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (err) {
        if (attempt > 100) throw err
        await new Promise(r => setTimeout(r, 100))
      }
    }
    dev = new Wallet(DEV_KEY, chain)
    const factory = new ContractFactory(GenericHTLCArtifact.abi, GenericHTLCArtifact.bytecode, dev)
    const deployed = await factory.deploy()
    await deployed.waitForDeployment()
    htlc = await deployed.getAddress()
  })
  afterAll(() => {
    chain?.destroy()
    node?.kill()
  })

  const now = async () => BigInt((await chain.getBlock('latest'))!.timestamp)
  async function send(tx: { to: string; data: string; value: bigint }) {
    const receipt = await (await dev.sendTransaction(tx)).wait()
    expect(receipt?.status).toBe(1)
    return receipt!
  }
  async function lock(amount: bigint, seconds: bigint) {
    const terms: EvmHtlcTerms = {
      recipient,
      refundAddress: refundTo,
      token: HTLC_NATIVE_TOKEN,
      amount,
      hashLock,
      expiresAt: (await now()) + seconds,
    }
    const receipt = await send(encodeHtlcLock(htlc, terms))
    return { terms, receipt, lockId: htlcLockId(dev.address, terms) }
  }

  it('opens a lock at the id it computes, withdraws it, and reads the preimage back', async () => {
    const { terms, receipt, lockId } = await lock(10n ** 15n, 3600n)
    const contract = new Contract(htlc, GenericHTLCArtifact.abi, chain)
    expect(await contract.lockIdOf(dev.address, ...Object.values(terms))).toBe(lockId)

    const open = await readHtlcLock(chain, htlc, lockId)
    expect(open).toEqual({ lockId, sender: dev.address, ...terms, state: 'open', preimage: null })

    await send(encodeHtlcWithdraw(htlc, lockId, preimage))
    expect(await chain.getBalance(recipient)).toBe(terms.amount)
    expect(await readHtlcLock(chain, htlc, lockId)).toMatchObject({ state: 'withdrawn', preimage })
    // As of the lock's block, it was still open.
    expect(await readHtlcLock(chain, htlc, lockId, { blockTag: receipt.blockNumber })).toMatchObject({
      state: 'open',
    })
  })

  it('refunds a lock once the chain reaches its deadline', async () => {
    const { terms, lockId } = await lock(2n * 10n ** 15n, 60n)
    await chain.send('evm_increaseTime', [61])
    await chain.send('evm_mine', [])
    await send(encodeHtlcRefund(htlc, lockId))
    expect(await chain.getBalance(refundTo)).toBe(terms.amount)
    expect(await readHtlcLock(chain, htlc, lockId)).toMatchObject({ state: 'refunded', preimage: null })
  })

  it('reads a lock whose refund address is its recipient, as htlc-round opens them', async () => {
    // Not something the wallet encoder writes, but the contract holds such locks.
    const contract = new Contract(htlc, GenericHTLCArtifact.abi, dev)
    const terms: EvmHtlcTerms = {
      recipient: dev.address,
      refundAddress: dev.address,
      token: HTLC_NATIVE_TOKEN,
      amount: 10n ** 14n,
      hashLock,
      expiresAt: (await now()) + 3600n,
    }
    await (await contract.lock(...Object.values(terms), { value: terms.amount })).wait()
    const lockId = htlcLockId(dev.address, terms)
    await send(encodeHtlcWithdraw(htlc, lockId, preimage))
    expect(await readHtlcLock(chain, htlc, lockId)).toEqual({
      lockId,
      sender: dev.address,
      ...terms,
      state: 'withdrawn',
      preimage,
    })
  })

  it('reads a lock that does not exist as null', async () => {
    expect(await readHtlcLock(chain, htlc, '0x' + 'ee'.repeat(32))).toBeNull()
  })
})
