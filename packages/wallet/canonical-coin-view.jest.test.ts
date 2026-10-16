import { ChainUtxoPool, normalizeUtxoAddress, inferChainFamily } from './chain-utxo-pool'

import { PROTOCOL_CHAINS } from './chain/chains-registry'
import { MonadHdKeyring } from './evm-hd-keyring'
import { MonadChangeKeyring } from './evm-change-keyring'
import { MonadSubAccountPool } from './evm-account-pool'
import { MonadChangePool } from './evm-change-pool'
import { InMemoryChangePoolStore } from './storage/change-pool-storage'

describe('canonical coin view boundaries', () => {
  test('rejects aliases and supplied mismatching families without effects', () => {
    const pool = new ChainUtxoPool()
    for (const chainIdentifier of ['monad', 'MONAD-testnet', 'unknown']) {
      expect(() => pool.registerCoin({ chainIdentifier, address: '0x1234', privateKey: 'fixture' })).toThrow()
    }
    expect(() => pool.registerCoin({ chainIdentifier: 'solana-devnet', family: 'evm', address: 'abc', privateKey: 'fixture' })).toThrow()
    expect(() => pool.evm.registerSubAccount({ chainIdentifier: 'solana-devnet', family: 'solana', address: 'abc', privateKey: 'fixture', balanceWei: 1n })).toThrow('mismatch')
    expect(() => pool.evm.registerSubAccount({ chainIdentifier: 'monad-testnet', family: 'solana', address: 'abc', privateKey: 'fixture', balanceWei: 1n })).toThrow('mismatch')
    expect(() => pool.utxo.registerOutpoint({ chainIdentifier: 'monad-testnet', family: 'evm', address: 'abc', privateKey: 'fixture', txid: 'tx', vout: 0, balanceWei: 1n })).toThrow('mismatch')
    expect(pool.getAllCoins()).toEqual([])
  })
  test('isolates identical outpoints and their confirmation and spent state', () => {
    const pool = new ChainUtxoPool()
    for (const chainIdentifier of ['xec-testnet', 'btc-testnet']) {
      pool.utxo.registerOutpoint({ chainIdentifier, address: 'Base58Case', privateKey: 'fixture', txid: 'child', vout: 0, balanceWei: 10000n, parentTxHash: 'parent' })
    }
    pool.registerTxDependency('child', 'xec-only-parent', 'xec-testnet')
    expect(pool.getOutpointDependencies('child', 0, 'btc-testnet')).toEqual(['parent'])
    expect(pool.getTransactionDependencies('child', 'xec-testnet')).toEqual(['parent', 'xec-only-parent'])
    pool.markTransactionConfirmed('parent', 'xec-testnet')
    expect(pool.isTransactionConfirmed('parent', 'btc-testnet')).toBe(false)
    expect(pool.getMempoolAncestors('child', 'btc-testnet')).toEqual(new Set(['child', 'parent']))
    expect(pool.getMempoolAncestors('child', 'xec-testnet')).toEqual(new Set(['child', 'xec-only-parent']))
    pool.markOutpointSpent('child', 0, 'xec-testnet')
    expect(pool.getUtxoByOutpoint('child', 0, 'btc-testnet')?.status).toBe('clean')
    expect(normalizeUtxoAddress('Base58Case', 'btc-testnet')).toBe('Base58Case')
  })
  test('all registered networks use protocol family authority and preserve non-EVM address case', () => {
    for (const facts of Object.values(PROTOCOL_CHAINS)) {
      expect(inferChainFamily(facts.id)).toBe(facts.family === 'bitcoin' ? 'utxo' : facts.family)
      expect(normalizeUtxoAddress('0xAbC', facts.id)).toBe(facts.family === 'evm' ? '0xabc' : '0xAbC')
    }
  })

  test('address, custom IDs, hydration, archive and transaction queries retain canonical scope', () => {
    const pool = new ChainUtxoPool()
    const address = '0x1111111111111111111111111111111111111111'
    const a = pool.registerCoin({ id: 'monad-testnet:custom', chainIdentifier: 'monad-testnet', address, privateKey: 'fixture', balanceWei: 100n })
    const b = pool.registerCoin({ chainIdentifier: 'ethereum-sepolia', address, privateKey: 'fixture', balanceWei: 200n })
    expect(pool.getCoinsByAddress(address, 'monad-testnet')).toEqual([a])
    expect(pool.getCoinsByAddress(address, 'ethereum-sepolia')).toEqual([b])
    expect(() => pool.registerCoin({ ...b, id: a.id })).toThrow('scope')
    expect(() => new ChainUtxoPool([{ ...a, chainIdentifier: 'monad' }])).toThrow()
    expect(() => new ChainUtxoPool([{ ...a, family: 'solana' }])).toThrow()
    expect(() => pool.selectCoins({ chainIdentifier: 'monad-testnet', family: 'solana', targetAmountWei: 0n })).toThrow('mismatch')
    expect(() => pool.archiveSpentCoins({ chainIdentifier: 'monad' })).toThrow()
    expect(() => pool.getMempoolAncestors('tx', 'monad')).toThrow()
    expect(() => pool.markOutpointSpent('tx', 0, 'monad')).toThrow()
    pool.markPending(a.id)
    expect(pool.selectCoins({ chainIdentifier: 'ethereum-sepolia', targetAmountWei: 1n }).selected).toEqual([b])
    pool.markSpent(a.id)
    pool.archiveSpentCoins({ chainIdentifier: 'monad-testnet', maxAgeMs: 0 })
    expect(pool.getArchivedCoins('monad-testnet')).toEqual([a])
    expect(pool.getArchivedCoins('ethereum-sepolia')).toEqual([])
    expect(pool.getCoinsByAddress(address, 'ethereum-sepolia')).toEqual([b])
  })

  test.each(['monad-testnet', 'ethereum-sepolia'])('HD status and interrupted change completion register on %s', async chainIdentifier => {
    const bytes = new Uint8Array(32).fill(42)
    const keyring = MonadHdKeyring.fromDomainRoot({ purpose: 'evm-wallet', bytes })
    const changeKeyring = MonadChangeKeyring.fromDomainRoot({ purpose: 'evm-wallet', bytes })
    const view = new ChainUtxoPool()
    const hd = new MonadSubAccountPool({ keyring })
    hd.setAccountUtxoPool(view, chainIdentifier)
    await hd.ensureSize(1)
    await hd.setStatus(0, 'available')
    expect(view.getCoinsByAddress(keyring.deriveSubAccount(0).address, chainIdentifier)).toHaveLength(1)
    expect(() => hd.setAccountUtxoPool(view, 'solana-devnet')).toThrow('mismatch')
    expect(() => hd.setAccountUtxoPool(view, chainIdentifier === 'monad-testnet' ? 'ethereum-sepolia' : 'monad-testnet')).toThrow('rebind')
    const store = new InMemoryChangePoolStore()
    const destination = changeKeyring.deriveChangeAccount(0)
    store.setPendingIntent({ index: 0, address: destination.address, sourceBurnIndex: 0, sourceBurnAddress: keyring.deriveSubAccount(0).address,
      sweptValueWei: '123456', rawTx: 'fixture-raw', txHash: 'fixture-tx', createdAt: 1 })
    const change = new MonadChangePool({ keyring: changeKeyring, store })
    change.setAccountUtxoPool(view, chainIdentifier)
    await change.sweepToChange({ burnIndex: 0, burnAddress: keyring.deriveSubAccount(0).address,
      burnAccountSigner: { getStatus: async () => 'confirmed' } as never, provider: {} as never })
    expect(view.getCoinsByAddress(destination.address, chainIdentifier)[0].balanceWei).toBe(123456n)
    expect(() => change.setAccountUtxoPool(view, chainIdentifier === 'monad-testnet' ? 'ethereum-sepolia' : 'monad-testnet')).toThrow('rebind')
  })

})
