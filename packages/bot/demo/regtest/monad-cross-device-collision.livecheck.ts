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
 *      never lands; B no longer offers the taken coin.
 *   2. The same with B's app closed in the middle: closed before it sent anything, reopened, and
 *      closed again just after it recorded that the payment is to be built again, then reopened.
 *
 * Every account the wallets used is swept back to the faucet at the end.
 */
import assert from 'assert'
import { fork, type ChildProcess } from 'child_process'
import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'

import { formatEther, parseEther, Transaction, Wallet } from 'ethers'

import { evmWalletInternals } from '@frank/wallet/evm-wallet'
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
    await monad.fund(bob.mainAccount, FUND_WEI)
    await monad.fund(a.mainAccount, FUND_WEI)
    console.log(`state ${stack.stateDir}; gina ${a.address} (main ${a.mainAccount}), bob ${bob.address}`)

    const round = async (label: string, interruptions: boolean, giver: RealWallet) => {
      // `giver` pays gina: both devices read the message and list the same received coin.
      let gift: string
      // bob's change from the last round may be spendable only a few blocks later.
      for (let tries = 0; ; tries++) {
        try {
          gift = await giver.send(a.address, [{ type: 'text', text: `${label} gift ${Date.now()}` }], SHARED_COIN_WEI)
          break
        } catch (err) {
          if (tries >= 20 || (err as Error).name !== 'InsufficientStampFundsError') throw err
          await sleep(3000)
        }
      }
      await a.call({ op: 'receive', digest: gift })
      await b.receive(message => message.payloadDigest === gift)

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
      const aSent = await a.call<{ digest: string; txHashes: string[] }>({
        op: 'send', to: bob.address, text: `${label} from device A`, stampWei: STAMP_WEI,
      })
      const aTxs = await Promise.all(
        aSent.txHashes.map(async txHash => {
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

      if (interruptions) {
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
      // What becomes of the taken operation's other transactions (reported, not checked): its
      // change transfers after the taken nonce were signed against a balance the other
      // device's transactions changed.
      for (const id of last.replacedOperationIds ?? []) {
        const describe = async () => {
          const operation = await evmWalletInternals(b.handle).transactionSetPreparer?.readOperation(id)
          return operation?.members.map(member =>
            `${member.transactionSet?.role} ${member.source.address}:${Transaction.from(member.unsignedTransaction).nonce} ${nativeMemberSuperseded(member) ? 'used by another' : member.observation.state}`)
        }
        const settled = (states: string[] | undefined) =>
          states?.every(state => /used by another|included-/.test(state)) ?? true
        let states = await describe()
        for (let waited = 0; !settled(states) && waited < 120_000; waited += 5000) {
          await b.handle.reobserveNativeOperations?.().catch(() => undefined)
          await sleep(5000)
          states = await describe()
        }
        console.log(`${label}: B's taken operation ${id} ${settled(states) ? 'settled' : 'NOT settled after 120s'}: ${states?.join('; ')}`)
      }
      // B never offers the coin A spent.
      const list = evmWalletInternals(b.handle).coinList!
      for (const tx of collided)
        assert.notEqual(list.get(tx.from!.toLowerCase(), tx.nonce)?.state, 'unspent', `${label}: B no longer offers ${tx.from}:${tx.nonce}`)
      console.log(
        `${label}: B's message delivered, paid ${formatEther(onChain)} by ${got.stampPayments.map(p => p.txHash).join(', ')}; its taken payment ${bTaken.map(tx => tx.hash).join(', ')} never landed`,
      )
    }

    await round('round 1', false, bob)
    // A fresh giver: bob's own change from round 1 may not be spendable as one coin yet.
    const carol = await openMonadWallet(stack, 'carol')
    devices.push(carol)
    await monad.fund(carol.mainAccount, parseEther('1'))
    await round('round 2 (B closed and reopened twice)', true, carol)
    console.log('PASS: the losing device delivered its message, paid once from another coin, both times')
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
        remember(device)
      } catch {
        // Closed already: its coins were remembered when it was open, or are swept below.
      }
      await device.close().catch(() => undefined)
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
