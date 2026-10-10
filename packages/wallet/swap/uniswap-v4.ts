/**
 * Uniswap v4 swap encoding and arithmetic. Pure: no network, no clock, no signer.
 *
 * A swap is one `UniversalRouter.execute` call carrying one V4_SWAP command with three actions:
 * swap exact-in on a single pool, settle everything owed in the input currency, take everything
 * owed in the output currency to the caller. The native coin is paid as the call value; an ERC-20
 * is pulled through Permit2, which the caller must first allow for exactly the amount spent.
 */

import { AbiCoder, getAddress, Interface, keccak256 } from 'ethers'
import {
  NATIVE_CURRENCY,
  type EvmDexToken,
  type UniswapV4Deployment,
  type UniswapV4PoolKey,
} from '../chain/dex-deployments'

const coder = AbiCoder.defaultAbiCoder()
const POOL_KEY = 'tuple(address,address,uint24,int24,address)'

/** Universal Router command and v4 router action bytes (Uniswap `Commands.sol`, `Actions.sol`). */
export const V4_SWAP_COMMAND = '0x10'
export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
} as const

export const universalRouterInterface = new Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)',
  'error TransactionDeadlinePassed()',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error InsufficientETH()',
  'error InsufficientToken()',
])
export const quoterInterface = new Interface([
  'function quoteExactInputSingle(tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
])
export const stateViewInterface = new Interface([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
])
export const erc20Interface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
export const permit2Interface = new Interface([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
])
export const poolManagerInterface = new Interface([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
])

const Q192 = 1n << 192n
const UINT128_MAX = (1n << 128n) - 1n
const UINT160_MAX = (1n << 160n) - 1n
/** Slippage the form accepts, in basis points. Above 50% a "minimum" protects nothing. */
export const MAX_SLIPPAGE_BPS = 5000

export function currencyOf(token: EvmDexToken): string {
  return token.address === null ? NATIVE_CURRENCY : getAddress(token.address)
}

function keyTuple(key: UniswapV4PoolKey) {
  return [
    getAddress(key.currency0),
    getAddress(key.currency1),
    key.fee,
    key.tickSpacing,
    getAddress(key.hooks),
  ] as const
}

/** The pool's id in the PoolManager: keccak256 of the ABI-encoded key. */
export function poolId(key: UniswapV4PoolKey): string {
  return keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [...keyTuple(key)],
    ),
  )
}

export interface PoolRoute {
  readonly key: UniswapV4PoolKey
  /** True when the input is the pool's currency0. */
  readonly zeroForOne: boolean
}

/** Every configured pool that trades exactly this pair. Empty means there is no route. */
export function routesFor(
  deployment: UniswapV4Deployment,
  tokenIn: EvmDexToken,
  tokenOut: EvmDexToken,
): PoolRoute[] {
  const input = currencyOf(tokenIn).toLowerCase()
  const output = currencyOf(tokenOut).toLowerCase()
  if (input === output) return []
  const routes: PoolRoute[] = []
  for (const key of deployment.pools) {
    const c0 = key.currency0.toLowerCase()
    const c1 = key.currency1.toLowerCase()
    if (c0 === input && c1 === output) routes.push({ key, zeroForOne: true })
    else if (c1 === input && c0 === output)
      routes.push({ key, zeroForOne: false })
  }
  return routes
}

export function findToken(
  deployment: UniswapV4Deployment,
  symbol: string,
): EvmDexToken | undefined {
  const wanted = symbol.trim().toUpperCase()
  return deployment.tokens.find(token => token.symbol.toUpperCase() === wanted)
}

export function encodeQuoteCall(route: PoolRoute, amountIn: bigint): string {
  requireAmount(amountIn)
  return quoterInterface.encodeFunctionData('quoteExactInputSingle', [
    [[...keyTuple(route.key)], route.zeroForOne, amountIn, '0x'],
  ])
}

export function decodeQuoteResult(data: string): {
  amountOut: bigint
  gasEstimate: bigint
} {
  const [amountOut, gasEstimate] = quoterInterface.decodeFunctionResult(
    'quoteExactInputSingle',
    data,
  )
  return { amountOut: BigInt(amountOut), gasEstimate: BigInt(gasEstimate) }
}

function requireAmount(amount: bigint): void {
  if (amount <= 0n) throw new RangeError('Swap amount must be positive')
  if (amount > UINT128_MAX) throw new RangeError('Swap amount is too large')
}

/**
 * What `amountIn` would buy at the pool's current price with no fee and no price movement.
 * `sqrtPriceX96` is the square root of (currency1 per currency0) in Q96, both in base units.
 */
export function outputAtMidPrice(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPriceX96 <= 0n) throw new RangeError('Pool has no price')
  const priceX192 = sqrtPriceX96 * sqrtPriceX96
  return zeroForOne
    ? (amountIn * priceX192) / Q192
    : (amountIn * Q192) / priceX192
}

