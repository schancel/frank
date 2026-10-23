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
    role: 'payment' | 'change'
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

  private operation(id: string): EvmNativeOperation {
    const row = this.options.authority.getOperation(id)
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

  /** The host calls only after its complete encrypted envelope and binding are durable.
   * `payments` becomes true only after relay acceptance (or explicit financial release). */
  async replay(id: string, input: { payments: boolean }): Promise<void> {
    const row = this.operation(id)
    const groups = new Map<string, number[]>()
    row.members.forEach((member, index) => {
      const key = member.source.address.toLowerCase()
      const indexes = groups.get(key) ?? []
      indexes.push(index)
      groups.set(key, indexes)
    })
    const results = await Promise.allSettled(
      [...groups.values()].map(async (indexes) => {
        indexes.sort(
          (a, b) =>
            Transaction.from(row.members[a]!.signed!.rawTransaction).nonce -
            Transaction.from(row.members[b]!.signed!.rawTransaction).nonce,
        )
        for (const index of indexes) {
          const member = this.operation(id).members[index]!
          const metadata = (member as EvmNativeMember & MemberMetadata)
            .transactionSet!
          if (
            member.observation.state === 'included-success' ||
            member.observation.state === 'included-revert'
          )
            continue
          if (nativeMemberSuperseded(member)) return
          if (metadata.role === 'payment' && !input.payments) return
          if (metadata.predecessorWaitBlocks !== undefined) {
            const predecessor = row.members[member.dependencies[0]!]
            const observation = predecessor?.observation
            if (
              !observation ||
              (observation.state !== 'included-success' &&
                observation.state !== 'included-revert') ||
              this.options.head() <
                observation.blockNumber + metadata.predecessorWaitBlocks
            )
              return
          }
          const signed = member.signed!
          if (
            await this.options.provider.getTransaction(signed.transactionHash)
          ) {
            await this.options.authority.markExposed(id, index)
            continue
          }
          await this.options.authority.markExposed(id, index)
          try {
            const response = await this.options.provider.broadcastTransaction(
              signed.rawTransaction,
            )
            if (
              response.hash.toLowerCase() !== signed.transactionHash.toLowerCase()
            )
              throw new Error('Unexpected transaction-set broadcast hash')
          } catch (error) {
            // The relay may have broadcast this exact recipient transaction before
            // delivery was recorded locally. Confirm by hash before treating a node's
            // duplicate-submission response as a failure.
            const alreadyKnown =
              error instanceof Error &&
              /already known|known transaction/i.test(error.message)
            if (
              !alreadyKnown &&
              !(await this.options.provider.getTransaction(signed.transactionHash))
            ) throw error
          }
        }
      }),
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  /** Read one canonical block's account state; never update inventory from relay answers. */
  async observe(id: string, provider: Provider): Promise<void> {
    const row = this.operation(id)
    for (let index = 0; index < row.members.length; index++) {
      const member = row.members[index]!,
        signed = member.signed!
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
