import { createVaultWriteIntent } from '@frank/account-vault'
import { expected, id, same } from './records'
import {
  CustodyError,
  type CustodySnapshot,
  type RetentionIncarnation,
  type RetentionIntent,
  type RetentionReceipt,
  type RetentionSnapshot,
} from './types'

export interface RetentionRecord {
  readonly schema: 1
  readonly nextGeneration: number
  readonly holds: readonly RetentionReceipt[]
  readonly resetting?: true
}

function invalid(): never {
  throw new CustodyError('invalid-input')
}
function fields(value: object, names: readonly string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== [...names].sort().join(',')
  )
    invalid()
}
function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return value
}
function incarnation(value: RetentionIncarnation): RetentionIncarnation {
  const supplied = value.accountReceipt
  const accountReceipt = createVaultWriteIntent({
    context: supplied.context,
    expected: null,
    operationId: supplied.operationId,
  }).receipt
  if (!same(supplied, accountReceipt)) invalid()
  const accountRevision = expected({
    revision: value.accountRevision,
    accountId: accountReceipt.context.accountId,
  }).revision
  return { accountRevision, accountReceipt }
}

/** Synchronous input snapshots; caller mutation after invocation cannot redirect admission. */
export function captureRetentionIntent(
  input: RetentionIntent,
): RetentionIntent {
  try {
    fields(input, [
      'accountRevision',
      'accountReceipt',
      'operationId',
      'expectedGeneration',
    ])
    return {
      ...incarnation(input),
      operationId: id(input.operationId),
      expectedGeneration: generation(input.expectedGeneration),
    }
  } catch {
    return invalid()
  }
}
export function captureRetentionReceipt(
  input: RetentionReceipt,
): RetentionReceipt {
  try {
    fields(input, [
      'accountRevision',
      'accountReceipt',
      'operationId',
      'generation',
    ])
    return {
      ...incarnation(input),
      operationId: id(input.operationId),
      generation: generation(input.generation),
    }
  } catch {
    return invalid()
  }
}
export function activeIncarnation(
  account: CustodySnapshot,
): RetentionIncarnation | null {
  return account.active
    ? {
        accountRevision: account.revision,
        accountReceipt: account.active.receipt,
      }
    : null
}
export function matchesIncarnation(
  a: RetentionIncarnation | null,
  b: RetentionIncarnation,
): boolean {
  return (
    a !== null &&
    a.accountRevision === b.accountRevision &&
    same(a.accountReceipt, b.accountReceipt)
  )
}

/** Validate the entire row, including every hold's affinity, before any authority decision. */
export function parseRetention(
  value: RetentionRecord | undefined,
  account: CustodySnapshot,
): RetentionRecord {
  if (value === undefined) return { schema: 1, nextGeneration: 0, holds: [] }
  try {
    const resetting =
      value !== null && typeof value === 'object' && 'resetting' in value
    fields(
      value,
      resetting
        ? ['schema', 'nextGeneration', 'holds', 'resetting']
        : ['schema', 'nextGeneration', 'holds'],
    )
    if (
      value.schema !== 1 ||
      !Array.isArray(value.holds) ||
      value.holds.length > 64 ||
      (resetting && (value.resetting !== true || value.holds.length > 0))
    )
      invalid()
    const nextGeneration = generation(value.nextGeneration)
    const operations = new Set<string>(),
      generations = new Set<number>()
    const holds = Array.from(value.holds, input => {
      const hold = captureRetentionReceipt(input)
      if (
        hold.generation >= nextGeneration ||
        operations.has(hold.operationId) ||
        generations.has(hold.generation) ||
        !matchesIncarnation(activeIncarnation(account), hold)
      )
        invalid()
      operations.add(hold.operationId)
      generations.add(hold.generation)
      return hold
    })
    return resetting
      ? { schema: 1, nextGeneration, holds, resetting: true }
      : { schema: 1, nextGeneration, holds }
  } catch {
    throw new CustodyError('locked')
  }
}
export function retentionSnapshot(
  account: CustodySnapshot,
  retention: RetentionRecord,
): RetentionSnapshot {
  if (retention.resetting) throw new CustodyError('locked')
  return {
    active: activeIncarnation(account),
    nextGeneration: retention.nextGeneration,
    holds: retention.holds,
  }
}
export function acquireRetention(
  account: CustodySnapshot,
  retention: RetentionRecord,
  intent: RetentionIntent,
): RetentionRecord {
  if (
    retention.resetting ||
    !matchesIncarnation(activeIncarnation(account), intent)
  )
    throw new CustodyError('conflict')
  const existing = retention.holds.find(
    hold => hold.operationId === intent.operationId,
  )
  if (existing) {
    if (
      !matchesIncarnation(existing, intent) ||
      existing.generation !== intent.expectedGeneration
    )
      throw new CustodyError('conflict')
    return retention
  }
  if (intent.expectedGeneration !== retention.nextGeneration)
    throw new CustodyError('conflict')
  if (
    retention.holds.length >= 64 ||
    retention.nextGeneration === Number.MAX_SAFE_INTEGER
  )
    throw new CustodyError('capacity')
  return {
    schema: 1,
    nextGeneration: retention.nextGeneration + 1,
    holds: [
      ...retention.holds,
      {
        accountRevision: intent.accountRevision,
        accountReceipt: intent.accountReceipt,
        operationId: intent.operationId,
        generation: retention.nextGeneration,
      },
    ],
  }
}
export function releaseRetention(
  retention: RetentionRecord,
  receipt: RetentionReceipt,
): RetentionRecord {
  if (retention.resetting) throw new CustodyError('conflict')
  const existing = retention.holds.find(
    hold => hold.operationId === receipt.operationId,
  )
  if (!existing) return retention
  if (
    !matchesIncarnation(existing, receipt) ||
    existing.generation !== receipt.generation
  )
    throw new CustodyError('conflict')
  return {
    ...retention,
    holds: retention.holds.filter(hold => hold !== existing),
  }
}
export function beginResetRetention(
  account: CustodySnapshot,
  retention: RetentionRecord,
): RetentionRecord {
  if (retention.holds.length > 0) throw new CustodyError('conflict')
  if (retention.resetting) return retention
  const advance = account.active !== null || account.pending !== null
  if (advance && retention.nextGeneration === Number.MAX_SAFE_INTEGER)
    throw new CustodyError('capacity')
  return {
    schema: 1,
    nextGeneration: advance
      ? retention.nextGeneration + 1
      : retention.nextGeneration,
    holds: [],
    resetting: true,
  }
}
