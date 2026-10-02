import { paymentOutput } from './pop'

// 25-byte P2PKH template with a fixed 20-byte hash. Not an address string.
const SCRIPT = Uint8Array.from([
  0x76, 0xa9, 0x14, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa,
  0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x10, 0x20, 0x30, 0x40, 0x88, 0xac,
])

it('copies BIP70 script bytes into the record constructTransaction wraps', () => {
  const script = Uint8Array.from(SCRIPT)
  const output = paymentOutput(script, 546)
  script[0] = 0
  expect(output.script[0]).toBe(0x76)
  expect(output.script).not.toBe(script)

  const fresh = paymentOutput(SCRIPT, 546)
  expect(Array.from(fresh.script)).toEqual(Array.from(SCRIPT))
  expect(fresh.satoshis).toBe(546)
})
