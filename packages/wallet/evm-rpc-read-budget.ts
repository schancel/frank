/** How many accounts one refresh reads at the same time. */
export const READS_AT_ONCE = 6
export const RATE_LIMIT_INITIAL_BACKOFF_MS = 5_000
export const RATE_LIMIT_MAX_BACKOFF_MS = 60_000

/** ethers wraps JSON-RPC errors inside UNKNOWN_ERROR and HTTP failures inside SERVER_ERROR. */
export function isRateLimited(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const value = error as {
    code?: unknown
    status?: unknown
    statusCode?: unknown
    error?: unknown
    response?: unknown
  }
  return (
    value.code === 429 ||
    value.code === -32005 ||
    value.code === -32007 ||
    value.code === -32016 ||
    value.status === 429 ||
    value.statusCode === 429 ||
    (value.error !== error && isRateLimited(value.error, depth + 1)) ||
    (value.response !== error && isRateLimited(value.response, depth + 1))
  )
}
