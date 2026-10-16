import type { Provider } from 'ethers'
import type { MonadSubAccountPool } from '../monad-account-pool'
import type { SubAccountFundingAttempt } from '../storage/sub-account-pool-storage'
import type { EvmNativeOperation } from '../storage/evm-native-operation-journal'

/** Normal finality requires 10 confirmations on EVM chains. */
export const EVM_FINALITY_CONFIRMATIONS = 10

export interface EvmChainHeadCheckpoint {
  readonly blockNumber: number
  readonly blockHash: string
}

export type EvmReorgWarningKind =
  | 'deep-reorg'
  | 'native-inclusion-contradicted'
  | 'funding-disconnected'
  | 'spend-contradicted'
  | 'terminal-unspent-balance'

export interface EvmReorgWarning {
  readonly kind: EvmReorgWarningKind
  readonly message: string
  readonly reorgDepth?: number
  readonly operationId?: string
  readonly memberIndex?: number
  readonly poolIndex?: number
  readonly address?: string
  readonly txHash?: string
  readonly orphanedBlockNumber?: number
  readonly orphanedBlockHash?: string
  readonly canonicalBlockHash?: string | null
  readonly unspentBalanceWei?: string
}

export interface EvmHeadReconciliationResult {
  readonly head: EvmChainHeadCheckpoint
  readonly reorgDetected: boolean
  readonly reorgDepth: number
  readonly commonAncestorBlockNumber?: number
  readonly reobservedNativeMembers: readonly {
    readonly operationId: string
    readonly memberIndex: number
  }[]
  readonly downgradedFundingIndices: readonly number[]
  readonly warnings: readonly EvmReorgWarning[]
}

export function getConfirmationCount(
  inclusionBlockNumber: number,
  headBlockNumber: number,
): number {
  if (
    !Number.isSafeInteger(inclusionBlockNumber) ||
    !Number.isSafeInteger(headBlockNumber) ||
    inclusionBlockNumber < 0 ||
    headBlockNumber < inclusionBlockNumber
  ) {
    return 0
  }
  return headBlockNumber - inclusionBlockNumber + 1
}

export function isFinalizedAtHead(
  inclusionBlockNumber: number,
  headBlockNumber: number,
  threshold = EVM_FINALITY_CONFIRMATIONS,
): boolean {
  return getConfirmationCount(inclusionBlockNumber, headBlockNumber) >= threshold
}

