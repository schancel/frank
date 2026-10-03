/** Private composition helper for the disposable built-in demo, never a production RPC override.
 * Discovery identifies the test service; it is not a hostile-local-machine security boundary.
 * Remove with #752 once #696 can obtain ordinary authenticated relay capabilities. */
export interface FakeDemoRpcConfig {
  enabled: boolean
  controlUrl: string
}

type DiscoveryFetch = (
  url: string,
  init: {
    redirect: 'error'
    signal: AbortSignal
  },
) => Promise<{ ok: boolean; redirected?: boolean; json(): Promise<unknown> }>

export async function discoverFakeDemoRpc(config: {
  fakeDemo?: FakeDemoRpcConfig
  rpcChain: string
  networkId: string
  networkTag: string
  chainId: number | bigint
}): Promise<string | undefined> {
  if (config.fakeDemo?.enabled !== true) return undefined
  if (
    config.rpcChain !== 'monad-testnet' ||
    config.networkId !== 'monad-testnet' ||
    config.networkTag !== 'MONT' ||
    BigInt(config.chainId) !== 10143n
  )
    throw new Error('Fake demo RPC requires Monad testnet configuration')
  const { controlUrl } = config.fakeDemo
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(controlUrl)
  if (!match || match[0] !== controlUrl || Number(match[1]) > 65535)
    throw new Error('Fake demo RPC requires the explicit built-in loopback URL')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await (
      globalThis as unknown as { fetch: DiscoveryFetch }
    ).fetch(`${controlUrl}/_ctl/demo-funding`, {
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok || response.redirected)
      throw new Error('Fake demo RPC capability unavailable')
    const capability = (await response.json()) as Record<string, unknown> | null
    if (
      !capability ||
      Array.isArray(capability) ||
      Object.keys(capability).length !== 3 ||
      capability.kind !== 'frank-simulated-ledger-v1' ||
      capability.amountWei !== '1000000000000000000' ||
      typeof capability.token !== 'string' ||
      capability.token.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(capability.token)
    )
      throw new Error('Fake demo RPC capability unavailable')
    // Keep only the validated public URL. No funding call or control token escapes discovery.
    return controlUrl
  } catch {
    // A malformed response or fetch error may contain control-token text. Keep it private.
    throw new Error('Fake demo RPC capability unavailable')
  } finally {
    clearTimeout(timer)
  }
}
