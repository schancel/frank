/**
 * Electrum protocol client over WebSocket.
 *
 * The app reaches Electrum servers through its relay (`/chain-rpc/<chain>/electrum`), which
 * forwards to TCP, TLS or WebSocket upstreams; see `relayElectrumUrl` in ./electrum-indexer.
 *
 * Implements a robust JSON-RPC 2.0 Electrum protocol client over WebSocket with:
 * - Multiple server endpoints with automatic failover and rotation
 * - Keep-alive heartbeat (server.ping)
 * - Auto-reconnect with exponential backoff on dropped connections
 * - Automatic re-subscription of active scripthashes upon reconnect
 * - Electrum scripthash computation (reversed sha256 digest of scriptPubKey)
 */

import WebSocket from 'ws'
import { sha256 } from '@noble/hashes/sha256'

export interface ElectrumUtxo {
  readonly tx_hash: string
  readonly tx_pos: number
  readonly value: number
  readonly height: number
}

export interface ElectrumHistoryItem {
  readonly tx_hash: string
  readonly height: number
  readonly fee?: number
}

export interface ElectrumBalance {
  readonly confirmed: number
  readonly unconfirmed: number
}

export interface ElectrumClientOptions {
  /** Ordered list of WebSocket endpoints (e.g. ['wss://electrum.blockstream.info:50002']). */
  readonly endpoints: readonly string[]
  /** Client identifier passed to server.version. Default 'FrankElectrum/1.0'. */
  readonly clientName?: string
  /** Protocol version string passed to server.version. Default '1.4'. */
  readonly protocolVersion?: string
  /** Keep-alive ping interval in milliseconds. Default 30,000 (30s). Set <= 0 to disable. */
  readonly pingIntervalMs?: number
  /** Base delay for exponential backoff on reconnect in milliseconds. Default 1,000 (1s). */
  readonly reconnectBaseDelayMs?: number
  /** Maximum delay for exponential backoff on reconnect in milliseconds. Default 30,000 (30s). */
  readonly reconnectMaxDelayMs?: number
  /** Default request timeout in milliseconds. Default 10,000 (10s). */
  readonly requestTimeoutMs?: number
  /** Test seam: custom WebSocket constructor for mocks or browser shims. */
  readonly WebSocketClass?: any
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (result: any) => void
  readonly reject: (error: any) => void
  readonly timeoutTimer: ReturnType<typeof setTimeout>
}

function getWebSocketConstructor(customWs?: any): any {
  if (customWs) return customWs
  if (typeof globalThis !== 'undefined' && (globalThis as any).WebSocket) {
    return (globalThis as any).WebSocket
  }
  return WebSocket
}

function messageDataToString(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).toString('utf8')
  }
  return String(data)
}

/**
 * Calculates the Electrum scripthash from a scriptPubKey (Uint8Array, Buffer, or hex string).
 * Electrum defines scripthash as the sha256 of the scriptPubKey with bytes reversed, hex-encoded.
 */
export function toElectrumScriptHash(
  script: Uint8Array | Buffer | string,
): string {
  const bytes =
    typeof script === 'string'
      ? Uint8Array.from(Buffer.from(script.replace(/^0x/, ''), 'hex'))
      : script instanceof Uint8Array
        ? script
        : new Uint8Array(script)

  const digest = sha256(bytes)
  let hex = ''
  for (let i = digest.length - 1; i >= 0; i--) {
    const byte = digest[i]
    hex += byte < 16 ? '0' + byte.toString(16) : byte.toString(16)
  }
  return hex
}

/** The server answered the request with an error: it was received and refused. */
export class ElectrumRpcError extends Error {
  constructor(readonly method: string, readonly serverMessage: string) {
    super(`Electrum RPC error (${method}): ${serverMessage}`)
    this.name = 'ElectrumRpcError'
  }
}

