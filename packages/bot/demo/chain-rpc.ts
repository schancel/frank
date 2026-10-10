/**
 * The few read-only JSON-RPC calls the launcher and the test harness make against the real chain
 * (balances, the chain id). `MONAD_TESTNET_HTTP_RPC_URL` may list several endpoints separated by
 * commas; each call tries them in order, up to three times. A URL is never put in an error message: it can carry an
 * API key.
 */
export function rpcUrlList(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export async function rpcCall<T = unknown>(rpcUrls: string, method: string, params: unknown[]): Promise<T> {
  let last = 'no RPC URL configured'
  // A public endpoint drops or stalls a request now and then, most of all while eight bots are
  // starting against it: the list is tried three times before a read is called failed.
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) await new Promise(r => setTimeout(r, 1500 * round))
    for (const [index, url] of rpcUrlList(rpcUrls).entries()) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        })
        if (!response.ok) {
          last = `endpoint ${index + 1} answered HTTP ${response.status}`
          continue
        }
        const body = (await response.json()) as { result?: T; error?: { message?: string } }
        if (body.error) {
          last = `endpoint ${index + 1} answered an error to ${method}: ${body.error.message ?? 'unknown'}`
          continue
        }
        return body.result as T
      } catch (err) {
        last = `endpoint ${index + 1} could not be reached (${err instanceof Error ? err.name : 'error'})`
      } finally {
        clearTimeout(timer)
      }
    }
  }
  throw new Error(`chain RPC ${method} failed: ${last}`)
}

export async function chainBalanceWei(rpcUrls: string, address: string): Promise<bigint> {
  return BigInt(await rpcCall<string>(rpcUrls, 'eth_getBalance', [address, 'latest']))
}

export async function chainId(rpcUrls: string): Promise<bigint> {
  return BigInt(await rpcCall<string>(rpcUrls, 'eth_chainId', []))
}
