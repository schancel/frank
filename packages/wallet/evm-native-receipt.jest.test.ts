import { EvmDepositScanner, type EvmDepositRow } from './evm-deposit-scan'
import { MemoryRecordStore } from './storage/evm-coin-store'

const address = `0x${'11'.repeat(20)}`
const from = `0x${'22'.repeat(20)}`
const hash = `0x${'33'.repeat(32)}`
const blockHash = `0x${'44'.repeat(32)}`

function fixture() {
  const block = {
    number: '0x1',
    hash: blockHash,
    timestamp: '0x64',
    transactions: [hash],
  }
  const tx = {
    hash,
    from,
    to: address,
    value: '0x64',
    chainId: '0x279f',
    type: '0x2',
    v: '0x1',
    blockNumber: '0x1',
    blockHash,
    transactionIndex: '0x0',
  }
  const receipt = {
    transactionHash: hash,
    from,
    to: address,
    status: '0x1',
    blockNumber: '0x1',
    blockHash,
    transactionIndex: '0x0',
  }
  let blockReads = 0
  const state = {
    block,
    tx,
    receipt,
    missingReceipt: false,
    reorganize: false,
  }
  const send = jest.fn(
    async (method: string, params: unknown[]): Promise<unknown> => {
      switch (method) {
        case 'eth_blockNumber':
          return '0x2'
        case 'eth_chainId':
          return '0x279f'
        case 'eth_getBalance':
          return params[1] === '0x0' ? '0x0' : '0x64'
        case 'eth_getTransactionCount':
          return '0x0'
        case 'eth_getBlockByNumber':
          blockReads++
          return {
            ...state.block,
            ...(state.reorganize && blockReads > 1
              ? { hash: `0x${'55'.repeat(32)}` }
              : {}),
          }
        case 'eth_getTransactionByHash':
          return state.tx
        case 'eth_getTransactionReceipt':
          return state.missingReceipt ? null : state.receipt
        default:
          throw new Error(`Unexpected method ${method}`)
      }
    },
  )
  const store = new MemoryRecordStore<EvmDepositRow>()
  const scanner = new EvmDepositScanner({
    chainIdentifier: 'monad-testnet',
    rpc: { send },
    store,
    watched: () => [address],
    tokens: [],
    isOwnAccount: () => false,
  })
  return { state, send, store, scanner }
}

describe('canonical native deposit evidence', () => {
  it.each([
    'wrong receipt hash',
    'wrong receipt block',
    'missing receipt',
    'changed canonical block',
  ])('does not persist or skip uncertain evidence: %s', async kind => {
    const { state, scanner } = fixture()
    if (kind === 'wrong receipt hash')
      state.receipt.transactionHash = `0x${'66'.repeat(32)}`
    if (kind === 'wrong receipt block')
      state.receipt.blockHash = `0x${'66'.repeat(32)}`
    if (kind === 'missing receipt') state.missingReceipt = true
    if (kind === 'changed canonical block') state.reorganize = true
    await expect(scanner.refresh()).rejects.toThrow()
    expect(scanner.deposits()).toEqual([])
    expect(scanner.cursorOf(address)?.block).toBe(0)
  })
})

import { readCanonicalNativeTransfers } from './evm-native-receipt'

const read = (
  send: (method: string, params: unknown[]) => Promise<unknown>,
  extra = {},
) =>
  readCanonicalNativeTransfers({
    rpc: { send },
    chainIdentifier: 'monad-testnet',
    address,
    blockNumber: 1,
    maximumBlock: 2,
    ...extra,
  })

