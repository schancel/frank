import {
  createWalletStorage,
  listAllocatedWalletDatabases,
  deleteWalletDatabase,
  clearAllWalletDatabases,
  type StorageChangeEvent,
} from './wallet-storage-adapter';

describe('WalletStorageAdapter', () => {
  beforeEach(async () => {
    await clearAllWalletDatabases();
  });

  afterEach(async () => {
    await clearAllWalletDatabases();
  });

  it('provides isolated in-memory storage per walletId', async () => {
    const storage1 = createWalletStorage('wallet-1', { inMemory: true });
    const storage2 = createWalletStorage('wallet-2', { inMemory: true });

    await storage1.set('balance', 100n);
    await storage2.set('balance', 200n);

    expect(await storage1.get('balance')).toBe(100n);
    expect(await storage2.get('balance')).toBe(200n);

    expect(storage1.dbName).toBe('frank-wallet-wallet-1');
    expect(storage2.dbName).toBe('frank-wallet-wallet-2');
  });

  it('notifies subscribers on set, delete, and clear', async () => {
    const storage = createWalletStorage<bigint | string>('monad-primary', { inMemory: true });
    const events: StorageChangeEvent<any>[] = [];

    const unsubscribe = storage.subscribe((event) => {
      events.push(event);
    });

    await storage.set('balance', 1500000n);
    await storage.set('lastTxHash', '0xabc123');
    await storage.delete('lastTxHash');
    await storage.clear();

    expect(events).toEqual([
      {
        walletId: 'monad-primary',
        dbName: 'frank-wallet-monad-primary',
        key: 'balance',
        type: 'set',
        value: 1500000n,
        oldValue: undefined,
      },
      {
        walletId: 'monad-primary',
        dbName: 'frank-wallet-monad-primary',
        key: 'lastTxHash',
        type: 'set',
        value: '0xabc123',
        oldValue: undefined,
      },
      {
        walletId: 'monad-primary',
        dbName: 'frank-wallet-monad-primary',
        key: 'lastTxHash',
        type: 'delete',
        oldValue: '0xabc123',
      },
      {
        walletId: 'monad-primary',
        dbName: 'frank-wallet-monad-primary',
        key: '*',
        type: 'clear',
      },
    ]);

    unsubscribe();
    await storage.set('balance', 0n);
    expect(events).toHaveLength(4); // No new events after unsubscribe
  });

  it('lists keys with optional prefix filtering', async () => {
    const storage = createWalletStorage('solana-sub', { inMemory: true });
    await storage.set('addr:0', 'sol-addr-0');
    await storage.set('addr:1', 'sol-addr-1');
    await storage.set('meta:name', 'Trading Subaccount');

    const allKeys = await storage.listKeys();
    expect(allKeys.sort()).toEqual(['addr:0', 'addr:1', 'meta:name']);

    const addrKeys = await storage.listKeys('addr:');
    expect(addrKeys.sort()).toEqual(['addr:0', 'addr:1']);
  });

  it('tracks allocated wallet database names in the registry manifest', async () => {
    createWalletStorage('btc-wallet', { inMemory: true });
    createWalletStorage('eth-wallet', { inMemory: true });

    const dbs = await listAllocatedWalletDatabases();
    expect(dbs).toContain('frank-wallet-btc-wallet');
    expect(dbs).toContain('frank-wallet-eth-wallet');

    await deleteWalletDatabase('btc-wallet');
    const remaining = await listAllocatedWalletDatabases();
    expect(remaining).not.toContain('frank-wallet-btc-wallet');
    expect(remaining).toContain('frank-wallet-eth-wallet');
  });
});
