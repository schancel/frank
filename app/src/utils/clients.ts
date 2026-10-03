import assert from 'assert'
import type RelayClient from '@frank/cashweb/relay'
import type { Wallet } from '@frank/cashweb/legacy-wallet'
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

/** Legacy DM access fails closed for typed accounts until #696. */
export function useMonadWallet(_newWallet?: WalletHandle): WalletHandle {
  throw new Error('Messaging is unavailable for typed accounts in this preview')
}
