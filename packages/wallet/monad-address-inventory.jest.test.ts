/**
 * Unit test suite for MonadAddressInventory (Ticket #924).
 *
 * Verifies:
 * 1. Derivation consistency across spend (m/44'/60'/0'/0/i) and change (m/44'/60'/0'/1/i) branches.
 * 2. Balance indexing, nonce tracking, and clean/dirty state transitions.
 * 3. Dynamic account selection across both branches without arbitrary promotion state machines.
 * 4. Best-fit account matching and branch preference.
 * 5. Signer instantiation and transaction signing capabilities.
 * 6. Consolidation candidate aggregation for bundle transactions.
 * 7. On-chain balance and nonce synchronization via mock provider.
 */

import { Provider, Transaction } from 'ethers'
import { MonadAddressInventory } from './monad-address-inventory'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadChangeKeyring } from './monad-change-keyring'
import { MonadTxSubmitter } from './monad-account-tx'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'

describe('MonadAddressInventory (Ticket #924)', () => {
  let inventory: MonadAddressInventory
  let spendKeyring: MonadHdKeyring
  let changeKeyring: MonadChangeKeyring

  beforeEach(() => {
    spendKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    changeKeyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    inventory = new MonadAddressInventory({
      spendKeyring,
      changeKeyring,
      initialLookahead: 5,
    })
  })

  describe('Keyring Derivation & Unified Registry', () => {
    it("correctly indexes spend accounts at m/44'/60'/0'/0/i", () => {
      const spend0 = inventory.getByIndex('spend', 0)
      expect(spend0).toBeDefined()
      expect(spend0?.branch).toBe('spend')
      expect(spend0?.index).toBe(0)
      expect(spend0?.path).toBe("m/44'/60'/0'/0/0")
      expect(spend0?.isClean).toBe(true)
      expect(spend0?.isSpent).toBe(false)
      expect(spend0?.nonce).toBe(0)

      const derivedDirect = spendKeyring.deriveSubAccount(0)
      expect(spend0?.address.toLowerCase()).toBe(
        derivedDirect.address.toLowerCase(),
      )
    })

    it("correctly indexes change accounts at m/44'/60'/0'/1/i", () => {
      const change0 = inventory.getByIndex('change', 0)
      expect(change0).toBeDefined()
      expect(change0?.branch).toBe('change')
      expect(change0?.index).toBe(0)
      expect(change0?.path).toBe("m/44'/60'/0'/1/0")
      expect(change0?.isClean).toBe(true)
      expect(change0?.isSpent).toBe(false)
      expect(change0?.nonce).toBe(0)

      const derivedDirect = changeKeyring.deriveChangeAccount(0)
      expect(change0?.address.toLowerCase()).toBe(
        derivedDirect.address.toLowerCase(),
      )
    })

    it('indexes spend and change accounts distinctly with different addresses', () => {
      const spend0 = inventory.getByIndex('spend', 0)!
      const change0 = inventory.getByIndex('change', 0)!
      expect(spend0.address.toLowerCase()).not.toBe(
        change0.address.toLowerCase(),
      )
    })

    it('allocates sequential fresh spend and change addresses', () => {
      const freshSpend = inventory.allocateNextSpendAddress()
      expect(freshSpend.branch).toBe('spend')
      expect(freshSpend.index).toBe(5)

      const freshChange = inventory.allocateNextChangeAddress()
      expect(freshChange.branch).toBe('change')
      expect(freshChange.index).toBe(5)
    })
  })

  describe('Dynamic Account Selection without Promotion (Issue #924)', () => {
    it('selects a spend account when it has sufficient balance', () => {
      const spend1 = inventory.getByIndex('spend', 1)!
      inventory.updateBalance(spend1.address, 100_000_000_000_000_000n) // 0.1 MON

      const selected = inventory.selectAccountForSpend(
        50_000_000_000_000_000n, // 0.05 MON
        21_000n,
      )
      expect(selected).toBeDefined()
      expect(selected?.address.toLowerCase()).toBe(spend1.address.toLowerCase())
      expect(selected?.branch).toBe('spend')
    })

    it('selects a CHANGE account directly when it has sufficient balance, WITHOUT requiring any promotion step', () => {
      // In the legacy architecture, change accounts could NOT be spent from without a promotion transaction.
      // In MonadAddressInventory, any HD account held with funds is immediately spendable!
      const change2 = inventory.getByIndex('change', 2)!
      inventory.updateBalance(change2.address, 200_000_000_000_000_000n) // 0.2 MON

      const selected = inventory.selectAccountForSpend(
        150_000_000_000_000_000n, // 0.15 MON
        21_000n,
      )
      expect(selected).toBeDefined()
      expect(selected?.address.toLowerCase()).toBe(
        change2.address.toLowerCase(),
      )
      expect(selected?.branch).toBe('change')
    })

    it('performs best-fit selection to minimize excess balance fragmentation', () => {
      const spend0 = inventory.getByIndex('spend', 0)!
      const change1 = inventory.getByIndex('change', 1)!
      const spend2 = inventory.getByIndex('spend', 2)!

      inventory.updateBalance(spend0.address, 1_000_000_000_000_000_000n) // 1.0 MON (large surplus)
      inventory.updateBalance(change1.address, 110_000_000_000_000_000n) // 0.11 MON (small surplus)
      inventory.updateBalance(spend2.address, 500_000_000_000_000_000n) // 0.5 MON (medium surplus)

      // Looking for 0.1 MON + 21000 gas
      const selected = inventory.selectAccountForSpend(
        100_000_000_000_000_000n,
        21_000n,
      )
      // change1 should be selected as the closest best fit (0.11 MON >= 0.100021 MON)
      expect(selected).toBeDefined()
      expect(selected?.address.toLowerCase()).toBe(
        change1.address.toLowerCase(),
      )
    })

    it('filters out dirty accounts (nonce > 0) unless allowDirty is true', () => {
      const spend1 = inventory.getByIndex('spend', 1)!
      inventory.updateBalance(spend1.address, 500_000_000_000_000_000n)
      inventory.updateNonce(spend1.address, 1) // Marked dirty

      const cleanSelected = inventory.selectAccountForSpend(
        100_000_000_000_000_000n,
        21_000n,
      )
      expect(cleanSelected).toBeUndefined()

      const dirtySelected = inventory.selectAccountForSpend(
        100_000_000_000_000_000n,
        21_000n,
        { allowDirty: true },
      )
      expect(dirtySelected?.address.toLowerCase()).toBe(
        spend1.address.toLowerCase(),
      )
    })

    it('respects branchPreference when multiple accounts qualify', () => {
      const spend1 = inventory.getByIndex('spend', 1)!
      const change1 = inventory.getByIndex('change', 1)!

      inventory.updateBalance(spend1.address, 200_000_000_000_000_000n)
      inventory.updateBalance(change1.address, 200_000_000_000_000_000n)

      const preferSpend = inventory.selectAccountForSpend(
        100_000_000_000_000_000n,
        21_000n,
        { branchPreference: 'spend' },
      )
      expect(preferSpend?.branch).toBe('spend')

      const preferChange = inventory.selectAccountForSpend(
        100_000_000_000_000_000n,
        21_000n,
        { branchPreference: 'change' },
      )
      expect(preferChange?.branch).toBe('change')
    })
  })

  describe('Consolidation Candidates Aggregation', () => {
    it('aggregates multiple clean accounts to cover a target amount', () => {
      inventory.updateBalance(
        inventory.getByIndex('spend', 0)!.address,
        30_000_000_000_000_000n,
      )
      inventory.updateBalance(
        inventory.getByIndex('spend', 1)!.address,
        40_000_000_000_000_000n,
      )
      inventory.updateBalance(
        inventory.getByIndex('change', 0)!.address,
        50_000_000_000_000_000n,
      )

      const result =
        inventory.findConsolidationCandidates(100_000_000_000_000_000n) // 0.1 MON
      expect(result.coversTarget).toBe(true)
      expect(result.accounts.length).toBeGreaterThanOrEqual(2)
      expect(result.totalBalanceWei).toBeGreaterThanOrEqual(
        100_000_000_000_000_000n,
      )
    })

    it('returns coversTarget = false if cumulative balance is insufficient', () => {
      inventory.updateBalance(
        inventory.getByIndex('spend', 0)!.address,
        10_000_000_000_000_000n,
      )
      const result =
        inventory.findConsolidationCandidates(100_000_000_000_000_000n)
      expect(result.coversTarget).toBe(false)
    })
  })

  describe('Signing Authority & Spend Tracking', () => {
    it('instantiates signers for both spend and change addresses', async () => {
      const mockProvider = {
        getFeeData: jest.fn().mockResolvedValue({
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        }),
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10143n }),
        estimateGas: jest.fn().mockResolvedValue(21000n),
        getTransactionCount: jest.fn().mockResolvedValue(0),
      } as unknown as Provider

      const mockHttpClient = {
        submitRawTransaction: jest.fn(),
        getTransactionReceipt: jest.fn(),
      } as unknown as MonadTxSubmitter

      const spendAccount = inventory.getByIndex('spend', 2)!
      const spendSigner = inventory.getSigner(spendAccount.address, {
        provider: mockProvider,
        httpClient: mockHttpClient,
      })
      expect(spendSigner.address.toLowerCase()).toBe(
        spendAccount.address.toLowerCase(),
      )

      const changeAccount = inventory.getByIndex('change', 3)!
      const changeSigner = inventory.getSigner(changeAccount.address, {
        provider: mockProvider,
        httpClient: mockHttpClient,
      })
      expect(changeSigner.address.toLowerCase()).toBe(
        changeAccount.address.toLowerCase(),
      )

      // Build and sign a transfer
      const signed = await changeSigner.buildAndSignTransfer(
        '0x000000000000000000000000000000000000dEaD',
        1000n,
      )
      expect(signed.from.toLowerCase()).toBe(
        changeAccount.address.toLowerCase(),
      )
      expect(signed.value).toBe(1000n)
      const parsed = Transaction.from(signed.rawTx)
      expect(parsed.from?.toLowerCase()).toBe(
        changeAccount.address.toLowerCase(),
      )
    })

    it('records spend operations and tracks nonce increments', () => {
      const spendAccount = inventory.getByIndex('spend', 0)!
      inventory.updateBalance(spendAccount.address, 10000n)
      expect(spendAccount.nonce).toBe(0)
      expect(spendAccount.isClean).toBe(true)

      inventory.recordSpend(spendAccount.address, {
        txHash: '0xabc',
        valueWei: 2000n,
      })

      expect(spendAccount.nonce).toBe(1)
      expect(spendAccount.isClean).toBe(false)
      expect(spendAccount.isSpent).toBe(true)
      expect(spendAccount.balanceWei).toBe(8000n)
    })
  })

  describe('scanBalances On-Chain Sync', () => {
    it('queries provider for balances and nonces across all indexed accounts', async () => {
      const mockProvider = {
        getBalance: jest.fn().mockImplementation((addr: string) => {
          if (
            addr.toLowerCase() ===
            inventory.getByIndex('spend', 0)!.address.toLowerCase()
          ) {
            return Promise.resolve(5000n)
          }
          if (
            addr.toLowerCase() ===
            inventory.getByIndex('change', 1)!.address.toLowerCase()
          ) {
            return Promise.resolve(8000n)
          }
          return Promise.resolve(0n)
        }),
        getTransactionCount: jest.fn().mockImplementation((addr: string) => {
          if (
            addr.toLowerCase() ===
            inventory.getByIndex('spend', 0)!.address.toLowerCase()
          ) {
            return Promise.resolve(2)
          }
          return Promise.resolve(0)
        }),
      } as unknown as Provider

      await inventory.scanBalances(mockProvider, 3)

      const spend0 = inventory.getByIndex('spend', 0)!
      expect(spend0.balanceWei).toBe(5000n)
      expect(spend0.nonce).toBe(2)
      expect(spend0.isClean).toBe(false)
      expect(spend0.isSpent).toBe(true)

      const change1 = inventory.getByIndex('change', 1)!
      expect(change1.balanceWei).toBe(8000n)
      expect(change1.nonce).toBe(0)
      expect(change1.isClean).toBe(true)
      expect(change1.isSpent).toBe(false)
    })
  })
})
