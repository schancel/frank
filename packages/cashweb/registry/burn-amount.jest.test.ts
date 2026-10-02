import { Transaction } from 'bitcore-lib-xpi'

import { pondBurnOutputSatoshis, pondBurnScript } from './burn-script'

// Bitcoin Core BIP143 unsigned transaction. Output 0 is value 1
// (01 00 00 00 00 00 00 00) and an empty script. Same bytes as
// packages/nakamoto/test/transaction.jest.test.ts. bitcoinsuite-core
// TxOutput.value is that little-endian integer (i64 in tx.rs).
const BIP143_UNSIGNED =
  '010000000169c12106097dc2e0526493ef67f21269fe888ef05c7a3a5dacab38e1ac8387f14c1d000000ffffffff0101000000000000000000000000'

const HASH = Buffer.alloc(32, 0x11)

function rawTx(outputs: { value: bigint; script: Uint8Array }[]): Buffer {
  const chunks = [
    Buffer.from('01000000', 'hex'),
    Buffer.of(1),
    Buffer.alloc(32),
    Buffer.from('00000000', 'hex'),
    Buffer.of(0),
    Buffer.from('ffffffff', 'hex'),
    Buffer.of(outputs.length),
  ]
  for (const output of outputs) {
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

function bitcoreOutput(
  tx: Buffer,
  index: number,
): { satoshis: number; script: Buffer } {
  const outputs = new Transaction(tx).outputs as Array<{
    satoshis: number
    script: { toBuffer(): Buffer }
  }>
  const output = outputs[index]
  if (!output) throw new Error('test-output')
  return {
    satoshis: output.satoshis,
    script: Buffer.from(output.script.toBuffer()),
  }
}

it('reads burn output amounts from transaction bytes', () => {
  const bip143 = Buffer.from(BIP143_UNSIGNED, 'hex')
  const empty = bitcoreOutput(bip143, 0)
  expect(empty.satoshis).toBe(1)
  expect(empty.script).toEqual(Buffer.alloc(0))
  expect(pondBurnOutputSatoshis(bip143, 0)).toBe(1)

  const upvote = pondBurnScript(HASH, true)
  const downvote = pondBurnScript(HASH, false)
  const tx = rawTx([
    { value: 1000n, script: upvote },
    { value: 50n, script: downvote },
  ])
  expect(bitcoreOutput(tx, 0).satoshis).toBe(1000)
  expect(bitcoreOutput(tx, 0).script).toEqual(Buffer.from(upvote))
  expect(bitcoreOutput(tx, 1).satoshis).toBe(50)
  expect(bitcoreOutput(tx, 1).script).toEqual(Buffer.from(downvote))
  expect(pondBurnOutputSatoshis(tx, 0)).toBe(1000)
  expect(pondBurnOutputSatoshis(tx, 1)).toBe(-50)

  const short = rawTx([{ value: 7n, script: Uint8Array.of(0x6a) }])
  expect(bitcoreOutput(short, 0).satoshis).toBe(7)
  expect(pondBurnOutputSatoshis(short, 0)).toBe(7)

  const zeroVote = rawTx([{ value: 0n, script: downvote }])
  expect(bitcoreOutput(zeroVote, 0).satoshis).toBe(0)
  expect(pondBurnOutputSatoshis(zeroVote, 0)).toBe(-0)

  const max = BigInt(Number.MAX_SAFE_INTEGER)
  const maxTx = rawTx([{ value: max, script: upvote }])
  expect(bitcoreOutput(maxTx, 0).satoshis).toBe(Number.MAX_SAFE_INTEGER)
  expect(pondBurnOutputSatoshis(maxTx, 0)).toBe(Number.MAX_SAFE_INTEGER)

  const huge = rawTx([{ value: 1n << 53n, script: Uint8Array.of() }])
  expect(bitcoreOutput(huge, 0).satoshis).toBe(2 ** 53)
  expect(() => pondBurnOutputSatoshis(huge, 0)).toThrow('burn-value')

  const trailing = Buffer.concat([bip143, Buffer.of(0)])
  expect(bitcoreOutput(trailing, 0).satoshis).toBe(1)
  expect(() => pondBurnOutputSatoshis(trailing, 0)).toThrow('burn-tx')
  expect(() => pondBurnOutputSatoshis(Uint8Array.of(), 0)).toThrow('burn-tx')
  expect(() => pondBurnOutputSatoshis(tx, 2)).toThrow('burn-output')
  expect(() => pondBurnOutputSatoshis(tx, -1)).toThrow('burn-output')
  expect(() => pondBurnOutputSatoshis(tx, 1.5)).toThrow('burn-output')
})
