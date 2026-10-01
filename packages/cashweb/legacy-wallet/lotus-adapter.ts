import { pubkeyHashFromOutputScript } from '@frank/nakamoto'
import { ChronikClient, SubscribeMsg, WsEndpoint } from 'chronik-client'

import {
  AddressEvent,
  ChainAdapter,
  ChainTx,
  ChainUtxo,
  ChainUtxoState,
  DecodedInput,
  DecodedOutput,
  NewBlockEvent,
} from './chain-adapter'

function scriptFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`Invalid script: ${JSON.stringify(hex)}`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function decodeP2pkhOutput(
  outputScriptHex: string | undefined,
): { pkh: string } | undefined {
  if (outputScriptHex === undefined) {
    return undefined
  }
  const matched = pubkeyHashFromOutputScript(scriptFromHex(outputScriptHex))
  if (!matched.ok) return undefined
  return { pkh: bytesToHex(matched.value) }
}

function utxoStateToChainUtxoState(state: string): ChainUtxoState {
  switch (state) {
    case 'UNSPENT':
      return 'unspent'
    case 'SPENT':
      return 'spent'
    case 'NO_SUCH_TX':
      return 'no-such-tx'
    case 'NO_SUCH_OUTPUT':
      return 'no-such-output'
    default:
      throw new Error(`Unknown UTXO state ${state}`)
  }
}

/**
 * `ChainAdapter` implementation backed by a Lotus chronik indexer (via `chronik-client`).
 * P2PKH outputs use nakamoto's 25-byte template (decision #493), not bitcore's chunk parser.
 *
 * This is a pure extraction: every call here was already made directly against
 * `ChronikClient`/`WsEndpoint` inside `Wallet` before this boundary existed.
 */
export class LotusAdapter implements ChainAdapter {
  private chronikClient: ChronikClient
  private chronikWs: WsEndpoint
  private blockListeners: Set<(event: NewBlockEvent) => void> = new Set()
  private addressEventListener: ((event: AddressEvent) => void) | undefined

  constructor({
    chronikClient,
    chronikWs,
  }: {
    chronikClient: ChronikClient
    chronikWs: WsEndpoint
  }) {
    this.chronikClient = chronikClient
    this.chronikWs = chronikWs
    this.chronikWs.onMessage = msg => this.handleMessage(msg)
  }

  private handleMessage(msg: SubscribeMsg) {
    switch (msg.type) {
      case 'AddedToMempool':
        this.addressEventListener?.({ type: 'mempool', txId: msg.txid })
        return
      case 'Confirmed':
        this.addressEventListener?.({ type: 'confirmed', txId: msg.txid })
        return
      case 'BlockConnected':
        // Sent regardless of subscriptions, so no separate subscribe call is needed.
        for (const listener of this.blockListeners) {
          listener({ blockHash: msg.blockHash })
        }
        return
      case 'Error':
        console.error('Error from chronik ws:', msg.errorCode, msg.msg)
        return
      default:
        return
    }
  }

  async submitTx(rawTxHex: string): Promise<string> {
    const result = await this.chronikClient.broadcastTx(rawTxHex)
    return result.txid
  }

  async getTx(txId: string): Promise<ChainTx> {
    const tx = await this.chronikClient.tx(txId)
    const outputs: DecodedOutput[] = tx.outputs.map(output => ({
      satoshis: Number(output.value),
      pkh: decodeP2pkhOutput(output.outputScript)?.pkh,
    }))
    const inputs: DecodedInput[] = tx.inputs.map(input => ({
      prevTxId: input.prevOut.txid,
      prevOutputIndex: input.prevOut.outIdx,
      satoshis: Number(input.value),
      pkh: decodeP2pkhOutput(input.outputScript)?.pkh,
    }))
    return { txId: tx.txid, inputs, outputs }
  }

  async getUtxosForAddress(pkh: string): Promise<ChainUtxo[]> {
    const scriptUtxos = await this.chronikClient.script('p2pkh', pkh).utxos()
    return scriptUtxos.flatMap(({ utxos }) =>
      utxos.map(utxo => ({
        txId: utxo.outpoint.txid,
        outputIndex: utxo.outpoint.outIdx,
        satoshis: Number(utxo.value),
      })),
    )
  }

  async validateUtxos(
    outpoints: Array<{ txId: string; outputIndex: number }>,
  ): Promise<ChainUtxoState[]> {
    const utxoStates = await this.chronikClient.validateUtxos(
      outpoints.map(({ txId, outputIndex }) => ({
        txid: txId,
        outIdx: outputIndex,
      })),
    )
    return utxoStates.map(utxoState =>
      utxoStateToChainUtxoState(utxoState.state),
    )
  }

  subscribeAddress(pkh: string): void {
    this.chronikWs.subscribe('p2pkh', pkh)
  }

  onAddressEvent(onEvent: (event: AddressEvent) => void): void {
    this.addressEventListener = onEvent
  }

  subscribeNewBlocks(onEvent: (event: NewBlockEvent) => void): () => void {
    this.blockListeners.add(onEvent)
    return () => this.blockListeners.delete(onEvent)
  }

  decodeP2pkhOutput(outputScriptHex: string): { pkh: string } | undefined {
    return decodeP2pkhOutput(outputScriptHex)
  }
}
