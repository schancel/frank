import { Wallet } from 'ethers'
import { AccountUtxoPool, AccountUtxo, makeUtxoId } from './account-utxo-pool'
import { orderOfMagnitude2 } from './monad-change-distribution'

describe('AccountUtxoPool (Issue #1184)', () => {
  const wallet1 = Wallet.createRandom()
  const wallet2 = Wallet.createRandom()
  const wallet3 = Wallet.createRandom()
  const walletStealth = Wallet.createRandom()

  let pool: AccountUtxoPool

  beforeEach(() => {
    pool = new AccountUtxoPool()
  })

  describe('Key Registration Across Origins', () => {
    it('registers pre-derived HD sub-accounts with attached private keys', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 10_000_000n,
        derivationPath: "m/44'/60'/0'/0/0",
        index: 0,
      })

      expect(utxo.origin).toBe('subaccount')
      expect(utxo.status).toBe('clean')
      expect(utxo.nonce).toBe(0)
      expect(utxo.privateKey).toBe(wallet1.privateKey)
      expect(utxo.address.toLowerCase()).toBe(wallet1.address.toLowerCase())

      const fetched = pool.getUtxo(utxo.id)
      expect(fetched).toBeDefined()
      expect(fetched?.privateKey).toBe(wallet1.privateKey)
    })

    it('registers non-HD stealth accounts derived via ECDH with attached keys', () => {
      const utxo = pool.registerStealthAccount({
        chain: 'monad',
        address: walletStealth.address,
        privateKey: walletStealth.privateKey,
        balanceWei: 50_000_000n,
        ephemeralPubKey: '0x02abcdef123456',
        txHash: '0xdeadbeef1234',
        label: 'Alice Stealth Payment',
      })

      expect(utxo.origin).toBe('stealth')
      expect(utxo.status).toBe('clean')
      expect(utxo.nonce).toBe(0)
      expect(utxo.privateKey).toBe(walletStealth.privateKey)
      expect(utxo.ephemeralPubKey).toBe('0x02abcdef123456')

      const cleanList = pool.getCleanUtxos('monad')
      expect(cleanList).toHaveLength(1)
      expect(cleanList[0].id).toBe(utxo.id)
    })

    it('registers fresh change outputs from previous transactions', () => {
      const changeUtxo = pool.registerChangeOutput({
        chain: 'monad',
        address: wallet2.address,
        privateKey: wallet2.privateKey,
        balanceWei: 25_000_000n,
        derivationPath: "m/44'/60'/0'/1/0",
      })

      expect(changeUtxo.origin).toBe('change')
      expect(changeUtxo.status).toBe('clean')
      expect(changeUtxo.nonce).toBe(0)
      expect(changeUtxo.balanceWei).toBe(25_000_000n)
    })
  })

  describe('Instant O(1) Signer Instantiation', () => {
    it('creates MonadAccountTxSigner directly from attached private key without keychain queries', () => {
      const utxo = pool.registerStealthAccount({
        chain: 'monad',
        address: walletStealth.address,
        privateKey: walletStealth.privateKey,
        balanceWei: 100_000_000n,
      })

      const signer = pool.createSigner(utxo)
      expect(signer).toBeDefined()
      expect(signer.address.toLowerCase()).toBe(
        walletStealth.address.toLowerCase(),
      )
    })
  })

  describe('Coin Selection', () => {
    beforeEach(() => {
      // Setup pool with diverse denominations:
      // coinA: 10,000 wei
      pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 10_000n,
      })
      // coinB: 50,000 wei
      pool.registerChangeAccount({
        chain: 'monad',
        address: wallet2.address,
        privateKey: wallet2.privateKey,
        balanceWei: 50_000n,
      })
      // coinC: 100,000 wei
      pool.registerStealthAccount({
        chain: 'monad',
        address: walletStealth.address,
        privateKey: walletStealth.privateKey,
        balanceWei: 100_000n,
      })
      // coinD: 250,000 wei
      pool.registerSubAccount({
        chain: 'monad',
        address: wallet3.address,
        privateKey: wallet3.privateKey,
        balanceWei: 250_000n,
      })
    })

    it('selects best-fit single coin (smallest coin >= needed amount)', () => {
      // Need 40,000 wei + 5,000 fee = 45,000 wei.
      // Smallest coin >= 45,000 is coinB (50,000 wei), NOT coinC (100,000) or coinD (250,000).
      const result = pool.selectCoins({
        chain: 'monad',
        targetAmountWei: 40_000n,
        feeReserveWei: 5_000n,
      })

      expect(result.selected).toHaveLength(1)
      expect(result.selected[0].balanceWei).toBe(50_000n)
      expect(result.totalSelectedWei).toBe(50_000n)
      expect(result.changeWei).toBe(5_000n)
    })

    it('combines multiple coins greedily when no single coin covers target', () => {
      // Need 300,000 wei + 10,000 fee = 310,000 wei.
      // Largest coin is 250,000 (coinD), which does not cover 310,000 alone.
      // Greedy selection picks coinD (250,000) + coinC (100,000) = 350,000 wei.
      const result = pool.selectCoins({
        chain: 'monad',
        targetAmountWei: 300_000n,
        feeReserveWei: 10_000n,
      })

      expect(result.selected).toHaveLength(2)
      expect(result.totalSelectedWei).toBe(350_000n)
      expect(result.changeWei).toBe(40_000n)
    })

    it('respects origin preference when specified', () => {
      // Specifically prefer 'stealth' coins
      const result = pool.selectCoins({
        chain: 'monad',
        targetAmountWei: 20_000n,
        originPreference: 'stealth',
      })

      expect(result.selected).toHaveLength(1)
      expect(result.selected[0].origin).toBe('stealth')
      expect(result.selected[0].balanceWei).toBe(100_000n)
    })

    it('generates geometric radix change splits avoiding recipient payment OOM', () => {
      const targetAmountWei = 16_384n // 2^14 -> OOM 14
      const recipientOOM = orderOfMagnitude2(targetAmountWei)

      const result = pool.selectCoins({
        chain: 'monad',
        targetAmountWei,
        feeReserveWei: 1_000n,
        decoyAvoidance: true,
      })

      expect(result.changeWei).toBeGreaterThan(0n)
      if (result.suggestedChangeSplits.length > 0) {
        for (const split of result.suggestedChangeSplits) {
          // Verify none of the change outputs collide with recipient OOM
          expect(orderOfMagnitude2(split)).not.toBe(recipientOOM)
        }
      }
    })

    it('throws error when available balance is insufficient', () => {
      expect(() => {
        pool.selectCoins({
          chain: 'monad',
          targetAmountWei: 10_000_000n,
        })
      }).toThrow(/Insufficient funds/)
    })
  })

  describe('Atomic State Advance & Nonce Safety', () => {
    it('immediately marks spent UTXO as pending upon broadcast', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 100_000n,
      })

      expect(pool.getCleanUtxos('monad')).toHaveLength(1)

      // Advance to pending
      const pending = pool.markPending(utxo.id)
      expect(pending.status).toBe('pending')

      // Crucial: Pending UTXO is NO LONGER in clean inventory!
      expect(pool.getCleanUtxos('monad')).toHaveLength(0)
      expect(pool.getPendingUtxos('monad')).toHaveLength(1)

      // Subsequent coin selection cannot pick this coin
      expect(() => {
        pool.selectCoins({
          chain: 'monad',
          targetAmountWei: 50_000n,
        })
      }).toThrow(/Insufficient funds/)
    })

    it('rolls back pending status to clean if broadcast fails', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 100_000n,
      })

      pool.markPending(utxo.id)
      expect(pool.getCleanUtxos('monad')).toHaveLength(0)

      // Rollback
      pool.releasePending(utxo.id)
      expect(pool.getCleanUtxos('monad')).toHaveLength(1)
      expect(pool.getPendingUtxos('monad')).toHaveLength(0)
    })

    it('permanently marks confirmed transaction as spent and advances nonce', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 100_000n,
      })

      pool.markPending(utxo.id)
      const spent = pool.markSpent(utxo.id, 1)

      expect(spent.status).toBe('spent')
      expect(spent.nonce).toBe(1)
      expect(spent.balanceWei).toBe(0n)

      expect(pool.getCleanUtxos('monad')).toHaveLength(0)
      expect(pool.getPendingUtxos('monad')).toHaveLength(0)
    })
  })

  describe('Hygiene Engine & Sweeper Integration', () => {
    it('identifies dirty UTXOs with nonce > 0 and remaining balance', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 500_000n,
      })

      // Advance nonce externally
      pool.updateBalanceAndNonce({
        id: utxo.id,
        balanceWei: 350_000n,
        nonce: 1,
      })

      const dirty = pool.getDirtyUtxos('monad')
      expect(dirty).toHaveLength(1)
      expect(dirty[0].address.toLowerCase()).toBe(wallet1.address.toLowerCase())
      expect(dirty[0].nonce).toBe(1)
    })

    it('generates a geometric radix sweep plan for dirty accounts', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 1_000_000n,
      })

      pool.updateBalanceAndNonce({
        id: utxo.id,
        balanceWei: 800_000n,
        nonce: 2,
      })

      const changeAddrs = [wallet2.address, wallet3.address]
      const plan = pool.createSweepPlan({
        chain: 'monad',
        dirtyUtxoId: utxo.id,
        changeAddresses: changeAddrs,
        minFeeWei: 21_000n,
      })

      expect(plan.dirtyUtxo.id).toBe(utxo.id)
      expect(plan.totalSweepableWei).toBe(800_000n - 21_000n)
      expect(plan.changeOutputs.length).toBeGreaterThanOrEqual(1)

      // Total sweep amounts must conserve available balance
      const totalPlanned = plan.changeOutputs.reduce(
        (sum, o) => sum + o.amountWei,
        0n,
      )
      expect(totalPlanned).toBe(plan.totalSweepableWei)
    })
  })
})
