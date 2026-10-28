/** Read-only recovery of a native stamp at its already-derived one-time destination.
 * Receipt provenance is never proof that the original sender/human repaid it.
 */
import { Transaction, type Provider } from 'ethers'
import { EvmDepositScanner, MAX_CHANGES_PER_REFRESH, type EvmDepositRow } from './evm-deposit-scan'
import {
  readCanonicalNativeTransfers,
  type EvmNativeReceiptRpc,
  type EvmNativeTransfer,
} from './evm-native-receipt'
import { findNonceConsumer } from './evm-nonce-consumer'
import { EVM_FAILURE_CONFIRMATIONS } from './chain/evm-settlement'
import {
  MemoryRecordStore,
  validateNativeStampRecovery,
  type EvmCoin,
  type EvmNativeStampRecovery,
} from './storage/evm-coin-store'

export class NativeStampEvidenceUnavailable extends Error {}

/** The received owner serializes passes; RPC waits never hold spend reservations. */
export class EvmNativeStampRecoveryReader {
  private readonly scans = new Map<string, EvmDepositScanner>()
  private readonly recheckOffsets = new Map<string, number>()
  constructor(
    private readonly options: {
      chainIdentifier: string
      nativeChainId: bigint
      rpc: EvmNativeReceiptRpc
      provider: Pick<
        Provider,
        'getBlock' | 'getTransactionReceipt' | 'getTransactionCount' | 'getBalance'
      >
      maximumBlock: () => Promise<number>
      assertActive: () => void
    },
  ) {}

