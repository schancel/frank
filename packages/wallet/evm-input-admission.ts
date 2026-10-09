import { getAddress, hexlify, Transaction } from 'ethers'
import type { MonadSubAccountPool } from './monad-account-pool'
import type { MonadChangePool } from './monad-change-pool'
import type { SubAccountLeaseManager } from './monad-account-lease'
import { PROTOCOL_CHAINS } from './chain/chains-registry'
import {
  EvmNativeJournalError,
  type EvmNativeOperationJournal,
  type EvmNativeBinding,
  type EvmNativePlan,
  type EvmNativeOperation,
  type EvmNativeSource,
} from './storage/evm-native-operation-journal'
import {
  CanonicalAttemptJournalError,
  type LevelCanonicalStampAttemptJournal,
  type CanonicalJournalIntent,
  type CanonicalJournalAttempt,
} from './storage/stamp-attempt-journal'
import {
  topicOperationKey,
  type TopicOperationJournal,
} from './storage/topic-operation-journal'

/** Runtime lifetime identity; possession is checked against the composing owner's live set. */
export interface WalletOperationLifetime {
  readonly walletBindingId: string
}
export interface AdmissionEpoch {
  readonly revision: number
}
export type EvmHeldResource =
  | { readonly kind: 'pair'; readonly address: string; readonly nonce: number }
  | { readonly kind: 'address'; readonly address: string }
  | {
      readonly kind: 'allocation'
      readonly pool: 'spend' | 'change'
      readonly index: number
    }
export type OwnerEvidence =
  | {
      readonly kind: 'native'
      readonly operationId: string
      readonly member: number
      readonly source: EvmNativeSource
    }
  | {
      readonly kind: 'canonical-intent' | 'canonical-attempt'
      readonly attemptRef: string
      readonly member: number
      readonly poolIndex: number
    }
  | {
      readonly kind: 'topic'
      readonly operationKey: string
      readonly poolIndex: number
    }
  | {
      readonly kind: 'pool-funding' | 'pool-retained'
      readonly poolIndex: number
      readonly role: 'funding' | 'spend' | 'hold'
    }
  | {
      readonly kind: 'change-sweep'
      readonly changeIndex: number
      readonly pending: boolean
    }
export interface ValidatedFrozenTransaction {
  readonly unsignedSerialized: string
  readonly sender: string
  readonly nonce: number
  readonly nativeChainId: string
  readonly transactionHash: string | null
}
export interface ProjectedObligation {
  readonly provenance: OwnerEvidence
  readonly binding: EvmNativeBinding
  readonly resources: readonly EvmHeldResource[]
  readonly transaction: ValidatedFrozenTransaction | null
}
export type AdmissionSnapshot =
  | {
      readonly status: 'ready'
      readonly epoch: AdmissionEpoch
      readonly obligations: readonly ProjectedObligation[]
    }
  | {
      readonly status: 'unavailable'
      readonly reason:
        | 'not-ready'
        | 'uncertain-owner'
        | 'invalid-provenance'
        | 'conflicting-authorization'
      readonly held: readonly EvmHeldResource[] | 'binding'
    }
export type CanonicalPrepareInput = Parameters<
  LevelCanonicalStampAttemptJournal['prepareIntent']
>[0]
export interface EvmInputAdmission {
  inspect(lifetime: WalletOperationLifetime): AdmissionSnapshot
  prepareNative(
    lifetime: WalletOperationLifetime,
    epoch: AdmissionEpoch,
    plan: EvmNativePlan,
  ): Promise<EvmNativeOperation>
  prepareCanonical(
    lifetime: WalletOperationLifetime,
    epoch: AdmissionEpoch,
    intent: CanonicalPrepareInput,
  ): Promise<CanonicalJournalIntent>
  authorizeNativeSigning(
    lifetime: WalletOperationLifetime,
    operationId: string,
  ): Promise<EvmNativeOperation>
  authorizeCanonicalSigning(
    lifetime: WalletOperationLifetime,
    attemptRef: string,
  ): Promise<CanonicalJournalIntent>
}
export class EvmInputAdmissionError extends Error {
  constructor(
    readonly reason:
      | 'not-ready'
      | 'uncertain-owner'
      | 'invalid-provenance'
      | 'conflicting-authorization'
      | 'foreign-lifetime'
      | 'stale-epoch'
      | 'reentrant-mutation',
  ) {
    super(`evm-input-admission:${reason}`)
    this.name = 'EvmInputAdmissionError'
  }
}
export type NativeJournalReader = Pick<
  EvmNativeOperationJournal,
  | 'binding'
  | 'list'
  | 'get'
  | 'sourceReferences'
  | 'referencesSpendIndex'
  | 'canSelect'
