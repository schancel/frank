// JSON-RPC shim between the relays and the local EVM node. It is a harness stand-in, not a chain:
//
//  1. The relay refuses to start unless its upstream reports the protocol-pinned Monad testnet
//     hash at height zero. A local EVM node has its own genesis, so this shim substitutes the
//     pinned hash in block-zero responses (the repo's fake RPC does the same). Nothing else about
//     a block is rewritten.
//  2. The relay verifies payments with `eth_getRawTransactionByHash`, which Monad nodes serve and
//     Hardhat does not. The shim answers it from the raw transactions it has relayed, falling
//     back to re-serializing the node's `eth_getTransactionByHash` result.
//
// Never point this at anything holding value.
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Transaction, keccak256 } from 'ethers'
import { HOST, PORTS, PINNED_GENESIS, P } from './config.mjs'

const raw = new Map(existsSync(P.rawTx) ? Object.entries(JSON.parse(readFileSync(P.rawTx, 'utf8'))) : [])
const persist = () => writeFileSync(P.rawTx, JSON.stringify(Object.fromEntries(raw)))

function upstream(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = httpRequest(
      { host: HOST, port: PORTS.chain, method: 'POST', path: '/', headers: { 'content-type': 'application/json', 'content-length': data.length } },
      res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

async function one(call) {
  const reply = result => ({ jsonrpc: '2.0', id: call.id ?? null, result })
  if (call.method === 'eth_getRawTransactionByHash') {
    const hash = String(call.params?.[0] ?? '').toLowerCase()
    if (raw.has(hash)) return reply(raw.get(hash))
    const found = await upstream({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] })
    const tx = found.result
    if (!tx) return reply(null)
    const serialized = Transaction.from({
      type: Number(tx.type),
      chainId: tx.chainId ?? undefined,
      nonce: Number(tx.nonce),
      to: tx.to,
      value: tx.value,
      data: tx.input,
      gasLimit: tx.gas,
      gasPrice: Number(tx.type) < 2 ? tx.gasPrice : undefined,
      maxFeePerGas: tx.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? undefined,
      accessList: tx.accessList ?? undefined,
      signature: { r: tx.r, s: tx.s, yParity: Number(tx.yParity ?? (BigInt(tx.v) % 2n === 0n ? 1 : 0)) & 1 },
    }).serialized
    if (keccak256(serialized) !== hash) return { jsonrpc: '2.0', id: call.id ?? null, error: { code: -32000, message: 'shim could not reproduce the raw transaction' } }
    return reply(serialized)
  }
  const answer = await upstream(call)
  if (call.method === 'eth_sendRawTransaction' && typeof answer.result === 'string') {
    raw.set(answer.result.toLowerCase(), call.params[0])
    persist()
  }
  if (call.method === 'eth_getBlockByNumber' && answer.result && BigInt(answer.result.number) === 0n) answer.result.hash = PINNED_GENESIS
  if (call.method === 'eth_getBlockByNumber' && answer.result && BigInt(answer.result.number) === 1n) answer.result.parentHash = PINNED_GENESIS
  return answer
}

createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)
      const methods = (Array.isArray(body) ? body : [body]).map(c => c.method).join(',')
      console.log(`${new Date().toISOString()} ${methods}`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    } catch (e) {
      console.log(`${new Date().toISOString()} ERROR ${e?.message}`)
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'chain shim upstream failure' } }))
    }
  })
}).listen(PORTS.chainShim, HOST, () => console.log(`chain shim on http://${HOST}:${PORTS.chainShim} -> ${PORTS.chain}`))
