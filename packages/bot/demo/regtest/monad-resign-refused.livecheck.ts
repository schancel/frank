/**
 * A Send to Address transaction set the Monad node refuses is signed again at its nonce and
 * lands within seconds, on the local Monad network (monad-solonet). Not part of CI.
 *
 *   yarn --cwd packages/bot regtest:monad-resign-refused
 *
 * A Monad node admits a transaction against its sender's balance as it was about four blocks
 * back and refuses one that pays out of money younger than that ("Signer had insufficient
 * balance"); it then goes on refusing those exact bytes for minutes, long after the money has
 * matured (docs/protocol/chains/monad-reserve-balance.md, "Money that has just arrived"). In a
 * QA run a Send to Address out of a 20 MON account was refused and its bytes, offered again and
 * again, landed only ~520 blocks (seven minutes) later. The wallet now signs the same transaction
 * again at its nonce (only the tip one wei lower: `packages/wallet/chain/evm-refused-resign.ts`)
 * once the node has refused it twice over three seconds, and hands the node the new bytes.
 *
 * The wallet's own coin selection waits out a fresh deposit, so the refusal is made on purpose:
 * the wallet's real transaction-set code (coin list, journal, preparer, lifecycle, submission,
 * all on disk) is given a coin funded in the block before, and a Send to Address of 1 MON to the
 * faucet out of it is submitted at once to the real node. The host's poll is played by calling
 * `reconcileAuthorized` once a second. Checked:
 *   1. the node refused the first bytes;
 *   2. the refused member was signed again at the same nonce with the same recipient, value, gas
 *      limit and fee ceiling, and every member of the set landed, within seconds; the original
 *      bytes, offered again afterwards, are still refused (without signing again the send would
 *      still be waiting);
 *   3. every member landed once and nothing reverted: each nonce of each account was used once,
 *      the payment is exactly 1 MON to the faucet, and no fee exceeds what its first signing
 *      allowed.
 *
 * Every account it funds is swept back to the faucet at the end, also after a failure.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { formatEther, JsonRpcProvider, parseEther, Transaction, Wallet } from 'ethers'

import { EvmCoinList, type StoredEvmListCoin } from '@frank/wallet/evm-coin-list'
import { LevelRecordStore } from '@frank/wallet/storage/evm-coin-store'
import {
  EvmNativeOperationJournal,
  memberSignings,
} from '@frank/wallet/storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from '@frank/wallet/evm-transaction-set'
import { EvmTransactionSetLifecycle } from '@frank/wallet/evm-transaction-set-lifecycle'
import { createEvmTransactionSetSubmission } from '@frank/wallet/evm-transaction-set-submission'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from '@frank/wallet/evm-transaction-set-types'
import { fundFromFaucet, MONAD_REGTEST_CHAIN_ID, sweepToFaucet } from './monad-regtest'
import { SolonetKeyRun, sweepLeftoverKeyRuns } from './solonet-keys'

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
  const fundWei = parseEther(process.env.FRANK_RESIGN_FUND_MON ?? '20')
  const valueWei = parseEther('1')
  const problems: string[] = []
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) problems.push(what)
  }
  const provider = new JsonRpcProvider(RPC, MONAD_REGTEST_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  provider.pollingInterval = 250
  const location = await mkdtemp(join(tmpdir(), 'monad-resign-'))
  const source = new Wallet(Wallet.createRandom().privateKey)
  const change = new Map<number, Wallet>()
  // Every key this check funds is saved durably first (solonet-keys.ts), so a crash cannot strand it.
  const keys = SolonetKeyRun.open('resign-refused')
  await sweepLeftoverKeyRuns(RPC, keys)
  const remember = (key: Wallet) => {
    keys.save(key.privateKey)
    return key
  }
  remember(source)
  console.log(`keys this check funds are kept in ${keys.dir}`)
  const changeKey = (index: number) => {
    if (!change.has(index)) change.set(index, remember(new Wallet(Wallet.createRandom().privateKey)))
    return change.get(index)!
  }
  // What the node answered to each broadcast, by bytes.
  const handed: { raw: string; error?: string }[] = []
  const nodeView = provider
  const broadcast = provider.broadcastTransaction.bind(provider)
  nodeView.broadcastTransaction = async (raw: string) => {
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
    binding: { chainIdentifier: 'monad-regtest', nativeChainId: MONAD_REGTEST_CHAIN_ID.toString(), publicTuple: 'resign-livecheck' },
  })
  await journal.Open()
  try {
    // Monad's reserve and the spacing the wallet keeps under it (evm-transaction-set-policy.ts).
    const spendRule = { belowWei: parseEther('10'), waitBlocks: 3 }
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
        maxChangeOutputs: 4,
        head,
        spendRule,
      }),
      deriveChange: index => ({ account: changeKey(index).address, privateKey: changeKey(index).privateKey, changeIndex: index }),
    })
    const lifecycle = new EvmTransactionSetLifecycle({ authority: preparer, provider: nodeView, head: () => head })
    const submission = createEvmTransactionSetSubmission({
      preparer,
      lifecycle,
      provider: nodeView,
      refresh: async () => {
        head = await provider.getBlockNumber()
      },
      operations: () => journal.list(),
    })

    await fund(source.address, fundWei)
    const fundedAt = await provider.getBlockNumber()
    head = fundedAt
    await coins.put({ account: source.address, privateKey: source.privateKey, nonce: 0, valueWei: fundWei, origin: 'stealth' })
    const prepared = await preparer.constructLegacyTransactionSet({
      operationId: 'legacy-resign-livecheck',
      amountWei: valueWei,
      kdf: () => FAUCET.toLowerCase(),
    })
    const originals = new Set([...prepared.bundle, ...prepared.otherTransactions].map(member => member.rawTransaction))
    const first = await submission.sendTransaction(prepared)
    const refusedAt = await provider.getBlockNumber()
    const refused = handed.filter(item => item.error !== undefined && originals.has(item.raw))
    check(refused.length > 0, `the node refused the set's first bytes ${refusedAt - fundedAt} block(s) after the funding (${refused[0]?.error ?? `status ${first.status}`})`)
    const startedMs = Date.now()
    const deadline = startedMs + 180_000
    let status = first.status
    while (status !== 'confirmed' && Date.now() < deadline) {
      await sleep(1000)
      status = (await submission.reconcileAuthorized())[0]?.status ?? 'confirmed'
    }
    const row = (await preparer.readOperation('legacy-resign-livecheck'))!
    const landedBlocks: number[] = []
    for (const [index, member] of row.members.entries()) {
      const signings = memberSignings(member).reverse().map(signing => Transaction.from(signing.rawTransaction))
      const original = signings[0]!
      const receipts = (await Promise.all(signings.map(tx => provider.getTransactionReceipt(tx.hash!)))).filter(receipt => receipt !== null)
      const line = signings.map(tx => {
        const answers = handed.filter(item => item.raw === tx.serialized)
        return `${tx.hash!.slice(0, 10)} (type ${tx.type}, tip ${tx.maxPriorityFeePerGas ?? tx.gasPrice}; refused ${answers.filter(item => item.error).length}x, taken ${answers.filter(item => !item.error).length}x)`
      }).join(' -> ')
      console.log(`  member ${index} ${member.transactionSet?.role} ${original.from!.slice(0, 10)} nonce ${original.nonce}: ${line}${receipts[0] ? `; landed in block ${receipts[0].blockNumber}` : ''}`)
      check(receipts.length === 1 && receipts[0]!.status === 1, `member ${index} landed once and succeeded`)
      if (receipts[0]) landedBlocks.push(receipts[0].blockNumber)
      check(signings.every(tx =>
        tx.from === original.from && tx.nonce === original.nonce && tx.to === original.to &&
        tx.value === original.value && tx.gasLimit === original.gasLimit &&
        (tx.maxFeePerGas ?? tx.gasPrice) === (original.maxFeePerGas ?? original.gasPrice)),
        `every signing of member ${index} is the same transaction at the same nonce with the same fee ceiling`)
      if (receipts[0])
        check(receipts[0].gasUsed * receipts[0].gasPrice <= original.gasLimit * (original.maxFeePerGas ?? original.gasPrice)!,
          `member ${index} paid no more fee than its first signing allowed`)
      if (member.transactionSet?.role === 'payment')
        check(original.to?.toLowerCase() === FAUCET.toLowerCase() && original.value === valueWei, 'the payment is 1 MON to the faucet')
    }
    const resigned = row.members.filter(member => (member.earlierSignings?.length ?? 0) > 0)
    check(resigned.length > 0, `the refused member was signed again (${resigned.length} member(s))`)
    check(status === 'confirmed', `the whole set landed ${landedBlocks.length ? Math.max(...landedBlocks) - refusedAt : '?'} block(s) and ${Math.round((Date.now() - startedMs) / 1000)} s after the first refusal`)
    for (const member of resigned) {
      const original = member.earlierSignings![0]!.rawTransaction
      const answer = await provider.send('eth_sendRawTransaction', [original]).then(
        () => undefined,
        (error: { error?: { message?: string }; message?: string }) => error?.error?.message ?? error?.message ?? 'refused',
      )
      check(answer !== undefined, `its original bytes are still refused now (${answer ?? 'taken'}): without signing again the send would still be waiting`)
    }
    for (const account of new Set(row.members.map(member => member.source.address))) {
      const used = row.members.filter(member => member.source.address === account).length
      const nonce = await provider.getTransactionCount(account)
      check(nonce === used, `${account.slice(0, 10)} used each of its ${used} nonce(s) once (nonce now ${nonce})`)
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
    // The key files go once each account is empty; anything left stays for a later run.
    await keys.sweep(RPC).catch(error => console.log(`  the key-file sweep failed: ${error instanceof Error ? error.message : String(error)}`))
    keys.close()
    provider.destroy()
  }
  console.log(problems.length === 0 ? 'Monad re-sign check: OK' : `Monad re-sign check: FAILED (${problems.length})`)
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