>
export type CanonicalJournalReader = Pick<
  LevelCanonicalStampAttemptJournal,
  | 'getIntents'
  | 'getAll'
  | 'lookupIntent'
  | 'lookup'
  | 'reconcile'
  | 'wasAcknowledged'
  | 'getPaymentObservations'
  | 'getImportedRecoveries'
  | 'importedRecovery'
  | 'retainedRecoveryCustody'
>
interface Owners {
  readonly binding?: EvmNativeBinding
  readonly native?: EvmNativeOperationJournal
  readonly canonical?: LevelCanonicalStampAttemptJournal
  readonly retained?: {
    getIntents(): CanonicalJournalIntent[]
    getAll(): CanonicalJournalAttempt[]
  }
  readonly canonicalBinding?: { readonly id: string; readonly tuple: string }
  readonly topic: TopicOperationJournal
  readonly pool: MonadSubAccountPool
  readonly change: MonadChangePool
  readonly leases: SubAccountLeaseManager
  assertLifetime(lifetime: WalletOperationLifetime): void
  validate(): void
}
interface Claim extends ProjectedObligation {
  readonly authorization: string
  /** Exact native inclusion evidence, used only to distinguish an older retained pair. */
  readonly observedConsumed: boolean
}
const internals = new WeakMap<EvmInputAdmission, AdmissionOwner>()
function address(value: string): string {
  return getAddress(value).toLowerCase()
}
function conflict(): never {
  throw new EvmInputAdmissionError('conflicting-authorization')
}
function invalid(): never {
  throw new EvmInputAdmissionError('invalid-provenance')
}
function overlap(a: EvmHeldResource, b: EvmHeldResource): boolean {
  if (a.kind === 'allocation' || b.kind === 'allocation')
    return (
      a.kind === 'allocation' &&
      b.kind === 'allocation' &&
      a.pool === b.pool &&
      a.index === b.index
    )
  return (
    a.address === b.address &&
    (a.kind === 'address' || b.kind === 'address' || a.nonce === b.nonce)
  )
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) frozen(entry)
    Object.freeze(value)
  }
  return value
}

