/**
 * Ambient declarations so the loaders typecheck whether or not the
 * third-party packages are installed. Only the members the loaders use.
 */
declare module '@silencelaboratories/dkls-wasm-ll-node' {
  const KeygenSession: import('./module.js').SilenceDklsModule['KeygenSession']
  const SignSession: import('./module.js').SilenceDklsModule['SignSession']
  const Keyshare: import('./module.js').SilenceDklsModule['Keyshare']
  const Message: import('./module.js').SilenceDklsModule['Message']
  export { KeygenSession, SignSession, Keyshare, Message }
}

declare module '@silencelaboratories/dkls-wasm-ll-web' {
  const KeygenSession: import('./module.js').SilenceDklsModule['KeygenSession']
  const SignSession: import('./module.js').SilenceDklsModule['SignSession']
  const Keyshare: import('./module.js').SilenceDklsModule['Keyshare']
  const Message: import('./module.js').SilenceDklsModule['Message']
  export { KeygenSession, SignSession, Keyshare, Message }
  /** Instantiates the WebAssembly module. Call once before anything else. */
  export default function init(input?: unknown): Promise<unknown>
  export function initSync(module: unknown): unknown
}
