import { recordWalletFailure } from './wallet-failure'

/** Ethers/relay adapter boundary only. Never use this to interpret arbitrary application errors. */
export function recordEvmRpcFailure<T>(error: T): T {
  try {
    if (!error || typeof error !== 'object') return error
    const value = error as {
      code?: unknown; event?: unknown; status?: unknown; statusCode?: unknown
      info?: { response?: { status?: unknown; statusCode?: unknown }; error?: { code?: unknown } }
      response?: { status?: unknown; statusCode?: unknown }
    }
    const { code, event } = value
    const status = value.status ?? value.statusCode ?? value.response?.status ??
      value.response?.statusCode ?? value.info?.response?.status ?? value.info?.response?.statusCode
    if (code === 'NETWORK_ERROR' && event === 'changed')
      return recordWalletFailure(error, { retryVeto: 'identity' })
    if (status === 401 || status === 403)
      return recordWalletFailure(error, { retryVeto: 'authorization' })
    if (code === 'CANCELLED' || code === 'ACTION_REJECTED')
      return recordWalletFailure(error, { retryVeto: code === 'CANCELLED' ? 'cancelled' : 'authorization' })
    if (code === 'INVALID_ARGUMENT' || code === 'UNSUPPORTED_OPERATION' || code === 'NOT_IMPLEMENTED')
      return recordWalletFailure(error, { retryVeto: 'programmer-error' })
    if ([429, 502, 503, 504].includes(status as number) ||
        code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 429 ||
        (code === 'SERVER_ERROR' && status === undefined && value.info?.error === undefined))
      return recordWalletFailure(error, { transientTransport: true })
    if (typeof status === 'number' && status >= 400)
      return recordWalletFailure(error, { retryVeto: 'nontransient-transport' })
  } catch {
    // Unknown provider objects must not replace the original rejection with a classifier error.
  }
  return error
}
