import assert from 'assert'
import type RelayClient from '@frank/cashweb/relay'
import type { Wallet } from '@frank/cashweb/legacy-wallet'
import type { WalletHandle } from '@frank/wallet/chain'
import { messagingWallet } from './monad-identity-session'

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

/** The live typed wallet, available only while canonical messaging is verified ready (#778). */
export function useMonadWallet(_newWallet?: WalletHandle): WalletHandle {
  const wallet = messagingWallet()
  if (!wallet)
    throw new Error(
      'Messaging is pending operator directory installation. Open Settings > Networking.',
    )
  return wallet
}
