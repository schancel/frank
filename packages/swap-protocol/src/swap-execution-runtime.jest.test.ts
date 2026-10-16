import { bytesToHex } from '@noble/hashes/utils.js'
import {
  InMemorySwapExecutionStore,
  SwapExecutionCoordinator,
  type EvmSwapCapability,
  type LegFundingObservation,
  type LegSettlementObservation,
  type SwapCustodyHoldCapability,
  type SwapSecretVaultCapability,
  type XecSwapCapability,
} from './swap-execution-runtime'

function createHarness() {
  const store = new InMemorySwapExecutionStore()
  const activeHolds = new Set<string>()
  const sealedSecrets = new Map<
    string,
    {
      accountIncarnation: string
      operationId: string
      contextBindingHex: string
      secret: Uint8Array
    }
  >()
  const xecReserved = new Set<string>()
  const evmReserved = new Set<string>()
  const xecBroadcasts: string[] = []
  const evmBroadcasts: string[] = []

  let xecFundingObs: LegFundingObservation = {
    status: 'unseen',
    confirmations: 0,
  }
  let evmFundingObs: LegFundingObservation = {
    status: 'unseen',
    confirmations: 0,
  }
  let xecSettlementObs: LegSettlementObservation = {
    effect: 'none',
    status: 'unseen',
    confirmations: 0,
  }
  let evmSettlementObs: LegSettlementObservation = {
    effect: 'none',
    status: 'unseen',
    confirmations: 0,
  }

  const custody: SwapCustodyHoldCapability = {
    async acquireHold(operationId) {
      activeHolds.add(operationId)
      return { operationId }
    },
    async releaseHold(operationId) {
      activeHolds.delete(operationId)
    },
  }

  const secretVault: SwapSecretVaultCapability = {
    async sealSecret(input) {
      const receiptId = `secret:${input.operationId}`
      sealedSecrets.set(receiptId, {
        ...input,
        secret: new Uint8Array(input.secret),
      })
      return { receiptId }
    },
    async openSecret(input) {
      const record = sealedSecrets.get(input.receiptId)
      if (
        !record ||
        record.accountIncarnation !== input.accountIncarnation ||
        record.operationId !== input.operationId ||
        record.contextBindingHex !== input.contextBindingHex
      ) {
        throw new Error('Secret vault context mismatch')
      }
      return new Uint8Array(record.secret)
    },
    async retireSecret(receiptId) {
      sealedSecrets.delete(receiptId)
    },
  }

  const xec: XecSwapCapability = {
    async reserveInputs({ swapId, principalSats }) {
      xecReserved.add(swapId)
      return {
        inputs: [
          {
            txid: '11'.repeat(32),
            vout: 0,
            valueSats: (principalSats + 500n).toString(),
          },
        ],
        feeSats: 500n,
        fundingTxHex: '02000000xecfund',
        fundingTxid: 'aa'.repeat(32),
        claimTxHex: '02000000xecclaim',
        claimTxid: 'bb'.repeat(32),
        refundTxHex: '02000000xecrefund',
        refundTxid: 'cc'.repeat(32),
      }
    },
    async broadcastTransaction(txHex) {
      xecBroadcasts.push(txHex)
      return { txid: 'aa'.repeat(32) }
    },
    async observeFunding() {
      return xecFundingObs
    },
    async observeSettlement() {
      return xecSettlementObs
    },
    async releaseInputs(swapId) {
      xecReserved.delete(swapId)
    },
  }

  const evm: EvmSwapCapability = {
    async reserveInput({ swapId }) {
      evmReserved.add(swapId)
      return {
        input: {
          address: '0x' + '22'.repeat(20),
          nonce: 7,
          feeBudgetWei: '21000000000000',
        },
        fundingTxHex: '0x02evmfund',
        fundingTxHash: '0x' + 'dd'.repeat(32),
        claimTxHex: '0x02evmclaim',
        claimTxHash: '0x' + 'ee'.repeat(32),
        refundTxHex: '0x02evmrefund',
        refundTxHash: '0x' + 'ff'.repeat(32),
      }
    },
    async broadcastTransaction(txHex) {
      evmBroadcasts.push(txHex)
      return { txHash: '0x' + 'dd'.repeat(32) }
    },
    async observeFunding() {
      return evmFundingObs
    },
    async observeSettlement() {
      return evmSettlementObs
    },
    async releaseInput(swapId) {
      evmReserved.delete(swapId)
    },
  }

  const coordinator = new SwapExecutionCoordinator({
    store,
    custody,
    secretVault,
    xec,
    evm,
    verifySecretMatchesPoint: (secret, point) =>
      secret.length === 32 && point.startsWith('0x03'),
  })

  return {
    store,
    coordinator,
    activeHolds,
    sealedSecrets,
    xecReserved,
    evmReserved,
    xecBroadcasts,
    evmBroadcasts,
    setXecFunding: (obs: LegFundingObservation) => {
      xecFundingObs = obs
    },
    setEvmFunding: (obs: LegFundingObservation) => {
      evmFundingObs = obs
    },
    setXecSettlement: (obs: LegSettlementObservation) => {
      xecSettlementObs = obs
    },
    setEvmSettlement: (obs: LegSettlementObservation) => {
      evmSettlementObs = obs
    },
  }
}

