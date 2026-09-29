// esbuild injection shim used only by `browsercheck.html`; production app bundlers provide their
// own standard Node-compat process shim for `level@7`'s browser dependency graph.
import processBrowser from 'process/browser'

export const process = processBrowser
