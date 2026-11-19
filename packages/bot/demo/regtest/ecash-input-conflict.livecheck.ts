/**
 * Two devices of one eCash account spend the same coin, on a real Bitcoin ABC regtest node with
 * Chronik (issue 2089). No fake chain. Each device is its own `EcashWallet` with its own operation
 * store; they share only the seed and the chain.
 *
 *   yarn --cwd packages/bot regtest:ecash-input-conflict
 *
 * Needs a Chronik-enabled `bitcoind` (FRANK_BITCOIN_ABC_BIN_DIR, or `yarn --cwd packages/bot
 * regtest:fetch`). The Jest wrapper `ecash-input-conflict.regtest.jest.test.ts` runs this file.
 *
 * A single regtest node has no Avalanche quorum, so "final" here is one confirmation (the
 * wallet's regtest rule, `ecashFinality`), as in the HTLC swap regtest.
 *
 * Checks, in order:
 *   1. The account holds two coins. Device 1 signs a payment from one of them; before it is
 *      broadcast, device 2 signs a larger payment that needs both, so both pick the same coin.
 *   2. Device 1's payment is broadcast; device 2's is refused. Device 2's operation stays
 *      unresolved and holds both inputs: a refused broadcast, or a conflicting spend that is only
 *      in the mempool, proves nothing.
 *   3. Device 1's payment is mined (final). Device 2 reconciles its operation as conflicted, with
 *      device 1's txid recorded; its other coin is released and counted again.
 *   4. Device 2 restarted keeps the conflicted state and never broadcasts those bytes again.
 *   5. Device 2 retries the same intent with fresh inputs (its other coin among them); it lands.
 *      The payee got each payment exactly once; the conflicted bytes never reached the chain.
 */
import assert from 'assert/strict'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ChronikClient } from 'chronik-client'
import { Address } from 'ecash-lib/dist/address/address'
import { InMemoryNativeTransactionAttemptStore, NativeTransactionSubmissionError } from '@frank/wallet/chain/chain-wallet'
import { InMemoryEcashOperationStore } from '@frank/wallet/ecash-operation-store'
import { EcashWallet } from '@frank/wallet/ecash-wallet'

import { ECASH_REGTEST_CHAIN, startEcashRegtest, type EcashRegtest } from './ecash-regtest'
import { sleep } from './regtest-chain'

const CHAIN = ECASH_REGTEST_CHAIN
const COIN = 600_000n
const FIRST = 300_000n
const SECOND = 700_000n

