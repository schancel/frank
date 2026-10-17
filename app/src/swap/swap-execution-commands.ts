import { shallowReactive } from 'vue'
import { toHex } from '@frank/codec'
import {
  InMemorySwapExecutionStore,
  SwapExecutionCoordinator,
  type EvmSwapCapability,
  type PrepareSwapInput,
  type SwapCustodyHoldCapability,
  type SwapExecutionRecord,
  type SwapExecutionStore,
  type SwapRole,
  type SwapSecretVaultCapability,
  type XecSwapCapability,
} from '@frank/swap-protocol/src/swap-execution-runtime'
import { BrowserSwapExecutionStore } from '@frank/swap-protocol/src/storage/execution-browser'
import { accountSession } from '../accounts/session'
import { negotiationErrorCode } from './negotiation-commands'

export { BrowserSwapExecutionStore }

export const swapExecutionState = shallowReactive({
  busy: false,
  error: '',
  records: {} as Record<string, SwapExecutionRecord>,
  coordinator: null as SwapExecutionCoordinator | null,
})

function syncRecords(records: readonly SwapExecutionRecord[]): void {
  const next: Record<string, SwapExecutionRecord> = {}
  for (const r of records) {
    next[r.swapId.toLowerCase()] = r
  }
  swapExecutionState.records = next
}

export function installSwapExecutionCoordinator(
  coordinator: SwapExecutionCoordinator | null,
): void {
  swapExecutionState.coordinator = coordinator
  swapExecutionState.error = ''
  if (!coordinator) {
    swapExecutionState.records = {}
  }
}

export function createSwapExecutionCoordinator(options: {
  store?: SwapExecutionStore
  custody: SwapCustodyHoldCapability
  secretVault?: SwapSecretVaultCapability
  xec: XecSwapCapability
  evm: EvmSwapCapability
  verifySecretMatchesPoint?: (
    secret: Uint8Array,
    adaptorPointHex: string,
  ) => boolean
}): SwapExecutionCoordinator {
  const coordinator = new SwapExecutionCoordinator({
    store: options.store ?? new InMemorySwapExecutionStore(),
    custody: options.custody,
    secretVault: options.secretVault,
    xec: options.xec,
    evm: options.evm,
    verifySecretMatchesPoint: options.verifySecretMatchesPoint,
    onUpdate: syncRecords,
  })
  installSwapExecutionCoordinator(coordinator)
  return coordinator
}

export async function refreshSwapExecutionRecords(filter?: {
  accountIncarnation?: string
  localPublicKey?: string
}): Promise<void> {
  if (!swapExecutionState.coordinator) return
  const list = await swapExecutionState.coordinator.listOperations(filter)
  syncRecords(list)
}

export function getSwapExecutionRecord(
  swapIdHex: string,
): SwapExecutionRecord | undefined {
  return swapExecutionState.records[swapIdHex.toLowerCase()]
}

function currentExecutionOwner(): {
  accountIncarnation: string
  localPublicKey: string
} {
  const pub = accountSession.getCachedCurvePublicKey('secp256k1')
  const accountId =
    accountSession.state.account?.receipt.context.accountId ?? 'default'
  const revision = accountSession.state.account?.receipt.revision ?? 1
  if (!pub) {
    throw new Error('Session changed')
  }
  return {
    accountIncarnation: `${accountId}:${revision}`,
    localPublicKey: toHex(pub),
  }
}

async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  swapExecutionState.busy = true
  swapExecutionState.error = ''
  try {
    return await fn()
  } catch (err) {
    swapExecutionState.error = negotiationErrorCode(err)
    throw err
  } finally {
    swapExecutionState.busy = false
  }
}

