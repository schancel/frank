import {
  HdAddressInventory,
  EvmAddressInventory,
  SolanaAddressInventory,
} from './hd-address-inventory'
import { MonadAddressInventory } from './monad-address-inventory'
import { EvmHdKeyring, EvmChangeKeyring } from './secp256k1-hd-keyring'
import { SolanaHdKeyring, SolanaChangeKeyring } from './ed25519-hd-keyring'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('HdAddressInventory (Ticket #955)', () => {
  describe('EvmAddressInventory (secp256k1, coin 60)', () => {
    let inventory: EvmAddressInventory

    beforeEach(() => {
      inventory = EvmAddressInventory.fromMnemonic(TEST_MNEMONIC, '', 5)
    })

    it("indexes spend accounts at m/44'/60'/0'/0/i", () => {
      const spend0 = inventory.getByIndex('spend', 0)
      expect(spend0).toBeDefined()
      expect(spend0?.branch).toBe('spend')
      expect(spend0?.index).toBe(0)
      expect(spend0?.path).toBe("m/44'/60'/0'/0/0")
      expect(spend0?.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
      expect(spend0?.isClean).toBe(true)
    })

    it("indexes change accounts at m/44'/60'/0'/1/i", () => {
      const change0 = inventory.getByIndex('change', 0)
      expect(change0).toBeDefined()
      expect(change0?.branch).toBe('change')
      expect(change0?.index).toBe(0)
      expect(change0?.path).toBe("m/44'/60'/0'/1/0")
      expect(change0?.address).not.toBe(
        inventory.getByIndex('spend', 0)?.address,
      )
    })

    it('performs case-insensitive EVM address lookup', () => {
      const spend0 = inventory.getByIndex('spend', 0)!
      expect(inventory.getAccount(spend0.address)).toBeDefined()
      expect(inventory.getAccount(spend0.address.toLowerCase())).toBeDefined()
      expect(inventory.getAccount(spend0.address.toUpperCase())).toBeDefined()
    })

    it('allocates fresh spend and change addresses sequentially', () => {
      const spendNext = inventory.allocateNextSpendAddress()
      expect(spendNext.index).toBe(5)
      expect(spendNext.branch).toBe('spend')

      const changeNext = inventory.allocateNextChangeAddress()
      expect(changeNext.index).toBe(5)
      expect(changeNext.branch).toBe('change')
    })

    it('selects best-fit clean account for spend across branches', () => {
      const spend0 = inventory.getByIndex('spend', 0)!
      const change1 = inventory.getByIndex('change', 1)!

      inventory.updateBalance(spend0.address, 1_000_000_000n)
      inventory.updateBalance(change1.address, 500_000_000n)

      // Needs 400_000_000n -> change1 is closer best-fit than spend0
      const selected = inventory.selectAccountForSpend(400_000_000n, 10_000n)
      expect(selected?.address).toBe(change1.address)
    })

    it('finds minimal consolidation candidates', () => {
      const spend0 = inventory.getByIndex('spend', 0)!
      const spend1 = inventory.getByIndex('spend', 1)!

      inventory.updateBalance(spend0.address, 300_000_000n)
      inventory.updateBalance(spend1.address, 500_000_000n)

      const result = inventory.findConsolidationCandidates(700_000_000n)
      expect(result.coversTarget).toBe(true)
      expect(result.accounts).toHaveLength(2)
      expect(result.totalBalanceWei).toBe(800_000_000n)
    })
  })

  describe('SolanaAddressInventory (ed25519, coin 501)', () => {
    let solanaInventory: SolanaAddressInventory

    beforeEach(async () => {
      solanaInventory = await SolanaAddressInventory.fromMnemonic(
        TEST_MNEMONIC,
        '',
        5,
      )
    })

    it("indexes spend accounts at m/44'/501'/0'/0'/i'", () => {
      const spend0 = solanaInventory.getByIndex('spend', 0)
      expect(spend0).toBeDefined()
      expect(spend0?.branch).toBe('spend')
      expect(spend0?.index).toBe(0)
      expect(spend0?.path).toBe("m/44'/501'/0'/0'/0'")
      expect(spend0?.address).toBe(
        'B9sVeu4rJU12oUrUtzjc6BSNuEXdfvurZkdcaTVkP2LY',
      )
      expect(spend0?.isClean).toBe(true)
    })

    it("indexes change accounts at m/44'/501'/0'/1'/i'", () => {
      const change0 = solanaInventory.getByIndex('change', 0)
      expect(change0).toBeDefined()
      expect(change0?.branch).toBe('change')
      expect(change0?.index).toBe(0)
      expect(change0?.path).toBe("m/44'/501'/0'/1'/0'")
      expect(change0?.address).not.toBe(
        solanaInventory.getByIndex('spend', 0)?.address,
      )
    })

    it('preserves case sensitivity for Solana base58 addresses', () => {
      const spend0 = solanaInventory.getByIndex('spend', 0)!
      expect(solanaInventory.getAccount(spend0.address)).toBeDefined()
      // Lowercased or upper-cased base58 is NOT the same address
      expect(
        solanaInventory.getAccount(spend0.address.toLowerCase()),
      ).toBeUndefined()
    })

    it('resolves keypair on demand for derived Solana accounts', async () => {
      const spend0 = solanaInventory.getByIndex('spend', 0)!
      const keypair = await solanaInventory.getSignerKeypair(spend0.address)
      expect(keypair.publicKey.toBase58()).toBe(spend0.address)

      const changeKeypair = await solanaInventory.getSignerKeypair({
        branch: 'change',
        index: 0,
      })
      expect(changeKeypair.publicKey.toBase58()).toBe(
        solanaInventory.getByIndex('change', 0)?.address,
      )
    })

    it('supports balance tracking and dynamic spend selection on Solana', () => {
      const spend0 = solanaInventory.getByIndex('spend', 0)!
      const change0 = solanaInventory.getByIndex('change', 0)!

      solanaInventory.updateBalance(spend0.address, 100_000_000n) // 0.1 SOL
      solanaInventory.updateBalance(change0.address, 50_000_000n) // 0.05 SOL

      const selected = solanaInventory.selectAccountForSpend(
        40_000_000n,
        5_000n,
      )
      expect(selected?.address).toBe(change0.address)

      solanaInventory.recordSpend(selected!.address, { valueWei: 40_005_000n })
      expect(selected?.isClean).toBe(false)
      expect(selected?.isSpent).toBe(true)
      expect(selected?.nonce).toBe(1)
      expect(selected?.balanceWei).toBe(9_995_000n)
    })
  })

  describe('Backwards Compatibility with MonadAddressInventory', () => {
    it('MonadAddressInventory aliases EvmAddressInventory identically', () => {
      const monadInv = MonadAddressInventory.fromMnemonic(TEST_MNEMONIC, '', 5)
      const evmInv = EvmAddressInventory.fromMnemonic(TEST_MNEMONIC, '', 5)

      expect(monadInv.getByIndex('spend', 0)?.address).toBe(
        evmInv.getByIndex('spend', 0)?.address,
      )
      expect(monadInv.getByIndex('change', 0)?.address).toBe(
        evmInv.getByIndex('change', 0)?.address,
      )
    })
  })
})
