import type { LevelDB } from 'level'

import { durableDelete, durablePut } from './level-durability'

export const TOPIC_OPERATION_KEY_PREFIX = 'topic-operation:'

interface OutgoingTopicOperationBase {
  version: 1
  requestBytes: number[]
  leaseIndex: number
  senderAddress: string
  rawTx: string
  txHash: string
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
  put(operation: OutgoingTopicOperation): Promise<void>
  delete(operation: OutgoingTopicOperation): Promise<void>
  getAll(): OutgoingTopicOperation[]
  referencesLeaseIndex(index: number): boolean
}

export function topicOperationKey(operation: OutgoingTopicOperation): string {
  return `${TOPIC_OPERATION_KEY_PREFIX}${operation.kind}:${operation.txHash
    .toLowerCase()
    .replace(/^0x/, '')}`
}

function cloneOperation(
  operation: OutgoingTopicOperation,
): OutgoingTopicOperation {
  return { ...operation, requestBytes: [...operation.requestBytes] }
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
  const allowed =
    value.kind === 'post'
      ? [
          'version',
          'kind',
          'requestBytes',
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

  referencesLeaseIndex(index: number): boolean {
    return Array.from(this.operations.values()).some(
      operation => operation.leaseIndex === index,
    )
  }
}

export class LevelTopicOperationJournal implements TopicOperationJournal {
  private readonly operations = new Map<string, OutgoingTopicOperation>()

  constructor(
    private readonly database: LevelDB,
    private readonly assertMutationAllowed: () => void,
  ) {}

  async Open(): Promise<void> {
    for await (const [key, encoded] of this.database.iterator({}) as any) {
      if (!key.startsWith(TOPIC_OPERATION_KEY_PREFIX)) continue
      const operation: unknown = JSON.parse(encoded)
      assertOutgoingTopicOperation(operation)
      if (key !== topicOperationKey(operation)) {
        throw new Error(
          'Outgoing topic operation key does not match its transaction',
        )
      }
      this.operations.set(key, cloneOperation(operation))
    }
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

  referencesLeaseIndex(index: number): boolean {
    return Array.from(this.operations.values()).some(
      operation => operation.leaseIndex === index,
    )
  }
}
