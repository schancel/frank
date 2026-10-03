/** Local fake-service control, not chain RPC or a production faucet. */
import { isAddress } from 'ethers'

export const DEMO_FUNDING_PATH = '/_ctl/demo-funding'
export const DEMO_FUNDING_KIND = 'frank-simulated-ledger-v1'
/** Shared with demo-config's existing fake faucet default; fixed at the 1 MON ceiling. */
export const DEMO_FUNDING_AMOUNT_WEI = '1000000000000000000'

export interface DemoFundingResult {
  kind: typeof DEMO_FUNDING_KIND
  evmReceiveAddress: string
  balanceWei: string
  creditedWei: string
}

/** Explicitly ensure a 1 simulated MON balance. Calling after spending requests a top-up.
 * The caller supplies the wallet's getReceiveAddress().raw, never its authentication identity.
 * No wallet secret or signing capability is accepted. */
export async function ensureDemoBalance(
  mode: { fakeChain: boolean; rpcUrl: string },
  evmReceiveAddress: string,
): Promise<DemoFundingResult> {
  if (mode.fakeChain !== true)
    throw new Error('Simulated funding requires explicit fake-chain mode')
  // A literal loopback URL only: no DNS, credentials, path, query, proxy, or redirect target.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(mode.rpcUrl)
  if (!match || Number(match[1]) > 65535)
    throw new Error('Simulated funding requires the built-in loopback RPC URL')
  if (typeof evmReceiveAddress !== 'string' || !isAddress(evmReceiveAddress)) {
    throw new Error('Expected an EVM receive address')
  }
  const url = `${mode.rpcUrl}${DEMO_FUNDING_PATH}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const options = { redirect: 'error' as const, signal: controller.signal }
    const discovery = await fetch(url, options)
    if (!discovery.ok)
      throw new Error('Fake-chain funding capability unavailable')
    const capability = (await discovery.json()) as Record<
      string,
      unknown
    > | null
    if (
      capability?.kind !== DEMO_FUNDING_KIND ||
      capability.amountWei !== DEMO_FUNDING_AMOUNT_WEI ||
      typeof capability.token !== 'string' ||
      !/^[0-9a-f]{64}$/.test(capability.token)
    )
      throw new Error('Fake-chain funding capability unavailable')
    const response = await fetch(url, {
      ...options,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-frank-demo-funding': capability.token,
      },
      body: JSON.stringify({
        evmReceiveAddress,
        amountWei: DEMO_FUNDING_AMOUNT_WEI,
      }),
    })
    if (!response.ok) throw new Error('Simulated ledger credit failed')
    const result = (await response.json()) as Record<string, unknown> | null
    if (
      result?.kind !== DEMO_FUNDING_KIND ||
      result.evmReceiveAddress !== evmReceiveAddress.toLowerCase() ||
      typeof result.balanceWei !== 'string' ||
      !/^[0-9]+$/.test(result.balanceWei) ||
      BigInt(result.balanceWei) < BigInt(DEMO_FUNDING_AMOUNT_WEI) ||
      typeof result.creditedWei !== 'string' ||
      !/^[0-9]+$/.test(result.creditedWei) ||
      BigInt(result.creditedWei) > BigInt(DEMO_FUNDING_AMOUNT_WEI)
    )
      throw new Error('Invalid simulated ledger credit response')
    return {
      kind: DEMO_FUNDING_KIND,
      evmReceiveAddress: result.evmReceiveAddress,
      balanceWei: result.balanceWei,
      creditedWei: result.creditedWei,
    }
  } finally {
    clearTimeout(timer)
  }
}
