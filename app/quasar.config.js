/*
 * This file runs in a Node context (it's NOT transpiled by Babel), so use only
 * the ES6 features that are supported by your Node version. https://node.green/
 *
 * Ticket #51: migrated from `quasar.conf.js` (CommonJS, `@quasar/app-webpack`) to this file
 * (`quasar.config.js`, ESM -- `@quasar/app-vite` specifically looks for this exact filename with
 * `export default`, per its own `get-app-paths.js`; `quasar.conf.js` is invisible to it). See each
 * section below for the webpack-to-Vite translation of each hook that needed one.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { configure } from 'quasar/wrappers'
import nodePolyfills from 'rollup-plugin-polyfill-node'
import inject from '@rollup/plugin-inject'
import stdLibBrowser from 'node-stdlib-browser'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Ticket #51 (Vite migration): `vite-plugin-node-polyfills` (tried first) is a documented,
// known-broken combination with Vite 8's Rolldown-based dependency optimizer -- confirmed via a
// real-world report of the exact same "Module 'x' has been externalized for browser
// compatibility" failure in another `@quasar/app-vite` v8 project, recommending this exact
// replacement. `rollup-plugin-polyfill-node` is a genuine Rollup plugin (not Vite-specific), which
// works here specifically *because* Rolldown is Rollup-plugin-API-compatible by design -- one of
// the stated goals of building Vite's new bundler on top of Rollup's plugin interface rather than
// esbuild's.
//
// Two separate concerns, two plugins:
// - `nodePolyfills` (this package) rewrites real `import .../require(...)` statements referencing
//   Node builtins (`path`, `buffer`, `process`, ...) to browser-safe polyfills.
// - `@rollup/plugin-inject` covers the *other* half `vite-plugin-node-polyfills` used to handle
//   automatically: this codebase has many bare `Buffer.from(...)`-style call sites with no
//   explicit import at all (previously relying on `node-polyfill-webpack-plugin`'s global
//   injection) -- `inject` rewrites those to insert the corresponding import automatically,
//   wherever the bare identifier is referenced.
//
// `include: null` on `nodePolyfills` (rather than its default, `node_modules/**/*.js` only):
// `local_modules/bn.js`/`local_modules/bitcore-lib-xpi` are aliased in but physically live
// *outside* `node_modules`, and need the exact same transform.
const globalPolyfills = nodePolyfills({ include: null })
const globalInject = inject({
  Buffer: ['buffer', 'Buffer'],
  process: 'process',
})

// A *third* mechanism, needed on top of the two above: confirmed live, Vite's dev server has its
// own separate "externalize this bare Node-builtin import for browser compatibility" check that
// runs independently of (and apparently before) a Rollup-style plugin's own `resolveId` hook --
// `rollup-plugin-polyfill-node` alone still left `import ... from 'path'` throwing "Module 'path'
// has been externalized for browser compatibility" at runtime, exactly the class of bug this
// package's build (Rolldown) transition seems to have introduced. `node-stdlib-browser` is the
// same underlying module map `vite-plugin-node-polyfills` used internally (confirmed by reading
// its source) -- using it directly via a plain `resolve.alias`, which Vite's dev server *does*
// consult before falling back to its own externalization behavior, sidesteps needing that
// (broken, for this Vite version) plugin at all.
const stdLibBrowserAliases = stdLibBrowser

// Ticket #51 (Vite migration): the 10 generated `*_pb.js` protobuf files under `src/`
// (google-protobuf codegen, e.g. `goog.object.extend(exports, proto.bip70)`) are genuinely
// CommonJS -- they reference a bare `exports` and call `require('google-protobuf')`, neither of
// which exists in a real ESM module. `@originjs/vite-plugin-commonjs` (tried first) has an
// ordering bug for this exact shape: it rewrites the `require(...)` call into a real `import`
// statement *before* asking esbuild to wrap the file as CommonJS -- but esbuild's own CJS-vs-ESM
// heuristic treats the presence of a top-level `import` as proof the file is *already* ESM, so it
// skips the wrap entirely, leaving the trailing `goog.object.extend(exports, ...)` referencing an
// `exports` that was never declared (confirmed live: serving the file directly from the dev
// server showed the `require` rewritten but no `export` ever added).
//
// This plugin does the same job directly and in the right order: wrap the untouched file body in
// a function that's given real local `exports`/`module`/`require` bindings (`require` only ever
// needs to resolve `google-protobuf`, real ESM-imported once at the top), then export the
// populated `module.exports` object -- exactly the shape `viteCommonjs()` produces for CJS files
// that *don't* happen to contain a `require()` call, which is why removing it fixed every other
// already-working `_pb.js` file's plain named/default imports without needing this plugin's help.
function protobufCjsInterop() {
  return {
    name: 'frank:protobuf-cjs-interop',
    transform(code, id) {
      if (!id.endsWith('_pb.js')) return null
      return {
        code: `import __jspb__ from 'google-protobuf'
