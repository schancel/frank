import { readFileSync } from 'fs'
import { join } from 'path'

import { Script, Transaction } from 'bitcore-lib-xpi'

import { readStampTransaction } from './stamp-tx'

// Bitcoin Core BIP143 unsigned transaction. Input 0 prevout is the
// internal hash below and vout 4c1d0000. Output 0 is value 1 and an
// empty script. Same bytes as packages/nakamoto/test/transaction.jest.test.ts.
const BIP143_UNSIGNED =
  '010000000169c12106097dc2e0526493ef67f21269fe888ef05c7a3a5dacab38e1ac8387f14c1d000000ffffffff0101000000000000000000000000'

const BIP143_INTERNAL = Buffer.from(
  '69c12106097dc2e0526493ef67f21269fe888ef05c7a3a5dacab38e1ac8387f1',
  'hex',
)

const P2PKH = Buffer.concat([
  Buffer.from('76a914', 'hex'),
  Buffer.alloc(20, 0xab),
  Buffer.from('88ac', 'hex'),
])

function rawTx(parts: {
  inputs: {
    txidInternal: Uint8Array
    vout: number
    script: Uint8Array
    sequence: number
  }[]
  outputs: { value: bigint; script: Uint8Array }[]
}): Buffer {
  const chunks = [Buffer.from('01000000', 'hex'), Buffer.of(parts.inputs.length)]
  for (const input of parts.inputs) {
    if (input.txidInternal.length !== 32) throw new Error('test-txid')
    if (input.script.length >= 0xfd) throw new Error('test-script')
    const vout = Buffer.alloc(4)
    vout.writeUInt32LE(input.vout)
    const sequence = Buffer.alloc(4)
    sequence.writeUInt32LE(input.sequence >>> 0)
    chunks.push(
      Buffer.from(input.txidInternal),
      vout,
      Buffer.of(input.script.length),
      Buffer.from(input.script),
      sequence,
    )
  }
  chunks.push(Buffer.of(parts.outputs.length))
  for (const output of parts.outputs) {
    if (output.script.length >= 0xfd) throw new Error('test-script')
    const amount = Buffer.alloc(8)
    amount.writeBigUInt64LE(output.value)
    chunks.push(
      amount,
      Buffer.of(output.script.length),
      Buffer.from(output.script),
    )
  }
  chunks.push(Buffer.from('00000000', 'hex'))
  return Buffer.concat(chunks)
}

function displayHex(internal: Uint8Array): string {
  let hex = ''
  for (let index = internal.length - 1; index >= 0; index -= 1) {
    hex += internal[index].toString(16).padStart(2, '0')
  }
  return hex
}

function bitcoreView(tx: Buffer): {
  txId: string
  hash: string
  inputs: { txId: string; outputIndex: number }[]
  outputs: { satoshis: number; script: Buffer }[]
} {
  const parsed = new Transaction(tx)
  const inputs = parsed.inputs
  const outputs = parsed.outputs
  if (!inputs || !outputs) throw new Error('test-view')
  return {
    txId: parsed.txid as string,
    hash: parsed.hash as string,
    inputs: inputs.map(
      (input: {
        prevTxId: { toString(enc: string): string }
        outputIndex: number
      }) => ({
        txId: input.prevTxId.toString('hex'),
        outputIndex: input.outputIndex,
      }),
    ),
    outputs: outputs.map(
      (output: { satoshis: number; script: { toBuffer(): Buffer } }) => ({
        satoshis: output.satoshis,
        script: Buffer.from(output.script.toBuffer()),
      }),
    ),
  }
}

