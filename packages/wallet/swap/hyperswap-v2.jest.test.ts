import { HYPERSWAP_V2_TESTNET, HyperSwapV2Testnet } from './hyperswap-v2'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import type { SwapWallet } from './swap-execution'
import { getAddress } from 'ethers'

describe('HyperSwap V2 Adapter', () => {
  it('exports the testnet configuration', () => {
    expect(HYPERSWAP_V2_TESTNET.id).toBe('hyperswap-v2')
    expect(HYPERSWAP_V2_TESTNET.chainIdentifier).toBe('hyperliquid-testnet')
    expect(getAddress(HYPERSWAP_V2_TESTNET.router)).toBe(HYPERSWAP_V2_TESTNET.router)
  })

  function createMockReader() {
    return {
      call: jest.fn().mockImplementation(async (tx) => {
        const ethers = require('ethers')
        const abi = new ethers.AbiCoder()
        if (tx.data.startsWith('0xd06ca61f')) { // getAmountsOut
          const decoded = abi.decode(['uint256', 'address[]'], '0x' + tx.data.slice(10))
          return abi.encode(['uint256[]'], [[decoded[0], 256n]])
        }
        if (tx.data.startsWith('0x0902f1ac')) { // getReserves
          return abi.encode(['uint112', 'uint112', 'uint32'], [1000000000000000000n, 1000000000000000000n, 0])
        }
        if (tx.data.startsWith('0xc45a0155')) { // factory
          return abi.encode(['address'], [HYPERSWAP_V2_TESTNET.factory])
        }
        if (tx.data.startsWith('0xad5c4648')) { // WETH
          return abi.encode(['address'], [HYPERSWAP_V2_TESTNET.wrappedNative])
        }
        if (tx.data.startsWith('0xe6a43905')) { // getPair
          return abi.encode(['address'], [HYPERSWAP_V2_TESTNET.pair])
        }
        if (tx.data.startsWith('0x0dfe1681')) { // token0
          return abi.encode(['address'], [HYPERSWAP_V2_TESTNET.wrappedNative])
        }
        if (tx.data.startsWith('0xd21220a7')) { // token1
          return abi.encode(['address'], [HYPERSWAP_V2_TESTNET.tokenOut.address])
        }
        if (tx.data.startsWith('0x313ce567')) { // decimals
          return abi.encode(['uint8'], [18])
        }
        return '0x'
      }),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 998n }),
      getBlock: jest.fn().mockResolvedValue({ hash: '0x61826beeba5fa2a5cc2dcd04febc904aca943cb95821eab8087308cfa25b2baf' }),
      getCode: jest.fn().mockResolvedValue('0x1234'),
      getTransaction: jest.fn().mockResolvedValue(null),
      getTransactionReceipt: jest.fn().mockResolvedValue(null)
    }
  }

  it('provides a quote', async () => {
    const mockReader = createMockReader()
    const mockWallet = {} as unknown as SwapWallet
    const adapter = new HyperSwapV2Testnet(mockReader as any, mockWallet)
    const quote = await adapter.quote(1000000000000000000n)
    expect(quote.amountOut).toBe(256n)
    expect(quote.poolAmountOut).toBe(256n)
  })

  it('plans a swap', async () => {
    const mockReader = createMockReader()
    const adapter = new HyperSwapV2Testnet(mockReader as any, {} as any)
    adapter.now = () => 1000000

    const plan = await adapter.plan({ amountIn: 10000n, account: HYPERSWAP_V2_TESTNET.router, slippageBps: 50 })
    expect(plan.slippageBps).toBe(50)
    expect(plan.minimumAmountOut).toBe(256n * 9950n / 10000n)
  })

  it('validates execute parameters', async () => {
    const mockReader = createMockReader()
    const adapter = new HyperSwapV2Testnet(mockReader as any, {} as any)
    await expect(adapter.execute({ route: { kind: 'wrong' } } as any, 1000n)).rejects.toThrow()
  })

  it('validates reconcile parameters', async () => {
    const mockReader = createMockReader()
    const adapter = new HyperSwapV2Testnet(mockReader as any, {} as any)
    const result = await adapter.reconcile({ txHash: '0x123', operationId: '0x456' }, { kind: 'hyperswap-v2-native-purr', amountIn: '10', minimumAmountOut: '10', account: HYPERSWAP_V2_TESTNET.router, deadline: 1000 })
    expect(result.status).toBe('pending')
  })

  it('validates observe parameters', async () => {
    const mockReader = createMockReader()
    const adapter = new HyperSwapV2Testnet(mockReader as any, {} as any)
    const result = await adapter.observe({ txHash: '0x123', operationId: '0x456' }, { kind: 'hyperswap-v2-native-purr', amountIn: '10', minimumAmountOut: '10', account: HYPERSWAP_V2_TESTNET.router, deadline: 1000 })
    expect(result.status).toBe('pending')
  })
})
