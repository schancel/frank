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
import { encodeTopicVote, validateFrame, defaultContext } from '@frank/codec'
import { hexlify } from 'ethers'

describe('Cross-Layer (On-Chain + Relay) Surveillance Analysis', () => {
  jest.setTimeout(120000)

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

    // Ensure zero target vote relay announcements carry the user's persistent identity pubkey
    const targetVotes = simulation.relayAnnouncements.filter(
      a => a.isTargetUser && a.actionType === 'forum-vote',
    )
    expect(targetVotes.length).toBe(50)
    for (const vote of targetVotes) {
      expect(vote.identityPubKey.toLowerCase()).not.toBe(
        simulation.targetIdentityPubKey.toLowerCase(),
      )
    }
  })

  it('enforces decoupled voting by default with 0% vote clustering and Shannon entropy > 8 bits', async () => {
    // When identitySigningPolicy is omitted, Frank defaults to decoupled voting
    const simulation = await runPrivacySimulation({
      forumPosts: 10,
      forumVotes: 50,
      stealthPayments: 5,
      sweeps: 15,
    })

    expect(simulation.identitySigningPolicy).toBe('decoupled-voting')
    const evaluator = new CrossLayerSurveillanceEvaluator(simulation)
    const report = evaluator.evaluateTargetIdentityCluster()

    // Public posts remain identified for author reputation
    expect(report.postAddressesClustered).toBe(10)

    // Voting is 100% decoupled from identity: 0 votes clustered
    expect(report.voteAddressesClustered).toBe(0)
    expect(report.voteAddressClusteringRate).toBe(0.0)

    // Clustered spend accounts drop from 60 down to 10
    expect(report.activeSpendAddressesClustered).toBe(10)
    expect(report.activeSpendAddressClusteringRate).toBeCloseTo(10 / 60, 2)

    // High Shannon graph entropy > 8 bits
    expect(report.crossLayerShannonEntropyBits).toBeGreaterThan(8.0)

    // DKSAP stealth payments remain 0% leaked
    expect(report.stealthAddressesExposed).toBe(0)

    // No target vote announcements carry the voter's persistent identity pubkey
    const targetVotes = simulation.relayAnnouncements.filter(
      a => a.isTargetUser && a.actionType === 'forum-vote',
    )
    expect(targetVotes.length).toBe(50)
    for (const vote of targetVotes) {
      expect(vote.identityPubKey.toLowerCase()).not.toBe(
        simulation.targetIdentityPubKey.toLowerCase(),
      )
    }
  })

  it('ensures type-11 TopicVoteSubmission frames strictly decouple identity signatures and keys', () => {
    const network = 'monad-testnet'
    const targetHash = new Uint8Array(32).fill(0xaa)
    const dummyBurnTx = new Uint8Array(64).fill(0xbb)

    const frameBytes = encodeTopicVote(network, targetHash, dummyBurnTx)
    const parsed = validateFrame(frameBytes, defaultContext())

    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') throw new Error('Failed to parse frame')

    expect(parsed.typeId).toBe(11) // TYPE_TOPIC_VOTE_SUBMISSION
    expect(parsed.typed).toBeDefined()
    expect(parsed.typed?.type).toBe(11)

    const voteSubmission = parsed.typed as {
      type: 11
      network: string
      targetHash: Uint8Array
      burnTx: Uint8Array
    }

    expect(voteSubmission.network).toBe(network)
    expect(hexlify(voteSubmission.targetHash)).toBe(hexlify(targetHash))
    expect(hexlify(voteSubmission.burnTx)).toBe(hexlify(dummyBurnTx))

    // Ensure NO identity pubkey or author signature properties exist on the submission frame
    expect((voteSubmission as any).identityPubKey).toBeUndefined()
    expect((voteSubmission as any).authorSignature).toBeUndefined()
    expect((voteSubmission as any).author).toBeUndefined()
    expect((voteSubmission as any).publicKey).toBeUndefined()
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
