import { defineStore } from 'pinia'
import { markRaw, toRaw } from 'vue'

import { calcUtxoId } from '@frank/cashweb/legacy-wallet/helpers'
import { store as levelOutpointStore } from '../adapters/level-utxo-store'
import { HDPrivateKey } from 'bitcore-lib-xpi'
import { Utxo } from '@frank/cashweb/types/utxo'

export interface State {
  xPrivKey: HDPrivateKey | null
  utxos: Record<string, number | undefined>
  seedPhrase: string | null
  /**
   * Epoch ms at which the user proved they hold the CURRENT seedPhrase (recovery-phrase
   * confirmation in onboarding, or an Import). null = never confirmed, including every
   * account stored before this field existed.
   */
  seedConfirmedAt: number | null
  balance: number
  feePerByte: number
}

const defaultWalletState: State = {
  feePerByte: 2,
  utxos: {},
  balance: 0,
  seedPhrase: null,
  seedConfirmedAt: null,
  xPrivKey: null,
}

export type RestorableState = Omit<State, 'xPrivKey' | 'seedConfirmedAt'> & {
  xPrivKey: unknown
  // Absent in data stored before the confirmation marker existed.
  seedConfirmedAt?: number | null
}

export async function rehydrateWallet(wallet: RestorableState): Promise<State> {
  if (!wallet || !wallet.xPrivKey) {
    return {
      ...defaultWalletState,
      seedPhrase: wallet.seedPhrase,
      seedConfirmedAt: wallet.seedConfirmedAt ?? null,
    }
  }
  let balance = 0
  const utxos: Record<string, number> = {}
  // FIXME: This shouldn't be necessary, but the GUI needs real time
  // balance updates. In the future, we should just aggregate a total over time here.
  const store = await levelOutpointStore
  await store.loadData()
  const utxoMap = store.getUtxoMap()
  for (const [utxoId, utxo] of utxoMap) {
    if (!utxo.address) {
      continue
    }
    utxos[utxoId] = utxo.satoshis
    balance += utxo.satoshis
  }
  return {
    feePerByte: wallet.feePerByte || 2,
    balance,
    utxos,
    seedPhrase: wallet.seedPhrase,
    seedConfirmedAt: wallet.seedConfirmedAt ?? null,
    xPrivKey: markRaw(HDPrivateKey.fromObject(wallet.xPrivKey)),
  }
}

export function saveWallet(
  storage: { put(key: string, value: string): Promise<void> },
  state: State,
): Promise<void> {
  const wallet = {
    xPrivKey: state.xPrivKey ? toRaw(state.xPrivKey).toObject() : null,
    seedPhrase: state.seedPhrase,
    seedConfirmedAt: state.seedConfirmedAt,
    utxos: {},
    feePerByte: 2,
    balance: 0,
  }
  return storage.put('wallet', JSON.stringify(wallet))
}

export async function restoreWallet(storage: {
  get(key: string): Promise<string>
}): Promise<Partial<State>> {
  let wallet = '{}'
  try {
    wallet = await storage.get('wallet')
  } catch (err) {
    //
  }
  const deserializedWallet = JSON.parse(wallet) as RestorableState
  return rehydrateWallet(deserializedWallet)
}

export const useWalletStore = defineStore('wallet', {
  state: (): State => ({
    ...defaultWalletState,
  }),
  actions: {
    reset() {
      this.xPrivKey = null
      this.utxos = {}
      this.balance = 0
    },
    setXPrivKey(xPrivKey: HDPrivateKey) {
      this.xPrivKey = markRaw(xPrivKey)
    },
    /**
     * Store the seed and its confirmation marker in ONE state write (one persisted snapshot).
     * A confirmation only ever vouches for the phrase it was made against: keeping the same
     * phrase keeps its marker, a different phrase starts unconfirmed unless `confirmedAt` says
     * otherwise.
     */
    setSeedPhrase(seedPhrase: string, confirmedAt: number | null = null) {
      const previous =
        this.seedPhrase === seedPhrase ? this.seedConfirmedAt : null
      this.seedPhrase = seedPhrase
      this.seedConfirmedAt = confirmedAt ?? previous
    },
    removeUTXO(id: string) {
      this.balance -= this.utxos[id] ?? 0
      delete this.utxos[id]
    },
    addUTXO(utxo: Utxo) {
      const utxoId = calcUtxoId(utxo)
      if (utxoId in this.utxos) {
        return
      }
      this.balance += utxo.satoshis
      this.utxos[utxoId] = utxo.satoshis
    },
  },
  storage: {
    save: (storage, _mutation, state) => saveWallet(storage, state),
    restore: storage => restoreWallet(storage),
  },
})
