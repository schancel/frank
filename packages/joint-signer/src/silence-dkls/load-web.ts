/**
 * Browser loader for the silence-dkls backend (also valid inside a Web
 * Worker). The web build must be initialised once with the location or the
 * bytes of its `.wasm` file before any class is used.
 *
 * Under Vite, pass the asset URL explicitly so both the dev server and the
 * production build serve the file:
 *
 *   import wasmUrl from '@silencelaboratories/dkls-wasm-ll-web/dkls-wasm-ll-web_bg.wasm?url'
 *   const signer = await loadSilenceDklsWeb(wasmUrl)
 *
 * With no argument the package fetches `dkls-wasm-ll-web_bg.wasm` relative to
 * its own module URL, which a dependency pre-bundler can break.
 */
import init, * as dkls from '@silencelaboratories/dkls-wasm-ll-web'

import { createSilenceDklsBackend } from './backend.js'
import type { PlainJointSigner } from '../types.js'

let initialised: Promise<unknown> | null = null

/** `wasm`: a URL, a `Response`, bytes, or a compiled `WebAssembly.Module`. */
export async function loadSilenceDklsWeb(
  wasm?: unknown,
): Promise<PlainJointSigner> {
  if (initialised === null) {
    initialised = init(wasm).catch((error: unknown) => {
      initialised = null
      throw error
    })
  }
  await initialised
  return createSilenceDklsBackend(dkls)
}
