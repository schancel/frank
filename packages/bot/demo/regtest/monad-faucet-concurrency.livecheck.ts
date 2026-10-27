/**
 * Two funders paying from the shared solonet faucet at the same time both get paid.
 *
 *   yarn --cwd packages/bot regtest:monad-faucet-concurrency
 *
 * Every check on a solonet funds its accounts from the same faucet account. Two checks running at
 * once read the same pending nonce, and the node turns the second transaction down ("An existing
 * transaction had higher priority", seen 2026-10-27 in regtest:monad-dm-cluster while another
 * process funded). This check runs several funders at once, each as a separate funder would (its
 * own `startMonadRegtest` handle, or the `fund` command's `fundFromFaucet`), round after round,
 * and passes only if every payment landed exactly once. It then sweeps everything back.
 *
 * The fresh keys are written to FRANK_LIVECHECK_KEY_FILE (default: a file in the temp folder)
 * before anything is paid to them, and the file is removed only once they are swept, so a crash
 * never strands funds: `yarn --cwd packages/bot regtest:monad-sweep < <that file>` returns them.
 *
 *   FRANK_FAUCET_FUNDERS  funders at once (default 4)
 *   FRANK_FAUCET_ROUNDS   rounds (default 3)
 */
import { appendFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { formatEther, parseEther, Wallet } from 'ethers'

import { fundFromFaucet, startMonadRegtest, sweepToFaucet } from './monad-regtest'

const FUNDERS = Number(process.env.FRANK_FAUCET_FUNDERS ?? 4)
const ROUNDS = Number(process.env.FRANK_FAUCET_ROUNDS ?? 3)
const AMOUNT = parseEther('0.05')
const KEY_FILE = process.env.FRANK_LIVECHECK_KEY_FILE ?? join(tmpdir(), `frank-faucet-concurrency-${process.pid}.keys`)

async function main(): Promise<void> {
  writeFileSync(KEY_FILE, '', { mode: 0o600 })
  const keys: string[] = []
  const handles = await Promise.all(Array.from({ length: Math.ceil(FUNDERS / 2) }, () => startMonadRegtest()))
  const provider = handles[0].provider
  const failures: string[] = []
  try {
    for (let round = 1; round <= ROUNDS; round++) {
      const wallets = Array.from({ length: FUNDERS }, () => Wallet.createRandom())
      // Written down before any of them is paid.
      for (const wallet of wallets) {
        appendFileSync(KEY_FILE, `${wallet.privateKey}\n`)
        keys.push(wallet.privateKey)
      }
      const results = await Promise.allSettled(
        wallets.map((wallet, i) =>
          i % 2 === 0 ? handles[i / 2].fund(wallet.address, AMOUNT) : fundFromFaucet(wallet.address, AMOUNT),
        ),
      )
      for (const [i, result] of results.entries()) {
        const address = wallets[i].address
        const balance = await provider.getBalance(address)
        if (result.status === 'rejected') {
          failures.push(`round ${round} funder ${i}: ${result.reason instanceof Error ? result.reason.message : result.reason}`)
        } else if (balance !== AMOUNT) {
          failures.push(`round ${round} funder ${i}: ${address} holds ${formatEther(balance)} MON, not ${formatEther(AMOUNT)}`)
        }
      }
      console.log(`round ${round}: ${results.filter(r => r.status === 'fulfilled').length} of ${FUNDERS} funders paid`)
    }
  } finally {
    let unswept = 0
    for (const key of keys) {
      try {
        await sweepToFaucet(key)
      } catch (error) {
        unswept += 1
        console.error(`sweep of ${new Wallet(key).address} failed:`, error instanceof Error ? error.message : error)
      }
    }
    for (const handle of handles) await handle.stop()
    if (unswept === 0) rmSync(KEY_FILE, { force: true })
    else console.error(`${unswept} keys not swept; they are in ${KEY_FILE}`)
  }
  if (failures.length) throw new Error(`concurrent faucet funding failed:\n  ${failures.join('\n  ')}`)
  console.log(`PASS: ${FUNDERS} funders at once, ${ROUNDS} rounds, every payment landed once; all swept back`)
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    error => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    },
  )
}
