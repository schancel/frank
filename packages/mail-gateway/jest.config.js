/* eslint-env node */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/directory-admission$': '<rootDir>/../directory-admission/src/index.ts',
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
  transformIgnorePatterns: ['/node_modules/(?!kysely)/'],
  testPathIgnorePatterns: ['/node_modules/'],
};
