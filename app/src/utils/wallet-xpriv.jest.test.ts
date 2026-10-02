import { readFileSync } from 'fs'
import { join } from 'path'

import { HDPrivateKey, Networks } from 'bitcore-lib-xpi'

import {
  WalletXprivError,
  assertStoredXpriv,
  walletXprivFromSeedHex,
} from './wallet-xpriv'

// BIP-0032 test vector 1 master. 16-byte seed.
const VECTOR_1_SEED = '000102030405060708090a0b0c0d0e0f'
const VECTOR_1_MASTER =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'

// 64-byte BIP39-sized seed. Not a published vector; bitcore is the oracle.
const SEED_64 = '00'.repeat(31) + '01'

function bitcoreRecord(seed: string, network?: object) {
  const fromSeed = HDPrivateKey.fromSeed as unknown as (
    hex: string,
    network?: object,
  ) => {
    toObject(): {
      network: string
      depth: number
      parentFingerPrint: number
      childIndex: number
      chainCode: string
      privateKey: string
      xprivkey: string
      fingerPrint: number
      checksum: number
    }
  }
  return fromSeed(seed, network).toObject() as {
    network: string
    depth: number
    parentFingerPrint: number
    childIndex: number
    chainCode: string
    privateKey: string
    xprivkey: string
    fingerPrint: number
    checksum: number
  }
}

describe('walletXprivFromSeedHex', () => {
  it('matches bitcore fromSeed for the BIP32 vector and a 64-byte seed', () => {
    const vector = walletXprivFromSeedHex(VECTOR_1_SEED)
    const bitcoreVector = bitcoreRecord(VECTOR_1_SEED)
    expect(vector.xprivkey).toBe(VECTOR_1_MASTER)
    expect(vector.xprivkey).toBe(bitcoreVector.xprivkey)
    expect(vector.privateKey).toBe(bitcoreVector.privateKey)
    expect(vector.chainCode).toBe(bitcoreVector.chainCode)
    expect(vector).toEqual({
      network: 'livenet',
      depth: 0,
      parentFingerPrint: 0,
      childIndex: 0,
      chainCode: bitcoreVector.chainCode,
      privateKey: bitcoreVector.privateKey,
      xprivkey: VECTOR_1_MASTER,
    })

    const wide = walletXprivFromSeedHex(SEED_64)
    const bitcoreWide = bitcoreRecord(SEED_64)
    expect(wide.xprivkey).toBe(bitcoreWide.xprivkey)
    expect(wide.privateKey).toBe(bitcoreWide.privateKey)
    expect(wide.chainCode).toBe(bitcoreWide.chainCode)
    expect(wide.network).toBe('livenet')
  })

  it('rejects a short seed, a non-hex seed, and a split record', () => {
    expect(() => walletXprivFromSeedHex('0001')).toThrow(WalletXprivError)
    expect(() => walletXprivFromSeedHex('zz')).toThrow(WalletXprivError)
    expect(() => walletXprivFromSeedHex(VECTOR_1_SEED + '0')).toThrow(
      WalletXprivError,
    )

    const stored = bitcoreRecord(VECTOR_1_SEED)
    expect(assertStoredXpriv(stored).xprivkey).toBe(VECTOR_1_MASTER)

    const testnet = bitcoreRecord(VECTOR_1_SEED, Networks.testnet)
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
