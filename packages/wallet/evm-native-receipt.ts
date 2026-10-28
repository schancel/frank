/** Native transaction facts derived from an already identity/checkpoint-verified chain RPC.
 * This reader does not establish upstream identity or spendability. Callers must supply their
 * canonical maximum head (financial consumers use the configured spend-rule head).
 */
import { getAddress } from 'ethers'
import { PROTOCOL_CHAINS } from './chain/chains-registry'

export interface EvmNativeReceiptRpc {
  send(method: string, params: unknown[]): Promise<unknown>
}

export interface EvmNativeTransfer {
  readonly chainIdentifier: string
  readonly txHash: string
  readonly from: string
  readonly to: string
  readonly amount: string
  readonly blockNumber: number
  readonly blockHash: string
  readonly blockTimeMs: number
}

export const MAX_NATIVE_BLOCK_TRANSACTION_READS = 2_000
const READS_AT_ONCE = 20

function invalid(detail: string): never {
  throw new Error(
    `Native receipt evidence unavailable or inconsistent: ${detail}`,
  )
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid('missing RPC record')
  return value as Record<string, unknown>
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    return invalid('invalid quantity')
  return BigInt(value)
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value))
    return invalid('invalid hash')
  return value.toLowerCase()
}
function address(value: unknown): string {
  if (typeof value !== 'string') return invalid('invalid address')
  return getAddress(value).toLowerCase()
}
function height(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    invalid('invalid block boundary')
}
async function inChunks<T, R>(
  items: readonly T[],
  read: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = []
  for (let start = 0; start < items.length; start += READS_AT_ONCE)
    result.push(
      ...(await Promise.all(
        items
          .slice(start, start + READS_AT_ONCE)
          .map((item, index) => read(item, start + index)),
      )),
    )
  return result
}

/** Read all direct positive native transfers to one address in a bounded canonical block.
 * No own-account/known-message filters: those belong to history presentation. Missing/pruned
 * records and a changed snapshot reject the whole read; no partial evidence is returned.
 * Legacy unprotected transactions belong to the chain through canonical block membership;
 * their absent/zero chain ID is not a new network identity. Protected IDs must agree.
 */
export async function readCanonicalNativeTransfers(options: {
  readonly rpc: EvmNativeReceiptRpc
  readonly chainIdentifier: string
  readonly address: string
  readonly blockNumber: number
  readonly maximumBlock: number
}): Promise<EvmNativeTransfer[]> {
  const { rpc, chainIdentifier, blockNumber, maximumBlock } = options
  height(blockNumber)
  height(maximumBlock)
  if (blockNumber > maximumBlock) invalid('block exceeds maximum head')
  const chain = PROTOCOL_CHAINS[chainIdentifier]
  if (!chain || chain.family !== 'evm' || chain.nativeChainId === undefined)
    invalid('unsupported canonical EVM chainIdentifier')
  const nativeChainId = BigInt(chain.nativeChainId)
  const recipient = address(options.address)
  if (quantity(await rpc.send('eth_chainId', [])) !== nativeChainId)
    invalid('RPC chain ID mismatch')
  const tag = `0x${blockNumber.toString(16)}`
  const readBlock = async () => {
    const block = object(await rpc.send('eth_getBlockByNumber', [tag, false]))
    if (quantity(block.number) !== BigInt(blockNumber))
      invalid('wrong block height')
    const blockHash = hash(block.hash)
    if (!Array.isArray(block.transactions)) invalid('missing block membership')
    const transactions = block.transactions.map(hash)
    if (new Set(transactions).size !== transactions.length)
      invalid('duplicate block membership')
    const timestamp = quantity(block.timestamp)
    if (timestamp > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)))
      invalid('invalid block timestamp')
    return { blockHash, transactions, blockTimeMs: Number(timestamp) * 1000 }
  }
  const block = await readBlock()
  if (block.transactions.length > MAX_NATIVE_BLOCK_TRANSACTION_READS)
    invalid('block transaction limit exceeded')
  const transfers = await inChunks(
    block.transactions,
    async (txHash, index) => {
      const tx = object(await rpc.send('eth_getTransactionByHash', [txHash]))
      if (
        hash(tx.hash) !== txHash ||
        hash(tx.blockHash) !== block.blockHash ||
        quantity(tx.blockNumber) !== BigInt(blockNumber) ||
        quantity(tx.transactionIndex) !== BigInt(index)
      )
        invalid('transaction inclusion mismatch')
      const explicit = tx.chainId === undefined ? 0n : quantity(tx.chainId)
      if (explicit !== 0n && explicit !== nativeChainId)
        invalid('transaction chain ID mismatch')
      const type = tx.type === undefined ? 0n : quantity(tx.type)
      if (type !== 0n) {
        if (explicit === 0n) invalid('typed transaction missing chain ID')
      } else {
        const v = quantity(tx.v)
        if (v !== 27n && v !== 28n && (v < 35n || (v - 35n) / 2n !== nativeChainId))
          invalid('legacy transaction chain ID mismatch')
      }
      const from = address(tx.from)
      const to = tx.to === null ? null : address(tx.to)
      const value = quantity(tx.value)
      if (to !== recipient || value === 0n) return undefined
      const receipt = object(
        await rpc.send('eth_getTransactionReceipt', [txHash]),
      )
      if (
        hash(receipt.transactionHash) !== txHash ||
        hash(receipt.blockHash) !== block.blockHash ||
        quantity(receipt.blockNumber) !== BigInt(blockNumber) ||
        quantity(receipt.transactionIndex) !== BigInt(index) ||
        address(receipt.from) !== from ||
        address(receipt.to) !== to
      )
        invalid('receipt inclusion mismatch')
      const status = quantity(receipt.status)
      if (status === 0n) return undefined
      if (status !== 1n) invalid('invalid receipt status')
      return {
        chainIdentifier,
        txHash,
        from,
        to,
        amount: value.toString(),
        blockNumber,
        blockHash: block.blockHash,
        blockTimeMs: block.blockTimeMs,
      }
    },
  )
  const again = await readBlock()
  if (
    again.blockHash !== block.blockHash ||
    again.blockTimeMs !== block.blockTimeMs ||
    again.transactions.length !== block.transactions.length ||
    again.transactions.some(
      (txHash, index) => txHash !== block.transactions[index],
    )
  )
    invalid('canonical block changed during read')
  return transfers.filter(
    (transfer): transfer is EvmNativeTransfer => transfer !== undefined,
  )
}
