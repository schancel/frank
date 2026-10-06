import {
  Secp256k1HdKeyring,
  EvmHdKeyring,
  EvmChangeKeyring,
  UtxoHdKeyring,
  resolveBip44Path,
} from './secp256k1-hd-keyring'
import { MonadHdKeyring, subAccountPath } from './monad-hd-keyring'
import { MonadChangeKeyring, changeAccountPath } from './monad-change-keyring'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('Secp256k1HdKeyring & Path Resolution', () => {
  it('resolves BIP-44 path configurations correctly', () => {
    expect(resolveBip44Path({ coinType: 60, branch: 0 })).toBe("m/44'/60'/0'/0")
    expect(resolveBip44Path({ coinType: 60, branch: 1 })).toBe("m/44'/60'/0'/1")
    expect(resolveBip44Path({ coinType: 1899, account: 2, branch: 0 })).toBe(
      "m/44'/1899'/2'/0",
    )
    expect(resolveBip44Path("m/44'/60'/0'/0/")).toBe("m/44'/60'/0'/0")
  })

  it('rejects invalid BIP-44 path configurations', () => {
    expect(() => resolveBip44Path({ coinType: -1 })).toThrow(/coinType/)
    expect(() => resolveBip44Path({ coinType: 60, account: -1 })).toThrow(
      /account/,
    )
    expect(() =>
      resolveBip44Path({ coinType: 60, branch: 2 as never }),
    ).toThrow(/branch/)
  })

  it('derives sub-accounts with full path indices', () => {
    const keyring = Secp256k1HdKeyring.fromMnemonic(TEST_MNEMONIC, {
      coinType: 60,
      branch: 0,
    })
    expect(keyring.subAccountPath(0)).toBe("m/44'/60'/0'/0/0")
    expect(keyring.subAccountPath(5)).toBe("m/44'/60'/0'/0/5")

    const acc0 = keyring.deriveSubAccount(0)
    expect(acc0.index).toBe(0)
    expect(acc0.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(acc0.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(acc0.publicKey).toMatch(/^0x[0-9a-fA-F]{66}$/)

    expect(() => keyring.deriveSubAccount(-1)).toThrow(/non-negative integer/)
  })

  it('supports eCash and UTXO BIP-44 coin types', () => {
    const ecashSpend = UtxoHdKeyring.fromCoin(TEST_MNEMONIC, 1899, 0)
    expect(ecashSpend.pathPrefix).toBe("m/44'/1899'/0'/0")
    expect(ecashSpend.subAccountPath(0)).toBe("m/44'/1899'/0'/0/0")

    const ecashChange = UtxoHdKeyring.fromCoin(TEST_MNEMONIC, 1899, 1)
    expect(ecashChange.pathPrefix).toBe("m/44'/1899'/0'/1")
    expect(ecashChange.subAccountPath(0)).toBe("m/44'/1899'/0'/1/0")

    // The derived child keypairs on different branches are distinct
    const spendKey = ecashSpend.deriveSubAccount(0)
    const changeKey = ecashChange.deriveSubAccount(0)
    expect(spendKey.privateKey).not.toBe(changeKey.privateKey)
  })
})

describe('EvmHdKeyring & EvmChangeKeyring', () => {
  it("EvmHdKeyring derives spend accounts at m/44'/60'/0'/0/*", () => {
    const keyring = EvmHdKeyring.fromMnemonic(TEST_MNEMONIC)
    expect(keyring.pathPrefix).toBe("m/44'/60'/0'/0")
    expect(keyring.subAccountPath(0)).toBe("m/44'/60'/0'/0/0")

    const acc0 = keyring.deriveSubAccount(0)
    expect(acc0.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
  })

  it("EvmChangeKeyring derives change accounts at m/44'/60'/0'/1/*", () => {
    const keyring = EvmChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    expect(keyring.pathPrefix).toBe("m/44'/60'/0'/1")
    expect(keyring.subAccountPath(0)).toBe("m/44'/60'/0'/1/0")

    const acc0 = keyring.deriveSubAccount(0)
    expect(acc0.address).not.toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
  })

  it('generates fresh keyrings with valid mnemonics', () => {
    const { keyring, mnemonic } = EvmHdKeyring.generate()
    expect(mnemonic.split(' ').length).toBe(12)
    const acc0 = keyring.deriveSubAccount(0)
    expect(acc0.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('publicBranchDescriptor returns neutered public keys without private key exposure', () => {
    const keyring = EvmHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const descriptor = keyring.publicBranchDescriptor()
    expect(descriptor.path).toBe("m/44'/60'/0'/0")
    expect(descriptor.publicKey.length).toBe(33)
    expect(descriptor.chainCode.length).toBe(32)
    expect('privateKey' in descriptor).toBe(false)
  })
})

describe('Backwards Compatibility with MonadHdKeyring & MonadChangeKeyring', () => {
  it('MonadHdKeyring aliases EvmHdKeyring identically', () => {
    const legacyKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const evmKeyring = EvmHdKeyring.fromMnemonic(TEST_MNEMONIC)

    expect(legacyKeyring.deriveSubAccount(0)).toEqual(
      evmKeyring.deriveSubAccount(0),
    )
    expect(legacyKeyring.deriveSubAccount(1)).toEqual(
      evmKeyring.deriveSubAccount(1),
    )
    expect(subAccountPath(3)).toBe("m/44'/60'/0'/0/3")
  })

  it('MonadChangeKeyring aliases EvmChangeKeyring identically', () => {
    const legacyChangeKeyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    const evmChangeKeyring = EvmChangeKeyring.fromMnemonic(TEST_MNEMONIC)

    expect(legacyChangeKeyring.deriveSubAccount(0)).toEqual(
      evmChangeKeyring.deriveSubAccount(0),
    )
    expect(legacyChangeKeyring.deriveSubAccount(1)).toEqual(
      evmChangeKeyring.deriveSubAccount(1),
    )
    expect(changeAccountPath(3)).toBe("m/44'/60'/0'/1/3")
  })
})