describe('native receipt reader boundary', () => {
  it('returns actual transaction provenance and value without history ownership filters', async () => {
    const { send } = fixture()
    expect(await read(send)).toEqual([
      {
        chainIdentifier: 'monad-testnet',
        txHash: hash,
        from,
        to: address,
        amount: '100',
        blockNumber: 1,
        blockHash,
        blockTimeMs: 100000,
      },
    ])
  })
  it.each([
    'transaction hash',
    'transaction block',
    'transaction index',
    'transaction chain',
    'receipt height',
    'receipt index',
    'receipt sender',
    'receipt recipient',
    'receipt status',
    'duplicate membership',
  ])('rejects inconsistent %s', async kind => {
    const { send, state } = fixture()
    const otherHash = `0x${'66'.repeat(32)}`
    if (kind === 'transaction hash') state.tx.hash = otherHash
    if (kind === 'transaction block') state.tx.blockHash = otherHash
    if (kind === 'transaction index') state.tx.transactionIndex = '0x1'
    if (kind === 'transaction chain') state.tx.chainId = '0x1'
    if (kind === 'receipt height') state.receipt.blockNumber = '0x2'
    if (kind === 'receipt index') state.receipt.transactionIndex = '0x1'
    if (kind === 'receipt sender') state.receipt.from = address
    if (kind === 'receipt recipient') state.receipt.to = from
    if (kind === 'receipt status') state.receipt.status = '0x2'
    if (kind === 'duplicate membership') state.block.transactions.push(hash)
    await expect(read(send)).rejects.toThrow()
  })
  it('cannot claim a transaction omitted from actual block membership', async () => {
    const { send, state } = fixture()
    state.block.transactions = []
    expect(await read(send)).toEqual([])
    expect(send.mock.calls.map(call => call[0])).not.toContain(
      'eth_getTransactionReceipt',
    )
  })
  it.each([NaN, -1, 0, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid or exceeded maximum %s before RPC',
    async maximumBlock => {
      const { send } = fixture()
      await expect(read(send, { maximumBlock })).rejects.toThrow()
      expect(send).not.toHaveBeenCalled()
    },
  )
  it.each(['evm', 'monad', 'solana-devnet', 'unknown'])(
    'refuses noncanonical/unsupported chain %s',
    async chainIdentifier => {
      const { send } = fixture()
      await expect(read(send, { chainIdentifier })).rejects.toThrow()
      expect(send).not.toHaveBeenCalled()
    },
  )
  it('rejects wrong RPC native chain affinity', async () => {
    const { send } = fixture()
    await expect(
      read((method, params) =>
        method === 'eth_chainId'
          ? Promise.resolve('0x1')
          : send(method, params),
      ),
    ).rejects.toThrow('RPC chain ID mismatch')
  })
  it.each([undefined, '0x0'])(
    'accepts unprotected legacy chainId %s under canonical inclusion',
    async chainId => {
      const { send, state } = fixture()
      Object.assign(state.tx, { chainId, type: '0x0', v: '0x1b' })
      expect(await read(send)).toHaveLength(1)
    },
  )
  it('derives protected legacy chain identity from v when chainId is absent', async () => {
    const { send, state } = fixture()
    Object.assign(state.tx, {
      chainId: undefined,
      type: '0x0',
      v: `0x${(10143n * 2n + 35n).toString(16)}`,
    })
    expect(await read(send)).toHaveLength(1)
    Object.assign(state.tx, { v: '0x25' })
    await expect(read(send)).rejects.toThrow(
      'legacy transaction chain ID mismatch',
    )
  })
  it('rejects a legacy signature scope contradicting an explicit matching RPC chainId', async () => {
    const { send, state } = fixture()
    Object.assign(state.tx, { type: '0x0', v: '0x25' })
    await expect(read(send)).rejects.toThrow('legacy transaction chain ID mismatch')
  })
  it('rejects typed transactions without chainId', async () => {
    const { send, state } = fixture()
    Object.assign(state.tx, { chainId: undefined, type: '0x2', v: '0x1' })
    await expect(read(send)).rejects.toThrow(
      'typed transaction missing chain ID',
    )
  })
  it('rejects a changed canonical block on the final reread', async () => {
    const { send, state } = fixture()
    state.reorganize = true
    await expect(read(send)).rejects.toThrow('canonical block changed during read')
  })
  it.each(['eth_getBlockByNumber', 'eth_getTransactionByHash'])('exposes missing %s records', async missingMethod => {
    const { send } = fixture()
    await expect(read((method, params) => method === missingMethod ? Promise.resolve(null) : send(method, params))).rejects.toThrow('missing RPC record')
  })
  it('returns no failed execution as received value', async () => {
    const { send, state } = fixture()
    state.receipt.status = '0x0'
    expect(await read(send)).toEqual([])
  })
  it('exposes RPC pruning rather than returning partial evidence', async () => {
    const { send } = fixture()
    await expect(
      read((method, params) =>
        method === 'eth_getTransactionReceipt'
          ? Promise.reject(new Error('historical state unavailable'))
          : send(method, params),
      ),
    ).rejects.toThrow('historical state unavailable')
  })
  it('refuses oversized blocks before reading transaction records', async () => {
    const { state, send } = fixture()
    state.block.transactions = Array.from(
      { length: 2001 },
      (_, i) => `0x${i.toString(16).padStart(64, '0')}`,
    )
    await expect(read(send)).rejects.toThrow('block transaction limit exceeded')
    expect(send.mock.calls.map(call => call[0])).not.toContain(
      'eth_getTransactionByHash',
    )
  })
  it('uses the supplied scanner maximum instead of reading a proposed RPC head', async () => {
    const { send, store } = fixture()
    const scan = new EvmDepositScanner({
      chainIdentifier: 'monad-testnet',
      rpc: { send },
      store,
      watched: () => [address],
      tokens: [],
      isOwnAccount: () => false,
      maximumBlock: async () => 0,
    })
    await scan.refresh()
    expect(scan.cursorOf(address)?.block).toBe(0)
    expect(scan.deposits()).toEqual([])
    expect(send.mock.calls.map(call => call[0])).not.toContain(
      'eth_blockNumber',
    )
  })
})

describe('scanner evidence commit boundary', () => {
  it('commits no partial block when one of two candidate receipts is unavailable', async () => {
    const { send, state, scanner } = fixture()
    const second = `0x${'77'.repeat(32)}`
    state.block.transactions.push(second)
    const original = send.getMockImplementation()!
    send.mockImplementation(async (method, params) => {
      if (method === 'eth_getTransactionByHash' && params[0] === second)
        return { ...state.tx, hash: second, transactionIndex: '0x1' }
      if (method === 'eth_getTransactionReceipt' && params[0] === second)
        return null
      return original(method, params)
    })
    await expect(scanner.refresh()).rejects.toThrow()
    expect(scanner.deposits()).toEqual([])
    expect(scanner.cursorOf(address)?.block).toBe(0)
    send.mockImplementation(async (method, params) => {
      if (method === 'eth_getTransactionByHash' && params[0] === second)
        return { ...state.tx, hash: second, transactionIndex: '0x1' }
      if (method === 'eth_getTransactionReceipt' && params[0] === second)
        return {
          ...state.receipt,
          transactionHash: second,
          transactionIndex: '0x1',
        }
      return original(method, params)
    })
    await scanner.refresh()
    expect(scanner.deposits()).toHaveLength(2)
    await scanner.refresh()
    expect(scanner.deposits()).toHaveLength(2)
  })
  it('preserves the bounded history gap for oversized blocks without reading their transactions', async () => {
    const { send, state, scanner } = fixture()
    state.block.transactions = Array.from(
      { length: 2001 },
      (_, i) => `0x${i.toString(16).padStart(64, '0')}`,
    )
    await scanner.refresh()
    expect(scanner.deposits()).toEqual([])
    expect(scanner.cursorOf(address)).toEqual({
      block: 2,
      scannedFrom: 0,
      unreadable: [[1, 1]],
    })
    expect(send.mock.calls.map(call => call[0])).not.toContain(
      'eth_getTransactionByHash',
    )
  })
})
