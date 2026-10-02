// Mutable wallet transaction. Serialization and the XPI id are nakamoto.
// Version 2, locktime 0, and sequence 0xffffffff match the bitcore defaults
// this builder replaced. prevTxId is display order.

import {
  XPI_MAINNET,
  displayTxidFromInternal,
  internalHashFromBytes,
  serializeTransaction,
  transactionId,
  type InternalHash,
  type SpentOutput,
  type Transaction as NakamotoTransaction,
} from '@frank/nakamoto'

const DEFAULT_SEQUENCE = 0xffffffff

export class WalletOutput {
  satoshis: number
  script: Buffer

  constructor(
    value:
      | WalletOutput
      | { satoshis: number; script?: Buffer | Uint8Array | string },
  ) {
    if (value instanceof WalletOutput) {
      this.satoshis = value.satoshis
      this.script = Buffer.from(value.script)
      return
    }
    if (value.script === undefined) throw new Error('tx-script')
    this.satoshis = value.satoshis
    this.script =
      typeof value.script === 'string'
        ? Buffer.from(value.script, 'hex')
        : Buffer.from(value.script)
  }
}

export class WalletInput {
  readonly prevTxId: Buffer
  readonly outputIndex: number
  readonly sequenceNumber: number
  readonly output: WalletOutput
  private scriptBuf: Buffer

  constructor(args: {
    prevTxId: Buffer
    outputIndex: number
    output: WalletOutput
  }) {
    this.prevTxId = args.prevTxId
    this.outputIndex = args.outputIndex
    this.sequenceNumber = DEFAULT_SEQUENCE
    this.output = args.output
    this.scriptBuf = Buffer.alloc(0)
  }

  get script(): { toBuffer(): Buffer } {
    const buf = this.scriptBuf
    return {
      toBuffer() {
        return Buffer.from(buf)
      },
    }
  }

  setScript(next: Uint8Array): void {
    this.scriptBuf = Buffer.from(next)
  }
}

function internalTxid(display: Uint8Array): InternalHash {
  const internal = new Uint8Array(display.length)
  for (let index = 0; index < display.length; index += 1) {
    internal[index] = display[display.length - 1 - index]
  }
  const branded = internalHashFromBytes(internal)
  if (!branded.ok) throw new Error('sign-bytes')
  return branded.value
}

export class WalletTransaction {
  version = 2
  nLockTime = 0
  readonly inputs: WalletInput[] = []
  readonly outputs: WalletOutput[] = []
  /** Kept so the change sweep can keep its existing increment. The amount
   * getters sum the outputs and inputs directly. */
  _outputAmount = 0

  get inputAmount(): number {
    let total = 0
    for (const input of this.inputs) total += input.output.satoshis
    return total
  }

  get outputAmount(): number {
    let total = 0
    for (const output of this.outputs) total += output.satoshis
    return total
  }

  from(
    utxos: Array<{
      txId: string
      outputIndex: number
      satoshis: number
      script: string | Uint8Array
    }>,
  ): this {
    for (const utxo of utxos) {
      const duplicate = this.inputs.some(
        input =>
          input.prevTxId.toString('hex') === utxo.txId &&
          input.outputIndex === utxo.outputIndex,
      )
      if (duplicate) continue
      this.inputs.push(
        new WalletInput({
          prevTxId: Buffer.from(utxo.txId, 'hex'),
          outputIndex: utxo.outputIndex,
          output: new WalletOutput({
            satoshis: utxo.satoshis,
            script: utxo.script,
          }),
        }),
      )
    }
    return this
  }

  addOutput(output: WalletOutput): this {
    this.outputs.push(output)
    this._outputAmount += output.satoshis
    return this
  }

  toNakamoto(): { tx: NakamotoTransaction; spent: SpentOutput[] } {
    const spent: SpentOutput[] = []
    const inputs = this.inputs.map(input => {
      const scriptPubKey = Uint8Array.from(input.output.script)
      spent.push({ value: BigInt(input.output.satoshis), scriptPubKey })
      return {
        prevout: {
          txid: internalTxid(input.prevTxId),
          vout: input.outputIndex,
        },
        scriptSig: Uint8Array.from(input.script.toBuffer()),
        sequence: input.sequenceNumber >>> 0,
      }
    })
    return {
      tx: {
        version: this.version,
        inputs,
        outputs: this.outputs.map(output => ({
          value: BigInt(output.satoshis),
          scriptPubKey: Uint8Array.from(output.script),
        })),
        locktime: this.nLockTime >>> 0,
      },
      spent,
    }
  }

  toBuffer(): Buffer {
    const serialized = serializeTransaction(this.toNakamoto().tx, XPI_MAINNET)
    if (!serialized.ok) throw new Error(serialized.error.code)
    return Buffer.from(serialized.value)
  }

  toString(): string {
    return this.toBuffer().toString('hex')
  }

  get txid(): string {
    const id = transactionId(this.toNakamoto().tx, XPI_MAINNET)
    if (!id.ok) throw new Error(id.error.code)
    return Buffer.from(displayTxidFromInternal(id.value)).toString('hex')
  }
}
