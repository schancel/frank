/**
 * Two devices of one eCash account on a real Bitcoin ABC regtest node with Chronik (issue 2084).
 * No fake chain. Each device is its own `EcashWallet` with its own operation store; the only
 * thing they share is the seed (here the eCash domain root) and the chain.
 *
 *   yarn --cwd packages/bot regtest:ecash-shared-seed
 *
 * Needs a Chronik-enabled `bitcoind` (FRANK_BITCOIN_ABC_BIN_DIR, or `yarn --cwd packages/bot
 * regtest:fetch`). The Jest wrapper `ecash-shared-seed.regtest.jest.test.ts` runs this file.
 *
 * Checks, in order:
 *   1. Devices 1 and 2 open from the same seed before any coin exists. Device 1 is funded and
 *      pays three times; each payment spends the previous change, so the account's only coin
 *      ends on change address 1/2, which device 2 never allocated. The third payment is left
 *      unconfirmed.
 *   2. Device 2, still open, sees the full balance while that change is still in the mempool.
 *   3. Device 2 pays twice, the second spending the first's change: its change goes to 1/3 and
 *      then 1/4, addresses neither device used before. Device 1 had allocated up to 1/3 itself,
 *      so 1/4 is beyond its own indices.
 *   4. Device 1, still open, sees device 2's change on 1/4 while it is still unconfirmed.
 *   5. Device 1 restarted with a wiped operation store sees the same balance and spends it.
 */
import assert from 'assert/strict'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ChronikClient } from 'chronik-client'
import { Address } from 'ecash-lib/dist/address/address'
import { InMemoryNativeTransactionAttemptStore } from '@frank/wallet/chain/chain-wallet'
import { InMemoryEcashOperationStore } from '@frank/wallet/ecash-operation-store'
import { EcashWallet } from '@frank/wallet/ecash-wallet'

import { ECASH_REGTEST_CHAIN, startEcashRegtest, type EcashRegtest } from './ecash-regtest'
import { sleep } from './regtest-chain'

const CHAIN = ECASH_REGTEST_CHAIN
const FUNDING = 1_000_000n

interface VerboseTx {
  txid: string
  vout: Array<{ n: number; value: number; scriptPubKey: { hex: string } }>
}

