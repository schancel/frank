/* eslint-env node */
module.exports = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testTimeout: 5000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Ticket #54: `chain/vite-env.ts` contains a real `import.meta.env` reference (see its own
  // header) -- V8 refuses to compile that token outside a genuine ES module, and Jest wraps every
  // transpiled file in a plain CommonJS function, so it can never load that file directly.
  // Substitute the Node-safe stub (`vite-env.node.ts`) for tests only; Vite and `tsx` both
  // resolve the real file normally, unaffected by this (Jest-only) config.
  moduleNameMapper: {
    '^@frank/nakamoto/keys$': '<rootDir>/../nakamoto/src/keys.ts',
    '^@frank/nakamoto/(.*)$': '<rootDir>/../nakamoto/src/$1',
    '^@frank/nakamoto$': '<rootDir>/../nakamoto/src/index.ts',
    '^@frank/adaptor-signatures$':
      '<rootDir>/../adaptor-signatures/src/index.ts',
    '^@frank/adaptor-signatures/src/(.*)\\.js$':
      '<rootDir>/../adaptor-signatures/src/$1',
    '^@frank/adaptor-signatures/(.*)$':
      '<rootDir>/../adaptor-signatures/src/$1',
    '^@frank/crypto-box/(.*)$': '<rootDir>/../crypto-box/src/$1',
    '^@frank/crypto-box$': '<rootDir>/../crypto-box/src/index.ts',
    '^@frank/codec/(.*)$': '<rootDir>/../frank-codec/src/$1',
    '^@frank/codec$': '<rootDir>/../frank-codec/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@frank/cashweb/(.*)$': '<rootDir>/../cashweb/$1',
    '^@frank/joint-signer/src/(.*)\\.js$':
      '<rootDir>/../joint-signer/src/$1.ts',
    '^@frank/joint-signer/src/(.*)$': '<rootDir>/../joint-signer/src/$1',
    '^@frank/joint-signer/(.*)$': '<rootDir>/../joint-signer/$1',
    '^@frank/joint-signer$': '<rootDir>/../joint-signer/src/index.ts',
    '^@frank/threshold-ecdsa/(.*)$': '<rootDir>/../threshold-ecdsa/src/$1',
    '^@frank/threshold-ecdsa$': '<rootDir>/../threshold-ecdsa/src/index.ts',
    '^@frank/wallet/(.*)$': '<rootDir>/$1',
    '^@frank/price-feeds$': '<rootDir>/../price-feeds/src/index.ts',
    '^@frank/price-feeds/(.*)$': '<rootDir>/../price-feeds/src/$1',
    '^\\./vite-env$': '<rootDir>/chain/vite-env.node.ts',
  },
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
  },
  testPathIgnorePatterns: ['/node_modules/'],
}
