import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  isAddressError,
  lockingScript,
  pubkeyHashFromOutputScript,
} from '../src/address.js'
import { pubkeyHashFromBytes } from '../src/constructors.js'

// lotusd src/test/descriptor_tests.cpp descriptor_test pins
// combo(L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1) to this script.
const LOTUSD_P2PKH = '76a9149a1c78a507689f6f54b847ad1cef1e614ee23f1e88ac'
const LOTUSD_HASH = '9a1c78a507689f6f54b847ad1cef1e614ee23f1e'

const load = createRequire(__filename)
const Script = load('bitcore-lib-xpi').Script as new (value: string) => {
  isPublicKeyHashOut(): boolean
  getPublicKeyHash(): { toString(encoding: 'hex'): string }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

describe('pubkeyHashFromOutputScript', () => {
  test('matches the lotusd descriptor_test P2PKH script', () => {
    const matched = pubkeyHashFromOutputScript(fromHex(LOTUSD_P2PKH))
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    expect(hex(matched.value)).toBe(LOTUSD_HASH)

    const old = new Script(LOTUSD_P2PKH)
    expect(old.isPublicKeyHashOut()).toBe(true)
    expect(old.getPublicKeyHash().toString('hex')).toBe(LOTUSD_HASH)

    const branded = pubkeyHashFromBytes(fromHex(LOTUSD_HASH))
    expect(branded.ok).toBe(true)
    if (!branded.ok) return
    expect(hex(lockingScript({ kind: 'p2pkh', hash: branded.value }))).toBe(
      LOTUSD_P2PKH,
    )
  })

  test('reads the BIP341 key-path fixture P2PKH output', () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, 'fixtures/bip341-keypath.json'), 'utf8'),
    ) as { utxosSpent: { scriptPubKey: string }[] }
    const scriptPubKey = fixture.utxosSpent[2]?.scriptPubKey
    expect(scriptPubKey).toBe(
      '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac',
    )
    const matched = pubkeyHashFromOutputScript(fromHex(scriptPubKey ?? ''))
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    expect(hex(matched.value)).toBe('751e76e8199196d454941c45d1b3a323f1433bd6')
  })

  test('rejects a non-minimal push that bitcore still calls P2PKH', () => {
    const pushed = `76a94c14${LOTUSD_HASH}88ac`
    expect(new Script(pushed).isPublicKeyHashOut()).toBe(true)
    expect(pubkeyHashFromOutputScript(fromHex(pushed))).toEqual({
      ok: false,
      error: { code: 'output-script-unmatched' },
    })
    expect(isAddressError({ code: 'output-script-unmatched' })).toBe(true)
  })

  test('rejects a truncated template and a P2SH output', () => {
    expect(
      pubkeyHashFromOutputScript(fromHex(LOTUSD_P2PKH.slice(0, -2))),
    ).toEqual({
      ok: false,
      error: { code: 'output-script-unmatched' },
    })
    const p2sh = `a914${LOTUSD_HASH}87`
    expect(new Script(p2sh).isPublicKeyHashOut()).toBe(false)
    expect(pubkeyHashFromOutputScript(fromHex(p2sh))).toEqual({
      ok: false,
      error: { code: 'output-script-unmatched' },
    })
  })
})
