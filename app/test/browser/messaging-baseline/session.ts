// Public UI/session boundary only: this fixture does not establish custody/restoration coverage.
export * from '../../../src/accounts/session.original'
import { readonly } from 'vue'
import {
  status,
  initialize,
  getWallet,
  peekWallet,
  unsupported,
} from './runtime'
import type { accountSession as original } from '../../../src/accounts/session.original'
export const accountStatus = readonly(status)
export const accountSession = {
  state: accountStatus,
  initialize,
  getWallet,
  peekWallet,
  async getChainAddress() {
    return (await getWallet()).identity.displayAddress
  },
  async close() {
    status.status = 'unavailable'
  },
  setStandby() {
    status.status = 'standby'
  },
  async createDappPersonaSigner() {
    return unsupported('dApp signer')
  },
  async createDappSolanaSigner() {
    return unsupported('Solana signer')
  },
} satisfies Pick<
  typeof original,
  | 'state'
  | 'initialize'
  | 'getWallet'
  | 'peekWallet'
  | 'getChainAddress'
  | 'close'
  | 'setStandby'
  | 'createDappPersonaSigner'
  | 'createDappSolanaSigner'
>
