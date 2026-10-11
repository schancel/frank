import {
  UsernameError,
  claimUsername,
  type UsernameSigner,
} from '@frank/cashweb/relay/username-client'
import { canonicalNetworkDescriptor } from '@frank/cashweb/relay/canonical-dm-transport'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import { useActiveWallet } from '../composables/useActiveWallet'

/** There is no unlocked account to sign a username claim with. */
export class NoWalletForUsernameError extends Error {
  constructor() {
    super('No unlocked account to claim a username with')
    this.name = 'NoWalletForUsernameError'
  }
}

/** The i18n key that tells the user why a username could not be set. */
export function usernameErrorKey(error: unknown): string {
  if (error instanceof NoWalletForUsernameError)
    return 'profile.usernameNoWallet'
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
 * Claim `username` on the relay for the active account's identity key. Resolves with the name
 * the account now holds; throws `UsernameError` when the relay does not give it (taken,
 * invalid, unreachable) and `NoWalletForUsernameError` when there is no unlocked account to
 * sign with.
 */
export async function claimOwnUsername(
  username: string,
  expectedOwner?: string,
): Promise<string> {
  let wallet: Awaited<ReturnType<typeof useActiveWallet>>
  try {
    wallet = await useActiveWallet()
  } catch {
    throw new NoWalletForUsernameError()
  }
  const identity = (wallet as unknown as { identity?: UsernameSigner }).identity
  if (!identity) throw new NoWalletForUsernameError()
  if (
    expectedOwner &&
    wallet.identity.address.raw.toLowerCase() !== expectedOwner.toLowerCase()
  )
    throw new NoWalletForUsernameError()
  const config = loadMonadChainConfigFromEnv()
  const entry = await claimUsername({
    relayBaseUrl:
      (wallet as { relayBaseUrl?: string }).relayBaseUrl ?? config.relayBaseUrl,
    network: canonicalNetworkDescriptor(config.networkTag).network,
    signer: identity,
    username,
  })
  return entry.username
}
