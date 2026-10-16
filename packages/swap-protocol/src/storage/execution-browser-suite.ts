import { BrowserSwapExecutionStore } from './execution-browser'
import {
  SwapExecutionCoordinator,
  type EvmSwapCapability,
  type LegFundingObservation,
  type LegSettlementObservation,
  type SwapCustodyHoldCapability,
  type XecSwapCapability,
} from '../swap-execution-runtime'

async function postStack(action: string, payload: unknown = {}): Promise<any> {
  const res = await fetch('/api/stack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  })
  if (!res.ok) {
    throw new Error(`Local stack HTTP ${res.status}`)
  }
  return await res.json()
}

function createStackCapabilities(): {
  custody: SwapCustodyHoldCapability
  xec: XecSwapCapability
  evm: EvmSwapCapability
} {
  const custody: SwapCustodyHoldCapability = {
    async acquireHold(operationId) {
      await postStack('acquire-hold', { operationId })
      return { operationId }
    },
    async releaseHold(operationId) {
      await postStack('release-hold', { operationId })
    },
  }

  const xec: XecSwapCapability = {
    async reserveInputs({ swapId, principalSats }) {
      const data = await postStack('xec-reserve', {
        swapId,
        principalSats: principalSats.toString(),
      })
      return {
        ...data,
        feeSats: BigInt(data.feeSats),
      }
    },
    async broadcastTransaction(txHex) {
      return await postStack('xec-broadcast', { txHex })
    },
    async observeFunding(txid): Promise<LegFundingObservation> {
      return await postStack('xec-observe-funding', { txid })
    },
    async observeSettlement(input): Promise<LegSettlementObservation> {
      return await postStack('xec-observe-settlement', input)
    },
    async releaseInputs(swapId) {
      await postStack('xec-release', { swapId })
    },
  }

  const evm: EvmSwapCapability = {
    async reserveInput({ swapId, principalWei }) {
      return await postStack('evm-reserve', {
        swapId,
        principalWei: principalWei.toString(),
      })
    },
    async broadcastTransaction(txHex) {
      return await postStack('evm-broadcast', { txHex })
    },
    async observeFunding(txHash): Promise<LegFundingObservation> {
      return await postStack('evm-observe-funding', { txHash })
    },
    async observeSettlement(input): Promise<LegSettlementObservation> {
      return await postStack('evm-observe-settlement', input)
    },
    async releaseInput(swapId) {
      await postStack('evm-release', { swapId })
    },
  }

  return { custody, xec, evm }
}

const NAMESPACE = 'local_stack_e2e'
const ACCOUNT_INCARNATION = 'acc-1:1'
const LOCAL_PUB = '02' + '11'.repeat(32)
const PEER_PUB = '03' + '22'.repeat(32)
const SWAP_ID = 'ab'.repeat(32)
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'

export async function runExecutionBrowserPhase(phase: string): Promise<any> {
  const store = new BrowserSwapExecutionStore(NAMESPACE)
  const { custody, xec, evm } = createStackCapabilities()
  const coordinator = new SwapExecutionCoordinator({
    store,
    custody,
    xec,
    evm,
  })

  try {
    if (phase === 'prepare-and-fund') {
      const prepared = await coordinator.prepare({
        swapId: SWAP_ID,
        conversationId: CONVERSATION_ID,
        accountIncarnation: ACCOUNT_INCARNATION,
        localPublicKey: LOCAL_PUB,
        peerPublicKey: PEER_PUB,
        role: 'initiator',
        xecChainIdentifier: 'xec-testnet',
        evmChainIdentifier: 'monad-testnet',
        xecPrincipal: 50_000n,
        evmPrincipal: 2_000_000_000_000_000n,
        expiry: 3_000_000_000,
        nowSec: 1_800_000_000,
      })
      const funded = await coordinator.fund(
        ACCOUNT_INCARNATION,
        LOCAL_PUB,
        SWAP_ID,
      )
      return {
        browser: navigator.userAgent,
        phase,
        preparedPhase: prepared.phase,
        fundedPhase: funded.phase,
        revision: funded.revision,
        xecInputs: funded.xecInputs,
        evmInput: funded.evmInput,
      }
    }

    if (phase === 'reopen-and-complete') {
      const restored = await coordinator.getOperation(
        ACCOUNT_INCARNATION,
        LOCAL_PUB,
        SWAP_ID,
      )
      if (!restored || !restored.fundingAuthorized) {
        throw new Error('Expected durable funded swap record on browser reopen')
      }
      await postStack('advance-confirmations', {
        fundingConfirmations: 10,
        settlementConfirmations: 0,
      })
      const readyToClaim = await coordinator.reconcile(
        ACCOUNT_INCARNATION,
        LOCAL_PUB,
        SWAP_ID,
      )
      if (readyToClaim.phase !== 'funded') {
        throw new Error(`Expected funded phase, got ${readyToClaim.phase}`)
      }
      await coordinator.claim(ACCOUNT_INCARNATION, LOCAL_PUB, SWAP_ID)
      await postStack('advance-confirmations', {
        fundingConfirmations: 12,
        settlementConfirmations: 10,
      })
      const completed = await coordinator.reconcile(
        ACCOUNT_INCARNATION,
        LOCAL_PUB,
        SWAP_ID,
      )
      return {
        browser: navigator.userAgent,
        phase,
        restoredPhase: restored.phase,
        completedPhase: completed.phase,
        retentionReleased: completed.retentionReleased,
        revision: completed.revision,
      }
    }

    throw new Error(`Unknown phase: ${phase}`)
  } finally {
    await store.close()
  }
}

;(globalThis as any).runExecutionBrowserPhase = runExecutionBrowserPhase
