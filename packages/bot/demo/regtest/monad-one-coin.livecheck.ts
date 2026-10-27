/**
 * A wallet whose whole balance is ONE coin below Monad's reserve pays through the real relay, on
 * the local Monad network (monad-solonet). Not part of CI.
 *
 *   yarn --cwd packages/bot regtest:monad-one-coin
 *
 * The owner's two-nonce ruling (2026-10-26): on an account-based chain a one-coin wallet funds
 * its message's stamp at the account's lower nonce, before the relay has the message, and the
 * payment the message carries (a contact transfer) goes out at the next nonce, only after the
 * relay stored the message. No self-payment round trip, no consolidation.
 *
 * Checked, each from a fresh wallet funded once from the faucet (one coin, FRANK_ONE_COIN_FUND_MON,
 * default 1 MON, under the 10 MON reserve):
 *   1. Send to Contact with a stamp: delivered and paid; the stamp's funding is the account's
 *      first transaction, broadcast before the relay stored the message; the contact transfer is
 *      the next nonce, broadcast only after, mined at least 3 blocks after the funding; no
 *      transaction of the wallet reverted.
 *   2. A paid direct message (a stamp only): delivered and its stamp paid on the chain, no
 *      broadcast of the stamp before the relay stored the message, nothing reverted.
 *
 * Every wallet's funds go back to the faucet at the end, also after a failure (`returnToFaucet`).
 */
import { formatEther, parseEther, Transaction } from 'ethers'

import { checkStampOnChain } from '../two-wallets'
import type { RealWallet } from '../real-stack'
import { MONAD_REGTEST_MIN_STAMP_WEI } from './monad-regtest'
import { monadOf, openMonadWallet, returnToFaucet } from './monad-wallets'
import { startRegtestStack } from './regtest-stack'
import { evmPaymentFloorWei } from '@frank/wallet/chain/payment-floor'
import { ContactPaymentPendingError } from '@frank/wallet/chain/chain-wallet'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Every broadcast `wallet` makes, with when it made it. */
function recordBroadcasts(wallet: RealWallet): { hash: string; atMs: number }[] {
  const seen: { hash: string; atMs: number }[] = []
  const provider = wallet.handle.provider
  const real = provider.broadcastTransaction.bind(provider)
  provider.broadcastTransaction = async (raw: string) => {
    seen.push({ hash: Transaction.from(raw).hash!, atMs: Date.now() })
    return real(raw)
  }
  return seen
}

