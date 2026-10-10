import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  TokenRegistry,
  tokenRegistry,
  getToken,
  listTokensForChain,
  TokenDefinition,
} from './token-registry'
import {
  TokenUtxoStore,
  TokenUtxoRecord,
  serializeTokenUtxo,
  deserializeTokenUtxo,
} from './token-utxo-store'

describe('TokenRegistry (ticket #1152)', () => {
  it('whitelists standard assets: USDC, USDT, and native coins MON, SOL, ETH, XEC; AVU is a unit, not a token', () => {
    // USDC
    const monadUsdc = getToken(
      'monad',
      '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea',
    )
    expect(monadUsdc).toBeDefined()
    expect(monadUsdc?.symbol).toBe('USDC')
    expect(monadUsdc?.decimals).toBe(6)
    expect(monadUsdc?.hasPermit).toBe(true)
    expect(monadUsdc?.standard).toBe('erc20')

    const ethUsdc = getToken(
      'ethereum',
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    )
    expect(ethUsdc).toBeDefined()
    expect(ethUsdc?.symbol).toBe('USDC')

    const solUsdc = getToken(
      'solana',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    )
    expect(solUsdc).toBeDefined()
    expect(solUsdc?.standard).toBe('spl')

    // USDT
    const ethUsdt = getToken(
      'ethereum',
      '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    )
    expect(ethUsdt).toBeDefined()
    expect(ethUsdt?.symbol).toBe('USDT')

    // AVU is a unit of account, never a token
    expect(
      getToken('monad', '0x0000000000000000000000000000000000000A70'),
    ).toBeUndefined()
    for (const chain of ['monad', 'ethereum', 'solana', 'xec'])
      expect(listTokensForChain(chain).map(t => t.symbol)).not.toContain('AVU')

    // Native coins
    const mon = getToken('monad', 'MON')
    expect(mon?.standard).toBe('native')

    const sol = getToken('solana', 'SOL')
    expect(sol?.standard).toBe('native')

    const eth = getToken('ethereum', 'ETH')
    expect(eth?.standard).toBe('native')

    const xec = getToken('xec', 'XEC')
    expect(xec?.standard).toBe('native')
  })

  it('resolves tokens by chain aliases and case-insensitively', () => {
    // Numeric chain ID 10143 and lowercase address
    const t1 = getToken('10143', '0xf817257fed379853cde0fa4f97ab987181b1e5ea')
    expect(t1?.symbol).toBe('USDC')

    // 'monad-testnet' alias
    const t2 = getToken('monad-testnet', 'USDC')
    expect(t2?.contractAddress).toBe(
      '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea',
    )

    // Chain 1 for Ethereum
    const t3 = getToken(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    expect(t3?.symbol).toBe('USDC')
  })

  it('lists whitelisted tokens for a chain', () => {
    const monadTokens = listTokensForChain('monad')
    expect(monadTokens.map(t => t.symbol)).toContain('USDC')
    expect(monadTokens.map(t => t.symbol)).toContain('USDT')
    expect(monadTokens.map(t => t.symbol)).toContain('MON')

    const solTokens = listTokensForChain('solana')
    expect(solTokens.map(t => t.symbol)).toContain('USDC')
    expect(solTokens.map(t => t.symbol)).toContain('SOL')
  })

  it('supports custom token registration in a registry instance', () => {
    const registry = new TokenRegistry([])
    const custom: TokenDefinition = {
      symbol: 'CUSTOM',
      name: 'Custom Token',
      contractAddress: '0x1234567890123456789012345678901234567890',
      chainId: 'monad',
      decimals: 18,
      hasPermit: false,
      standard: 'erc20',
    }
    registry.registerToken(custom)
    expect(registry.getToken('monad', 'CUSTOM')).toEqual(custom)
    expect(
      registry.getToken('monad', '0x1234567890123456789012345678901234567890'),
    ).toEqual(custom)
    expect(registry.getToken('monad', 'UNKNOWN')).toBeUndefined()
  })
})

describe('TokenUtxoStore (ticket #1153)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-utxo-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('serializes and deserializes bigint amounts without precision loss', () => {
    const record: TokenUtxoRecord = {
      id: 'utxo-1',
      chainId: 'monad',
      tokenAddress: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea',
      recipientAddress: '0x2222222222222222222222222222222222222222',
      amount: 123456789012345678901234567890n,
      status: 'unspent',
      receivedAt: 1700000000,
      derivationIndex: 3,
      txHash: '0xabcd1234',
    }

    const raw = serializeTokenUtxo(record)
    const parsed = deserializeTokenUtxo(raw)
    expect(parsed.amount).toBe(123456789012345678901234567890n)
    expect(parsed).toEqual(record)
  })

  it('puts, gets, and aggregates unspent token balances locally with zero RPC calls', async () => {
    const store = new TokenUtxoStore(tmpDir)
    await store.open()

    const tokenAddr = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea'

    // Note 1: 50 USDC
    const note1: TokenUtxoRecord = {
      id: 'note-1',
      chainId: 'monad',
      tokenAddress: tokenAddr,
      recipientAddress: '0x1111111111111111111111111111111111111111',
      amount: 50_000_000n,
      status: 'unspent',
      receivedAt: Date.now(),
      derivationIndex: 0,
    }

    // Note 2: 25 USDC
    const note2: TokenUtxoRecord = {
      id: 'note-2',
      chainId: 'monad',
      tokenAddress: tokenAddr,
      recipientAddress: '0x2222222222222222222222222222222222222222',
      amount: 25_000_000n,
      status: 'unspent',
      receivedAt: Date.now() + 1000,
      derivationIndex: 1,
    }

    // Note 3: a different token
    const otherTokenAddr = '0x88b8E2161DEDC77EF4ab7585569D2415a1C10552'
    const note3: TokenUtxoRecord = {
      id: 'note-3',
      chainId: 'monad',
      tokenAddress: otherTokenAddr,
      recipientAddress: '0x1111111111111111111111111111111111111111',
      amount: 10_000_000n, // 10 USDT
      status: 'unspent',
      receivedAt: Date.now() + 2000,
    }

    await store.putUtxo(note1)
    await store.putUtxo(note2)
    await store.putUtxo(note3)

    // Verify individual retrieval
    const fetched1 = await store.getUtxo('note-1')
    expect(fetched1).toEqual(note1)

    // Verify unspent list
    const unspentUsdc = await store.listUnspentByToken('monad', tokenAddr)
    expect(unspentUsdc).toHaveLength(2)
    expect(unspentUsdc.map(n => n.id)).toEqual(['note-1', 'note-2'])

    // Verify balance aggregation: 50 + 25 = 75 USDC
    const totalUsdc = await store.getTotalBalance('monad', tokenAddr)
    expect(totalUsdc).toBe(75_000_000n)

    const totalOther = await store.getTotalBalance('monad', otherTokenAddr)
    expect(totalOther).toBe(10_000_000n)

    // Mark note1 as spent
    await store.markSpent('note-1', '0xspendtxhash123')
    const note1Spent = await store.getUtxo('note-1')
    expect(note1Spent?.status).toBe('spent')
    expect(note1Spent?.txHash).toBe('0xspendtxhash123')

    // Balance after spending note1 should only be 25 USDC
    const balanceAfterSpend = await store.getTotalBalance('monad', tokenAddr)
    expect(balanceAfterSpend).toBe(25_000_000n)

    // Mark note2 as leased
    await store.markLeased('note-2')
    const balanceAfterLease = await store.getTotalBalance('monad', tokenAddr)
    expect(balanceAfterLease).toBe(0n)

    await store.close()
  })

  it('persists records and balances across LevelDB restart (close and reopen)', async () => {
    const tokenAddr = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea'

    // First store instance
    const store1 = new TokenUtxoStore(tmpDir)
    await store1.open()

    await store1.putUtxo({
      id: 'persisted-1',
      chainId: '10143',
      tokenAddress: tokenAddr,
      recipientAddress: '0x1111111111111111111111111111111111111111',
      amount: 100_000_000n,
      status: 'unspent',
      receivedAt: 123456,
      derivationIndex: 5,
    })

    await store1.putUtxo({
      id: 'persisted-2',
      chainId: 'monad',
      tokenAddress: tokenAddr,
      recipientAddress: '0x2222222222222222222222222222222222222222',
      amount: 200_000_000n,
      status: 'spent',
      receivedAt: 123457,
      txHash: '0xspent',
    })

    await store1.close()

    // Second store instance reopening the exact same directory
    const store2 = new TokenUtxoStore(tmpDir)
    await store2.open()

    const note1 = await store2.getUtxo('persisted-1')
    expect(note1).toBeDefined()
    expect(note1?.amount).toBe(100_000_000n)
    expect(note1?.status).toBe('unspent')
    expect(note1?.derivationIndex).toBe(5)

    const note2 = await store2.getUtxo('persisted-2')
    expect(note2?.status).toBe('spent')
    expect(note2?.txHash).toBe('0xspent')

    // Local balance calculation directly from reloaded LevelDB:
    const balance = await store2.getTotalBalance('monad', tokenAddr)
    expect(balance).toBe(100_000_000n)

    await store2.close()
  })
})
