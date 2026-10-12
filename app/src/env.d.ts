declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: string
    VUE_ROUTER_MODE: 'hash' | 'history' | 'abstract' | undefined
    VUE_ROUTER_BASE: string | undefined
  }
}

/** Vite emits the committed WASM file as a local asset; imports carry its URL. */
declare module '*.wasm?url' {
  const url: string
  export default url
}
