import { Transaction, getAddress } from 'ethers'
import type { LevelDB } from 'level'

import { durableDelete, durablePut } from './level-durability'

export const TOPIC_OPERATION_KEY_PREFIX = 'topic-operation:'

interface RetainedTopicOperationBase {
  version: 1
  requestBytes: number[]
  /** Absent on deployed version-1 rows, which are legacy protobuf operations. */
  writeFormat?: 'protobuf' | 'cbor' | 'forum-cbor'
  leaseIndex: number
  senderAddress: string
  rawTx: string
  txHash: string
  valueWei: string
  direction: 'up' | 'down'
}

export type RetainedTopicOperation = RetainedTopicOperationBase &
  (
    | {
        kind: 'post'
        payloadHashHex: string
      }
    | {
        kind: 'vote'
        targetPayloadHashHex: string
      }
  )

export function assertRetainedTopicOperation(
  operation: unknown,
): asserts operation is RetainedTopicOperation {
  if (typeof operation !== 'object' || operation === null) {
    throw new Error('Invalid outgoing topic operation')
  }
  const value = operation as Record<string, unknown>
  const allowed =
    value.kind === 'post'
      ? [
          'version',
          'kind',
          'requestBytes',
          'writeFormat',
          'leaseIndex',
          'senderAddress',
          'rawTx',
          'txHash',
          'valueWei',
          'direction',
          'payloadHashHex',
        ]
      : value.kind === 'vote'
      ? [
          'version',
          'kind',
          'requestBytes',
          'writeFormat',
          'leaseIndex',
          'senderAddress',
          'rawTx',
          'txHash',
          'valueWei',
          'direction',
          'targetPayloadHashHex',
        ]
      : []
  if (
    allowed.length === 0 ||
    Object.keys(value).some(key => !allowed.includes(key)) ||
    value.version !== 1 ||
    (value.writeFormat !== undefined &&
      value.writeFormat !== 'protobuf' &&
      value.writeFormat !== 'cbor' &&
      value.writeFormat !== 'forum-cbor') ||
    !Array.isArray(value.requestBytes) ||
    value.requestBytes.length === 0 ||
    value.requestBytes.some(
      byte => !Number.isInteger(byte) || byte < 0 || byte > 255,
    ) ||
    !Number.isSafeInteger(value.leaseIndex) ||
    (value.leaseIndex as number) < 0 ||
    typeof value.senderAddress !== 'string' ||
    typeof value.rawTx !== 'string' ||
    typeof value.valueWei !== 'string' ||
    !/^\d+$/.test(value.valueWei) ||
    (value.direction !== 'up' && value.direction !== 'down')
  ) {
    throw new Error('Invalid outgoing topic operation')
  }
  assertHex(value.txHash, 32, 'outgoing topic transaction hash')
  try {
    const tx = Transaction.from(value.rawTx)
    if (
      !tx.isSigned() ||
      !tx.hash ||
      !tx.from ||
      tx.hash.slice(2).toLowerCase() !==
        (value.txHash as string).replace(/^0x/, '').toLowerCase() ||
      getAddress(value.senderAddress) !== getAddress(tx.from) ||
      tx.serialized.toLowerCase() !== value.rawTx.toLowerCase() ||
      tx.value.toString() !== value.valueWei
    )
      throw new Error('mismatched signed authority')
  } catch {
    throw new Error('Invalid retained topic signed authority')
  }
  if (value.kind === 'post') {
    assertHex(value.payloadHashHex, 32, 'outgoing topic payload hash')
  } else {
    assertHex(value.targetPayloadHashHex, 32, 'outgoing topic vote target hash')
  }
}

interface OutgoingTopicOperationBase {
  version: 2
  requestBytes: number[]
  writeFormat: 'forum-cbor'
  transactionSetOperationId: string
  funders: string[]
  rawTransactions: string[]
  transactionSetHash: string
  /** Original public post and burn policy, durable before financial construction. */
  construction?: {
    burnAddress: string
    postFrameHex?: string
    fundingOperationId?: string
  }
  intendedValueWei: string
  /** Actual aggregate burn, including economically unavoidable recipient gifts. */
  valueWei: string
  direction: 'up' | 'down'
}

export type OutgoingTopicOperation = OutgoingTopicOperationBase &
  (
    | {
        kind: 'post'
        payloadHashHex: string
      }
    | {
        kind: 'vote'
        targetPayloadHashHex: string
      }
  )

export interface TopicOperationJournal {
  /** Original v1 signed authority, never re-signed or normalized. */
  getRetainedLegacy?(): RetainedTopicOperation[]
  /** Terminal original-operation recovery only; immutable authority must still match. */
  deleteRetained?(operation: RetainedTopicOperation): Promise<void>
  holdsRetainedSource?(account: string): boolean
  put(operation: OutgoingTopicOperation): Promise<void>
  delete(operation: OutgoingTopicOperation): Promise<void>
  getAll(): OutgoingTopicOperation[]
}

