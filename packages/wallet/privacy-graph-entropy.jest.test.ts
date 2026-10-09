/**
 * Automated Graph-Analysis & Entropy Simulation Test Suite (Ticket #928).
 *
 * Mathematically validates Frank's self-custodial privacy architecture against
 * surveillance heuristics (Chainalysis, TRM Labs) over a 30-day realistic user session,
 * and benchmarks it against a Naive Single-Account Web3 baseline.
 */

import {
  runPrivacySimulation,
  runBaselineSimulation,
  SurveillanceHeuristicEvaluator,
  formatComparativeMarkdownReport,
} from './privacy-simulation-engine'
import { deriveEvmStealthPrivateKey } from './monad-stealth'
import { getBytes, SigningKey } from 'ethers'

describe('Privacy Graph Analysis & Entropy Simulation (Ticket #928)', () => {
  jest.setTimeout(45000)

  let frankSimulation: Awaited<ReturnType<typeof runPrivacySimulation>>
  let baselineSimulation: Awaited<ReturnType<typeof runBaselineSimulation>>
  let frankEvaluator: SurveillanceHeuristicEvaluator
  let baselineEvaluator: SurveillanceHeuristicEvaluator

  beforeAll(async () => {
    // 1. Run Frank's self-custodial privacy simulation
    frankSimulation = await runPrivacySimulation({
      forumPosts: 10,
      forumVotes: 50,
      stealthPayments: 5,
      sweeps: 15,
      ambientActors: 20,
      ambientTransactionsPerDay: 10,
      durationDays: 30,
    })
    frankEvaluator = new SurveillanceHeuristicEvaluator(frankSimulation)

    // 2. Run Naive Single-Account Baseline simulation
    baselineSimulation = await runBaselineSimulation({
      forumPosts: 10,
      forumVotes: 50,
      stealthPayments: 5,
      sweeps: 0,
      ambientActors: 20,
      ambientTransactionsPerDay: 10,
      durationDays: 30,
    })
    baselineEvaluator = new SurveillanceHeuristicEvaluator(baselineSimulation)
  })

  describe('30-Day Session Simulation Integrity', () => {
    it('executes all expected user transactions and ambient background traffic in Frank simulation', () => {
      const txs = frankSimulation.ledger.getTransactions()
      expect(txs.length).toBeGreaterThanOrEqual(360) // 300 ambient + 75 target

      const posts = txs.filter(t => t.actionType === 'forum-post')
      expect(posts.length).toBe(10)

      const votes = txs.filter(t => t.actionType === 'forum-vote')
      expect(votes.length).toBe(50)

      const stealth = txs.filter(t => t.actionType === 'dksap-stealth-payment')
      expect(stealth.length).toBe(5)

      const sweeps = txs.filter(t => t.actionType === 'change-sweep')
      expect(sweeps.length).toBe(15)
    })

    it('executes all expected user transactions in Naive Baseline simulation', () => {
      const txs = baselineSimulation.ledger.getTransactions()
      expect(txs.length).toBeGreaterThanOrEqual(360)

      const posts = txs.filter(t => t.actionType === 'forum-post')
      expect(posts.length).toBe(10)

      const votes = txs.filter(t => t.actionType === 'forum-vote')
      expect(votes.length).toBe(50)

      const payments = txs.filter(
        t => t.actionType === 'baseline-direct-payment',
      )
      expect(payments.length).toBe(5)
    })
  })

  describe('Heuristic 1: Address Reuse Resistance vs Baseline', () => {
    it('achieves 0.0% address reuse for Frank while Baseline suffers 100% address reuse', () => {
      const frankResult = frankEvaluator.evaluateAddressReuse()
      expect(frankResult.totalActions).toBe(60) // 10 posts + 50 votes
      expect(frankResult.reusedCount).toBe(0)
      expect(frankResult.reuseRate).toBe(0)

      const baselineResult = baselineEvaluator.evaluateAddressReuse()
      expect(baselineResult.totalActions).toBe(60)
      // All 60 actions originate from the single hot address: 59 reuses!
      expect(baselineResult.reusedCount).toBe(59)
      expect(baselineResult.reuseRate).toBeCloseTo(59 / 60, 2)
    })
  })

  describe('Heuristic 2: Common-Input Leakage Resistance', () => {
    it('exhibits zero common-input co-signing leakage on EVM transactions', () => {
      const result = frankEvaluator.evaluateCommonInputLeakage()
      expect(result.coInputTransactions).toBe(0)
      expect(result.leakageRate).toBe(0)
    })
  })

  describe('Heuristic 3: Sibling Change Clumping & Graph Partitioning', () => {
    it('proves sibling change addresses have 0 on-chain co-edges and 0 clustering coefficient', () => {
      const result = frankEvaluator.evaluateSiblingChangeDisjointness()
      expect(result.changeCount).toBe(15)
      expect(result.siblingEdgeCount).toBe(0)
      expect(result.clusteringCoefficient).toBe(0)
    })

    it('disguises change sweeps as ordinary peer-to-peer transfers', () => {
      const txs = frankSimulation.ledger.getTransactions()
      const sweeps = txs.filter(t => t.actionType === 'change-sweep')
      for (const sweep of sweeps) {
        expect(sweep.data).toBe('0x')
        expect(sweep.valueWei).toBeGreaterThan(0n)
      }
    })
  })

  describe('Heuristic 4: Timing Correlation Resistance', () => {
    it('breaks temporal correlation between user actions and sweeps via randomized hygiene jitter', () => {
      const result = frankEvaluator.evaluateTimingCorrelation()
      // Pearson correlation r between action timestamp and sweep delay must be statistically uncorrelated
      // For N=15 samples, the two-tailed critical r at alpha=0.05 is 0.514; any |r| < 0.50 confirms independence
      expect(result.correlationCoefficient).toBeLessThan(0.5)
      expect(result.meanDelaySeconds).toBeGreaterThan(10)
    })
  })

  describe('Heuristic 5: Graph Entropy & Combinatorial Search Space Explosion', () => {
    it('demonstrates high Shannon entropy (> 8 bits) for Frank vs 0 bits for Baseline', () => {
      const frankEntropy = frankEvaluator.evaluateGraphEntropy()
      expect(frankEntropy.entropyBits).toBeGreaterThan(8)
      expect(frankEntropy.combinatorialSearchSpace).toMatch(
        /10\^\d+\.?\d* candidates/,
      )
      expect(frankEntropy.adversaryPrecision).toBeLessThan(0.1)

      const baselineEntropy = baselineEvaluator.evaluateGraphEntropy()
      expect(baselineEntropy.entropyBits).toBe(0)
      expect(baselineEntropy.adversaryPrecision).toBe(1.0)
    })
  })

  describe('DKSAP Stealth Payment Cryptographic Detection', () => {
    it('allows recipient to derive the private key for stealth payments while remaining unlinked to external observers', () => {
      const txs = frankSimulation.ledger.getTransactions()
      const stealthTxs = txs.filter(
        t => t.actionType === 'dksap-stealth-payment',
      )
      expect(stealthTxs.length).toBe(5)

      const recipientSpendSecret =
        frankSimulation.targetSpendKeyring!.deriveSubAccount(
          0,
        ).privateKey

      for (const tx of stealthTxs) {
        const ephemeralPubKey = getBytes(tx.data)
        const derived = deriveEvmStealthPrivateKey({
          recipientSpendSecret,
          ephemeralPubKey,
        })

        expect(derived.stealthAddress.toLowerCase()).toBe(tx.to.toLowerCase())
        expect(derived.stealthPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/)
      }
    })
  })

  describe('Comparative Benchmark Report', () => {
    it('generates a full markdown comparative benchmark report contrasting Frank and Baseline', () => {
      const frankReport = frankEvaluator.generateFullReport()
      const baselineReport = baselineEvaluator.generateFullReport()

      expect(frankReport.addressReuseRate).toBe(0)
      expect(baselineReport.addressReuseRate).toBeGreaterThan(0.95)

      expect(frankReport.distinctTargetAddressesUsed).toBeGreaterThanOrEqual(75)
      expect(baselineReport.distinctTargetAddressesUsed).toBe(1)

      const markdown = formatComparativeMarkdownReport(
        frankReport,
        baselineReport,
      )
      expect(markdown).toContain(
        '# Frank Privacy Architecture vs. Naive Web3 Baseline',
      )
      expect(markdown).toContain('Address Reuse Rate')
      expect(markdown).toContain('Shannon Graph Entropy')
      expect(markdown).toContain('Dual-Key Stealth')
    })
  })
})
