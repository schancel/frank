/**
 * `MonadHttpClient` wraps the Monad (EVM) JSON-RPC operations needed to submit transactions and
 * read chain state over HTTPS, via `ethers.js` against an injected endpoint. The browser
 * composition root supplies the relay family route, never the provider's secret upstream URL.
 *
 * Scope (see ticket #17): only the HTTP JSON-RPC surface —
 *   - `eth_sendRawTransaction` (submit an already-signed raw tx)
 *   - `eth_getTransactionReceipt`
 *   - `eth_getLogs`
 * plus `eth_blockNumber`, exposed as a small convenience since it's needed to pick a "recent"
 * block range for `getLogs` and comes for free from the same provider.
 *
 * This module is deliberately standalone: it does NOT implement the `ChainAdapter` interface
 * from `./chain-adapter.ts`. Final assembly of a Monad `ChainAdapter` (combining this HTTP
 * client with the WS subscription piece from ticket #20) happens later, when the parent
 * tracking ticket (#2) is closed out.
 *
 * Alchemy free-tier eth_getLogs range limit: as observed live against the testnet endpoint in
 * `.env` (`MONAD_TESTNET_HTTP_RPC_URL`), Alchemy's free tier rejects `eth_getLogs` calls whose
 * `fromBlock`/`toBlock` span more than 10 blocks (JSON-RPC error code -32600). This module does
 * not enforce or chunk that itself (the limit is a plan/quota detail, not a Monad protocol rule,
 * and may not apply to whatever key/tier runs in production) — callers that need a wider range
 * must page through it in <=10-block windows themselves. See `monad-http.smoketest.ts` for a
 * working example.
 *
 * Env/config note: this module intentionally does NOT read `process.env`/`.env` itself — the
 * RPC URL is injected via the constructor. Browser/Electron/Capacitor callers use the relay's
 * `/chain-rpc/:chain/rpc` URL; Node-only smoke tests may still inject a provider URL directly.
 */
import { JsonRpcProvider, Log as EthersLog, TransactionReceipt } from 'ethers'
import { MonadRelayRpcAuth, createMonadJsonRpcProvider } from './monad-provider'

/** A block range/topic filter for `eth_getLogs`, decoupled from ethers' own `Filter` type so
 * callers of this module don't need to depend on ethers types directly. */
export interface MonadLogFilter {
  address?: string | string[]
  topics?: Array<string | string[] | null>
  fromBlock?: number | 'latest' | 'earliest'
  toBlock?: number | 'latest' | 'earliest'
}

/** A single EVM log entry, as returned by `eth_getLogs`. */
export interface MonadLog {
  address: string
  topics: string[]
  data: string
  blockNumber: number
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
  removed: boolean
}

/** A transaction receipt, as returned by `eth_getTransactionReceipt`. `undefined` if the node
 * has no receipt for the given hash yet (unknown tx, or not yet mined). */
export interface MonadTxReceipt {
  txHash: string
  blockNumber: number
  blockHash: string
  /** `'unknown'` only for pre-Byzantium-style receipts with no status field; Monad, being a
   * modern EVM chain, should always report `'success'`/`'failure'`. */
  status: 'success' | 'failure' | 'unknown'
  gasUsed: bigint
  effectiveGasPrice: bigint
  logs: MonadLog[]
}

/** Discriminable RPC/chain failure kinds, so callers (M3-client, M4) can branch on failure kind
 * instead of pattern-matching raw provider error strings. Extend this union as new kinds are
 * needed; anything not recognized falls back to `'unknown'`. */
export type MonadRpcErrorKind =
  | 'nonce-too-low'
  | 'insufficient-funds'
  | 'replacement-underpriced'
  | 'already-known'
  | 'execution-reverted'
  | 'unknown'

/** Typed error thrown by every `MonadHttpClient` method on RPC/provider failure. `cause` holds
 * the original error (usually an ethers `EthersError`) for debugging/logging. */
export class MonadRpcError extends Error {
  readonly kind: MonadRpcErrorKind
  readonly cause: unknown

  constructor(kind: MonadRpcErrorKind, message: string, cause: unknown) {
    super(message)
    this.name = 'MonadRpcError'
    this.kind = kind
    this.cause = cause
  }
}

/** Best-effort classification of an ethers/JSON-RPC error into a `MonadRpcErrorKind`. Ethers
 * already normalizes several JSON-RPC error message shapes into its own `ErrorCode`s (see
 * `ethers` `utils/errors.ts` and `providers/provider-jsonrpc.ts` `getRpcError`); this maps those
 * (plus a couple of message-based fallbacks ethers doesn't normalize) onto our own union. */
