import { readFileSync } from 'fs'
import { join } from 'path'

import {
  BTC_MAINNET,
  BTC_TESTNET,
  hdPrivateFromSeed,
  serializeHdPrivate,
} from '@frank/nakamoto'

import {
  WalletXprivError,
  assertStoredXpriv,
  walletXprivFromSeedHex,
} from './wallet-xpriv'

// BIP-0032 test vector 1 master. 16-byte seed.
const VECTOR_1_SEED = '000102030405060708090a0b0c0d0e0f'
const VECTOR_1_MASTER =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'

// 64-byte BIP39-sized seed. Not a published vector; the nakamoto node is the oracle.
const SEED_64 = '00'.repeat(31) + '01'

function nakamotoRecord(seed: string, network: 'livenet' | 'testnet') {
  const node = hdPrivateFromSeed(Uint8Array.from(Buffer.from(seed, 'hex')))
  if (!node.ok) throw new Error(node.error.code)
  const chain = network === 'livenet' ? BTC_MAINNET : BTC_TESTNET
  const xprivkey = serializeHdPrivate(node.value, chain)
  if (!xprivkey.ok) throw new Error(xprivkey.error.code)
  return {
    network,
    depth: node.value.depth,
    parentFingerPrint: 0,
    childIndex: node.value.childIndex,
    chainCode: Buffer.from(node.value.chainCode).toString('hex'),
    privateKey: Buffer.from(node.value.privateKey.bytes).toString('hex'),
    xprivkey: xprivkey.value,
  }
}

describe('walletXprivFromSeedHex', () => {
  it('matches the BIP32 vector and the nakamoto node for a 64-byte seed', () => {
    const vector = walletXprivFromSeedHex(VECTOR_1_SEED)
    const nakamotoVector = nakamotoRecord(VECTOR_1_SEED, 'livenet')
    expect(vector.xprivkey).toBe(VECTOR_1_MASTER)
    expect(vector.xprivkey).toBe(nakamotoVector.xprivkey)
    expect(vector.privateKey).toBe(nakamotoVector.privateKey)
    expect(vector.chainCode).toBe(nakamotoVector.chainCode)
    expect(vector).toEqual({
      network: 'livenet',
      depth: 0,
      parentFingerPrint: 0,
      childIndex: 0,
      chainCode: nakamotoVector.chainCode,
      privateKey: nakamotoVector.privateKey,
      xprivkey: VECTOR_1_MASTER,
    })

    const wide = walletXprivFromSeedHex(SEED_64)
    const nakamotoWide = nakamotoRecord(SEED_64, 'livenet')
    expect(wide.xprivkey).toBe(nakamotoWide.xprivkey)
    expect(wide.privateKey).toBe(nakamotoWide.privateKey)
    expect(wide.chainCode).toBe(nakamotoWide.chainCode)
    expect(wide.network).toBe('livenet')
  })

  it('rejects a short seed, a non-hex seed, and a split record', () => {
    expect(() => walletXprivFromSeedHex('0001')).toThrow(WalletXprivError)
    expect(() => walletXprivFromSeedHex('zz')).toThrow(WalletXprivError)
    expect(() => walletXprivFromSeedHex(VECTOR_1_SEED + '0')).toThrow(
      WalletXprivError,
    )

    const stored = nakamotoRecord(VECTOR_1_SEED, 'livenet')
    expect(assertStoredXpriv(stored).xprivkey).toBe(VECTOR_1_MASTER)

    const testnet = nakamotoRecord(VECTOR_1_SEED, 'testnet')
    expect(testnet.xprivkey.startsWith('tprv')).toBe(true)
    expect(testnet.privateKey).toBe(stored.privateKey)
    expect(testnet.chainCode).toBe(stored.chainCode)
    expect(assertStoredXpriv(testnet).xprivkey.startsWith('tprv')).toBe(true)

    expect(() =>
      assertStoredXpriv({ ...stored, privateKey: '11'.repeat(32) }),
    ).toThrow(WalletXprivError)
    expect(() => assertStoredXpriv({ ...stored, xprivkey: 'xprv' })).toThrow(
      WalletXprivError,
    )
    expect(stored.privateKey).not.toBe('11'.repeat(32))
  })

  it('does not import bitcore-lib-xpi from the UI master-key files', () => {
    const files = [
      'stores/wallet.ts',
      'workers/xpriv_generate.ts',
      'pages/Setup.vue',
    ]
    for (const file of files) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8')
      expect(source).not.toMatch(/from ['"]bitcore-lib-xpi['"]/)
    }
  })
})