export async function ecashSharedSeedCheck(xec: EcashRegtest): Promise<string[]> {
  const steps: string[] = []
  const step = (line: string) => {
    steps.push(line)
    console.log(`ok - ${line}`)
  }
  const chronik = new ChronikClient([xec.chronikUrl])
  /** One device: its own attempt and operation stores, nothing shared but the seed. */
  const open = (root: Uint8Array) =>
    EcashWallet.fromDomainRoot({
      domainRoot: {
        registry: 'frank-domain-roots-v1',
        purpose: 'ecash-bch-wallet',
        bytes: Uint8Array.from(root),
      },
      networkId: CHAIN,
      checkpoint: xec.checkpoint,
      chronik,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      operationStore: new InMemoryEcashOperationStore(),
      rebroadcast: async raws => {
        for (const raw of raws) await chronik.broadcastTx(raw)
      },
    })
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
    waitFor(label, async () => {
      const balance = await wallet.getBalance()
      return balance === expected ? balance : undefined
    }).catch(async error => {
      throw new Error(`${error.message} (expected ${expected}, saw ${await wallet.getBalance()})`)
    })
  const inMempool = async (txid: string) => (await xec.rpc<string[]>('getrawmempool')).includes(txid)

  const root = new Uint8Array(randomBytes(32))
  const device1 = await open(root)
  const device2 = await open(root)
  const payee = (await (await open(new Uint8Array(randomBytes(32)))).getReceiveAddress()).raw
  const payeeScript = Address.fromCashAddress(payee).toScript().toHex()

  let expected = FUNDING
  /** Change scripts of every payment so far, in order: no device may reuse one. */
  const changeScripts: string[] = []
  /** Pays the payee; `mine: false` leaves the payment in the mempool. */
  const pay = async (wallet: EcashWallet, value: bigint, label: string, mine = true) => {
    const operationId = `shared-seed:${randomBytes(16).toString('hex')}`
    const operation = await wallet.prepareNativeOperation({ operationId, recipient: { raw: payee }, value })
    const sent = await wallet.submitNativeOperation(operationId)
    // Read while it is in the mempool: the node keeps no txindex.
    const tx = await waitFor(`${label} in the mempool`, () =>
      xec.rpc<VerboseTx>('getrawtransaction', [sent.txHash, true]),
    )
    const change = tx.vout.filter(output => output.scriptPubKey.hex !== payeeScript)
    assert.equal(change.length, 1, `${label}: one change output`)
    assert.ok(!changeScripts.includes(change[0].scriptPubKey.hex), `${label}: change goes to a fresh address`)
    changeScripts.push(change[0].scriptPubKey.hex)
    assert.equal(operation.inputs.length, 1, `${label}: spends the single coin the account holds`)
    expected -= value + BigInt(operation.fee)
    if (mine) await xec.mine(1)
    return { operation, txid: sent.txHash, changeScript: change[0].scriptPubKey.hex }
  }

  // 1. Device 1 is funded and pays three times, each spending the previous change.
  await xec.fund((await device1.getReceiveAddress()).raw, FUNDING)
  await balanceOf(device1, FUNDING, 'device 1 funding')
  await pay(device1, 100_000n, 'device 1 payment 1')
  await balanceOf(device1, expected, 'device 1 after payment 1')
  await pay(device1, 100_000n, 'device 1 payment 2')
  await balanceOf(device1, expected, 'device 1 after payment 2')
  const third = await pay(device1, 100_000n, 'device 1 payment 3', false)
  step(`device 1 paid three times; the account's ${expected} sats sit on its third change address`)

  // 2. Device 2 opened before any of that and never allocated those change addresses.
  await balanceOf(device2, expected, 'device 2 balance from the same seed')
  assert.ok(await inMempool(third.txid), 'device 1 change is still unconfirmed')
  step(`device 2 of the same seed (separate operation store) sees the full ${expected} sats from unconfirmed change`)
  await xec.mine(1)

  // 3. Device 2 spends that change twice over; its second change lands on 1/4.
  await pay(device2, expected / 2n + 1n, 'device 2 payment 1')
  await balanceOf(device2, expected, 'device 2 after payment 1')
  const fourth = await pay(device2, 50_000n, 'device 2 payment 2', false)
  await balanceOf(device2, expected, 'device 2 after payment 2')
  step(`device 2 spent device 1's change, then its own; each change on a fresh address`)

  // 4. Device 1, still running, has allocated change only up to 1/3: 1/4 needs discovery.
  await balanceOf(device1, expected, 'device 1 sees device 2 change')
  assert.ok(await inMempool(fourth.txid), 'device 2 change is still unconfirmed')
  step(`device 1 sees device 2's unconfirmed change beyond its own change index: both report ${expected} sats`)
  await xec.mine(1)

  // 5. Device 1 restarts with a wiped operation store.
  const restarted = await open(root)
  await balanceOf(restarted, expected, 'restarted device 1 balance')
  await pay(restarted, 50_000n, 'restarted device 1 payment')
  await balanceOf(restarted, expected, 'restarted device 1 after its payment')
  await balanceOf(device2, expected, 'device 2 sees the restarted device change')
  step(`device 1 restarted with a wiped operation store sees ${expected} sats and spends from them`)
  return steps
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'frank-ecash-shared-seed-'))
  // Blocks only when the check mines.
  const xec = await startEcashRegtest({ stateDir, blockIntervalMs: 24 * 3600_000 })
  try {
    const steps = await ecashSharedSeedCheck(xec)
    console.log(`eCash shared-seed regtest: OK (${steps.length} checks)`)
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
