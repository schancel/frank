/**
 * The Monad regtest stack, checked for real: the real relay on a local Monad network
 * (monad-solonet), contracts deployed, and two wallets exchanging a paid and a free message with
 * every stamp payment read back from the chain. Costs nothing and needs no `.env`.
 *
 *   yarn --cwd packages/bot regtest:monad-check
 *
 * The first run starts the VM and the chain (5 to 8 minutes, see monad-regtest.ts); later runs
 * reuse them and take well under a minute. Not part of CI.
 */
import assert from 'assert'

import { formatEther, parseEther } from 'ethers'

import { checkStampOnChain } from '../two-wallets'
import type { RealWallet } from '../real-stack'
import { MONAD_REGTEST_MIN_STAMP_WEI } from './monad-regtest'
import { deployMonadContracts, monadOf, openMonadWallet } from './monad-wallets'
import { RegtestStack, startRegtestStack } from './regtest-stack'

const STAMP_WEI = MONAD_REGTEST_MIN_STAMP_WEI
/** Well above Monad's 10 MON reserve, so this check is not about the reserve rule
 * (monad-reserve.livecheck.ts is). */
const FUND_WEI = parseEther('50')

async function exchange(stack: RegtestStack, from: RealWallet, to: RealWallet, text: string, stampWei: bigint) {
  const monad = monadOf(stack)
  const digest = await from.send(to.address, [{ type: 'text', text }], stampWei)
  const got = await to.receive(message => message.payloadDigest === digest)
  assert.deepEqual(
    got.items.flatMap(item => (item.type === 'text' ? [item.text] : [])),
    [text],
  )
  assert.equal(got.senderAddress.raw.toLowerCase(), from.address.toLowerCase())
  const problem = await checkStampOnChain(monad.provider, got, stampWei)
  assert.equal(problem, undefined, problem)
  console.log(
    stampWei === 0n
      ? `${from.label} -> ${to.label}: free message delivered, no payment`
      : `${from.label} -> ${to.label}: delivered; ${got.stampPayments.length} stamp payment(s) of ${stampWei} wei mined: ${got.stampPayments
          .map(payment => payment.txHash)
          .join(', ')}`,
  )
}

async function main() {
  const startedAt = Date.now()
  const stack = await startRegtestStack({ chains: ['monad-regtest'] })
  try {
    const monad = monadOf(stack)
    console.log(
      `stack up in ${Math.round((Date.now() - startedAt) / 1000)} s: relay ${stack.relayUrl} on ${monad.chainIdentifier} (checkpoint block ${monad.checkpoint.height} ${monad.checkpoint.hash}), chain at block ${await monad.provider.getBlockNumber()}`,
    )
    const chains = (await (await fetch(`${stack.relayUrl}/chains`)).json()) as {
      chains: Array<{ id: string; network: string; native_chain_id: string }>
    }
    assert.deepEqual(
      chains.chains.map(chain => [chain.id, chain.network, chain.native_chain_id]),
      [['monad-regtest', 'regtest', '20143']],
    )

    const record = await deployMonadContracts(stack)
    for (const [name, contract] of Object.entries(record.contracts)) {
      assert.notEqual(await monad.provider.getCode(contract.address), '0x', `${name} has code`)
      console.log(`${name} deployed at ${contract.address} (${contract.deployedVia})`)
    }

    const alice = await openMonadWallet(stack, 'alice', { stampValueWei: STAMP_WEI, contracts: record })
    assert.equal(alice.chain.getHtlcAddress?.(), record.contracts.GenericHTLC.address)
    assert.equal(alice.chain.getStateChannelAddress?.(), record.contracts.StateChannel.address)
    const bob = await openMonadWallet(stack, 'bob', { stampValueWei: STAMP_WEI })
    for (const wallet of [alice, bob]) {
      const txHash = await monad.fund(wallet.mainAccount, FUND_WEI)
      assert.equal(await monad.provider.getBalance(wallet.mainAccount), FUND_WEI)
      console.log(`${wallet.label} ${wallet.mainAccount} funded with ${formatEther(FUND_WEI)} MON in ${txHash}`)
    }
    await exchange(stack, alice, bob, 'paid ping', STAMP_WEI)
    await exchange(stack, bob, alice, 'paid pong', STAMP_WEI)
    await exchange(stack, alice, bob, 'free ping', 0n)
    await exchange(stack, bob, alice, 'free pong', 0n)
  } finally {
    await stack.stop()
  }
  console.log(`Monad regtest: OK (${Math.round((Date.now() - startedAt) / 1000)} s; the chain keeps running, stop it with regtest:monad-stop)`)
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
