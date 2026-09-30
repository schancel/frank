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
 *
 * CORS (#361): every response carries `Access-Control-Allow-Origin: *` and OPTIONS preflights get a
 * 204, so a browser app on another origin (the Quasar dev server) can reach it. `*` is safe HERE
 * only because this server holds nothing real and binds 127.0.0.1; this module is never used for a
 * real RPC and nothing in it may be copied into one.
 *
 * Persistence (#361 follow-up): with `stateFile` the ledger (balances, nonces, accepted raw
 * transactions) is written after every accepted transaction and reloaded on the next start, so a
 * restarted demo keeps every profile's balance and the bots' nonces. A file that cannot be parsed
 * is refused (never silently replaced by an empty chain).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { dirname } from 'path'

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
  /** The interface it listens on: 127.0.0.1 unless a test asks otherwise (never all interfaces). */
  host: string
  port: number
  /** Transactions restored from the state file at start (0 for a fresh chain). */
  restoredTransactions: number
  transactions(): FakeChainTx[]
  close(): Promise<void>
}

const CORS_METHODS = 'POST, GET, OPTIONS'
const CORS_DEFAULT_HEADERS = 'content-type'

/** The CORS headers for a response to `req` (a preflight's requested headers are echoed back). */
export function corsHeaders(req: Pick<IncomingMessage, 'headers'>): Record<string, string> {
  const requested = req.headers['access-control-request-headers']
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': CORS_METHODS,
    'access-control-allow-headers':
      typeof requested === 'string' && /^[\w\-, ]+$/.test(requested)
        ? requested
        : CORS_DEFAULT_HEADERS,
    'access-control-max-age': '600',
  }
}

interface LedgerFile {
  version: 1
  balances: Record<string, string>
  nonces: Record<string, number>
  /** Raw signed transactions, in acceptance order. */
  transactions: string[]
}

function loadLedger(path: string): LedgerFile | undefined {
  if (!existsSync(path)) return undefined
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as LedgerFile
    if (json.version !== 1 || !json.balances || !json.nonces || !Array.isArray(json.transactions)) {
      throw new Error('unexpected format')
    }
    return json
  } catch (err) {
    throw new Error(
      `the fake-chain ledger ${path} cannot be read (${
        err instanceof Error ? err.message : String(err)
      }); delete it (and the faucet state next to it) to start a fresh fake chain`,
    )
  }
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
  /** JSON file the ledger is persisted to (created 0600, parent directory created). */
  stateFile?: string
}): Promise<FakeRpc> {
  const txs = new Map<string, Transaction>()
  const nonces = new Map<string, number>()
  const balances = new Map<string, bigint>()
  const saved = params.stateFile ? loadLedger(params.stateFile) : undefined
  let restored = 0
  if (saved) {
    for (const [a, v] of Object.entries(saved.balances)) balances.set(a, BigInt(v))
    for (const [a, n] of Object.entries(saved.nonces)) nonces.set(a, n)
    for (const raw of saved.transactions) {
      const tx = Transaction.from(raw)
      txs.set(tx.hash as string, tx)
      restored += 1
    }
  }
  // A funded address that is new to a restored ledger still starts funded; a known one keeps
  // whatever it has spent since.
  for (const a of params.funded ?? []) {
    if (!balances.has(a.toLowerCase())) balances.set(a.toLowerCase(), FUNDED_BALANCE_WEI)
  }
  function persist(): void {
    if (!params.stateFile) return
    const ledger: LedgerFile = {
      version: 1,
      balances: Object.fromEntries([...balances].map(([a, v]) => [a, v.toString()])),
      nonces: Object.fromEntries(nonces),
      transactions: [...txs.values()].map(t => t.serialized),
    }
    mkdirSync(dirname(params.stateFile), { recursive: true, mode: 0o700 })
    const tmp = `${params.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, params.stateFile)
  }
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
          persist()
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
    for (const [name, value] of Object.entries(corsHeaders(req))) res.setHeader(name, value)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
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
    host,
    port,
    restoredTransactions: restored,
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
