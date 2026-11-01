/**
 * The recipient of a paid message receives exactly the stamp the sender asked for, checked on
 * the local Monad network (monad-solonet) through a real relay. Not part of CI.
 *
 *   FRANK_EXACT_DIR=/absolute/new-owned-run FRANK_EXACT_RELAY="$FRESH_RELAY" \
 *   FRANK_SOLONET_RPC_URL=http://127.0.0.1:48090 FRANK_SOLONET_KEY_DIR=/absolute/new-owned-run/faucet-journal \
 *     yarn --cwd packages/bot regtest:monad-exact-payment
 *
 * The relay is the cluster lab (docs/plans/relay-ha-cluster-local-test.md) or any relay on
 * solonet. Two fresh wallets: alice is funded from the faucet and pays bob stamps of several
 * sizes, so her later payments draw on the change accounts her first ones made, and several
 * draw on part of a coin or on several coins. Bob then pays alice back from the stamp coins he
 * received, as a bot's refund does. For every message, the values of its payment transactions
 * on chain add up to the stamp exactly. Everything left is swept back to the faucet.
 */
import assert from 'assert'
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'

import { formatEther, parseEther } from 'ethers'

import type { RealWallet } from '../real-stack'
import { startMonadRegtest } from './monad-regtest'
import { fundWithPublicIntent, openMonadWallet, returnToFaucet } from './monad-wallets'
import type { RegtestStack } from './regtest-stack'
import { sleep } from './regtest-chain'
import { evmPaymentFloorWei } from '@frank/wallet/chain/payment-floor'

