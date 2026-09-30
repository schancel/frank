/**
 * A tiny fake Monad JSON-RPC for the demo's `--fake-chain` mode and its smoke test (#312). It is
 * NOT a chain: every address has a fixed generous balance, every accepted raw transaction is
 * "mined" immediately, and nothing is ever validated beyond parsing. Balances are a simple ledger
 * (value and fee moved on each accepted transaction, never below zero; only `funded` addresses
 * start with anything), so a fresh profile really shows 0 until the faucet's transfer arrives.
 * That is enough for the relay
 * to accept a stamped message (it fetches the payment transaction and its receipt) and for the
 * bots to fund sub-accounts and send transfers, so the whole demo runs with no keys or funds.
 * Never point anything holding real value at it.
 *
 * Control/inspection: `GET /_ctl` returns every transaction seen, `[{hash, from, to, valueWei}]`.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'

import { Transaction } from 'ethers'

const CHAIN_ID = 10143
/** Starting balance of each `funded` address: far more than any demo spends. */
const FUNDED_BALANCE_WEI = 1_000_000n * 10n ** 18n
const ZERO32 = `0x${'00'.repeat(32)}`
const BLOCK_HASH = `0x${'11'.repeat(32)}`

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`

export interface FakeChainTx {
  hash: string
  from: string
  to: string | null
  valueWei: string
}

export interface FakeRpc {
  url: string
  port: number
  transactions(): FakeChainTx[]
  close(): Promise<void>
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

export async function startFakeRpc(params: {
  port: number
  host?: string
  /** Addresses that start with a large balance (the demo's main wallet). */
  funded?: string[]
}): Promise<FakeRpc> {
  const txs = new Map<string, Transaction>()
  const nonces = new Map<string, number>()
  const balances = new Map<string, bigint>(
    (params.funded ?? []).map(a => [a.toLowerCase(), FUNDED_BALANCE_WEI]),
  )
  const balanceOf = (a: string) => balances.get(a.toLowerCase()) ?? 0n
  const debit = (a: string, amount: bigint) => {
    const cur = balanceOf(a)
    balances.set(a.toLowerCase(), cur > amount ? cur - amount : 0n)
  }

  function handle(method: string, p: unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return hex(CHAIN_ID)
      case 'net_version':
        return String(CHAIN_ID)
      case 'eth_blockNumber':
        return hex(1000 + txs.size)
      case 'eth_getBalance':
        return hex(balanceOf(String(p[0])))
      case 'eth_getTransactionCount':
        return hex(nonces.get(String(p[0]).toLowerCase()) ?? 0)
      case 'eth_gasPrice':
        return hex(50n * 10n ** 9n)
      case 'eth_maxPriorityFeePerGas':
        return hex(2n * 10n ** 9n)
      case 'eth_estimateGas':
        return hex(60000)
      case 'eth_feeHistory':
        return {
          oldestBlock: '0x1',
          baseFeePerGas: ['0x2540be400', '0x2540be400'],
          gasUsedRatio: [0.5],
          reward: [['0x77359400']],
        }
      case 'eth_getBlockByNumber':
        return {
          number: hex(1000),
          hash: BLOCK_HASH,
          parentHash: ZERO32,
          timestamp: hex(Math.floor(Date.now() / 1000)),
          baseFeePerGas: '0x2540be400',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          transactions: [],
          miner: `0x${'00'.repeat(20)}`,
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          extraData: '0x',
          stateRoot: ZERO32,
          receiptsRoot: ZERO32,
          transactionsRoot: ZERO32,
          logsBloom: `0x${'00'.repeat(256)}`,
          sha3Uncles: ZERO32,
          size: '0x1',
          totalDifficulty: '0x0',
          uncles: [],
          mixHash: ZERO32,
        }
      case 'eth_sendRawTransaction': {
        const tx = Transaction.from(String(p[0]))
        const hash = tx.hash as string
        if (!txs.has(hash)) {
          // A replayed identical transaction moves nothing twice.
          txs.set(hash, tx)
          const from = (tx.from as string).toLowerCase()
          nonces.set(from, Math.max(nonces.get(from) ?? 0, tx.nonce + 1))
          debit(from, tx.value + tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n))
          if (tx.to) balances.set(tx.to.toLowerCase(), balanceOf(tx.to) + tx.value)
        }
        return hash
      }
      case 'eth_getTransactionByHash': {
        const t = txs.get(String(p[0]))
        if (!t) return null
        return {
          hash: t.hash,
          from: t.from,
          to: t.to,
          value: hex(t.value),
          input: t.data,
          nonce: hex(t.nonce),
          gas: hex(t.gasLimit),
          gasPrice: hex(t.maxFeePerGas ?? 1n),
          chainId: hex(t.chainId),
          type: hex(t.type ?? 2),
          blockHash: BLOCK_HASH,
          blockNumber: hex(1000),
          transactionIndex: '0x0',
          v: '0x0',
          r: '0x1',
          s: '0x1',
        }
      }
      case 'eth_getTransactionReceipt': {
        const t = txs.get(String(p[0]))
        if (!t) return null
        return {
          transactionHash: t.hash,
          blockHash: BLOCK_HASH,
          blockNumber: '0x3e8',
          transactionIndex: '0x0',
          from: t.from,
          to: t.to,
          contractAddress: null,
          gasUsed: '0x5208',
          cumulativeGasUsed: '0x5208',
          effectiveGasPrice: '0x2540be400',
          status: '0x1',
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          type: '0x2',
        }
      }
      default:
        throw new RpcError(-32601, `method not found: ${method}`)
    }
  }

  function one(m: { id?: unknown; method: string; params?: unknown[] }) {
    try {
      return { jsonrpc: '2.0', id: m.id, result: handle(m.method, m.params ?? []) }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: m.id,
        error: {
          code: err instanceof RpcError ? err.code : -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  function onRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'GET' && req.url === '/_ctl') {
      const list: FakeChainTx[] = [...txs.values()].map(t => ({
        hash: t.hash as string,
        from: t.from as string,
        to: t.to,
        valueWei: t.value.toString(),
      }))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(list))
      return
    }
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let out: unknown
      try {
        const json = JSON.parse(body)
        out = Array.isArray(json) ? json.map(one) : one(json)
      } catch {
        out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out))
    })
  }

  const server: Server = createServer(onRequest)
  const host = params.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(params.port, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : params.port
  return {
    url: `http://${host}:${port}`,
    port,
    transactions: () =>
      [...txs.values()].map(t => ({
        hash: t.hash as string,
        from: t.from as string,
        to: t.to,
        valueWei: t.value.toString(),
      })),
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
        const closeAll = (server as unknown as { closeAllConnections?: () => void })
          .closeAllConnections
        closeAll?.call(server)
      }),
  }
}