/** Fixed owner composition, not a registration mechanism or another persisted claim table. */
class AdmissionOwner implements EvmInputAdmission {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly epochs = new WeakMap<
    AdmissionEpoch,
    WalletOperationLifetime
  >()
  private revision = 0
  private uncertain = false
  private invokingMutation = false
  constructor(readonly owners: Owners) {
    internals.set(this, this)
  }
  private assertLifetime(lifetime: WalletOperationLifetime): void {
    this.owners.assertLifetime(lifetime)
  }
  private tx(bytes: string, sender?: string): ValidatedFrozenTransaction {
    const tx = Transaction.from(bytes)
    const binding = this.owners.binding
    if (
      !binding ||
      tx.chainId.toString() !== binding.nativeChainId ||
      !Number.isSafeInteger(tx.nonce) ||
      tx.nonce < 0
    )
      invalid()
    const from = tx.from ?? sender
    if (!from || (sender && address(from) !== address(sender))) invalid()
    return {
      unsignedSerialized: tx.unsignedSerialized,
      sender: address(from),
      nonce: tx.nonce,
      nativeChainId: tx.chainId.toString(),
      transactionHash: tx.hash,
    }
  }
  project(): Claim[] {
    const o = this.owners,
      binding = o.binding
    if (!binding || !o.native) throw new EvmInputAdmissionError('not-ready')
    if (this.uncertain) throw new EvmInputAdmissionError('uncertain-owner')
    const chain = PROTOCOL_CHAINS[binding.chainIdentifier]
    if (
      !chain ||
      chain.family !== 'evm' ||
      String(chain.nativeChainId) !== binding.nativeChainId ||
      JSON.stringify(o.native.binding) !== JSON.stringify(binding)
    )
      invalid()
    o.validate()
    const claims: Claim[] = []
    const add = (
      provenance: OwnerEvidence,
      authorization: string,
      bytes: string | null,
      sender?: string,
      extra: EvmHeldResource[] = [],
      observedConsumed = false,
    ) => {
      const transaction = bytes === null ? null : this.tx(bytes, sender)
      const resources: EvmHeldResource[] = transaction
        ? [
            {
              kind: 'pair',
              address: transaction.sender,
              nonce: transaction.nonce,
            },
            ...extra,
          ]
        : extra
      claims.push({
        provenance,
        authorization,
        binding,
        transaction,
        resources,
        observedConsumed,
      })
    }
    for (const row of o.native.list()) {
      if (row.cancelled) continue
      row.members.forEach((m, index) => {
        const unresolved = m.dependencies.length
          ? m.observation.state !== 'included-success'
          : m.observation.state !== 'included-success' &&
            m.observation.state !== 'included-revert'
        add(
          {
            kind: 'native',
            operationId: row.operationId,
            member: index,
            source: m.source,
          },
          `native:${row.operationId}`,
          m.signed?.rawTransaction ?? m.unsignedTransaction,
          m.source.address,
          unresolved ? [{ kind: 'address', address: m.source.address }] : [],
          m.observation.state === 'included-success' ||
            m.observation.state === 'included-revert',
        )
      })
    }
    const retained = o.retained ?? o.canonical
    const canonicalBinding = (prepared: CanonicalJournalIntent['prepared']) => {
      if (
        prepared.network !== binding.chainIdentifier ||
        prepared.chainId !== binding.nativeChainId
      )
        invalid()
      // A foreign canonical identity sharing this persisted economic pool protects only; it cannot sign.
      const economic = JSON.parse(binding.publicTuple) as {
        mainAddress?: string
      }
      if (
        !economic.mainAddress ||
        address(prepared.accountId) !== address(economic.mainAddress)
      )
        invalid()
    }
    for (const row of retained?.getIntents() ?? []) {
      canonicalBinding(row.prepared)
      row.members.forEach((m, member) => {
        const record = o.pool.getRecord(m.reservation.index)
        if (!record || address(record.address) !== address(m.from)) invalid()
        add(
          {
            kind: 'canonical-intent',
            attemptRef: row.attemptRef,
            member,
            poolIndex: m.reservation.index,
          },
          `canonical:${row.prepared.walletBindingId}:${row.attemptRef}`,
          m.rawTx ?? m.unsignedSerialized,
          m.from,
          [{ kind: 'allocation', pool: 'spend', index: m.reservation.index }],
        )
      })
    }
    for (const row of retained?.getAll() ?? []) {
      canonicalBinding(row.prepared)
      if (row.request.parts.transactions.length !== row.reservations.length)
        invalid()
      row.request.parts.transactions.forEach((raw, member) => {
        const index = row.reservations[member]!.index
        const record =
          o.pool.getRecord(index) ??
          o.pool.terminalCheckpoints().find(r => r.index === index)
        if (!record) invalid()
        add(
          {
            kind: 'canonical-attempt',
            attemptRef: row.attemptRef,
            member,
            poolIndex: index,
          },
          `canonical:${row.prepared.walletBindingId}:${row.attemptRef}`,
          hexlify(raw),
          record.address,
          row.cleanupComplete
            ? []
            : [{ kind: 'allocation', pool: 'spend', index }],
        )
      })
    }
    for (const row of o.topic.getAll()) {
      const record =
        o.pool.getRecord(row.leaseIndex) ??
        o.pool.terminalCheckpoints().find(r => r.index === row.leaseIndex)
      if (!record || address(record.address) !== address(row.senderAddress))
        invalid()
      const key = topicOperationKey(row)
      const tx = this.tx(row.rawTx, row.senderAddress)
      if (tx.transactionHash !== row.txHash.toLowerCase()) invalid()
      add(
        { kind: 'topic', operationKey: key, poolIndex: row.leaseIndex },
        `topic:${key}`,
        row.rawTx,
        row.senderAddress,
        [{ kind: 'allocation', pool: 'spend', index: row.leaseIndex }],
      )
    }
    const poolAuthorities = new Map<number, Claim[]>()
    for (const claim of claims) {
      const evidence = claim.provenance
      const index =
        evidence.kind === 'native'
          ? evidence.source.kind === 'spend'
            ? evidence.source.index
            : undefined
          : evidence.kind === 'canonical-intent' ||
            evidence.kind === 'canonical-attempt' ||
            evidence.kind === 'topic'
          ? evidence.poolIndex
          : undefined
      if (index !== undefined) {
        const rows = poolAuthorities.get(index) ?? []
        rows.push(claim)
        poolAuthorities.set(index, rows)
      }
    }
    const checkpoint = (
      index: number,
      role: 'funding' | 'spend',
      raw: string,
      hash: string,
      from?: string,
    ) => {
      const tx = this.tx(raw, from)
      if (tx.transactionHash !== hash.toLowerCase()) invalid()
      let authorization = `pool:${index}:${role}`
      let observedConsumed = false
      if (role === 'spend') {
        const related = (poolAuthorities.get(index) ?? []).filter(
          c =>
            (c.provenance.kind === 'native' &&
              c.transaction?.sender === tx.sender &&
              c.transaction.nonce === tx.nonce) ||
            c.provenance.kind === 'canonical-attempt' ||
            c.provenance.kind === 'topic',
        )
        const identical = related.filter(
          c =>
            c.transaction?.transactionHash === tx.transactionHash &&
            c.transaction.unsignedSerialized === tx.unsignedSerialized,
        )
        if (related.length && identical.length !== related.length) conflict()
        if (identical.length === 1) {
          authorization = identical[0]!.authorization
          observedConsumed = identical[0]!.observedConsumed
        }
      }
      add(
        { kind: 'pool-retained', poolIndex: index, role },
        authorization,
        raw,
        from,
        [],
        observedConsumed,
      )
    }
    const records = o.pool.records()
    for (const row of [...records, ...o.pool.terminalCheckpoints()]) {
      if ('fundingAttempt' in row && row.fundingAttempt) {
        const tx = this.tx(row.fundingAttempt.rawTx)
        if (tx.transactionHash !== row.fundingAttempt.txHash.toLowerCase())
          invalid()
        add(
          { kind: 'pool-funding', poolIndex: row.index, role: 'funding' },
          `pool:${row.index}:funding`,
          row.fundingAttempt.rawTx,
          undefined,
          [
            { kind: 'address', address: address(row.address) },
            { kind: 'allocation', pool: 'spend', index: row.index },
          ],
        )
      }
      const lifecycle = row.lifecycle
      if (lifecycle?.funding)
        checkpoint(
          row.index,
          'funding',
          lifecycle.funding.rawTx,
          lifecycle.funding.txHash,
        )
      if (lifecycle?.spend)
        checkpoint(
          row.index,
          'spend',
          lifecycle.spend.rawTx,
          lifecycle.spend.txHash,
          row.address,
        )
      const hasOwner = poolAuthorities.has(row.index)
      if (
        (row.status === 'in-use' && !hasOwner) ||
        ((row.status === 'spent' || row.status === 'retired') &&
          !lifecycle?.spend)
      )
        add(
          { kind: 'pool-retained', poolIndex: row.index, role: 'hold' },
          `pool:${row.index}:hold`,
          null,
          undefined,
          [
            { kind: 'address', address: address(row.address) },
            { kind: 'allocation', pool: 'spend', index: row.index },
          ],
        )
    }
    const change = o.change.pendingIntent()
    for (const row of [...o.change.records(), ...(change ? [change] : [])]) {
      const tx = this.tx(row.rawTx, row.sourceBurnAddress)
      if (tx.transactionHash !== row.txHash.toLowerCase()) invalid()
      const pending = row === change
      add(
        { kind: 'change-sweep', changeIndex: row.index, pending },
        `change:${row.index}`,
        row.rawTx,
        row.sourceBurnAddress,
        pending
          ? [
              { kind: 'allocation', pool: 'change', index: row.index },
              { kind: 'address', address: address(row.address) },
            ]
          : [],
      )
    }
    const pairs = new Map<string, Claim>()
    const allocations = new Map<string, string>()
    const addresses = new Map<string, Set<Claim>>()
    const addressHolds = new Map<string, Claim>()
    // A new pending nonce does not retrospectively conflict with an exact earlier observed
    // pair. This never removes that pair, ignores a dependency hold, or grants eligibility.
    const olderObservedPair = (prior: Claim, holder: Claim) =>
      prior.observedConsumed &&
      prior.transaction !== null &&
      holder.transaction !== null &&
      prior.transaction.sender === holder.transaction.sender &&
      prior.transaction.nonce < holder.transaction.nonce
    for (const claim of claims)
      for (const resource of claim.resources) {
        if (resource.kind === 'allocation') {
          const key = `${resource.pool}:${resource.index}`,
            prior = allocations.get(key)
          if (prior !== undefined && prior !== claim.authorization) conflict()
          allocations.set(key, claim.authorization)
          continue
        }
        const held = addressHolds.get(resource.address)
        if (
          held !== undefined &&
          held.authorization !== claim.authorization &&
          !(resource.kind === 'pair' && olderObservedPair(claim, held))
        )
          conflict()
        const owners = addresses.get(resource.address) ?? new Set<Claim>()
        if (resource.kind === 'address') {
          if (
            [...owners].some(
              value =>
                value.authorization !== claim.authorization &&
                !olderObservedPair(value, claim),
            )
          )
            conflict()
          addressHolds.set(resource.address, claim)
        } else {
          const key = `${resource.address}:${resource.nonce}`,
            prior = pairs.get(key)
          if (prior) {
            if (prior.authorization !== claim.authorization) conflict()
            if (
              prior.transaction &&
              claim.transaction &&
              (prior.transaction.unsignedSerialized !==
                claim.transaction.unsignedSerialized ||
                (prior.transaction.transactionHash &&
                  claim.transaction.transactionHash &&
                  prior.transaction.transactionHash !==
                    claim.transaction.transactionHash))
            )
              conflict()
          }
          pairs.set(key, claim)
        }
        owners.add(claim)
        addresses.set(resource.address, owners)
      }
    return claims
  }
  inspect(lifetime: WalletOperationLifetime): AdmissionSnapshot {
    this.assertLifetime(lifetime)
    try {
      const obligations = this.project().map(
        ({
          authorization: _authorization,
          observedConsumed: _observed,
          ...claim
        }) => claim,
      )
      const epoch = Object.freeze({ revision: this.revision })
      this.epochs.set(epoch, lifetime)
      return frozen({ status: 'ready', epoch, obligations })
    } catch (error) {
      return Object.freeze({
        status: 'unavailable',
        reason:
          error instanceof EvmInputAdmissionError
            ? error.reason === 'stale-epoch' ||
              error.reason === 'foreign-lifetime' ||
              error.reason === 'reentrant-mutation'
              ? 'invalid-provenance'
              : error.reason
            : (error instanceof EvmNativeJournalError &&
                error.code === 'uncertain') ||
              (error instanceof CanonicalAttemptJournalError &&
                error.code === 'corrupt')
            ? 'uncertain-owner'
            : 'invalid-provenance',
        held: 'binding',
      })
    }
  }
  private checkEpoch(
    epoch: AdmissionEpoch,
    lifetime: WalletOperationLifetime,
  ): void {
    if (this.epochs.get(epoch) !== lifetime)
      throw new EvmInputAdmissionError('stale-epoch')
    // Epoch is provenance, not permission: every candidate is rechecked against current owners.
  }
  private check(resources: readonly EvmHeldResource[], own?: string): void {
    for (const c of this.project())
      if (
        c.authorization !== own &&
        resources.some(r => c.resources.some(held => overlap(r, held)))
      )
        conflict()
  }
  private nativeResources(plan: EvmNativePlan): EvmHeldResource[] {
    return plan.members.map(m => ({
      kind: 'pair',
      address: address(m.source.address),
      nonce: this.tx(m.unsignedTransaction, m.source.address).nonce,
    }))
  }
  private canonicalResources(intent: CanonicalPrepareInput): EvmHeldResource[] {
    if (
      !this.owners.canonical ||
      !this.owners.canonicalBinding ||
      intent.prepared.walletBindingId !== this.owners.canonicalBinding.id ||
      intent.prepared.network !== this.owners.binding?.chainIdentifier ||
      intent.prepared.chainId !== this.owners.binding.nativeChainId
    )
      invalid()
    return intent.members.flatMap(m => {
      const record = this.owners.pool.getRecord(m.reservation.index)
      if (
        !record ||
        address(record.address) !== address(m.from) ||
        (record.status !== 'available' && record.status !== 'in-use')
      )
        invalid()
      return [
        {
          kind: 'pair' as const,
          address: address(m.from),
          nonce: this.tx(m.unsignedSerialized, m.from).nonce,
        },
        {
          kind: 'allocation' as const,
          pool: 'spend' as const,
          index: m.reservation.index,
        },
      ]
    })
  }
  /** Only fixed owner methods invoke this; no consumer callback runs while it is held. */
  mutate<T>(
    lifetime: WalletOperationLifetime,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertLifetime(lifetime)
    if (this.invokingMutation)
      throw new EvmInputAdmissionError('reentrant-mutation')
    const run = this.tail.then(async () => {
      this.assertLifetime(lifetime)
      if (this.uncertain) throw new EvmInputAdmissionError('uncertain-owner')
      try {
        let pending: Promise<T>
        this.invokingMutation = true
        try {
          pending = operation()
        } finally {
          this.invokingMutation = false
        }
        const result = await pending
        this.revision++
        return result
      } catch (error) {
        // Invalid candidates do not poison a healthy owner. Journals themselves distinguish a
        // rejected input from an uncertain durable write and refuse reads in the latter state.
        try {
          this.owners.native?.list()
          this.owners.canonical?.getAll()
        } catch {
          this.uncertain = true
        }
        throw error
      }
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  prepareNative(
    lifetime: WalletOperationLifetime,
    epoch: AdmissionEpoch,
    plan: EvmNativePlan,
  ): Promise<EvmNativeOperation> {
    const snapshot = JSON.parse(JSON.stringify(plan)) as EvmNativePlan
    return this.mutate(lifetime, async () => {
      this.checkEpoch(epoch, lifetime)
      this.check(this.nativeResources(snapshot))
      // Owned HD accounts can receive funds without a pool allocation row. The native
      // executor verifies current account state and custody; any existing row must agree.
      for (const { source } of snapshot.members) {
        if (source.kind === 'spend') {
          const record =
            this.owners.pool.getRecord(source.index) ??
            this.owners.pool
              .terminalCheckpoints()
              .find(r => r.index === source.index)
          if (
            record &&
            (record.address.toLowerCase() !== source.address ||
              record.status === 'funding')
          )
            invalid()
        }
        if (source.kind === 'change') {
          const record =
            this.owners.change.getRecord(source.index) ??
            this.owners.change
              .recoveredAccounts()
              .find(r => r.index === source.index)
          if (record && record.address.toLowerCase() !== source.address)
            invalid()
        }
      }
      return this.owners.native!.prepare(snapshot)
    })
  }
  prepareCanonical(
    lifetime: WalletOperationLifetime,
    epoch: AdmissionEpoch,
    intent: CanonicalPrepareInput,
  ): Promise<CanonicalJournalIntent> {
    const snapshot = {
      ...intent,
      prepared: {
        ...intent.prepared,
        payload: new Uint8Array(intent.prepared.payload),
        context: new Uint8Array(intent.prepared.context),
        economicBinding: new Uint8Array(intent.prepared.economicBinding),
      },
      construction: new Uint8Array(intent.construction),
      members: intent.members.map(m => ({
        ...m,
        reservation: { ...m.reservation },
      })),
    }
    return this.mutate(lifetime, async () => {
      this.checkEpoch(epoch, lifetime)
      this.check(this.canonicalResources(snapshot))
      return this.owners.canonical!.prepareIntent(snapshot)
    })
  }
  faultUncertain(): void {
    this.uncertain = true
  }
  checkNative(id: string): EvmNativeOperation {
    const row = this.owners.native!.get(id)
    if (row.cancelled) conflict()
    this.check(this.nativeResources(row), `native:${id}`)
    return row
  }
  checkCanonical(ref: string): CanonicalJournalIntent {
    const row = this.owners.canonical
      ?.getIntents()
      .find(r => r.attemptRef === ref)
    if (!row) invalid()
    this.check(
      this.canonicalResources(row),
      `canonical:${row.prepared.walletBindingId}:${ref}`,
    )
    return row
  }
  authorizeNativeSigning(
    lifetime: WalletOperationLifetime,
    id: string,
  ): Promise<EvmNativeOperation> {
    return this.mutate(lifetime, async () => {
      return this.checkNative(id)
    })
  }
  authorizeCanonicalSigning(
    lifetime: WalletOperationLifetime,
    ref: string,
  ): Promise<CanonicalJournalIntent> {
    return this.mutate(lifetime, async () => {
      return this.checkCanonical(ref)
    })
  }
}
export function createEvmInputAdmission(owners: Owners): EvmInputAdmission {
  const owner = new AdmissionOwner(
    Object.freeze({
      ...owners,
      binding: owners.binding
        ? Object.freeze({ ...owners.binding })
        : undefined,
    }),
  )
  const api: EvmInputAdmission = Object.freeze({
    inspect: owner.inspect.bind(owner),
    prepareNative: owner.prepareNative.bind(owner),
    prepareCanonical: owner.prepareCanonical.bind(owner),
    authorizeNativeSigning: owner.authorizeNativeSigning.bind(owner),
    authorizeCanonicalSigning: owner.authorizeCanonicalSigning.bind(owner),
  })
  internals.set(api, owner)
  return api
}

function ownerOf(admission: EvmInputAdmission): AdmissionOwner {
  const owner = internals.get(admission)
  if (!owner) throw new EvmInputAdmissionError('foreign-lifetime')
  return owner
}
export function nativeJournalReader(
  journal: EvmNativeOperationJournal,
): NativeJournalReader {
  return Object.freeze({
    binding: Object.freeze({ ...journal.binding }),
    list: () => journal.list(),
    get: id => journal.get(id),
    sourceReferences: () => journal.sourceReferences(),
    referencesSpendIndex: index => journal.referencesSpendIndex(index),
    canSelect: (source, nonce) => journal.canSelect(source, nonce),
  } satisfies NativeJournalReader)
}
export function canonicalJournalReader(
  journal: LevelCanonicalStampAttemptJournal,
): CanonicalJournalReader {
  return Object.freeze({
    getIntents: () => journal.getIntents(),
    getAll: () => journal.getAll(),
    lookupIntent: prepared => journal.lookupIntent(prepared),
    lookup: prepared => journal.lookup(prepared),
    reconcile: (...args) => journal.reconcile(...args),
    wasAcknowledged: ref => journal.wasAcknowledged(ref),
    getPaymentObservations: ref => journal.getPaymentObservations(ref),
    getImportedRecoveries: () => journal.getImportedRecoveries(),
    importedRecovery: id => journal.importedRecovery(id),
    retainedRecoveryCustody: id => journal.retainedRecoveryCustody(id),
  } satisfies CanonicalJournalReader)
}
export type NativeExecutionJournal = NativeJournalReader &
  Pick<
    EvmNativeOperationJournal,
    | 'prepare'
    | 'checkpointSigned'
    | 'markExposed'
    | 'markSyncApplied'
    | 'cancelUnsigned'
    | 'beginCapture'
    | 'recordObservation'
  >
/** Internal executor capability. Every completion rechecks the captured lifetime; no raw owner escapes. */
export function nativeAdmissionJournal(
  admission: EvmInputAdmission,
  lifetime: WalletOperationLifetime,
): NativeExecutionJournal {
  const owner = ownerOf(admission),
    journal = owner.owners.native
  if (!journal) throw new EvmInputAdmissionError('not-ready')
  owner.owners.assertLifetime(lifetime)
  const mutation = <T>(operation: () => Promise<T>) =>
    owner.mutate(lifetime, operation)
  return {
    ...nativeJournalReader(journal),
    prepare: plan => {
      const snapshot = admission.inspect(lifetime)
      if (snapshot.status !== 'ready')
        return Promise.reject(new EvmInputAdmissionError(snapshot.reason))
      return admission.prepareNative(lifetime, snapshot.epoch, plan)
    },
    checkpointSigned: (id, index, raw) =>
      mutation(async () => {
        owner.checkNative(id)
        return journal.checkpointSigned(id, index, raw)
      }),
    markExposed: (id, index) =>
      mutation(async () => {
        owner.checkNative(id)
        return journal.markExposed(id, index)
      }),
    markSyncApplied: (id, index) =>
      mutation(() => journal.markSyncApplied(id, index)),
    cancelUnsigned: id => mutation(() => journal.cancelUnsigned(id)),
    beginCapture: (id, index) => {
      owner.owners.assertLifetime(lifetime)
      return journal.beginCapture(id, index)
    },
    recordObservation: (...args) =>
      mutation(() => journal.recordObservation(...args)),
  }
}
export type CanonicalExecutionJournal = CanonicalJournalReader &
  Pick<
    LevelCanonicalStampAttemptJournal,
    | 'checkpointSignedMember'
    | 'promoteIntent'
    | 'beginReplay'
    | 'endReplay'
    | 'recordTerminal'
    | 'completeCleanup'
    | 'acknowledge'
    | 'beginObservation'
    | 'recordObservations'
    | 'importRecovery'
    | 'markRecoveryAcknowledged'
  >
/** Internal canonical capability; prepare remains exclusively on the fixed admission API. */
export function canonicalAdmissionJournal(
  admission: EvmInputAdmission,
  lifetime: WalletOperationLifetime,
): CanonicalExecutionJournal {
  const owner = ownerOf(admission),
    journal = owner.owners.canonical
  if (!journal) throw new EvmInputAdmissionError('not-ready')
  owner.owners.assertLifetime(lifetime)
  const mutation = <T>(operation: () => Promise<T>) =>
    owner.mutate(lifetime, operation)
  return {
    ...canonicalJournalReader(journal),
    checkpointSignedMember: (ref, index, raw) =>
      mutation(() => {
        owner.checkCanonical(ref)
        return journal.checkpointSignedMember(ref, index, raw)
      }),
    promoteIntent: (ref, request) =>
      mutation(() => {
        owner.checkCanonical(ref)
        return journal.promoteIntent(ref, request)
      }),
    beginReplay: eligibility =>
      mutation(() => journal.beginReplay(eligibility)),
    endReplay: eligibility => {
      owner.owners.assertLifetime(lifetime)
      journal.endReplay(eligibility)
    },
    recordTerminal: (ref, terminal) =>
      mutation(() => journal.recordTerminal(ref, terminal)),
    completeCleanup: ref => mutation(() => journal.completeCleanup(ref)),
    acknowledge: (ref, consumer) =>
      mutation(() => journal.acknowledge(ref, consumer)),
    beginObservation: ref => mutation(() => journal.beginObservation(ref)),
    recordObservations: (...args) =>
      mutation(() => journal.recordObservations(...args)),
    importRecovery: input => mutation(() => journal.importRecovery(input)),
    markRecoveryAcknowledged: id =>
      mutation(() => journal.markRecoveryAcknowledged(id)),
  }
}

/** Fixed lease transitions only. In particular this cannot run a signing/network/workflow callback. */
export function canonicalAdmissionPool(
  admission: EvmInputAdmission,
  lifetime: WalletOperationLifetime,
) {
  const owner = ownerOf(admission),
    { pool, leases } = owner.owners
  const flush = async () => {
    try {
      await pool.flush()
    } catch (error) {
      owner.faultUncertain()
      throw error
    }
  }
  return {
    acquire: (index: number) =>
      owner.mutate(lifetime, async () => {
        const handle = leases.acquireForIndex(index)
        await flush()
        return handle
      }),
    recordSpend: (
      index: number,
      checkpoint: Parameters<MonadSubAccountPool['recordSpendTransaction']>[1],
    ) =>
      owner.mutate(lifetime, async () => {
        pool.recordSpendTransaction(index, checkpoint)
        await flush()
      }),
    release: async (
      handle: Parameters<SubAccountLeaseManager['releaseLease']>[0],
      outcome: Parameters<SubAccountLeaseManager['releaseLease']>[1],
    ) => {
      await owner.mutate(lifetime, async () => {
        leases.releaseLease(handle, outcome, false)
        await flush()
      })
      owner.owners.assertLifetime(lifetime)
      if (outcome !== 'unused') pool.triggerProactiveWarming()
    },
    setStatus: async (
      index: number,
      status: Parameters<MonadSubAccountPool['setStatus']>[1],
    ) => {
      await owner.mutate(lifetime, async () => {
        pool.setStatus(index, status, false)
        await flush()
      })
      owner.owners.assertLifetime(lifetime)
      if (status === 'spent' || status === 'retired')
        pool.triggerProactiveWarming()
    },
  }
}

/** All fact owners must be readable before publication; contradictory preserved records hold signing. */
export function validateEvmInputAdmission(admission: EvmInputAdmission): void {
  try {
    ownerOf(admission).project()
  } catch (error) {
    if (
      !(error instanceof EvmInputAdmissionError) ||
      error.reason !== 'conflicting-authorization'
    )
      throw error
  }
}
