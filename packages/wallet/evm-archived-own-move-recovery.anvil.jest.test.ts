/** Investigation: baseline lifecycle can archive an exposed own move whose exact bytes still
 * execute after a later independent top-up. Real isolated Anvil and durable Level stores.
 * No fabricated exposure, relay, Solonet, funded custody, or product implementation changes.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  JsonRpcProvider,
  Transaction,
  Wallet,
  SigningKey,
  parseEther,
} from 'ethers'
import level from 'level'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { LevelRecordStore } from './storage/evm-coin-store'
import {
  EvmNativeOperationJournal,
  nativeMemberSuperseded,
} from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { transactionSetFinancialCompletionReceipt } from './evm-operation-completion'
import { createEvmTransactionSetSubmission } from './evm-transaction-set-submission'
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
  'archived exposed own move remains executable after independent topup',
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
    it.each([false, true])(
      'reactivates original own bytes after top-up/reopen without signing (already spent target=%s)',
      async (alreadySpent) => {
        const saved = JSON.parse(
          readFileSync(
            join(
              __dirname,
              'fixtures/archived-own-move/baseline-lifecycle.json'
            ),
            'utf8'
          )
        )
        const original = saved.originalOperation,
          member = original.members[1],
          raw = member.signed.rawTransaction
        const source = signer(321),
          dev = new Wallet(DEV_KEY, chain),
          own = Transaction.from(raw)
        let head = await chain.getBlockNumber()
        await (
          await dev.sendTransaction({
            to: source.address,
            value: parseEther('10'),
          })
        ).wait()
        const foreign = await source.signTransaction({
          type: 0,
          chainId: 10143,
          nonce: 0,
          to: signer(323).address,
          value: parseEther('10') - 3n * FEE - 1n,
          gasLimit: 21000n,
          gasPrice: 3n * PRICE,
        })
        await (await chain.broadcastTransaction(foreign)).wait()
        await chain.send('anvil_mine', ['0x14'])
        head = await chain.getBlockNumber()
        const db = level(join(directory, 'evm-native-operations-v1'))
        await db.batch([
          {
            type: 'put',
            key: 'manifest',
            value: JSON.stringify({
              version: 1,
              binding: original.binding,
              nextSequence: 2,
              archivedCount: 1,
              revision: 1,
            }),
          },
          {
            type: 'put',
            key: `history:${original.operationId}`,
            value: JSON.stringify(original),
          },
          {
            type: 'put',
            key: `completion:${original.operationId}`,
            value: JSON.stringify(saved.originalCompletion),
          },
          {
            type: 'put',
            key: `preparation:${original.preparationId}`,
            value: original.operationId,
          },
          {
            type: 'put',
            key: `consumed:${source.address.toLowerCase()}:0`,
            value: original.operationId,
          },
        ])
        await db.close()
        const open = async () => {
          store = await LevelRecordStore.open<StoredEvmListCoin>(
            directory,
            'coins'
          )
          const coins = await EvmCoinList.open(store)
          journal = new EvmNativeOperationJournal({
            location: directory,
            binding: original.binding,
          })
          await journal.Open()
          const preparer = new EvmTransactionSetPreparer({
            coins,
            journal,
            observeOwnedRecoveryTarget: async (target, minimumBlock) => {
              const at = await chain.getBlockNumber()
              expect(at).toBeGreaterThanOrEqual(minimumBlock)
              const [nonce, balance] = await Promise.all([
                chain.getTransactionCount(target.account, at),
                chain.getBalance(target.account, at),
              ])
              await coins.put({
                account: target.account,
                privateKey: target.privateKey,
                nonce,
                valueWei: balance,
                origin: 'change',
                changeIndex: target.changeIndex,
                listedInBlock: at,
              })
            },
            recoverySpendRule: { belowWei: parseEther('1'), waitBlocks: 3 },
            policy: () => ({
              sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
              gasPriceWei: PRICE,
              paymentGasLimit: () => 21000n,
              changeGasLimit: 21000n,
              paymentFeeIsExact: true,
              dustWei: 1000n,
              radix: 2,
              jitterBps: 0,
              maxChangeOutputs: 1,
              head,
              spendRule: { belowWei: parseEther('1'), waitBlocks: 3 },
            }),
            deriveChange: (index) => ({
              account: signer(400 + index).address.toLowerCase(),
              privateKey: signer(400 + index).privateKey,
              changeIndex: index,
            }),
          })
          const lifecycle = new EvmTransactionSetLifecycle({
            authority: preparer,
            provider: chain,
            head: () => head,
          })
          return { coins, preparer, lifecycle }
        }
        let w = await open()
        for (const coin of saved.retainedInventory)
          await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
        const signing = jest.spyOn(SigningKey.prototype, 'sign')
        const recovered = await w.preparer.recoverArchivedOwnMoves({
          operationId: original.operationId,
          expectedOriginalOperationHash:
            saved.originalCompletion.expectedOperationHash,
        })
        expect(recovered.status).toBe('active')
        const logicalId = original.preparationId.slice(
          'evm-transaction-set:'.length
        )
        await w.lifecycle.observe(logicalId, chain)
        expect(
          (await w.preparer.readOperation(logicalId))!.members[1]!.observation
            .state
        ).not.toBe('abandoned')
        await expect(
          w.lifecycle.replay(logicalId, { payments: false })
        ).rejects.toThrow()
        expect(signing).not.toHaveBeenCalled()
        signing.mockRestore()
        if (alreadySpent) {
          const deposit = parseEther('0.01')
          await (
            await dev.sendTransaction({ to: own.to!, value: deposit })
          ).wait()
          await (
            await signer(400)
              .connect(chain)
              .sendTransaction({
                type: 0,
                to: dev.address,
                value: deposit - FEE,
                gasLimit: 21000n,
                gasPrice: PRICE,
              })
          ).wait()
          expect(await chain.getTransactionCount(own.to!)).toBe(1)
        }
        await journal!.Close()
        await store!.close()
        journal = undefined
        store = undefined
        // An independently authorized deposit is the only fresh signed transaction.
        await (
          await dev.sendTransaction({
            to: source.address,
            value: parseEther('10'),
          })
        ).wait()
        await chain.send('anvil_mine', ['0x5'])
        head = await chain.getBlockNumber()
        w = await open()
        const noSigning = jest.spyOn(SigningKey.prototype, 'sign')
        for (let pass = 0; pass < 3; pass++) {
          await w.lifecycle.observe(logicalId, chain)
          await w.lifecycle.replay(logicalId, { payments: false })
          await w.lifecycle.observe(logicalId, chain)
        }
        expect((await chain.getTransactionReceipt(own.hash!))?.status).toBe(1)
        expect(await chain.getBalance(own.to!)).toBe(own.value)
        expect(
          w.coins
            .liveUnspent()
            .filter((coin) => coin.account === own.to!.toLowerCase())
        ).toEqual([
          expect.objectContaining({
            nonce: alreadySpent ? 1 : 0,
            valueWei: own.value,
          }),
        ])
        expect(noSigning).not.toHaveBeenCalled()
        noSigning.mockRestore()
        const current = (await w.preparer.readOperation(logicalId))!
        expect(current.members.map((m) => m.signed!.rawTransaction)).toEqual(
          original.members.map(
            (m: { signed: { rawTransaction: string } }) =>
              m.signed.rawTransaction
          )
        )
        expect(journal!.list().map((row) => row.operationId)).toEqual([
          original.operationId,
        ])
        expect(
          await journal!.readArchivedOperation(original.operationId)
        ).toEqual(original)
        expect(
          transactionSetFinancialCompletionReceipt(current)
        ).toBeUndefined()
        await journal!.markSyncApplied(original.operationId, 1)
        await journal!.archiveCompleted(
          original.operationId,
          transactionSetFinancialCompletionReceipt(
            journal!.get(original.operationId)
          )!
        )
        expect(journal!.list()).toEqual([])
        expect(
          (await journal!.readOperation(original.operationId))!.members[1]!
            .observation.state
        ).toBe('included-success')
        expect(
          await journal!.readArchivedOperation(original.operationId)
        ).toEqual(original)
      }
    )
  }
)
