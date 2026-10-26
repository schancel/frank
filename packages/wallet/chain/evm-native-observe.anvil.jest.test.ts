/**
 * INTEGRATION: one look at a native transfer whose block is made while the look is reading.
 *
 * Real: a local dev node of a real EVM client (`anvil`, chain ID 10143, no automine), ethers'
 * JSON-RPC provider talking to it, the wallet's native operation journal on Level, the native
 * executor and its transaction builder, real signing.
 *
 * Not real, and said so: the order of events. A Monad node does not serve a transaction before
 * its block; anvil does. So the signed transfer is handed to anvil, and a block made, exactly
 * between the look's reads by hash and its account read. The node answers every read itself.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  JsonRpcProvider,
  Transaction,
  Wallet,
  type Provider,
  type TransactionReceipt,
  type TransactionResponse,
} from 'ethers'
import { EvmLegacyConsolidator } from './evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './evm-transaction-builder'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import {
  EvmNativeOperationJournal,
  nativeMemberSuperseded,
  type EvmNativeSource,
} from '../storage/evm-native-operation-journal'

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

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'test-owned-public-branches',
}

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: evm-native-observe.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.',
  )
const suite = anvilBin ? describe : describe.skip

suite('a native transfer mined during a look (anvil)', () => {
  jest.setTimeout(60_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let location: string
  let journal: EvmNativeOperationJournal
  const payer = Wallet.createRandom()
  const recipient = Wallet.createRandom().address.toLowerCase()
  const source: EvmNativeSource = {
    kind: 'spend',
    index: 0,
    address: payer.address.toLowerCase(),
  }

  beforeEach(async () => {
    const port = await freePort()
    node = spawn(
      anvilBin!,
      [
        '--port',
        String(port),
        '--chain-id',
        '10143',
        '--no-mining',
        '--base-fee',
        '0',
        '--gas-price',
        '1000000000',
      ],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
      batchMaxCount: 1,
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
    const dev = new Wallet(DEV_KEY, chain)
    await dev.sendTransaction({ to: payer.address, value: 10n ** 18n })
    await chain.send('evm_mine', [])
    location = await mkdtemp(join(tmpdir(), 'frank-native-observe-'))
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  })
  afterEach(async () => {
    await journal?.Close()
    if (location) await rm(location, { recursive: true, force: true })
    chain?.destroy()
    node?.kill()
  })

  it('a transfer the node did not know when read by hash, and that took its nonce before the account was read, is recorded mined in its block, never "superseded"', async () => {
    let target: string | undefined
    let landed = false
    let byHash: Promise<unknown> | undefined
    // The node's own answers, with one event placed: once both reads by hash for the signed
    // transfer have been answered (the node knew nothing), the transfer is handed to the node and
    // mined. The account read that follows sees its nonce consumed.
    const land = async () => {
      landed = true
      await byHash
      const raw = journal.list()[0]!.members[0]!.signed!.rawTransaction
      await chain.broadcastTransaction(raw)
      await chain.send('evm_mine', [])
    }
    const provider = new Proxy(chain, {
      get(target_, key, receiver) {
        if (key === 'getTransaction')
          return (hash: string) => {
            const read = target_.getTransaction(hash)
            if (hash === target && !landed) byHash = read.catch(() => null)
            return read
          }
        if (key === 'getTransactionReceipt')
          return async (hash: string) => {
            const receipt = await target_.getTransactionReceipt(hash)
            if (hash === target && !landed && receipt === null) await land()
            return receipt
          }
        const value = Reflect.get(target_, key, receiver)
        return typeof value === 'function' ? value.bind(target_) : value
      },
    }) as Provider
    const executor = new EvmLegacyConsolidator({
      journal,
      provider,
      transactionBuilder: new NativeEvmTransactionBuilder(),
      mainSource: source,
      ownedSource: address =>
        address.toLowerCase() === source.address ? source : undefined,
      sign: async (_source, raw) =>
        payer.signTransaction(Transaction.from(raw)),
    })
    const row = await executor.signIndependentPayment({
      kind: 'native',
      preparationId: 'stealth-payment:mined-during-look',
      recipient: { raw: recipient },
      maxNativeFeeWei: 10n ** 16n,
      members: [{ sourceAddress: source.address, value: 10n ** 15n }],
    })
    const hash = row.members[0]!.signed!.transactionHash
    target = hash
    // Signed, not yet at the node: the look's reads by hash find nothing.
    expect(await chain.getTransaction(hash)).toBeNull()

    await executor.observe(row.operationId, 0)

    const receipt = (await chain.getTransactionReceipt(
      hash,
    )) as TransactionReceipt
    expect(landed).toBe(true)
    expect(receipt.status).toBe(1)
    const member = journal.get(row.operationId).members[0]!
    expect(nativeMemberSuperseded(member)).toBe(false)
    expect(member.observation).toMatchObject({
      state: 'included-success',
      transactionHash: hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
    })
    expect(summarizeEvmNativeOperation(journal.get(row.operationId))).toMatchObject({
      payment: 'included',
      members: [
        { state: 'included-success', blockNumber: receipt.blockNumber },
      ],
    })
    // The recipient was paid exactly once.
    expect(await chain.getBalance(recipient)).toBe(10n ** 15n)
    expect(
      ((await chain.getTransaction(hash)) as TransactionResponse).blockNumber,
    ).toBe(receipt.blockNumber)
  })

  it('a nonce taken by another transaction, with no receipt for ours, is still recorded superseded', async () => {
    const executor = new EvmLegacyConsolidator({
      journal,
      provider: chain,
      transactionBuilder: new NativeEvmTransactionBuilder(),
      mainSource: source,
      ownedSource: address =>
        address.toLowerCase() === source.address ? source : undefined,
      sign: async (_source, raw) =>
        payer.signTransaction(Transaction.from(raw)),
    })
    const row = await executor.signIndependentPayment({
      kind: 'native',
      preparationId: 'stealth-payment:nonce-taken',
      recipient: { raw: recipient },
      maxNativeFeeWei: 10n ** 16n,
      members: [{ sourceAddress: source.address, value: 10n ** 15n }],
    })
    // Another transaction at the same nonce, never handed over by the wallet, takes its place.
    await payer.connect(chain).sendTransaction({
      to: payer.address,
      value: 1n,
      nonce: Transaction.from(row.members[0]!.unsignedTransaction).nonce,
    })
    await chain.send('evm_mine', [])

    await executor.observe(row.operationId, 0)

    const member = journal.get(row.operationId).members[0]!
    expect(member.observation.state).toBe('missing')
    expect(nativeMemberSuperseded(member)).toBe(true)
    expect(summarizeEvmNativeOperation(journal.get(row.operationId)).payment).toBe(
      'superseded',
    )
    expect(await chain.getBalance(recipient)).toBe(0n)
  })
})
