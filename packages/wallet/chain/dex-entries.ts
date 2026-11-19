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
 * Source for `hyperliquid-testnet`: HyperSwap's published testnet contracts,
 * https://docs.hyperswap.exchange/docs/amm/contracts/testnet/v2/ (V2 router, factory),
 * https://docs.hyperswap.exchange/docs/amm/contracts/testnet/v3/ (SwapRouter02) and
 * https://docs.hyperswap.exchange/docs/amm/contracts/testnet/ (its WETH and test PURR tokens).
 * The published V2 router quotes and manages liquidity but has no swap function (its bytecode
 * holds no swap selector); swaps through the V2 pairs go through SwapRouter02, whose
 * factoryV2() is the V2 factory. Checked on chain 2026-11-18 (`swap/hyperswap-v2.livecheck.ts`
 * repeats the check): chain 998, every address holds code, router.factory() and router.WETH()
 * and swapRouter.factoryV2() and swapRouter.WETH9() are the factory and wrapped native coin
 * below, factory.getPair(wrapped native, PURR) is the pair below with reserves on both sides,
 * router.getAmountsOut answers, and a simulated (`eth_call`) swap through SwapRouter02 pays
 * exactly that answer.
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

/**
 * Resolves a runtime/build-time configured interface fee (#1375) from environment variables
 * (`SWAP_INTERFACE_FEE_BPS` and `EVM_SWAP_INTERFACE_FEE_RECIPIENT` / `SOLANA_SWAP_INTERFACE_FEE_RECIPIENT`).
 * Returns `undefined` when no fee recipient or rate is configured, and throws `RangeError` if
 * configured with an invalid basis-point rate (`1..MAX_INTERFACE_FEE_BPS`) or malformed EVM recipient.
 */
export function resolveConfiguredInterfaceFee(
  family: 'evm' | 'solana',
  env: Record<string, string | undefined> | undefined = typeof process !==
    'undefined'
    ? process.env
    : undefined,
): InterfaceFee | undefined {
  if (!env) return undefined
  const recipientKey =
    family === 'evm'
      ? 'EVM_SWAP_INTERFACE_FEE_RECIPIENT'
      : 'SOLANA_SWAP_INTERFACE_FEE_RECIPIENT'
  const rawRecipient = (
    env[recipientKey] ?? env.SWAP_INTERFACE_FEE_RECIPIENT
  )?.trim()
  const rawBps = (
    env[
      family === 'evm'
        ? 'EVM_SWAP_INTERFACE_FEE_BPS'
        : 'SOLANA_SWAP_INTERFACE_FEE_BPS'
    ] ?? env.SWAP_INTERFACE_FEE_BPS
  )?.trim()
  if (!rawRecipient || !rawBps) return undefined
  const bps = Number(rawBps)
  const fee: InterfaceFee = { bps, recipient: rawRecipient }
  if (family === 'evm') {
    assertInterfaceFee(fee)
  } else if (!Number.isInteger(bps) || bps < 1 || bps > MAX_INTERFACE_FEE_BPS) {
    throw new RangeError(
      `Interface fee must be 1 to ${MAX_INTERFACE_FEE_BPS} whole basis points`,
    )
  }
  return Object.freeze(fee)
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

/** A Uniswap v2-style pair of a router's factory, and the two tokens it holds. */
export interface UniswapV2Pair {
  readonly address: string
  readonly token0: string
  readonly token1: string
}

/**
 * A HyperSwap V2 deployment (a Uniswap v2-style router, factory and pairs). Its router has no
 * way to take a portion of the output for Frank, so the entry cannot carry an interface fee.
 */
export interface HyperSwapV2Deployment extends SwapVenue {
  readonly adapter: 'hyperswap-v2'
  readonly source: string
  /** The V2 router: quotes (`getAmountsOut`) only. */
  readonly router: string
  /** HyperSwap's SwapRouter02: sends the swap through the V2 pairs (`swapExactTokensForTokens`). */
  readonly swapRouter: string
  readonly factory: string
  /** The wrapped native coin the router trades the native coin through (its `WETH()`). */
  readonly wrappedNative: string
  readonly tokens: readonly EvmDexToken[]
  /** Pairs the router may trade through; each one's tokens are the configured ones. */
  readonly pairs: readonly UniswapV2Pair[]
  readonly interfaceFee?: never
}

const HYPERLIQUID_TESTNET_WRAPPED = '0xADcb2f358Eae6492F61A5F87eb8893d09391d160'
const HYPERLIQUID_TESTNET_PURR = '0xC003D79B8a489703b1753711E3ae9fFDFC8d1a82'

/** The `dex` list of the `hyperliquid-testnet` row of the chain registry. */
export const HYPERLIQUID_TESTNET_DEX: readonly HyperSwapV2Deployment[] =
  Object.freeze([
    Object.freeze({
      id: 'hyperswap-v2',
      adapter: 'hyperswap-v2',
      enabled: true,
      displayName: 'HyperSwap V2',
      maintainer: 'HyperSwap',
      source: 'https://docs.hyperswap.exchange/docs/amm/contracts/testnet/v2/',
      router: '0x85aA63EB2ab9BaAA74eAd7e7f82A571d74901853',
      swapRouter: '0x51c5958FFb3e326F8d7AA945948159f1FF27e14A',
      factory: '0xA028411927E2015A363014881a4404C636218fb1',
      wrappedNative: HYPERLIQUID_TESTNET_WRAPPED,
      tokens: Object.freeze([
        Object.freeze({
          symbol: 'tHYPE',
          name: 'Hyperliquid testnet HYPE',
          decimals: 18,
          address: null,
        }),
        Object.freeze({
          symbol: 'PURR',
          name: 'HyperSwap test PURR',
          decimals: 18,
          address: HYPERLIQUID_TESTNET_PURR,
          testToken: true,
        }),
      ]),
      pairs: Object.freeze([
        Object.freeze({
          address: '0xddA44A39AaA3e2dcc8aFd78ca70b0718877188b5',
          token0: HYPERLIQUID_TESTNET_WRAPPED,
          token1: HYPERLIQUID_TESTNET_PURR,
        }),
      ]),
    }),
  ])

/** Every EVM dex entry type; one per adapter. */
export type EvmDexEntry = UniswapV4Deployment | HyperSwapV2Deployment

/**
 * Whether an adapter's transactions can carry Frank's interface fee. A venue that cannot is not
 * offered while a fee is configured: it is neither offered without the fee nor offered to fail.
 */
export const EVM_DEX_CARRIES_INTERFACE_FEE: {
  readonly [K in EvmDexEntry['adapter']]: boolean
} = Object.freeze({ 'uniswap-v4': true, 'hyperswap-v2': false })
