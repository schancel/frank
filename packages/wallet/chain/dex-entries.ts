/**
 * The exchanges (`dex` entries) a network's row in the chain registry can list: facts only.
 *
 * These are network facts, not a price or liquidity table: every address here was read from a
 * published list and then confirmed on the chain itself (it has code, and it answers as the
 * contract it is listed as). Amounts, prices, fees and liquidity are never recorded here; they
 * are read from the chain when a quote is asked for.
 *
 * Source for `monad-testnet`: Monad's protocol directory,
 * https://github.com/monad-crypto/protocols/blob/main/testnet/uniswap_v4.jsonc (contracts),
 * testnet/CANONICAL.jsonc (Permit2) and testnet/circle_usdc.jsonc (USDC). That directory describes
 * the deployment as Uniswap v4 contracts maintained by Monad, "not an official Uniswap
 * deployment". Uniswap's own list for chain 10143
 * (https://github.com/Uniswap/contracts/blob/main/deployments/10143.md) names v2/v3 addresses
 * that hold no code on the current testnet, so they are not used.
 *
 * Checked on chain 2026-10-09 (`swap/uniswap-v4.livecheck.ts` repeats the check):
 * StateView.poolManager(), V4Quoter.poolManager() and UniversalRouter.poolManager() all return the
 * PoolManager below; each pool is initialised with liquidity and the quoter answers for it.
 *
 * To add a network or a pool: add it here, then run the live check against that network.
 */

/** `address: null` is the chain's native coin (Uniswap v4 currency zero), paid as the call value. */
export interface EvmDexToken {
  readonly symbol: string
  readonly name: string
  readonly decimals: number
  readonly address: string | null
  /** A token with no value or issuer behind it, listed only because its pool is real. */
  readonly testToken?: boolean
}

/** A Uniswap v4 pool key. `currency0 < currency1`; the native coin is the zero address. */
export interface UniswapV4PoolKey {
  readonly currency0: string
  readonly currency1: string
  /** LP fee in hundredths of a basis point (500 = 0.05%). */
  readonly fee: number
  readonly tickSpacing: number
  readonly hooks: string
}

/**
 * A place a swap can be made on one chain. A chain lists zero or more; the first is the one a
 * form opens on and the user may pick another. Every venue, on any chain family, has these
 * fields; what a protocol needs beyond them (contracts, pools, programs) is in its own type.
 */
export interface SwapVenue {
  /** Stable within its chain; stored with a swap so it is finished on the venue it was made on. */
  readonly id: string
  /** Names the adapter class that speaks to it. Composition maps this key to the class. */
  readonly adapter: string
  /** A disabled entry is not offered. Nothing else decides whether a network has a swap. */
  readonly enabled: boolean
  /** What the user sees, e.g. "Uniswap v4". */
  readonly displayName: string
  /** Who runs this deployment, when it is not the protocol's own. */
  readonly maintainer: string
  /**
   * Frank's own fee on this venue, taken from what the swap returns. Absent means no fee: the
   * transaction encodes nothing about one and the form shows none. No venue has one today
   * (no collecting wallet exists yet; ticket #1375).
   */
  readonly interfaceFee?: InterfaceFee
}

export interface InterfaceFee {
  /** Whole basis points of the output, 1 to `MAX_INTERFACE_FEE_BPS`. */
  readonly bps: number
  readonly recipient: string
}

/** A configured fee above this is a mistake, and is refused when the configuration loads. */
export const MAX_INTERFACE_FEE_BPS = 100

/** Throws unless the fee is a whole number of basis points in range, paid to a real address. */
export function assertInterfaceFee(fee: InterfaceFee): void {
  if (
    !Number.isInteger(fee.bps) ||
    fee.bps < 1 ||
    fee.bps > MAX_INTERFACE_FEE_BPS
  )
    throw new RangeError(
      `Interface fee must be 1 to ${MAX_INTERFACE_FEE_BPS} whole basis points`,
    )
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(fee.recipient) ||
    /^0x0{40}$/.test(fee.recipient)
  )
    throw new RangeError('Interface fee needs a recipient address')
}

export interface UniswapV4Deployment extends SwapVenue {
  readonly adapter: 'uniswap-v4'
  /** False when the contracts are Uniswap's but someone else deployed and maintains them. */
  readonly officialUniswapDeployment: boolean
  readonly maintainer: string
  readonly source: string
  readonly poolManager: string
  readonly quoter: string
  readonly stateView: string
  readonly universalRouter: string
  readonly permit2: string
  readonly tokens: readonly EvmDexToken[]
  /** Pools without hooks only: a hook can change what a swap pays or returns. */
  readonly pools: readonly UniswapV4PoolKey[]
}

export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000'

const MONAD_TESTNET_USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3'
const MONAD_TESTNET_CHOMP = '0x130556848511554b181e645309754F265522F3c2'

/** The `dex` list of the `monad-testnet` row of the chain registry. */
export const MONAD_TESTNET_DEX: readonly UniswapV4Deployment[] = Object.freeze([
  Object.freeze({
    id: 'uniswap-v4',
    displayName: 'Uniswap v4',
    adapter: 'uniswap-v4',
    enabled: true,
    officialUniswapDeployment: false,
    maintainer: 'Monad',
    source:
      'https://github.com/monad-crypto/protocols/blob/main/testnet/uniswap_v4.jsonc',
    poolManager: '0x451D64ab3b650040d2aE1886602b97ed6eDc643d',
    quoter: '0x869834d127b230283fe63E0d0A9bEB67216a94C7',
    stateView: '0xB639209539c61BaF67AC04876315786F8D0b153c',
    universalRouter: '0x1b7bFCd2870329B987191910D85c22C7287f3c22',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    tokens: Object.freeze([
      Object.freeze({
        symbol: 'MON',
        name: 'Monad',
        decimals: 18,
        address: null,
      }),
      Object.freeze({
        symbol: 'USDC',
        name: 'USD Coin (Circle testnet)',
        decimals: 6,
        address: MONAD_TESTNET_USDC,
      }),
      Object.freeze({
        symbol: 'CHOMP',
        name: 'Monad Pet Chomp (test token)',
        decimals: 18,
        address: MONAD_TESTNET_CHOMP,
        testToken: true,
      }),
    ]),
    pools: Object.freeze([
      Object.freeze({
        currency0: NATIVE_CURRENCY,
        currency1: MONAD_TESTNET_USDC,
        fee: 500,
        tickSpacing: 10,
        hooks: NATIVE_CURRENCY,
      }),
      Object.freeze({
        currency0: NATIVE_CURRENCY,
        currency1: MONAD_TESTNET_CHOMP,
        fee: 3000,
        tickSpacing: 60,
        hooks: NATIVE_CURRENCY,
      }),
    ]),
  }),
])

/** Every EVM dex entry type; one per adapter. */
export type EvmDexEntry = UniswapV4Deployment
