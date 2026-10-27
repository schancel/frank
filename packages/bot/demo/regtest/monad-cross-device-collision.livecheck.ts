/**
 * Two devices of one account pay from the same coin at the same moment, on the local Monad
 * network (monad-solonet) through the real relay binary. Not part of CI.
 *
 *   yarn --cwd packages/bot regtest:monad-cross-device
 *
 * `startRegtestStack` runs the relay (CASHWEBD_BIN, or this worktree's Cargo build) on the
 * long-running solonet. gina has two devices (`gina-a`, `gina-b`: one account root), bob is the
 * recipient. bob pays gina a stamp, so both of gina's devices list the same received coin, which
 * their selection takes first. Device B signs its message's payment from that coin and is held
 * just before it hands anything out; device A then sends from the same coin, and the chain takes
 * A's transaction. B is let go: its own transaction can never land (its nonce is used by A's).
 *
 * Checked:
 *   1. B's message is delivered, paid once, in full, from another coin; its first signed payment
 *      never lands; B no longer offers the taken coin. Every transaction of B's taken set is
 *      decided by the chain (landed, its nonce used by another, or given up because one it stood
 *      on was), none of it holds an account, and B's next message goes through (it is not
 *      refused as money tied up in a send that can never land).
 *   2. The same with B's app closed in the middle: closed before it sent anything, reopened, and
 *      closed again just after it recorded that the payment is to be built again, then reopened.
 *   3. The same when A's transaction moves a different value (most of the coin): B's change
 *      transfers after the taken nonce were signed against money that is gone, and are given up.
 *   4. A's transaction lands while the relay already holds B's message (A's is on the network
 *      first; the relay's look at the account does not show it yet): B's message is delivered and
 *      its taken payment is paid again, the same amount to the same destination, once. When the
 *      relay saw A's transaction first and refused B's message, the round reports that and checks
 *      round 1's outcome instead: which of the two happens is a race the check does not control.
 *   5. B's message carries a payment to a contact together with its stamp (one combined set),
 *      and A takes a coin of that set: the message ends saying another device spent the same
 *      funds, nothing of it is paid, nothing stays held, and B's next message goes through.
 *
 * Every account the wallets used is swept back to the faucet at the end.
 */
import assert from 'assert'
import { fork, type ChildProcess } from 'child_process'
import { copyFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'

import { formatEther, parseEther, Transaction, Wallet } from 'ethers'

import { evmWalletInternals } from '@frank/wallet/evm-wallet'
import { evmStealthTransactionSetOperationId } from '@frank/wallet/chain/evm-stealth-payments'
import { recipientAssetPaymentFromPrepared } from '@frank/wallet/message-item-plugins/stealth-asset/from-prepared'
import type { StealthPaymentIntent } from '@frank/wallet/stealth-payment'
import { nativeMemberSuperseded } from '@frank/wallet/storage/evm-native-operation-journal'
import {
  LevelOutgoingMessageStore,
  type StoredMessage,
} from '@frank/wallet/storage/outgoing-message-store'
import type { RealWallet } from '../real-stack'
import { TRANSFER_GAS } from '../funds'
import { MONAD_REGTEST_MIN_STAMP_WEI } from './monad-regtest'
import { monadOf, openMonadWallet, returnToFaucet } from './monad-wallets'
import { SolonetKeyRun } from './solonet-keys'
import { startRegtestStack, type RegtestStack } from './regtest-stack'
import { sleep } from './regtest-chain'

const FUND_WEI = parseEther('2')
/** What bob pays gina each round: the coin both of gina's devices take first. */
const SHARED_COIN_WEI = parseEther('0.3')
const STAMP_WEI = MONAD_REGTEST_MIN_STAMP_WEI * 3n
/** Round 3: what A's message pays, most of the shared coin. */
const A_LARGE_STAMP_WEI = parseEther('0.25')
/** Round 5: what B pays bob's contact address together with its stamp. */
const CONTACT_WEI = parseEther('0.01')

/** Every row the wallets in this process write, by payload digest, in order. */
const written = new Map<string, StoredMessage[]>()
/** Throws once, just after the row is on disk, when it matches: the app "closes" there. */
let crashAfter: ((row: StoredMessage) => boolean) | undefined
const originalPut = LevelOutgoingMessageStore.prototype.put
LevelOutgoingMessageStore.prototype.put = async function (row: StoredMessage) {
  await originalPut.call(this, row)
  written.set(row.digest, [...(written.get(row.digest) ?? []), structuredClone(row)])
  if (crashAfter?.(row)) {
    crashAfter = undefined
    throw new Error('the app closed here')
  }
}

function openDevice(stack: RegtestStack, label: string, root?: string): Promise<RealWallet> {
  if (root) {
    // A second device of the same account: the same account root, its own state.
    const dir = join(stack.stateDir, 'wallets', label)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    copyFileSync(join(stack.stateDir, 'wallets', root, 'account-root.hex'), join(dir, 'account-root.hex'))
  }
  return openMonadWallet(stack, label)
}

/** Device A, in a process of its own (`monad-cross-device-collision.device.ts`): a process opens
 * one handle of an account. */
interface OtherDevice {
  address: string
  mainAccount: string
  call<T>(request: Record<string, unknown>): Promise<T>
  child: ChildProcess
}
function openOtherDevice(stack: RegtestStack, label: string): Promise<OtherDevice> {
  const child = fork(join(__dirname, 'monad-cross-device-collision.device.ts'), [stack.relayUrl, stack.stateDir, label], {
    execArgv: ['--import', 'tsx'],
    serialization: 'advanced',
  })
  let next = 0
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  return new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`device ${label} exited (${code})`)))
    child.on('message', (message: { ready?: { address: string; mainAccount: string }; id?: number; ok?: boolean; result?: unknown; error?: string }) => {
      if (message.ready)
        return resolve({
          ...message.ready,
          child,
          call: <T>(request: Record<string, unknown>) =>
            new Promise<T>((resolveCall, rejectCall) => {
              const id = next++
              waiting.set(id, { resolve: resolveCall as (value: unknown) => void, reject: rejectCall })
              child.send({ ...request, id })
            }),
        })
      const call = waiting.get(message.id!)
      waiting.delete(message.id!)
      if (message.ok) call?.resolve(message.result)
      else call?.reject(new Error(message.error))
    })
  })
}

