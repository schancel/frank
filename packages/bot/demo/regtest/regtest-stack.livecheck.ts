/**
 * Starts the regtest stack for real and checks it: the node, the faucet, the block driver, the
 * relay's Chronik proxy and the teardown. Costs nothing and needs no configuration.
 *
 *   yarn --cwd packages/bot regtest:check
 */
import assert from 'assert'

import { EcashRegtest } from './ecash-regtest'
import { isListening, sleep } from './regtest-chain'
import { startRegtestStack } from './regtest-stack'

async function bytes(url: string): Promise<Buffer> {
  const response = await fetch(url)
  assert.equal(response.status, 200, `GET ${url} answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  const startedAt = Date.now()
  const stack = await startRegtestStack({ blockIntervalMs: 1000 })
  const ports: number[] = []
  try {
    console.log(`stack up in ${Date.now() - startedAt} ms: relay ${stack.relayUrl}, state ${stack.stateDir}`)
    const xec = stack.chains['xec-regtest'] as EcashRegtest
    const proxy = `${stack.relayUrl}/chain-rpc/xec-regtest/chronik`
    ports.push(Number(new URL(stack.relayUrl).port), Number(new URL(xec.chronikUrl).port))

    // The relay started, so it found the checkpoint block on the node (it refuses to start
    // otherwise). The checkpoint is the block this run's node mined; Chronik carries the hash in
    // the block's byte order, the reverse of the usual hex.
    const block = await bytes(`${xec.chronikUrl}/block/${xec.checkpoint.height}`)
    assert.ok(block.includes(Buffer.from(xec.checkpoint.hash, 'hex').reverse()), 'checkpoint hash')
    const chains = (await (await fetch(`${stack.relayUrl}/chains`)).json()) as {
      chains: Array<{ id: string; network: string; capabilities: string[] }>
    }
    assert.deepEqual(
      chains.chains.map(chain => [chain.id, chain.network, chain.capabilities]),
      [['xec-regtest', 'regtest', ['chronik']]],
    )
    assert.ok((await bytes(`${proxy}/blockchain-info`)).equals(await bytes(`${xec.chronikUrl}/blockchain-info`)))
    console.log(`the relay serves xec-regtest (checkpoint block ${xec.checkpoint.height} ${xec.checkpoint.hash})`)

    // The faucet pays and the payment is in a block, seen through the relay.
    const address = await xec.rpc<string>('getnewaddress')
    const txid = await xec.fund(address, 1_000_000n)
    const tx = await xec.rpc<{ confirmations: number; details: Array<{ address: string; amount: number; category: string }> }>(
      'gettransaction',
      [txid],
    )
    assert.ok(tx.confirmations >= 1, 'the funding payment is confirmed')
    assert.ok(tx.details.some(d => d.category === 'receive' && d.address === address && d.amount === 10_000))
    assert.ok((await bytes(`${proxy}/tx/${txid}`)).equals(await bytes(`${xec.chronikUrl}/tx/${txid}`)))
    console.log(`faucet paid 10000.00 XEC to ${address} in ${txid}, confirmed, served by the relay`)

    // Blocks arrive on the timer without being asked for, and at once when asked.
    const before = await xec.rpc<number>('getblockcount')
    await sleep(2500)
    const afterTimer = await xec.rpc<number>('getblockcount')
    assert.ok(afterTimer >= before + 2, `the timer mined ${afterTimer - before} blocks in 2.5 s`)
    await xec.mine(3)
    assert.ok((await xec.rpc<number>('getblockcount')) >= afterTimer + 3)
    console.log(`blocks: ${before} -> ${afterTimer} on the timer, then 3 more on demand`)
  } finally {
    await stack.stop()
  }
  for (const port of ports) assert.equal(await isListening(port), false, `port ${port} closed`)
  console.log(`stopped; ports ${ports.join(', ')} are closed`)
  console.log('regtest stack: OK')
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err)
    process.exit(1)
  },
)
