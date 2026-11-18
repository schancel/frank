import { shallowReactive } from 'vue'
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
import { negotiationErrorCode } from './negotiation-commands'

export { BrowserSwapExecutionStore }

/**
 * Whose swap records these are: the account incarnation (`appNegotiationIncarnation`, the
 * same one the negotiation journals use) and the wallet's compressed secp256k1 key. Records
 * are written and read back under exactly this pair, so the runtime derives it once, when it
 * starts, and every command uses it.
 */
export interface SwapExecutionOwner {
  readonly accountIncarnation: string
  readonly localPublicKey: string
}

/**
 * Whether this device's swap records are open. `failed` is shown on the card: a swap funded
 * earlier may need its claim or refund, so records that cannot be opened are never shown as
 * "no swap".
 */
export type SwapExecutionRestore = 'off' | 'loading' | 'ready' | 'failed'

export type SwapExecutionRestoreFailure =
  | 'storage-unavailable'
  | 'account-unavailable'
  | 'records-unreadable'

export const swapExecutionState = shallowReactive({
  busy: false,
  error: '',
  records: {} as Record<string, SwapExecutionRecord>,
  coordinator: null as SwapExecutionCoordinator | null,
  owner: null as SwapExecutionOwner | null,
  restore: 'off' as SwapExecutionRestore,
  restoreFailure: null as SwapExecutionRestoreFailure | null,
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
  owner: SwapExecutionOwner | null = null,
): void {
  swapExecutionState.coordinator = coordinator
  swapExecutionState.owner = coordinator ? owner : null
  swapExecutionState.error = ''
  swapExecutionState.restore = coordinator ? 'ready' : 'off'
  swapExecutionState.restoreFailure = null
  if (!coordinator) {
    swapExecutionState.records = {}
  }
}

/** This device's swap records could not be opened: no coordinator, and the card says so. */
export function failSwapExecutionRestore(
  failure: SwapExecutionRestoreFailure,
): void {
  installSwapExecutionCoordinator(null)
  swapExecutionState.restore = 'failed'
  swapExecutionState.restoreFailure = failure
}

export function createSwapExecutionCoordinator(options: {
  owner: SwapExecutionOwner
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
  installSwapExecutionCoordinator(coordinator, options.owner)
  return coordinator
}

/**
 * Reads the installed owner's records from the store. A store that cannot be read leaves
 * `restore` at `failed`, and the error is thrown on.
 */
export async function refreshSwapExecutionRecords(): Promise<void> {
  const { coordinator, owner } = swapExecutionState
  if (!coordinator || !owner) return
  swapExecutionState.restore = 'loading'
  swapExecutionState.restoreFailure = null
  try {
    const list = await coordinator.listOperations(owner)
    if (swapExecutionState.coordinator !== coordinator) return
    syncRecords(list)
    swapExecutionState.restore = 'ready'
  } catch (error) {
    if (swapExecutionState.coordinator === coordinator) {
      swapExecutionState.restore = 'failed'
      swapExecutionState.restoreFailure = 'records-unreadable'
    }
    throw error
  }
}

export function getSwapExecutionRecord(
  swapIdHex: string,
): SwapExecutionRecord | undefined {
  return swapExecutionState.records[swapIdHex.toLowerCase()]
}

function currentExecutionOwner(): SwapExecutionOwner {
  const owner = swapExecutionState.owner
  if (!swapExecutionState.coordinator || !owner) {
    throw new Error('Swap execution unavailable')
  }
  return owner
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
