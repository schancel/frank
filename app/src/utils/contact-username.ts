/**
 * A contact's @username comes from the relay's name store and nowhere else.
 *
 * A profile can say anything about itself, including a username it does not hold, so nothing a
 * profile declares is ever shown or matched as a handle. The relay gives a name to one account
 * only; these helpers ask it which name an address holds and which address holds a name.
 *
 * A contact is its address. Adding someone by username resolves the name once; afterwards the
 * contact stays that address even if the name later points to another account.
 */
import {
  lookupUsername,
  usernamesOfAddresses,
} from '@frank/cashweb/relay/username-client'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'

export interface ContactHandle {
  /** The name the relay says this address holds now, or `null` when it holds none. */
  username: string | null
  /** The name this contact was added by is now held by a different account. */
  reassigned: boolean
}

/**
 * What the relay says about `address`: the name it holds, and whether the name the contact was
 * added by (if any) has moved to another account. `undefined` when the relay could not be
 * asked; the caller then keeps what it knew.
 */
export async function relayHandleOf(
  address: string,
  addedByUsername?: string | null,
): Promise<ContactHandle | undefined> {
  try {
    const relayBaseUrl = loadMonadChainConfigFromEnv().relayBaseUrl
    const own = address.toLowerCase()
    const held = (
      await usernamesOfAddresses({ relayBaseUrl, addresses: [own] })
    ).find(user => user.address === own)
    const username = held?.username ?? null
    if (!addedByUsername || addedByUsername === username)
      return { username, reassigned: false }
    const holder = await lookupUsername({
      relayBaseUrl,
      username: addedByUsername,
    })
    return {
      username,
      reassigned: holder !== undefined && holder.address !== own,
    }
  } catch {
    return undefined
  }
}

/**
 * The account that holds `username` on the relay right now, or `undefined` when nobody does.
 * Throws when the relay could not be asked.
 */
export async function resolveUsername(
  username: string,
): Promise<{ username: string; address: string } | undefined> {
  const holder = await lookupUsername({
    relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
    username,
  })
  return holder && { username: holder.username, address: holder.address }
}
