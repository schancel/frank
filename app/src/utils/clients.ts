import assert from 'assert'
import RelayClient from '@frank/cashweb/relay'
import { Wallet } from '@frank/cashweb/legacy-wallet'
import type { WalletHandle } from '@frank/wallet/chain'

let wallet: Wallet | null = null
export function useWallet(newWallet?: Wallet) {
  if (newWallet) {
    wallet = newWallet
  }
  assert(wallet, 'Attempting to use wallet before setup')
  return wallet
}

let relayClient: RelayClient | null = null
export function useRelayClient(newRelayClient?: RelayClient) {
  if (newRelayClient) {
    relayClient = newRelayClient
  }
  assert(relayClient, 'Attempting to use relayClient before setup')
  return relayClient
}

/** Singleton accessor for the app's `ActiveChain` `WalletHandle` (ticket #42), mirroring
 * `useWallet`/`useRelayClient`'s established pattern above. Set once by
 * `src/boot/monad-direct-messages.ts`; `stores/chats.ts`'s `sendMessage` action and any UI wiring
 * to it (ticket #44's job -- see `PLAN.md`'s M9 section) read it via this accessor. */
let monadWallet: WalletHandle | null = null
export function useMonadWallet(newWallet?: WalletHandle) {
  if (newWallet) {
    monadWallet = newWallet
  }
  assert(monadWallet, 'Attempting to use Monad wallet before setup')
  return monadWallet
}
