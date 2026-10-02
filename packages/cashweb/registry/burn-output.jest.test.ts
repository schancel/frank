import { readFileSync } from 'fs'
import { join } from 'path'

import { Transaction } from 'bitcore-lib-xpi'

import { pondBurnScript } from './burn-script'
import { registryBurnOutput } from './burn-output'

const HASH = new Uint8Array(32).fill(0x11)

it('matches pondBurnScript and wraps as a payment output', () => {
  const up = registryBurnOutput(HASH, 1000)
  const down = registryBurnOutput(HASH, -1000)
  const zero = registryBurnOutput(HASH, 0)

  expect(up.satoshis).toBe(1000)
  expect(down.satoshis).toBe(1000)
  expect(zero.satoshis).toBe(0)
  expect(Array.from(up.script)).toEqual(Array.from(pondBurnScript(HASH, true)))
  expect(Array.from(down.script)).toEqual(
    Array.from(pondBurnScript(HASH, false)),
  )
  expect(Array.from(zero.script)).toEqual(
    Array.from(pondBurnScript(HASH, false)),
  )
  expect(Array.from(up.script)).not.toEqual(Array.from(down.script))

  const hash = Uint8Array.from(HASH)
  const output = registryBurnOutput(hash, 1000)
  hash[0] = 0
  expect(output.script[8]).toBe(0x11)

  const wrapped = new Transaction.Output(up)
  expect(Array.from(wrapped.script.toBuffer())).toEqual(Array.from(up.script))
  expect(wrapped.satoshis).toBe(1000)

  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  expect(source).not.toMatch(/new Transaction\.Output/)
  expect(source).toContain('registryBurnOutput')
})
