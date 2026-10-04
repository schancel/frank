/**
 * Node loader for the silence-dkls backend. The node build instantiates its
 * WebAssembly synchronously from the file next to it when it is first
 * imported: no network, no flags.
 */
import * as dkls from '@silencelaboratories/dkls-wasm-ll-node'

import { createSilenceDklsBackend } from './backend.js'
import type { SilenceDklsModule } from './module.js'
import type { PlainJointSigner } from '../types.js'

/** The node build is CommonJS; under an ESM loader its exports sit on `default`. */
function unwrap(loaded: unknown): SilenceDklsModule {
  const direct = loaded as Partial<SilenceDklsModule>
  if (typeof direct.KeygenSession === 'function') {
    return direct as SilenceDklsModule
  }
  return (loaded as { default: SilenceDklsModule }).default
}

export function loadSilenceDklsNode(): PlainJointSigner {
  return createSilenceDklsBackend(unwrap(dkls))
}
