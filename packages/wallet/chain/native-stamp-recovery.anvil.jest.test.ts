/** Real isolated Anvil; actual received owner, canonical derivation, durable stores and spend inventory. Relay delivery is not exercised here. */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Wallet, Transaction, getBytes, hexlify, parseEther } from 'ethers'
import { canonicalStampDestination } from '@frank/cashweb/relay/canonical-dm-stamp'
import { fixture, roots, type Fixture } from './canonical-two-wallets.testutil'
import { evmWalletInternals } from '../evm-wallet'
import { LegacyTransactionSetPendingError } from './evm-legacy-transaction-set'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({ rpcUrl: mockNode.url, chainId: options.chainId }),
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)
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

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const anvilBin = findAnvil()
const suite = anvilBin ? describe : describe.skip
suite('repaid native stamp receiver (real Anvil)', () => {
  jest.setTimeout(120000)
  let child: ChildProcess
  let node: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    child = spawn(
      anvilBin!,
      [
        '--port',
        String(port),
        '--chain-id',
        '10143',
        '--base-fee',
        '0',
        '--gas-price',
        '1000000000',
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    node = new JsonRpcProvider(mockNode.url, 10143, { staticNetwork: true, cacheTimeout: -1 })
    for (let i = 0; ; i++) {
      try {
        await node.getBlockNumber()
        break
      } catch (error) {
        if (i > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    dev = new Wallet(DEV_KEY, node)
    f = await fixture({ transactionSetPolicy: undefined, seedDiscovery: false })
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await f?.close()
    node?.destroy()
    child?.kill()
  })
  const mine = async () => {
    for (let i = 0; i < 4; i++) await node.send('evm_mine', [])
  }
  async function stamp(
    wallet: EvmChainWalletHandle,
    intended = parseEther('0.01'),
    timestampMs = Date.now(),
  ) {
    const roles = evmWalletInternals(wallet).material!.canonicalRoles!
    const sharedPoint = getBytes(new Wallet('0x' + '12'.repeat(32)).signingKey.compressedPublicKey)
    const address = hexlify(
      canonicalStampDestination({
        network: 'monad-testnet',
        stampKey: { keyType: 1, keyBytes: roles.publicGenerationZeroPoints().stamp },
        sharedPoint,
        childIndex: 0,
      }).address,
    ).toLowerCase()
    const key = roles.stampChildPrivateKey({
      network: 'monad-testnet',
      sharedPoint,
      childIndex: 0,
      address,
    })!
    const raw = await dev.signTransaction({
      type: 0,
      chainId: 10143,
      nonce: await node.getTransactionCount(dev.address),
      to: address,
      value: intended,
      gasLimit: 21000n,
      gasPrice: 1000000000n,
    })
    // A second device consumes the original's sender nonce, paying elsewhere.
    await (await dev.sendTransaction({ to: dev.address, value: 0n })).wait()
    await evmWalletInternals(wallet).receivedCoinOwner!.recordStampCoin({
      address,
      privateKey: key,
      childIndex: 0,
      stampSharedPoint: hexlify(sharedPoint),
      payloadDigest: 'ab'.repeat(32),
      valueWei: intended,
      transaction: raw,
      timestampMs,
    })
    return { address, key, raw, intended, hash: Transaction.from(raw).hash! }
  }
  it('recognizes a partial repayment without including the original, then admits the real balance to selection', async () => {
    const original = await stamp(f.bob)
    const repayment = await (
      await dev.sendTransaction({ to: original.address, value: original.intended / 2n })
    ).wait()
    await mine()
    const payments = await f.bob.refreshReceivedPayments!()
    await f.bob.refreshTransactionSetInventory!()
    const selectable = evmWalletInternals(f.bob).coinList!.selectableAt({
      head: await node.getBlockNumber(),
      sourceOrder: ['stamp'],
    })
    expect(selectable.some(coin => coin.account === original.address)).toBe(true)
    expect(payments[0]).toMatchObject({
      status: 'received',
      partial: true,
      receivedAmountWei: original.intended / 2n,
      amountWei: original.intended / 2n,
      transactions: [original.raw.slice(2)],
    })
    expect(await node.getTransactionReceipt(original.hash)).toBeNull()
    await f.bob.refreshTransactionSetInventory!()
    const list = evmWalletInternals(f.bob).coinList!
    expect(
      list
        .selectableAt({ head: await node.getBlockNumber(), sourceOrder: ['stamp'] })
        .some(coin => coin.account === original.address),
    ).toBe(true)
    expect(payments[0]!.nativeStampRecovery?.receipts.map(receipt => receipt.txHash)).toEqual([
      repayment!.hash,
    ])
    expect(payments[0]!.settledTransactions).toBeUndefined()
    const held = list.select({
      holder: 'concurrent-operation',
      amountWei: 1000n,
      feeReserveWei: 1000n,
    })!
    expect(held.some(part => part.coin.account === original.address)).toBe(true)
    await f.bob.refreshTransactionSetInventory!()
    expect(
      list.selectableAt({ head: await node.getBlockNumber(), sourceOrder: ['stamp'] }),
    ).toEqual([])
    list.abandon('concurrent-operation')
    const destination = Wallet.createRandom().address
    let operationId: string | undefined
    try {
      await f.bob.sendLegacy!({ recipient: { raw: destination }, value: original.intended / 10n })
    } catch (error) {
      if (!(error instanceof LegacyTransactionSetPendingError)) throw error
      operationId = error.operation.operationId
    }
    if (operationId)
      for (let pass = 0; pass < 30; pass++) {
        await mine()
        try {
          await f.bob.resumeLegacySend!(operationId)
          operationId = undefined
          break
        } catch (error) {
          if (!(error instanceof LegacyTransactionSetPendingError)) throw error
        }
      }
    expect(operationId).toBeUndefined()
    expect(await node.getBalance(destination)).toBe(original.intended / 10n)
  })
  it('merges top-ups by actual receipt, survives reopen and retains facts when RPC later prunes them', async () => {
    const original = await stamp(f.bob)
    const first = await (
      await dev.sendTransaction({ to: original.address, value: original.intended / 3n })
    ).wait()
    await mine()
    await f.bob.refreshReceivedPayments!()
    // An unrelated source is actual provenance, never attributed to the original sender.
    const other = new Wallet('0x' + '13'.repeat(32), node)
    await (await dev.sendTransaction({ to: other.address, value: parseEther('0.02') })).wait()
    const second = await (
      await other.sendTransaction({ to: original.address, value: original.intended / 3n })
    ).wait()
    await mine()
    const amounts = await f.bob.refreshReceivedPayments!()
    expect(amounts[0]!.receivedAmountWei).toBe((original.intended / 3n) * 2n)
    expect(amounts[0]!.nativeStampRecovery!.receipts.map(receipt => receipt.from)).toEqual([
      dev.address.toLowerCase(),
      other.address.toLowerCase(),
    ])
    await f.bob.refreshReceivedPayments!()
    expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBe(amounts[0]!.receivedAmountWei)
    await f.bob.close()
    const reopened = (await f.chain.createWallet(roots(1))) as EvmChainWalletHandle
    try {
      expect(reopened.getReceivedPayments!()[0]!.transactions).toEqual([original.raw.slice(2)])
      await reopened.refreshReceivedPayments!()
      expect(
        reopened.getReceivedPayments!()[0]!.nativeStampRecovery!.receipts.map(
          receipt => receipt.txHash,
        ),
      ).toEqual([first!.hash, second!.hash])
      const send = (reopened.provider as JsonRpcProvider).send.bind(reopened.provider)
      jest
        .spyOn(reopened.provider as JsonRpcProvider, 'send')
        .mockImplementation(async (method, params) =>
          method === 'eth_getTransactionReceipt' && [first!.hash, second!.hash].includes(params[0])
            ? null
            : send(method, params),
        )
      await expect(reopened.refreshReceivedPayments!()).rejects.toThrow()
      expect(reopened.getReceivedPayments!()[0]!.receivedAmountWei).toBe(
        amounts[0]!.receivedAmountWei,
      )
      await reopened.refreshTransactionSetInventory!()
      expect(evmWalletInternals(reopened).coinList!.latestOf(original.address)?.nonce).toBe(
        await node.getTransactionCount(original.address),
      )
    } finally {
      await reopened.close()
    }
  })
  it('retains received value when another device already spent the account, without offering its old nonce', async () => {
    const original = await stamp(f.bob)
    const repayment = await (
      await dev.sendTransaction({ to: original.address, value: original.intended })
    ).wait()
    const account = new Wallet(original.key, node)
    await (
      await account.sendTransaction({
        to: dev.address,
        value: original.intended - 21000n * 1000000000n,
        gasLimit: 21000n,
        gasPrice: 1000000000n,
      })
    ).wait()
    await mine()
    const [received] = await f.bob.refreshReceivedPayments!()
    expect(received).toMatchObject({
      status: 'received',
      amountWei: 0n,
      receivedAmountWei: original.intended,
      spendable: false,
    })
    expect(received!.nativeStampRecovery!.receipts[0]!.txHash).toBe(repayment!.hash)
    await f.bob.refreshTransactionSetInventory!()
    const list = evmWalletInternals(f.bob).coinList!
    expect(
      list.selectableAt({ head: await node.getBlockNumber(), sourceOrder: ['stamp'] }),
    ).toEqual([])
    expect(await node.getTransactionCount(original.address)).toBe(1)
  })

  it('invalidates a recovery receipt only on a canonical reorg and withdraws stale inventory', async () => {
    const original = await stamp(f.bob)
    const snapshot = await node.send('evm_snapshot', [])
    await (await dev.sendTransaction({ to: original.address, value: original.intended })).wait()
    await mine()
    await f.bob.refreshReceivedPayments!()
    await f.bob.refreshTransactionSetInventory!()
    expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBe(original.intended)
    await node.send('evm_revert', [snapshot])
    await node.send('evm_mine', [])
    await mine()
    await expect(f.bob.refreshReceivedPayments!()).rejects.toThrow('rebuild')
    await f.bob.refreshReceivedPayments!()
    const [payment] = f.bob.getReceivedPayments!()
    expect(payment!.receivedAmountWei).toBe(0n)
    expect(payment!.nativeStampRecovery!.receipts).toEqual([])
    expect(payment!.transactions).toEqual([original.raw.slice(2)])
    await f.bob.refreshTransactionSetInventory!()
    expect(evmWalletInternals(f.bob).coinListSync!.isDirty(original.address)).toBe(true)
    await expect(
      f.bob.sendLegacy!({ recipient: { raw: dev.address }, value: 1000000000000000n }),
    ).rejects.toThrow()
  })
  it('keeps a funded destination pending while the original can still land, then recognizes the actual original', async () => {
    const intended = parseEther('0.01')
    const secondWallet = f.alice
    const roles = evmWalletInternals(secondWallet).material!.canonicalRoles!
    const sharedPoint = getBytes(new Wallet('0x' + '14'.repeat(32)).signingKey.compressedPublicKey)
    const address = hexlify(
      canonicalStampDestination({
        network: 'monad-testnet',
        stampKey: { keyType: 1, keyBytes: roles.publicGenerationZeroPoints().stamp },
        sharedPoint,
        childIndex: 0,
      }).address,
    ).toLowerCase()
    const key = roles.stampChildPrivateKey({
      network: 'monad-testnet',
      sharedPoint,
      childIndex: 0,
      address,
    })!
    const donor = new Wallet('0x' + '15'.repeat(32), node)
    await (await dev.sendTransaction({ to: donor.address, value: parseEther('0.02') })).wait()
    // The intended original uses the sender nonce that donor funding left unused.
    const pendingRaw = await dev.signTransaction({
      type: 0,
      chainId: 10143,
      nonce: await node.getTransactionCount(dev.address),
      to: address,
      value: intended,
      gasLimit: 21000n,
      gasPrice: 1000000000n,
    })
    await (await donor.sendTransaction({ to: address, value: intended / 2n })).wait()
    await evmWalletInternals(secondWallet).receivedCoinOwner!.recordStampCoin({
      address,
      privateKey: key,
      childIndex: 0,
      stampSharedPoint: hexlify(sharedPoint),
      payloadDigest: 'cd'.repeat(32),
      valueWei: intended,
      transaction: pendingRaw,
      timestampMs: Date.now(),
    })
    const broadcast = jest
      .spyOn(secondWallet.provider, 'broadcastTransaction')
      .mockRejectedValue(new Error('offline'))
    await secondWallet.refreshReceivedPayments!()
    expect(secondWallet.getReceivedPayments!()[0]).toMatchObject({
      status: 'pending',
      amountWei: intended / 2n,
    })
    expect(secondWallet.getReceivedPayments!()[0]!.receivedAmountWei).toBeUndefined()
    broadcast.mockRestore()
    await (await node.broadcastTransaction(pendingRaw)).wait()
    await mine()
    await secondWallet.refreshReceivedPayments!()
    expect(secondWallet.getReceivedPayments!()[0]).toMatchObject({
      status: 'received',
      receivedAmountWei: intended,
    })
    expect(secondWallet.getReceivedPayments!()[0]!.nativeStampRecovery).toBeUndefined()
  })

  it('accepts an own-source receipt without history ownership filters or original attribution', async () => {
    const original = await stamp(f.bob)
    const owned = new Wallet(evmWalletInternals(f.bob).material!.mainAccount.privateKey, node)
    await (await dev.sendTransaction({ to: owned.address, value: parseEther('0.02') })).wait()
    const receipt = await (
      await owned.sendTransaction({ to: original.address, value: original.intended })
    ).wait()
    await mine()
    await f.bob.refreshReceivedPayments!()
    const [payment] = f.bob.getReceivedPayments!()
    expect(payment!.receivedAmountWei).toBe(original.intended)
    expect(payment!.nativeStampRecovery!.receipts).toEqual([
      expect.objectContaining({ txHash: receipt!.hash, from: owned.address.toLowerCase() }),
    ])
    expect(await node.getTransactionReceipt(original.hash)).toBeNull()
  })
  it('commits no recovery facts when the pinned canonical head changes during observation', async () => {
    const original = await stamp(f.bob)
    await (await dev.sendTransaction({ to: original.address, value: original.intended })).wait()
    await mine()
    const maximum = await node.getBlockNumber()
    const getBlock = f.bob.provider.getBlock.bind(f.bob.provider)
    let checks = 0
    const spy = jest.spyOn(f.bob.provider, 'getBlock').mockImplementation(async tag => {
      const block = await getBlock(tag)
      if (tag === maximum && ++checks > 1)
        return { ...block!, hash: '0x' + '77'.repeat(32) } as typeof block
      return block
    })
    await expect(f.bob.refreshReceivedPayments!()).rejects.toThrow('canonical head changed')
    expect(f.bob.getReceivedPayments!()[0]!.nativeStampRecovery).toBeUndefined()
    expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBeUndefined()
    spy.mockRestore()
    await f.bob.refreshReceivedPayments!()
    expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBe(original.intended)
  })
  it('rechecks old receipt blocks even when a reorg also removes the original supersession proof', async () => {
    const snapshot = await node.send('evm_snapshot', [])
    const original = await stamp(f.bob)
    await (await dev.sendTransaction({ to: original.address, value: original.intended })).wait()
    await mine()
    await f.bob.refreshReceivedPayments!()
    await node.send('evm_revert', [snapshot])
    await mine()
    await mine()
    await expect(f.bob.refreshReceivedPayments!()).rejects.toThrow('supersession')
    expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBe(0n)
    expect(f.bob.getReceivedPayments!()[0]!.transactions).toEqual([original.raw.slice(2)])
  })

  it('counts an actual late original once after canonical reorganization, replacing orphaned recovery evidence', async () => {
    const snapshot = await node.send('evm_snapshot', [])
    const original = await stamp(f.bob)
    await (await dev.sendTransaction({ to: original.address, value: original.intended })).wait()
    await mine()
    await f.bob.refreshReceivedPayments!()
    await node.send('evm_revert', [snapshot])
    await (await node.broadcastTransaction(original.raw)).wait()
    await mine()
    await mine()
    await expect(f.bob.refreshReceivedPayments!()).rejects.toThrow('rebuild')
    await f.bob.refreshReceivedPayments!()
    const [payment] = f.bob.getReceivedPayments!()
    expect(payment).toMatchObject({
      status: 'received',
      receivedAmountWei: original.intended,
      amountWei: original.intended,
    })
    expect(payment!.transactions).toEqual([original.raw.slice(2)])
    expect(payment!.nativeStampRecovery!.receipts.map(receipt => receipt.txHash)).toEqual([
      original.hash,
    ])
    await f.bob.refreshReceivedPayments!()
    expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBe(original.intended)
  })
  it.each(['same transaction', 'distinct transaction'])(
    'rediscovers a canonically moved repayment with the retained live reader: %s',
    async mode => {
      const original = await stamp(f.bob, undefined, Date.now() - 24 * 60 * 60 * 1000)
      const snapshot = await node.send('evm_snapshot', [])
      const nonce = await node.getTransactionCount(dev.address)
      const oldRaw = await dev.signTransaction({
        type: 0,
        chainId: 10143,
        nonce,
        to: original.address,
        value: original.intended,
        gasLimit: 21000n,
        gasPrice: 1000000000n,
      })
      const oldReceipt = await (await node.broadcastTransaction(oldRaw)).wait()
      await mine()
      await f.bob.refreshReceivedPayments!()
      await f.bob.refreshTransactionSetInventory!()
      expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBe(original.intended)
      await node.send('evm_revert', [snapshot])
      await node.send('evm_mine', [])
      const newRaw =
        mode === 'same transaction'
          ? oldRaw
          : await dev.signTransaction({
              type: 0,
              chainId: 10143,
              nonce,
              to: original.address,
              value: original.intended,
              gasLimit: 21000n,
              gasPrice: 2000000000n,
            })
      const replacement = await (await node.broadcastTransaction(newRaw)).wait()
      expect(replacement!.blockNumber).toBe(oldReceipt!.blockNumber + 1)
      await mine()
      const failures: unknown[] = []
      try {
        await f.bob.refreshReceivedPayments!()
      } catch (error) {
        failures.push(error)
      }
      // No manual strict refresh bypass: these old, previously fully received stamps must be
      // revisited through the production background owner despite their normal long backoff.
      for (let pass = 0; pass < 2; pass++)
        await evmWalletInternals(f.bob).receivedCoinOwner!.checkPendingCoins()
      const [payment] = f.bob.getReceivedPayments!()
      expect(payment).toMatchObject({
        status: 'received',
        receivedAmountWei: original.intended,
        amountWei: original.intended,
        transactions: [original.raw.slice(2)],
      })
      expect(payment!.nativeStampRecovery!.receipts).toEqual([
        expect.objectContaining({
          txHash: replacement!.hash,
          blockNumber: replacement!.blockNumber,
          amount: original.intended.toString(),
        }),
      ])
      expect(failures).toHaveLength(1)
      await f.bob.refreshTransactionSetInventory!()
      expect(
        evmWalletInternals(f.bob)
          .coinList!.selectableAt({ head: await node.getBlockNumber(), sourceOrder: ['stamp'] })
          .some(coin => coin.account === original.address),
      ).toBe(true)
      await f.bob.refreshReceivedPayments!()
      expect(f.bob.getReceivedPayments!()[0]!.receivedAmountWei).toBe(original.intended)
      await f.bob.close()
      const reopened = (await f.chain.createWallet(roots(1))) as EvmChainWalletHandle
      try {
        await reopened.refreshReceivedPayments!()
        expect(
          reopened.getReceivedPayments!()[0]!.nativeStampRecovery!.receipts.map(
            receipt => receipt.txHash,
          ),
        ).toEqual([replacement!.hash])
        expect(reopened.getReceivedPayments!()[0]!.receivedAmountWei).toBe(original.intended)
        expect(await node.getTransactionReceipt(original.hash)).toBeNull()
      } finally {
        await reopened.close()
      }
    },
  )
})
