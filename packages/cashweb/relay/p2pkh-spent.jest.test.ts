import { Transaction } from 'bitcore-lib-xpi'

import { p2pkhSpentOutpoints } from './p2pkh-spent'

// Bitcoin Core BIP143 unsigned transaction. Input 0 prevout is the
// internal hash below and vout 4c1d0000. Same bytes as
// packages/nakamoto/test/transaction.jest.test.ts. bitcoinsuite-core
// OutPoint.txid is those 32 wire bytes; Sha256d::to_hex_be reverses them.
const BIP143_UNSIGNED =
  '010000000169c12106097dc2e0526493ef67f21269fe888ef05c7a3a5dacab38e1ac8387f14c1d000000ffffffff0101000000000000000000000000'

const BIP143_INTERNAL = Buffer.from(
  '69c12106097dc2e0526493ef67f21269fe888ef05c7a3a5dacab38e1ac8387f1',
  'hex',
)

function rawTx(
  inputs: {
    txidInternal: Uint8Array
    vout: number
    script: Uint8Array
    sequence: number
  }[],
): Buffer {
  const chunks = [Buffer.from('01000000', 'hex'), Buffer.of(inputs.length)]
  for (const input of inputs) {
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
  chunks.push(Buffer.of(0), Buffer.from('00000000', 'hex'))
  return Buffer.concat(chunks)
}

function displayHex(internal: Uint8Array): string {
  let hex = ''
  for (let index = internal.length - 1; index >= 0; index -= 1) {
    hex += internal[index].toString(16).padStart(2, '0')
  }
  return hex
}

function bitcoreInputs(
  tx: Buffer,
): { txId: string; outputIndex: number }[] {
  const parsed = new Transaction(tx)
  const inputs = parsed.inputs
  if (!inputs) throw new Error('test-inputs')
  return inputs.map(
    (input: { prevTxId: { toString(enc: string): string }; outputIndex: number }) => ({
      txId: input.prevTxId.toString('hex'),
      outputIndex: input.outputIndex,
    }),
  )
}

it('reads p2pkh spent outpoints from transaction bytes', () => {

  const bip143 = Buffer.from(BIP143_UNSIGNED, 'hex')
  const bip143Spent = {
    txId: displayHex(BIP143_INTERNAL),
    outputIndex: 0x1d4c,
  }
  expect(bitcoreInputs(bip143)).toEqual([bip143Spent])
  expect(p2pkhSpentOutpoints(bip143)).toEqual([bip143Spent])
  expect(bip143Spent.txId).toHaveLength(64)
  expect(bip143Spent.txId).not.toBe(BIP143_INTERNAL.toString('hex'))

  const first = Buffer.alloc(32, 0x11)
  const second = Buffer.alloc(32, 0x22)
  second[0] = 0x00
  const script = Uint8Array.of(0x51)
  const tx = rawTx([
    { txidInternal: first, vout: 0, script, sequence: 0xffffffff },
    { txidInternal: second, vout: 7, script: Uint8Array.of(), sequence: 1 },
  ])
  const expected = [
    { txId: displayHex(first), outputIndex: 0 },
    { txId: displayHex(second), outputIndex: 7 },
  ]
  expect(bitcoreInputs(tx)).toEqual(expected)
  expect(p2pkhSpentOutpoints(tx)).toEqual(expected)
  expect(expected[1].txId.startsWith('00')).toBe(false)
  expect(expected[1].txId.endsWith('00')).toBe(true)

  const coinbase = rawTx([
    {
      txidInternal: Buffer.alloc(32),
      vout: 0xffffffff,
      script: Uint8Array.of(0x00),
      sequence: 0xffffffff,
    },
  ])
  const coinbaseSpent = {
    txId: '00'.repeat(32),
    outputIndex: 0xffffffff,
  }
  expect(bitcoreInputs(coinbase)).toEqual([coinbaseSpent])
  expect(p2pkhSpentOutpoints(coinbase)).toEqual([coinbaseSpent])

  const trailing = Buffer.concat([bip143, Buffer.of(0)])
  expect(bitcoreInputs(trailing)).toEqual([bip143Spent])
  expect(() => p2pkhSpentOutpoints(trailing)).toThrow('p2pkh-tx')
  expect(() => p2pkhSpentOutpoints(Uint8Array.of())).toThrow('p2pkh-tx')
})
