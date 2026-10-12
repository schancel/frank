/** Check the discovered host describes this exact HTTPS origin and canonical network before
 * asking it for a username. This is routing validation, not directory identity admission. */
export async function assertDiscoveryRelay(
  endpoint: string,
  chainIdentifier: string,
): Promise<void> {
  const origin = new URL(endpoint)
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== endpoint ||
    origin.username ||
    origin.password
  )
    throw new Error('Discovery requires an HTTPS origin')
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 5000)
  try {
    const response = await fetch(`${endpoint}/relay/v1/info`, {
      signal: abort.signal,
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error('Relay unavailable')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing relay information')
    let text = ''
    const decoder = new TextDecoder()
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if ((bytes += chunk.value.length) > 4096)
          throw new Error('Relay information too large')
        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      await reader.cancel()
    }
    text += decoder.decode()
    const info = JSON.parse(text) as { network?: unknown; endpoint?: unknown }
    if (info.network !== chainIdentifier || info.endpoint !== endpoint)
      throw new Error('Relay origin or network mismatch')
  } finally {
    clearTimeout(timeout)
  }
}
