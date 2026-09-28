/**
 * `ChainAdapter` is the boundary between `Wallet`'s logic (key derivation, coin selection,
 * transaction building, UTXO bookkeeping) and a specific underlying blockchain.
 *
 * Today the only implementation is Lotus (see `./lotus-adapter.ts`, which wraps
 * `bitcore-lib-xpi` for script decoding and `chronik-client` for chain reads/writes). The
 * interface exists so a future chain (e.g. Monad) can be supported by adding a new
 * implementation of `ChainAdapter`, instead of a rewrite of `Wallet`.
 *
 * No behavior change is intended by introducing this interface: it's a boundary drawn around
 * calls that already existed directly inside `Wallet` against `chronik-client`/`bitcore-lib-xpi`.
 */

/** A UTXO as reported by the chain, independent of chronik's wire format. */
export interface ChainUtxo {
  txId: string
  outputIndex: number
  satoshis: number
}

/** Outcome of checking whether a previously-seen outpoint is still unspent. */
export type ChainUtxoState =
  | 'unspent'
  | 'spent'
  | 'no-such-tx'
  | 'no-such-output'

/** A chain output, decoded just enough to tell whether/who it pays. */
export interface DecodedOutput {
  /** Value of the output, in satoshis. */
  satoshis: number
  /** 20-byte P2PKH pubkey hash (hex), if this output pays a P2PKH address; `undefined`
   * otherwise (e.g. OP_RETURN, P2SH, or any other non-P2PKH output). */
  pkh: string | undefined
}

/** A chain input, decoded just enough to tell which prior output (and who) it spends. */
export interface DecodedInput extends DecodedOutput {
  prevTxId: string
  prevOutputIndex: number
}

/** A transaction as returned by the chain, decoded into inputs/outputs a wallet can match
 * against its own known addresses, without needing chain-specific types. */
export interface ChainTx {
  txId: string
  inputs: DecodedInput[]
  outputs: DecodedOutput[]
}

/** A mempool/confirmation event for a subscribed address, delivered via
 * [[ChainAdapter.onAddressEvent]]. */
export type AddressEvent =
  | { type: 'mempool'; txId: string }
  | { type: 'confirmed'; txId: string }

/** A newly connected block, delivered via [[ChainAdapter.subscribeNewBlocks]]. */
export interface NewBlockEvent {
  blockHash: string
}

export interface ChainAdapter {
  /** Submit an already-signed raw transaction (hex-encoded) to the network. Returns the txid. */
  submitTx(rawTxHex: string): Promise<string>

  /** Fetch a transaction by its id, decoded into a chain-agnostic shape. */
  getTx(txId: string): Promise<ChainTx>

  /** Fetch the current UTXO set for a given P2PKH pubkey hash (hex). */
  getUtxosForAddress(pkh: string): Promise<ChainUtxo[]>

  /** Check whether the given outpoints are still unspent. */
  validateUtxos(
    outpoints: Array<{ txId: string; outputIndex: number }>,
  ): Promise<ChainUtxoState[]>

  /** Subscribe to mempool/confirmation events for a P2PKH pubkey hash (hex). Events for every
   * subscribed address are delivered to the listener set via [[onAddressEvent]]. */
  subscribeAddress(pkh: string): void

  /** Set the listener that receives mempool/confirmation events for every address subscribed
   * via [[subscribeAddress]]. */
  onAddressEvent(onEvent: (event: AddressEvent) => void): void

  /** Subscribe to newly connected blocks. Returns an unsubscribe function.
   *
   * Not used by `Wallet` today (it only needs per-address events), but part of the boundary so
   * a future chain can expose it symmetrically with the Rust-side
   * `ChainAdapter::subscribe_new_blocks`. */
  subscribeNewBlocks(onEvent: (event: NewBlockEvent) => void): () => void

  /** Decode a raw output script (hex) into a P2PKH payment/burn commitment, if it is one.
   * `undefined` if the script isn't a P2PKH output. */
  decodeP2pkhOutput(outputScriptHex: string): { pkh: string } | undefined
}
