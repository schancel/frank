/**
 * Standalone `eth_subscribe("newHeads")` subscriber for Monad, over a plain WS connection
 * (the already-vendored `ws` package) against an Alchemy JSON-RPC WS endpoint.
 *
 * This file is deliberately *not* a `ChainAdapter` implementation (see `./chain-adapter.ts`)
 * and does not implement any part of the Monad HTTP JSON-RPC path (`./monad-http.ts`, a
 * sibling ticket's file). It's a standalone building block: whoever assembles the eventual
 * `MonadAdapter` (tracked in the parent ticket) can wrap `subscribeMonadNewBlocks` to implement
 * `ChainAdapter.subscribeNewBlocks`, mirroring `LotusAdapter`'s block-listener shape.
 *
 * Reconnect behavior: on a dropped connection (close or error), this automatically reconnects
 * with exponential backoff (capped) and re-issues `eth_subscribe("newHeads")` on every
 * reconnect, so a caller does not silently stop receiving blocks after a transient WS drop.
 * Reconnect attempts and any subscription/parse errors are logged via `console.warn`/
 * `console.error`. There is no cap on the number of reconnect attempts — it keeps retrying
 * until `unsubscribe()` is called.
 */

import WebSocket, { RawData } from 'ws'

import { NewBlockEvent } from '@frank/cashweb/legacy-wallet/chain-adapter'

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30_000
const SUBSCRIBE_REQUEST_ID = 1

interface EthSubscribeResponse {
  jsonrpc: '2.0'
  id: number
  result?: string
  error?: { code: number; message: string }
}

interface EthSubscriptionNotification {
  jsonrpc: '2.0'
  method: 'eth_subscription'
  params: {
    subscription: string
    result: { hash?: string; [key: string]: unknown }
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8')
  }
  return Buffer.from(data).toString('utf8')
}

/**
 * Opens a WS connection to `wsUrl`, subscribes to `eth_subscribe("newHeads")`, and calls
 * `onEvent` with each new block header as it arrives. Automatically reconnects (with
 * exponential backoff) and re-subscribes on a dropped connection.
 *
 * @param wsUrl JSON-RPC WS endpoint (e.g. the value of `MONAD_TESTNET_WS_RPC_URL`). Callers
 * must read this from env/config themselves — this function never hardcodes an endpoint.
 * @param onEvent Called with each new block as it connects.
 * @returns An `unsubscribe` function that closes the connection and stops reconnecting.
 */
export function subscribeMonadNewBlocks(
  wsUrl: string,
  onEvent: (event: NewBlockEvent) => void,
): () => void {
  let stopped = false
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelayMs = RECONNECT_BASE_DELAY_MS
  let subscriptionId: string | undefined

  function connect(): void {
    if (stopped) {
      return
    }

    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.on('open', () => {
      reconnectDelayMs = RECONNECT_BASE_DELAY_MS
      subscriptionId = undefined
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: SUBSCRIBE_REQUEST_ID,
          method: 'eth_subscribe',
          params: ['newHeads'],
        }),
      )
    })

    socket.on('message', data => {
      let msg: unknown
      try {
        msg = JSON.parse(rawDataToString(data))
      } catch (err) {
        console.error('monad-ws: failed to parse WS message as JSON', err)
        return
      }

      if (typeof msg !== 'object' || msg === null) {
        return
      }
      const record = msg as Record<string, unknown>

      if (record.method === 'eth_subscription') {
        const notification = record as unknown as EthSubscriptionNotification
        if (notification.params.subscription !== subscriptionId) {
          // Notification for a subscription we didn't just create (e.g. a stale one from
          // before a reconnect) — ignore it.
          return
        }
        const hash = notification.params.result?.hash
        if (typeof hash !== 'string') {
          console.warn(
            'monad-ws: newHeads notification missing block hash',
            notification.params.result,
          )
          return
        }
        onEvent({ blockHash: hash })
        return
      }

      if (record.id === SUBSCRIBE_REQUEST_ID) {
        const response = record as unknown as EthSubscribeResponse
        if (response.error !== undefined) {
          console.error(
            'monad-ws: eth_subscribe("newHeads") failed',
            response.error,
          )
          return
        }
        subscriptionId = response.result
        return
      }
    })

    socket.on('error', err => {
      console.error('monad-ws: WS error', err)
    })

    socket.on('close', (code, reason) => {
      if (stopped) {
        return
      }
      console.warn(
        `monad-ws: WS closed (code=${code}, reason=${
          reason.toString() || '<none>'
        }), ` + `reconnecting in ${reconnectDelayMs}ms`,
      )
      scheduleReconnect()
    })
  }

  function scheduleReconnect(): void {
    reconnectTimer = setTimeout(() => {
      connect()
    }, reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS)
  }

  connect()

  return function unsubscribe(): void {
    stopped = true
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer)
    }
    ws?.removeAllListeners()
    ws?.close()
  }
}
