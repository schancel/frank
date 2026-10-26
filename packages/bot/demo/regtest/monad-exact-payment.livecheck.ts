/**
 * The recipient of a paid message receives exactly the stamp the sender asked for, checked on
 * the local Monad network (monad-solonet) through a real relay. Not part of CI.
 *
 *   FRANK_EXACT_RELAY=http://127.0.0.1:18180 yarn --cwd packages/bot regtest:monad-exact-payment
 *
 * The relay is the cluster lab (docs/plans/relay-ha-cluster-local-test.md) or any relay on
 * solonet. Two fresh wallets: alice is funded from the faucet and pays bob stamps of several
 * sizes, so her later payments draw on the change accounts her first ones made, and several
 * draw on part of a coin or on several coins. Bob then pays alice back from the stamp coins he
 * received, as a bot's refund does. For every message, the values of its payment transactions
 * on chain add up to the stamp exactly. Everything left is swept back to the faucet.
 */
import assert from 'assert'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { formatEther, parseEther } from 'ethers'

import type { RealWallet } from '../real-stack'
import { startMonadRegtest } from './monad-regtest'
import { openMonadWallet, returnToFaucet } from './monad-wallets'
import type { RegtestStack } from './regtest-stack'
import { sleep } from './regtest-chain'
import { evmPaymentFloorWei } from '@frank/wallet/chain/payment-floor'

const RELAY = process.env.FRANK_EXACT_RELAY ?? 'http://127.0.0.1:18180'
const FUND_WEI = parseEther(process.env.FRANK_EXACT_FUND ?? '5')

async function main() {
  const monad = await startMonadRegtest()
  const stateDir = mkdtempSync(join(process.env.FRANK_EXACT_DIR ?? tmpdir(), 'frank-exact-'))
  const stack: RegtestStack = {
    relayUrl: RELAY,
    relayUrls: [RELAY],
    chains: { [monad.chainIdentifier]: monad },
    stateDir,
    relayLogPath: '',
    stop: async () => {},
  }
  const floor = evmPaymentFloorWei(BigInt(await monad.provider.send('eth_gasPrice', [])))
  const wallets: RealWallet[] = []
  const lines: string[] = []
  let failed = false
  try {
    const alice = await openMonadWallet(stack, 'alice', { stampValueWei: floor })
    const bob = await openMonadWallet(stack, 'bob', { stampValueWei: floor })
    wallets.push(alice, bob)
    await monad.fund(alice.mainAccount, FUND_WEI)
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
    for (const wallet of wallets) await wallet.close().catch(() => undefined)
    const swept = await returnToFaucet(stack)
    console.log(`swept ${formatEther(swept.returnedWei)} back to the faucet; left ${formatEther(swept.leftWei)} (dust or in flight)`)
    monad.provider.destroy()
  }
  process.exit(failed ? 1 : 0)
}

if (require.main === module) void main()
