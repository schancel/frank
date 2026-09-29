/* eslint-env node */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 10_000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/wallet/(.*)$': '<rootDir>/../wallet/$1',
    '^@frank/cashweb/(.*)$': '<rootDir>/../cashweb/$1',
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