it('reads stamp transactions from transaction bytes', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const receiveStart = source.indexOf('async receiveMessage')
  const receive = source.slice(
    receiveStart,
    source.indexOf('Decode entries', receiveStart),
  )
  expect(receive).toContain('readStampTransaction')
  expect(receive).not.toContain('new Transaction')
  expect(receive).toContain('constructStampHDPrivateKey')
  expect(receive).toContain('new Script(')
  expect(receive).toContain("throw new Error('stamp-output')")
  const stealth = readFileSync(join(__dirname, 'decode-entry.ts'), 'utf8')
  expect(stealth).toContain('new Transaction(stealthTxRaw)')

  const bip143 = Buffer.from(BIP143_UNSIGNED, 'hex')
  const bip143Bitcore = bitcoreView(bip143)
  const bip143Stamp = readStampTransaction(bip143)
  expect(bip143Stamp.txId).toBe(bip143Bitcore.txId)
  expect(bip143Stamp.txId).toHaveLength(64)
  expect(bip143Stamp.txId).not.toBe(bip143Bitcore.hash)
  expect(bip143Stamp.inputs).toEqual([
    { txId: displayHex(BIP143_INTERNAL), outputIndex: 0x1d4c },
  ])
  expect(bip143Stamp.inputs).toEqual(bip143Bitcore.inputs)
  expect(bip143Stamp.outputs).toEqual([
    { satoshis: 1, script: new Uint8Array() },
  ])
  expect(bip143Bitcore.outputs[0].satoshis).toBe(1)
  expect(bip143Bitcore.outputs[0].script).toEqual(Buffer.alloc(0))

  const first = Buffer.alloc(32, 0x11)
  const second = Buffer.alloc(32, 0x22)
  second[0] = 0x00
  const paid = rawTx({
    inputs: [
      { txidInternal: first, vout: 0, script: Uint8Array.of(0x51), sequence: 0xffffffff },
      { txidInternal: second, vout: 7, script: Uint8Array.of(), sequence: 1 },
    ],
    outputs: [
      { value: 1000n, script: P2PKH },
      { value: 0n, script: Uint8Array.of(0x6a) },
    ],
  })
  const paidBitcore = bitcoreView(paid)
  const paidStamp = readStampTransaction(paid)
  expect(paidStamp.txId).toBe(paidBitcore.txId)
  expect(paidStamp.txId).not.toBe(paidBitcore.hash)
  expect(paidStamp.inputs).toEqual(paidBitcore.inputs)
  expect(paidStamp.inputs[1].txId.startsWith('00')).toBe(false)
  expect(paidStamp.inputs[1].txId.endsWith('00')).toBe(true)
  expect(paidStamp.outputs[0].satoshis).toBe(1000)
  expect(Buffer.from(paidStamp.outputs[0].script)).toEqual(Buffer.from(P2PKH))
  expect(paidStamp.outputs[1].satoshis).toBe(0)
  const address = new Script(Buffer.from(paidStamp.outputs[0].script)).toAddress()
  const bitcoreAddress = new Script(paidBitcore.outputs[0].script).toAddress()
  if (
    !address ||
    !bitcoreAddress ||
    typeof address === 'boolean' ||
    typeof bitcoreAddress === 'boolean'
  ) {
    throw new Error('test-address')
  }
  expect(address.toBuffer().equals(bitcoreAddress.toBuffer())).toBe(true)

  const otherScript = rawTx({
    inputs: [
      { txidInternal: first, vout: 0, script: Uint8Array.of(0x52), sequence: 0xffffffff },
      { txidInternal: second, vout: 7, script: Uint8Array.of(), sequence: 1 },
    ],
    outputs: [
      { value: 1000n, script: P2PKH },
      { value: 0n, script: Uint8Array.of(0x6a) },
    ],
  })
  const otherBitcore = bitcoreView(otherScript)
  const otherStamp = readStampTransaction(otherScript)
  expect(otherStamp.txId).toBe(paidStamp.txId)
  expect(otherBitcore.txId).toBe(paidBitcore.txId)
  expect(otherBitcore.hash).not.toBe(paidBitcore.hash)

  const coinbase = rawTx({
    inputs: [
      {
        txidInternal: Buffer.alloc(32),
        vout: 0xffffffff,
        script: Uint8Array.of(0x00),
        sequence: 0xffffffff,
      },
    ],
    outputs: [{ value: 50n, script: P2PKH }],
  })
  const coinbaseBitcore = bitcoreView(coinbase)
  const coinbaseStamp = readStampTransaction(coinbase)
  expect(coinbaseStamp.txId).toBe(coinbaseBitcore.txId)
  expect(coinbaseStamp.inputs).toEqual([
    { txId: '00'.repeat(32), outputIndex: 0xffffffff },
  ])

  const emptyInputs = rawTx({
    inputs: [],
    outputs: [{ value: 1n, script: Uint8Array.of() }],
  })
  expect(readStampTransaction(emptyInputs).txId).not.toBe(
    bitcoreView(emptyInputs).txId,
  )

  const huge = rawTx({
    inputs: [
      { txidInternal: first, vout: 1, script: Uint8Array.of(), sequence: 0 },
    ],
    outputs: [{ value: 1n << 53n, script: P2PKH }],
  })
  expect(() => readStampTransaction(huge)).toThrow('stamp-value')

  const trailing = Buffer.concat([bip143, Buffer.of(0)])
  expect(bitcoreView(trailing).txId).toBe(bip143Bitcore.txId)
  expect(() => readStampTransaction(trailing)).toThrow('stamp-tx')
  expect(() => readStampTransaction(Uint8Array.of())).toThrow('stamp-tx')
  expect(readStampTransaction(paid).outputs[9]).toBeUndefined()
})
