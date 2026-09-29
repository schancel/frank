/* eslint-env node */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
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
