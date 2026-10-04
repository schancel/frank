/**
 * The one peer admitted through the operator-installed directory (#778), if messaging is ready.
 *
 * A canonical peer's identity and key come from the directory, never from a relay-served display
 * profile. A display profile, when one exists, only contributes its name, bio and avatar.
 */
import { activeChain } from '@frank/wallet/chain'

type ChainAddress = Parameters<typeof activeChain.fetchProfile>[0]
type ProfileInfo = NonNullable<
  Awaited<ReturnType<typeof activeChain.fetchProfile>>
>

let peer: { address: string; pubKey: Uint8Array } | null = null

/** Set by the messaging session while a verified directory is installed; cleared when it stops. */
export function setDirectoryPeer(
  value: { address: string; pubKey: Uint8Array } | null,
): void {
  peer = value
    ? { address: value.address.toLowerCase(), pubKey: value.pubKey.slice() }
    : null
}

function directoryKey(address: ChainAddress): Uint8Array | undefined {
  return peer !== null && address.raw.toLowerCase() === peer.address
    ? peer.pubKey.slice()
    : undefined
}

/** Profile used to create or refresh a contact. */
export async function fetchContactProfile(
  address: ChainAddress,
): Promise<ProfileInfo | undefined> {
  const pubKey = directoryKey(address)
  if (!pubKey) return activeChain.fetchProfile(address)
  let display: ProfileInfo | undefined
  try {
    display = await activeChain.fetchProfile(address)
  } catch {
    display = undefined
  }
  return { ...(display ?? {}), address, pubKey }
}