export async function ecashInputConflictCheck(xec: EcashRegtest): Promise<string[]> {
  const steps: string[] = []
  const step = (line: string) => {
    steps.push(line)
    console.log(`ok - ${line}`)
  }
  const chronik = new ChronikClient([xec.chronikUrl])
  let broadcasts = 0
  /** One device: its own attempt and operation stores (unless reopened), nothing else shared. */
  const open = (
    root: Uint8Array,
    stores = { attempts: new InMemoryNativeTransactionAttemptStore(), operations: new InMemoryEcashOperationStore() },
  ) =>
    EcashWallet.fromDomainRoot({
      domainRoot: { registry: 'frank-domain-roots-v1', purpose: 'ecash-bch-wallet', bytes: Uint8Array.from(root) },
      networkId: CHAIN,
      checkpoint: xec.checkpoint,
      chronik,
      nativeAttemptStore: stores.attempts,
      operationStore: stores.operations,
      getTransactionStatus: async transaction => {
        try {
          return (await chronik.tx(transaction.txHash)).block === undefined ? 'pending' : 'confirmed'
        } catch {
          return 'unknown'
        }
      },
      rebroadcast: async raws => {
        broadcasts++
        for (const raw of raws) await chronik.broadcastTx(raw)
      },
    }).then(wallet => ({ wallet, stores }))
  const waitFor = async <T>(label: string, read: () => Promise<T | undefined>): Promise<T> => {
    let last: unknown
    for (let i = 0; i < 100; i++) {
      const value = await read().catch(error => {
        last = error
        return undefined
      })
      if (value !== undefined) return value
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`)
  }
  const balanceOf = (wallet: EcashWallet, expected: bigint, label: string) =>
    waitFor(label, async () => ((await wallet.getBalance()) === expected ? expected : undefined)).catch(async error => {
      throw new Error(`${error.message} (expected ${expected}, saw ${await wallet.getBalance()})`)
    })
  const key = (input: { txid: string; vout: number }) => `${input.txid}:${input.vout}`
  const onChain = (txid: string) => chronik.tx(txid).then(
    tx => tx,
    () => undefined,
  )

  const root = new Uint8Array(randomBytes(32))
  const device1 = (await open(root)).wallet
  const device2Opened = await open(root)
  const device2 = device2Opened.wallet
  const payee = (await (await open(new Uint8Array(randomBytes(32)))).wallet.getReceiveAddress()).raw

  // 1. Two coins; both devices sign a payment that takes the same one.
  const address = (await device1.getReceiveAddress()).raw
  await xec.fund(address, COIN)
  await xec.fund(address, COIN)
  await balanceOf(device1, 2n * COIN, 'device 1 sees both coins')
  await balanceOf(device2, 2n * COIN, 'device 2 sees both coins')
  const first = await device1.prepareNativeOperation({ operationId: 'conflict:first', recipient: { raw: payee }, value: FIRST })
  const second = await device2.prepareNativeOperation({ operationId: 'conflict:second', recipient: { raw: payee }, value: SECOND })
  assert.equal(first.inputs.length, 1, 'device 1 pays from one coin')
  assert.equal(second.inputs.length, 2, 'device 2 needs both coins')
  const shared = second.inputs.find(input => key(input) === key(first.inputs[0]))
  assert.ok(shared, 'both devices picked the same coin')
  const other = second.inputs.find(input => key(input) !== key(first.inputs[0]))!
  step('two devices of one seed each signed a payment from the same coin')

  // 2. Device 1's payment goes out; device 2's is refused and stays unresolved.
  const firstTxid = (await device1.submitNativeOperation(first.operationId)).txHash
  await waitFor('device 1 payment in the mempool', () => onChain(firstTxid))
  await assert.rejects(device2.submitNativeOperation(second.operationId), NativeTransactionSubmissionError)
  assert.equal((await device2.reconcileNativeOperation(second.operationId)).state, 'exposed')
  await assert.rejects(device2.finishInterruptedSend(), AggregateError)
  const firstChange = COIN - FIRST - BigInt(first.fee)
  // Device 2 holds both of its inputs; the spent coin is gone, device 1's change is unclaimed.
  await balanceOf(device2, firstChange, 'device 2 holds both inputs while unresolved')
  step('device 2 broadcast was refused; while device 1 spend is only in the mempool its operation stays unresolved and holds both inputs')

  // 3. Device 1's payment is final: device 2's bytes can never land.
  await xec.mine(1)
  assert.ok((await onChain(firstTxid))?.block, 'device 1 payment is mined')
  const conflicted = await device2.reconcileNativeOperation(second.operationId)
  assert.equal(conflicted.state, 'conflicted')
  assert.deepEqual(conflicted.conflict, { input: { txid: shared.txid, vout: shared.vout }, spentBy: firstTxid })
  await balanceOf(device2, firstChange + COIN, 'device 2 counts its released coin again')
  await device2.finishInterruptedSend()
  step(`device 2 reconciled its operation as conflicted by ${firstTxid.slice(0, 12)}…; its other coin is released`)

  // 4. Restart keeps the terminal state; nothing is broadcast again.
  const restartedBroadcasts = broadcasts
  const restarted = (await open(root, device2Opened.stores)).wallet
  await restarted.finishInterruptedSend()
  const kept = restarted.getEcashOperations().find(op => op.operationId === second.operationId)!
  assert.equal(kept.state, 'conflicted')
  assert.deepEqual(kept.conflict, conflicted.conflict)
  assert.equal(broadcasts, restartedBroadcasts, 'the conflicted bytes are never broadcast again')
  await assert.rejects(restarted.submitNativeOperation(second.operationId), /never land/)
  step('device 2 restarted keeps the conflicted state and never rebroadcasts it')

  // 5. The same intent, retried from fresh inputs, lands; nothing is paid twice.
  const retried = await restarted.retryConflictedNativeOperation(second.operationId)
  assert.equal(retried.state, 'prepared')
  assert.deepEqual(retried.intent, second.intent)
  assert.ok(retried.inputs.some(input => key(input) === key(other)), 'the released coin funds the retry')
  assert.ok(!retried.inputs.some(input => key(input) === key(shared)))
  const retriedTxid = (await restarted.submitNativeOperation(second.operationId)).txHash
  await xec.mine(1)
  assert.equal((await restarted.reconcileNativeOperation(second.operationId)).state, 'confirmed')
  assert.equal(await onChain(second.transactions[0].txid), undefined, 'the conflicted bytes never reached the chain')
  const received = (await chronik.script('p2pkh', Address.fromCashAddress(payee).hash).utxos()).utxos
  assert.deepEqual(
    received.map(utxo => [utxo.outpoint.txid, utxo.sats]).sort(),
    [
      [firstTxid, FIRST],
      [retriedTxid, SECOND],
    ].sort(),
    'the payee got each payment exactly once',
  )
  await balanceOf(restarted, 2n * COIN - FIRST - SECOND - BigInt(first.fee) - BigInt(retried.fee), 'device 2 after the retry')
  step('device 2 retried the same intent from fresh inputs; the payee got each payment exactly once')
  return steps
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'frank-ecash-input-conflict-'))
  // Blocks only when the check mines.
  const xec = await startEcashRegtest({ stateDir, blockIntervalMs: 24 * 3600_000 })
  try {
    const steps = await ecashInputConflictCheck(xec)
    console.log(`eCash input-conflict regtest: OK (${steps.length} checks)`)
  } finally {
    await xec.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