export async function main() {
  const RELAY = process.env.FRANK_EXACT_RELAY
  if (!RELAY || !process.env.FRANK_SOLONET_RPC_URL)
    throw new Error('FRANK_EXACT_RELAY and FRANK_SOLONET_RPC_URL must explicitly select the setup relay and chain')
  for (const value of [RELAY, process.env.FRANK_SOLONET_RPC_URL]) {
    const endpoint = new URL(value!)
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
      throw new Error('setup relay and chain require explicit HTTP endpoints')
  }
  const FUND_WEI = parseEther(process.env.FRANK_EXACT_FUND ?? '5')
  if (FUND_WEI <= 0n) throw new Error('setup funding amount must be positive')
  const base = process.env.FRANK_EXACT_DIR
  if (!base || !isAbsolute(base) || base !== resolve(base))
    throw new Error('FRANK_EXACT_DIR must be a new canonical absolute owned state root')
  const originalRoot = lstatSync(base)
  if (!originalRoot.isDirectory() || originalRoot.isSymbolicLink())
    throw new Error('FRANK_EXACT_DIR must be an original directory, not a symlink')
  const intentPath = join(base, 'funding-intent.json')
  if (existsSync(intentPath)) throw new Error('setup funding intent already exists; reconcile the original run, do not rerun setup')
  // Validate the actual process scanner root BEFORE startMonadRegtest can inspect leftovers.
  const keyRoot = process.env.FRANK_SOLONET_KEY_DIR
  if (!keyRoot || !isAbsolute(keyRoot) || keyRoot !== resolve(keyRoot))
    throw new Error('FRANK_SOLONET_KEY_DIR must explicitly name a canonical absolute fresh run directory')
  const within = relative(base, keyRoot)
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error('setup key directory must be strictly inside FRANK_EXACT_DIR')
  const parts = within.split(sep)
  let parent = base
  for (const part of parts) {
    const directory = lstatSync(parent)
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        readdirSync(parent).some(name => name !== part))
      throw new Error('setup root must be fresh and contain only its new key directory')
    parent = join(parent, part)
  }
  const keys = lstatSync(parent)
  if (!keys.isDirectory() || keys.isSymbolicLink() || readdirSync(parent).length !== 0)
    throw new Error('setup key directory must be a fresh empty original directory, not a symlink')
  // Resolve trusted ancestor aliases (such as macOS /var) only after every in-root component
  // was checked. The scanner receives this validated process value, never its global default.
  const actualBase = realpathSync(base)
  const actualKeys = realpathSync(parent)
  const actualWithin = relative(actualBase, actualKeys)
  if (!actualWithin || actualWithin === '..' || actualWithin.startsWith(`..${sep}`) || isAbsolute(actualWithin))
    throw new Error('setup key directory resolved outside its original run')
  process.env.FRANK_SOLONET_KEY_DIR = actualKeys
  const monad = await startMonadRegtest()
  let stateDir: string
  try { stateDir = mkdtempSync(join(base, 'frank-exact-')) }
  catch (error) { monad.provider.destroy(); throw error }
  const stack: RegtestStack = {
    relayUrl: RELAY,
    relayUrls: [RELAY],
    chains: { [monad.chainIdentifier]: monad },
    stateDir,
    relayLogPath: '',
    // This check never deletes its state directory, so the wallets' keys always stay.
    fundsReturned: () => {},
    stop: async () => {},
  }
  const wallets: RealWallet[] = []
  const lines: string[] = []
  let failed = false
  try {
    const floor = evmPaymentFloorWei(BigInt(await monad.provider.send('eth_gasPrice', [])))
    const alice = await openMonadWallet(stack, 'alice', { stampValueWei: floor })
    const bob = await openMonadWallet(stack, 'bob', { stampValueWei: floor })
    wallets.push(alice, bob)
    await fundWithPublicIntent(stack, alice, FUND_WEI, intentPath)
    console.log(`state ${stateDir}; alice ${alice.mainAccount} funded ${formatEther(FUND_WEI)}; stamp floor ${floor}`)

    const pay = async (from: RealWallet, to: RealWallet, amountWei: bigint, label: string) => {
      const text = `${label} ${amountWei} ${Date.now()}`
      let digest: string | undefined
      // A fresh deposit or a just-spent account may not be spendable yet; nothing is signed then.
      for (let tries = 0; ; tries++) {
        try {
          digest = await from.send(to.address, [{ type: 'text', text }], amountWei)
          break
        } catch (err) {
          if (tries >= 20 || (err as Error).name !== 'InsufficientStampFundsError') throw err
          await sleep(3000)
        }
      }
      const got = await to.receive(message => message.payloadDigest === digest)
      let onChain = 0n
      const hashes: string[] = []
      for (const payment of got.stampPayments) {
        const receipt = await monad.provider.waitForTransaction(payment.txHash, 1, 120_000)
        assert.equal(receipt?.status, 1, `payment ${payment.txHash} mined`)
        const tx = await monad.provider.getTransaction(payment.txHash)
        assert.ok(tx, `payment ${payment.txHash} on chain`)
        onChain += tx.value
        hashes.push(`${payment.txHash} ${tx.value}`)
      }
      const line = `${label}: asked ${amountWei} (${formatEther(amountWei)}), recipient got ${onChain} on chain in ${hashes.length} tx: ${hashes.join(', ')}`
      console.log(line)
      lines.push(line)
      assert.equal(got.stampValueWei, amountWei, `${label}: the recipient counts the stamp exactly`)
      assert.equal(onChain, amountWei, `${label}: the chain carried exactly the stamp`)
    }

    const sizes = [
      ['stamp floor', floor],
      ['raffle entry', parseEther('0.02')],
      ['vendor purchase', parseEther('0.05')],
      ['larger', parseEther('0.3')],
      ['odd', 1_234_567_890_123_456_789n],
      ['raffle entry again', parseEther('0.02')],
      ['small', parseEther('0.0123')],
      ['raffle entry third', parseEther('0.02')],
      ['stamp floor again', floor],
    ] as const
    for (const [label, amount] of sizes) await pay(alice, bob, amount, `alice→bob ${label}`)
    // Bob holds only the stamp coins he received: pays back from several of them (a refund).
    await pay(bob, alice, parseEther('0.05'), 'bob→alice refund-shaped')
    await pay(bob, alice, parseEther('0.02'), 'bob→alice refund-shaped')
    console.log('every recipient received exactly the asked amount')
  } catch (err) {
    failed = true
    console.error(err)
  } finally {
    try {
      for (const wallet of wallets) {
        try { await wallet.close() }
        catch { failed = true; console.error('original wallet could not close; state retained for reconciliation') }
      }
      const swept = await returnToFaucet(stack)
      if (swept.unswept !== 0 || swept.leftWei !== 0n) {
        failed = true
        console.error('original return accounting remains incomplete; state and intent retained')
      } else if (!failed) stack.fundsReturned()
      console.log(`swept ${formatEther(swept.returnedWei)} back to the faucet; left ${formatEther(swept.leftWei)} (dust or in flight)`)
    } catch {
      failed = true
      console.error('original return failed; state and intent retained for reconciliation')
    } finally { monad.provider.destroy() }
  }
  return !failed
}

if (require.main === module) {
  main().then(
    ok => process.exit(ok ? 0 : 1),
    error => { console.error(error); process.exit(1) },
  )
}