async function reconcileUntilDelivered(device: RealWallet, digest: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = (
      await device.chain.directMessages.reconcileAttempts({ wallet: device.handle, payloadDigests: [digest] })
    )[digest]
    if (status === 'delivered') return
    if (status === 'dead') throw new Error(`${device.label}'s message ${digest} was ended by the relay`)
    if (Date.now() > deadline) {
      const rows = written.get(digest) ?? []
      const last = rows.at(-1)
      throw new Error(
        `${device.label}'s message ${digest} is still ${status} after ${timeoutMs / 1000}s ` +
          `(payments ${JSON.stringify(last?.payments.map(p => p.state))}, reason ${last?.reason}, ` +
          `summary ${device.chain.directMessages.paymentSummaryOf?.({ wallet: device.handle, payloadDigest: digest })})`,
      )
    }
    await sleep(3000)
  }
}

/** The faucet pays `address`; other checks share the faucet, so a payment that lost the race for
 * the faucet's nonce is sent again. */
async function fundFromFaucet(stack: RegtestStack, address: string, amount: bigint): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await monadOf(stack).fund(address, amount)
      return
    } catch (error) {
      const text = `${(error as Error).message}`
      if (tries >= 10 || !/nonce too low|nonce has already been used|higher priority|already known|replacement/i.test(text)) throw error
      await sleep(2000)
    }
  }
}

/** Every transaction of `operationId` that the chain decided: landed, its nonce used by another
 * transaction, or given up because one it stood on was. Waits up to `timeoutMs`; the wallet's
 * own passes (reconcile and re-observation) are what decide them. */
