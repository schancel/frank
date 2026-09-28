/** Ticket #54: isolated in its own file on purpose. `import.meta` is a *parse-time* restriction,
 * not a runtime one -- V8 refuses to compile any script/function body containing that token
 * unless it's genuinely loaded as an ES module. `monad-chain.ts` (which uses this) also runs
 * under ts-jest for its own tests, which transpiles a file then wraps the *result* in a plain
 * CommonJS function before compiling it -- a bare `import.meta.env` there fails with "Cannot use
 * 'import.meta' outside a module" at Jest's compile step, unconditionally, no runtime guard
 * (`typeof`, optional chaining, try/catch) can help since the token itself is the problem, not
 * its value.
 *
 * Splitting it into its own file lets `jest.config.js`'s `moduleNameMapper` substitute a
 * Node-safe stub (`vite-env.node.ts`) for this exact path when running tests, so Jest never
 * parses this file's `import.meta` at all. Vite (real browser bundling) and `tsx` (real Node ESM,
 * `packages/bot`'s scripts) both resolve to *this* file normally -- `import.meta.env` is a real,
 * live, Vite-populated object in the browser, and simply `undefined` under tsx (which doesn't
 * inject it), safely short-circuited by `?.`. */
export function readViteEnv(key: string): string | undefined {
  return (import.meta as { env?: Record<string, string | undefined> }).env?.[
    key
  ]
}
