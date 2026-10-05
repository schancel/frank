/**
 * Browser loader for the silence-dkls backend (also valid inside a Web
 * Worker). The web build of our forked wasm must be initialised once with the
 * location or the bytes of its `.wasm` file before any class is used.
 *
 * Under Vite, pass the asset URL explicitly so both the dev server and the
 * production build serve the file:
 *
 *   import wasmUrl from '<repo>/third_party/silent-shard-dkls23-ll/pkg/web/dkls-wasm-ll-web_bg.wasm?url'
 *   const signer = await loadSilenceDklsWeb(wasmUrl)
 *
 * With no argument the build fetches `dkls-wasm-ll-web_bg.wasm` relative to
 * its own module URL.
 */
import init, * as dkls from '../../../../third_party/silent-shard-dkls23-ll/pkg/web/dkls-wasm-ll-web.js'

import { createSilenceDklsBackend } from './backend.js'
import type { SilenceDklsModule } from './module.js'
import type { LockingJointSigner } from '../types.js'

let initialised: Promise<unknown> | null = null

/** `wasm`: a URL, a `Response`, bytes, or a compiled `WebAssembly.Module`. */
export async function loadSilenceDklsWeb(
  wasm?: unknown,
): Promise<LockingJointSigner> {
  if (initialised === null) {
    initialised = (init as (input?: unknown) => Promise<unknown>)(wasm).catch(
      (error: unknown) => {
        initialised = null
        throw error
      },
    )
  }
  await initialised
  return createSilenceDklsBackend(dkls as unknown as SilenceDklsModule)
}
