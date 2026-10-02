// esbuild injection shim used only by `browsercheck.html`; production app bundlers provide their
// own standard Node-compat process shim for `level@7`'s browser dependency graph.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const processBrowser = require('process/browser') as typeof import('process')

export const process = processBrowser
