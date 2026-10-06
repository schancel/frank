/**
 * HD change-account key derivation for EVM sub-account change pools.
 *
 * @deprecated Use `EvmChangeKeyring` or `Secp256k1HdKeyring` from `./secp256k1-hd-keyring` instead.
 * Maintained as a backwards-compatible alias for existing callers.
 */

import {
  EvmChangeKeyring,
  type DerivedChangeAccount,
  subAccountPathFor,
} from './secp256k1-hd-keyring'

export const CHANGE_DERIVATION_PATH_PREFIX = "m/44'/60'/0'/1"

export function changeAccountPath(index: number): string {
  return subAccountPathFor(CHANGE_DERIVATION_PATH_PREFIX, index)
}

export type { DerivedChangeAccount }
export { EvmChangeKeyring as MonadChangeKeyring }
