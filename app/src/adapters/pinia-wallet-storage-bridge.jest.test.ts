/** @jest-environment jsdom */
import {
  createObservableWalletStorage,
  attachPiniaWalletStorageBridge,
  useWalletStorageState,
  WALLET_STORAGE_CHANGE_EVENT,
} from './pinia-wallet-storage-bridge';
import { createWalletStorage } from '@frank/wallet/storage/wallet-storage-adapter';

describe('Pinia Wallet Storage Bridge', () => {
  it('updates reactive state and dispatches global event on storage set', async () => {
    const dispatchSpy = jest.spyOn(globalThis, 'dispatchEvent');
    const onBalance = jest.fn();

    const storage = createObservableWalletStorage('monad-main', {
      inMemory: true,
      onBalanceChange: onBalance,
    });

    const reactiveState = useWalletStorageState('monad-main');

    await storage.set('balance', 2500000000000000000n);
    await storage.set('primaryAddress', '0x1234567890123456789012345678901234567890');

    expect(reactiveState.balance).toBe(2500000000000000000n);
    expect(reactiveState.primaryAddress).toBe('0x1234567890123456789012345678901234567890');
    expect(onBalance).toHaveBeenCalledWith('monad-main', 2500000000000000000n);

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WALLET_STORAGE_CHANGE_EVENT,
      })
    );

    dispatchSpy.mockRestore();
  });

  it('updates reactive state on delete and clear', async () => {
    const storage = createWalletStorage('btc-test', { inMemory: true });
    const unsubscribe = attachPiniaWalletStorageBridge(storage);

    const reactiveState = useWalletStorageState('btc-test');

    await storage.set('utxos', ['tx1:0', 'tx2:1']);
    expect(reactiveState.utxos).toEqual(['tx1:0', 'tx2:1']);

    await storage.delete('utxos');
    expect(reactiveState.utxos).toBeUndefined();

    await storage.set('foo', 'bar');
    await storage.clear();
    expect(reactiveState.foo).toBeUndefined();

    unsubscribe();
  });
});
