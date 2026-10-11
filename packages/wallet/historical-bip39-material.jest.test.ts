import { HDNodeWallet, Mnemonic, getBytes } from 'ethers'
import { BIP39_DERIVATION } from '../domain-roots/src'
import { deriveBip39RoleLeaves } from '../role-keys/src'
import { selfOpenKeyFromBip39Seed } from '@frank/crypto-box'
import { conversationIdSaltFromBip39Seed } from '@frank/cashweb/relay/conversation-id'
import {
  createMonadWalletMaterial,
  legacyMnemonicWalletMaterial,
} from './monad-wallet-material'
import { MONAD_IDENTITY_DERIVATION_PATH } from './monad-identity'

const phrase = 'test test test test test test test test test test test junk'
const seedOf = () => getBytes(Mnemonic.fromPhrase(phrase).computeSeed())

test('historical seed material preserves identity, main, spend and change keys exactly', () => {
  const seed = seedOf()
  const restored = createMonadWalletMaterial({
    derivation: BIP39_DERIVATION,
    seed,
  })
  seed.fill(0)
  const historical = legacyMnemonicWalletMaterial({ mnemonic: phrase })
  try {
    expect(restored.identity.address).toEqual(historical.identity.address)
    expect(restored.identity.toPrivateKeyHex()).toBe(
      historical.identity.toPrivateKeyHex(),
    )
    expect(restored.mainAccount.address).toBe(historical.mainAccount.address)
    for (const index of [0, 1, 17]) {
      expect(restored.keyring.deriveSubAccount(index)).toEqual(
        historical.keyring.deriveSubAccount(index),
      )
      expect(restored.changeKeyring.deriveChangeAccount(index)).toEqual(
        historical.changeKeyring.deriveChangeAccount(index),
      )
    }
    const points = restored.canonicalRoles!.publicGenerationZeroPoints()
    expect(points.auth).toEqual(
      new Uint8Array(historical.identity.compressedPubKey),
    )
    expect(points.message).not.toEqual(points.auth)
    expect(points.stamp).not.toEqual(points.auth)
    expect(restored.canonicalRoles!.derivationRegistry).toBe(BIP39_DERIVATION)
    const reopened = createMonadWalletMaterial({
      derivation: BIP39_DERIVATION,
      seed: seedOf(),
    })
    try {
      expect(reopened.canonicalRoles!.publicGenerationZeroPoints()).toEqual(
        points,
      )
      expect(reopened.canonicalRoles!.conversationIdSalt()).toEqual(
        restored.canonicalRoles!.conversationIdSalt(),
      )
      expect(restored.canonicalRoles!.conversationIdSalt()).toEqual(
        conversationIdSaltFromBip39Seed(seedOf()),
      )
    } finally {
      reopened.dispose()
    }
  } finally {
    restored.dispose()
    historical.dispose()
  }
  expect(() => restored.canonicalRoles!.publicGenerationZeroPoints()).toThrow(
    'disposed',
  )
})

test('historical roles derive the established paths from all64 seed bytes and auxiliaries never truncate', () => {
  const seed = seedOf()
  const master = HDNodeWallet.fromSeed(seed)
  const leaves = deriveBip39RoleLeaves({
    seed,
    messageGeneration: 3n,
    stampGeneration: 2n,
    previousStampGeneration: 1n,
  })
  try {
    for (const [leaf, path] of [
      [leaves.auth, MONAD_IDENTITY_DERIVATION_PATH],
      [leaves.message, "m/44'/60'/4'/0'/3'"],
      [leaves.stamp, "m/44'/60'/2'/0'/2'"],
      [leaves.previousStamp!, "m/44'/60'/2'/0'/1'"],
    ] as const) {
      expect(leaf.public.path).toBe(path)
      expect(leaf.public.compressedPoint).toEqual(
        getBytes(master.derivePath(path).publicKey),
      )
      leaf.useSecret(secret =>
        expect(secret).toEqual(getBytes(master.derivePath(path).privateKey)),
      )
    }
    const changed = new Uint8Array(seed)
    changed[63] ^= 1
    expect(selfOpenKeyFromBip39Seed(changed)).not.toEqual(
      selfOpenKeyFromBip39Seed(seed),
    )
    expect(conversationIdSaltFromBip39Seed(changed)).not.toEqual(
      conversationIdSaltFromBip39Seed(seed),
    )
    expect(() => selfOpenKeyFromBip39Seed(seed.slice(0, 32))).toThrow()
    expect(() =>
      createMonadWalletMaterial({
        derivation: BIP39_DERIVATION,
        seed: seed.slice(0, 32),
      }),
    ).toThrow()
    expect(() =>
      deriveBip39RoleLeaves({
        seed,
        messageGeneration: 0n,
        stampGeneration: 0n,
        previousStampGeneration: 0n,
      }),
    ).toThrow('invalid-previous-generation')
  } finally {
    leaves.dispose()
    seed.fill(0)
  }
})
