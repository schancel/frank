import {
  Ed25519HdKeyring,
  SolanaHdKeyring,
  SolanaChangeKeyring,
  deriveEd25519MasterNode,
  deriveEd25519PathNode,
  resolveEd25519Bip44Path,
  parseEd25519Path,
} from './ed25519-hd-keyring'

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

describe('Ed25519HdKeyring - SLIP-0010 Official Test Vectors', () => {
  describe('Test Vector 1 for ed25519', () => {
    const seed = hexToBytes('000102030405060708090a0b0c0d0e0f')

    it('derives master node m', () => {
      const master = deriveEd25519MasterNode(seed)
      expect(bytesToHex(master.chainCode)).toBe(
        '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
      )
      expect(bytesToHex(master.key)).toBe(
        '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
      )
    })

    it('derives m/0_H', () => {
      const master = deriveEd25519MasterNode(seed)
      const { node } = deriveEd25519PathNode(master, "m/0'")
      expect(bytesToHex(node.chainCode)).toBe(
        '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
      )
      expect(bytesToHex(node.key)).toBe(
        '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
      )
    })

    it('derives m/0_H/1_H', () => {
      const master = deriveEd25519MasterNode(seed)
      const { node } = deriveEd25519PathNode(master, "m/0'/1'")
      expect(bytesToHex(node.chainCode)).toBe(
        'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
      )
      expect(bytesToHex(node.key)).toBe(
        'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
      )
    })

    it('derives m/0_H/1_H/2_H', () => {
      const master = deriveEd25519MasterNode(seed)
      const { node } = deriveEd25519PathNode(master, "m/0'/1'/2'")
      expect(bytesToHex(node.chainCode)).toBe(
        '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c',
      )
      expect(bytesToHex(node.key)).toBe(
        '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9',
      )
    })

    it('derives m/0_H/1_H/2_H/2_H', () => {
      const master = deriveEd25519MasterNode(seed)
      const { node } = deriveEd25519PathNode(master, "m/0'/1'/2'/2'")
      expect(bytesToHex(node.chainCode)).toBe(
        '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc',
      )
      expect(bytesToHex(node.key)).toBe(
        '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662',
      )
    })

    it('derives m/0_H/1_H/2_H/2_H/1000000000_H', () => {
      const master = deriveEd25519MasterNode(seed)
      const { node } = deriveEd25519PathNode(
        master,
        "m/0'/1'/2'/2'/1000000000'",
      )
      expect(bytesToHex(node.chainCode)).toBe(
        '68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230',
      )
      expect(bytesToHex(node.key)).toBe(
        '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
      )
    })
  })

  describe('Test Vector 2 for ed25519', () => {
    const seed = hexToBytes(
      'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542',
    )

    it('derives master node m', () => {
      const master = deriveEd25519MasterNode(seed)
      expect(bytesToHex(master.chainCode)).toBe(
        'ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b',
      )
      expect(bytesToHex(master.key)).toBe(
        '171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012',
      )
    })
  })
})

describe('Ed25519 Path Resolution & Validation', () => {
  it('resolves BIP-44 path configurations correctly with hardened segments', () => {
    expect(resolveEd25519Bip44Path({ coinType: 501, branch: 0 })).toBe(
      "m/44'/501'/0'/0'",
    )
    expect(resolveEd25519Bip44Path({ coinType: 501, branch: 1 })).toBe(
      "m/44'/501'/0'/1'",
    )
    expect(
      resolveEd25519Bip44Path({ coinType: 501, account: 3, branch: 0 }),
    ).toBe("m/44'/501'/3'/0'")
  })

  it('rejects invalid BIP-44 path configurations', () => {
    expect(() => resolveEd25519Bip44Path({ coinType: -1 })).toThrow(/coinType/)
    expect(() =>
      resolveEd25519Bip44Path({ coinType: 501, account: -1 }),
    ).toThrow(/account/)
    expect(() =>
      resolveEd25519Bip44Path({ coinType: 501, branch: 2 as never }),
    ).toThrow(/branch/)
  })

  it('rejects unhardened path segments in SLIP-0010 derivation', () => {
    expect(() => parseEd25519Path("m/44'/501'/0'/0")).toThrow(
      /only supports hardened path segments/,
    )
    expect(() => parseEd25519Path('invalid/path')).toThrow(
      /must start with 'm'/,
    )
  })
})

describe('SolanaHdKeyring & SolanaChangeKeyring', () => {
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  it("SolanaHdKeyring derives spend accounts at m/44'/501'/0'/0'/i'", async () => {
    const keyring = await SolanaHdKeyring.fromMnemonic(TEST_MNEMONIC)
    expect(keyring.pathPrefix).toBe("m/44'/501'/0'/0'")
    expect(keyring.subAccountPath(0)).toBe("m/44'/501'/0'/0'/0'")
    expect(keyring.subAccountPath(1)).toBe("m/44'/501'/0'/0'/1'")

    const acc0 = await keyring.deriveSubAccount(0)
    expect(acc0.index).toBe(0)
    expect(acc0.path).toBe("m/44'/501'/0'/0'/0'")
    expect(acc0.address).toBe('B9sVeu4rJU12oUrUtzjc6BSNuEXdfvurZkdcaTVkP2LY')
    expect(acc0.publicKey.toBase58()).toBe(
      'B9sVeu4rJU12oUrUtzjc6BSNuEXdfvurZkdcaTVkP2LY',
    )
    expect(acc0.keypair.publicKey.toBase58()).toBe(
      'B9sVeu4rJU12oUrUtzjc6BSNuEXdfvurZkdcaTVkP2LY',
    )

    const acc1 = await keyring.deriveSubAccount(1)
    expect(acc1.index).toBe(1)
    expect(acc1.address).not.toBe(acc0.address)
  })

  it("SolanaChangeKeyring derives change accounts at m/44'/501'/0'/1'/i'", async () => {
    const changeKeyring = await SolanaChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    expect(changeKeyring.pathPrefix).toBe("m/44'/501'/0'/1'")
    expect(changeKeyring.subAccountPath(0)).toBe("m/44'/501'/0'/1'/0'")

    const spendKeyring = await SolanaHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const spendAcc = await spendKeyring.deriveSubAccount(0)
    const changeAcc = await changeKeyring.deriveChangeAccount(0)

    expect(changeAcc.address).not.toBe(spendAcc.address)
  })

  it('generates fresh keyrings with valid mnemonics', async () => {
    const { keyring, mnemonic } = await SolanaHdKeyring.generate()
    expect(mnemonic.split(' ').length).toBe(12)
    const acc0 = await keyring.deriveSubAccount(0)
    expect(acc0.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })

  it('publicBranchDescriptor returns neutered public key and chain code', async () => {
    const keyring = await SolanaHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const descriptor = keyring.publicBranchDescriptor()
    expect(descriptor.path).toBe("m/44'/501'/0'/0'")
    expect(descriptor.publicKey.length).toBe(32)
    expect(descriptor.chainCode.length).toBe(32)
    expect('privateKey' in descriptor).toBe(false)
  })
})