async function waitSettled(device: RealWallet, operationId: string, digest: string, label: string, timeoutMs = 180_000): Promise<string[]> {
  const preparer = evmWalletInternals(device.handle).transactionSetPreparer!
  const describe = async () => {
    const operation = await preparer.readOperation(operationId)
    return operation?.members.map(member =>
      `${member.transactionSet?.role} ${member.source.address}:${Transaction.from(member.unsignedTransaction).nonce} ${
        nativeMemberSuperseded(member) ? 'used by another' : member.observation.state}`) ?? []
  }
  const settled = (states: string[]) => states.every(state => /used by another|included-|abandoned/.test(state))
  let states = await describe()
  for (const deadline = Date.now() + timeoutMs; !settled(states) && Date.now() < deadline; ) {
    await device.chain.directMessages.reconcileAttempts({ wallet: device.handle, payloadDigests: digest ? [digest] : [] }).catch(() => undefined)
    await device.handle.reobserveNativeOperations?.().catch(() => undefined)
    await sleep(3000)
    states = await describe()
  }
  assert.ok(settled(states), `${label}: B's taken set ${operationId} is decided by the chain (${states.join('; ')})`)
  // None of the set's coins is still held by it (another send may hold the same account since).
  const held = evmWalletInternals(device.handle).coinList!.all().filter(coin => coin.holder === operationId && coin.state !== 'spent')
  assert.deepEqual(
    held.map(coin => `${coin.account}:${coin.nonce} ${coin.state}`), [],
    `${label}: B's taken set ${operationId} holds no coin`,
  )
  return states
}

/** B's next message goes through once the sends before it are decided: it is not refused as
 * money tied up in a send that can never land. `settled` are B's operations for this round (the
 * taken one and the one that paid again), each waited for first. */
async function nextSendGoesThrough(device: RealWallet, to: string, label: string, settled: string[]): Promise<void> {
  const digest = '' // reconcile everything B holds
  for (const id of settled) await waitSettled(device, id, digest, label)
  for (let tries = 0; ; tries++) {
    try {
      await device.send(to, [{ type: 'text', text: `${label}: B's next message ${Date.now()}` }], STAMP_WEI)
      return
    } catch (error) {
      // Change of B's own just-landed transactions may be spendable a few blocks later.
      if (tries >= 20 || (error as Error).name !== 'InsufficientStampFundsError')
        throw new Error(`${label}: B's next message was refused: ${(error as Error).name}: ${(error as Error).message}`)
      await sleep(3000)
    }
  }
}

