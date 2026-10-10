/**
 * Funded eCash sends end to end on the local regtest stack. Costs nothing and needs no
 * configuration.
 *
 *   yarn --cwd packages/bot regtest:ecash-send
 *
 * Two checks, each also callable on a stack another script started:
 *   ecashWalletsPayEachOther(stack)  two real wallets, opened the way the app opens them (through
 *                                    the relay's Chronik proxy), pay each other, and every payment
 *                                    is read back from the node itself
 *   walletFundedSendCheck(stack)     the wallet package's own funded send check
 *                                    (packages/wallet/utxo-funded-send.livecheck.ts), funded from
 *                                    the node's faucet instead of testnet coins
 */
import assert from 'assert'
import { spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { writeFileSync } from 'fs'
import { join, resolve } from 'path'

import { InMemoryNativeTransactionAttemptStore } from '@frank/wallet/chain/chain-wallet'
import { openRelayUtxoChain } from '@frank/wallet/chain/utxo-family'

import { EcashRegtest } from './ecash-regtest'
import { RegtestStack, startRegtestStack } from './regtest-stack'

const CHAIN = 'xec-regtest'

const WALLET_PACKAGE = resolve(__dirname, '..', '..', '..', 'wallet')

/** Runs the wallet package's funded send check on `xec-regtest`: first unfunded (it names the
 * address to fund and exits 2), then funded from the faucet (it must send and exit 0). */
export async function walletFundedSendCheck(stack: RegtestStack): Promise<void> {
  const xec = stack.chains[CHAIN] as EcashRegtest
  const seedFile = join(stack.stateDir, 'funded-send-seed.hex')
  writeFileSync(seedFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  const run = () =>
    spawnSync(process.execPath, ['--import', 'tsx', 'utxo-funded-send.livecheck.ts', CHAIN], {
      cwd: WALLET_PACKAGE,
      env: {
        ...process.env,
        // This package's tsconfig maps the workspace packages to their sources. Without it Node
        // cannot load @frank/nakamoto, which publishes no CommonJS entry.
        TSX_TSCONFIG_PATH: resolve(__dirname, '..', '..', 'tsconfig.json'),
        FRANK_LIVE_RELAY_URL: stack.relayUrl,
        FRANK_UTXO_TEST_SEED_FILE: seedFile,
        FRANK_UTXO_CHECKPOINT: `${xec.checkpoint.height}:${xec.checkpoint.hash}`,
      },
      encoding: 'utf8',
    })
  const unfunded = run()
  const address = /fund (ecregtest:\S+)/.exec(unfunded.stdout)?.[1]
  assert.ok(unfunded.status === 2 && address, `expected "not funded" (exit 2):\n${unfunded.stdout}${unfunded.stderr}`)
  await xec.fund(address, 100_000n)
  const funded = run()
  assert.equal(funded.status, 0, `the funded send check failed:\n${funded.stdout}${funded.stderr}`)
  console.log(funded.stdout.trimEnd())
}

/** Two wallets opened through the relay pay each other; each payment is read back from the node. */
export async function ecashWalletsPayEachOther(stack: RegtestStack): Promise<void> {
  const xec = stack.chains[CHAIN] as EcashRegtest
  const open = async (checkpoint = xec.checkpoint) => {
    const network = openRelayUtxoChain({
      chainIdentifier: CHAIN,
      relayBaseUrl: stack.relayUrl,
      checkpoint,
      // Node has no browser storage for the record of a send in progress.
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    return { chain: network.chain, wallet: await network.createWallet(Uint8Array.from(randomBytes(32))) }
  }
  /** The unspent output of `txid` paying `address`, read from the node, with its confirmations. */
  const paidOnChain = async (txid: string, address: string) => {
    for (let index = 0; index < 4; index++) {
      const output = await xec.rpc<{ value: number; confirmations: number; scriptPubKey: { addresses?: string[] } } | null>(
        'gettxout',
        [txid, index],
      )
      if (output?.scriptPubKey.addresses?.includes(address)) {
        return { sats: BigInt(Math.round(output.value * 100)), confirmations: output.confirmations }
      }
    }
    throw new Error(`the node has no unspent output of ${txid} paying ${address}`)
  }

  // A wallet is refused without this run's checkpoint block, and with another chain's.
  await assert.rejects(
    openRelayUtxoChain({ chainIdentifier: CHAIN, relayBaseUrl: stack.relayUrl }).createWallet(randomBytes(32)),
    /needs the checkpoint block/,
  )
  await assert.rejects(open({ height: xec.checkpoint.height, hash: 'ab'.repeat(32) }), /checkpoint mismatch/)
  console.log('a wallet without the checkpoint, or with a wrong one, is refused')

  const alice = await open()
  const bob = await open()
  const aliceAddress = (await alice.wallet.getReceiveAddress()).raw
  const bobAddress = (await bob.wallet.getReceiveAddress()).raw
  assert.ok(aliceAddress.startsWith('ecregtest:') && bobAddress.startsWith('ecregtest:'))
  assert.equal(await alice.chain.nativeTransfers.getBalance({ wallet: alice.wallet }), 0n)

  const funding = await xec.fund(aliceAddress, 1_000_000n)
  const funded = await paidOnChain(funding, aliceAddress)
  assert.ok(funded.sats === 1_000_000n && funded.confirmations >= 1)
  assert.equal(await alice.chain.nativeTransfers.getBalance({ wallet: alice.wallet }), 1_000_000n)
  console.log(`alice ${aliceAddress} funded with 10000.00 XEC in ${funding}`)

  // Alice pays Bob. Broadcast goes through the relay; the node then has the payment.
  const sent = await alice.chain.nativeTransfers.send({
    wallet: alice.wallet,
    recipient: { raw: bobAddress },
    value: 250_000n,
  })
  assert.equal((await paidOnChain(sent.txHash, bobAddress)).sats, 250_000n)
  await xec.mine()
  assert.ok((await paidOnChain(sent.txHash, bobAddress)).confirmations >= 1)
  assert.equal(
    await alice.chain.nativeTransfers.getTransactionStatus({ wallet: alice.wallet, transaction: sent }),
    'confirmed',
  )
  assert.equal(await bob.chain.nativeTransfers.getBalance({ wallet: bob.wallet }), 250_000n)
  const aliceAfter = await alice.chain.nativeTransfers.getBalance({ wallet: alice.wallet })
  const fee = 1_000_000n - 250_000n - aliceAfter
  assert.ok(fee > 0n && fee < 10_000n, `alice paid a fee of ${fee} satoshis`)
  console.log(`alice paid bob 2500.00 XEC in ${sent.txHash} (fee ${fee} sat), confirmed on the node`)

  // Bob spends what he received.
  const back = await bob.chain.nativeTransfers.send({
    wallet: bob.wallet,
    recipient: { raw: aliceAddress },
    value: 100_000n,
  })
  await xec.mine()
  assert.ok((await paidOnChain(back.txHash, aliceAddress)).confirmations >= 1)
  assert.equal(await alice.chain.nativeTransfers.getBalance({ wallet: alice.wallet }), aliceAfter + 100_000n)
  console.log(`bob paid alice 1000.00 XEC back in ${back.txHash}, confirmed on the node`)
}

async function main() {
  const stack = await startRegtestStack()
  try {
    await ecashWalletsPayEachOther(stack)
    await walletFundedSendCheck(stack)
  } finally {
    await stack.stop()
  }
  console.log('eCash regtest send: OK')
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
