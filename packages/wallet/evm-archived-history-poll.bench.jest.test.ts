/** Optional focused measurement of the actual history-page path used by archived discovery.
 * Synthetic signed completed history measures validation cost; it is not financial evidence.
 * ARCHIVED_HISTORY_BENCH=1 enables the bounded 16-row cold/warm/sweep/tail measurement.
 */
import { readFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { performance } from 'perf_hooks'
import level from 'level'
import { Transaction, Wallet } from 'ethers'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from './evm-transaction-set-types'
import {
  EvmNativeOperationJournal,
  evmNativeOperationDigest,
  type EvmNativeOperation,
} from './storage/evm-native-operation-journal'
const measured = process.env.ARCHIVED_HISTORY_BENCH === '1' ? test : test.skip
measured.each([
  { memberCount: 2, count: 1536 },
  { memberCount: 21, count: 64 },
  { memberCount: 64, count: 64 },
])(
  'bounded discovery measures $memberCount-member rows',
  async ({ memberCount, count }) => {
    jest.setTimeout(120000)
    const saved = JSON.parse(
      readFileSync(
        join(__dirname, 'fixtures/archived-own-move/baseline-lifecycle.json'),
        'utf8'
      )
    )
    let template = saved.originalOperation as EvmNativeOperation
    if (memberCount !== 2) {
      const coins = await EvmCoinList.open(
        new MemoryRecordStore<StoredEvmListCoin>()
      )
      const owner = new EvmNativeOperationJournal({
        testOnlyEphemeral: true,
        binding: template.binding,
      })
      await owner.Open()
      const root = new Wallet('0x' + (4999).toString(16).padStart(64, '0'))
      await coins.put({
        account: root.address,
        privateKey: root.privateKey,
        nonce: 0,
        valueWei: 10n ** 40n,
        origin: 'stealth',
      })
      const preparer = new EvmTransactionSetPreparer({
        coins,
        journal: owner,
        random: () => 0.99,
        policy: () => ({
          sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
          gasPriceWei: 1000000000n,
          paymentGasLimit: () => 21000n,
          changeGasLimit: 21000n,
          paymentFeeIsExact: true,
          dustWei: 1000n,
          radix: 2,
          jitterBps: 0,
          maxChangeOutputs: memberCount - 1,
          head: 100,
        }),
        deriveChange: (index) => {
          const key = new Wallet(
            '0x' + (8000 + index).toString(16).padStart(64, '0')
          )
          return {
            account: key.address.toLowerCase(),
            privateKey: key.privateKey,
            changeIndex: index,
          }
        },
      })
      await preparer.constructTransactionSet({
        operationId: 'perf-template-00',
        amountWei: 10n ** 15n,
        kdf: () => new Wallet('0x' + '01'.padStart(64, '0')).address,
      })
      template = owner.list()[0]!
      expect(template.members).toHaveLength(memberCount)
      await owner.Close()
    }
    const directory = await mkdtemp(join(tmpdir(), 'archived-poll-measure-'))
    let journal: EvmNativeOperationJournal | undefined
    try {
      const db = level(join(directory, 'evm-native-operations-v1'))
      const operations: { type: 'put'; key: string; value: string }[] = []
      for (let n = 0; n < count; n++) {
        const row = structuredClone(template) as EvmNativeOperation
        row.operationId = `evm-native-v1:${(n + 1)
          .toString(16)
          .padStart(16, '0')}`
        row.preparationId = `evm-transaction-set:perf-${n
          .toString()
          .padStart(11, '0')}`
        const signer = new Wallet(
          '0x' + (5000 + n).toString(16).padStart(64, '0')
        )
        for (const member of row.members) {
          const old = Transaction.from(member.signed!.rawTransaction)
          const raw = await signer.signTransaction({
            type: old.type!,
            chainId: old.chainId,
            nonce: old.nonce,
            to: old.to,
            value: old.value,
            gasLimit: old.gasLimit,
            gasPrice: old.gasPrice!,
          })
          const tx = Transaction.from(raw)
          member.source.address = signer.address.toLowerCase()
          member.unsignedTransaction = tx.unsignedSerialized
          member.signed = { rawTransaction: raw, transactionHash: tx.hash! }
          member.exposed = true
          member.syncApplied = true
          member.transactionSet!.inventoryApplied = true
          member.observation = {
            state: 'included-success',
            transactionHash: tx.hash!,
            blockHash: '0x' + '77'.repeat(32),
            blockNumber: 20,
            transactionIndex: old.nonce,
            feeWei: '21000000000000',
          }
          member.account = {
            blockHash: '0x' + '77'.repeat(32),
            blockNumber: 20,
            nonce: memberCount,
            balanceWei: row.members.at(-1)!.transactionSet!.balanceAfterWei,
          }
          operations.push({
            type: 'put',
            key: `consumed:${member.source.address}:${tx.nonce}`,
            value: row.operationId,
          })
        }
        const completion = {
          ...saved.originalCompletion,
          expectedOperationHash: evmNativeOperationDigest(row),
          ownerReference: `wallet-financial-sync:${row.operationId}`,
        }
        operations.push(
          {
            type: 'put',
            key: `history:${row.operationId}`,
            value: JSON.stringify(row),
          },
          {
            type: 'put',
            key: `completion:${row.operationId}`,
            value: JSON.stringify(completion),
          },
          {
            type: 'put',
            key: `preparation:${row.preparationId}`,
            value: row.operationId,
          }
        )
        if (n % 64 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve))
      }
      operations.push({
        type: 'put',
        key: 'manifest',
        value: JSON.stringify({
          version: 1,
          binding: saved.originalOperation.binding,
          nextSequence: count + 1,
          archivedCount: count,
          revision: 1,
        }),
      })
      await db.batch(operations)
      await db.close()
      journal = new EvmNativeOperationJournal({
        location: directory,
        binding: saved.originalOperation.binding,
      })
      const parse = jest.spyOn(JSON, 'parse')
      const get = jest.spyOn(require('levelup').prototype, 'get')
      const iterator = jest.spyOn(require('levelup').prototype, 'iterator')
      const measure = async (name: string, after?: string) => {
        parse.mockClear()
        get.mockClear()
        iterator.mockClear()
        const cpu = process.cpuUsage(),
          at = performance.now()
        let timerDelay = 0,
          maxTimerLag = 0,
          lastTick = performance.now()
        const probe = setInterval(() => {
          const now = performance.now()
          maxTimerLag = Math.max(maxTimerLag, now - lastTick - 1)
          lastTick = now
        }, 1)
        const timer = new Promise<void>((resolve) =>
          setTimeout(() => {
            timerDelay = performance.now() - at
            resolve()
          }, 0)
        )
        const page = await journal!.historyPage({
          limit: 16,
          background: true,
          memberBudget: 32,
          ...(after ? { after } : {}),
        })
        await timer
        clearInterval(probe)
        const used = process.cpuUsage(cpu)
        const result = {
          name,
          memberCount,
          historyRows: count,
          maxTimerLagMs: +maxTimerLag.toFixed(3),
          rows: page.operations.length,
          wallMs: +(performance.now() - at).toFixed(3),
          cpuMs: +((used.user + used.system) / 1000).toFixed(3),
          timerDelayMs: +timerDelay.toFixed(3),
          levelGets: get.mock.calls.length,
          levelIterators: iterator.mock.calls.length,
          jsonParses: parse.mock.calls.length,
        }
        console.log('ARCHIVED_HISTORY_MEASURE', JSON.stringify(result))
        return page
      }
      await journal.Open()
      // Open scans active rows only; immutable completed history is not materialized at open.
      expect(journal.list()).toEqual([])
      await measure('cold-prefix')
      await measure('warm-prefix-no-change')
      let after: string | undefined
      do {
        const page = await journal.historyPage({
          limit: 16,
          background: true,
          memberBudget: 32,
          ...(after ? { after } : {}),
        })
        after = page.next
      } while (after)
      await measure('post-sweep-prefix-no-change')
      const tail = `evm-native-v1:${(count - 16)
        .toString(16)
        .padStart(16, '0')}`
      await measure('post-sweep-tail')
      await measure('repeat-tail-no-change')
      parse.mockRestore()
      get.mockRestore()
      iterator.mockRestore()
    } finally {
      jest.restoreAllMocks()
      await journal?.Close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120000
)
