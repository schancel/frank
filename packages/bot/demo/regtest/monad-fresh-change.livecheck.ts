/**
 * A send made right after a send that left 10 MON or more of change is paid out of that change
 * only once the node will take it, on the local Monad network (monad-solonet). Not part of CI.
 *
 *   yarn --cwd packages/bot regtest:monad-fresh-change
 *
 * The Monad node judges a transaction against its sender's balance of about four blocks back
 * (`spendSpacingBlocks + 1`, `packages/wallet/chain/evm-spend-rule.ts`) and refuses one that pays
 * out of younger money, whatever the amount (docs/protocol/chains/monad-reserve-balance.md,
 * "Money that has just arrived"). Change used to be listed as spendable at once when it was 10 MON
 * or more, so the next send was refused first and recovered only by signing again
 * (`regtest:monad-resign-refused`).
 *
 * The wallet's real transaction-set code (coin list, journal, preparer, lifecycle, submission, on
 * disk) holds one settled 30 MON coin. A first send of 1 MON to the faucet leaves one change coin
 * of about 29 MON. As soon as the wallet has recorded that change, a second send of 1 MON is made
 * from it the way the app makes one (`constructWhenSpendable`: wait for the block the coin
 * may be spent from, refresh, construct). Checked:
 *   1. the change is 10 MON or more and is the only coin of the wallet;
 *   2. the second send is paid from the change, constructed no sooner than four blocks after the
 *      change's block;
 *   3. the node took every byte of the second send the first time it was offered: no refusal,
 *      nothing signed again, every member landed and succeeded.
 *
 * Every key it funds is written to `FRANK_LIVECHECK_KEYS_FILE` (default: the OS temp folder)
 * before it is funded, and swept back to the faucet at the end, also after a failure.
 */
import { appendFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { formatEther, JsonRpcProvider, parseEther, Transaction, Wallet } from 'ethers'

import { EvmCoinList, type StoredEvmListCoin } from '@frank/wallet/evm-coin-list'
import { LevelRecordStore } from '@frank/wallet/storage/evm-coin-store'
import { EvmNativeOperationJournal } from '@frank/wallet/storage/evm-native-operation-journal'
import { constructWhenSpendable, EvmTransactionSetPreparer } from '@frank/wallet/evm-transaction-set'
import { EvmTransactionSetLifecycle } from '@frank/wallet/evm-transaction-set-lifecycle'
import { createEvmTransactionSetSubmission } from '@frank/wallet/evm-transaction-set-submission'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from '@frank/wallet/evm-transaction-set-types'
import { fundsSettleBlocks } from '@frank/wallet/chain/evm-spend-rule'
import { fundFromFaucet, MONAD_REGTEST_CHAIN_ID, sweepToFaucet } from './monad-regtest'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const RPC = process.env.FRANK_SOLONET_RPC_URL ?? 'http://127.0.0.1:48080'
const FAUCET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/** The faucet is shared with whatever else runs on the lab: a payment that loses its nonce to
 * another one is tried again. */
async function fund(address: string, amount: bigint): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fundFromFaucet(address, amount, RPC)
      return
    } catch (error) {
      if (attempt >= 5) throw error
      await sleep(1000)
    }
  }
}