  async read(coin: EvmCoin) {
    const atMs = Date.now()
    const { provider, rpc, chainIdentifier, nativeChainId, assertActive } = this.options
    validateNativeStampRecovery(coin, chainIdentifier)
    const tx = Transaction.from(`0x${coin.transactions[0]!.replace(/^0x/, '')}`)
    if (
      !tx.isSigned() ||
      tx.chainId !== nativeChainId ||
      tx.to?.toLowerCase() !== coin.address ||
      tx.data !== '0x' ||
      tx.value <= 0n ||
      coin.transactions.length !== 1
    )
      throw new NativeStampEvidenceUnavailable('Invalid original native stamp transaction')
    const maximumBlock = await this.options.maximumBlock()
    const head = await provider.getBlock(maximumBlock)
    assertActive()
    if (!head?.hash || head.number !== maximumBlock)
      throw new NativeStampEvidenceUnavailable('Native stamp canonical head unavailable')
    const pinnedHash = head.hash.toLowerCase()
    const readBlock = (blockNumber: number) =>
      readCanonicalNativeTransfers({
        rpc,
        chainIdentifier,
        address: coin.address,
        blockNumber,
        maximumBlock,
      })
    const pending = async (unexecuted: boolean) => {
      const [balanceWei, accountNonce] = await Promise.all([
        provider.getBalance(coin.address, maximumBlock),
        provider.getTransactionCount(coin.address, maximumBlock),
      ])
      await this.checkHead(maximumBlock, pinnedHash)
      return {
        original: undefined,
        recovery: undefined,
        balanceWei,
        accountNonce,
        atMs,
        canonicalBlocks: [],
        receipts: [] as EvmNativeTransfer[],
        unavailable: undefined,
        kind: 'pending' as const,
        unexecuted,
      }
    }
    const originalReceipt = await provider.getTransactionReceipt(tx.hash!)
    assertActive()
    let original: EvmNativeTransfer | undefined
    let supersededAt = coin.nativeStampRecovery?.supersededAt
    let unavailable: unknown
    let discover = true
    if (originalReceipt && originalReceipt.blockNumber <= maximumBlock) {
      const originals = await readBlock(originalReceipt.blockNumber)
      original = originals.find(receipt => receipt.txHash === tx.hash)
      if (!original) {
        const block = await provider.getBlock(originalReceipt.blockNumber)
        if (
          originalReceipt.status !== 0 ||
          originalReceipt.hash.toLowerCase() !== tx.hash ||
          originalReceipt.from.toLowerCase() !== tx.from!.toLowerCase() ||
          originalReceipt.to?.toLowerCase() !== coin.address ||
          block?.hash?.toLowerCase() !== originalReceipt.blockHash.toLowerCase() ||
          block.transactions[originalReceipt.index]?.toLowerCase() !== tx.hash
        )
          throw new NativeStampEvidenceUnavailable(
            'Original native stamp did not resolve canonically',
          )
        if (!coin.nativeStampRecovery) return { ...(await pending(false)), kind: 'failed' as const }
      }
      // A canonical original observed before supersession follows the normal original path.
      if (!coin.nativeStampRecovery && original) {
        const [balanceWei, accountNonce] = await Promise.all([
          provider.getBalance(coin.address, maximumBlock),
          provider.getTransactionCount(coin.address, maximumBlock),
        ])
        await this.checkHead(maximumBlock, pinnedHash)
        return {
          kind: 'original' as const,
          original,
          balanceWei,
          accountNonce,
          atMs,
          canonicalBlocks: [],
          receipts: [] as EvmNativeTransfer[],
          recovery: undefined,
          unavailable: undefined,
        }
      }
    } else {
      try {
        const senderNonce = await provider.getTransactionCount(tx.from!, maximumBlock)
        assertActive()
        if (senderNonce <= tx.nonce && !coin.nativeStampRecovery) return pending(true)
        if (
          originalReceipt &&
          originalReceipt.blockNumber > maximumBlock &&
          !coin.nativeStampRecovery
        )
          return pending(false)
        const current = await this.supersessionOf(tx, maximumBlock)
        if (!current && !coin.nativeStampRecovery) return pending(false)
        if (!current)
          throw new NativeStampEvidenceUnavailable(
            'Original stamp supersession is not yet confirmed',
          )
        supersededAt = current
      } catch (error) {
        if (!coin.nativeStampRecovery) throw error
        // Loss/contradiction of the original supersession proof must not prevent checking
        // previously recorded receipt blocks for an explicit reorganization.
        unavailable = error
        discover = false
      }
    }
    if (!supersededAt)
      throw new NativeStampEvidenceUnavailable('Native stamp supersession anchor unavailable')
    let scanner = this.scans.get(coin.address)
    if (!scanner) {
      scanner = new EvmDepositScanner({
        chainIdentifier,
        rpc,
        store: new MemoryRecordStore<EvmDepositRow>(),
        watched: () => [coin.address],
        tokens: [],
        isOwnAccount: () => false,
        maximumBlock: async () => this.scanHeads.get(coin.address)!,
      })
      this.scans.set(coin.address, scanner)
    }
    // The callback of an existing scanner must read this pass's pinned maximum, not its creation head.
    this.scanHeads.set(coin.address, maximumBlock)
    const receipts = new Map<string, EvmNativeTransfer>()
    if (original) receipts.set(original.txHash, original)
    if (discover)
      try {
        await scanner.refresh()
        for (const deposit of scanner.deposits()) {
          if (deposit.blockNumber > maximumBlock) continue
          const { id: _id, asset: _asset, ...receipt } = deposit
          receipts.set(receipt.txHash, receipt)
        }
        if (scanner.cursorOf(coin.address)?.unreadable.length)
          unavailable = new NativeStampEvidenceUnavailable(
            'Native stamp recovery history has unreadable gaps',
          )
      } catch (error) {
        unavailable = error
      }
    // Revalidate both durable facts and ephemeral scanner facts. Work per pass is bounded;
    // earlier valid receipts remain evidence when a node later prunes them.
    const known = [...(coin.nativeStampRecovery?.receipts ?? []), ...receipts.values()]
    const blocks = [...new Set(known.map(receipt => receipt.blockNumber))].sort((a, b) => a - b)
    const offset = this.recheckOffsets.get(coin.address) ?? 0
    const selected = Array.from(
      { length: Math.min(blocks.length, MAX_CHANGES_PER_REFRESH) },
      (_, i) => blocks[(offset + i) % blocks.length]!,
    )
    this.recheckOffsets.set(
      coin.address,
      blocks.length ? (offset + selected.length) % blocks.length : 0,
    )
    const canonicalBlocks: { blockNumber: number; blockHash: string }[] = []
    for (const blockNumber of selected) {
      try {
        const block = await provider.getBlock(blockNumber)
        assertActive()
        if (!block?.hash || blockNumber > maximumBlock)
          throw new NativeStampEvidenceUnavailable('Native stamp receipt block unavailable')
        const verified = await readBlock(blockNumber)
        const checked = await provider.getBlock(blockNumber)
        assertActive()
        if (
          checked?.hash?.toLowerCase() !== block.hash.toLowerCase() ||
          verified.some(receipt => receipt.blockHash !== block.hash!.toLowerCase())
        )
          throw new NativeStampEvidenceUnavailable('Native stamp receipt snapshot changed')
        canonicalBlocks.push({ blockNumber, blockHash: block.hash.toLowerCase() })
        for (const receipt of verified) receipts.set(receipt.txHash, receipt)
      } catch (error) {
        unavailable ??= error
      }
    }
    // Values collected during this read are usable only after their own canonical check.
    const checkedReceipts = [...receipts.values()].filter(receipt =>
      canonicalBlocks.some(
        block => block.blockNumber === receipt.blockNumber && block.blockHash === receipt.blockHash,
      ),
    )
    const [balanceWei, accountNonce] = await Promise.all([
      provider.getBalance(coin.address, maximumBlock),
      provider.getTransactionCount(coin.address, maximumBlock),
    ])
    await this.checkHead(maximumBlock, pinnedHash)
    assertActive()
    const recovery: EvmNativeStampRecovery = {
      chainIdentifier,
      originalTransactionHash: tx.hash!,
      supersededAt,
      receipts: checkedReceipts,
    }
    return {
      kind: 'recovery' as const,
      original,
      recovery,
      receipts: checkedReceipts,
      canonicalBlocks,
      balanceWei,
      accountNonce,
      atMs,
      unavailable,
    }
  }
  private async supersessionOf(tx: Transaction, maximumBlock: number) {
    const { provider, assertActive } = this.options
    const capturedBlocks: NonNullable<Awaited<ReturnType<typeof provider.getBlock>>>[] = []
    const consumer = await findNonceConsumer(
      {
        getTransactionCount: (account, at) => provider.getTransactionCount(account, at),
        getBlock: async at => {
          const block = await provider.getBlock(at)
          if (block) capturedBlocks.push(block)
          return block
        },
      },
      { account: tx.from!, nonce: tx.nonce, transactionHash: tx.hash! },
      maximumBlock,
    )
    assertActive()
    const consumerBlock = capturedBlocks.at(-1)
    if (
      consumer?.by === 'another' &&
      maximumBlock - consumer.blockNumber + 1 < EVM_FAILURE_CONFIRMATIONS
    )
      return undefined
    if (
      consumer?.by !== 'another' ||
      maximumBlock - consumer.blockNumber + 1 < EVM_FAILURE_CONFIRMATIONS ||
      !consumerBlock?.hash
    )
      throw new NativeStampEvidenceUnavailable(
        'Original stamp supersession is not canonical and confirmed',
      )
    if (consumer.blockNumber === 0)
      throw new NativeStampEvidenceUnavailable('Invalid stamp nonce consumer block')
    const [before, after, checked] = await Promise.all([
      provider.getTransactionCount(tx.from!, consumer.blockNumber - 1),
      provider.getTransactionCount(tx.from!, consumer.blockNumber),
      provider.getBlock(consumer.blockNumber),
    ])
    assertActive()
    if (
      !checked ||
      before > tx.nonce ||
      after <= tx.nonce ||
      checked?.hash?.toLowerCase() !== consumerBlock.hash.toLowerCase() ||
      checked.transactions.some(hash => hash.toLowerCase() === tx.hash) ||
      checked.transactions.length !== consumerBlock.transactions.length ||
      checked.transactions.some(
        (hash, index) => hash.toLowerCase() !== consumerBlock!.transactions[index]?.toLowerCase(),
      )
    )
      throw new NativeStampEvidenceUnavailable('Original stamp supersession snapshot changed')
    return { blockNumber: consumer.blockNumber, blockHash: checked.hash!.toLowerCase() }
  }
  private readonly scanHeads = new Map<string, number>()
  private async checkHead(number: number, hash: string) {
    const checked = await this.options.provider.getBlock(number)
    this.options.assertActive()
    if (checked?.hash?.toLowerCase() !== hash)
      throw new NativeStampEvidenceUnavailable('Native stamp canonical head changed')
  }
}
