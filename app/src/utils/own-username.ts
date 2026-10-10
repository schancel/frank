/**
 * The username this account holds, as the relay confirms it.
 *
 * The profile store remembers the name the user asked for. Whether the account actually holds
 * it is the relay's answer, kept here: everything that shows the user's own @username reads
 * `ownUsername.held`, and `ownUsername.problem` says why a saved name is not held.
 */
import { reactive } from 'vue'
import {
  claimUsername,
  usernamesOfAddresses,
  type UsernameSigner,
} from '@frank/cashweb/relay/username-client'
import { usernameErrorKey } from './username-claim'

export const ownUsername = reactive({
  /** The name the relay says this account holds, or `null`. */
  held: null as string | null,
  /** The saved name that is not held, when claiming it again was refused or failed. */
  wanted: null as string | null,
  /** i18n key saying why `wanted` is not held. */
  problem: null as string | null,
})

/** Record that the relay accepted a claim for `username` (or that the account holds none). */
export function setOwnUsername(username: string | null): void {
  ownUsername.held = username
  ownUsername.wanted = null
  ownUsername.problem = null
}

/** Forget everything, e.g. when the account changes. */
export function clearOwnUsername(): void {
  setOwnUsername(null)
}

/**
 * Bring `ownUsername` in line with the relay. With a saved name, claim it again (a no-op when
 * the account already holds it, and what restores it on a relay with a fresh database); if the
 * relay refuses, record why. Then ask the relay which name the account really holds.
 */
export async function syncOwnUsername(options: {
  relayBaseUrl: string
  network: string
  signer: UsernameSigner
  address: string
  saved?: string | null
}): Promise<void> {
  const { relayBaseUrl, network, signer, saved } = options
  if (saved) {
    try {
      const entry = await claimUsername({
        relayBaseUrl,
        network,
        signer,
        username: saved,
      })
      setOwnUsername(entry.username)
      return
    } catch (error) {
      ownUsername.wanted = saved
      ownUsername.problem = usernameErrorKey(error)
    }
  } else {
    ownUsername.wanted = null
    ownUsername.problem = null
  }
  const address = options.address.toLowerCase()
  try {
    const held = (
      await usernamesOfAddresses({ relayBaseUrl, addresses: [address] })
    ).find(user => user.address === address)
    ownUsername.held = held?.username ?? null
  } catch {
    // The relay could not be asked: what was known stays.
  }
}