async function main() {
  const stack = await startRegtestStack({ chains: ['monad-regtest'] })
  const monad = monadOf(stack)
  const devices: RealWallet[] = []
  let other: OtherDevice | undefined
  const keys = new Map<string, string>()
  const remember = (device: RealWallet) => {
    for (const coin of evmWalletInternals(device.handle).coinList?.all() ?? [])
      if (coin.privateKey) keys.set(coin.account.toLowerCase(), coin.privateKey)
  }
  let failed = false
  try {
    const bob = await openMonadWallet(stack, 'bob')
    devices.push(bob)
    const a = await openOtherDevice(stack, 'gina-a')
    other = a
    let b = await openDevice(stack, 'gina-b', 'gina-a')
    devices.push(b)
    assert.equal(a.address, b.address, 'both devices are one account')
    await fundFromFaucet(stack, bob.mainAccount, FUND_WEI)
    await fundFromFaucet(stack, a.mainAccount, FUND_WEI)
    console.log(`state ${stack.stateDir}; gina ${a.address} (main ${a.mainAccount}), bob ${bob.address}`)

    /** gina receives a coin both devices list (from `giver`). */
    const shareCoin = async (label: string, giver: RealWallet) => {
      let gift: string
      for (let tries = 0; ; tries++) {
        try {
          gift = await giver.send(a.address, [{ type: 'text', text: `${label} gift ${Date.now()}` }], SHARED_COIN_WEI)
          break
        } catch (err) {
          // The giver's change from its last gift lands and matures a few blocks later. Its own
          // sends' later transfers go to the node from the wallet's background pass, which the
          // app runs on a timer and this check runs here.
          if (tries >= 100 || (err as Error).name !== 'InsufficientStampFundsError') throw err
          await giver.chain.directMessages.reconcileAttempts({ wallet: giver.handle, payloadDigests: [] }).catch(() => undefined)
          await giver.handle.reobserveNativeOperations?.().catch(() => undefined)
          await sleep(3000)
        }
      }
      await a.call({ op: 'receive', digest: gift })
      await b.receive(message => message.payloadDigest === gift)
    }

    const round = async (
      label: string,
      interruptions: boolean,
      giver: RealWallet,
      variant: 'same-coin' | 'different-value' | 'relay-stored' = 'same-coin',
    ) => {
      // `giver` pays gina: both devices read the message and list the same received coin.
      await shareCoin(label, giver)

      // B signs its payment and is held just before it hands anything out.
      let reachedHold!: (digest: string) => void
      const held = new Promise<string>(resolve => (reachedHold = resolve))
      let release!: () => void
      const released = new Promise<void>(resolve => (release = resolve))
      const bSend = b.chain.directMessages.send({
        wallet: b.handle,
        recipient: { raw: bob.address },
        items: [{ type: 'text', text: `${label} from device B` }],
        sealedSender: true,
        stampValue: STAMP_WEI,
        onAttemptCreated: async digest => {
          reachedHold(digest)
          await released
          if (interruptions) throw new Error('the app closed before sending')
        },
      })
      const bOutcome = bSend.then(
        () => 'returned',
        (error: Error) => `${error.name}: ${error.message}`,
      )
      const bDigest = await held
      const bFirst = written.get(bDigest)!.at(-1)!
      const bTaken = bFirst.payments.map(payment => Transaction.from(payment.rawTx))
      console.log(`${label}: B signed ${bTaken.map(tx => `${tx.hash} (${tx.from} nonce ${tx.nonce})`).join(', ')}`)

      // A pays from the same coin; the chain takes A's transaction.
      let relayStored: boolean | undefined
      let aHashes: string[]
      if (variant === 'relay-stored') {
        // A's transaction goes to the network first, and B is let go at once: the relay reads
        // the account before the network shows A's transaction used the nonce, stores B's
        // message, and B's payment then cannot land.
        // Both devices derive the same keys from the account; the coin's key is read from B's list.
        const victim = bTaken[0]!
        const key = evmWalletInternals(b.handle).coinList!.all()
          .find(coin => coin.account.toLowerCase() === victim.from!.toLowerCase() && coin.privateKey)?.privateKey
        assert.ok(key, `${label}: the account holds the key of ${victim.from}`)
        const signer = new Wallet(key!, monad.provider)
        const gasPrice = BigInt(await monad.provider.send('eth_gasPrice', []))
        const raw = await signer.signTransaction({
          type: 0, chainId: (await monad.provider.getNetwork()).chainId, to: monad.faucetAddress,
          value: STAMP_WEI * 2n, nonce: victim.nonce, gasLimit: TRANSFER_GAS, gasPrice,
        })
        const aHash = Transaction.from(raw).hash!
        await monad.provider.send('eth_sendRawTransaction', [raw])
        release()
        const outcome = await bOutcome
        relayStored = !/Another transaction used the coin/.test(outcome)
        console.log(`${label}: A's ${aHash} sent first; B's send ended: ${outcome}`)
        aHashes = [aHash]
      } else {
        const aSent = await a.call<{ digest: string; txHashes: string[] }>({
          op: 'send', to: bob.address, text: `${label} from device A`,
          stampWei: variant === 'different-value' ? A_LARGE_STAMP_WEI : STAMP_WEI,
        })
        aHashes = aSent.txHashes
      }
      const aTxs = await Promise.all(
        aHashes.map(async txHash => {
          const receipt = await monad.provider.waitForTransaction(txHash, 1, 120_000)
          assert.equal(receipt?.status, 1, `A's payment ${txHash} landed`)
          const tx = (await monad.provider.getTransaction(txHash))!
          return { from: tx.from, nonce: tx.nonce }
        }),
      )
      const collided = bTaken.filter(tx =>
        aTxs.some(other => other.from === tx.from && other.nonce === tx.nonce),
      )
      assert.ok(collided.length > 0, `${label}: A and B paid from the same coin (A ${aTxs.map(tx => `${tx.from}:${tx.nonce}`)})`)
      await monad.mine(4)

      if (variant === 'relay-stored') {
        // Released above.
      } else if (interruptions) {
        release()
        console.log(`${label}: B's send ended: ${await bOutcome}`)
        // Closed before anything left; reopened.
        await b.close()
        b = await openDevice(stack, 'gina-b')
        devices.push(b)
        // Closed again just after recording that the payment is built again.
        crashAfter = row => row.digest === bDigest && (row.replacedOperationIds?.length ?? 0) > 0
        try {
          await reconcileUntilDelivered(b, bDigest)
          throw new Error(`${label}: B's message was delivered without the payment being built again`)
        } catch (error) {
          if ((error as Error).message !== 'the app closed here') throw error
        }
        console.log(`${label}: B closed just after recording the rebuild; reopening`)
        await b.close()
        b = await openDevice(stack, 'gina-b')
        devices.push(b)
      } else {
        release()
        console.log(`${label}: B's send ended: ${await bOutcome}`)
      }
      await reconcileUntilDelivered(b, bDigest)

      if (relayStored) {
        // The relay held B's message: its taken payment is paid again, the same amount to the
        // same destination, once.
        const destination = bTaken[0]!.to!
        const deadline = Date.now() + 240_000
        let row = written.get(bDigest)!.at(-1)!
        while (!(row.repayments?.length && row.repayments.every(repayment => repayment.state === 'spent'))) {
          if (Date.now() > deadline)
            throw new Error(`${label}: B's taken payment was not paid again (${JSON.stringify(row.repayments)}, payments ${JSON.stringify(row.payments.map(p => p.state))})`)
          await b.chain.directMessages.reconcileAttempts({ wallet: b.handle, payloadDigests: [bDigest] })
          await sleep(3000)
          row = written.get(bDigest)!.at(-1)!
        }
        assert.equal(row.repayments!.length, bTaken.length, `${label}: each taken payment is paid again once`)
        for (const tx of bTaken)
          assert.equal(await monad.provider.getTransactionReceipt(tx.hash!), null, `${label}: B's taken payment ${tx.hash} never landed`)
        assert.equal(await monad.provider.getBalance(destination), STAMP_WEI, `${label}: the destination B's message names holds exactly the stamp`)
        assert.equal(b.chain.directMessages.paymentSummaryOf?.({ wallet: b.handle, payloadDigest: bDigest }), 'repaid', `${label}: B reads its payment as paid again`)
        const states = await waitSettled(b, row.transactionSetOperationId!, bDigest, label)
        console.log(`${label}: the relay held B's message; its taken payment was paid again to ${destination}; taken set: ${states.join('; ')}`)
        await nextSendGoesThrough(b, bob.address, label, row.repayments!.map(repayment => repayment.operationId))
        return
      }

      // Delivered, paid once, in full, by transactions other than the first signed ones.
      const got = await bob.receive(message => message.payloadDigest === bDigest)
      let onChain = 0n
      for (const payment of got.stampPayments) {
        const receipt = await monad.provider.waitForTransaction(payment.txHash, 1, 120_000)
        assert.equal(receipt?.status, 1, `${label}: B's payment ${payment.txHash} landed`)
        assert.ok(!bTaken.some(tx => tx.hash === payment.txHash), `${label}: B's payment is not its taken one`)
        onChain += (await monad.provider.getTransaction(payment.txHash))!.value
      }
      assert.equal(got.stampValueWei, STAMP_WEI, `${label}: bob counts B's stamp exactly`)
      assert.equal(onChain, STAMP_WEI, `${label}: the chain carried exactly B's stamp, once`)
      for (const tx of bTaken)
        assert.equal(await monad.provider.getTransactionReceipt(tx.hash!), null, `${label}: B's taken payment ${tx.hash} never landed`)
      const last = written.get(bDigest)!.at(-1)!
      assert.ok((last.replacedOperationIds?.length ?? 0) === 1, `${label}: B built its payment again exactly once`)
      // The taken operation's other transactions: its change transfers after the taken nonce
      // were signed against a balance the other device's transaction changed. Each is decided
      // by the chain, and none holds an account.
      for (const id of last.replacedOperationIds ?? []) {
        const states = await waitSettled(b, id, bDigest, label)
        console.log(`${label}: B's taken operation ${id} settled: ${states.join('; ')}`)
      }
      // B never offers the coin A spent.
      const list = evmWalletInternals(b.handle).coinList!
      for (const tx of collided)
        assert.notEqual(list.get(tx.from!.toLowerCase(), tx.nonce)?.state, 'unspent', `${label}: B no longer offers ${tx.from}:${tx.nonce}`)
      console.log(
        `${label}: B's message delivered, paid ${formatEther(onChain)} by ${got.stampPayments.map(p => p.txHash).join(', ')}; its taken payment ${bTaken.map(tx => tx.hash).join(', ')} never landed`,
      )
      await nextSendGoesThrough(b, bob.address, label, [last.transactionSetOperationId!])
    }

    /** B pays bob's contact address together with its message's stamp (one combined set); A
     * takes a coin of that set. */
    const combinedRound = async (label: string, giver: RealWallet) => {
      await shareCoin(label, giver)
      const payments = b.handle.stealthPayments!
      const intent0 = {
        operationId: `contact-${Date.now()}`,
        chainIdentifier: 'monad-regtest',
        asset: { kind: 'native' as const },
        recipientSpendPublicKey: bob.handle.identity.compressedPubKey,
        amountAtomic: CONTACT_WEI,
      }
      const quote = await payments.quote!(intent0)
      const stamp = await b.chain.directMessages.quoteStamp!({ wallet: b.handle, stampValue: STAMP_WEI })
      if (stamp.status !== 'available') throw new Error(`${label}: no stamp quote (${stamp.status})`)
      const intent: StealthPaymentIntent = {
        ...intent0,
        maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
        messageStamp: { amountAtomic: STAMP_WEI, maxNativeFeeAtomic: stamp.maximumNativeFeeAtomic },
      }
      const prepared = await payments.prepare(intent)
      let reachedHold!: (digest: string) => void
      const held = new Promise<string>(resolve => (reachedHold = resolve))
      let release!: () => void
      const released = new Promise<void>(resolve => (release = resolve))
      const bOutcome = b.chain.directMessages
        .send({
          wallet: b.handle,
          recipient: { raw: bob.address },
          items: [recipientAssetPaymentFromPrepared(prepared)],
          sealedSender: true,
          stampValue: STAMP_WEI,
          paymentOperationId: intent.operationId,
          onEnvelopeDurable: digest => payments.expose({ operationId: intent.operationId, payloadDigest: digest }),
          onAttemptCreated: async digest => {
            reachedHold(digest)
            await released
          },
        })
        .then(() => 'returned', (error: Error) => `${error.name}: ${error.message}`)
      const bDigest = await held
      const operationId = evmStealthTransactionSetOperationId(intent.operationId)
      const preparer = evmWalletInternals(b.handle).transactionSetPreparer!
      const signed = (await preparer.readOperation(operationId))!.members.map(member => Transaction.from(member.signed!.rawTransaction))
      console.log(`${label}: B signed its combined set ${signed.map(tx => `${tx.hash} (${tx.from} nonce ${tx.nonce})`).join(', ')}`)
      const aSent = await a.call<{ digest: string; txHashes: string[] }>({
        op: 'send', to: bob.address, text: `${label} from device A`, stampWei: STAMP_WEI,
      })
      const aTxs = await Promise.all(aSent.txHashes.map(async txHash => {
        const receipt = await monad.provider.waitForTransaction(txHash, 1, 120_000)
        assert.equal(receipt?.status, 1, `A's payment ${txHash} landed`)
        const tx = (await monad.provider.getTransaction(txHash))!
        return { from: tx.from, nonce: tx.nonce }
      }))
      assert.ok(
        signed.some(tx => aTxs.some(other => other.from === tx.from && other.nonce === tx.nonce)),
        `${label}: A paid from a coin of B's combined set (A ${aTxs.map(tx => `${tx.from}:${tx.nonce}`)})`,
      )
      await monad.mine(4)
      release()
      console.log(`${label}: B's send ended: ${await bOutcome}`)
      const deadline = Date.now() + 240_000
      for (;;) {
        const status = (await b.chain.directMessages.reconcileAttempts({ wallet: b.handle, payloadDigests: [bDigest] }))[bDigest]
        if (status === 'dead') break
        if (status === 'delivered') throw new Error(`${label}: B's message was delivered though its combined payment was taken`)
        if (Date.now() > deadline) throw new Error(`${label}: B's message is still ${status} after 240s`)
        await sleep(3000)
      }
      assert.deepEqual(
        await b.chain.directMessages.endOf!({ wallet: b.handle, payloadDigest: bDigest }),
        { reason: 'payment-taken' },
        `${label}: B's message ends saying another device spent the same funds`,
      )
      for (const tx of signed) {
        const receipt = await monad.provider.getTransactionReceipt(tx.hash!)
        if (receipt) {
          const member = (await preparer.readOperation(operationId))!.members.find(m => m.signed!.transactionHash.toLowerCase() === tx.hash!.toLowerCase())!
          assert.notEqual(member.transactionSet?.role, 'payment', `${label}: no payment of B's combined set landed (${tx.hash})`)
        }
      }
      assert.equal(await monad.provider.getBalance(prepared.recipientAddress), 0n, `${label}: nothing reached bob's contact address`)
      const states = await waitSettled(b, operationId, bDigest, label)
      console.log(`${label}: B's message ended (payment-taken); its combined set: ${states.join('; ')}`)
      await nextSendGoesThrough(b, bob.address, label, [])
    }

    await round('round 1', false, bob)
    // A fresh giver: bob's own change from round 1 may not be spendable as one coin yet.
    const carol = await openMonadWallet(stack, 'carol')
    devices.push(carol)
    await fundFromFaucet(stack, carol.mainAccount, parseEther('2'))
    await round('round 2 (B closed and reopened twice)', true, carol)
    await round('round 3 (A moves most of the coin)', false, carol, 'different-value')
    await round('round 4 (the relay already holds B\'s message)', false, carol, 'relay-stored')
    await combinedRound('round 5 (a payment to a contact with its stamp)', carol)
    console.log('PASS: every collision ended paid once, or ended saying so; nothing stayed held')
  } catch (err) {
    failed = true
    console.error(err)
  } finally {
    if (other) {
      for (const [account, key] of await other.call<[string, string][]>({ op: 'keys' }).catch(() => []))
        keys.set(account, key)
      await other.call({ op: 'close' }).catch(() => undefined)
      other.child.kill()
    }
    for (const device of devices) {
      try {
        // Coins received in messages this device has not read yet (a stamp paid to it, a gift)
        // are listed once it reads them, so they are swept too.
        // (Reading the mailbox is what lists them; no message is matched.)
        await device.receive(() => false, 10_000)
      } catch {
        // Nothing more to read, or closed already.
      }
      try {
        remember(device)
      } catch {
        // Closed already: its coins were remembered when it was open, or are swept below.
      }
      await device.close().catch(() => undefined)
    }
    // Coins received in messages (stamps paid to bob, the gifts) are listed by a wallet that reads
    // its mailbox and settles; each account (gina once) is opened again for that, then swept.
    for (const label of readdirSync(join(stack.stateDir, 'wallets')).filter(label => label !== 'gina-a')) {
      try {
        const device = await openDevice(stack, label)
        try {
          await device.receive(() => false, 15_000).catch(() => undefined)
          for (let pass = 0; pass < 5; pass++) {
            await device.handle.reobserveNativeOperations?.().catch(() => undefined)
            await sleep(2000)
          }
          remember(device)
        } finally {
          await device.close().catch(() => undefined)
        }
      } catch (error) {
        console.warn(`could not reopen ${label} to sweep its received coins: ${(error as Error).message}`)
      }
    }
    let leftCoins: SolonetKeyRun | undefined
    const swept = await returnToFaucet(stack).catch(() => ({ returnedWei: 0n, leftWei: 0n, unswept: 1 }))
    // Received stamp coins and their successors are not among the accounts `returnToFaucet` finds.
    const gasPrice = BigInt(await monad.provider.send('eth_gasPrice', []))
    const fee = TRANSFER_GAS * gasPrice
    let extra = 0n
    for (const [account, key] of keys) {
      const held = await monad.provider.getBalance(account)
      if (held <= fee * 2n) continue
      try {
        const tx = await new Wallet(key, monad.provider).sendTransaction({
          type: 0, to: monad.faucetAddress, value: held - fee, gasLimit: TRANSFER_GAS, gasPrice,
        })
        if ((await tx.wait(1, 120_000))?.status === 1) extra += held - fee
      } catch (error) {
        console.warn(`could not sweep ${account}: ${(error as Error).message}`)
      }
    }
    // A coin key that still holds funds is saved durably, so a later run's leftover sweep returns it.
    let coinsLeft = 0
    for (const [account, key] of keys) {
      if ((await monad.provider.getBalance(account)) <= fee * 2n) continue
      coinsLeft += 1
      ;(leftCoins ??= SolonetKeyRun.open('cross-device-coins')).save(key)
    }
    leftCoins?.close()
    if (swept.unswept === 0 && coinsLeft === 0) stack.fundsReturned()
    console.log(
      `swept ${formatEther(swept.returnedWei + extra)} back to the faucet; left ${formatEther(swept.leftWei)} (dust or in flight)`,
    )
    await stack.stop().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
}

if (require.main === module) void main()
