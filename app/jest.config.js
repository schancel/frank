const esModules = ['quasar/lang', 'lodash-es'].join('|')

/* eslint-env node */
module.exports = {
  globals: {
    '__DEV__': true,
    // TODO: Remove if resolved natively https://github.com/vuejs/vue-jest/issues/175
    'vue-jest': {
      pug: { doctype: 'html' },
    },
  },
  setupFiles: ['<rootDir>/test/jest/level-open-guard.js'],
  setupFilesAfterEnv: ['<rootDir>/test/jest/jest.setup.ts'],
  // noStackTrace: true,
  // bail: true,
  // cache: false,
  // verbose: true,
  // watch: true,
  collectCoverage: false,
  coverageDirectory: '<rootDir>/test/jest/coverage',
  collectCoverageFrom: [
    '<rootDir>/src/**/*.vue',
    '<rootDir>/src/**/*.js',
    '<rootDir>/src/**/*.ts',
    '<rootDir>/src/**/*.jsx',
    '<rootDir>/src/**/*.tsx',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '.d.ts$'],
  coverageThreshold: {
    global: {
      //  branches: 50,
      //  functions: 50,
      //  lines: 50,
      //  statements: 50
    },
  },
  testMatch: [
    // Matches tests in any subfolder of 'src' or into 'test/jest/__tests__'
    // Matches all files with extension 'js', 'jsx', 'ts' and 'tsx'
    '<rootDir>/test/jest/__tests__/**/*.(spec|test).+(ts|js)?(x)',
    '<rootDir>/src/**/*.jest.(spec|test).+(ts|js)?(x)',
  ],
  // Extension-less imports of components are resolved to .ts files by TS,
  //  grating correct type-checking in test files.
  // Being 'vue' the first moduleFileExtension option, the very same imports
  //  will be resolved to .vue files by Jest, if both .vue and .ts files are
  //  in the same folder.
  // This guarantee a great dev experience both for testing and type-checking.
  // See https://github.com/vuejs/vue-jest/issues/188#issuecomment-620750728
  moduleFileExtensions: ['vue', 'js', 'jsx', 'json', 'ts', 'tsx'],
  moduleNameMapper: {
    // Resolve workspace packages from this checkout. Worktrees intentionally share the root
    // node_modules directory, whose workspace symlinks otherwise point at another checkout.
    '^@frank/cashweb/(.*)$': '<rootDir>/../packages/cashweb/$1',
    '^@frank/wallet/(.*)$': '<rootDir>/../packages/wallet/$1',
    // Same source map cashweb's jest uses. The package export points at dist,
    // which this suite does not build. Nakamoto's own imports end in .js.
    '^@frank/crypto-box$': '<rootDir>/../packages/crypto-box/src/index.ts',
    '^@frank/codec$': '<rootDir>/../packages/frank-codec/src/index.ts',
    '^@frank/codec/(.*)$': '<rootDir>/../packages/frank-codec/src/$1',
    '^@frank/nakamoto$': '<rootDir>/../packages/nakamoto/src/index.ts',
    '^@frank/nakamoto/curve$': '<rootDir>/../packages/nakamoto/src/curve.ts',
    '^@frank/nakamoto/constructors$':
      '<rootDir>/../packages/nakamoto/src/constructors.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Use Quasar's CommonJS server entry in Jest. The older
    // `quasar.cjs.prod.js` filename disappeared in Quasar 2.33.
    '^quasar$': 'quasar/dist/quasar.server.prod.cjs',
    '^~/(.*)$': '<rootDir>/$1',
    '^src/(.*)$': '<rootDir>/src/$1',
    '^app/(.*)$': '<rootDir>/$1',
    '^components/(.*)$': '<rootDir>/src/components/$1',
    '^layouts/(.*)$': '<rootDir>/src/layouts/$1',
    '^pages/(.*)$': '<rootDir>/src/pages/$1',
    '^assets/(.*)$': '<rootDir>/src/assets/$1',
    '^boot/(.*)$': '<rootDir>/src/boot/$1',
    // Locally-committed stub (see test/jest/utils/stub.css) rather than pulling in
    // @quasar/quasar-app-extension-testing-unit-jest just for a css stub; jest-transform-stub
    // below turns any matched css/asset file into a stub module anyway.
    '.*css$': '<rootDir>/test/jest/utils/stub.css',
    // Ticket #54: same substitution as @frank/wallet's own jest.config.js (see that file's
    // comment, and chain/vite-env.ts's own header, for the full story) -- these tests
    // transitively pull in @frank/wallet/chain, which imports the real `vite-env.ts` (a genuine
    // `import.meta.env` reference Jest can never parse) via this exact relative specifier.
    '^\\./vite-env$': '<rootDir>/../packages/wallet/chain/vite-env.node.ts',
  },
  transform: {
    // See https://jestjs.io/docs/en/configuration.html#transformignorepatterns-array-string
    [`^(${esModules}).+\\.js$`]: 'babel-jest',
    '^.+\\.(ts|js|html)$': [
      'ts-jest',
      {
        // isolatedModules (transpile-only, no cross-file type-checking) is set in
        // tsconfig.jest.json - matches the official Quasar testing extension's own default,
        // keeps jest fast, and avoids ts-jest's Program-wide type inference disagreeing with
        // mocked types (e.g. jest.fn()'s inferred return type vs. the mocked interface) in ways
        // plain `tsc`/eslint's type-aware rules don't flag.
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
    // @vue/vue3-jest (Vue 3 + jest 29 compatible) replaces the old Vue2-era 'vue-jest'
    // package, which this app (Vue 3 / Quasar 2) was never actually compatible with.
    // Wraps @vue/vue3-jest, only adding an `import.meta.url` rewrite (see the file).
    '.*\\.vue$': '<rootDir>/test/jest/vue-import-meta-transform.js',
    '.+\\.(css|styl|less|sass|scss|svg|png|jpg|ttf|woff|woff2)$':
      'jest-transform-stub',
  },
  transformIgnorePatterns: [`node_modules/(?!(${esModules}))`],
  // NOTE: 'jest-serializer-vue' (Vue2-VNode-shaped snapshot serializer) was dropped: it has no
  // Vue3-compatible release and isn't required for tests to run; drop-in replacement can be
  // added later if Vue3 snapshot tests need prettier output.
  testPathIgnorePatterns: [
    '/node_modules/',
    // Legacy Quasar-CLI (Vue2 / Quasar1) demo scaffolding, never updated for this app's actual
    // Vue3/Quasar2 stack (uses @vue/test-utils v1 APIs like `createLocalVue` and the old v2.x
    // `mountFactory` export, neither of which exist/work with the installed Vue3 toolchain).
    // Tracked separately from ticket #28 (installing jest infra); rewriting them is new test
    // authorship, out of scope here.
    '<rootDir>/test/jest/__tests__/App.spec.ts',
    '<rootDir>/test/jest/__tests__/QBtn-demo.spec.ts',
  ],
}