async function main(): Promise<boolean> {
  const fundWei = parseEther(process.env.FRANK_FRESH_CHANGE_FUND_MON ?? '30')
  const valueWei = parseEther('1')
  const problems: string[] = []
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) problems.push(what)
  }
  const provider = new JsonRpcProvider(RPC, MONAD_REGTEST_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  provider.pollingInterval = 250
  const location = await mkdtemp(join(tmpdir(), 'monad-fresh-change-'))
  const keysFile = process.env.FRANK_LIVECHECK_KEYS_FILE ?? join(tmpdir(), 'monad-fresh-change-livecheck-keys.txt')
  const remember = (key: Wallet) => {
    appendFileSync(keysFile, `${key.privateKey}\n`)
    return key
  }
  const source = remember(new Wallet(Wallet.createRandom().privateKey))
  console.log(`keys this check funds are kept in ${keysFile}`)
  const change = new Map<number, Wallet>()
  const changeKey = (index: number) => {
    if (!change.has(index)) change.set(index, remember(new Wallet(Wallet.createRandom().privateKey)))
    return change.get(index)!
  }
  // What the node answered to each broadcast, by bytes.
  const handed: { raw: string; error?: string }[] = []
  const broadcast = provider.broadcastTransaction.bind(provider)
  provider.broadcastTransaction = async (raw: string) => {
    const entry: { raw: string; error?: string } = { raw }
    handed.push(entry)
    try {
      return await broadcast(raw)
    } catch (error) {
      const raised = error as { error?: { message?: string }; message?: string }
      entry.error = raised?.error?.message ?? raised?.message ?? String(error)
      throw error
    }
  }
  let head = await provider.getBlockNumber()
  const gasPriceWei = BigInt(await provider.send('eth_gasPrice', []))
  const store = await LevelRecordStore.open<StoredEvmListCoin>(location, 'inventory')
  const coins = await EvmCoinList.open(store)
  const journal = new EvmNativeOperationJournal({
    location,
    binding: { chainIdentifier: 'monad-regtest', nativeChainId: MONAD_REGTEST_CHAIN_ID.toString(), publicTuple: 'fresh-change-livecheck' },
  })
  await journal.Open()
  try {
    // Monad's reserve and spacing as the registry configures them (chains-registry.ts).
    const spendRule = { belowWei: parseEther('10'), waitBlocks: 3 }
    const settle = fundsSettleBlocks(spendRule.waitBlocks)
    const preparer = new EvmTransactionSetPreparer({
      coins,
      journal,
      recoverySpendRule: spendRule,
      policy: () => ({
        sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
        gasPriceWei,
        paymentGasLimit: () => 21000n,
        changeGasLimit: 21000n,
        paymentFeeIsExact: true,
        dustWei: 10n * 21000n * gasPriceWei,
        radix: 2,
        jitterBps: 0,
        // One change output, so the change is one coin well above the reserve.
        maxChangeOutputs: 1,
        head,
        spendRule,
      }),
      deriveChange: index => ({ account: changeKey(index).address, privateKey: changeKey(index).privateKey, changeIndex: index }),
    })
    const lifecycle = new EvmTransactionSetLifecycle({ authority: preparer, provider, head: () => head })
    const refresh = async () => {
      head = await provider.getBlockNumber()
    }
    const submission = createEvmTransactionSetSubmission({
      preparer,
      lifecycle,
      provider,
      refresh,
      operations: () => journal.list(),
    })
    const untilBlock = async (block: number) => {
      while ((await provider.getBlockNumber()) < block) await sleep(100)
    }
    /** Reconciles every 250 ms until `done` holds or two minutes pass. */
    const reconcileUntil = async (done: (statuses: string[]) => boolean) => {
      const deadline = Date.now() + 120_000
      for (;;) {
        await refresh()
        const statuses = (await submission.reconcileAuthorized()).map(result => result.status)
        if (process.env.FRANK_LIVECHECK_DEBUG) console.log(`  head ${head}: ${statuses.join(',')}; offered ${handed.length}, refused ${handed.filter(item => item.error).length} ${handed.find(item => item.error)?.error ?? ''}`)
        if (done(statuses) || Date.now() > deadline) return statuses
        await sleep(250)
      }
    }
    const listedChange = () =>
      coins.all().find(coin => coin.origin === 'change' && coin.state === 'unspent' && coin.valueWei > 0n)

    await fund(source.address, fundWei)
    const fundedAt = await provider.getBlockNumber()
    // The deposit itself is fresh money too: list it as the coin-list sync would.
    await coins.put({ account: source.address, privateKey: source.privateKey, nonce: 0, valueWei: fundWei, origin: 'stealth', spendableFromBlock: fundedAt + settle })
    await refresh()
    const firstSet = await constructWhenSpendable(
      () => preparer.constructTransactionSet({ operationId: 'fresh-change-first', amountWei: valueWei, kdf: () => FAUCET.toLowerCase() }),
      { untilBlock, refresh },
    )
    console.log(`  first send: ${(await submission.sendTransaction(firstSet)).status}`)
    // The next send starts the moment the wallet has recorded the change, as a user's would.
    await reconcileUntil(() => listedChange() !== undefined)
    const changeCoin = listedChange()
    const changeMember = (await preparer.readOperation('fresh-change-first'))!.members.find(member => member.transactionSet?.role === 'change')!
    const changeBlock = (await provider.getTransactionReceipt(changeMember.signed!.transactionHash))?.blockNumber
    await refresh()
    const others = coins.all().filter(coin => coin.state === 'unspent' && coin.valueWei > 0n && coin !== changeCoin)
    check(changeCoin !== undefined && changeCoin.valueWei >= spendRule.belowWei && others.length === 0,
      `the wallet's only coin is change of ${changeCoin ? formatEther(changeCoin.valueWei) : '?'} MON (10 MON or more)`)
    console.log(`  change mined in block ${changeBlock}; listed spendable from ${changeCoin?.spendableFromBlock}; head when listed ${head}`)

    let constructedAt: number | undefined
    const secondSet = await constructWhenSpendable(
      async () => {
        const set = await preparer.constructTransactionSet({ operationId: 'fresh-change-second', amountWei: valueWei, kdf: () => FAUCET.toLowerCase() })
        constructedAt = head
        return set
      },
      { untilBlock, refresh },
    )
    check(secondSet.bundle.every(tx => tx.sourceAccount === changeCoin?.account),
      'the second send is paid from the change')
    check(changeBlock !== undefined && constructedAt !== undefined && constructedAt >= changeBlock + settle,
      `the second send was constructed ${constructedAt !== undefined && changeBlock !== undefined ? constructedAt - changeBlock : '?'} block(s) after the change's block (at least ${settle})`)
    const secondBytes = new Set([...secondSet.bundle, ...secondSet.otherTransactions].map(tx => tx.rawTransaction))
    await submission.sendTransaction(secondSet)
    const statuses = await reconcileUntil(all => all.every(status => status === 'confirmed'))
    const status = statuses.every(each => each === 'confirmed') ? 'confirmed' : statuses.join(',')
    const answers = handed.filter(item => secondBytes.has(item.raw))
    const refusals = answers.filter(item => item.error !== undefined)
    check(answers.length > 0 && refusals.length === 0,
      `the node took the second send's bytes the first time (${answers.length} offered, ${refusals.length} refused${refusals[0] ? `: ${refusals[0].error}` : ''})`)
    const row = (await preparer.readOperation('fresh-change-second'))!
    check(row.members.every(member => (member.earlierSignings?.length ?? 0) === 0), 'nothing of the second send was signed again')
    check(status === 'confirmed', 'the second send landed')
    for (const [index, member] of row.members.entries()) {
      const receipt = await provider.getTransactionReceipt(Transaction.from(member.signed!.rawTransaction).hash!)
      check(receipt?.status === 1, `second send member ${index} (${member.transactionSet?.role}) landed and succeeded`)
    }
  } finally {
    await journal.Close()
    await store.close()
    await rm(location, { recursive: true, force: true })
    // Monad refuses to empty an account within a few blocks of its last transaction.
    const until = (await provider.getBlockNumber()) + 6
    while ((await provider.getBlockNumber()) < until) await sleep(300)
    let returned = 0n
    for (const key of [source, ...change.values()]) {
      const held = await provider.getBalance(key.address)
      const hash = await sweepToFaucet(key.privateKey, RPC).catch(error => {
        console.log(`  could not sweep ${key.address}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      if (hash) returned += held
    }
    const left = (await Promise.all([source, ...change.values()].map(key => provider.getBalance(key.address)))).reduce((a, b) => a + b, 0n)
    console.log(`returned about ${formatEther(returned)} MON to the faucet; ${formatEther(left)} MON left as dust`)
    provider.destroy()
  }
  console.log(problems.length === 0 ? 'Monad fresh-change check: OK' : `Monad fresh-change check: FAILED (${problems.length})`)
  return problems.length === 0
}

if (require.main === module) {
  main().then(
    ok => process.exit(ok ? 0 : 1),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
