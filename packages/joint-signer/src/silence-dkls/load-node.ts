/**
 * Node loader for the silence-dkls backend. The node build of our forked
 * wasm instantiates synchronously from the file next to it when it is first
 * required: no network, no flags.
 */
import * as dkls from '../../../../third_party/silent-shard-dkls23-ll/pkg/node/dkls-wasm-ll-node.js'

import { createSilenceDklsBackend } from './backend.js'
import type { SilenceDklsModule } from './module.js'
import type { LockingJointSigner } from '../types.js'

/** The node build is CommonJS; under an ESM loader its exports sit on `default`. */
function unwrap(loaded: unknown): SilenceDklsModule {
  const direct = loaded as Partial<SilenceDklsModule>
  if (typeof direct.KeygenSession === 'function') {
    return direct as SilenceDklsModule
  }
  return (loaded as { default: SilenceDklsModule }).default
}

export function loadSilenceDklsNode(): LockingJointSigner {
  return createSilenceDklsBackend(unwrap(dkls))
}
