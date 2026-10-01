import { readFileSync } from 'fs'
import { join } from 'path'

import { XPI_MAINNET, evaluateScript } from '@frank/nakamoto'
import { Opcode, Script } from 'bitcore-lib-xpi'

import { pondBurnIsDownvote, pondBurnScript } from './burn-script'

// 32 bytes of 0x11. bitcoinsuite opcode.rs: OP_RETURN 0x6a, OP_0 0x00,
// OP_1 0x51. script.rs push of len < 0x4c is one length byte then data.
const HASH = Buffer.alloc(32, 0x11)
const UPVOTE = '6a04504f4e445120' + '11'.repeat(32)
const DOWNVOTE = '6a04504f4e440020' + '11'.repeat(32)

function bitcoreBurn(hash: Buffer, upvote: boolean): Buffer {
  return new Script(undefined)
    .add(Opcode.map.OP_RETURN)
    .add(Buffer.from([80, 79, 78, 68]))
    .add(upvote ? Opcode.map.OP_1 : Opcode.map.OP_0)
    .add(hash)
    .toBuffer()
}

it('builds the legacy POND burn script from opcode bytes', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const burn = source.slice(
    source.indexOf('private constructBurnTransaction'),
    source.indexOf('async createBroadcast'),
  )
  const amount = source.slice(
    source.indexOf('function calculateBurnAmount'),
    source.indexOf('export class RegistryHandler'),
  )
  expect(burn).toContain('pondBurnScript')
  expect(burn).not.toContain('new Script')
  expect(burn).not.toContain('Opcode')
  expect(amount).toContain('pondBurnIsDownvote')
  expect(amount).not.toContain('Opcode')
  expect(source).not.toContain('Opcode')

  const upvote = Buffer.from(pondBurnScript(HASH, true))
  const downvote = Buffer.from(pondBurnScript(Uint8Array.from(HASH), false))
  expect(upvote.toString('hex')).toBe(UPVOTE)
  expect(downvote.toString('hex')).toBe(DOWNVOTE)
  expect(upvote).toEqual(bitcoreBurn(HASH, true))
  expect(downvote).toEqual(bitcoreBurn(HASH, false))
  expect(upvote[6]).toBe(0x51)
  expect(downvote[6]).toBe(0x00)
  expect(pondBurnIsDownvote(upvote)).toBe(false)
  expect(pondBurnIsDownvote(downvote)).toBe(true)
  expect(pondBurnIsDownvote(Uint8Array.of(0x6a))).toBe(false)

  expect(
    evaluateScript(pondBurnScript(HASH, true), { chain: XPI_MAINNET }),
  ).toEqual({
    ok: false,
    error: { code: 'script-return', opcode: 0x6a },
  })

  expect(() => pondBurnScript(HASH.subarray(0, 31), true)).toThrow('burn-hash')
  expect(() => pondBurnScript(Buffer.alloc(33), false)).toThrow('burn-hash')
})
