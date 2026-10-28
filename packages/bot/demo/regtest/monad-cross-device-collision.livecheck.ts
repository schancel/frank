/**
 * Two devices of one account pay from the same coin at the same moment, on the local Monad
 * network (monad-solonet) through the real relay binary. Not part of CI.
 *
 *   yarn --cwd packages/bot regtest:monad-cross-device
 *
 * `startRegtestStack` runs the relay (CASHWEBD_BIN, or this worktree's Cargo build) on the
 * long-running solonet. gina has two devices (`gina-a`, `gina-b`: one account root), bob is the
 * recipient. bob pays gina a stamp, so both of gina's devices list the same received coin. Device
 * B signs its message's payment and is held just before it hands anything out; device A (the same
 * account keys) then signs a transfer from the account and nonce B's payment was signed from, and
 * the chain takes A's transaction. (A's own wallet does not always choose the same coin as B, so
 * A signs with that coin's key directly.) B is let go: its own transaction can never land (its
 * nonce is used by A's).
 *
 * Checked:
 *   1. B's message is delivered, paid once, in full, from another coin; its first signed payment
 *      never lands; B no longer offers the taken coin. Every transaction of B's taken set is
 *      decided by the chain (landed, its nonce used by another, or given up because one it stood
 *      on was), none of it holds an account, and B's next message goes through (it is not
 *      refused as money tied up in a send that can never land).
 *   2. The same with B's app closed in the middle: closed before it sent anything, reopened, and
 *      closed again just after it recorded that the payment is to be built again, then reopened.
 *   3. The same when A's transaction moves a different value (most of the account B's payment
 *      was signed from, at B's nonce): B's change transfers after the taken nonce were signed
 *      against money that is gone, and are given up.
 *   4. A's transaction lands while the relay already holds B's message (A's is on the network
 *      first; the relay's look at the account does not show it yet): B's message is delivered and
 *      its taken payment is paid again, the same amount to the same destination, once (what bob's
 *      wallet shows for that money is printed: it does not count it, see the round). When the
 *      relay saw A's transaction first and refused B's message, the round reports that and checks
 *      round 1's outcome instead: which of the two happens is a race the check does not control.
 *   5. B's message carries a payment to a contact together with its stamp (one combined set),
 *      and A takes a coin of that set: the message ends saying another device spent the same
 *      funds, nothing of it is paid, nothing stays held, and B's next message goes through.
 *
 * Every account the wallets used is swept back to the faucet at the end.
 */
import assert from 'assert'
import type { EvmNativeOperation } from '@frank/wallet/storage/evm-native-operation-journal'
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
/** Round 5: what B pays bob's contact address together with its stamp (well above the payment
 * floor, which follows the gas price). */
const CONTACT_WEI = parseEther('0.1')

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

/** B's message reached its hold (its attempt is recorded), or B's send ended before that: a send
 * that fails before recording an attempt never reaches the hold, and waiting for it alone would
 * wait forever. */
async function heldOrEnded(held: Promise<string>, outcome: Promise<string>, label: string): Promise<string> {
  const first = await Promise.race([held.then(digest => ({ digest })), outcome.then(ended => ({ ended }))])
  if ('digest' in first) return first.digest
  throw new Error(`${label}: B's send ended before it recorded its message: ${first.ended}`)
}