export function topicOperationKey(operation: OutgoingTopicOperation): string {
  return `${TOPIC_OPERATION_KEY_PREFIX}${operation.kind}:${operation.transactionSetOperationId}`
}

function cloneOperation(
  operation: OutgoingTopicOperation,
): OutgoingTopicOperation {
  return {
    ...operation,
    requestBytes: [...operation.requestBytes],
    funders: [...operation.funders],
    rawTransactions: [...operation.rawTransactions],
    ...(operation.construction
      ? { construction: { ...operation.construction } }
      : {}),
  }
}

function assertHex(value: unknown, bytes: number, label: string): void {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }
}

export function assertOutgoingTopicOperation(
  operation: unknown,
): asserts operation is OutgoingTopicOperation {
  if (typeof operation !== 'object' || operation === null) {
    throw new Error('Invalid outgoing topic operation')
  }
  const value = operation as Record<string, unknown>
  const allowed = [
    'version',
    'kind',
    'requestBytes',
    'writeFormat',
    'transactionSetOperationId',
    'funders',
    'rawTransactions',
    'transactionSetHash',
    'construction',
    'intendedValueWei',
    'valueWei',
    'direction',
    value.kind === 'post' ? 'payloadHashHex' : 'targetPayloadHashHex',
  ]
  if (value.version !== 2)
    throw new Error(
      'Unsupported Forum operation format; retain funded wallet state and review the development Forum journal reset',
    )
  if (
    (value.kind !== 'post' && value.kind !== 'vote') ||
    Object.keys(value).some(key => !allowed.includes(key)) ||
    value.writeFormat !== 'forum-cbor' ||
    !Array.isArray(value.requestBytes) ||
    (!value.construction && value.requestBytes.length === 0) ||
    value.requestBytes.some(
      byte => !Number.isInteger(byte) || byte < 0 || byte > 255,
    ) ||
    typeof value.transactionSetOperationId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.transactionSetOperationId) ||
    !Array.isArray(value.funders) ||
    (!value.construction && value.funders.length < 1) ||
    value.funders.length > 64 ||
    !Array.isArray(value.rawTransactions) ||
    value.rawTransactions.length !== value.funders.length ||
    value.rawTransactions.some(
      raw => typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw),
    ) ||
    typeof value.valueWei !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.valueWei) ||
    typeof value.intendedValueWei !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.intendedValueWei) ||
    BigInt(value.valueWei) < BigInt(value.intendedValueWei) ||
    (value.direction !== 'up' && value.direction !== 'down')
  )
    throw new Error('Invalid outgoing topic operation')
  for (const funder of value.funders) assertHex(funder, 20, 'Forum funder')
  if (value.construction) {
    const construction = value.construction as Record<string, unknown>
    if (
      Object.keys(construction).some(
        key =>
          key !== 'burnAddress' &&
          key !== 'postFrameHex' &&
          key !== 'fundingOperationId',
      ) ||
      (construction.fundingOperationId !== undefined &&
        (typeof construction.fundingOperationId !== 'string' ||
          !construction.fundingOperationId.length)) ||
      value.funders.length ||
      value.rawTransactions.length ||
      value.requestBytes.length ||
      value.transactionSetHash !== '' ||
      typeof construction.burnAddress !== 'string' ||
      (value.kind === 'post' &&
        (typeof construction.postFrameHex !== 'string' ||
          !/^(?:[0-9a-f]{2})+$/.test(construction.postFrameHex)))
    )
      throw new Error('Invalid Forum construction intent')
    assertHex(construction.burnAddress, 20, 'Forum construction burn address')
  } else
    assertHex(
      value.transactionSetHash,
      32,
      'outgoing topic transaction set hash',
    )
  if (value.kind === 'post') {
    assertHex(value.payloadHashHex, 32, 'outgoing topic payload hash')
  } else {
    assertHex(value.targetPayloadHashHex, 32, 'outgoing topic vote target hash')
  }
}

function assertReplacement(
  prior: OutgoingTopicOperation | undefined,
  next: OutgoingTopicOperation,
): void {
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(next)) {
    const target = (operation: OutgoingTopicOperation) =>
      operation.kind === 'post'
        ? operation.payloadHashHex
        : operation.targetPayloadHashHex
    if (
      prior.construction &&
      next.construction &&
      prior.construction.fundingOperationId === undefined &&
      next.construction.fundingOperationId !== undefined &&
      JSON.stringify({
        ...next,
        construction: { ...next.construction, fundingOperationId: undefined },
      }) === JSON.stringify(prior)
    )
      return
    if (
      !prior.construction ||
      next.construction ||
      prior.transactionSetOperationId !== next.transactionSetOperationId ||
      prior.kind !== next.kind ||
      prior.direction !== next.direction ||
      prior.intendedValueWei !== next.intendedValueWei ||
      target(prior) !== target(next)
    )
      throw new Error('Cannot replace an outgoing topic operation')
  }
}

