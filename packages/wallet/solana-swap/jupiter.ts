/**
 * Jupiter swap API client (https://api.jup.ag/swap/v1): a real quote for an exact input and
 * the transaction Jupiter builds for it. Jupiter serves Solana mainnet only.
 *
 * No platform fee is requested. Responses are checked against the request before use.
 */

export interface JupiterRouteHop {
  readonly swapInfo: {
    readonly ammKey: string
    readonly label?: string
    readonly inputMint: string
    readonly outputMint: string
    readonly inAmount: string
    readonly outAmount: string
  }
  readonly percent?: number | null
}

/** The quote exactly as Jupiter returned it; it is sent back verbatim to build the swap. */
export interface JupiterQuoteResponse {
  readonly inputMint: string
  readonly outputMint: string
  readonly inAmount: string
  readonly outAmount: string
  readonly otherAmountThreshold: string
  readonly swapMode: string
  readonly slippageBps: number
  readonly priceImpactPct: string
  readonly platformFee: unknown
  readonly routePlan: readonly JupiterRouteHop[]
  readonly [key: string]: unknown
}

export interface JupiterSwapResponse {
  /** Base64 unsigned versioned transaction. */
  readonly swapTransaction: string
  readonly lastValidBlockHeight: number
  readonly prioritizationFeeLamports?: number
}

export interface JupiterClientOptions {
  readonly apiBaseUrl: string
  /** Optional `x-api-key`; without one Jupiter allows 0.5 requests/second. */
  readonly apiKey?: string
  readonly fetchImpl?: typeof fetch
}

export class JupiterApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'JupiterApiError'
  }
}

async function request<T>(
  options: JupiterClientOptions,
  path: string,
  init: RequestInit,
): Promise<T> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const response = await fetchFn(
    `${options.apiBaseUrl.replace(/\/+$/, '')}${path}`,
    {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
      },
    },
  )
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok || body === undefined || body === null) {
    const detail =
      (body as { error?: string; message?: string } | undefined)?.error ??
      (body as { message?: string } | undefined)?.message ??
      `HTTP ${response.status}`
    throw new JupiterApiError(response.status, `Jupiter: ${detail}`)
  }
  return body as T
}

const isAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value)

/** Quote for swapping exactly `amount` base units of `inputMint` into `outputMint`. */
export async function fetchJupiterQuote(
  options: JupiterClientOptions,
  params: {
    inputMint: string
    outputMint: string
    amount: bigint
    slippageBps: number
    /** Frank's fee in basis points, when one is configured for the venue. */
    platformFeeBps?: number
  },
): Promise<JupiterQuoteResponse> {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: params.slippageBps.toString(),
    swapMode: 'ExactIn',
    ...(params.platformFeeBps
      ? { platformFeeBps: params.platformFeeBps.toString() }
      : {}),
  })
  const quote = await request<JupiterQuoteResponse>(
    options,
    `/quote?${query}`,
    {
      method: 'GET',
    },
  )
  if (
    quote.inputMint !== params.inputMint ||
    quote.outputMint !== params.outputMint ||
    quote.inAmount !== params.amount.toString() ||
    quote.swapMode !== 'ExactIn' ||
    !isAmount(quote.outAmount) ||
    !isAmount(quote.otherAmountThreshold) ||
    !Array.isArray(quote.routePlan)
  ) {
    throw new JupiterApiError(
      200,
      'Jupiter returned a quote for a different swap',
    )
  }
  // The quote must carry exactly the fee that was asked for: none, or the configured rate.
  const fee = quote.platformFee as
    | { amount?: unknown; feeBps?: unknown }
    | null
    | undefined
  const feeMatches = params.platformFeeBps
    ? fee != null &&
      fee.feeBps === params.platformFeeBps &&
      isAmount(fee.amount)
    : fee == null
  if (!feeMatches) {
    throw new JupiterApiError(
      200,
      'Jupiter quote carries a platform fee that was not requested',
    )
  }
  return quote
}

/** The unsigned transaction for a quote, paid for and signed only by `userPublicKey`. */
export async function fetchJupiterSwapTransaction(
  options: JupiterClientOptions,
  params: {
    quote: JupiterQuoteResponse
    userPublicKey: string
    /** Token account that collects the platform fee the quote was made with. */
    feeAccount?: string
  },
): Promise<JupiterSwapResponse> {
  const swap = await request<JupiterSwapResponse>(options, '/swap', {
    method: 'POST',
    body: JSON.stringify({
      quoteResponse: params.quote,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      ...(params.feeAccount ? { feeAccount: params.feeAccount } : {}),
    }),
  })
  if (
    typeof swap.swapTransaction !== 'string' ||
    !Number.isSafeInteger(swap.lastValidBlockHeight)
  ) {
    throw new JupiterApiError(200, 'Jupiter returned no swap transaction')
  }
  return swap
}

/** Jupiter reports price impact as a fraction ("0.0012" = 0.12%). */
export function jupiterPriceImpactBps(
  quote: JupiterQuoteResponse,
): number | null {
  const fraction = Number(quote.priceImpactPct)
  return Number.isFinite(fraction) ? Math.abs(fraction) * 10_000 : null
}
