import { Interface, getAddress, zeroPadValue } from 'ethers'
import { PROTOCOL_CHAINS } from './chains-registry'
import {
  PATHUSD,
  tempoPathUsdReceivedTransfer,
  type TempoPathUsdRpc,
  type TempoReceipt,
} from './tempo-pathusd-operation'

/** RPC transport is supplied by composition, which owns endpoint and relay selection. */
export interface TempoJsonRpcTransport {
  send(method: string, params: readonly unknown[]): Promise<unknown>
}

const abi = new Interface(['function balanceOf(address owner) view returns (uint256)'])
const HASH = /^0x[0-9a-f]{64}$/i

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed Tempo RPC object')
  return value as Record<string, unknown>
}

function hex(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    throw new Error('Malformed Tempo RPC quantity')
  return BigInt(value)
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Malformed Tempo RPC hash')
  return value.toLowerCase()
}

function address(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Malformed Tempo RPC address')
  return getAddress(value).toLowerCase()
}

function blockNumber(value: unknown): number {
  const number = hex(value)
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Tempo block number is unsafe')
  return Number(number)
}

export class TempoPathUsdJsonRpc implements TempoPathUsdRpc {
  constructor(
    private readonly transport: TempoJsonRpcTransport,
    private readonly chainIdentifier: 'tempo-testnet' | 'tempo-mainnet',
  ) {}

  async verifyChain(chainIdentifier: 'tempo-testnet' | 'tempo-mainnet'): Promise<void> {
    if (chainIdentifier !== this.chainIdentifier) throw new Error('Tempo RPC binding mismatch')
    const chain = PROTOCOL_CHAINS[chainIdentifier]
    if (chain?.kind !== 'tempo' || !chain.nativeChainId)
      throw new Error('Unknown Tempo chain')
    const observed = hex(await this.transport.send('eth_chainId', []))
    if (observed !== BigInt(chain.nativeChainId)) throw new Error('Tempo chain ID mismatch')
    for (const probe of chain.identityProbes) {
      if (probe.kind !== 'block-hash') continue
      const block = record(await this.transport.send('eth_getBlockByNumber', [`0x${probe.height.toString(16)}`, false]))
      if (hash(block.hash) !== probe.expected.toLowerCase())
        throw new Error('Tempo checkpoint mismatch')
    }
  }

  async getPendingNonce(owner: string): Promise<bigint> {
    return hex(await this.transport.send('eth_getTransactionCount', [address(owner), 'pending']))
  }

  async getPathUsdBalance(owner: string): Promise<bigint> {
    const data = abi.encodeFunctionData('balanceOf', [address(owner)])
    const result = await this.transport.send('eth_call', [{ to: PATHUSD, data }, 'latest'])
    if (typeof result !== 'string') throw new Error('Malformed Tempo balance')
    return abi.decodeFunctionResult('balanceOf', result)[0] as bigint
  }

  async quoteTransfer(params: { from: string; to: string; data: string }): Promise<{
    gasLimit: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }> {
    if (address(params.to) !== PATHUSD) throw new Error('Tempo transfer must call PathUSD')
    // Tempo's 0x76 simulation accounts for TIP-20 account creation and token-paid fees.
    const estimate = hex(await this.transport.send('eth_estimateGas', [{
      from: address(params.from), to: PATHUSD, data: params.data,
      type: '0x76', feeToken: PATHUSD,
    }]))
    if (estimate === 0n) throw new Error('Tempo returned zero gas estimate')
    const history = record(await this.transport.send('eth_feeHistory', ['0x1', 'latest', []]))
    if (!Array.isArray(history.baseFeePerGas) || history.baseFeePerGas.length < 2)
      throw new Error('Malformed Tempo fee history')
    const baseFee = hex(history.baseFeePerGas.at(-1))
    const priority = hex(await this.transport.send('eth_maxPriorityFeePerGas', []))
    return {
      gasLimit: (estimate * 120n + 99n) / 100n,
      maxFeePerGas: baseFee * 2n + priority,
      maxPriorityFeePerGas: priority,
    }
  }

  async sendRawTransaction(raw: string): Promise<string> {
    return hash(await this.transport.send('eth_sendRawTransaction', [raw]))
  }

  async getReceipt(transactionHash: string): Promise<TempoReceipt | null> {
    const result = await this.transport.send('eth_getTransactionReceipt', [hash(transactionHash)])
    if (result === null) return null
    const value = record(result)
    if (!Array.isArray(value.logs)) throw new Error('Malformed Tempo receipt logs')
    return {
      transactionHash: hash(value.transactionHash),
      blockHash: hash(value.blockHash),
      blockNumber: blockNumber(value.blockNumber),
      status: Number(hex(value.status)),
      gasUsed: hex(value.gasUsed),
      effectiveGasPrice: hex(value.effectiveGasPrice),
      feeToken: address(value.feeToken),
      feePayer: address(value.feePayer),
      logs: value.logs.map(item => {
        const log = record(item)
        if (!Array.isArray(log.topics) || log.topics.some(topic => typeof topic !== 'string' || !HASH.test(topic)))
          throw new Error('Malformed Tempo receipt topics')
        if (typeof log.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data))
          throw new Error('Malformed Tempo receipt data')
        return { address: address(log.address), topics: log.topics as string[], data: log.data }
      }),
    }
  }

  /** Caller owns the durable scan cursor and finality policy. */
  async receivedTransfers(recipient: string, fromBlock: bigint, toBlock: bigint): Promise<{
    transactionHash: string
    blockHash: string
    blockNumber: number
    sender: string
    recipient: string
    amountAtomic: bigint
  }[]> {
    if (fromBlock < 0n || toBlock < fromBlock) throw new RangeError('Invalid Tempo scan range')
    if (toBlock - fromBlock >= 2_000n) throw new RangeError('Tempo scan range exceeds 2,000 blocks')
    await this.verifyChain(this.chainIdentifier)
    const target = address(recipient)
    const transferTopic = new Interface(['event Transfer(address indexed from, address indexed to, uint256 amount)']).getEvent('Transfer')!.topicHash
    const result = await this.transport.send('eth_getLogs', [{
      address: PATHUSD,
      topics: [transferTopic, null, zeroPadValue(target, 32)],
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    }])
    if (!Array.isArray(result)) throw new Error('Malformed Tempo logs')
    return result.map(item => {
      const log = record(item)
      if (!Array.isArray(log.topics)) throw new Error('Malformed Tempo log topics')
      const transfer = tempoPathUsdReceivedTransfer({
        address: address(log.address),
        topics: log.topics as string[],
        data: String(log.data),
      }, target)
      if (!transfer) throw new Error('Tempo RPC returned an unexpected transfer')
      return {
        transactionHash: hash(log.transactionHash),
        blockHash: hash(log.blockHash),
        blockNumber: blockNumber(log.blockNumber),
        ...transfer,
      }
    })
  }
}