export class ElectrumClient {
  private readonly options: ElectrumClientOptions
  private endpointIndex = 0
  private socket?: any
  private connectPromise?: Promise<void>
  private isClosed = false
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private requestId = 0
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly subscriptions = new Map<
    string,
    Set<(status: string | null) => void>
  >()

  constructor(options: ElectrumClientOptions) {
    if (!options.endpoints || options.endpoints.length === 0) {
      throw new Error('ElectrumClient requires at least one endpoint URL')
    }
    this.options = {
      pingIntervalMs: 30_000,
      reconnectBaseDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
      requestTimeoutMs: 10_000,
      clientName: 'FrankElectrum/1.0',
      protocolVersion: '1.4',
      ...options,
    }
  }

  get isConnected(): boolean {
    return this.socket !== undefined && this.socket.readyState === 1 /* OPEN */
  }

  get currentEndpoint(): string {
    return this.options.endpoints[this.endpointIndex]
  }

  get currentEndpointIndex(): number {
    return this.endpointIndex
  }

  /**
   * Connects to the active Electrum endpoint. If the current endpoint fails, rotates
   * and attempts failover to the next available endpoint.
   */
  async connect(): Promise<void> {
    if (this.isClosed) {
      throw new Error('ElectrumClient is closed')
    }
    if (this.isConnected) {
      return
    }
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = this.attemptConnect()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = undefined
    }
  }

  private async attemptConnect(): Promise<void> {
    const totalEndpoints = this.options.endpoints.length
    let lastError: unknown = null

    for (let i = 0; i < totalEndpoints; i++) {
      if (this.isClosed) return
      const endpoint = this.options.endpoints[this.endpointIndex]
      try {
        await this.connectToEndpoint(endpoint)
        this.reconnectAttempts = 0
        this.startHeartbeat()
        await this.resubscribeActiveScriptHashes()
        return
      } catch (err) {
        lastError = err
        // Rotate to next endpoint for failover
        this.endpointIndex = (this.endpointIndex + 1) % totalEndpoints
      }
    }

    // If all endpoints failed, schedule background reconnect and rethrow
    this.scheduleReconnect()
    throw (
      lastError ?? new Error('Failed to connect to any Electrum server endpoint')
    )
  }

  private connectToEndpoint(endpoint: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false
      const WS = getWebSocketConstructor(this.options.WebSocketClass)

      let socket: any
      try {
        socket = new WS(endpoint)
      } catch (err) {
        return reject(err)
      }

      const cleanup = () => {
        socket.onopen = null
        socket.onerror = null
      }

      socket.onopen = () => {
        resolved = true
        cleanup()
        this.socket = socket
        this.bindSocketEvents(socket)
        resolve()
      }

      socket.onerror = (event: any) => {
        if (!resolved) {
          cleanup()
          try {
            socket.close()
          } catch {}
          const err =
            event?.error ||
            new Error(`WebSocket connection failed for endpoint: ${endpoint}`)
          reject(err)
        }
      }

      socket.onclose = () => {
        if (!resolved) {
          cleanup()
          reject(
            new Error(`WebSocket closed before open event: ${endpoint}`),
          )
        }
      }
    })
  }

  private bindSocketEvents(socket: any): void {
    socket.onmessage = (event: any) => {
      const raw = messageDataToString(event.data)
      const lines = raw.split('\n').filter(line => line.trim().length > 0)
      for (const line of lines) {
        try {
          const msg = JSON.parse(line)
          this.handleMessage(msg)
        } catch (err) {
          console.warn('ElectrumClient JSON parse error:', line, err)
        }
      }
    }

    socket.onclose = () => {
      if (this.socket === socket) {
        this.handleConnectionDrop()
      }
    }

    socket.onerror = (err: any) => {
      console.warn(
        `ElectrumClient socket error on ${this.currentEndpoint}:`,
        err?.message ?? err,
      )
      if (this.socket === socket) {
        this.handleConnectionDrop()
      }
    }
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return

    // Correlation with pending request
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id)
      if (pending) {
        this.pendingRequests.delete(msg.id)
        clearTimeout(pending.timeoutTimer)
        if (msg.error) {
          const errorMsg =
            typeof msg.error === 'string'
              ? msg.error
              : msg.error?.message ?? JSON.stringify(msg.error)
          pending.reject(new ElectrumRpcError(pending.method, errorMsg))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // Server-push notification (no id)
    if (msg.method === 'blockchain.scripthash.subscribe') {
      const params = msg.params
      if (Array.isArray(params) && params.length >= 2) {
        const scriptHash = String(params[0]).toLowerCase()
        const status = params[1] === null ? null : String(params[1])
        const listeners = this.subscriptions.get(scriptHash)
        if (listeners) {
          for (const cb of listeners) {
            try {
              cb(status)
            } catch (e) {
              console.error('Error in scriptHash subscription callback:', e)
            }
          }
        }
      }
    }
  }

  private handleConnectionDrop(): void {
    if (this.isClosed) return
    this.stopHeartbeat()

    if (this.socket) {
      try {
        this.socket.onopen = null
        this.socket.onmessage = null
        this.socket.onerror = null
        this.socket.onclose = null
        this.socket.close()
      } catch {}
      this.socket = undefined
    }

    // Reject all in-flight pending requests with connection drop error
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutTimer)
      pending.reject(
        new Error(
          `Electrum connection dropped while awaiting ${pending.method} (id=${id})`,
        ),
      )
    }
    this.pendingRequests.clear()

    // Rotate endpoint for failover on next attempt
    this.endpointIndex =
      (this.endpointIndex + 1) % this.options.endpoints.length

    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.isClosed || this.reconnectTimer) return
    const baseDelay = this.options.reconnectBaseDelayMs ?? 1_000
    const maxDelay = this.options.reconnectMaxDelayMs ?? 30_000
    const delay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempts),
      maxDelay,
    )
    this.reconnectAttempts++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.isClosed) {
        this.connect().catch(err => {
          console.warn('ElectrumClient reconnect attempt failed:', err?.message)
        })
      }
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const interval = this.options.pingIntervalMs ?? 30_000
    if (interval <= 0) return

    this.heartbeatTimer = setInterval(async () => {
      if (!this.isConnected || this.isClosed) return
      try {
        await this.ping()
      } catch (err) {
        if (!this.isClosed && this.isConnected) {
          console.warn('ElectrumClient heartbeat ping failed, dropping socket:', err)
          this.handleConnectionDrop()
        }
      }
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private async resubscribeActiveScriptHashes(): Promise<void> {
    const hashes = Array.from(this.subscriptions.keys())
    for (const scriptHash of hashes) {
      this.rawRequest<string | null>(
        'blockchain.scripthash.subscribe',
        [scriptHash],
      )
        .then(status => {
          const listeners = this.subscriptions.get(scriptHash)
          if (listeners) {
            for (const cb of listeners) {
              try {
                cb(status)
              } catch (e) {
                console.error('Error in resubscription callback:', e)
              }
            }
          }
        })
        .catch(err => {
          if (!this.isClosed) {
            console.warn(
              `Failed to re-subscribe scriptHash ${scriptHash} after reconnect:`,
              err?.message ?? err,
            )
          }
        })
    }
  }

  private sendPayload(payload: string): void {
    if (!this.socket || this.socket.readyState !== 1 /* OPEN */) {
      throw new Error('ElectrumClient WebSocket is not open')
    }
    this.socket.send(payload)
  }

  /**
   * Executes a raw JSON-RPC 2.0 request over the established WebSocket connection.
   */
  rawRequest<T>(method: string, params: unknown[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.isClosed) {
        return reject(new Error('ElectrumClient is closed'))
      }
      if (!this.isConnected) {
        return reject(new Error('ElectrumClient is not connected'))
      }

      const id = ++this.requestId
      const timeoutMs = this.options.requestTimeoutMs ?? 10_000
      const timeoutTimer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(
          new Error(
            `Electrum request timed out after ${timeoutMs}ms: ${method} (id=${id})`,
          ),
        )
      }, timeoutMs)

      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeoutTimer,
      })

      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })

      try {
        this.sendPayload(payload)
      } catch (err) {
        clearTimeout(timeoutTimer)
        this.pendingRequests.delete(id)
        reject(err)
      }
    })
  }

  /**
   * Sends a request, auto-connecting if the connection is not yet active.
   */
  async request<T>(method: string, ...params: unknown[]): Promise<T> {
    if (this.isClosed) {
      throw new Error('ElectrumClient is closed')
    }
    if (!this.isConnected) {
      await this.connect()
    }
    return this.rawRequest<T>(method, params)
  }

  /**
   * Performs server version negotiation handshake.
   */
  async serverVersion(
    clientName = this.options.clientName ?? 'FrankElectrum/1.0',
    protocolVersion = this.options.protocolVersion ?? '1.4',
  ): Promise<[string, string] | string> {
    return this.request('server.version', clientName, protocolVersion)
  }

  /**
   * Sends keep-alive ping.
   */
  async ping(): Promise<null> {
    return this.request('server.ping')
  }

  /**
   * Retrieves unspent transaction outputs (UTXOs) for the given scripthash.
   */
  async listUnspent(scriptHash: string): Promise<ElectrumUtxo[]> {
    return this.request('blockchain.scripthash.listunspent', scriptHash.toLowerCase())
  }

  /**
   * Retrieves confirmed and unconfirmed balance for the given scripthash.
   */
  async getBalance(
    scriptHash: string,
  ): Promise<{ confirmed: number; unconfirmed: number }> {
    return this.request('blockchain.scripthash.get_balance', scriptHash.toLowerCase())
  }

  /**
   * Retrieves transaction history for the given scripthash.
   */
  async getHistory(scriptHash: string): Promise<ElectrumHistoryItem[]> {
    return this.request('blockchain.scripthash.get_history', scriptHash.toLowerCase())
  }

  /**
   * Broadcasts a serialized raw transaction hex string to the network.
   */
  async broadcastTransaction(rawTxHex: string): Promise<string> {
    const cleanHex = rawTxHex.replace(/^0x/, '')
    return this.request('blockchain.transaction.broadcast', cleanHex)
  }

  /**
   * Subscribes to status updates for a scripthash. Returns the initial status string or null.
   */
  async subscribeScriptHash(
    scriptHash: string,
    callback: (status: string | null) => void,
  ): Promise<string | null> {
    const normalized = scriptHash.toLowerCase()
    let listeners = this.subscriptions.get(normalized)
    if (!listeners) {
      listeners = new Set()
      this.subscriptions.set(normalized, listeners)
    }
    listeners.add(callback)

    return this.request<string | null>(
      'blockchain.scripthash.subscribe',
      normalized,
    )
  }

  /**
   * Unsubscribes from status updates for a scripthash.
   */
  async unsubscribeScriptHash(scriptHash: string): Promise<boolean> {
    const normalized = scriptHash.toLowerCase()
    const existed = this.subscriptions.delete(normalized)
    if (this.isConnected) {
      try {
        this.sendPayload(
          JSON.stringify({
            jsonrpc: '2.0',
            id: ++this.requestId,
            method: 'blockchain.scripthash.unsubscribe',
            params: [normalized],
          }),
        )
      } catch {
        // Unsubscribe is optional in standard Electrum; ignore if server doesn't implement
      }
    }
    return existed
  }

  /**
   * Permanently closes the client, disconnecting any active socket and clearing all timers.
   */
  async close(): Promise<void> {
    this.isClosed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    if (this.socket) {
      try {
        this.socket.onopen = null
        this.socket.onmessage = null
        this.socket.onerror = null
        this.socket.onclose = null
        this.socket.close()
      } catch {}
      this.socket = undefined
    }

    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutTimer)
      pending.reject(new Error(`ElectrumClient closed (id=${id})`))
    }
    this.pendingRequests.clear()
    this.subscriptions.clear()
  }
}
