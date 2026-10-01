// Hash and secp256k1 backend. The installed implementation is pure JS.
// A Node accelerator would live under src/backend/node and stay unimported
// here. hash-wasm and tiny-secp256k1 stay uninstalled until their install
// scripts are inspected (docs/nakamoto-audit.md section 11 on issue 235).

import { nobleBackend } from './backend/noble.js'
import type { CryptoBackend } from './backend/types.js'

export { CryptoBackendError, nobleBackend } from './backend/noble.js'
export type { BackendCode, CryptoBackend } from './backend/types.js'

/** Noble fallback. WASM is not loaded. */
export function selectCryptoBackend(): CryptoBackend {
  return nobleBackend
}

export const cryptoBackend: CryptoBackend = selectCryptoBackend()
