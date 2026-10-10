import {
  UsernameError,
  claimUsername,
  type UsernameSigner,
} from '@frank/cashweb/relay/username-client'
import { canonicalNetworkDescriptor } from '@frank/cashweb/relay/canonical-dm-transport'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import { useActiveWallet } from '../composables/useActiveWallet'

/** The i18n key that tells the user why a username could not be set. */
export function usernameErrorKey(error: unknown): string {
  if (!(error instanceof UsernameError)) return 'profile.usernameUnavailable'
  switch (error.code) {
    case 'taken':
      return 'profile.usernameTaken'
    case 'invalid-username':
      return 'profile.invalidUsername'
    case 'not-published':
      return 'profile.usernameNotPublished'
    default:
      return 'profile.usernameUnavailable'
  }
}

/**
 * Claim `username` on the relay for the active account's identity key. Resolves when the account
 * holds the name; throws `UsernameError` when it does not (taken, invalid, relay unreachable).
 * Without an unlocked wallet there is nothing to sign with and nothing is claimed.
 */
export async function claimOwnUsername(username: string): Promise<void> {
  let wallet: Awaited<ReturnType<typeof useActiveWallet>>
  try {
    wallet = await useActiveWallet()
  } catch {
    return
  }
  const identity = (wallet as unknown as { identity?: UsernameSigner }).identity
  if (!identity) return
  const config = loadMonadChainConfigFromEnv()
  await claimUsername({
    relayBaseUrl:
      (wallet as { relayBaseUrl?: string }).relayBaseUrl ?? config.relayBaseUrl,
    network: canonicalNetworkDescriptor(config.networkTag).network,
    signer: identity,
    username,
  })
}
