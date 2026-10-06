/**
 * Cross-Layer Surveillance Heuristic Suite (Issue #928 Follow-Up).
 *
 * Tests the "Multimodal / Cross-Layer Attack Vector":
 * Evaluates how blockchain intelligence firms (Chainalysis, TRM Labs) can correlate
 * on-chain EVM transactions with public off-chain relay messages carrying author identity signatures.
 *
 * Demonstrates:
 * 1. Mode 1 (Persistent Identity on Posts + Votes): Reveals 100% of forum and voting addresses.
 * 2. Mode 2 (Decoupled Voting): Completely protects voter privacy (0% voting leakage) and shrinks
 *    the clustered address footprint by 83.3%.
 * 3. Stealth Immunity: DKSAP inbound payments remain 100% invisible across all modes.
 */

import {
  runPrivacySimulation,
  runBaselineSimulation,
  CrossLayerSurveillanceEvaluator,
  formatCrossLayerComparativeMarkdownReport,
} from './privacy-simulation-engine'

describe('Cross-Layer (On-Chain + Relay) Surveillance Analysis', () => {
  jest.setTimeout(45000)

  it('proves persistent identity on both posts and votes clusters 100% of spend accounts', async () => {
    const simulation = await runPrivacySimulation({
      forumPosts: 10,
      forumVotes: 50,
      stealthPayments: 5,
      sweeps: 15,
      identitySigningPolicy: 'persistent-identity-all',
    })

    const evaluator = new CrossLayerSurveillanceEvaluator(simulation)
    const report = evaluator.evaluateTargetIdentityCluster()

    // 10 posts + 50 votes = 60 spend accounts
    expect(report.postAddressesClustered).toBe(10)
    expect(report.voteAddressesClustered).toBe(50)
    expect(report.activeSpendAddressesClustered).toBe(60)
    expect(report.activeSpendAddressClusteringRate).toBe(1.0) // 100% clustered

    // DKSAP stealth payments have zero identity linkage
    expect(report.stealthAddressesExposed).toBe(0)

    // 1-hop change sweep tracing captures descending change accounts
    expect(report.candidateChangeAddressesExposed).toBeGreaterThan(0)
  })

  it('proves decoupling voting from identity signature reduces clustered spend accounts by 83.3%', async () => {
    const simulation = await runPrivacySimulation({
      forumPosts: 10,
      forumVotes: 50,
      stealthPayments: 5,
      sweeps: 15,
      identitySigningPolicy: 'decoupled-voting',
    })

    const evaluator = new CrossLayerSurveillanceEvaluator(simulation)
    const report = evaluator.evaluateTargetIdentityCluster()

    // Posts remain identified (as intended for public author reputation)
    expect(report.postAddressesClustered).toBe(10)

    // BUT all 50 votes are completely anonymous!
    expect(report.voteAddressesClustered).toBe(0)
    expect(report.voteAddressClusteringRate).toBe(0.0)

    // Clustered spend accounts drop from 60 down to 10
    expect(report.activeSpendAddressesClustered).toBe(10)
    expect(report.activeSpendAddressClusteringRate).toBeCloseTo(10 / 60, 2)

    // Voting accounts maintain high entropy in the ambient transaction pool
    expect(report.crossLayerShannonEntropyBits).toBeGreaterThan(8.0)

    // DKSAP stealth payments remain 0% leaked
    expect(report.stealthAddressesExposed).toBe(0)
  })

  it('proves DKSAP inbound stealth payments remain completely decoupled (0% leakage) across all modes', async () => {
    const simulation = await runPrivacySimulation({
      forumPosts: 10,
      forumVotes: 50,
      stealthPayments: 5,
      sweeps: 15,
      identitySigningPolicy: 'persistent-identity-all',
    })

    const targetStealthAddrs = simulation.targetStealthAddresses
    expect(targetStealthAddrs.size).toBe(5)

    // Check that none of the stealth addresses appear in relay announcements
    const relaySenders = new Set(
      simulation.relayAnnouncements.map(a => a.senderAddress.toLowerCase()),
    )
    for (const stealthAddr of targetStealthAddrs) {
      expect(relaySenders.has(stealthAddr)).toBe(false)
    }

    const evaluator = new CrossLayerSurveillanceEvaluator(simulation)
    const report = evaluator.evaluateTargetIdentityCluster()
    expect(report.stealthAddressesExposed).toBe(0)
  })

  it('generates a cross-layer comparative markdown benchmark report', async () => {
    const persistentSim = await runPrivacySimulation({
      identitySigningPolicy: 'persistent-identity-all',
    })
    const decoupledSim = await runPrivacySimulation({
      identitySigningPolicy: 'decoupled-voting',
    })
    const baselineSim = await runBaselineSimulation()

    const persistentReport = new CrossLayerSurveillanceEvaluator(
      persistentSim,
    ).evaluateTargetIdentityCluster()
    const decoupledReport = new CrossLayerSurveillanceEvaluator(
      decoupledSim,
    ).evaluateTargetIdentityCluster()
    const baselineReport = new CrossLayerSurveillanceEvaluator(
      baselineSim,
    ).evaluateTargetIdentityCluster()

    const markdown = formatCrossLayerComparativeMarkdownReport(
      persistentReport,
      decoupledReport,
      baselineReport,
    )

    expect(markdown).toContain(
      'Cross-Layer (On-Chain + Off-Chain Relay) Surveillance Benchmark',
    )
    expect(markdown).toContain('Mode 1: Persistent Identity')
    expect(markdown).toContain('Mode 2: Decoupled Voting')
    expect(markdown).toContain('Naive Baseline')

    // Print benchmark table to stdout for inspection
    console.log('\n' + markdown)
  })
})
