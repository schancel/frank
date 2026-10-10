/**
 * Two wallets exchange paid messages through the real relay on Monad testnet, and what the wallet
 * reports is checked against the chain:
 *
 *   yarn test:two-wallets            (from the repo root; needs .env, see real-stack.ts)
 *
 * The two accounts (alice, bob) are kept in the harness's persistent state directory and reused:
 * an account is given 0.012 testnet MON from the TEST wallet (FRANK_TEST_WALLET_JSON) when it
 * cannot pay for a transfer, and what the accounts hold at the end goes back to that wallet
 * (pass or fail), with a line for anything that could not be moved. Alice sends Bob a stamped message, Bob reads it and answers,
 * Alice reads the answer. For every stamp payment a message reports, the transaction must be
 * mined successfully on chain, pay the address and amount the wallet reported from another
 * account, the destination must hold it, and the amounts must add up to the stamp. Exit code 0
 * only if every check passes.
 */
import { formatEther, type JsonRpcProvider } from 'ethers'

import type { DirectMessageReceived } from '@frank/wallet/chain/active-chain'

import { redact } from './demo'
import { RealStack, RealWallet, startRealStack } from './real-stack'

const FUND_WEI = 12_000_000_000_000_000n // 0.012 MON each
const REUSE_MIN_WEI = 2_000_000_000_000_000n // 0.002 MON
const STAMP_WEI = 1_000_000_000_000n // the relay's minimum stamp, 0.000001 MON

interface Check {
  name: string
  ok: boolean
  detail: string
}

/** The stamp payments a delivered message carries, checked on chain. */
export async function checkStampOnChain(
  provider: JsonRpcProvider,
  message: DirectMessageReceived,
  expectedStampWei: bigint,
): Promise<string | undefined> {
  if (message.stampValueWei !== expectedStampWei) {
    return `the message reports a stamp of ${message.stampValueWei} wei, ${expectedStampWei} was sent`
  }
  let total = 0n
  for (const payment of message.stampPayments) {
    const receipt = await provider.waitForTransaction(payment.txHash, 1, 120_000)
    if (!receipt || receipt.status !== 1) return `stamp payment ${payment.txHash} is not mined successfully`
    const tx = await provider.getTransaction(payment.txHash)
    if (!tx) return `stamp payment ${payment.txHash} is not on chain`
    if (tx.from.toLowerCase() === payment.destinationAddress.toLowerCase()) return `stamp payment ${payment.txHash} pays its own sender`
    if ((tx.to ?? '').toLowerCase() !== payment.destinationAddress.toLowerCase() || tx.value !== payment.valueWei) {
      return `stamp payment ${payment.txHash} pays ${tx.value} wei to ${tx.to}, the wallet reported ${payment.valueWei} to ${payment.destinationAddress}`
    }
    if ((await provider.getBalance(payment.destinationAddress)) < payment.valueWei) {
      return `the stamp's destination ${payment.destinationAddress} does not hold the ${payment.valueWei} wei paid`
    }
    total += payment.valueWei
  }
  if (total !== expectedStampWei) return `the stamp payments on chain add up to ${total} wei, not ${expectedStampWei}`
  return undefined
}

async function exchange(
  stack: RealStack,
  from: RealWallet,
  to: RealWallet,
  text: string,
): Promise<Check> {
  const name = `${from.label} -> ${to.label}`
  try {
    const digest = await from.send(to.address, [{ type: 'text', text }], STAMP_WEI)
    const got = await to.receive(m => m.payloadDigest === digest)
    const texts = got.items.flatMap(i => (i.type === 'text' ? [i.text] : []))
    if (texts.length !== 1 || texts[0] !== text) {
      return { name, ok: false, detail: `received ${JSON.stringify(texts)}, sent ${JSON.stringify(text)}` }
    }
    if (got.senderAddress.raw.toLowerCase() !== from.address.toLowerCase()) {
      return { name, ok: false, detail: `the message is attributed to ${got.senderAddress.raw}, not ${from.address}` }
    }
    const problem = await checkStampOnChain(stack.provider, got, STAMP_WEI)
    if (problem) return { name, ok: false, detail: problem }
    return {
      name,
      ok: true,
      detail: `text delivered; ${got.stampPayments.length} stamp payment(s) of ${STAMP_WEI} wei mined to ${got.stampPayments
        .map(p => p.destinationAddress)
        .join(', ')}`,
    }
  } catch (err) {
    return { name, ok: false, detail: redact(err instanceof Error ? err.message : String(err), []) }
  }
}

export async function runTwoWallets(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const checks: Check[] = []
  let stack: RealStack | undefined
  try {
    stack = await startRealStack({ relayUrl: env.FRANK_REAL_STACK_RELAY_URL })
    console.log(`[two-wallets] relay ${stack.relayUrl}, state ${stack.stateDir}`)
    const alice = await stack.openWallet('alice', { stampValueWei: STAMP_WEI })
    const bob = await stack.openWallet('bob', { stampValueWei: STAMP_WEI })
    for (const wallet of [alice, bob]) {
      // The accounts persist between runs with what they hold; only one that cannot pay for a
      // transfer is funded.
      const held = await stack.provider.getBalance(wallet.mainAccount)
      if (held >= REUSE_MIN_WEI) {
        checks.push({ name: `fund ${wallet.label}`, ok: true, detail: `${wallet.mainAccount} already holds ${formatEther(held)} MON; not funded again` })
        continue
      }
      const txHash = await stack.fund(wallet.mainAccount, FUND_WEI)
      const balance = await stack.provider.getBalance(wallet.mainAccount)
      checks.push({
        name: `fund ${wallet.label}`,
        ok: balance >= FUND_WEI,
        detail: `${wallet.mainAccount} holds ${formatEther(balance)} MON on chain after ${txHash}`,
      })
    }
    const tag = Date.now().toString(36)
    checks.push(await exchange(stack, alice, bob, `ping ${tag}`))
    checks.push(await exchange(stack, bob, alice, `pong ${tag}`))
  } catch (err) {
    checks.push({ name: 'setup', ok: false, detail: redact(err instanceof Error ? err.message : String(err), []) })
  } finally {
    // Whatever happened above (Ctrl-C included, see the harness): what the two accounts hold
    // above their float goes back to the test wallet, and one line says funded, returned, left.
    await stack?.finish().catch(err => checks.push({ name: 'teardown', ok: false, detail: String(err) }))
  }
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`)
  const ok = checks.length > 0 && checks.every(c => c.ok)
  console.log(ok ? '\nTWO WALLETS OK' : `\nTWO WALLETS FAILED${stack ? ` (state and logs kept in ${stack.stateDir})` : ''}`)
  return ok
}

if (require.main === module) {
  runTwoWallets().then(
    ok => process.exit(ok ? 0 : 1),
    err => {
      console.error('two-wallets error:', err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
