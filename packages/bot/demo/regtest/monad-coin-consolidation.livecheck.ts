/**
 * Background coin consolidation on the local Monad network (monad-solonet), through the real
 * relay. Not part of CI.
 *
 *   yarn --cwd packages/bot regtest:monad-consolidation
 *
 * Owner rulings (2026-10-26, 2026-10-27): an idle wallet merges the many small coins stamps and
 * payouts leave, but never what a payment just made as change, with the same thresholds as the
 * change splitter (`packages/wallet/evm-coin-distribution.ts`).
 *
 * A fresh wallet whose account root is written before it first opens gets FRANK_CONSOLIDATION_COINS
 * (default 30) small coins from the faucet on its own change branch, as another device of the
 * account would have left them. The wallet finds them by walking its seed. Checked:
 *   1. An idle maintenance step merges the smallest settled coins into one fresh change account
 *      (one transaction set, the coins moved whole), keeping the newest 4.
 *   2. A paid message sent straight after, while the merge is on its way, is delivered and its
 *      stamp paid: it takes other coins and nothing waits for the merge.
 *   3. Ticking as the app does, the merge's transactions all succeed, the fresh account holds every
 *      merged coin less that coin's own transfer fee, the wallet's pool is back inside the band,
 *      and the next maintenance step does nothing. History names the row a consolidation.
 *
 * Every wallet's funds go back to the faucet at the end, also after a failure (`returnToFaucet`).
 */
import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { formatEther, parseEther, Wallet } from 'ethers'

import { deriveDomainRoot } from '@frank/domain-roots'
import { MonadChangeKeyring } from '@frank/wallet/secp256k1-hd-keyring'
import { evmCoinDistribution } from '@frank/wallet/evm-coin-distribution'
import { classifyEvmOperation } from '@frank/wallet/chain/evm-native-operation-status'
import { checkStampOnChain } from '../two-wallets'
import { MONAD_REGTEST_MIN_STAMP_WEI } from './monad-regtest'
import { monadOf, openMonadWallet, returnToFaucet } from './monad-wallets'
import { startRegtestStack } from './regtest-stack'