async function main(): Promise<boolean> {
  const fundWei = parseEther(process.env.FRANK_ONE_COIN_FUND_MON ?? '1')
  const stack = await startRegtestStack({ chains: ['monad-regtest'] })
  const problems: string[] = []
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) problems.push(what)
  }
  try {
    const monad = monadOf(stack)
    const floor = evmPaymentFloorWei(BigInt(await monad.provider.send('eth_gasPrice', [])))
    const stampWei = floor > MONAD_REGTEST_MIN_STAMP_WEI ? floor : MONAD_REGTEST_MIN_STAMP_WEI
    const valueWei = 10n * stampWei
    console.log(`stamp ${formatEther(stampWei)} MON, contact payment ${formatEther(valueWei)} MON, one coin of ${formatEther(fundWei)} MON`)
    const recipient = await openMonadWallet(stack, 'recipient', { stampValueWei: stampWei })

    // 1. Send to Contact from one coin.
    {
      const sender = await openMonadWallet(stack, 'contact-sender', { stampValueWei: stampWei })
      await monad.fund(sender.mainAccount, fundWei)
      // The deposit is spendable once it is older than the spacing window.
      await monad.mine(6)
      const main = sender.mainAccount.toLowerCase()
      const startNonce = await monad.provider.getTransactionCount(main)
      const broadcasts = recordBroadcasts(sender)
      const sent = await sender.handle.sendToContact!({ recipient: { raw: recipient.address }, value: valueWei })
        .catch(error => error)
      if (!(sent && 'txHash' in sent) && !(sent instanceof ContactPaymentPendingError)) throw sent
      const deadline = Date.now() + 180_000
      for (;;) {
        await sender.handle.resumeContactPayments!()
        if (sender.handle.getContactPayments!()[0]?.state === 'paid') break
        if (Date.now() > deadline) throw new Error('the contact payment was not paid within 180 s')
        await sleep(2000)
      }
      const [payment] = sender.handle.getContactPayments!()
      const got = await recipient.receive(message => message.messageId === payment.messageId, 60_000)
      const operation = sender.handle.getNativeOperations!()
        .find(row => row.members.some(member => member.signed?.transactionHash === payment.txHash))!
      const transfer = operation.members.find(member => member.signed?.transactionHash === payment.txHash)!
      const stamp = operation.members.find(member =>
        member.transactionSet?.role === 'payment' && member.transactionSet.stageId !== undefined)!
      const funding = operation.members[stamp.dependencies[0]!]!
      const nonce = (member: typeof transfer) => Transaction.from(member.signed!.rawTransaction).nonce
      const fundingReceipt = await monad.provider.getTransactionReceipt(funding.signed!.transactionHash)
      const transferReceipt = await monad.provider.getTransactionReceipt(payment.txHash!)
      const storedAtMs = got.receivedTime
      const fundingSent = broadcasts.find(item => item.hash === funding.signed!.transactionHash)
      const transferSent = broadcasts.filter(item => item.hash === payment.txHash)
      console.log(`  funding ${funding.signed!.transactionHash} nonce ${nonce(funding)} block ${fundingReceipt?.blockNumber}; transfer ${payment.txHash} nonce ${nonce(transfer)} block ${transferReceipt?.blockNumber}; relay stored at ${storedAtMs}`)
      check(funding.source.address === main && nonce(funding) === startNonce, 'the stamp is funded from the one coin at its lowest nonce')
      check(transfer.source.address === main && nonce(transfer) === startNonce + 1, 'the contact transfer is the next nonce')
      check(fundingReceipt?.status === 1 && transferReceipt?.status === 1, 'the funding and the transfer both succeeded on the chain')
      check(fundingSent !== undefined && fundingSent.atMs < storedAtMs, 'the funding was broadcast before the relay stored the message')
      check(transferSent.length > 0 && transferSent.every(item => item.atMs >= storedAtMs), 'the contact transfer was broadcast only after the relay stored the message')
      check((transferReceipt?.blockNumber ?? 0) >= (fundingReceipt?.blockNumber ?? Infinity) + 3, 'the transfer landed after the account\'s quiet window')
      check(await monad.provider.getBalance(transferReceipt!.to!) === valueWei, 'the contact\'s one-time address holds the payment once')
      const unpaid = await checkStampOnChain(monad.provider, got, stampWei)
      check(unpaid === undefined, `the stamp is paid on the chain${unpaid ? ` (${unpaid})` : ''}`)
      // The set's change after the transfer is the wallet's own, sent on later ticks.
      let receipts = await Promise.all(operation.members.map(member =>
        monad.provider.getTransactionReceipt(member.signed!.transactionHash)))
      for (let pass = 0; pass < 60 && receipts.some(receipt => receipt === null); pass++) {
        await sender.handle.resumeContactPayments!()
        await sleep(2000)
        receipts = await Promise.all(operation.members.map(member =>
          monad.provider.getTransactionReceipt(member.signed!.transactionHash)))
      }
      check(receipts.every(receipt => receipt?.status === 1),
        `every transaction of the set landed and none reverted (${receipts.map(receipt => receipt?.status ?? 'missing').join(', ')})`)
      await sender.close()
    }

    // 2. A paid direct message from one coin.
    {
      const sender = await openMonadWallet(stack, 'dm-sender', { stampValueWei: stampWei })
      await monad.fund(sender.mainAccount, fundWei)
      await monad.mine(6)
      const broadcasts = recordBroadcasts(sender)
      const digest = await sender.send(recipient.address, [{ type: 'text', text: 'one coin, one stamp' }], stampWei, 180_000)
      const got = await recipient.receive(message => message.payloadDigest === digest, 60_000)
      const unpaid = await checkStampOnChain(monad.provider, got, stampWei)
      check(unpaid === undefined, `the paid message is delivered and its stamp paid on the chain${unpaid ? ` (${unpaid})` : ''}`)
      const operation = sender.handle.getNativeOperations!().find(row => row.kind === 'transaction-set')!
      const stamps = new Set(operation.members.filter(member => member.transactionSet?.role === 'payment')
        .map(member => member.signed!.transactionHash))
      check(broadcasts.filter(item => stamps.has(item.hash)).every(item => item.atMs >= got.receivedTime),
        'no stamp was broadcast before the relay stored the message')
      const receipts = await Promise.all(operation.members.map(member =>
        monad.provider.getTransactionReceipt(member.signed!.transactionHash)))
      check(receipts.every(receipt => receipt === null || receipt.status === 1), 'no transaction of the set reverted')
      await sender.close()
    }
    await recipient.close()
  } finally {
    try {
      const { returnedWei, leftWei } = await returnToFaucet(stack)
      console.log(`returned ${formatEther(returnedWei)} MON to the faucet; ${formatEther(leftWei)} MON left as dust or unsweepable`)
    } finally {
      await stack.stop()
    }
  }
  console.log(problems.length === 0 ? 'Monad one-coin check: OK' : `Monad one-coin check: FAILED (${problems.length})`)
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
