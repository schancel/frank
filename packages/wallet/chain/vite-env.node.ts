/** Jest-only stand-in for `vite-env.ts` -- see that file's own header for why Jest can never load
 * the real one. Substituted in via `jest.config.js`'s `moduleNameMapper`, never imported
 * directly. `monad-chain.ts`'s `readEnv` already falls back to `process.env[key]` after this
 * returns `undefined`, so returning `undefined` unconditionally here is correct, not a stub
 * needing real logic: under Jest there is no Vite-populated `import.meta.env` to read from. */
export function readViteEnv(_key: string): string | undefined {
  return undefined
}
