/**
 * Points the wallet's EVM JSON-RPC provider at a local anvil node, the way the wallet's anvil
 * Jest suites do with `jest.mock('../evm-provider')` (packages/wallet/swap/htlc-lock-resume.anvil
 * .jest.test.ts): `createMonadJsonRpcProvider` is called with the node's URL instead of the
 * relay's chain-rpc route. Only the URL changes; the provider, signing, journal and node are real.
 *
 * Import this module before anything that loads `@frank/wallet` (it hooks `require`), then call
 * `redirectEvmRpcTo(url)`. For tsx/CommonJS processes such as the regtest livechecks.
 */
import Module from 'module'

let target: string | undefined
const patched = new WeakMap<object, object>()
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown
const host = Module as unknown as {
  _load: Loader
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string
}
const load = host._load
host._load = function (request, parent, isMain) {
  const exports = load.call(this, request, parent, isMain) as Record<string, unknown>
  let filename: string
  try {
    filename = host._resolveFilename(request, parent, isMain)
  } catch {
    return exports
  }
  if (!/[\\/]packages[\\/]wallet[\\/]evm-provider\.ts$/.test(filename)) return exports
  const cached = patched.get(exports)
  if (cached) return cached
  const create = exports.createMonadJsonRpcProvider as (options: { rpcUrl: string; chainId?: number | bigint }) => unknown
  const proxy = new Proxy(exports, {
    get(object, key) {
      if (key !== 'createMonadJsonRpcProvider') return Reflect.get(object, key)
      return (options: { chainId?: number | bigint }) => {
        if (!target) throw new Error('redirectEvmRpcTo was not called')
        return create({ rpcUrl: target, chainId: options.chainId })
      }
    },
  })
  patched.set(exports, proxy)
  return proxy
}

export function redirectEvmRpcTo(url: string): void {
  target = url
}
