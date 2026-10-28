/**
 * Reserve-balance regression check for the wallet, on the local Monad network.
 *
 *   yarn --cwd packages/bot regtest:monad-reserve
 *
 * Monad reverts a transaction that leaves its sender under 10 MON when that sender had another
 * transaction in the same block or the two before it (docs/protocol/chains/monad-reserve-balance.md).
 * A reverted payment is still mined: the gas limit is paid, the nonce is used, no value moves.
 *
 * The check: a wallet whose main account holds 5 MON (under the reserve) and nothing else sends
 * several paid messages through the real relay, first one after another and then all at once. It
 * passes only if every message is delivered with its stamp paid on chain AND no transaction from
 * the wallet's accounts reverted.
 *
 * The wallet is ticked as the app and the bot host tick it (`tickUntilSettled`): on Monad the
 * change behind a delivered message goes out only on later ticks, and until it lands the wallet's
 * next paid send is refused with `FundsInPendingSendError` (owner ruling 2026-10-26: refused,
 * never queued). So in turn, each send follows the previous message's settling; at once, every
 * message is sent together and one the wallet refuses for that reason is sent again once the
 * wallet has settled, as a person does who is told "try again in a moment". Any other refusal,
 * or a message still refused after that many tries, fails the check.
 * Every transaction of the wallet's accounts is read from the chain itself, block by block, so a
 * revert the wallet did not report is still counted.
 *
 * It runs the wallet of the checkout it is in. To check another branch, run it from that
 * branch's checkout (the branch must contain the `monad-regtest` network, i.e. be rebased on a
 * main that has it); the solonet is shared, so nothing has to be restarted.
 *
 *   FRANK_RESERVE_MESSAGES   how many messages in each round (default 6)
 *   FRANK_RESERVE_FUND_MON   what the main account is given (default 5)
 */
import { formatEther, parseEther } from 'ethers'

import { checkStampOnChain } from '../two-wallets'
import { MONAD_REGTEST_MIN_STAMP_WEI, MonadRegtest } from './monad-regtest'
import { monadOf, openMonadWallet, returnToFaucet, tickUntilSettled } from './monad-wallets'
import { fundsInPendingSend } from '@frank/wallet/evm-transaction-set-types'
import { startRegtestStack } from './regtest-stack'
import { evmPaymentFloorWei } from '@frank/wallet/chain/payment-floor'

// The wallet refuses a stamp smaller than the fee of moving it (21,000 gas at the node's price),
// so the stamp sent here is that floor, read from the chain; never below the relay's minimum.
let STAMP_WEI = MONAD_REGTEST_MIN_STAMP_WEI

interface ChainTx {
  hash: string
  block: number
  from: string
  to: string
  valueWei: bigint
  status: number
}

/** Every transaction in blocks `from..to` sent by `root` or by an account `root` paid (and so
 * on): the wallet's main account and the stamp accounts it funds. */
async function walletTransactions(monad: MonadRegtest, root: string, from: number, to: number): Promise<ChainTx[]> {
  const ours = new Set([root.toLowerCase()])
  const found: ChainTx[] = []
  for (let start = from; start <= to; start += 25) {
    const numbers = Array.from({ length: Math.min(25, to - start + 1) }, (_, i) => start + i)
    const blocks = await Promise.all(numbers.map(number => monad.provider.getBlock(number, true)))
    for (const block of blocks) {
      for (const tx of block?.prefetchedTransactions ?? []) {
        if (!ours.has(tx.from.toLowerCase())) continue
        const receipt = await monad.provider.getTransactionReceipt(tx.hash)
        if (tx.to) ours.add(tx.to.toLowerCase())
        found.push({
          hash: tx.hash,
          block: block!.number,
          from: tx.from,
          to: tx.to ?? '(contract creation)',
          valueWei: tx.value,
          status: receipt?.status ?? -1,
        })
      }
    }
  }
  return found
}

