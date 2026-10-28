/** Node effects for a durable transaction set. The preparer remains the state owner. */
import { Transaction } from 'ethers'
import type { Provider } from 'ethers'
import type {
  EvmNativeAccountObservation,
  EvmNativeMember,
  EvmNativeObservation,
  EvmNativeOperation,
} from './storage/evm-native-operation-journal'
import { memberSignings, nativeMemberAbandoned, nativeMemberEnded, nativeMemberNeedsOwnMoveRecovery, nativeMemberSuperseded } from './storage/evm-native-operation-journal'
import { EVM_FAILURE_CONFIRMATIONS } from './chain/evm-settlement'
import { RefusalLedger } from './chain/evm-refused-resign'

export interface EvmTransactionSetAuthority {
  getOperation(id: string): EvmNativeOperation | undefined
  readOperation(id: string): Promise<EvmNativeOperation | undefined>
  markExposed(id: string, memberIndex: number): Promise<void>
  recordObservation(
    id: string,
    memberIndex: number,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
    expectedMember?: EvmNativeMember,
  ): Promise<unknown>
  /**
   * Signs member `memberIndex` again at its nonce because the node keeps refusing its bytes
   * (`chain/evm-refused-resign.ts`) and records the new signing durably. False, and nothing
   * changes, when this operation's members are not signed again (only Send to Address is).
   */
  resignRefused?(id: string, memberIndex: number): Promise<boolean>
}
type ReplayProvider = Pick<Provider, 'getTransaction' | 'broadcastTransaction'>
interface MemberMetadata {
  transactionSet?: {
    role: 'payment' | 'change' | 'funding'
    stageId?: string
    fundingWaitBlocks?: number
    predecessorWaitBlocks?: number
  }
}

/**
 * The block by which the chain shows a same-account predecessor's nonce consumed, which is what
 * the member at the next nonce waits for: the block that included it, or, when the node no
 * longer knows the predecessor and the account's nonce is already past it
 * (`nativeMemberSuperseded`: mined on a node that has since dropped it from its history, or
 * replaced), the block of that look (the nonce was consumed at or before it). Undefined while the
 * chain shows neither.
 */
export function predecessorConsumedAt(prior: EvmNativeMember): number | undefined {
  const observation = prior.observation
  if (observation.state === 'included-success' || observation.state === 'included-revert')
    return observation.blockNumber
  return nativeMemberSuperseded(prior) ? prior.account!.blockNumber : undefined
}

export class EvmTransactionSetLifecycle {
  /** What the node said to each member's bytes this process: when one may be signed again. */
  private readonly refusals = new RefusalLedger()
  constructor(
    private readonly options: {
      authority: EvmTransactionSetAuthority
      provider: ReplayProvider
      head: () => number
    },
  ) {}

  private validateOperation(row: EvmNativeOperation | undefined): EvmNativeOperation {
    if (!row || row.cancelled) throw new Error('Unknown active transaction set')
    if (
      row.members.some(
        (member) =>
          !member.signed ||
          !(member as EvmNativeMember & MemberMetadata).transactionSet,
      )
    )
      throw new Error('Incomplete durable transaction set')
    return row
  }

  private ready(row: EvmNativeOperation, index: number): boolean {
    const member = row.members[index]!, meta = member.transactionSet!
    return member.dependencies.every(dependency => {
      const prior = row.members[dependency]!, observation = prior.observation
      // Given up: nothing that stands on it is handed out.
      if (nativeMemberAbandoned(prior)) return false
      const funding = prior.source.address !== member.source.address
      if (funding) return observation.state === 'included-success' && this.options.head() >= observation.blockNumber + (meta.fundingWaitBlocks ?? 0)
      if (meta.predecessorWaitBlocks !== undefined) {
        const consumed = predecessorConsumedAt(prior)
        return consumed !== undefined && this.options.head() >= consumed + meta.predecessorWaitBlocks
      }
      return prior.exposed || observation.state === 'included-success' || observation.state === 'included-revert'
    })
  }

  /** Cached readiness only. Relays must not receive a payment whose funding is still private. */
  canSubmitPayments(id: string, stageId?: string): boolean {
    const row = this.validateOperation(this.options.authority.getOperation(id))
    const indexes = row.members.flatMap((member, index) => member.transactionSet!.role === 'payment' && member.transactionSet!.stageId === stageId ? [index] : [])
    return indexes.length > 0 && indexes.every(index => !nativeMemberEnded(row.members[index]!) && row.members[index]!.observation.state !== 'included-revert' && this.ready(row, index))
  }

