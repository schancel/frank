/** Node effects for a durable transaction set. The preparer remains the state owner. */
import { Transaction } from 'ethers'
import type { Provider } from 'ethers'
import type {
  EvmNativeAccountObservation,
  EvmNativeMember,
  EvmNativeObservation,
  EvmNativeOperation,
} from './storage/evm-native-operation-journal'
import { nativeMemberSuperseded } from './storage/evm-native-operation-journal'
import { EVM_FAILURE_CONFIRMATIONS } from './chain/evm-settlement'

export interface EvmTransactionSetAuthority {
  getOperation(id: string): EvmNativeOperation | undefined
  readOperation(id: string): Promise<EvmNativeOperation | undefined>
  markExposed(id: string, memberIndex: number): Promise<void>
  recordObservation(
    id: string,
    memberIndex: number,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
  ): Promise<unknown>
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

export class EvmTransactionSetLifecycle {
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
      const funding = prior.source.address !== member.source.address
      if (funding) return observation.state === 'included-success' && this.options.head() >= observation.blockNumber + (meta.fundingWaitBlocks ?? 0)
      if (meta.predecessorWaitBlocks !== undefined)
        return (observation.state === 'included-success' || observation.state === 'included-revert') && this.options.head() >= observation.blockNumber + meta.predecessorWaitBlocks
      return prior.exposed || observation.state === 'included-success' || observation.state === 'included-revert'
    })
  }

  /** Cached readiness only. Relays must not receive a payment whose funding is still private. */
  canSubmitPayments(id: string, stageId?: string): boolean {
    const row = this.validateOperation(this.options.authority.getOperation(id))
    const indexes = row.members.flatMap((member, index) => member.transactionSet!.role === 'payment' && member.transactionSet!.stageId === stageId ? [index] : [])
    return indexes.length > 0 && indexes.every(index => !nativeMemberSuperseded(row.members[index]!) && row.members[index]!.observation.state !== 'included-revert' && this.ready(row, index))
  }

  /** Historical readiness is available without reactivating archived inventory. */
  async readCanSubmitPayments(id: string, stageId?: string): Promise<boolean> {
    const row = this.validateOperation(await this.options.authority.readOperation(id))
    const indexes = row.members.flatMap((member, index) => member.transactionSet!.role === 'payment' && member.transactionSet!.stageId === stageId ? [index] : [])
    return indexes.length > 0 && indexes.every(index => !nativeMemberSuperseded(row.members[index]!) && row.members[index]!.observation.state !== 'included-revert' && this.ready(row, index))
  }

  /** Called only after the complete encrypted message and signed graph are durable. */
  async replayDependencies(id: string, stageId: string): Promise<void> {
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
      if (member.observation.state === 'included-success' || member.observation.state === 'included-revert' || nativeMemberSuperseded(member) || !this.ready(row, index)) continue
      const signed = member.signed!
      try {
        if (await this.options.provider.getTransaction(signed.transactionHash)) {
          await this.options.authority.markExposed(id, index)
          continue
        }
        await this.options.authority.markExposed(id, index)
        try {
          const response = await this.options.provider.broadcastTransaction(signed.rawTransaction)
          if (response.hash.toLowerCase() !== signed.transactionHash.toLowerCase()) throw new Error('Unexpected transaction-set broadcast hash')
        } catch (error) {
          const alreadyKnown = error instanceof Error && /already known|known transaction/i.test(error.message)
          if (!alreadyKnown && !(await this.options.provider.getTransaction(signed.transactionHash))) throw error
        }
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw failures[0]
  }

  /** Read one canonical block's account state; never update inventory from relay answers. */
  async observe(id: string, provider: Provider): Promise<void> {
    const row = this.validateOperation(await this.options.authority.readOperation(id))
    for (let index = 0; index < row.members.length; index++) {
      const member = row.members[index]!,
        signed = member.signed!
      // Terminal history must never be fed through inventory observation again.
      if (member.transactionSet?.inventoryApplied && (member.observation.state === 'included-success' || member.observation.state === 'included-revert' || nativeMemberSuperseded(member))) continue
      const receipt = await provider.getTransactionReceipt(
        signed.transactionHash,
      )
      const block = await provider.getBlock(receipt?.blockNumber ?? 'latest')
      if (!block?.hash)
        throw new Error(
          'Transaction-set observation requires a canonical block',
        )
      if (
        receipt &&
        (receipt.blockHash !== block.hash ||
          receipt.hash.toLowerCase() !== signed.transactionHash.toLowerCase())
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
        (await provider.getTransactionReceipt(signed.transactionHash))
      )
        continue
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
            state: (await provider.getTransaction(signed.transactionHash))
              ? 'pending'
              : 'missing',
          }
      await this.options.authority.recordObservation(
        id,
        index,
        observation,
        account,
      )
    }
  }
}