export async function prepareSwapExecution(input: {
  swapId: string
  conversationId: string
  peerPublicKey: string
  role: SwapRole
  xecChainIdentifier: string
  evmChainIdentifier: string
  xecPrincipal: bigint
  evmPrincipal: bigint
  expiry: number
  nowSec?: number
  xecRefundTimestamp?: number
  evmOpeningTimestamp?: number
  evmChallengeDuration?: number
  jointPublicKey?: string
  adaptorPoint?: string
  adaptorSecret?: Uint8Array
}): Promise<SwapExecutionRecord> {
  return await runExclusive(async () => {
    const coordinator = swapExecutionState.coordinator
    if (!coordinator) throw new Error('Swap execution unavailable')
    const owner = currentExecutionOwner()
    const fullInput: PrepareSwapInput = {
      ...input,
      accountIncarnation: owner.accountIncarnation,
      localPublicKey: owner.localPublicKey,
      nowSec: input.nowSec ?? Math.floor(Date.now() / 1000),
    }
    const record = await coordinator.prepare(fullInput)
    swapExecutionState.records = {
      ...swapExecutionState.records,
      [record.swapId.toLowerCase()]: record,
    }
    return record
  })
}

export async function fundSwapExecution(
  swapId: string,
): Promise<SwapExecutionRecord> {
  return await runExclusive(async () => {
    const coordinator = swapExecutionState.coordinator
    if (!coordinator) throw new Error('Swap execution unavailable')
    const owner = currentExecutionOwner()
    const record = await coordinator.fund(
      owner.accountIncarnation,
      owner.localPublicKey,
      swapId,
    )
    swapExecutionState.records = {
      ...swapExecutionState.records,
      [record.swapId.toLowerCase()]: record,
    }
    return record
  })
}

export async function claimSwapExecution(
  swapId: string,
): Promise<SwapExecutionRecord> {
  return await runExclusive(async () => {
    const coordinator = swapExecutionState.coordinator
    if (!coordinator) throw new Error('Swap execution unavailable')
    const owner = currentExecutionOwner()
    const record = await coordinator.claim(
      owner.accountIncarnation,
      owner.localPublicKey,
      swapId,
    )
    swapExecutionState.records = {
      ...swapExecutionState.records,
      [record.swapId.toLowerCase()]: record,
    }
    return record
  })
}

export async function refundSwapExecution(
  swapId: string,
  nowSec?: number,
): Promise<SwapExecutionRecord> {
  return await runExclusive(async () => {
    const coordinator = swapExecutionState.coordinator
    if (!coordinator) throw new Error('Swap execution unavailable')
    const owner = currentExecutionOwner()
    const record = await coordinator.refund(
      owner.accountIncarnation,
      owner.localPublicKey,
      swapId,
      nowSec,
    )
    swapExecutionState.records = {
      ...swapExecutionState.records,
      [record.swapId.toLowerCase()]: record,
    }
    return record
  })
}

export async function cancelSwapExecution(
  swapId: string,
): Promise<SwapExecutionRecord> {
  return await runExclusive(async () => {
    const coordinator = swapExecutionState.coordinator
    if (!coordinator) throw new Error('Swap execution unavailable')
    const owner = currentExecutionOwner()
    const record = await coordinator.cancelBeforeExposure(
      owner.accountIncarnation,
      owner.localPublicKey,
      swapId,
    )
    swapExecutionState.records = {
      ...swapExecutionState.records,
      [record.swapId.toLowerCase()]: record,
    }
    return record
  })
}

export async function reconcileSwapExecution(
  swapId: string,
): Promise<SwapExecutionRecord> {
  return await runExclusive(async () => {
    const coordinator = swapExecutionState.coordinator
    if (!coordinator) throw new Error('Swap execution unavailable')
    const owner = currentExecutionOwner()
    const record = await coordinator.reconcile(
      owner.accountIncarnation,
      owner.localPublicKey,
      swapId,
    )
    swapExecutionState.records = {
      ...swapExecutionState.records,
      [record.swapId.toLowerCase()]: record,
    }
    return record
  })
}
