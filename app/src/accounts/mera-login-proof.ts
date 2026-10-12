import axios from 'axios'
import { decodeProfileBytes, isCborFrame } from '@frank/wallet/monad-identity'

export type MeraLoginVerification = 'existing' | 'unverified' | 'unreachable'

/** Read-only proof for automatic login. Legacy protobuf decoding does not verify signatures. */
export async function verifyMeraLoginProfile(
  relayBaseUrl: string,
  address: string,
): Promise<MeraLoginVerification> {
  let raw: Uint8Array
  try {
    const response = await axios({
      method: 'get',
      url: `${relayBaseUrl.replace(/\/+$/, '')}/metadata/${address}`,
      responseType: 'arraybuffer',
      signal: AbortSignal.timeout(10000),
    })
    raw = new Uint8Array(response.data)
  } catch (error) {
    return axios.isAxiosError(error) && error.response?.status === 404
      ? 'unverified'
      : 'unreachable'
  }
  if (!isCborFrame(raw)) return 'unverified'
  try {
    // The CBOR branch validates full frame signatures, subject ownership and address binding.
    const profile = decodeProfileBytes(raw, { expectedAddress: address })
    if (profile.expiresAtMs !== undefined && profile.expiresAtMs <= Date.now())
      return 'unverified'
    return 'existing'
  } catch {
    return 'unverified'
  }
}
