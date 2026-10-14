import {
  ColdVaultSweepConfig,
  ColdVaultSweeper,
  ColdVaultSweepJournal,
  ColdVaultSpendableCoin,
  computeTriggerCeilingAtomic,
  defaultMaxHotBalanceForChain,
  DEFAULT_COLD_VAULT_HYSTERESIS_BPS,
  DEFAULT_MAX_HOT_BALANCE_AVU,
  DEFAULT_MONAD_MAX_HOT_BALANCE_ATOMIC,
  DEFAULT_MONAD_TRIGGER_CEILING_ATOMIC,
  evaluateColdVaultSweep,
} from './cold-vault-sweeper'

const VAULT_ADDRESS = '0x9999999999999999999999999999999999999999'
const CHILD_1 = '0x1111111111111111111111111111111111111111'
const CHILD_2 = '0x2222222222222222222222222222222222222222'
const CHILD_3 = '0x3333333333333333333333333333333333333333'
const MAIN_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const ONE_MON = 10n ** 18n
const FEE_PER_INPUT = 21_000n * 50_000_000_000n // 0.00105 MON

describe('Cold-Wallet Auto-Sweeper (Issue #1572)', () => {
  describe('defaultMaxHotBalanceForChain & computeTriggerCeilingAtomic', () => {
    it('returns 1,500 MON (1500 * 10^18 wei, ~150 AVU) for monad-testnet and monad-mainnet with +20% hysteresis (1,800 MON)', () => {
      expect(DEFAULT_MAX_HOT_BALANCE_AVU).toBe(150)
      expect(DEFAULT_COLD_VAULT_HYSTERESIS_BPS).toBe(2000)
      expect(defaultMaxHotBalanceForChain('monad-testnet')).toBe(
        1500n * ONE_MON,
      )
      expect(defaultMaxHotBalanceForChain('monad-mainnet')).toBe(
        1500n * ONE_MON,
      )
      expect(defaultMaxHotBalanceForChain('monad')).toBe(
        DEFAULT_MONAD_MAX_HOT_BALANCE_ATOMIC,
      )

      const triggerCeiling = computeTriggerCeilingAtomic({
        maxHotBalanceAtomic: defaultMaxHotBalanceForChain('monad-testnet'),
      })
      expect(triggerCeiling).toBe(1800n * ONE_MON)
      expect(triggerCeiling).toBe(DEFAULT_MONAD_TRIGGER_CEILING_ATOMIC)
    })

    it('provides chain-appropriate atomic defaults for Solana, Ethereum, eCash, and Bitcoin', () => {
      expect(defaultMaxHotBalanceForChain('solana-devnet')).toBe(250_000_000n)
      expect(defaultMaxHotBalanceForChain('ethereum-sepolia')).toBe(
        15_000_000_000_000_000n,
      )
      expect(defaultMaxHotBalanceForChain('xec-testnet')).toBe(150_000_000n)
      expect(defaultMaxHotBalanceForChain('btc-testnet')).toBe(50_000n)
    })
  })

  describe('evaluateColdVaultSweep', () => {
    const baseConfig: ColdVaultSweepConfig = {
      chainId: 'monad-testnet',
      enabled: true,
      externalVaultAddress: VAULT_ADDRESS,
      maxHotBalanceAtomic: 1500n * ONE_MON,
      maxHotBalanceAvu: 150,
      hysteresisBps: 2000,
    }

    it('does not trigger when balance is at or below the +20% hysteresis ceiling (1,800 MON)', () => {
      const coins: ColdVaultSpendableCoin[] = [
        {
          id: 'coin-1',
          address: CHILD_1,
          balanceAtomic: 1800n * ONE_MON,
          origin: 'stealth',
          status: 'clean',
        },
      ]

      const atCeiling = evaluateColdVaultSweep({
        config: baseConfig,
        currentHotBalanceAtomic: 1800n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
      })
      expect(atCeiling.shouldSweep).toBe(false)
      expect(atCeiling.reason).toBe('below-trigger-ceiling')
      expect(atCeiling.triggerCeilingAtomic).toBe(1800n * ONE_MON)
      expect(atCeiling.directTransfers).toHaveLength(0)

      const belowMax = evaluateColdVaultSweep({
        config: baseConfig,
        currentHotBalanceAtomic: 1500n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
      })
      expect(belowMax.shouldSweep).toBe(false)
      expect(belowMax.reason).toBe('below-trigger-ceiling')
    })

    it('skips when disabled or vault address is missing/invalid', () => {
      const coins: ColdVaultSpendableCoin[] = [
        {
          id: 'coin-1',
          address: CHILD_1,
          balanceAtomic: 2000n * ONE_MON,
          origin: 'stealth',
        },
      ]

      expect(
        evaluateColdVaultSweep({
          config: { ...baseConfig, enabled: false },
          currentHotBalanceAtomic: 2000n * ONE_MON,
          spendableCoins: coins,
          estimatedFeePerInputAtomic: FEE_PER_INPUT,
        }).reason,
      ).toBe('disabled')

      expect(
        evaluateColdVaultSweep({
          config: { ...baseConfig, externalVaultAddress: '' },
          currentHotBalanceAtomic: 2000n * ONE_MON,
          spendableCoins: coins,
          estimatedFeePerInputAtomic: FEE_PER_INPUT,
        }).reason,
      ).toBe('missing-vault-address')

      expect(
        evaluateColdVaultSweep({
          config: { ...baseConfig, externalVaultAddress: 'not-an-address' },
          currentHotBalanceAtomic: 2000n * ONE_MON,
          spendableCoins: coins,
          estimatedFeePerInputAtomic: FEE_PER_INPUT,
        }).reason,
      ).toBe('invalid-vault-address')
    })

    it('sweeps excess funds directly in 1 hop (child -> externalVaultAddress) prioritizing unreserved stealth/stamp child coins', () => {
      // Total hot balance: 2,100 MON (> 1,800 MON ceiling).
      // Excess above 1,500 MON target = 600 MON.
      const coins: ColdVaultSpendableCoin[] = [
        {
          id: 'main-0',
          address: MAIN_ADDR,
          balanceAtomic: 1100n * ONE_MON,
          origin: 'main',
          status: 'clean',
        },
        {
          id: 'reserved-stealth',
          address: '0x4444444444444444444444444444444444444444',
          balanceAtomic: 400n * ONE_MON,
          origin: 'stealth',
          status: 'clean',
          reserved: true,
        },
        {
          id: 'stealth-1',
          address: CHILD_1,
          balanceAtomic: 400n * ONE_MON,
          origin: 'stealth',
          status: 'clean',
        },
        {
          id: 'stealth-2',
          address: CHILD_2,
          balanceAtomic: 200n * ONE_MON,
          origin: 'coin',
          status: 'clean',
        },
      ]

      const plan = evaluateColdVaultSweep({
        config: baseConfig,
        currentHotBalanceAtomic: 2100n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
      })

      expect(plan.shouldSweep).toBe(true)
      expect(plan.excessAtomic).toBe(600n * ONE_MON)
      expect(plan.totalGrossSweepAtomic).toBe(600n * ONE_MON)
      expect(plan.totalEstimatedFeeAtomic).toBe(2n * FEE_PER_INPUT)
      expect(plan.totalNetSweepAtomic).toBe(600n * ONE_MON - 2n * FEE_PER_INPUT)

      // Must select the 2 unreserved stealth/stamp child coins, ignoring reserved-stealth and leaving main untouched
      expect(plan.directTransfers).toHaveLength(2)
      expect(plan.directTransfers[0]).toMatchObject({
        coinId: 'stealth-1',
        sourceAddress: CHILD_1,
        destinationAddress: VAULT_ADDRESS,
        grossAmountAtomic: 400n * ONE_MON,
        feeAtomic: FEE_PER_INPUT,
        netAmountAtomic: 400n * ONE_MON - FEE_PER_INPUT,
        hops: 1,
        isFullCoinDrain: true,
      })
      expect(plan.directTransfers[1]).toMatchObject({
        coinId: 'stealth-2',
        sourceAddress: CHILD_2,
        destinationAddress: VAULT_ADDRESS,
        grossAmountAtomic: 200n * ONE_MON,
        feeAtomic: FEE_PER_INPUT,
        netAmountAtomic: 200n * ONE_MON - FEE_PER_INPUT,
        hops: 1,
        isFullCoinDrain: true,
      })
    })

    it('sweeps mainAccount surplus when child coins alone do not cover excessAtomic', () => {
      const coins: ColdVaultSpendableCoin[] = [
        {
          id: 'stealth-1',
          address: CHILD_1,
          balanceAtomic: 200n * ONE_MON,
          origin: 'stealth',
          status: 'clean',
        },
        {
          id: 'main-0',
          address: MAIN_ADDR,
          balanceAtomic: 1800n * ONE_MON,
          origin: 'main',
          status: 'clean',
        },
      ]

      const plan = evaluateColdVaultSweep({
        config: baseConfig,
        currentHotBalanceAtomic: 2000n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
      })

      expect(plan.shouldSweep).toBe(true)
      expect(plan.excessAtomic).toBe(500n * ONE_MON)
      expect(plan.directTransfers).toHaveLength(2)
      expect(plan.directTransfers[0].coinId).toBe('stealth-1')
      expect(plan.directTransfers[0].grossAmountAtomic).toBe(200n * ONE_MON)
      expect(plan.directTransfers[0].isFullCoinDrain).toBe(true)

      expect(plan.directTransfers[1].coinId).toBe('main-0')
      expect(plan.directTransfers[1].grossAmountAtomic).toBe(300n * ONE_MON)
      expect(plan.directTransfers[1].isFullCoinDrain).toBe(false)
      expect(plan.totalGrossSweepAtomic).toBe(500n * ONE_MON)
    })

    it('respects minSweepAmountAtomic threshold', () => {
      const coins: ColdVaultSpendableCoin[] = [
        {
          id: 'stealth-1',
          address: CHILD_1,
          balanceAtomic: 1850n * ONE_MON,
          origin: 'stealth',
          status: 'clean',
        },
      ]

      const plan = evaluateColdVaultSweep({
        config: {
          ...baseConfig,
          minSweepAmountAtomic: 400n * ONE_MON,
        },
        currentHotBalanceAtomic: 1850n * ONE_MON, // excess is 350 MON < 400 MON
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
      })

      expect(plan.shouldSweep).toBe(false)
      expect(plan.reason).toBe('below-min-sweep')
    })
  })

  describe('Durable at-most-once ColdVaultSweepJournal & ColdVaultSweeper', () => {
    it('executes a 1-hop sweep once and prevents duplicate execution across restarts or tabs', async () => {
      const kvStore = new Map<string, string>()
      const storage = {
        get: jest.fn(async (key: string) => {
          const val = kvStore.get(key)
          if (val === undefined) throw new Error('NotFound')
          return val
        }),
        put: jest.fn(async (key: string, value: string) => {
          kvStore.set(key, value)
        }),
      }

      const config: ColdVaultSweepConfig = {
        chainId: 'monad-testnet',
        enabled: true,
        externalVaultAddress: VAULT_ADDRESS,
        maxHotBalanceAtomic: 1500n * ONE_MON,
      }

      const coins: ColdVaultSpendableCoin[] = [
        {
          id: 'stealth-1',
          address: CHILD_1,
          balanceAtomic: 500n * ONE_MON,
          origin: 'stealth',
          status: 'clean',
        },
        {
          id: 'main-0',
          address: MAIN_ADDR,
          balanceAtomic: 1500n * ONE_MON,
          origin: 'main',
          status: 'clean',
        },
      ]

      const submitTxTab1 = jest.fn(async () => ({
        txHash: '0xdeadbeef11111111111111111111111111111111111111111111111111111111',
      }))

      const sweeperTab1 = new ColdVaultSweeper({
        storage,
        submitDirectTransfer: submitTxTab1,
      })

      const firstRun = await sweeperTab1.evaluateAndSweep({
        config,
        currentHotBalanceAtomic: 2000n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
        nowMs: 1_700_000_000_000,
      })

      expect(firstRun.executed).toBe(true)
      expect(submitTxTab1).toHaveBeenCalledTimes(1)
      expect(firstRun.record).toBeDefined()
      expect(firstRun.record?.status).toBe('submitted')
      expect(firstRun.record?.txHashes).toEqual([
        '0xdeadbeef11111111111111111111111111111111111111111111111111111111',
      ])
      expect(firstRun.record?.amountAtomic).toBe(500n * ONE_MON - FEE_PER_INPUT)

      // Simulate a second tab or app restart sharing the same durable storage
      const submitTxTab2 = jest.fn(async () => ({
        txHash: '0xdeadbeef22222222222222222222222222222222222222222222222222222222',
      }))
      const sweeperTab2 = new ColdVaultSweeper({
        storage,
        submitDirectTransfer: submitTxTab2,
      })

      const secondRun = await sweeperTab2.evaluateAndSweep({
        config,
        currentHotBalanceAtomic: 2000n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
        nowMs: 1_700_000_005_000,
      })

      expect(secondRun.executed).toBe(false)
      expect(secondRun.skippedReason).toBe('already-in-flight-or-swept')
      expect(submitTxTab2).not.toHaveBeenCalled()

      // Confirm the sweep in the journal and verify it remains protected against re-sweeping the same coin
      await sweeperTab2.journal.markConfirmed(firstRun.record!.sweepId)
      const confirmedRecord = await sweeperTab1.journal.getRecord(
        firstRun.record!.sweepId,
      )
      expect(confirmedRecord?.status).toBe('confirmed')

      const thirdRun = await sweeperTab2.evaluateAndSweep({
        config,
        currentHotBalanceAtomic: 2000n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
      })
      expect(thirdRun.executed).toBe(false)
      expect(thirdRun.skippedReason).toBe('already-in-flight-or-swept')
    })

    it('marks record as failed on broadcast error and allows retry afterward', async () => {
      const journal = new ColdVaultSweepJournal()
      const config: ColdVaultSweepConfig = {
        chainId: 'monad-testnet',
        enabled: true,
        externalVaultAddress: VAULT_ADDRESS,
        maxHotBalanceAtomic: 1500n * ONE_MON,
      }
      const coins: ColdVaultSpendableCoin[] = [
        {
          id: 'stealth-retry',
          address: CHILD_3,
          balanceAtomic: 500n * ONE_MON,
          origin: 'stealth',
          status: 'clean',
        },
        {
          id: 'main-0',
          address: MAIN_ADDR,
          balanceAtomic: 1500n * ONE_MON,
          origin: 'main',
          status: 'clean',
        },
      ]

      const failingSweeper = new ColdVaultSweeper({
        journal,
        submitDirectTransfer: async () => {
          throw new Error('RPC timeout')
        },
      })

      await expect(
        failingSweeper.evaluateAndSweep({
          config,
          currentHotBalanceAtomic: 2000n * ONE_MON,
          spendableCoins: coins,
          estimatedFeePerInputAtomic: FEE_PER_INPUT,
        }),
      ).rejects.toThrow('RPC timeout')

      const recordsAfterFail = await journal.listRecords('monad-testnet')
      expect(recordsAfterFail).toHaveLength(1)
      expect(recordsAfterFail[0].status).toBe('failed')
      expect(recordsAfterFail[0].error).toBe('RPC timeout')

      // Retry with working executor succeeds because failed records do not block retry
      const retrySweeper = new ColdVaultSweeper({
        journal,
        autoConfirmOnBroadcast: true,
        submitDirectTransfer: async () => ({
          txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        }),
      })

      const retryResult = await retrySweeper.evaluateAndSweep({
        config,
        currentHotBalanceAtomic: 2000n * ONE_MON,
        spendableCoins: coins,
        estimatedFeePerInputAtomic: FEE_PER_INPUT,
      })

      expect(retryResult.executed).toBe(true)
      expect(retryResult.record?.status).toBe('confirmed')
    })
  })
})
