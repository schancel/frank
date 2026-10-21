import { defineStore } from 'pinia'
import { readStoreJson } from 'src/boot/pinia'

export interface State {
  token: string | null
}

export const useRelayClientStore = defineStore('relayClient', {
  state: (): State => ({ token: null }),
  actions: {
    setToken(token: string) {
      this.token = token
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      return storage.put('relayClient', JSON.stringify(state))
    },
    async restore(storage): Promise<Partial<State>> {
      return (await readStoreJson<State>(storage, 'relayClient')) ?? {}
    },
  },
})