  /** Historical readiness is available without reactivating archived inventory. */
  async readCanSubmitPayments(id: string, stageId?: string): Promise<boolean> {
    const row = this.validateOperation(await this.options.authority.readOperation(id))
    const indexes = row.members.flatMap((member, index) => member.transactionSet!.role === 'payment' && member.transactionSet!.stageId === stageId ? [index] : [])
    return indexes.length > 0 && indexes.every(index => !nativeMemberEnded(row.members[index]!) && row.members[index]!.observation.state !== 'included-revert' && this.ready(row, index))
  }

  /** Called only after the complete encrypted message and signed graph are durable. */
  async replayDependencies(id: string, stageId?: string): Promise<void> {
    const row = this.validateOperation(await this.options.authority.readOperation(id)), selected = new Set<number>()
    const visit = (index: number) => {
      if (selected.has(index)) return
      selected.add(index)
      for (const dependency of row.members[index]!.dependencies) visit(dependency)
    }
    const targets = row.members.flatMap((member, index) => member.transactionSet!.role === 'payment' && member.transactionSet!.stageId === stageId ? [index] : [])
    if (!targets.length) throw new Error('Unknown transaction-set stage')
    for (const index of targets) for (const dependency of row.members[index]!.dependencies) visit(dependency)
    await this.replayMembers(id, selected)
  }

  /** Existing standalone consumers may withhold recipient transactions until acceptance. */
  async replay(id: string, input: { payments: boolean }): Promise<void> {
    const row = this.validateOperation(await this.options.authority.readOperation(id))
    await this.replayMembers(id, new Set(row.members.flatMap((member, index) => input.payments || member.transactionSet!.role !== 'payment' ? [index] : [])))
  }

