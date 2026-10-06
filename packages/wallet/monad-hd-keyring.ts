/**
 * HD sub-account key derivation for EVM sub-account pools.
 *
 * @deprecated Use `EvmHdKeyring` or `Secp256k1HdKeyring` from `./secp256k1-hd-keyring` instead.
 * Maintained as a backwards-compatible alias for existing callers.
 */

import {
  EvmHdKeyring,
  type DerivedSubAccount,
  subAccountPathFor,
} from './secp256k1-hd-keyring'

export const DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0"

export function subAccountPath(index: number): string {
  return subAccountPathFor(DERIVATION_PATH_PREFIX, index)
}

export type { DerivedSubAccount }
export { EvmHdKeyring as MonadHdKeyring }
