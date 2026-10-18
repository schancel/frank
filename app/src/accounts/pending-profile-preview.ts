import axios from 'axios'
import { usernamesOfAddresses } from '@frank/cashweb/relay/username-client'
import { decodeProfileBytes, isCborFrame } from '@frank/wallet/evm-identity'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/evm-chain'

export class PendingProfilePreviewError extends Error {
  constructor(readonly code: 'unreachable' | 'unverified') {
    super(code)
  }
}

/** Read public presentation before activation without opening custody or changing local state. */
export async function readPendingProfilePreview(options: {
  relayBaseUrl: string
  address: string
  signal?: AbortSignal
}): Promise<{ name?: string; username?: string } | undefined> {
  const { relayBaseUrl, address, signal } = options
  let raw: Uint8Array
  try {
    const response = await axios({
      method: 'get',
      url: `${relayBaseUrl.replace(/\/+$/, '')}/metadata/${address}`,
      responseType: 'arraybuffer',
      signal,
    })
    raw = new Uint8Array(response.data)
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404)
      return undefined
    throw new PendingProfilePreviewError('unreachable')
  }

  // Legacy protobuf decoding checks address derivation but does not verify its signature.
  if (!isCborFrame(raw)) throw new PendingProfilePreviewError('unverified')
  let name: string | undefined
  try {
    const profile = decodeProfileBytes(raw, {
      expectedAddress: address,
      expectedNetwork: loadMonadChainConfigFromEnv().rpcChain,
    })
    if (profile.expiresAtMs !== undefined && profile.expiresAtMs <= Date.now())
      throw new Error('expired')
    name = profile.name?.trim() || undefined
  } catch {
    throw new PendingProfilePreviewError('unverified')
  }

  // A profile may claim any username. Only the relay's current name registry owns that fact.
  try {
    const names = await usernamesOfAddresses({
      relayBaseUrl,
      addresses: [address],
      fetch: signal
        ? (input, init) =>
            fetch(input, {
              ...init,
              body:
                init?.body === undefined
                  ? undefined
                  : Uint8Array.from(init.body).buffer,
              signal,
            })
        : undefined,
    })
    const username = names.find(
      entry => entry.address.toLowerCase() === address.toLowerCase(),
    )?.username
    return { name, username }
  } catch {
    throw new PendingProfilePreviewError('unreachable')
  }
}
