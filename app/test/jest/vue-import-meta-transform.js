/* eslint-env node */
// Test-only wrapper around @vue/vue3-jest. Jest runs SFCs as CommonJS, where
// `import.meta` is a syntax error, so any SFC that uses Vite's
// `new URL(..., import.meta.url)` asset idiom (e.g. pages/Setup.vue) could not
// be loaded. This rewrites `import.meta.url` to a fixed file URL before the
// normal SFC transform. Production (Vite) builds never see this.
const vueJest = require('@vue/vue3-jest')

const rewrite = source =>
  source.replace(/import\.meta\.url/g, '"file:///jest-import-meta-url"')

module.exports = {
  ...vueJest,
  process: (source, filename, options) =>
    vueJest.process(rewrite(source), filename, options),
  getCacheKey: (source, filename, options) =>
    vueJest.getCacheKey(rewrite(source), filename, options),
}