const baseInput = {
  swapId: 'ab'.repeat(32),
  conversationId: '11111111-1111-4111-8111-111111111111',
  accountIncarnation: 'inc-1',
  localPublicKey: '02' + '33'.repeat(32),
  peerPublicKey: '03' + '44'.repeat(32),
  role: 'initiator' as const,
  xecChainIdentifier: 'xec-testnet',
  evmChainIdentifier: 'monad-testnet',
  xecPrincipal: 10_000n,
  evmPrincipal: 500_000_000_000_000n,
  expiry: 2_000_000,
  nowSec: 1_000_000,
  adaptorSecret: new Uint8Array(32).fill(9),
}

describe('SwapExecutionCoordinator (S3, S4, S6)', () => {
  it('acquires custody hold, reserves exact UTXO/account inputs, seals adaptor secret, and completes at 10-block finality', async () => {
    const h = createHarness()
    const prepared = await h.coordinator.prepare(baseInput)
    expect(prepared.phase).toBe('prepared')
    expect(prepared.xecInputs).toEqual([
      { txid: '11'.repeat(32), vout: 0, valueSats: '10500' },
    ])
    expect(prepared.evmInput).toEqual({
      address: '0x' + '22'.repeat(20),
      nonce: 7,
      feeBudgetWei: '21000000000000',
    })
    expect(h.activeHolds.has(prepared.retentionOperationId)).toBe(true)
    expect(prepared.secretReceiptId).toBe(
      `secret:${prepared.retentionOperationId}`,
    )
    expect(h.xecBroadcasts).toHaveLength(0)
    expect(h.evmBroadcasts).toHaveLength(0)

    // Fund and check write-ahead broadcast
    h.setXecFunding({ status: 'included', confirmations: 3 })
    h.setEvmFunding({ status: 'included', confirmations: 9 })
    const funding = await h.coordinator.fund(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    expect(funding.fundingAuthorized).toBe(true)
    expect(funding.phase).toBe('funding')
    expect(h.xecBroadcasts).toEqual(['02000000xecfund'])
    expect(h.evmBroadcasts).toEqual(['0x02evmfund'])

    // Cancel after funding cutoff is refused
    await expect(
      h.coordinator.cancelBeforeExposure(
        baseInput.accountIncarnation,
        baseInput.localPublicKey,
        baseInput.swapId,
      ),
    ).rejects.toThrow('Cannot cancel swap after funding exposure cutoff')

    // Reach 10-block finality on both funding legs
    h.setXecFunding({ status: 'included', confirmations: 10 })
    h.setEvmFunding({ status: 'included', confirmations: 12 })
    const funded = await h.coordinator.reconcile(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    expect(funded.phase).toBe('funded')
    expect(h.activeHolds.has(prepared.retentionOperationId)).toBe(true)

    // Claim broadcasts claim transactions and opens sealed secret
    h.setXecSettlement({
      effect: 'claim',
      status: 'included',
      confirmations: 2,
    })
    h.setEvmSettlement({
      effect: 'claim',
      status: 'included',
      confirmations: 2,
    })
    const claiming = await h.coordinator.claim(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    expect(claiming.phase).toBe('claiming')
    expect(claiming.adaptorSecretHex).toBe(bytesToHex(baseInput.adaptorSecret))
    expect(claiming.retentionReleased).toBe(false)

    // Reach 10-block settlement finality on both legs
    h.setXecSettlement({
      effect: 'claim',
      status: 'included',
      confirmations: 10,
    })
    h.setEvmSettlement({
      effect: 'claim',
      status: 'included',
      confirmations: 10,
    })
    const completed = await h.coordinator.reconcile(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    expect(completed.phase).toBe('complete')
    expect(completed.retentionReleased).toBe(true)
    expect(h.activeHolds.has(prepared.retentionOperationId)).toBe(false)
    expect(h.xecReserved.has(baseInput.swapId)).toBe(false)
    expect(h.evmReserved.has(baseInput.swapId)).toBe(false)
    expect(h.sealedSecrets.size).toBe(0)
  })

  it('replays exact persisted signed transactions on displaced funding and retains extracted adaptor secret across reorgs', async () => {
    const h = createHarness()
    const secretHex = bytesToHex(new Uint8Array(32).fill(0x5a))
    await h.coordinator.prepare({
      ...baseInput,
      role: 'responder',
      adaptorSecret: undefined,
    })
    h.setXecFunding({ status: 'unseen', confirmations: 0 })
    h.setEvmFunding({ status: 'included', confirmations: 10 })
    await h.coordinator.fund(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    // XEC was unseen during reconcile inside fund(), so it replayed the exact fundingTxHex
    expect(h.xecBroadcasts).toEqual(['02000000xecfund', '02000000xecfund'])

    // Counterparty claims on XEC revealing adaptor secret, then a 2-block reorg temporarily displaces it
    h.setXecFunding({ status: 'final', confirmations: 12 })
    h.setXecSettlement({
      effect: 'claim',
      status: 'included',
      confirmations: 1,
      extractedSecretHex: secretHex,
    })
    const seen = await h.coordinator.reconcile(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    expect(seen.adaptorSecretHex).toBe(secretHex)

    // Displaced in 2-block reorg: secret knowledge is retained
    h.setXecSettlement({
      effect: 'none',
      status: 'unseen',
      confirmations: 0,
      revertedDepth: 2,
    })
    const afterReorg = await h.coordinator.reconcile(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    expect(afterReorg.adaptorSecretHex).toBe(secretHex)
    expect(afterReorg.maxObservedReorgDepth).toBe(2)
    expect(afterReorg.reorgWarning).toBeUndefined()
  })

  it('surfaces reorg warning and keeps custody hold when reorg exceeds 10-block finality or settlement contradicts', async () => {
    const h = createHarness()
    const prepared = await h.coordinator.prepare(baseInput)
    h.setXecFunding({ status: 'final', confirmations: 10 })
    h.setEvmFunding({ status: 'final', confirmations: 10 })
    await h.coordinator.fund(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )

    h.setXecFunding({
      status: 'included',
      confirmations: 1,
      revertedDepth: 11,
    })
    const deep = await h.coordinator.reconcile(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )
    expect(deep.phase).toBe('recovery-required')
    expect(deep.reorgWarning).toBe('deep-reorg-exceeded-finality')
    expect(deep.retentionReleased).toBe(false)
    expect(h.activeHolds.has(prepared.retentionOperationId)).toBe(true)
  })

  it('enforces refund timelock before refunding and releases hold after 10-block refund finality', async () => {
    const h = createHarness()
    const prepared = await h.coordinator.prepare(baseInput)
    await h.coordinator.fund(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
    )

    await expect(
      h.coordinator.refund(
        baseInput.accountIncarnation,
        baseInput.localPublicKey,
        baseInput.swapId,
        baseInput.nowSec + 60,
      ),
    ).rejects.toThrow('Refund timelock has not matured yet')

    h.setXecSettlement({
      effect: 'refund',
      status: 'final',
      confirmations: 10,
    })
    h.setEvmSettlement({
      effect: 'refund',
      status: 'final',
      confirmations: 10,
    })
    const refunded = await h.coordinator.refund(
      baseInput.accountIncarnation,
      baseInput.localPublicKey,
      baseInput.swapId,
      prepared.xecRefundTimestamp + 1,
    )
    expect(refunded.phase).toBe('refunded')
    expect(refunded.retentionReleased).toBe(true)
    expect(h.activeHolds.has(prepared.retentionOperationId)).toBe(false)
  })
})