const module = { exports: {} }
const exports = module.exports
function require(name) {
  if (name === 'google-protobuf') return __jspb__
  throw new Error('protobufCjsInterop: unexpected require(' + JSON.stringify(name) + ') in ' + ${JSON.stringify(
    id,
  )})
}
${code}
export default module.exports
`,
        map: null,
      }
    },
  }
}

export default configure(ctx => {
  return {
    // app boot file (/src/boot)
    // --> boot files are part of "main.js"
    // https://quasar.dev/quasar-cli/cli-documentation/boot-files
    boot: [
      'pinia',
      'i18n',
      'axios',
      'network-prefix',
      'setup-apis',
      // ticket #42: separate from 'setup-apis' (the pre-existing Lotus boot sequence) -- see this
      // boot file's own header comment for why.
      'monad-direct-messages',
      // Was `ctx.mode.electron ? 'electron' : 'capacitor'` -- an unconditional fallback that
      // loaded the capacitor boot file (and its `@capacitor/core` import) for *any* non-electron
      // mode, including plain SPA. Under webpack this silently resolved anyway; found live under
      // Vite (ticket #51 migration) as `Failed to resolve import "@capacitor/core"` for an SPA
      // dev server that was never going to run on a device at all. Loading platform-specific boot
      // code outside its actual platform never made sense regardless of whether a bundler happens
      // to tolerate it -- scoped to the modes that are actually true instead.
      ctx.mode.electron && 'electron',
      ctx.mode.capacitor && 'capacitor',
    ].filter(Boolean),

    // https://quasar.dev/quasar-cli/quasar-conf-js#Property%3A-css
    css: ['dialogs.scss', 'dark-mode.scss', 'light-mode.scss', 'app.scss'],

    // https://github.com/quasarframework/quasar/tree/dev/extras
    extras: [
      // 'ionicons-v4',
      // 'mdi-v5',
      // 'fontawesome-v5',
      // 'eva-icons',
      // 'themify',
      // 'line-awesome',
      // 'roboto-font-latin-ext', // this or either 'roboto-font', NEVER both!

      'roboto-font', // optional, you are not bound to it
      'material-icons', // optional, you are not bound to it
    ],

    // https://quasar.dev/quasar-cli/quasar-conf-js#Property%3A-framework
    framework: {
      iconSet: 'material-icons', // Quasar icon set
      lang: 'en-US', // Quasar language pack

      components: ['QSkeleton', 'QScrollObserver'],
      directives: [],

      // Quasar plugins
      plugins: ['Notify', 'Loading', 'Dialog'],
    },

    // https://quasar.dev/quasar-cli/cli-documentation/supporting-ie
    supportIE: false,

    // default values:
    // sourceFiles: {
    //   rootComponent: 'src/App.vue',
    //   router: 'src/router',
    //   store: 'src/store',
    //   indexHtmlTemplate: 'src/index.template.html',
    //   registerServiceWorker: 'src-pwa/register-service-worker.js',
    //   serviceWorker: 'src-pwa/custom-service-worker.js',
    //   electronMain: 'src-electron/electron-main.js',
    //   electronPreload: 'src-electron/electron-preload.js'
    // },

    // https://quasar.dev/quasar-cli/cli-documentation/prefetch-feature
    // preFetch: true

    // Full list of options: https://quasar.dev/quasar-cli/quasar-conf-js#Property%3A-build
    build: {
      target: {
        browser: ['es2020'],
      },

      sourcemap: true,

      vueRouterMode: 'hash', // available values: 'hash', 'history'

      // Ticket #54 (fixed): this file used to also have a `build.env` field claiming to forward
      // `process.env.KEY` values into the bundle "the same way `@quasar/app-webpack` forwarded it
      // into webpack's `DefinePlugin`" -- false under this Quasar/Vite version, confirmed by
      // dumping `viteConf.define`: it contains only Quasar's own `import.meta.env.QUASAR_*`
      // entries, never a `process.env.*` key. The real, working mechanism is Quasar's own
      // `QCLI_`-prefixed env var convention (confirmed live): any real environment variable named
      // `QCLI_SOMETHING` is automatically exposed as `import.meta.env.QCLI_SOMETHING`, no config
      // needed here at all. Every `process.env.MONAD_*`/`CASHWEB_*` read in this app
      // (`@frank/wallet/chain/monad-chain.ts`, `boot/monad-direct-messages.ts`, `router/index.ts`)
      // now checks `import.meta.env.QCLI_KEY` first -- set `QCLI_MONAD_TESTNET_HTTP_RPC_URL`, not
      // `MONAD_TESTNET_HTTP_RPC_URL`, to actually override one of these at dev/build time.

      // Vite/esbuild-native replacement for `node-polyfill-webpack-plugin` (ticket #51): shims
      // Node core modules (`Buffer`, `process`, `stream`, etc.) for the browser -- this app's
      // bitcore-lib-xpi dependency chain (`browserify-sign`, `create-ecdh`, etc.) needs these, and
      // several files reach for a bare global `Buffer` with no explicit import, relying on exactly
      // this kind of polyfill having run.
      // Passed as already-invoked plugin instances, NOT wrapped in Quasar's `[name, opts]` tuple
      // form -- that form is for when *Quasar* should call the plugin factory with the given
      // options (`parseVitePlugins`'s `typeof name === 'function'` branch); since these are called
      // directly here, wrapping them again (`[nodePolyfills(), {}]`) fed the *result* in as if it
      // were the factory, which silently never actually ran. Confirmed live: a generated `*_pb.js`
      // protobuf file (CommonJS, e.g. `goog.object.extend(exports, proto.bip70)`) failed with
      // "does not provide an export named 'default'" even though a standalone `esbuild.
      // transformSync` proved the underlying CJS->ESM conversion works fine in isolation -- the
      // plugin just never ran in the live dev server because of this wrapping mistake.
      vitePlugins: [globalPolyfills, globalInject, protobufCjsInterop()],

      // Vite equivalent of webpack's `extendWebpack`'s `cfg.resolve.modules` directory-prepend
      // hack (ticket #51): that forced *every* `require('bn.js')`/`require('bitcore-lib-xpi')`
      // anywhere in the dependency tree to resolve to this repo's pinned local copy, working
      // around real version skew across the tree (`bitcore-lib-xpi`'s own nested `bn.js` differs
      // from the top-level one, and `browserify-sign`/`browserify-rsa` pull a newer `bn.js` major
      // version) that breaks `BN.isBN()`'s `instanceof` check across copies. Vite's `resolve.alias`
      // is the more direct way to express the same "always resolve this specifier to this exact
      // file" intent, without needing a directory-search-order trick.
      extendViteConf(viteConf) {
        // Ticket #51 (Vite migration): Vue's esm-bundler build gates Options API support
        // (`data()`/`methods`/`computed`/`watch`) behind this bundler-injected constant --
        // confirmed live: `@quasar/app-vite` v3.10.0 / Vite 8 doesn't define it here, so it stays
        // a bare unreplaced global (`__VUE_OPTIONS_API__`) which is `undefined` (falsy) in the
        // browser. Vue's `finishComponentSetup` gates `applyOptions()` on this flag, so with it
        // falsy every Options-API component silently never merges `data()`/`methods` onto the
        // instance -- `setup()`-returned bindings still work (unconditional), which is why this
        // manifested as component-specific "Property 'x' was accessed during render but is not
        // defined on instance" warnings (e.g. TopicLayout's `data() { message }`/`methods.
        // sendMessage`) rather than a single obvious top-level error.
        viteConf.define = {
          ...viteConf.define,
          __VUE_OPTIONS_API__: JSON.stringify(true),
          __VUE_PROD_DEVTOOLS__: JSON.stringify(false),
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: JSON.stringify(false),
        }
        // Ticket #54 (fixed): `process.env.MONAD_*`/`CASHWEB_*` reads throughout this app used to
        // always be `undefined` regardless of what was configured -- `viteConf.define` genuinely
        // doesn't reach first-party source in this `@quasar/app-vite`/Vite 8/Rolldown combination
        // (confirmed: even Vite's own built-in `process.env.NODE_ENV` has the same gap), only
        // pre-bundled `node_modules` dependency chunks (where `__VUE_OPTIONS_API__` above lives).
        // Fixed at the call sites instead, using Quasar's own `QCLI_`-prefixed env var convention
        // (`import.meta.env.QCLI_KEY`, confirmed live to actually work) -- see router/index.ts's
        // and `@frank/wallet/chain/monad-chain.ts`'s own comments. No `define`/`build.env` config
        // needed here for this at all.
        viteConf.resolve = viteConf.resolve || {}
        viteConf.resolve.alias = {
          ...viteConf.resolve.alias,
          ...stdLibBrowserAliases,
          // Ticket #53 (package split): `bitcore-lib-xpi` used to live outside `node_modules`
          // (`local_modules/`), aliased in by hand here -- now a real yarn workspace package
          // (`packages/bitcore-lib-xpi`), symlinked into `node_modules` like any other
          // dependency, so no alias is needed for it anymore.
          //
          // `bn.js` still needs one, for a sharper reason than "it used to live outside
          // node_modules": `bitcore-lib-xpi`'s own package.json pins `bn.js` at an *exact*
          // `4.11.8`, while our workspace `bn.js` package (`packages/bn.js`) is `4.11.9` --
          // genuinely incompatible semver ranges, so yarn's own resolution installs a *second*,
          // real, nested `bn.js` copy under `bitcore-lib-xpi/node_modules/` to satisfy that
          // exact pin rather than reusing the hoisted workspace one. That's precisely the
          // multi-copy `BN.isBN()`/`instanceof` breakage this alias originally existed to
          // prevent (see this file's git history) -- it still needs to force every `bn.js`
          // resolution to the one workspace copy at the Vite/bundle level, regardless of what
          // yarn's own node_modules layout does underneath.
          'bn.js': path.resolve(__dirname, '../packages/bn.js/lib/bn.js'),
          // Mirrors tsconfig.json's `paths` (see that file's own comment): Vite doesn't read
          // tsconfig `paths` for its own module resolution the way @quasar/app-webpack's internal
          // chain did, so these need restating here or every `import ... from 'src/...'` (130
          // real call sites) and `'app/...'` (1) in this codebase would fail to resolve at
          // runtime even though tsc/eslint are happy with them. Vite `resolve.alias` entries are
          // matched in order and only as a path-prefix, so the longer/more specific aliases
          // (`components`, `layouts`, etc.) must come before the bare `src` catch-all or they'd
          // never be reached.
          'components': path.resolve(__dirname, 'src/components'),
          'layouts': path.resolve(__dirname, 'src/layouts'),
          'pages': path.resolve(__dirname, 'src/pages'),
          'assets': path.resolve(__dirname, 'src/assets'),
          'boot': path.resolve(__dirname, 'src/boot'),
          'stores': path.resolve(__dirname, 'src/stores'),
          'src': path.resolve(__dirname, 'src'),
          'app': __dirname,
        }
        // `local_modules/bitcore-lib-xpi` and `local_modules/bn.js` are CommonJS
        // (`module.exports = {...}`). Vite normally converts a CJS dependency's exports to named
        // ESM exports automatically, but only for packages its dependency optimizer discovers
        // under `node_modules` -- a plain `resolve.alias` pointing outside `node_modules` (like
        // both of these) is treated as "your own source, already ESM" and skipped, which is
        // exactly why `import { Transaction } from 'bitcore-lib-xpi'` failed with "does not
        // provide an export named 'Transaction'" the first time this was tried. Forcing them into
        // `optimizeDeps.include` makes Vite run its normal esbuild CJS-interop pre-bundling step
        // on them regardless of where the alias actually points.
        viteConf.optimizeDeps = viteConf.optimizeDeps || {}
        viteConf.optimizeDeps.include = [
          ...(viteConf.optimizeDeps.include || []),
          'bn.js',
          'bitcore-lib-xpi',
        ]
      },
    },

    // Full list of options: https://quasar.dev/quasar-cli/quasar-conf-js#Property%3A-devServer
    devServer: {
      open: true, // opens browser window automatically
      port: 8080,
    },

    // animations: 'all', // --- includes all animations
    // https://quasar.dev/options/animations
    animations: [],

    // https://quasar.dev/quasar-cli/developing-ssr/configuring-ssr
    ssr: {
      pwa: false,
    },

    // https://quasar.dev/quasar-cli/developing-pwa/configuring-pwa
    pwa: {
      workboxMode: 'GenerateSW', // 'GenerateSW' or 'InjectManifest'
      workboxOptions: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'Stamp',
        short_name: 'Stamp',
        description: ' A Lotus powered internet cryptomessenger',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#027be3',
        icons: [
          {
            src: 'icons/icon-128x128.png',
            sizes: '128x128',
            type: 'image/png',
          },
          {
            src: 'icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-256x256.png',
            sizes: '256x256',
            type: 'image/png',
          },
          {
            src: 'icons/icon-384x384.png',
            sizes: '384x384',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    },

    // Full list of options: https://quasar.dev/quasar-cli/developing-cordova-apps/configuring-cordova
    cordova: {
      // noIosLegacyBuildFlag: true, // uncomment only if you know what you are doing
    },

    // Full list of options: https://quasar.dev/quasar-cli/developing-capacitor-apps/configuring-capacitor
    capacitor: {
      hideSplashscreen: true,
      iosStatusBarPadding: true,
    },

    // Full list of options: https://quasar.dev/quasar-cli/developing-electron-apps/configuring-electron
    electron: {
      bundler: 'builder', // 'packager' or 'builder'

      builder: {
        // https://www.electron.build/configuration/configuration

        appId: 'org.cashweb.stamp',
        extraFiles: [{ from: 'src-electron/icons', to: 'resources/icons' }],
        publish: [],

        linux: {
          category: 'Utility',
          target: 'AppImage',
          icon: 'src-electron/icons/linux-512x512.png',
        },
      },
    },
  }
})
