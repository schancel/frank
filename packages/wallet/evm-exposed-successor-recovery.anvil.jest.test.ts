/** C2: original exposed same-account successor recovery; real isolated Anvil and durable stores.
 * No relay, Solonet, funded custody or product implementation changes.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { JsonRpcProvider, Transaction, Wallet, parseEther } from 'ethers'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { LevelRecordStore } from './storage/evm-coin-store'
import {
  EvmNativeOperationJournal,
  nativeMemberSuperseded,
} from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { abandonTakenMembers } from './evm-transaction-set-taken'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  type EvmTransactionSetPolicy,
} from './evm-transaction-set-types'
function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json'))
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(
      root,
      `anvil-${process.platform}-${arch}`,
      'bin',
      'anvil'
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
const signer = (n: number) =>
  new Wallet('0x' + n.toString(16).padStart(64, '0'))
const PRICE = 1_000_000_000n
const FEE = 21_000n * PRICE
const anvilBin = findAnvil()
if (!anvilBin) console.warn('NOT RUN: exposed-successor-recovery needs Anvil')
const suite = anvilBin ? describe : describe.skip
suite(
  'exposed original successor after another device consumes its predecessor',
  () => {
    jest.setTimeout(60_000)
    let node: ChildProcess
    let chain: JsonRpcProvider
    let directory: string
    let store: LevelRecordStore<StoredEvmListCoin> | undefined
    let journal: EvmNativeOperationJournal | undefined
    beforeEach(async () => {
      const port = await freePort()
      node = spawn(
        anvilBin!,
        [
          '--port',
          String(port),
          '--chain-id',
          '10143',
          '--base-fee',
          '0',
          '--gas-price',
          String(PRICE),
          '--silent',
        ],
        { stdio: 'ignore' }
      )
      chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, {
        staticNetwork: true,
        cacheTimeout: -1,
      })
      for (let n = 0; ; n++) {
        try {
          await chain.getBlockNumber()
          break
        } catch (error) {
          if (n > 100) throw error
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      directory = await mkdtemp(join(tmpdir(), 'frank-exposed-successor-'))
    })
    afterEach(async () => {
      await journal?.Close()
      await store?.close()
      chain?.destroy()
      node?.kill()
      await rm(directory, { recursive: true, force: true })
    })
    it.each([
      'direct predecessor',
      'earlier predecessor with abandoned intermediate moves',
      'persisted baseline exposed abandoned intermediate moves',
    ] as const)(
      'recovers exact exposed successor after top-up and reopen: %s',
      async (collision) => {
        const source = signer(123),
          recipient = signer(124),
          spare = signer(125)
        const dev = new Wallet(DEV_KEY, chain)
        const initial = parseEther('10'),
          amount = parseEther('0.1')
        const binding = {
          chainIdentifier: 'monad-testnet',
          nativeChainId: '10143',
          publicTuple: 'exposed-successor-anvil',
        }
        let head = await chain.getBlockNumber()
        const rule = { belowWei: parseEther('1'), waitBlocks: 3 }
        const policy = (): EvmTransactionSetPolicy => ({
          sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
          gasPriceWei: PRICE,
          paymentGasLimit: () => 21000n,
          changeGasLimit: 21000n,
          paymentFeeIsExact: true,
          dustWei: 1000n,
          radix: 2,
          jitterBps: 0,
          maxChangeOutputs: 16,
          head,
          spendRule: rule,
        })
        const deriveChange = (index: number) => ({
          account: signer(200 + index).address.toLowerCase(),
          privateKey: signer(200 + index).privateKey,
          changeIndex: index,
        })
        const open = async () => {
          store = await LevelRecordStore.open<StoredEvmListCoin>(
            directory,
            'coins'
          )
          const coins = await EvmCoinList.open(store)
          journal = new EvmNativeOperationJournal({
            location: directory,
            binding,
          })
          await journal.Open()
          const preparer = new EvmTransactionSetPreparer({
            coins,
            journal,
            policy,
            recoverySpendRule: rule,
            deriveChange,
            random: () => 0.01,
          })
          const lifecycle = new EvmTransactionSetLifecycle({
            authority: preparer,
            provider: chain,
            head: () => head,
          })
          return { coins, preparer, lifecycle }
        }
        const mine = async (n = 1) => {
          await chain.send('anvil_mine', [`0x${n.toString(16)}`])
          head = await chain.getBlockNumber()
        }
        await (
          await dev.sendTransaction({ to: source.address, value: initial })
        ).wait()
        await (
          await dev.sendTransaction({
            to: spare.address,
            value: parseEther('1'),
          })
        ).wait()
        await mine(5)
        let w = await open()
        await w.coins.put({
          account: source.address,
          privateKey: source.privateKey,
          nonce: 0,
          valueWei: initial,
          origin: 'stealth',
          listedInBlock: head - 5,
        })
        await w.coins.put({
          account: spare.address,
          privateKey: spare.privateKey,
          nonce: 0,
          valueWei: parseEther('1'),
          origin: 'stealth',
          listedInBlock: head - 5,
        })
        const id = 'original-exposed-successor'
        await w.preparer.constructTransactionSet({
          operationId: id,
          amountWei: amount,
          kdf: () => recipient.address,
          sourceAccounts: [source.address],
        })
        const original = (await w.preparer.readOperation(id))!
        const bytes = original.members.map((m) => m.signed!.rawTransaction)
        const at = original.members.findIndex(
          (m) => m.transactionSet?.role === 'payment'
        )
        console.log(
          'ORIGINAL GRAPH',
          original.members.map((m) => ({
            role: m.transactionSet!.role,
            nonce: Transaction.from(m.unsignedTransaction).nonce,
            wait: m.transactionSet!.predecessorWaitBlocks,
          }))
        )
        expect(at).toBeGreaterThan(0)
        const payment = Transaction.from(bytes[at]!)
        await w.preparer.authorizeSubmission(id)
        await chain.send('evm_setAutomine', [false])
        await w.lifecycle.replay(id, { payments: true })
        const out = (await w.preparer.readOperation(id))!
        expect(out.members[at]!.exposed).toBe(true)
        expect(out.members[at - 1]!.exposed).toBe(true)
        expect(
          out.members[at]!.transactionSet!.predecessorWaitBlocks
        ).toBeUndefined()
        expect(await chain.getTransaction(payment.hash!)).not.toBeNull()
        const collisionIndex = collision === 'direct predecessor' ? at - 1 : 0
        const first = Transaction.from(bytes[collisionIndex]!)
        if (collisionIndex > 0) {
          // This node forgets an already handed-off predecessor. The original earlier moves land;
          // the recipient stays legitimately exposed at the next nonce, behind the missing move.
          await chain.send('anvil_dropTransaction', [first.hash])
          await mine()
          expect(
            await chain.getTransactionCount(source.address, 'latest')
          ).toBe(first.nonce)
        }
        const beforeTake = await chain.getBalance(source.address)
        const foreignRaw = await source.signTransaction({
          type: 0,
          chainId: 10143,
          nonce: first.nonce,
          to: signer(126).address,
          value: beforeTake - 3n * FEE - 1n,
          gasLimit: 21000n,
          gasPrice: 3n * PRICE,
        })
        await chain.broadcastTransaction(foreignRaw)
        await mine(5)
        expect(await chain.getTransactionReceipt(first.hash!)).toBeNull()
        expect(await chain.getTransactionReceipt(payment.hash!)).toBeNull()
        expect(await chain.getTransactionCount(source.address, 'latest')).toBe(
          first.nonce + 1
        )
        await w.lifecycle.observe(id, chain)
        await abandonTakenMembers({
          authority: w.preparer,
          provider: chain,
          operationId: id,
        })
        if (
          collision ===
          'persisted baseline exposed abandoned intermediate moves'
        ) {
          // Reproduce the durable baseline state AFTER genuine lifecycle exposure and the
          // canonical foreign nonce consumption. The old abandonment algorithm wrote these
          // exact facts; the fixed algorithm no longer generates them. No exposure is invented.
          const block = (await chain.getBlock('latest'))!
          for (let index = collisionIndex + 1; index < at; index++) {
            const member = (await w.preparer.readOperation(id))!.members[index]!
            await w.preparer.recordObservation(
              id,
              index,
              { state: 'abandoned', blockNumber: block.number },
              {
                blockHash: block.hash!,
                blockNumber: block.number,
                nonce: first.nonce + 1,
                balanceWei: (
                  await chain.getBalance(source.address, block.number)
                ).toString(),
              },
              member
            )
          }
        }
        const short = (await w.preparer.readOperation(id))!
        expect(nativeMemberSuperseded(short.members[collisionIndex]!)).toBe(
          true
        )
        expect(short.members[at]!.observation.state).not.toBe('abandoned')
        expect(w.preparer.isSourceReserved(source.address)).toBe(true)
        const abandoned = short.members.flatMap((member, index) =>
          member.observation.state === 'abandoned' ? [index] : []
        )
        const stillKnown = await Promise.all(
          abandoned.map((index) =>
            chain.getTransaction(Transaction.from(bytes[index]!).hash!)
          )
        )
        console.log('AFTER TAKE', collision, {
          abandoned,
          exposedAbandoned: abandoned.filter(
            (index) => short.members[index]!.exposed
          ),
          nodeStillKnows: stillKnown.filter(Boolean).length,
          sourceReserved: w.preparer.isSourceReserved(source.address),
          heldCoins: w.coins
            .heldBy(id)
            .map((coin) => ({ nonce: coin.nonce, state: coin.state })),
        })
        // Another independently funded source remains selectable during original reconciliation.
        const other = await w.preparer.constructTransactionSet({
          operationId: 'unrelated',
          amountWei: parseEther('0.01'),
          kdf: () => signer(127).address,
          sourceAccounts: [spare.address],
        })
        expect(
          other.bundle.every(
            (tx) => tx.sourceAccount === spare.address.toLowerCase()
          )
        ).toBe(true)
        // Lost mempool copies must be recovered from the wallet's original durable bytes.
        for (const raw of bytes) {
          const tx = Transaction.from(raw)
          if (await chain.getTransactionReceipt(tx.hash!)) continue
          await chain
            .send('anvil_dropTransaction', [tx.hash])
            .catch(() => undefined)
        }
        await journal!.Close()
        await store!.close()
        journal = undefined
        store = undefined
        w = await open()
        expect(
          (await w.preparer.readOperation(id))!.members.map(
            (m) => m.signed!.rawTransaction
          )
        ).toEqual(bytes)
        // Independent authorization funds this owned source; original message/payment is unchanged.
        await chain.send('evm_setAutomine', [true])
        await (
          await dev.sendTransaction({ to: source.address, value: initial })
        ).wait()
        await mine(5)
        for (let pass = 0; pass < 8; pass++) {
          await w.lifecycle.observe(id, chain)
          await w.lifecycle.replay(id, { payments: true })
          await mine(4)
          await w.lifecycle.observe(id, chain)
          if (
            (await w.preparer.readOperation(id))!.members[at]!.observation
              .state === 'included-success'
          )
            break
        }
        expect(
          (await w.preparer.readOperation(id))!.members.map(
            (m) => m.signed!.rawTransaction
          )
        ).toEqual(bytes)
        console.log('RECOVERY RESULT', collision, {
          nonce: await chain.getTransactionCount(source.address, 'latest'),
          paymentNonce: payment.nonce,
          state: (await w.preparer.readOperation(id))!.members[at]!.observation
            .state,
          balance: (await chain.getBalance(source.address)).toString(),
          recipient: (await chain.getBalance(recipient.address)).toString(),
        })
        const recoveredByWallet =
          (await w.preparer.readOperation(id))!.members[at]!.observation
            .state === 'included-success'
        if (!recoveredByWallet) {
          // Diagnostic counterproof AFTER recording the failed wallet outcome: exact abandoned
          // signed bytes still execute once funds return. No replacement or new signing is used.
          const diagnosticReceipts = []
          for (const index of abandoned) {
            const mined = await (
              await chain.broadcastTransaction(bytes[index]!)
            ).wait()
            expect(mined?.status).toBe(1)
            diagnosticReceipts.push(mined!.hash)
          }
          await w.lifecycle.observe(id, chain)
          await mine(4)
          await w.lifecycle.replay(id, { payments: true })
          await mine(4)
          await w.lifecycle.observe(id, chain)
          expect(
            (await chain.getTransactionReceipt(payment.hash!))?.status
          ).toBe(1)
          console.log(
            'ABANDONED BYTES STILL LAND',
            diagnosticReceipts.length,
            'original successor included after exact-byte diagnostic replay'
          )
        }
        expect(recoveredByWallet).toBe(true)
        expect(await chain.getBalance(recipient.address)).toBe(amount)
        expect((await chain.getTransactionReceipt(payment.hash!))?.status).toBe(
          1
        )
        expect(
          (await w.preparer.readOperation(id))!.members.map(
            (m) => m.signed!.rawTransaction
          )
        ).toEqual(bytes)
        for (let pass = 0; pass < 3; pass++) {
          await w.lifecycle.replay(id, { payments: true })
          await w.lifecycle.observe(id, chain)
        }
        expect(await chain.getBalance(recipient.address)).toBe(amount)
        const finished = (await w.preparer.readOperation(id))!
        expect(
          finished.members.every(
            (member) =>
              member.observation.state === 'included-success' ||
              nativeMemberSuperseded(member)
          )
        ).toBe(true)
        expect(w.preparer.isSourceReserved(source.address)).toBe(false)
        expect(
          finished.members.map((member) => member.signed!.rawTransaction)
        ).toEqual(bytes)
      }
    )
  }
)