function classifyError(err: unknown): MonadRpcError {
  const message = err instanceof Error ? err.message : String(err)
  const code =
    err !== null && typeof err === 'object' && 'code' in err
      ? (err as { code: unknown }).code
      : undefined

  if (code === 'NONCE_EXPIRED') {
    return new MonadRpcError('nonce-too-low', message, err)
  }
  if (code === 'INSUFFICIENT_FUNDS') {
    return new MonadRpcError('insufficient-funds', message, err)
  }
  if (code === 'REPLACEMENT_UNDERPRICED') {
    return new MonadRpcError('replacement-underpriced', message, err)
  }
  if (code === 'CALL_EXCEPTION') {
    return new MonadRpcError('execution-reverted', message, err)
  }
  // Fallbacks for shapes ethers doesn't coalesce into its own ErrorCode (e.g. "already known",
  // which most clients report as a plain SERVER_ERROR/UNKNOWN_ERROR).
  if (/already known/i.test(message)) {
    return new MonadRpcError('already-known', message, err)
  }
  if (/nonce/i.test(message) && /too low/i.test(message)) {
    return new MonadRpcError('nonce-too-low', message, err)
  }
  if (/insufficient funds/i.test(message)) {
    return new MonadRpcError('insufficient-funds', message, err)
  }
  return new MonadRpcError('unknown', message, err)
}

function toMonadLog(log: EthersLog): MonadLog {
  return {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.index,
    removed: log.removed,
  }
}

function toMonadTxReceipt(receipt: TransactionReceipt): MonadTxReceipt {
  const status =
    receipt.status === 1
      ? 'success'
      : receipt.status === 0
      ? 'failure'
      : 'unknown'
  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    status,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.gasPrice,
    logs: receipt.logs.map(toMonadLog),
  }
}

/**
 * HTTP JSON-RPC client for a Monad (EVM) endpoint, e.g. Alchemy's testnet/mainnet HTTPS
 * endpoints. Holds no chain-specific wallet/key state — it's a thin, typed wrapper around the
 * three JSON-RPC calls this ticket scopes, plus `eth_blockNumber` as a convenience.
 */
export interface MonadHttpClientOptions {
  rpcUrl?: string
  rpcUrls?: readonly string[]
  chainId?: number | bigint
  relayAuth?: MonadRelayRpcAuth
  demoOnlyAbortOnDestroy?: boolean
}

export class MonadHttpClient {
  private provider: JsonRpcProvider

  /** @param options HTTPS JSON-RPC endpoint and optional expected chainId (defaults to Monad testnet 10143).
   * Read by the caller from env/config and passed in — this class never reads env itself. */
  constructor({
    rpcUrl,
    rpcUrls,
    chainId,
    relayAuth,
    demoOnlyAbortOnDestroy,
  }: MonadHttpClientOptions) {
    this.provider = createMonadJsonRpcProvider({
      rpcUrl,
      rpcUrls,
      chainId,
      relayAuth,
      demoOnlyAbortOnDestroy,
    })
  }

  /** Releases resources and cancels pending requests on the underlying provider. */
  destroy(): void {
    this.provider.destroy()
  }

  /** Submit an already-signed raw transaction (0x-prefixed hex) via `eth_sendRawTransaction`.
   * Returns the transaction hash. Does not wait for confirmation. */
  async submitRawTransaction(rawTxHex: string): Promise<string> {
    try {
      const tx = await this.provider.broadcastTransaction(rawTxHex)
      return tx.hash
    } catch (err) {
      throw classifyError(err)
    }
  }

  /** Fetch a transaction receipt by hash via `eth_getTransactionReceipt`. Returns `undefined`
   * if the node has no receipt for this hash (unknown tx, or not yet mined). */
  async getTransactionReceipt(
    txHash: string,
  ): Promise<MonadTxReceipt | undefined> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash)
      return receipt === null ? undefined : toMonadTxReceipt(receipt)
    } catch (err) {
      throw classifyError(err)
    }
  }

  /** Fetch logs matching a filter via `eth_getLogs`. */
  async getLogs(filter: MonadLogFilter): Promise<MonadLog[]> {
    try {
      const logs = await this.provider.getLogs(filter)
      return logs.map(toMonadLog)
    } catch (err) {
      throw classifyError(err)
    }
  }

  /** Fetch the current block height via `eth_blockNumber`. Not one of the ticket's three
   * required operations, but trivial to expose from the same provider, and useful for callers
   * (e.g. the smoke test) that need to pick a "recent" block range for `getLogs`. */
  async getBlockNumber(): Promise<number> {
    try {
      return await this.provider.getBlockNumber()
    } catch (err) {
      throw classifyError(err)
    }
  }
}
