import {
  XPI_MAINNET,
  displayTxidFromInternal,
  parseTransaction,
  pubkeyHashFromOutputScript,
  transactionHash,
  transactionId,
} from '@frank/nakamoto'

import { readStealthTransaction } from './stealth-tx'

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
  const chunks = [
    Buffer.from('01000000', 'hex'),
    Buffer.of(parts.inputs.length),
  ]
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

function hexForward(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function parsedView(tx: Buffer): {
  txId: string
  hash: string
  inputs: { txId: string; outputIndex: number }[]
  outputs: { satoshis: number; script: Buffer }[]
} {
  const parsed = parseTransaction(Uint8Array.from(tx), XPI_MAINNET)
  if (!parsed.ok) throw new Error(parsed.error.code)
  const id = transactionId(parsed.value, XPI_MAINNET)
  const hash = transactionHash(parsed.value, XPI_MAINNET)
  if (!id.ok || !hash.ok) throw new Error('test-view')
  return {
    txId: hexForward(displayTxidFromInternal(id.value)),
    hash: hexForward(displayTxidFromInternal(hash.value)),
    inputs: parsed.value.inputs.map(input => ({
      txId: hexForward(displayTxidFromInternal(input.prevout.txid)),
      outputIndex: input.prevout.vout,
    })),
    outputs: parsed.value.outputs.map(output => ({
      satoshis: Number(output.value),
      script: Buffer.from(output.scriptPubKey),
    })),
  }
}

it('reads stealth transactions from transaction bytes', () => {
  const bip143 = Buffer.from(BIP143_UNSIGNED, 'hex')
  const bip143Bitcore = parsedView(bip143)
  const bip143Stealth = readStealthTransaction(bip143)
  expect(bip143Stealth.txId).toBe(bip143Bitcore.txId)
  expect(bip143Stealth.txId).toHaveLength(64)
  expect(bip143Stealth.txId).not.toBe(bip143Bitcore.hash)
  expect(bip143Stealth.inputs).toEqual([
    { txId: displayHex(BIP143_INTERNAL), outputIndex: 0x1d4c },
  ])
  expect(bip143Stealth.inputs).toEqual(bip143Bitcore.inputs)
  expect(bip143Stealth.outputs).toEqual([
    { satoshis: 1, script: new Uint8Array() },
  ])
  expect(bip143Bitcore.outputs[0].satoshis).toBe(1)
  expect(bip143Bitcore.outputs[0].script).toEqual(Buffer.alloc(0))

  const first = Buffer.alloc(32, 0x11)
  const second = Buffer.alloc(32, 0x22)
  second[0] = 0x00
  const paid = rawTx({
    inputs: [
      {
        txidInternal: first,
        vout: 0,
        script: Uint8Array.of(0x51),
        sequence: 0xffffffff,
      },
      { txidInternal: second, vout: 7, script: Uint8Array.of(), sequence: 1 },
    ],
    outputs: [
      { value: 1000n, script: P2PKH },
      { value: 0n, script: Uint8Array.of(0x6a) },
    ],
  })
  const paidBitcore = parsedView(paid)
  const paidStealth = readStealthTransaction(paid)
  expect(paidStealth.txId).toBe(paidBitcore.txId)
  expect(paidStealth.txId).not.toBe(paidBitcore.hash)
  expect(paidStealth.inputs).toEqual(paidBitcore.inputs)
  expect(paidStealth.inputs[1].txId.startsWith('00')).toBe(false)
  expect(paidStealth.inputs[1].txId.endsWith('00')).toBe(true)
  expect(paidStealth.outputs[0].satoshis).toBe(1000)
  expect(Buffer.from(paidStealth.outputs[0].script)).toEqual(Buffer.from(P2PKH))
  expect(paidStealth.outputs[1].satoshis).toBe(0)
  const paidHash = pubkeyHashFromOutputScript(
    Uint8Array.from(paidStealth.outputs[0].script),
  )
  expect(paidHash.ok).toBe(true)
  if (paidHash.ok) {
    expect(Buffer.from(paidHash.value)).toEqual(Buffer.alloc(20, 0xab))
  }

  const otherScript = rawTx({
    inputs: [
      {
        txidInternal: first,
        vout: 0,
        script: Uint8Array.of(0x52),
        sequence: 0xffffffff,
      },
      { txidInternal: second, vout: 7, script: Uint8Array.of(), sequence: 1 },
    ],
    outputs: [
      { value: 1000n, script: P2PKH },
      { value: 0n, script: Uint8Array.of(0x6a) },
    ],
  })
  const otherBitcore = parsedView(otherScript)
  const otherStealth = readStealthTransaction(otherScript)
  expect(otherStealth.txId).toBe(paidStealth.txId)
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
  const coinbaseBitcore = parsedView(coinbase)
  const coinbaseStealth = readStealthTransaction(coinbase)
  expect(coinbaseStealth.txId).toBe(coinbaseBitcore.txId)
  expect(coinbaseStealth.inputs).toEqual([
    { txId: '00'.repeat(32), outputIndex: 0xffffffff },
  ])

  const safeMax = rawTx({
    inputs: [
      { txidInternal: first, vout: 1, script: Uint8Array.of(), sequence: 0 },
    ],
    outputs: [{ value: BigInt(Number.MAX_SAFE_INTEGER), script: P2PKH }],
  })
  expect(readStealthTransaction(safeMax).outputs[0].satoshis).toBe(
    Number.MAX_SAFE_INTEGER,
  )

  const emptyInputs = rawTx({
    inputs: [],
    outputs: [{ value: 1n, script: Uint8Array.of() }],
  })
  expect(readStealthTransaction(emptyInputs).txId).not.toBe(
    parsedView(emptyInputs).hash,
  )

  const emptyOutputs = rawTx({
    inputs: [
      { txidInternal: first, vout: 1, script: Uint8Array.of(), sequence: 0 },
    ],
    outputs: [],
  })
  expect(readStealthTransaction(emptyOutputs).txId).not.toBe(
    parsedView(emptyOutputs).hash,
  )

  const huge = rawTx({
    inputs: [
      { txidInternal: first, vout: 1, script: Uint8Array.of(), sequence: 0 },
    ],
    outputs: [{ value: 1n << 53n, script: P2PKH }],
  })
  expect(() => readStealthTransaction(huge)).toThrow('stealth-value')

  const trailing = Buffer.concat([bip143, Buffer.of(0)])
  expect(parseTransaction(Uint8Array.from(trailing), XPI_MAINNET).ok).toBe(
    false,
  )
  expect(() => readStealthTransaction(trailing)).toThrow('stealth-tx')
  expect(() => readStealthTransaction(Uint8Array.of())).toThrow('stealth-tx')
  expect(readStealthTransaction(paid).outputs[9]).toBeUndefined()
})