async function main(): Promise<boolean> {
  const count = Number(process.env.FRANK_RESERVE_MESSAGES ?? '6')
  const fundWei = parseEther(process.env.FRANK_RESERVE_FUND_MON ?? '5')
  const stack = await startRegtestStack({ chains: ['monad-regtest'] })
  const problems: string[] = []
  try {
    const monad = monadOf(stack)
    const floor = evmPaymentFloorWei(BigInt(await monad.provider.send('eth_gasPrice', [])))
    if (floor > STAMP_WEI) STAMP_WEI = floor
    console.log(`stamp: ${formatEther(STAMP_WEI)} MON (the fee floor)`)
    const sender = await openMonadWallet(stack, 'sender', { stampValueWei: STAMP_WEI })
    const recipient = await openMonadWallet(stack, 'recipient', { stampValueWei: STAMP_WEI })
    await monad.fund(sender.mainAccount, fundWei)
    // Leave the funding more than three blocks behind, so only the wallet's own sends count.
    await monad.mine(6)
    const firstBlock = await monad.provider.getBlockNumber()
    console.log(
      `sender main account ${sender.mainAccount} holds ${formatEther(await monad.provider.getBalance(sender.mainAccount))} MON; sending ${count} paid messages in turn and then ${count} at once, from block ${firstBlock}`,
    )

    // One tick pass at a time: concurrent senders waiting to retry share it.
    let settling: Promise<number> | undefined
    const settle = () =>
      (settling ??= tickUntilSettled(sender).finally(() => {
        settling = undefined
      }))
    const sendOne = async (round: string, i: number) => {
      const text = `reserve check ${round} ${i}`
      const at = Date.now()
      try {
        let digest: string | undefined
        for (let attempt = 1; digest === undefined; attempt++) {
          try {
            digest = await sender.send(recipient.address, [{ type: 'text', text }], STAMP_WEI, 90_000)
          } catch (err) {
            // Refused only because an earlier message's change is not on the chain yet: nothing
            // was signed or recorded. Sent again once the wallet has settled.
            if (!fundsInPendingSend(err) || attempt > count + 1) throw err
            console.log(`${round} message ${i}: refused while an earlier send settles (try ${attempt}); again once settled`)
            await settle()
          }
        }
        const got = await recipient.receive(message => message.payloadDigest === digest, 60_000)
        const unpaid = await checkStampOnChain(monad.provider, got, STAMP_WEI)
        if (unpaid) problems.push(`${round} message ${i}: delivered, but ${unpaid}`)
        console.log(
          `${round} message ${i}: delivered after ${((Date.now() - at) / 1000).toFixed(1)} s${unpaid ? `, STAMP NOT PAID (${unpaid})` : ', stamp paid on chain'}`,
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        problems.push(`${round} message ${i}: not delivered (${reason})`)
        console.log(`${round} message ${i}: NOT DELIVERED after ${((Date.now() - at) / 1000).toFixed(1)} s: ${reason}`)
      }
    }
    const numbers = Array.from({ length: count }, (_, i) => i + 1)
    // One after another: each send starts once the one before is delivered and settled.
    for (const i of numbers) {
      await sendOne('in turn', i)
      await settle()
    }
    // All at once: what a person does who sends several messages without waiting.
    await Promise.all(numbers.map(i => sendOne('at once', i)))

    await monad.mine(4)
    const lastBlock = await monad.provider.getBlockNumber()
    const transactions = await walletTransactions(monad, sender.mainAccount, firstBlock, lastBlock)
    console.log(`the wallet's accounts sent ${transactions.length} transactions in blocks ${firstBlock}..${lastBlock}:`)
    let previous: Record<string, number> = {}
    for (const tx of transactions) {
      const gap = previous[tx.from] === undefined ? '' : ` (+${tx.block - previous[tx.from]} blocks after this account's previous one)`
      previous = { ...previous, [tx.from]: tx.block }
      console.log(
        `  block ${tx.block} ${tx.status === 1 ? 'ok      ' : 'REVERTED'} ${tx.from === sender.mainAccount ? 'main' : tx.from.slice(0, 10)} -> ${tx.to.slice(0, 10)} ${formatEther(tx.valueWei)} MON${gap}`,
      )
    }
    const reverted = transactions.filter(tx => tx.status !== 1)
    if (reverted.length > 0) {
      problems.push(`${reverted.length} of the wallet's ${transactions.length} transactions reverted: ${reverted.map(tx => `${tx.hash} (block ${tx.block})`).join(', ')}`)
    }
    console.log(`sender main account ends with ${formatEther(await monad.provider.getBalance(sender.mainAccount))} MON`)
  } finally {
    // Test funds come back: the wallets' keys are in the stack's directory, which stop() deletes.
    try {
      const { returnedWei, leftWei, unswept } = await returnToFaucet(stack)
      if (unswept === 0) stack.fundsReturned()
      console.log(`returned ${formatEther(returnedWei)} MON to the faucet; ${formatEther(leftWei)} MON left as dust or unsweepable`)
    } catch (error) {
      console.log(`the sweep back to the faucet failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await stack.stop()
    }
  }
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  console.log(problems.length === 0 ? 'Monad reserve check: OK (every message delivered and paid, no reverted transaction)' : 'Monad reserve check: FAILED')
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