async function main(): Promise<boolean> {
  const coinCount = Number(process.env.FRANK_CONSOLIDATION_COINS ?? '30')
  const coinWei = parseEther(process.env.FRANK_CONSOLIDATION_COIN_MON ?? '0.05')
  const stack = await startRegtestStack({ chains: ['monad-regtest'] })
  // The coins' keys, kept so the end sweeps them even when the wallet never listed them.
  const coinKeys: string[] = []
  const problems: string[] = []
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) problems.push(what)
  }
  try {
    const monad = monadOf(stack)
    const gasPrice = BigInt(await monad.provider.send('eth_gasPrice', []))
    const distribution = evmCoinDistribution(gasPrice)
    const stampWei =
      distribution.floorWei > MONAD_REGTEST_MIN_STAMP_WEI ? distribution.floorWei : MONAD_REGTEST_MIN_STAMP_WEI
    console.log(
      `${coinCount} coins of ${formatEther(coinWei)} MON; floor ${formatEther(distribution.floorWei)} MON, band top ${distribution.maxCoins}, merge down to ${distribution.mergeDownToCoins}`,
    )
    const recipient = await openMonadWallet(stack, 'recipient', { stampValueWei: stampWei })

    // The account root first, so the coins are on the wallet's change branch before it opens.
    const label = `consolidating-${randomBytes(4).toString('hex')}`
    const dir = join(stack.stateDir, 'wallets', label)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const accountRoot = randomBytes(32)
    writeFileSync(join(dir, 'account-root.hex'), accountRoot.toString('hex'), { mode: 0o600 })
    const change = MonadChangeKeyring.fromDomainRoot(deriveDomainRoot(Uint8Array.from(accountRoot), 'evm-wallet'))
    accountRoot.fill(0)
    const coins: string[] = []
    for (let index = 0; index < coinCount; index++) {
      const derived = change.deriveChangeAccount(index)
      coins.push(derived.address.toLowerCase())
      coinKeys.push(derived.privateKey)
    }
    // The shared node may answer "overloaded": try a funding again a few times.
    for (const account of coins)
      for (let attempt = 1; ; attempt++)
        try {
          await monad.fund(account, coinWei)
          break
        } catch (error) {
          if (attempt >= 5) throw error
          await new Promise(resolve => setTimeout(resolve, 3000 * attempt))
        }
    await monad.mine(distribution.confirmationBlocks + 6)

    const wallet = await openMonadWallet(stack, label, { stampValueWei: stampWei })
    const held = async (account: string) => monad.provider.getBalance(account)

    // 1. Idle: merge.
    // The wallet lists a coin found by reading the chain at the head it read; it waits the
    // confirmation depth from there, as the app's idle tick would on its next passes.
    let first = await wallet.handle.maintainCoins!()
    for (let pass = 0; pass < 10 && first.outcome === 'idle'; pass++) {
      await monad.mine(1)
      first = await wallet.handle.maintainCoins!()
    }
    check(first.outcome === 'merged', `an idle maintenance step merges (${JSON.stringify(first, (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`)
    if (first.outcome !== 'merged') throw new Error('no merge')
    const expectedMerged = Math.min(coinCount - distribution.mergeDownToCoins + 1, coinCount - distribution.keepNewestCoins)
    check(first.coins === expectedMerged, `it merges ${expectedMerged} coins (merged ${first.coins})`)
    check(!coins.includes(first.target), 'into a fresh change account, not one of the coins')

    // 2. Straight after, while the merge is on its way: a paid message.
    const digest = await wallet.send(recipient.address, [{ type: 'text', text: 'sent during a merge' }], stampWei, 180_000)
    const got = await recipient.receive(message => message.payloadDigest === digest, 60_000)
    const unpaid = await checkStampOnChain(monad.provider, got, stampWei)
    check(unpaid === undefined, `a paid message sent during the merge is delivered and its stamp paid${unpaid ? ` (${unpaid})` : ''}`)

    // 3. Tick as the app does (`startOutgoingReconciliation`): reconcile messages, look again at
    // the wallet's own broadcast transfers, and when nothing is pending take one maintenance
    // step. Until the merge has landed and its fresh account is listed.
    const mergeRow = () =>
      wallet.handle.getNativeOperations!().find(item => item.preparationId === `evm-transaction-set:${first.operationId}`)
    let again: Awaited<ReturnType<NonNullable<typeof wallet.handle.maintainCoins>>> = first
    let ticks = 0
    for (const deadline = Date.now() + 240_000; Date.now() < deadline; ) {
      ticks++
      await wallet.chain.directMessages.reconcileAttempts({ wallet: wallet.handle, payloadDigests: [] })
      await wallet.handle.reobserveNativeOperations?.()
      again = await wallet.handle.maintainCoins!()
      if (again.outcome === 'idle' && (await wallet.handle.getNativeOperations!()).every(item => item.cancelled || item.members.every(member => member.observation.state === 'included-success' || member.observation.state === 'included-revert' || member.signed === null))) break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    console.log(`  merge members: ${mergeRow()?.members.map(member => member.observation.state).join(' ')}`)
    const row = mergeRow()
    check(row !== undefined && classifyEvmOperation(row.preparationId).purpose === 'consolidation', 'History names the merge a consolidation')
    const receipts = await Promise.all(
      (row?.members ?? []).map(member => monad.provider.getTransactionReceipt(member.signed!.transactionHash)),
    )
    check(
      receipts.length === first.coins && receipts.every(receipt => receipt?.status === 1),
      `after ${ticks} tick(s) every move of the merge succeeded (${receipts.map(receipt => receipt?.status ?? 'missing').join(', ')})`,
    )
    const moved = BigInt(first.coins) * (coinWei - distribution.moveFeeWei)
    const targetHeld = await held(first.target)
    check(targetHeld === moved, `the fresh account holds every merged coin less its move fee (${formatEther(targetHeld)} of ${formatEther(moved)} MON)`)
    const left = (await Promise.all(coins.map(held))).filter(value => value >= distribution.floorWei).length
    const pool = left + (targetHeld >= distribution.floorWei ? 1 : 0)
    check(pool <= distribution.maxCoins, `the pool is back inside the band: ${pool} coins of at least the floor (top ${distribution.maxCoins})`)
    check(again.outcome === 'idle', `the next maintenance step does nothing (${again.outcome})`)
    await wallet.close()
    await recipient.close()
  } finally {
    try {
      // Coins the wallet never took over (a failure before it opened) go back first.
      const monad = monadOf(stack)
      await monad.mine(4)
      const gasPrice = BigInt(await monad.provider.send('eth_gasPrice', []))
      const fee = 21_000n * gasPrice
      let swept = 0n
      for (const key of coinKeys) {
        const signer = new Wallet(key, monad.provider)
        const value = await monad.provider.getBalance(signer.address)
        if (value <= 2n * fee) continue
        try {
          const tx = await signer.sendTransaction({ type: 0, to: monad.faucetAddress, value: value - fee, gasLimit: 21_000n, gasPrice })
          if ((await tx.wait(1, 120_000))?.status === 1) swept += value - fee
        } catch {
          /* returnToFaucet below tries the wallet's accounts again */
        }
      }
      if (swept > 0n) console.log(`returned ${formatEther(swept)} MON of unmerged coins to the faucet`)
    } catch {
      /* returnToFaucet below */
    }
    try {
      const { returnedWei, leftWei } = await returnToFaucet(stack)
      console.log(`returned ${formatEther(returnedWei)} MON to the faucet; ${formatEther(leftWei)} MON left as dust or unsweepable`)
    } finally {
      await stack.stop()
    }
  }
  console.log(problems.length === 0 ? 'Monad coin consolidation check: OK' : `Monad coin consolidation check: FAILED (${problems.length})`)
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