/**
 * How much worse the quote is than the pool's mid price, in parts per million, after taking the
 * LP fee out of the input (the fee is shown on its own line, so it is not counted as impact).
 * Never negative: rounding in the trader's favour reads as zero.
 */
export function priceImpactPpm(params: {
  amountIn: bigint
  amountOut: bigint
  sqrtPriceX96: bigint
  zeroForOne: boolean
  lpFeePpm: number
}): number {
  const afterFee =
    (params.amountIn * BigInt(1_000_000 - params.lpFeePpm)) / 1_000_000n
  const ideal = outputAtMidPrice(
    afterFee,
    params.sqrtPriceX96,
    params.zeroForOne,
  )
  if (ideal <= 0n || params.amountOut >= ideal) return 0
  return Number(((ideal - params.amountOut) * 1_000_000n) / ideal)
}

/** The least output the swap may deliver before it reverts. Rounds down, never to zero output. */
export function minimumOutput(amountOut: bigint, slippageBps: number): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > MAX_SLIPPAGE_BPS
  )
    throw new RangeError('Slippage must be between 0% and 50%')
  if (amountOut <= 0n) throw new RangeError('Quoted output must be positive')
  const minimum = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n
  return minimum > 0n ? minimum : 1n
}

export interface EncodedCall {
  readonly to: string
  readonly data: string
  readonly value: bigint
}

/** The swap transaction: exact input, a floor on the output, a deadline, no interface fee. */
export function encodeSwap(params: {
  deployment: UniswapV4Deployment
  route: PoolRoute
  amountIn: bigint
  minimumAmountOut: bigint
  /** Unix seconds after which the router refuses the swap. */
  deadline: number
}): EncodedCall {
  requireAmount(params.amountIn)
  if (params.minimumAmountOut <= 0n || params.minimumAmountOut > UINT128_MAX)
    throw new RangeError('Minimum output must be positive')
  if (!Number.isSafeInteger(params.deadline) || params.deadline <= 0)
    throw new RangeError('Swap deadline is invalid')
  const { key, zeroForOne } = params.route
  const input = getAddress(zeroForOne ? key.currency0 : key.currency1)
  const output = getAddress(zeroForOne ? key.currency1 : key.currency0)
  const actions =
    '0x' +
    [
      V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
      V4_ACTIONS.SETTLE_ALL,
      V4_ACTIONS.TAKE_ALL,
    ]
      .map(action => action.toString(16).padStart(2, '0'))
      .join('')
  const swap = coder.encode(
    [`tuple(${POOL_KEY},bool,uint128,uint128,bytes)`],
    [
      [
        [...keyTuple(key)],
        zeroForOne,
        params.amountIn,
        params.minimumAmountOut,
        '0x',
      ],
    ],
  )
  const settle = coder.encode(['address', 'uint256'], [input, params.amountIn])
  const take = coder.encode(
    ['address', 'uint256'],
    [output, params.minimumAmountOut],
  )
  const v4Input = coder.encode(
    ['bytes', 'bytes[]'],
    [actions, [swap, settle, take]],
  )
  return {
    to: getAddress(params.deployment.universalRouter),
    data: universalRouterInterface.encodeFunctionData('execute', [
      V4_SWAP_COMMAND,
      [v4Input],
      BigInt(params.deadline),
    ]),
    value: input === NATIVE_CURRENCY ? params.amountIn : 0n,
  }
}

export interface AllowanceState {
  /** ERC-20 allowance the account has given Permit2. */
  readonly tokenToPermit2: bigint
  /** Permit2 allowance the account has given the router, and when it lapses (unix seconds). */
  readonly permit2ToRouter: { amount: bigint; expiration: number }
}

export type ApprovalStep =
  | { readonly kind: 'token-approve-permit2'; readonly call: EncodedCall }
  | { readonly kind: 'permit2-approve-router'; readonly call: EncodedCall }

/** How long a Permit2 allowance given for one swap stays usable, in seconds. */
export const PERMIT2_ALLOWANCE_SECONDS = 30 * 60

/**
 * The approvals a swap of `amountIn` still needs. Each is for exactly `amountIn`, never unlimited,
 * and the Permit2 one lapses on its own. The native coin needs none.
 */
