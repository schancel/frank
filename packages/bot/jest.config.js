/* eslint-env node */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/bot-framework/(.*)$': '<rootDir>/../bot-framework/src/$1',
    '^@frank/bot-framework$': '<rootDir>/../bot-framework/src/index.ts',
    '^@frank/directory-admission$':
      '<rootDir>/../directory-admission/src/index.ts',
    '^@frank/directory-admission/browser$':
      '<rootDir>/../directory-admission/src/browser.ts',
    '^@frank/directory-admission/node$':
      '<rootDir>/../directory-admission/src/node.ts',
    // Same source map cashweb's and wallet's own jest configs carry: `@frank/nakamoto` is
    // ESM-only ("exports" without a CJS condition), so a CJS jest require of the installed
    // package can never resolve -- tests load its TypeScript source instead.
    '^@frank/nakamoto/(.*)$': '<rootDir>/../nakamoto/src/$1',
    '^@frank/nakamoto$': '<rootDir>/../nakamoto/src/index.ts',
    '^@frank/crypto-box/(.*)$': '<rootDir>/../crypto-box/src/$1',
    '^@frank/crypto-box$': '<rootDir>/../crypto-box/src/index.ts',
    '^@frank/codec/(.*)$': '<rootDir>/../frank-codec/src/$1',
    '^@frank/codec$': '<rootDir>/../frank-codec/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@frank/cashweb/(.*)$': '<rootDir>/../cashweb/$1',
    '^@frank/wallet/(.*)$': '<rootDir>/../wallet/$1',
    '^\\./vite-env$': '<rootDir>/../wallet/chain/vite-env.node.ts',
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
