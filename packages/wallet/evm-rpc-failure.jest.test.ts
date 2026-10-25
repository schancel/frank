import { recordEvmRpcFailure } from './evm-rpc-failure'
import { describeWalletFailure, recordWalletFailure } from './wallet-failure'

it.each([{ status: 429 }, { info: { response: { statusCode: 502 } } },
  { code: 'TIMEOUT' }, { code: 'NETWORK_ERROR' }, { code: 'SERVER_ERROR' },
  { code: 'SERVER_ERROR', info: { response: { statusCode: 500 } } },
  { code: 'SERVER_ERROR', info: { error: { code: -32000 } } },
  new TypeError('Failed to fetch')])(
  'preserves known provider transport rejection %j', error => {
    expect(recordEvmRpcFailure(error)).toBe(error)
    expect(describeWalletFailure(error).retry).toBe('transient')
  },
)
it.each([{ code: 'NETWORK_ERROR', event: 'changed' }, { status: 401, code: 'SERVER_ERROR' },
  { statusCode: 403 }, { code: 'CANCELLED' }, { code: 'INVALID_ARGUMENT' }])(
  'keeps provider refusal %j forbidden even after a failed observation', error => {
    recordEvmRpcFailure(error)
    recordWalletFailure(error, { observationUnavailable: true, transientTransport: true })
    expect(describeWalletFailure(error).retry).toBe('forbidden')
  },
)
it.each([new Error('network 429 insufficient funds'), { code: 'INSUFFICIENT_FUNDS' },
  new TypeError('undefined is not a function'),
  new Proxy({}, { get() { throw new Error('unknown provider') } })])(
  'does not infer wallet funding or replace unknown provider rejection', error => {
    expect(recordEvmRpcFailure(error)).toBe(error)
    expect(describeWalletFailure(error)).toMatchObject({ kind: 'unknown', retry: 'unknown' })
  },
)
it('never infers wallet funding from a JSON-RPC server error body', () => {
  const error = { code: 'SERVER_ERROR', info: { error: { code: -32000, message: 'insufficient funds' } } }
  recordEvmRpcFailure(error)
  expect(describeWalletFailure(error).kind).toBe('unknown')
})