async function main() {
  const stack = await startRegtestStack({ chains: ['monad-regtest'] })
  const monad = monadOf(stack)
  const devices: RealWallet[] = []
  let other: OtherDevice | undefined
  const keys = new Map<string, string>()
  /** Another device of gina's account (A: the same account keys, read here from B's list) signs
   * a transfer to the faucet from the account and nonce of `victim`, one of B's signed
   * transactions, and hands it to the network. Signing from B's very account and nonce means the
   * two always collide, whichever coin B chose. */
  const takeAccount = async (
    device: RealWallet, victim: Transaction, value: (balance: bigint, fee: bigint) => bigint, label: string,
  ): Promise<string> => {
    const key = evmWalletInternals(device.handle).coinList!.all()
      .find(coin => coin.account.toLowerCase() === victim.from!.toLowerCase() && coin.privateKey)?.privateKey
    assert.ok(key, `${label}: the account holds the key of ${victim.from}`)
    const signer = new Wallet(key!, monad.provider)
    const gasPrice = BigInt(await monad.provider.send('eth_gasPrice', []))
    const balance = await monad.provider.getBalance(victim.from!)
    const raw = await signer.signTransaction({
      type: 0, chainId: (await monad.provider.getNetwork()).chainId, to: monad.faucetAddress,
      value: value(balance, TRANSFER_GAS * gasPrice), nonce: victim.nonce, gasLimit: TRANSFER_GAS, gasPrice,
    })
    await monad.provider.send('eth_sendRawTransaction', [raw])
    return Transaction.from(raw).hash!
  }
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
          if (tries >= 100 || (err as Error).name !== 'InsufficientStampFundsError') {
            // What the giver's sets still wait on, for the report.
            const { Transaction } = await import('ethers')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const journal = (evmWalletInternals(giver.handle).transactionSetPreparer as any)?.options?.journal
            for (const row of (journal?.list?.() ?? []) as EvmNativeOperation[])
              console.log(`${label}: giver set ${row.operationId}: ${row.members.map(m => `${m.transactionSet?.role} ${m.source.address}:${Transaction.from(m.unsignedTransaction).nonce} ${m.observation.state} exposed=${m.exposed}`).join('; ')}`)
            throw err
          }
          await giver.chain.directMessages.reconcileAttempts({ wallet: giver.handle, payloadDigests: [] }).catch(() => undefined)
          await giver.handle.reobserveNativeOperations?.().catch(error => {
            if (tries % 20 === 0) console.warn(`${label}: the giver's background pass failed:`, error)
          })
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
      const bDigest = await heldOrEnded(held, bOutcome, label)
      const bFirst = written.get(bDigest)!.at(-1)!
      const bTaken = bFirst.payments.map(payment => Transaction.from(payment.rawTx))
      console.log(`${label}: B signed ${bTaken.map(tx => `${tx.hash} (${tx.from} nonce ${tx.nonce})`).join(', ')}`)

      // A pays from the same coin; the chain takes A's transaction.
      let relayStored: boolean | undefined
      let aHashes: string[]
      const takeB = (value: (balance: bigint, fee: bigint) => bigint) => takeAccount(b, bTaken[0]!, value, label)
      if (variant === 'relay-stored') {
        // A's transaction goes to the network first, and B is let go at once: the relay reads
        // the account before the network shows A's transaction used the nonce, stores B's
        // message, and B's payment then cannot land.
        const aHash = await takeB(() => STAMP_WEI * 2n)
        release()
        const outcome = await bOutcome
        relayStored = !/Another transaction used the coin/.test(outcome)
        console.log(`${label}: A's ${aHash} sent first; B's send ended: ${outcome}`)
        aHashes = [aHash]
      } else if (variant === 'different-value') {
        // A moves most of the account B's payment was signed from (B is let go only after it
        // landed): B's later transfers from that account were signed against money that is gone.
        aHashes = [await takeB((balance, fee) => balance - fee * 4n)]
      } else {
        // A pays the same value from the same account and nonce (B is let go only after it
        // landed).
        aHashes = [await takeB(() => STAMP_WEI)]
      }
      const aTxs = await Promise.all(
        aHashes.map(async txHash => {
          const receipt = await monad.provider.waitForTransaction(txHash, 1, 120_000)
          // A's transfer only has to use the nonce: included either way. Solonet has included
          // one reverted (status 0) right after the coin's funding.
          assert.ok(receipt, `A's transaction ${txHash} was included`)
          const tx = (await monad.provider.getTransaction(txHash))!
          return { from: tx.from, nonce: tx.nonce }
        }),
      )
      const collided = bTaken.filter(tx =>
        aTxs.some(other => other.from === tx.from && other.nonce === tx.nonce),
      )
      if (collided.length === 0) {
        // B chose other coins than A (change left from an earlier round): nothing collided, so
        // the round shows nothing. B's message is let go and delivered, and the round is
        // played again.
        if (variant !== 'relay-stored') release()
        console.log(`${label}: A and B did not pay from the same coin (A ${aTxs.map(tx => `${tx.from}:${tx.nonce}`)}; B's send ended: ${await bOutcome}); played again`)
        await reconcileUntilDelivered(b, bDigest)
        return false
      }
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
        const outcome = await bOutcome
        // The relay's look at the account can miss A's transaction even here (it reads what the
        // node has executed so far): it stores B's message, and B's payment then cannot land.
        // That is round 4's case, checked as round 4 checks it.
        relayStored = outcome === 'returned'
        console.log(`${label}: B's send ended: ${outcome}${relayStored ? ' (the relay stored B\'s message before it saw A\'s transaction)' : ''}`)
      }
      await reconcileUntilDelivered(b, bDigest)

      if (relayStored) {
        // The relay held B's message: its taken payment is paid again, the same amount to the
        // same destination, once.
        const destination = collided[0]!.to!
        const deadline = Date.now() + 240_000
        let row = written.get(bDigest)!.at(-1)!
        while (!(row.repayments?.length && row.repayments.every(repayment => repayment.state === 'spent'))) {
          if (Date.now() > deadline)
            throw new Error(`${label}: B's taken payment was not paid again (${JSON.stringify(row.repayments)}, payments ${JSON.stringify(row.payments.map(p => p.state))})`)
          await b.chain.directMessages.reconcileAttempts({ wallet: b.handle, payloadDigests: [bDigest] })
          await sleep(3000)
          row = written.get(bDigest)!.at(-1)!
        }
        // Only what A took is paid again; a payment of the same message A did not take lands as
        // signed (the relay holds it too).
        assert.equal(row.repayments!.length, collided.length, `${label}: each taken payment is paid again once`)
        for (const tx of bTaken) {
          const receipt = await monad.provider.getTransactionReceipt(tx.hash!)
          if (collided.includes(tx)) assert.equal(receipt, null, `${label}: B's taken payment ${tx.hash} never landed`)
          else assert.equal(receipt?.status, 1, `${label}: B's untaken payment ${tx.hash} landed as signed`)
        }
        // Every destination the message names holds exactly what the message pays it, once.
        const owed = new Map<string, bigint>()
        for (const tx of bTaken) owed.set(tx.to!, (owed.get(tx.to!) ?? 0n) + tx.value)
        for (const [to, value] of owed)
          assert.equal(await monad.provider.getBalance(to), value, `${label}: ${to}, named by B's message, holds exactly what it is paid`)
        assert.equal(b.chain.directMessages.paymentSummaryOf?.({ wallet: b.handle, payloadDigest: bDigest }), 'repaid', `${label}: B reads its payment as paid again`)
        const states = await waitSettled(b, row.transactionSetOperationId!, bDigest, label)
        console.log(`${label}: the relay held B's message; its taken payment was paid again to ${destination}; taken set: ${states.join('; ')}`)
        // What bob's wallet makes of it. The message names the taken transaction, which never
        // lands; the repayment is a different transaction, which the message does not name. Bob's
        // wallet counts a received coin only once the transfer its message carries is included,
        // so it does not count this money (shown, not asserted: an open owner question).
        await bob.chain.directMessages.fetchSince({ wallet: bob.handle, sinceMs: 0 }).catch(() => [])
        const seen = (await bob.handle.refreshReceivedPayments?.())?.find(payment => payment.address === destination.toLowerCase())
        console.log(`${label}: bob's wallet shows the repaid stamp at ${destination} as ${seen?.status ?? 'unknown to it'} (spendable ${seen?.spendable ?? false})`)
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
      // Quoted with its stamp, as the app's review does: the reviewed fee is what the payment
      // and its stamp pay together.
      const quote = await payments.quote!({ ...intent0, messageStamp: { amountAtomic: STAMP_WEI } })
      if (quote.messageStampFeeAtomic === undefined) throw new Error(`${label}: the quote has no stamp fee`)
      const intent: StealthPaymentIntent = {
        ...intent0,
        maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
        messageStamp: { amountAtomic: STAMP_WEI, maxNativeFeeAtomic: quote.messageStampFeeAtomic },
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
      const bDigest = await heldOrEnded(held, bOutcome, label)
      const operationId = evmStealthTransactionSetOperationId(intent.operationId)
      const preparer = evmWalletInternals(b.handle).transactionSetPreparer!
      const signed = (await preparer.readOperation(operationId))!.members.map(member => Transaction.from(member.signed!.rawTransaction))
      console.log(`${label}: B signed its combined set ${signed.map(tx => `${tx.hash} (${tx.from} nonce ${tx.nonce})`).join(', ')}`)
      // A takes the account and nonce of the set's first transaction.
      const aHash = await takeAccount(b, signed[0]!, () => STAMP_WEI, label)
      const aTxs = await Promise.all([aHash].map(async txHash => {
        const receipt = await monad.provider.waitForTransaction(txHash, 1, 120_000)
        assert.ok(receipt, `A's transaction ${txHash} was included`)
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

    /** Plays a round until A and B paid from the same coin (at most three times). */
    const collide = async (...args: Parameters<typeof round>) => {
      for (let attempt = 0; attempt < 3; attempt++) if ((await round(...args)) !== false) return
      throw new Error(`${args[0]}: A and B never paid from the same coin`)
    }
    await collide('round 1', false, bob)
    // A fresh giver: bob's own change from round 1 may not be spendable as one coin yet.
    const carol = await openMonadWallet(stack, 'carol')
    devices.push(carol)
    await fundFromFaucet(stack, carol.mainAccount, parseEther('3'))
    await collide('round 2 (B closed and reopened twice)', true, carol)
    await collide('round 3 (A moves most of the coin)', false, carol, 'different-value')
    await collide('round 4 (the relay already holds B\'s message)', false, carol, 'relay-stored')
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
          // Every message in its mailbox, not only those since it opened.
          await device.chain.directMessages.fetchSince({ wallet: device.handle, sinceMs: 0 }).catch(() => undefined)
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