export function approvalSteps(params: {
  deployment: UniswapV4Deployment
  tokenIn: EvmDexToken
  amountIn: bigint
  allowance: AllowanceState
  /** Unix seconds. */
  now: number
}): ApprovalStep[] {
  if (params.tokenIn.address === null) return []
  requireAmount(params.amountIn)
  if (params.amountIn > UINT160_MAX)
    throw new RangeError('Swap amount is too large')
  const token = getAddress(params.tokenIn.address)
  const permit2 = getAddress(params.deployment.permit2)
  const router = getAddress(params.deployment.universalRouter)
  const steps: ApprovalStep[] = []
  if (params.allowance.tokenToPermit2 < params.amountIn)
    steps.push({
      kind: 'token-approve-permit2',
      call: {
        to: token,
        data: erc20Interface.encodeFunctionData('approve', [
          permit2,
          params.amountIn,
        ]),
        value: 0n,
      },
    })
  const routerAllowance = params.allowance.permit2ToRouter
  // A lapsed allowance is no allowance. Leave a minute so it cannot lapse before the swap lands.
  if (
    routerAllowance.amount < params.amountIn ||
    routerAllowance.expiration < params.now + 60
  )
    steps.push({
      kind: 'permit2-approve-router',
      call: {
        to: permit2,
        data: permit2Interface.encodeFunctionData('approve', [
          token,
          router,
          params.amountIn,
          params.now + PERMIT2_ALLOWANCE_SECONDS,
        ]),
        value: 0n,
      },
    })
  return steps
}

export interface ReceiptLog {
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
}

/**
 * What a confirmed swap paid and delivered, from the transaction's own logs.
 *
 * The PoolManager's `Swap` event for this pool gives both sides from the swapper's point of view
 * (negative = paid in, positive = paid out). For an ERC-20 output the token's own `Transfer` to
 * the account is used when present, because that is what the account actually holds; the native
 * coin emits no log, so there the event is the evidence. Returns undefined when the receipt does
 * not contain this pool's swap: the caller must not fall back to the quote.
 */
export function readSwapOutcome(params: {
  deployment: UniswapV4Deployment
  route: PoolRoute
  account: string
  logs: readonly ReceiptLog[]
}): { amountIn: bigint; amountOut: bigint } | undefined {
  const manager = params.deployment.poolManager.toLowerCase()
  const id = poolId(params.route.key).toLowerCase()
  const swapTopic = poolManagerInterface.getEvent('Swap')!.topicHash
  let amountIn: bigint | undefined
  let amountOut: bigint | undefined
  for (const log of params.logs) {
    if (
      log.address.toLowerCase() !== manager ||
      log.topics[0] !== swapTopic ||
      log.topics[1]?.toLowerCase() !== id
    )
      continue
    const parsed = poolManagerInterface.decodeEventLog('Swap', log.data, [
      ...log.topics,
    ])
    const amount0 = BigInt(parsed.amount0)
    const amount1 = BigInt(parsed.amount1)
    const paid = params.route.zeroForOne ? amount0 : amount1
    const received = params.route.zeroForOne ? amount1 : amount0
    if (paid >= 0n || received <= 0n) return undefined
    amountIn = (amountIn ?? 0n) - paid
    amountOut = (amountOut ?? 0n) + received
  }
  if (amountIn === undefined || amountOut === undefined) return undefined
  const output = (
    params.route.zeroForOne
      ? params.route.key.currency1
      : params.route.key.currency0
  ).toLowerCase()
  if (output !== NATIVE_CURRENCY) {
    const transferTopic = erc20Interface.getEvent('Transfer')!.topicHash
    const account = params.account.toLowerCase()
    let transferred: bigint | undefined
    for (const log of params.logs) {
      if (
        log.address.toLowerCase() !== output ||
        log.topics[0] !== transferTopic ||
        log.topics.length !== 3 ||
        ('0x' + log.topics[2]!.slice(26)).toLowerCase() !== account
      )
        continue
      transferred = (transferred ?? 0n) + BigInt(log.data)
    }
    if (transferred !== undefined) amountOut = transferred
  }
  return { amountIn, amountOut }
}

/** Plain-language cause of a failed swap, from the revert data. Undefined when unrecognised. */
export type SwapRevertReason =
  | 'slippage'
  | 'deadline'
  | 'allowance'
  | 'insufficient-funds'

export function classifySwapRevert(
  data: string | undefined,
): SwapRevertReason | undefined {
  if (!data || data.length < 10) return undefined
  const selector = data.slice(0, 10).toLowerCase()
  const is = (iface: Interface, name: string) =>
    iface.getError(name)!.selector === selector
  if (is(universalRouterInterface, 'ExecutionFailed')) {
    try {
      const [, inner] = universalRouterInterface.decodeErrorResult(
        'ExecutionFailed',
        data,
      )
      return classifySwapRevert(String(inner))
    } catch {
      return undefined
    }
  }
  if (
    is(universalRouterInterface, 'V4TooLittleReceived') ||
    is(universalRouterInterface, 'V4TooMuchRequested')
  )
    return 'slippage'
  if (is(universalRouterInterface, 'TransactionDeadlinePassed'))
    return 'deadline'
  if (
    is(permit2Interface, 'AllowanceExpired') ||
    is(permit2Interface, 'InsufficientAllowance')
  )
    return 'allowance'
  if (
    is(universalRouterInterface, 'InsufficientETH') ||
    is(universalRouterInterface, 'InsufficientToken')
  )
    return 'insufficient-funds'
  return undefined
}