  private async replayMembers(id: string, selected: Set<number>): Promise<void> {
    // Member order is a validated topological order. Independent sources still proceed when
    // one source is awaiting inclusion; no network wait owns a wallet-wide reservation lock.
    const failures: unknown[] = []
    for (const index of [...selected].sort((a,b) => a-b)) {
      const row = this.validateOperation(await this.options.authority.readOperation(id)), member = row.members[index]!
      if (member.observation.state === 'included-success' || member.observation.state === 'included-revert' || nativeMemberEnded(member) || !this.ready(row, index)) continue
      try {
        // Only a member that has left the wallet can already be on a node; one never exposed is
        // marked exposed (durably, before its bytes leave) and broadcast without asking first.
        if (member.exposed) {
          if (await this.knownOn(member, this.options.provider)) continue
        } else await this.options.authority.markExposed(id, index)
        const refusal = await this.hand(member.signed!)
        if (refusal === undefined) continue
        // The node keeps refusing these bytes: the same member is signed again at its nonce,
        // recorded durably, and the new bytes are handed over instead. The old ones are still
        // looked for (`observe`) until one of them lands.
        if (
          !this.options.authority.resignRefused ||
          !this.refusals.due(member.signed!.rawTransaction, memberSignings(member).length) ||
          !(await this.options.authority.resignRefused(id, index))
        )
          throw refusal
        const again = (await this.options.authority.readOperation(id))!.members[index]!.signed!
        console.warn(
          `[evm-transaction-set] the node kept refusing ${member.signed!.transactionHash}; the same transaction is signed again at its nonce as ${again.transactionHash}`,
        )
        const refused = await this.hand(again)
        if (refused !== undefined) throw refused
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw failures[0]
  }

  /** Hands `signing` to the node. Undefined when the node has it; else what the node said. */
  private async hand(signing: { rawTransaction: string; transactionHash: string }): Promise<unknown> {
    try {
      const response = await this.options.provider.broadcastTransaction(signing.rawTransaction)
      if (response.hash.toLowerCase() !== signing.transactionHash.toLowerCase()) throw new Error('Unexpected transaction-set broadcast hash')
      this.refusals.note(signing.rawTransaction)
      return undefined
    } catch (error) {
      const alreadyKnown = error instanceof Error && /already known|known transaction/i.test(error.message)
      if (alreadyKnown || (await this.options.provider.getTransaction(signing.transactionHash))) {
        this.refusals.note(signing.rawTransaction)
        return undefined
      }
      this.refusals.note(signing.rawTransaction, error)
      return error
    }
  }

  /** Whether the node holds any signing of `member` (a node need not serve pending ones). */
  private async knownOn(member: EvmNativeMember, provider: Pick<Provider, 'getTransaction'>): Promise<boolean> {
    for (const signing of memberSignings(member))
      if (await provider.getTransaction(signing.transactionHash)) return true
    return false
  }

  /** The receipt of whichever signing of `member` the chain included, if any. */
  private async receiptOf(member: EvmNativeMember, provider: Provider) {
    for (const signing of memberSignings(member)) {
      const receipt = await provider.getTransactionReceipt(signing.transactionHash)
      if (receipt) return { receipt, signing }
    }
    return undefined
  }

  /** Read one canonical block's account state; never update inventory from relay answers. */
  async observe(id: string, provider: Provider): Promise<void> {
    const row = this.validateOperation(await this.options.authority.readOperation(id))
    for (let index = 0; index < row.members.length; index++) {
      const member = row.members[index]!,
        signed = member.signed!
      // Terminal history must never be fed through inventory observation again.
      if (!this.options.authority.getOperation(id) && member.transactionSet?.inventoryApplied && (member.observation.state === 'included-success' || member.observation.state === 'included-revert' || nativeMemberEnded(member))) continue
      const found = await this.receiptOf(member, provider)
      // The durable abandonment may have committed just before interruption of its inventory
      // projection. Resume that same evidence under the exact-member CAS; never invent a new
      // chain observation or broadcast. A newly discovered actual receipt takes precedence.
      if (nativeMemberAbandoned(member) && !nativeMemberNeedsOwnMoveRecovery(member) && !found) {
        if (!member.transactionSet?.inventoryApplied)
          await this.options.authority.recordObservation(id, index, member.observation, member.account, member)
        continue
      }
      const receipt = found?.receipt ?? null
      const block = await provider.getBlock(receipt?.blockNumber ?? 'latest')
      if (!block?.hash)
        throw new Error(
          'Transaction-set observation requires a canonical block',
        )
      if (
        receipt &&
        (receipt.blockHash !== block.hash ||
          receipt.hash.toLowerCase() !== found!.signing.transactionHash.toLowerCase())
      )
        throw new Error('Transaction-set receipt is not canonical')
      if (
        receipt?.status === 0 &&
        (await provider.getBlockNumber()) - receipt.blockNumber + 1 <
          EVM_FAILURE_CONFIRMATIONS
      )
        continue
      const [nonce, balance] = await Promise.all([
        provider.getTransactionCount(member.source.address, block.number),
        provider.getBalance(member.source.address, block.number),
      ])
      const account = {
        blockHash: block.hash,
        blockNumber: block.number,
        nonce,
        balanceWei: balance.toString(),
      }
      if (
        !receipt &&
        nonce > Transaction.from(signed.rawTransaction).nonce &&
        (await this.receiptOf(member, provider))
      )
        continue
      // A member whose bytes have not left the wallet cannot be on any node. With no receipt and
      // its nonce still free there is nothing to record: it is not missing, it is not yet sent
      // (a submission's look before its first replay would otherwise record every member of a
      // fresh set missing, although they all land moments later). A consumed nonce is still
      // recorded, as evidence the member can never land.
      if (
        !receipt &&
        !member.exposed &&
        nonce <= Transaction.from(signed.rawTransaction).nonce
      )
        continue
      // Already recorded superseded and still no receipt: keep the first look that showed the
      // nonce consumed. Its block bounds when the nonce was taken, which is what the member at
      // the next nonce waits on (`predecessorConsumedAt`); a fresh look each pass would move
      // that bound forward with the head, and the member after it would wait for ever.
      if (
        !receipt &&
        nativeMemberSuperseded(member) &&
        nonce > Transaction.from(signed.rawTransaction).nonce
      ) {
        // Chain-terminal evidence can precede its durable inventory checkpoint (including
        // archived observe-only restoration). Resume the retained consumption bound through
        // the same guarded owner; a newer member or closed lifetime must still win.
        if (!member.transactionSet?.inventoryApplied)
          await this.options.authority.recordObservation(id, index, member.observation, member.account, member)
        continue
      }
      const observation: EvmNativeObservation = receipt
        ? {
            state:
              receipt.status === 1 ? 'included-success' : 'included-revert',
            transactionHash: receipt.hash,
            blockHash: receipt.blockHash,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.index,
            feeWei: (
              receipt.fee ?? receipt.gasUsed * (receipt.gasPrice ?? 0n)
            ).toString(),
          }
        : {
            // Missing means no node has it. A member this wallet has exposed whose nonce is
            // still unconsumed is submitted and awaiting a block, even when the node does not
            // show it: a node need not serve transactions outside a block (Monad's does not), so
            // a look between the broadcast and the block would otherwise record every member of
            // a set missing though they all land in the next block. Only a consumed nonce with no
            // receipt of ours is evidence the member will not land (`nativeMemberSuperseded`).
            state:
              (await this.knownOn(member, provider)) ||
              (member.exposed && nonce <= Transaction.from(signed.rawTransaction).nonce)
                ? 'pending'
                : 'missing',
          }
      await this.options.authority.recordObservation(
        id,
        index,
        observation,
        account,
        member,
      )
    }
  }
}
