/**
 * A local regtest network of a real chain client, as the regtest stack drives it. Every network
 * the stack runs has this shape (eCash in ecash-regtest.ts, Monad in monad-regtest.ts), so a test
 * starts, funds, mines and stops any of them alike.
 */
import { createServer, connect } from 'net'

export interface RegtestChain {
  /** Canonical identifier from docs/protocol/chains/v1.json, for example `xec-regtest`. */
  readonly chainIdentifier: string
  /**
   * A block of THIS run's chain. Every regtest of a client starts from the same genesis block, so
   * the relay and the wallets are given this block instead and refuse a node that does not have it.
   */
  readonly checkpoint: { readonly height: number; readonly hash: string }
  /** What the relay needs to serve this network: one config row and the upstream it names. */
  readonly relay:
    | {
        readonly section: 'bitcoin_proxy'
        readonly row: string
        readonly env: Record<string, string>
      }
    | {
        readonly section: 'evm_rpc'
        readonly row: string
        readonly env: Record<string, string>
        /** The relay's message mailbox runs on this network: stamps are paid here. */
        readonly mailbox: {
          readonly rpcUrl: string
          readonly expectedChainId: bigint
          readonly minValueWei: bigint
          readonly networkTag: string
        }
      }
  /** Pays `amount` (base units) from the network's faucet and confirms it. Returns the txid. */
  fund(address: string, amount: bigint): Promise<string>
  /** Produces blocks now. Blocks also appear on a timer, as on a live network. */
  mine(blocks?: number): Promise<void>
  /** Stops what this stack started for the network (a node it shares with other runs keeps
   * running) and checks that its ports are closed. Safe to call more than once. */
  stop(): Promise<void>
}

/** Ports other workers and the demo use; nothing a regtest starts may bind them. */
const RESERVED_PORTS = new Set([8080, 8098, 8545])

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const chosen = (server.address() as { port: number }).port
        server.close(() => resolvePort(chosen))
      })
    })
    if (!RESERVED_PORTS.has(port)) return port
  }
}

export function isListening(port: number): Promise<boolean> {
  return new Promise(resolveListening => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolveListening(true)
    })
    socket.once('error', () => resolveListening(false))
  })
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
