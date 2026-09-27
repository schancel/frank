/**
 * Ticket #8, acceptance criterion 4: "The relay's stamp-tx broadcast is independently visible
 * on-chain via Alchemy (e.g. `eth_getTransactionReceipt` on the broadcast tx hash)."
 *
 * Deliberately minimal and dependency-free (no `ethers`, no wallet/keyring code, nothing shared
 * with `monad-e2e-demo.livecheck.ts` beyond the tx hash string) -- a plain `fetch` POST of a raw
 * JSON-RPC `eth_getTransactionReceipt` call, run as its own separate `node` process. This is the
 * "a process that didn't send it" independent check the ticket asks for: it never touches the
 * wallet/pool/relay code that produced the tx, it only asks Alchemy's real Monad testnet endpoint
 * "does this tx hash exist and what does its receipt say", exactly what a skeptical third party
 * would do to confirm the demo's claim.
 *
 * Usage (from `app/`, after compiling alongside the e2e demo -- see that file's header for the
 * exact `tsc` invocation; this file has no extra dependencies beyond Node's built-in `fetch`):
 *
 *   node /tmp/monad-e2e-demo/verify-onchain-tx.livecheck.js <tx_hash> [rpc_url]
 *
 * `rpc_url` defaults to `process.env.MONAD_TESTNET_HTTP_RPC_URL`. If neither `<tx_hash>` nor
 * `/tmp/e2e-demo-stamp-tx.json` (written by `monad-e2e-demo.livecheck.ts`) is available, this
 * exits with a usage error.
 */
import { readFileSync, existsSync } from 'fs'

interface JsonRpcReceipt {
  transactionHash: string
  blockNumber: string
  blockHash: string
  from: string
  to: string | null
  status: string
  gasUsed: string
}

async function callJsonRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as {
    result?: T
    error?: { code: number; message: string }
  }
  if (body.error) {
    throw new Error(
      `RPC error calling ${method}: ${JSON.stringify(body.error)}`,
    )
  }
  if (body.result === undefined) {
    throw new Error(
      `RPC call ${method} returned no result: ${JSON.stringify(body)}`,
    )
  }
  return body.result
}

async function main() {
  const rpcUrl = process.argv[3] ?? process.env.MONAD_TESTNET_HTTP_RPC_URL
  if (!rpcUrl) {
    throw new Error(
      'No RPC URL: pass it as the second CLI arg, or set MONAD_TESTNET_HTTP_RPC_URL',
    )
  }

  let txHash = process.argv[2]
  if (!txHash) {
    const handoffPath = '/tmp/e2e-demo-stamp-tx.json'
    if (!existsSync(handoffPath)) {
      throw new Error(
        'Usage: verify-onchain-tx.livecheck.js <tx_hash> [rpc_url] (no tx hash given, and no ' +
          `handoff file at ${handoffPath} from a prior monad-e2e-demo.livecheck.js run)`,
      )
    }
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf8')) as {
      txHash: string
    }
    txHash = handoff.txHash
    console.log(`Read tx hash from handoff file ${handoffPath}: ${txHash}`)
  }

  console.log(`\n== Independently verifying ${txHash} against ${rpcUrl} ==`)
  console.log(
    '(this process shares no state with whatever sent this transaction)',
  )

  const chainIdHex = await callJsonRpc<string>(rpcUrl, 'eth_chainId', [])
  console.log(`Chain ID: ${chainIdHex} (${parseInt(chainIdHex, 16)})`)

  const receipt = await callJsonRpc<JsonRpcReceipt | null>(
    rpcUrl,
    'eth_getTransactionReceipt',
    [txHash],
  )
  if (!receipt) {
    throw new Error(
      `eth_getTransactionReceipt returned null for ${txHash} -- not yet mined, or wrong hash/chain`,
    )
  }

  console.log('\nReceipt found on-chain:')
  console.log(`  blockNumber: ${parseInt(receipt.blockNumber, 16)}`)
  console.log(`  blockHash:   ${receipt.blockHash}`)
  console.log(`  from:        ${receipt.from}`)
  console.log(`  to:          ${receipt.to}`)
  console.log(
    `  status:      ${receipt.status} (${
      receipt.status === '0x1' ? 'success' : 'FAILED'
    })`,
  )
  console.log(`  gasUsed:     ${parseInt(receipt.gasUsed, 16)}`)

  const tx = await callJsonRpc<{ value: string; input: string }>(
    rpcUrl,
    'eth_getTransactionByHash',
    [txHash],
  )
  console.log(`  value:       ${BigInt(tx.value)} wei`)
  console.log(`  calldata:    ${tx.input}`)

  if (receipt.status !== '0x1') {
    throw new Error('Transaction receipt status is not success')
  }

  console.log(
    '\nIndependently confirmed: this transaction is real, mined, and successful on Monad testnet.',
  )
}

main().catch(err => {
  console.error('\nINDEPENDENT VERIFICATION FAILED:', err)
  process.exit(1)
})
