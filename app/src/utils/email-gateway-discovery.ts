export interface AdvertisedEmailGateway {
  address: string
  domain: string
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export async function discoverEmailGateway({
  relayBaseUrl,
  chainIdentifier,
  fetcher = fetch,
}: {
  relayBaseUrl: string
  chainIdentifier: string
  fetcher?: typeof fetch
}): Promise<AdvertisedEmailGateway | null> {
  const relayUrl = new URL(relayBaseUrl)
  if (
    relayUrl.protocol !== 'https:' &&
    !(
      relayUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(relayUrl.hostname)
    )
  )
    throw new Error('Email gateway relay must use HTTPS or local loopback')
  const origin = relayUrl.origin
  const response = await fetcher(`${origin}/relay/v1/info`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('Relay information is unavailable')
  const info: unknown = await response.json()
  if (!info || typeof info !== 'object')
    throw new Error('Invalid relay information')
  const record = info as Record<string, unknown>
  if (
    record.network !== chainIdentifier ||
    typeof record.endpoint !== 'string' ||
    new URL(record.endpoint).origin !== origin
  )
    throw new Error(
      'Email gateway relay identity does not match the selected network and relay',
    )
  if (record.emailGateway === undefined || record.emailGateway === null)
    return null
  const gateway = record.emailGateway
  if (!gateway || typeof gateway !== 'object')
    throw new Error('Invalid email gateway advertisement')
  const value = gateway as Record<string, unknown>
  if (
    'chainIdentifier' in value ||
    typeof value.address !== 'string' ||
    !ADDRESS.test(value.address) ||
    typeof value.domain !== 'string' ||
    !DOMAIN.test(value.domain)
  )
    throw new Error('Invalid email gateway advertisement')
  return { address: value.address, domain: value.domain }
}
