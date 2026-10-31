/** @jest-environment jsdom */
import { defineComponent, h, reactive, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useReceivedPayment } from './useReceivedPayment'
import { peekActiveWallet } from './useActiveWallet'
import { receivedValueRevision } from '../utils/message-receipts'
import {
  EvmCoinList,
  type StoredEvmListCoin,
} from '@frank/wallet/evm-coin-list'
import { EvmCoinListSync } from '@frank/wallet/evm-coin-list-sync'
import { EvmBlockWatcher } from '@frank/wallet/evm-block-watcher'
import { receivedAccountBalanceSnapshot } from '@frank/wallet/evm-wallet-coin-list'
import {
  createEvmReceivedCoinAndContactManager,
  type EvmReceivedCoinAndContactManagerParams,
} from '@frank/wallet/evm-received-coin-manager'
import {
  MemoryRecordStore,
  type EvmCoin,
} from '@frank/wallet/storage/evm-coin-store'
import type { Provider } from 'ethers'
const mockSessionState = reactive({
  status: 'ready',
  revision: 1,
  account: null,
})
jest.mock('../accounts/session', () => ({
  accountSession: {
    get state() {
      return mockSessionState
    },
  },
}))
jest.mock('../utils/message-receipts', () => ({
  receivedValueRevision: jest.requireActual('vue').ref(0),
}))
jest.mock('./useActiveWallet', () => ({
  peekActiveWallet: jest.fn(),
  useActiveWallet: jest.fn(),
}))
it.each([8, 16, 32])(
  'indexes one real inventory snapshot per revision for %i mounted cards',
  async n => {
    const receipts = new MemoryRecordStore<EvmCoin>()
    const keys = Array.from(
      { length: n },
      (_, i) => '02' + (i + 1).toString(16).padStart(64, '0'),
    )
    for (let i = 0; i < n; i++)
      await receipts.put('receipt-' + i, {
        address: '0x' + (i + 1).toString(16).padStart(40, '0'),
        privateKey: '',
        origin: 'stealth',
        state: 'unspent',
        amountWei: '200',
        receivedAmountWei: '200',
        claimedAmountWei: '200',
        discoveredAtMs: 1,
        checkedAtMs: 2,
        transactions: ['ab'.repeat(32)],
        ephemeralPubKey: keys[i],
        payloadDigest: 'aa'.repeat(32),
      })
    const list = await EvmCoinList.open(
      new MemoryRecordStore<StoredEvmListCoin>(),
    )
    const forbidden = jest.fn(() => {
      throw new Error('RPC forbidden in read-only probe')
    })
    const rpc = {
      getBlockNumber: forbidden,
      getBalance: forbidden,
      getTransactionCount: forbidden,
    }
    const sync = new EvmCoinListSync({
      list,
      provider: rpc as unknown as Provider,
      watcher: new EvmBlockWatcher({ provider: rpc }),
      sources: () => [],
    })
    const snapshot = jest.fn((addresses: readonly string[]) =>
      receivedAccountBalanceSnapshot(list, sync, addresses),
    )
    const manager = createEvmReceivedCoinAndContactManager({
      chainIdentifier: 'monad-regtest',
      chainId: 20143n,
      coinStore: receipts,
      provider: rpc,
      currentReceivedBalances: snapshot,
      receivedCoinFloorWei: () => 10n,
    } as unknown as EvmReceivedCoinAndContactManagerParams)
    const getter = jest.spyOn(manager, 'getReceivedPayments')
    const all = jest.spyOn(list, 'all')
    const dirty = jest.spyOn(sync, 'isDirty')
    const empty = jest.spyOn(sync, 'hasObservedEmpty')
    const refresh = jest.fn(() => {
      throw new Error('Recovery forbidden for received cards')
    })
    ;(peekActiveWallet as jest.Mock).mockReturnValue({
      getReceivedPayments: manager.getReceivedPayments,
      refreshReceivedPayments: refresh,
    })
    const wrappers = keys.map(key =>
      mount(
        defineComponent({
          setup() {
            const { payment } = useReceivedPayment(() => key)
            return () => h('div', payment.value?.status)
          },
        }),
      ),
    )
    await nextTick()
    expect(wrappers.every(w => w.text() === 'received')).toBe(true)
    const reset = () => {
      getter.mockClear()
      snapshot.mockClear()
      all.mockClear()
      dirty.mockClear()
      empty.mockClear()
    }
    const counts = () => ({
      getter: getter.mock.calls.length,
      snapshots: snapshot.mock.calls.length,
      addressVisits: snapshot.mock.calls.reduce((a, c) => a + c[0].length, 0),
      listScans: all.mock.calls.length,
      dirtyChecks: dirty.mock.calls.length,
      emptyChecks: empty.mock.calls.length,
      rpc: forbidden.mock.calls.length,
      recovery: refresh.mock.calls.length,
    })
    try {
      reset()
      receivedValueRevision.value++
      const immediate = counts()
      await nextTick()
      const afterVueFlush = counts()
      expect(immediate).toEqual({
        getter: 1,
        snapshots: 1,
        addressVisits: n,
        listScans: 1,
        dirtyChecks: n,
        emptyChecks: n,
        rpc: 0,
        recovery: 0,
      })
      expect(afterVueFlush).toEqual(immediate)
      reset()
      receivedValueRevision.value++
      receivedValueRevision.value++
      const sameTurnTwoTicks = counts()
      expect(sameTurnTwoTicks.getter).toBe(2)
      expect(sameTurnTwoTicks.dirtyChecks).toBe(2 * n)
      wrappers.forEach(w => w.unmount())
      reset()
      receivedValueRevision.value++
      await nextTick()
      const unmounted = counts()
      expect(unmounted.getter).toBe(0)
    } finally {
      wrappers.forEach(w => w.unmount())
      await sync.stop()
    }
  },
)
