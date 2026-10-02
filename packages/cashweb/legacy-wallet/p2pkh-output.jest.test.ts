import { pubkeyHashFromOutputScript } from '@frank/nakamoto'

import { LotusAdapter } from './lotus-adapter'

// lotusd src/test/descriptor_tests.cpp descriptor_test.
const LOTUSD_P2PKH = '76a9149a1c78a507689f6f54b847ad1cef1e614ee23f1e88ac'
const LOTUSD_HASH = '9a1c78a507689f6f54b847ad1cef1e614ee23f1e'

function adapter(): LotusAdapter {
  const chronikWs: { onMessage?: unknown } = {}
  return new LotusAdapter({
    chronikClient: {} as ConstructorParameters<
      typeof LotusAdapter
    >[0]['chronikClient'],
    chronikWs: chronikWs as ConstructorParameters<
      typeof LotusAdapter
    >[0]['chronikWs'],
  })
}

it('decodes the lotusd descriptor P2PKH script', () => {
  expect(adapter().decodeP2pkhOutput(LOTUSD_P2PKH)).toEqual({
    pkh: LOTUSD_HASH,
  })
})

it('does not treat a non-minimal PUSHDATA1 output as P2PKH', () => {
  const pushed = `76a94c14${LOTUSD_HASH}88ac`
  expect(adapter().decodeP2pkhOutput(pushed)).toBeUndefined()
  const parsed = pubkeyHashFromOutputScript(
    Uint8Array.from(Buffer.from(pushed, 'hex')),
  )
  expect(parsed.ok).toBe(false)
  const minimal = pubkeyHashFromOutputScript(
    Uint8Array.from(Buffer.from(LOTUSD_P2PKH, 'hex')),
  )
  expect(minimal.ok).toBe(true)
  if (minimal.ok) {
    expect(Buffer.from(minimal.value).toString('hex')).toBe(LOTUSD_HASH)
  }
})

it('returns undefined for P2SH and throws on non-hex', () => {
  expect(adapter().decodeP2pkhOutput(`a914${LOTUSD_HASH}87`)).toBeUndefined()
  expect(adapter().decodeP2pkhOutput('')).toBeUndefined()
  expect(() => adapter().decodeP2pkhOutput('not-hex')).toThrow(/Invalid script/)
})
