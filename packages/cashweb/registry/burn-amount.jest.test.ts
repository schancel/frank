import { XPI_MAINNET, parseTransaction } from '@frank/nakamoto'

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

it('reads burn output amounts from transaction bytes', () => {
  const bip143 = Buffer.from(BIP143_UNSIGNED, 'hex')
  // Last output of the BIP143 fixture: value 1, empty script, then locktime.
  const value = bip143.subarray(bip143.length - 13, bip143.length - 5)
  expect(value.readBigUInt64LE(0)).toBe(1n)
  expect(bip143[bip143.length - 5]).toBe(0)
  expect(pondBurnOutputSatoshis(bip143, 0)).toBe(1)

  const upvote = pondBurnScript(HASH, true)
  const downvote = pondBurnScript(HASH, false)
  const tx = rawTx([
    { value: 1000n, script: upvote },
    { value: 50n, script: downvote },
  ])
  const parsed = parseTransaction(Uint8Array.from(tx), XPI_MAINNET)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  expect(parsed.value.outputs[0].value).toBe(1000n)
  expect(parsed.value.outputs[1].value).toBe(50n)
  expect(pondBurnOutputSatoshis(tx, 0)).toBe(1000)
  expect(pondBurnOutputSatoshis(tx, 1)).toBe(-50)

  const short = rawTx([{ value: 7n, script: Uint8Array.of(0x6a) }])
  expect(pondBurnOutputSatoshis(short, 0)).toBe(7)

  const zeroVote = rawTx([{ value: 0n, script: downvote }])
  expect(pondBurnOutputSatoshis(zeroVote, 0)).toBe(-0)

  const max = BigInt(Number.MAX_SAFE_INTEGER)
  const maxTx = rawTx([{ value: max, script: upvote }])
  expect(pondBurnOutputSatoshis(maxTx, 0)).toBe(Number.MAX_SAFE_INTEGER)

  const huge = rawTx([{ value: 1n << 53n, script: Uint8Array.of() }])
  expect(() => pondBurnOutputSatoshis(huge, 0)).toThrow('burn-value')

  const trailing = Buffer.concat([bip143, Buffer.of(0)])
  expect(parseTransaction(Uint8Array.from(trailing), XPI_MAINNET).ok).toBe(
    false,
  )
  expect(() => pondBurnOutputSatoshis(trailing, 0)).toThrow('burn-tx')
  expect(() => pondBurnOutputSatoshis(Uint8Array.of(), 0)).toThrow('burn-tx')
  expect(() => pondBurnOutputSatoshis(tx, 2)).toThrow('burn-output')
  expect(() => pondBurnOutputSatoshis(tx, -1)).toThrow('burn-output')
  expect(() => pondBurnOutputSatoshis(tx, 1.5)).toThrow('burn-output')
})