export async function reconcileEvmChainHead(params: {
  provider: Provider
  pool?: MonadSubAccountPool
  nativeOperations?: readonly EvmNativeOperation[]
  observeNativeMember?: (operationId: string, memberIndex: number) => Promise<void>
  previousHead?: EvmChainHeadCheckpoint
   knownBlockHashes?: ReadonlyMap<number, string>
  onWarning?: (warning: EvmReorgWarning) => void
}): Promise<EvmHeadReconciliationResult> {
  const { provider, previousHead } = params
  const latest = await provider.getBlock('latest')
  if (
    !latest ||
    typeof latest.number !== 'number' ||
    !Number.isSafeInteger(latest.number) ||
    latest.number < 0 ||
    typeof latest.hash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(latest.hash)
  ) {
    throw new Error('Canonical EVM head block is unavailable')
  }

  const head: EvmChainHeadCheckpoint = {
    blockNumber: latest.number,
    blockHash: latest.hash.toLowerCase(),
  }

  const warnings: EvmReorgWarning[] = []
  const emitWarning = (warning: EvmReorgWarning) => {
    warnings.push(warning)
    params.onWarning?.(warning)
  }

  let reorgDetected = false
  let reorgDepth = 0
  let commonAncestorBlockNumber: number | undefined

  if (previousHead !== undefined) {
    const prevHash = previousHead.blockHash.toLowerCase()
    if (head.blockNumber < previousHead.blockNumber) {
      reorgDetected = true
    } else if (
      head.blockNumber === previousHead.blockNumber &&
      head.blockHash !== prevHash
    ) {
      reorgDetected = true
    } else {
      const canonicalAtPrev = await provider.getBlock(previousHead.blockNumber)
      if (
        !canonicalAtPrev?.hash ||
        canonicalAtPrev.hash.toLowerCase() !== prevHash
      ) {
        reorgDetected = true
      }
    }

    if (reorgDetected) {
      const checkStart = Math.min(head.blockNumber, previousHead.blockNumber)
      reorgDepth = previousHead.blockNumber - checkStart + 1
      if (params.knownBlockHashes && params.knownBlockHashes.size > 0) {
        const heights = [...params.knownBlockHashes.keys()]
          .filter(h => h <= checkStart)
          .sort((a, b) => b - a)
        for (const h of heights) {
          const expectedHash = params.knownBlockHashes.get(h)!.toLowerCase()
          const block = await provider.getBlock(h)
          if (block?.hash?.toLowerCase() === expectedHash) {
            commonAncestorBlockNumber = h
            reorgDepth = previousHead.blockNumber - h
            break
          }
          reorgDepth = previousHead.blockNumber - h + 1
        }
      }
    }
  }

  const reobservedNativeMembers: { operationId: string; memberIndex: number }[] =
    []
  const inspectAllRetained =
    reorgDetected || reorgDepth > EVM_FINALITY_CONFIRMATIONS

  for (const row of params.nativeOperations ?? []) {
    if (row.cancelled) continue
    for (let index = 0; index < row.members.length; index++) {
      const member = row.members[index]!
      const obs = member.observation
      if (
        obs.state !== 'included-success' &&
        obs.state !== 'included-revert'
      ) {
        continue
      }
      const wasFinalized =
        previousHead !== undefined &&
        isFinalizedAtHead(obs.blockNumber, previousHead.blockNumber)
      const withinWindow = !isFinalizedAtHead(obs.blockNumber, head.blockNumber)
      if (!withinWindow && !inspectAllRetained) {
        continue
      }
      const canonical = await provider.getBlock(obs.blockNumber)
      const canonicalHash = canonical?.hash?.toLowerCase() ?? null
      if (canonicalHash !== obs.blockHash.toLowerCase()) {
        reorgDetected = true
        const memberDepth =
          Math.max(head.blockNumber, previousHead?.blockNumber ?? obs.blockNumber) -
          obs.blockNumber +
          1
        if (memberDepth > reorgDepth) {
          reorgDepth = memberDepth
        }
        await params.observeNativeMember?.(row.operationId, index)
        reobservedNativeMembers.push({
          operationId: row.operationId,
          memberIndex: index,
        })
        if (
          wasFinalized ||
          memberDepth > EVM_FINALITY_CONFIRMATIONS
        ) {
          emitWarning({
            kind: 'native-inclusion-contradicted',
            message: `Deep reorg contradicted previously finalized native operation ${row.operationId} member ${index} at block ${obs.blockNumber}.`,
            reorgDepth: memberDepth,
            operationId: row.operationId,
            memberIndex: index,
            address: member.source.address,
            txHash: obs.transactionHash,
            orphanedBlockNumber: obs.blockNumber,
            orphanedBlockHash: obs.blockHash,
            canonicalBlockHash: canonicalHash,
          })
        }
      }
    }
  }

  const downgradedFundingIndices: number[] = []
  if (params.pool) {
    const records = params.pool.records()
    const checkpoints = params.pool.terminalCheckpoints()

    for (const row of [...records, ...checkpoints]) {
      if (row.funding) {
        let rowContradicted = false
        const updatedAttempts: SubAccountFundingAttempt[] = []
        for (const attempt of row.funding.attempts) {
          if (attempt.observation.kind !== 'included') {
            updatedAttempts.push(attempt)
            continue
          }
          const obsBlockNum = Number(attempt.observation.receiptBlock.number)
          const obsBlockHash = attempt.observation.receiptBlock.hash
          const withinWindow = !isFinalizedAtHead(obsBlockNum, head.blockNumber)
          if (!withinWindow && !inspectAllRetained) {
            updatedAttempts.push(attempt)
            continue
          }
          const canonical = await provider.getBlock(obsBlockNum)
          const canonicalHash = canonical?.hash?.toLowerCase() ?? null
          if (canonicalHash !== obsBlockHash.toLowerCase()) {
            reorgDetected = true
            rowContradicted = true
            const depth =
              Math.max(head.blockNumber, previousHead?.blockNumber ?? obsBlockNum) -
              obsBlockNum +
              1
            if (depth > reorgDepth) reorgDepth = depth
            updatedAttempts.push({
              ...attempt,
              observation: { kind: 'unresolved', reason: 'pending' },
            })
            emitWarning({
              kind: 'funding-disconnected',
              message: `Funding transaction ${attempt.txHash} for sub-account ${row.index} (${row.address}) was disconnected at block ${obsBlockNum}.`,
              reorgDepth: depth,
              poolIndex: row.index,
              address: row.address,
              txHash: attempt.txHash,
              orphanedBlockNumber: obsBlockNum,
              orphanedBlockHash: obsBlockHash,
              canonicalBlockHash: canonicalHash,
            })
          } else {
            updatedAttempts.push(attempt)
          }
        }
        if (
          rowContradicted &&
          'revision' in row &&
          typeof row.revision === 'number'
        ) {
          await params.pool.reconcileDisconnectedFunding(
            row.index,
            updatedAttempts,
          )
          downgradedFundingIndices.push(row.index)
        }
      }

      if (row.status === 'spent' || row.status === 'retired') {
        const spend = row.lifecycle?.spend
        const [balance, nonce, receipt] = await Promise.all([
          provider.getBalance(row.address, head.blockNumber),
          provider.getTransactionCount(row.address, head.blockNumber),
          spend
            ? provider.getTransactionReceipt(spend.txHash)
            : Promise.resolve(null),
        ])
        if (spend && (receipt === null || receipt.status !== 1)) {
          reorgDetected = true
          emitWarning({
            kind: 'spend-contradicted',
            message: `Retained ${row.status} sub-account ${row.index} (${row.address}) spend transaction ${spend.txHash} is no longer confirmed on the canonical chain (nonce=${nonce}, balance=${balance.toString()}). Sub-account remains quarantined from selection.`,
            poolIndex: row.index,
            address: row.address,
            txHash: spend.txHash,
            unspentBalanceWei: balance.toString(),
          })
        } else if (balance > 0n) {
          emitWarning({
            kind: 'terminal-unspent-balance',
            message: `Retained ${row.status} sub-account ${row.index} (${row.address}) holds an unspent balance of ${balance.toString()} wei on the canonical chain that cannot be resolved automatically.`,
            poolIndex: row.index,
            address: row.address,
            txHash: spend?.txHash,
            unspentBalanceWei: balance.toString(),
          })
        }
      }
    }
  }

  if (reorgDetected && reorgDepth > EVM_FINALITY_CONFIRMATIONS) {
    emitWarning({
      kind: 'deep-reorg',
      message: `Detected chain reorganization of depth ${reorgDepth} blocks exceeding the ${EVM_FINALITY_CONFIRMATIONS}-block finality threshold.`,
      reorgDepth,
      orphanedBlockNumber: previousHead?.blockNumber,
      orphanedBlockHash: previousHead?.blockHash,
      canonicalBlockHash: head.blockHash,
    })
  }

  return {
    head,
    reorgDetected,
    reorgDepth,
    ...(commonAncestorBlockNumber !== undefined
      ? { commonAncestorBlockNumber }
      : {}),
    reobservedNativeMembers,
    downgradedFundingIndices,
    warnings,
  }
}
