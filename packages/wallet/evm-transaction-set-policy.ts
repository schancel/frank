/** Cached network observations. No construction call performs network I/O. */
import type { Provider } from 'ethers'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  type EvmTransactionSetPolicy,
} from './evm-transaction-set-types'

export class EvmTransactionSetPolicyUnavailableError extends Error {
  constructor() {
    super('EVM transaction-set fee quote is not ready; refresh wallet state')
    this.name = 'EvmTransactionSetPolicyUnavailableError'
  }
}

export class EvmTransactionSetPolicyCache {
  private gasPriceWei: bigint | undefined
  private head = 0
  private refreshing: Promise<void> | undefined
  constructor(
    private readonly options: {
      provider: Pick<Provider, 'getFeeData' | 'getBlockNumber'>
      kind: string
      spendSpacingBlocks?: number
      reserveBalanceWei?: bigint
      override?: () => EvmTransactionSetPolicy
      knownNoCodeAddress: string
    },
  ) {}

  refresh(): Promise<void> {
    // An injected reviewed policy is already the complete cached snapshot. Avoid an
    // unrelated RPC quote/read that could stall a local/test composition or override.
    if (this.options.override) return Promise.resolve()
    return (this.refreshing ??= Promise.all([
      this.options.provider.getFeeData(),
      this.options.provider.getBlockNumber(),
    ])
      .then(([fees, head]) => {
        const price = fees.gasPrice ?? fees.maxFeePerGas
        if (price === null || price === undefined || price <= 0n)
          throw new Error('No current EVM transaction-set fee quote')
        this.gasPriceWei = price
        this.head = head
      })
      .finally(() => {
        this.refreshing = undefined
      }))
  }

  snapshot(): EvmTransactionSetPolicy {
    if (this.options.override) return this.options.override()
    const price = this.gasPriceWei
    if (price === undefined)
      throw new EvmTransactionSetPolicyUnavailableError()
    return {
      sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
      gasPriceWei: price,
      paymentGasLimit: (calldata, destination) => {
        if (
          calldata !== '0x' &&
          destination?.toLowerCase() !==
            this.options.knownNoCodeAddress.toLowerCase()
        )
          throw new Error(
            'Contract calldata requires an explicit reviewed transaction-set gas policy',
          )
        const bytes = calldata.slice(2).match(/../g) ?? []
        const tokens = bytes.reduce(
          (sum, byte) => sum + (byte === '00' ? 1n : 4n),
          0n,
        )
        // Supported Ethereum and Monad forks enforce the EIP-7623 calldata floor.
        // Monad additionally charges this complete limit, so signing must reserve all of it.
        const floorPerToken =
          this.options.kind === 'ethereum' || this.options.kind === 'monad'
            ? 10n
            : 4n
        return 21_000n + tokens * floorPerToken
      },
      paymentFeeIsExact: destination =>
        this.options.kind === 'monad' ||
        destination.toLowerCase() ===
          this.options.knownNoCodeAddress.toLowerCase(),
      changeGasLimit: 21_000n,
      dustWei: 10n * 21_000n * price,
      radix: 2,
      jitterBps: 1_500,
      maxChangeOutputs: 20,
      head: this.head,
      ...(this.options.spendSpacingBlocks === undefined
        ? {}
        : {
            spendRule: {
              belowWei: this.options.reserveBalanceWei ?? 0n,
              waitBlocks: this.options.spendSpacingBlocks,
            },
          }),
    }
  }
}
