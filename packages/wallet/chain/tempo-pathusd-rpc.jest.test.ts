import { Interface, zeroPadValue } from 'ethers'
import { PROTOCOL_CHAINS } from './chains-registry'
import { PATHUSD } from './tempo-pathusd-operation'
import { TempoPathUsdJsonRpc, type TempoJsonRpcTransport } from './tempo-pathusd-rpc'

const SOURCE = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const HASH = '0x' + '33'.repeat(32)
const BLOCK = '0x' + '44'.repeat(32)
const genesis = PROTOCOL_CHAINS['tempo-testnet'].identityProbes.find(p => p.kind === 'block-hash')
const abi = new Interface(['event Transfer(address indexed from, address indexed to, uint256 amount)'])

function transport() {
  const calls: { method: string; params: readonly unknown[] }[] = []
  let override: Partial<Record<string, unknown>> = {}
  const send = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls.push({ method, params })
    if (method in override) return override[method]
    switch (method) {
      case 'eth_chainId': return '0xa5bf'
      case 'eth_getBlockByNumber': return { hash: genesis!.expected }
      case 'eth_getTransactionCount': return '0x7'
      case 'eth_call': return zeroPadValue('0x989680', 32)
      case 'eth_estimateGas': return '0x4722a'
      case 'eth_feeHistory': return { baseFeePerGas: ['0x23c34600', '0x23c34600'] }
      case 'eth_maxPriorityFeePerGas': return '0x1'
      case 'eth_sendRawTransaction': return HASH
      case 'eth_getTransactionReceipt': return null
      case 'eth_getLogs': return []
      default: throw new Error('Unexpected RPC method ' + method)
    }
  }
  return { rpc: new TempoPathUsdJsonRpc({ send } satisfies TempoJsonRpcTransport, 'tempo-testnet'), calls, set: (method: string, value: unknown) => { override[method] = value } }
}

describe('Tempo PathUSD JSON-RPC boundary', () => {
  test('verifies chain and genesis checkpoint from authoritative registry', async () => {
    const h = transport()
    await h.rpc.verifyChain('tempo-testnet')
    expect(h.calls.map(call => call.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber'])
    h.set('eth_getBlockByNumber', { hash: BLOCK })
    await expect(h.rpc.verifyChain('tempo-testnet')).rejects.toThrow('checkpoint mismatch')
    h.set('eth_chainId', '0x1')
    await expect(h.rpc.verifyChain('tempo-testnet')).rejects.toThrow('chain ID mismatch')
    await expect(h.rpc.verifyChain('tempo-mainnet')).rejects.toThrow('binding mismatch')
  })

  test('queries PathUSD balance and quotes 0x76 token-paid gas with margin', async () => {
    const h = transport()
    expect(await h.rpc.getPathUsdBalance(SOURCE)).toBe(10_000_000n)
    const quote = await h.rpc.quoteTransfer({ from: SOURCE, to: PATHUSD, data: '0xa9059cbb' })
    expect(quote.gasLimit).toBe((0x4722an * 120n + 99n) / 100n)
    expect(quote.maxFeePerGas).toBe(2n * 0x23c34600n + 1n)
    const estimate = h.calls.find(call => call.method === 'eth_estimateGas')!
    expect(estimate.params).toEqual([{ from: SOURCE, to: PATHUSD, data: '0xa9059cbb', type: '0x76', feeToken: PATHUSD }])
    expect(h.calls.some(call => call.method === 'eth_getBalance')).toBe(false)
  })

  test('parses only matching incoming PathUSD transfers from a bounded log range', async () => {
    const h = transport()
    const encoded = abi.encodeEventLog(abi.getEvent('Transfer')!, [SOURCE, RECIPIENT, 2_000_000n])
    h.set('eth_getLogs', [{
      address: PATHUSD, topics: encoded.topics, data: encoded.data,
      transactionHash: HASH, blockHash: BLOCK, blockNumber: '0x64',
    }])
    expect(await h.rpc.receivedTransfers(RECIPIENT, 90n, 100n)).toEqual([{
      transactionHash: HASH, blockHash: BLOCK, blockNumber: 100,
      sender: SOURCE, recipient: RECIPIENT, amountAtomic: 2_000_000n,
    }])
    const filter = h.calls.find(call => call.method === 'eth_getLogs')!.params[0] as Record<string, unknown>
    expect(filter.address).toBe(PATHUSD)
    expect(filter.fromBlock).toBe('0x5a')
    expect(filter.toBlock).toBe('0x64')
    expect((filter.topics as unknown[])[2]).toBe(zeroPadValue(RECIPIENT, 32))
    expect(h.calls.slice(-3).map(call => call.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs'])
    await expect(h.rpc.receivedTransfers(RECIPIENT, 0n, 2_000n)).rejects.toThrow('exceeds')
    h.set('eth_getBlockByNumber', { hash: BLOCK })
    await expect(h.rpc.receivedTransfers(RECIPIENT, 0n, 1n)).rejects.toThrow('checkpoint mismatch')
  })

  test('finality checks canonical receipt block hash at finalized height', async () => {
    const h = transport()
    const receipt = {
      transactionHash: HASH, blockHash: BLOCK, blockNumber: 100, status: 1,
      gasUsed: 1n, effectiveGasPrice: 1n, feeToken: PATHUSD, feePayer: SOURCE, logs: [],
    }
    h.set('eth_getBlockByNumber', { number: '0x63', hash: BLOCK })
    expect(await h.rpc.isFinalizedReceipt(receipt)).toBe(false)
    h.set('eth_getBlockByNumber', { number: '0x64', hash: BLOCK })
    expect(await h.rpc.isFinalizedReceipt(receipt)).toBe(true)
    h.set('eth_getBlockByNumber', { number: '0x64', hash: HASH })
    expect(await h.rpc.isFinalizedReceipt(receipt)).toBe(false)
  })
})