export class InMemoryTopicOperationJournal implements TopicOperationJournal {
  private readonly operations = new Map<string, OutgoingTopicOperation>()
  async put(operation: OutgoingTopicOperation): Promise<void> {
    assertOutgoingTopicOperation(operation)
    const key = topicOperationKey(operation)
    assertReplacement(this.operations.get(key), operation)
    this.operations.set(key, cloneOperation(operation))
  }

  async delete(operation: OutgoingTopicOperation): Promise<void> {
    this.operations.delete(topicOperationKey(operation))
  }

  getAll(): OutgoingTopicOperation[] {
    return Array.from(this.operations.values()).map(cloneOperation)
  }
}

export class LevelTopicOperationJournal implements TopicOperationJournal {
  private readonly operations = new Map<string, OutgoingTopicOperation>()
  private readonly retained = new Map<string, RetainedTopicOperation>()

  getRetainedLegacy(): RetainedTopicOperation[] {
    return Array.from(this.retained.values()).map(row => ({
      ...row,
      requestBytes: [...row.requestBytes],
    }))
  }

  holdsRetainedSource(account: string): boolean {
    const key = account.toLowerCase()
    return Array.from(this.retained.values()).some(row => {
      if (row.senderAddress.toLowerCase() === key) return true
      // Opening validated every signed source; an unexpected parse failure must fail closed.
      return Transaction.from(row.rawTx).from?.toLowerCase() === key
    })
  }

  constructor(
    private readonly database: LevelDB,
    private readonly assertMutationAllowed: () => void,
    private readonly assertRetainedBinding?: (
      operation: RetainedTopicOperation,
    ) => void,
  ) {}

  async Open(): Promise<void> {
    for await (const [key, encoded] of this.database.iterator({}) as any) {
      if (!key.startsWith(TOPIC_OPERATION_KEY_PREFIX)) continue
      const operation: unknown = JSON.parse(encoded)
      if ((operation as { version?: unknown })?.version === 1) {
        assertRetainedTopicOperation(operation)
        const expected = `${TOPIC_OPERATION_KEY_PREFIX}${
          operation.kind
        }:${operation.txHash.toLowerCase().replace(/^0x/, '')}`
        if (key !== expected)
          throw new Error('Retained topic operation key mismatch')
        this.assertRetainedBinding?.(operation)
        this.retained.set(key, {
          ...operation,
          requestBytes: [...operation.requestBytes],
        })
        continue
      }
      assertOutgoingTopicOperation(operation)
      if (key !== topicOperationKey(operation)) {
        throw new Error(
          'Outgoing topic operation key does not match its transaction',
        )
      }
      this.operations.set(key, cloneOperation(operation))
    }
  }

  async deleteRetained(operation: RetainedTopicOperation): Promise<void> {
    this.assertMutationAllowed()
    assertRetainedTopicOperation(operation)
    if (operation.writeFormat !== 'forum-cbor')
      throw new Error('Unsupported retained Forum operation')
    const key = `${TOPIC_OPERATION_KEY_PREFIX}${
      operation.kind
    }:${operation.txHash.toLowerCase().replace(/^0x/, '')}`
    const prior = this.retained.get(key)
    if (!prior) return
    if (JSON.stringify(prior) !== JSON.stringify(operation))
      throw new Error('Retained Forum authority changed before deletion')
    await durableDelete(this.database, key)
    this.retained.delete(key)
  }

  async put(operation: OutgoingTopicOperation): Promise<void> {
    this.assertMutationAllowed()
    assertOutgoingTopicOperation(operation)
    const key = topicOperationKey(operation)
    assertReplacement(this.operations.get(key), operation)
    await durablePut(this.database, key, JSON.stringify(operation))
    this.operations.set(key, cloneOperation(operation))
  }

  async delete(operation: OutgoingTopicOperation): Promise<void> {
    this.assertMutationAllowed()
    const key = topicOperationKey(operation)
    const prior = this.operations.get(key)
    if (
      prior !== undefined &&
      JSON.stringify(prior) !== JSON.stringify(operation)
    ) {
      throw new Error('Outgoing topic operation changed before deletion')
    }
    await durableDelete(this.database, key)
    this.operations.delete(key)
  }

  getAll(): OutgoingTopicOperation[] {
    return Array.from(this.operations.values()).map(cloneOperation)
  }
}
