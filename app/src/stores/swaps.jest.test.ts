/** @jest-environment jsdom */
import { setActivePinia, createPinia } from 'pinia'
import {
  useSwapStore,
  encodeSwapRecord,
  decodeSwapRecord,
  swapRecordItem,
  type SwapRecord,
} from './swaps'
import { useChatStore } from './chats'
import { fromHex } from '@frank/codec'

describe('useSwapStore and typed CBOR swap records', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  test('encodeSwapRecord and decodeSwapRecord round-trip canonically', () => {
    const original: SwapRecord = {
      id: 'swap-123',
      timestamp: 1728345600000,
      chain: 'solana',
      fromAsset: 'SOL',
      toAsset: 'USDC',
      fromAmount: '1',
      toAmount: '144.87',
      txHash: '5K6yZ7kXzD8mQ4bV3w9yF2uG1hJ4rT6sA8cE2pL5nN9wK3mQ7rT8uV9xZ',
      route: 'Jupiter Aggregator (Solana)',
      feeDisplay: '0.0875% (~$0.13)',
      destinationAddress: 'Private Stealth Address',
      status: 'confirmed',
    }

    const cborBytes = encodeSwapRecord(original)
    expect(cborBytes).toBeInstanceOf(Uint8Array)
    expect(cborBytes.length).toBeGreaterThan(0)

    const decoded = decodeSwapRecord(cborBytes)
    expect(decoded.id).toBe(original.id)
    expect(decoded.chain).toBe(original.chain)
    expect(decoded.fromAsset).toBe(original.fromAsset)
    expect(decoded.toAsset).toBe(original.toAsset)
    expect(decoded.fromAmount).toBe(original.fromAmount)
    expect(decoded.toAmount).toBe(original.toAmount)
    expect(decoded.txHash).toBe(original.txHash)
    expect(decoded.route).toBe(original.route)
    expect(decoded.feeDisplay).toBe(original.feeDisplay)
    expect(decoded.status).toBe(original.status)
    expect(decoded.destinationAddress).toBe(original.destinationAddress)
  })

  test('recordSwap adds to store, encodes CBOR, and self-sends typed message without text item', async () => {
    const store = useSwapStore()
    const chats = useChatStore()
    const selfSendSpy = jest
      .spyOn(chats, 'selfSendMessage')
      .mockResolvedValue('msg-self-123')

    const record = await store.recordSwap({
      chain: 'solana',
      fromAsset: 'SOL',
      toAsset: 'USDC',
      fromAmount: '1',
      toAmount: '144.87',
      txHash: '5K6yZ7kXzD8mQ4bV3w9yF2uG1hJ4rT6sA8cE2pL5nN9wK3mQ7rT8uV9xZ',
      route: 'Jupiter Aggregator',
      feeDisplay: '0.0875% (~$0.13)',
    })

    expect(record.id).toBeTruthy()
    expect(record.cborPayload).toBeTruthy()
    expect(store.swaps).toHaveLength(1)
    expect(store.swaps[0].id).toBe(record.id)

    expect(selfSendSpy).toHaveBeenCalledTimes(1)
    const sendArg = selfSendSpy.mock.calls[0][0]
    expect(sendArg.type).toBe('swap')
    expect(sendArg.items).toHaveLength(1)
    expect(sendArg.items[0].type).toBe('swap-record')

    // Must NOT contain any text item (avoiding chat drawer pollution)
    const textItems = sendArg.items.filter((it: any) => it.type === 'text')
    expect(textItems).toHaveLength(0)

    // CBOR payload must decode back to identical fields
    const decoded = decodeSwapRecord(
      fromHex((sendArg.items[0] as any).cborPayload),
    )
    expect(decoded.fromAmount).toBe('1')
    expect(decoded.toAsset).toBe('USDC')
  })

  test('handleSwapItem processes incoming typed swap items and updates Pinia state', () => {
    const store = useSwapStore()
    expect(store.swaps).toHaveLength(0)

    store.handleSwapItem({
      type: 'swap-record',
      swapId: 'swap-remote-99',
      chain: 'solana',
      fromAsset: 'tSOL',
      toAsset: 'USDC',
      fromAmount: '2.5',
      toAmount: '362.18',
      txHash: '4Z4T2vN8xL9pQ3mK1wR7yU5sA6dF8gH2jE4cM7bP9nQ8',
      route: 'Jupiter Aggregator',
      feeDisplay: '0.0875%',
      status: 'confirmed',
      timestamp: 1728346000000,
    })

    expect(store.swaps).toHaveLength(1)
    expect(store.swaps[0].id).toBe('swap-remote-99')
    expect(store.swaps[0].fromAmount).toBe('2.5')

    // Deduplicates when called again with same ID
    store.handleSwapItem({
      type: 'swap-record',
      swapId: 'swap-remote-99',
      chain: 'solana',
      fromAsset: 'tSOL',
      toAsset: 'USDC',
      fromAmount: '2.5',
      toAmount: '362.18',
      txHash: '4Z4T2vN8xL9pQ3mK1wR7yU5sA6dF8gH2jE4cM7bP9nQ8',
      route: 'Jupiter Aggregator',
      feeDisplay: '0.0875%',
      status: 'confirmed',
      timestamp: 1728346000000,
    })
    expect(store.swaps).toHaveLength(1)
  })

  test('getSwapsForChain filters correctly for solana and other chains', async () => {
    const store = useSwapStore()
    store.swaps = [
      {
        id: 's1',
        chain: 'solana',
        fromAsset: 'SOL',
        toAsset: 'USDC',
        fromAmount: '1',
        toAmount: '145',
        txHash: 'hash1',
        route: 'Jupiter',
        feeDisplay: '0.0875%',
        status: 'confirmed',
        timestamp: 1000,
      },
      {
        id: 's2',
        chain: 'ecash',
        fromAsset: 'XEC',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '41',
        txHash: 'hash2',
        route: 'eCash Atomic Swap',
        feeDisplay: '0.0875%',
        status: 'confirmed',
        timestamp: 2000,
      },
    ]

    expect(store.getSwapsForChain('solana')).toHaveLength(1)
    expect(store.getSwapsForChain('solana')[0].id).toBe('s1')
    expect(store.getSwapsForChain('ecash')).toHaveLength(1)
    expect(store.getSwapsForChain('ecash')[0].id).toBe('s2')
  })

  const pending: SwapRecord = {
    id: 'swap-pending',
    timestamp: 1,
    chain: 'monad',
    chainIdentifier: 'monad-testnet',
    fromAsset: 'MON',
    toAsset: 'USDC',
    fromAmount: '0.02',
    toAmount: '≥0.019796',
    txHash: '0xabc',
    route: 'Uniswap v4',
    feeDisplay: '',
    status: 'pending',
  }

  test('saveLocal writes the swap to this device and replaces it by id', () => {
    const store = useSwapStore()
    store.saveLocal(pending)
    store.saveLocal({ ...pending, status: 'confirmed', toAmount: '0.019996' })
    expect(store.swaps).toHaveLength(1)
    expect(
      JSON.parse(window.localStorage.getItem('frank_swap_history')!),
    ).toEqual([{ ...pending, status: 'confirmed', toAmount: '0.019996' }])
  })

  test('saveLocal throws, and records nothing, when the device cannot store the swap', () => {
    const store = useSwapStore()
    const write = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
    expect(() => store.saveLocal(pending)).toThrow('QuotaExceededError')
    expect(store.swaps).toEqual([])
    write.mockRestore()
  })

  test('a swap that names its network is listed only on that network', () => {
    const store = useSwapStore()
    store.saveLocal(pending)
    expect(store.getSwapsForChain('monad', 'monad-testnet')).toHaveLength(1)
    expect(store.getSwapsForChain('monad', 'monad-mainnet')).toHaveLength(0)
    expect(store.getSwapsForChain('monad')).toHaveLength(1)
  })

  test('a note read back from the mailbox rebuilds the swap on a device that never saw it', () => {
    const made = useSwapStore()
    const item = swapRecordItem({
      ...pending,
      recovery: {
        operationId: 'op-1',
        venueId: 'uniswap-v4',
        account: '0xMain',
        route: { zeroForOne: true },
        call: { to: '0xRouter', data: '0x00', value: '1' },
        toDecimals: 6,
      },
    })
    setActivePinia(createPinia())
    window.localStorage.clear()
    const other = useSwapStore()
    expect(other.swaps).toEqual([])
    other.handleSwapItem(item)
    expect(other.getSwapsForChain('monad', 'monad-testnet')).toHaveLength(1)
    expect(other.swaps[0]).toMatchObject({
      id: 'swap-pending',
      status: 'pending',
      chainIdentifier: 'monad-testnet',
      txHash: '0xabc',
      recovery: {
        venueId: 'uniswap-v4',
        account: '0xMain',
        route: { zeroForOne: true },
        toDecimals: 6,
      },
    })
    // Only the device that made the swap can re-send it.
    expect(other.swaps[0].recovery?.operationId).toBeUndefined()
    expect(made).toBeDefined()
  })

  test('a note never undoes what this device has read from the chain or knows of its own operation', () => {
    const store = useSwapStore()
    const recovery = {
      operationId: 'op-1',
      venueId: 'uniswap-v4',
      account: '0xMain',
      route: { zeroForOne: true },
      call: { to: '0xRouter', data: '0x00', value: '1' },
      toDecimals: 6,
    }
    store.saveLocal({
      ...pending,
      status: 'confirmed',
      toAmount: '0.019996',
      feeDisplay: '0.0211 MON',
      recovery,
      noted: true,
    })
    store.handleSwapItem(swapRecordItem({ ...pending, recovery }))
    expect(store.swaps).toHaveLength(1)
    expect(store.swaps[0]).toMatchObject({
      status: 'confirmed',
      toAmount: '0.019996',
      feeDisplay: '0.0211 MON',
      noted: true,
      recovery: { operationId: 'op-1' },
    })
  })

  test('markNoted remembers that the note reached the relay', () => {
    const store = useSwapStore()
    store.saveLocal(pending)
    store.markNoted('swap-pending')
    expect(store.swaps[0].noted).toBe(true)
  })
})
