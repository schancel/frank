/**
 * @jest-environment node
 */
/**
 * INTEGRATION: a payment card on a device of the account that did not send the payment.
 *
 * Real: a local dev node of a real EVM client (`anvil`), ethers' JSON-RPC provider talking to it
 * as the wallet's read-only node access, real transfers and their receipts. The device's own
 * journal holds nothing for the payment, as on a second device.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Wallet, keccak256 } from 'ethers'
import {
  outgoingStealthPayments,
  refreshOutgoingStealthPayments,
  type StealthPaymentOwner,
} from './outgoing-stealth-payments'
import { sentStealthAssetDetail } from './stealth-transaction-details'

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
const DIGEST = 'f6'.repeat(32)

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: outgoing-stealth-payments.anvil needs an anvil binary (set ANVIL_BIN).',
  )
const suite = anvilBin ? describe : describe.skip

suite('a sent payment card on the device that did not send it (anvil)', () => {
  jest.setTimeout(60_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet

  beforeAll(async () => {
    const port = await freePort()
    node = spawn(
      anvilBin!,
      ['--port', String(port), '--chain-id', '10143', '--no-mining'],
      { stdio: 'ignore' },
    )
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
  beforeEach(() => outgoingStealthPayments.clear())

  /** This device: its journal holds no payment at all; it can read the node. */
  const device = (): StealthPaymentOwner => ({
    chainIdentifier: 'monad-regtest',
    stealthPayments: { list: async () => [], status: async () => undefined },
    evmReader: chain,
  })
  async function signedTransfer(value: bigint, nonce: number) {
    const to = Wallet.createRandom().address
    const raw = await dev.signTransaction({
      to,
      value,
      nonce,
      gasLimit: 21000n,
      gasPrice: 2_000_000_000n,
      chainId: 10143n,
    })
    return { raw, to, value }
  }
  const message = (transfers: { raw: string; to: string; value: bigint }[]) => {
    const items = [
      {
        type: 'stealth-asset',
        transfers: transfers.map(transfer => ({
          chainIdentifier: 'monad-regtest',
          // The transaction hash the message carries: keccak of the signed bytes.
          txId: keccak256(transfer.raw),
          destination: transfer.to.slice(2).toLowerCase(),
          amountAtomic: transfer.value.toString(),
          asset: { kind: 'native' },
        })),
      },
    ]
    return {
      outbound: true,
      payloadDigest: 'local-digest',
      delivery: { attemptDigest: DIGEST },
      items,
    }
  }
  const shown = (sent: ReturnType<typeof message>) =>
    sentStealthAssetDetail(outgoingStealthPayments.get(DIGEST), sent.items[0]!)

  it('reads not checked while the chain shows nothing, partly landed once one transfer is in a block, and paid once all are', async () => {
    const nonce = await chain.getTransactionCount(dev.address)
    const first = await signedTransfer(10n ** 15n, nonce)
    const second = await signedTransfer(2n * 10n ** 15n, nonce + 1)
    const sent = message([first, second])

    // Signed and sent with the message, not at the node yet: nothing is claimed.
    await refreshOutgoingStealthPayments([device()], [sent])
    expect(shown(sent)).toEqual({ state: 'unknown' })

    await chain.broadcastTransaction(first.raw)
    await chain.send('evm_mine', [])
    expect(await refreshOutgoingStealthPayments([device()], [sent])).toBe(1)
    expect(shown(sent)).toMatchObject({
      state: 'partial',
      payment: {
        intendedAmountAtomic: 3n * 10n ** 15n,
        verifiedReceivedAmountAtomic: 10n ** 15n,
        members: [{ state: 'landed' }, { state: 'pending' }],
      },
    })

    await chain.broadcastTransaction(second.raw)
    await chain.send('evm_mine', [])
    expect(await refreshOutgoingStealthPayments([device()], [sent])).toBe(0)
    expect(shown(sent)).toMatchObject({
      state: 'paid',
      payment: {
        verifiedReceivedAmountAtomic: 3n * 10n ** 15n,
        members: [{ state: 'landed' }, { state: 'landed' }],
      },
    })
  })

  it('a receipt that does not pay the stated recipient is not taken as the payment', async () => {
    const nonce = await chain.getTransactionCount(dev.address)
    const real = await signedTransfer(10n ** 15n, nonce)
    await chain.broadcastTransaction(real.raw)
    await chain.send('evm_mine', [])
    const sent = message([{ ...real, to: Wallet.createRandom().address }])
    await refreshOutgoingStealthPayments([device()], [sent])
    expect(shown(sent)).toEqual({ state: 'unknown' })
  })
})
